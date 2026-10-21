// Vigie — conversations Codex (OpenAI) : lecture des fils de ~/.codex/sessions (rollout-*.jsonl).
// Chaque fil donne : la conversation (dossier, titre), tes demandes, ses messages (intermédiaires et comptes
// rendus), les tours (début, fin, interruption), son plan (update_plan), ses commandes (shell_command, exec_command,
// et le « mode code » où Codex appelle tools.exec_command({cmd}) dans un petit programme), ses modifications de
// fichiers (apply_patch), ses agents (spawn_agent) et sa consommation (token_count : tokens et rate_limits).
// Lecture incrémentale : seul ce qui s'ajoute à un fil est relu. Rien n'est écrit dans ~/.codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { commitMessage } from './indexer.mjs';

// Le programme codex : celui du PATH, sinon celui de l'extension VS Code d'OpenAI (la version la plus récente).
export function findCodexBin(home = os.homedir()) {
  const which = spawnSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  const onPath = which.status === 0 ? which.stdout.trim() : '';
  if (onPath && fs.existsSync(onPath)) return onPath;
  const ext = path.join(home, '.vscode', 'extensions');
  let dirs = [];
  try { dirs = fs.readdirSync(ext).filter((d) => /^openai\.chatgpt-/.test(d)).sort().reverse(); } catch { return null; }
  for (const d of dirs) {
    let bins = [];
    try { bins = fs.readdirSync(path.join(ext, d, 'bin')).filter((b) => b.startsWith('macos')); } catch { continue; }
    for (const b of bins) { const p = path.join(ext, d, 'bin', b, 'codex'); if (fs.existsSync(p)) return p; }
  }
  return null;
}
// `codex login` attend un terminal : pseudo-terminal sans fenêtre (Python du système), comme pour les MCP.
const PTY_PROG = ['import os,pty,sys', 'pid,fd=pty.fork()', 'if pid==0: os.execvp(sys.argv[1],sys.argv[1:])', 'while True:',
  ' try: d=os.read(fd,4096)', ' except OSError: break', ' if not d: break', ' os.write(1,d)',
  '_,st=os.waitpid(pid,0)', 'sys.exit(os.waitstatus_to_exitcode(st))'].join('\n');

const KEEP_MS = 14 * 86_400_000;        // fils modifiés depuis moins de 14 jours
const RECENT_MS = 30 * 60_000;          // sans autre signe : ouverte si active depuis moins de 30 min
const BUSY_STALE_MS = 15 * 60_000;      // un tour commencé mais silencieux depuis 15 min n'est plus « au travail »
const MAX_ITEMS = 300;
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const ms = (iso) => Date.parse(iso || '') || 0;
const DEPLOY_RE = /\b(?:vercel\s+(?:deploy|--prod)\b|netlify\s+deploy\b|wrangler\s+(?:pages\s+)?deploy\b|fly(?:ctl)?\s+deploy\b|firebase\s+deploy\b|railway\s+up\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b|supabase\s+(?:db\s+push|functions\s+deploy)\b)/;
const TEST_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bplaywright\s+test\b/;
// Une relance (« continue », « ok ») ne dit pas ce qui est demandé : la vraie demande est avant.
const RELAUNCH = /^\s*(?:continu[eé]?|ok(?:ay)?|oui|vas[- ]y|go|reprends?|on reprend|c'est bon|parfait|merci)\b[\s.!,]*$/i;

// Les commandes d'un appel d'outil, quelle que soit sa forme.
export function commandsOf(name, payload) {
  const out = [];
  if (payload?.type === 'custom_tool_call' && name === 'exec') {
    // mode code : tools.exec_command({cmd:"…"}) dans un petit programme JavaScript
    for (const m of String(payload.input || '').matchAll(/exec_command\(\{\s*"?cmd"?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g)) {
      const raw = m[1];
      try { out.push(raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1).replace(/\\(.)/g, '$1')); } catch { out.push(raw.slice(1, -1)); }
    }
    return out;
  }
  if (payload?.type === 'function_call' && ['shell_command', 'exec_command', 'shell', 'local_shell'].includes(name)) {
    let a = {};
    try { a = JSON.parse(payload.arguments || '{}'); } catch { /* arguments illisibles */ }
    const c = a.command ?? a.cmd;
    if (Array.isArray(c)) out.push(c.join(' ')); else if (typeof c === 'string') out.push(c);
  }
  return out;
}

// Les fichiers d'un apply_patch : « *** Add File: … », « *** Update File: … », « *** Delete File: … ».
export function patchFiles(input) {
  const out = [];
  for (const m of String(input || '').matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) out.push({ op: m[1].toLowerCase(), path: m[2].trim() });
  return out;
}

function newSession(file) {
  return { file, id: null, cwd: null, startTs: null, lastTs: null, title: null, originator: null,
    prompts: [], reports: [], lastText: null, liveText: null, turnStart: null, turnEnd: null,
    plan: null, planTs: null, commands: [], files: new Map(), agents: [], mcp: new Map(),
    tokens: 0, recent: [], rate: null, rateTs: null, limitHit: null, approval: null, sandbox: null,
    parent: null, nickname: null, agentPath: null };
}

// Fils que Codex a chargés : un processus codex (app-server de l'extension VS Code, ou codex en terminal) garde ouvert
// le fichier de la conversation. { running: un processus codex tourne, files: fichiers ouverts | null si illisible }.
export function codexLiveFiles() {
  try {
    const pids = spawnSync('/usr/bin/pgrep', ['-x', 'codex'], { encoding: 'utf8', timeout: 2000 }).stdout.split('\n').filter((x) => /^\d+$/.test(x));
    if (!pids.length) return { running: false, files: new Set() };
    const r = spawnSync('/usr/sbin/lsof', ['-Fn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || typeof r.stdout !== 'string') return { running: true, files: null };
    const files = new Set(r.stdout.split('\n').filter((l) => l.startsWith('n') && /\/rollout-[^/]*\.jsonl$/.test(l)).map((l) => l.slice(1)));
    return { running: true, files };
  } catch { return { running: null, files: null }; }
}

export function createCodex({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'), now = () => Date.now(),
  dataDir = null, codexBin = undefined, ptyPython = '/usr/bin/python3', liveFiles = codexLiveFiles } = {}) {
  const SESS = path.join(codexHome, 'sessions');
  const files = new Map(); // fichier -> { size, mtimeMs, offset, carry, s }
  let titles = new Map(), titlesMtime = 0, lastScan = 0, list = [];

  const present = () => fs.existsSync(codexHome);

  function readTitles() {
    const f = path.join(codexHome, 'session_index.jsonl');
    let st; try { st = fs.statSync(f); } catch { return; }
    if (st.mtimeMs === titlesMtime) return;
    titlesMtime = st.mtimeMs;
    const m = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      try { const r = JSON.parse(line); if (r?.id && r.thread_name) m.set(r.id, r.thread_name); } catch { /* ligne abîmée */ }
    }
    titles = m;
  }

  function rollouts() {
    const out = [];
    const limit = now() - KEEP_MS;
    const walk = (dir, depth) => {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (d.isFile() && /^rollout-.*\.jsonl$/.test(d.name)) {
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (st.mtimeMs >= limit) out.push({ p, st });
        }
      }
    };
    walk(SESS, 0);
    return out;
  }

  function apply(s, r) {
    const ts = r.timestamp || null;
    if (ts) { if (!s.startTs || ts < s.startTs) s.startTs = ts; if (!s.lastTs || ts > s.lastTs) s.lastTs = ts; }
    const p = r.payload || {};
    if (r.type === 'session_meta') {
      s.id = p.id || p.session_id || s.id; s.cwd = p.cwd || s.cwd; s.originator = p.originator || s.originator;
      if (p.timestamp) s.startTs = p.timestamp;
      // agent lancé par une conversation (spawn_agent) : rangé sous elle, pas listé à part
      if (p.thread_source === 'subagent' || p.source?.subagent) {
        s.parent = p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id || null;
        s.nickname = p.agent_nickname || p.source?.subagent?.thread_spawn?.agent_nickname || null;
        s.agentPath = p.agent_path || p.source?.subagent?.thread_spawn?.agent_path || null;
      }
      return;
    }
    if (r.type === 'turn_context') { s.approval = p.approval_policy || s.approval; s.sandbox = p.sandbox_policy?.type || s.sandbox; if (p.cwd) s.cwd = p.cwd; return; }
    if (r.type === 'event_msg') {
      switch (p.type) {
        case 'user_message': {
          const text = String(p.message || '').trim();
          if (text) s.prompts.push({ text: short(text, 400), ts });
          break;
        }
        case 'agent_message': {
          const text = String(p.message || '').trim();
          if (!text) break;
          s.liveText = { text: short(text, 400), ts };
          if (p.phase && p.phase !== 'commentary') s.lastText = { text: short(text, 600), ts };
          break;
        }
        case 'task_started': s.turnStart = ts; break;
        case 'task_complete': {
          s.turnEnd = ts;
          const text = String(p.last_agent_message || '').trim();
          if (text) { s.lastText = { text: short(text, 600), ts }; s.reports.push({ text: short(text, 600), ts }); }
          break;
        }
        case 'turn_aborted': s.turnEnd = ts; break;
        case 'token_count': {
          const last = p.info?.last_token_usage?.total_tokens || 0;
          if (p.info?.total_token_usage?.total_tokens) s.tokens = p.info.total_token_usage.total_tokens;
          if (last && ts) { s.recent.push({ ts, n: last }); if (s.recent.length > 200) s.recent.splice(0, s.recent.length - 200); }
          if (p.rate_limits) { s.rate = p.rate_limits; s.rateTs = ts; if (p.rate_limits.rate_limit_reached_type) s.limitHit = ts; }
          break;
        }
        case 'mcp_tool_call_end': {
          const server = p.invocation?.server;
          if (server) { const m = s.mcp.get(server) || { uses: 0, lastTs: null }; m.uses++; m.lastTs = ts; s.mcp.set(server, m); }
          break;
        }
        default: break;
      }
      return;
    }
    if (r.type === 'response_item') {
      const name = p.name;
      if (p.type === 'function_call' && name === 'update_plan') {
        try {
          const a = JSON.parse(p.arguments || '{}');
          if (Array.isArray(a.plan)) { s.plan = { title: a.explanation ? short(a.explanation, 120) : null, steps: a.plan }; s.planTs = ts; }
        } catch { /* plan illisible */ }
        return;
      }
      if (p.type === 'function_call' && name === 'spawn_agent') {
        let a = {}; try { a = JSON.parse(p.arguments || '{}'); } catch { /* */ }
        s.agents.push({ title: a.task_name || 'Agent', ts });
        return;
      }
      if (p.type === 'custom_tool_call' && name === 'apply_patch') {
        for (const f of patchFiles(p.input)) {
          const e = s.files.get(f.path) || { path: f.path, ops: 0, created: false, firstTs: ts, lastTs: ts };
          e.ops++; e.lastTs = ts; if (f.op === 'add') e.created = true;
          s.files.set(f.path, e);
        }
        return;
      }
      for (const cmd of commandsOf(name, p)) {
        s.commands.push({ ts, cmd: short(cmd, 400) });
        if (s.commands.length > MAX_ITEMS * 3) s.commands.splice(0, s.commands.length - MAX_ITEMS * 3);
      }
    }
  }

  // Relit ce qui s'est ajouté aux fils (au plus toutes les 2 s).
  function scan() {
    if (now() - lastScan < 2000) return list;
    lastScan = now();
    if (!present()) { list = []; return list; }
    readTitles();
    const seen = new Set();
    for (const { p, st } of rollouts()) {
      seen.add(p);
      let f = files.get(p);
      if (!f || st.size < f.offset) { f = { offset: 0, carry: '', s: newSession(p), mtimeMs: 0 }; files.set(p, f); }
      f.mtimeMs = st.mtimeMs;
      if (st.size > f.offset) {
        let fd;
        try {
          fd = fs.openSync(p, 'r');
          const len = Math.min(st.size - f.offset, 64 * 1024 * 1024);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, f.offset);
          f.offset += len;
          const lines = (f.carry + buf.toString('utf8')).split('\n');
          f.carry = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            let r; try { r = JSON.parse(line); } catch { continue; }
            apply(f.s, r);
          }
        } catch { /* fil illisible pour l'instant */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } }
      }
      if (!f.s.id) f.s.id = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(p) || [])[1] || null;
    }
    for (const p of files.keys()) if (!seen.has(p)) files.delete(p);
    list = [...files.entries()].filter(([, f]) => f.s.id).map(([file, f]) => ({ s: f.s, mtimeMs: f.mtimeMs, file }));
    return list;
  }

  // Ouverte : Codex a ce fil chargé (fichier ouvert par son processus) ou y travaille ; sans processus codex, rien
  // n'est ouvert. Relevé impossible : ouverte si active depuis moins de 30 min (avant : 12 h, une conversation
  // fermée restait affichée « ouverte, en attente »).
  let live = null;
  function liveNow() {
    if (!live || now() - live.at > 5000 || now() < live.at) live = { at: now(), ...liveFiles() };
    return live;
  }
  function stateOf(s, mtimeMs, file) {
    const t = now();
    const l = liveNow();
    if (l.running === false) return 'closed';
    const busy = s.turnStart && (!s.turnEnd || s.turnStart > s.turnEnd) && t - mtimeMs < BUSY_STALE_MS;
    if (busy) return 'busy';
    if (file && l.files?.has(file)) return 'idle';
    return t - Math.max(mtimeMs, ms(s.lastTs)) < RECENT_MS ? 'idle' : 'closed';
  }

  const planSteps = (s) => (s.plan?.steps || []).map((x, i) => ({ id: String(i + 1), text: short(x.step || x.text || '', 200),
    status: x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'doing' : 'todo', group: null }));

  function titleOf(s) {
    const t = titles.get(s.id);
    if (t) return t;
    const first = s.prompts.find((p) => p.text && !RELAUNCH.test(p.text));
    return first ? short(first.text, 80) : 'Conversation Codex';
  }

  function tokensPerMin(s) {
    const since = now() - 10 * 60_000;
    const n = s.recent.filter((x) => ms(x.ts) >= since).reduce((a, x) => a + x.n, 0);
    return n / 10;
  }

  function summary({ s, mtimeMs, file }) {
    const st = stateOf(s, mtimeMs, file);
    const steps = planSteps(s);
    const done = steps.filter((x) => x.status === 'done').length;
    const cur = steps.find((x) => x.status === 'doing') || steps.find((x) => x.status === 'todo');
    const head = (s.lastText?.text || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || null;
    return {
      id: s.id, agent: 'codex', title: titleOf(s), project: s.cwd ? path.basename(s.cwd) : null, cwd: s.cwd,
      status: st, running: st !== 'closed', lastActivity: s.lastTs, startedAt: s.startTs,
      headline: cur ? short(cur.text, 90) : head ? short(head, 90) : null,
      progress: steps.length ? { done, total: steps.length, label: s.plan?.title || 'Plan', current: cur ? short(cur.text, 90) : null } : null,
      agentsRunning: 0, workflowsRunning: 0,
      rate: { tokensPerMin: tokensPerMin(s) || null, weekPctPerHour: null, spark: [], trend: null },
      tokens: s.tokens,
    };
  }

  function milestones(s) {
    const out = [];
    const add = (m) => { if (m.ts) out.push(m); };
    for (const p of s.prompts) add({ ts: p.ts, kind: 'prompt', title: p.text });
    for (const r of s.reports) {
      const lines = r.text.split(/(?<=[.!?])\s+/);
      add({ ts: r.ts, kind: 'report', title: short(lines[0], 220), detail: lines.length > 1 ? short(lines.slice(1).join(' '), 500) : null });
    }
    for (const c of s.commands) {
      if (/\bgit\b[^\n]*\bcommit\b/.test(c.cmd)) add({ ts: c.ts, kind: 'commit', title: commitMessage(c.cmd) || 'Commit' });
      else if (/\bgit\b[^\n]*\bpush\b/.test(c.cmd)) add({ ts: c.ts, kind: 'push', title: short(c.cmd, 120) });
      else if (DEPLOY_RE.test(c.cmd)) add({ ts: c.ts, kind: 'deploy', title: short(c.cmd, 120) });
    }
    for (const a of s.agents) add({ ts: a.ts, kind: 'agent', title: a.title, ok: true });
    if (s.limitHit) add({ ts: s.limitHit, kind: 'limit', title: 'Limite atteinte' });
    return out.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 150);
  }

  function current(s) {
    if (!s.prompts.length) return null;
    let i = s.prompts.length - 1;
    while (i > 0 && (RELAUNCH.test(s.prompts[i].text) || s.prompts[i].text.length < 12)) i--;
    const p = s.prompts[i], last = s.prompts[s.prompts.length - 1];
    const since = p.ts || '';
    const cmds = s.commands.filter((c) => c.ts >= since);
    return { prompt: p.text, start: p.ts,
      commits: cmds.filter((c) => /\bgit\b[^\n]*\bcommit\b/.test(c.cmd)).length,
      pushes: cmds.filter((c) => /\bgit\b[^\n]*\bpush\b/.test(c.cmd)).length,
      deploys: cmds.filter((c) => DEPLOY_RE.test(c.cmd)).length,
      files: [...s.files.values()].filter((f) => f.lastTs >= since).length,
      testsOk: 0, testsFailed: 0,
      agents: s.agents.filter((a) => a.ts >= since).length, workflows: 0,
      relaunch: p !== last ? { prompt: last.text, ts: last.ts } : null };
  }

  function detail(id) {
    const e = scan().find((x) => x.s.id === id);
    if (!e) return null;
    const { s } = e;
    const steps = planSteps(s);
    const cur = steps.findIndex((x) => x.status === 'doing');
    const plan = steps.length ? { title: s.plan?.title || 'Plan de Codex', file: null, updatedAt: s.planTs, steps,
      done: steps.filter((x) => x.status === 'done').length, total: steps.length, current: cur >= 0 ? steps[cur].id : null } : null;
    const sum = summary(e);
    return {
      summary: sum,
      now: { text: s.lastText?.text || null, ts: s.lastText?.ts || null,
        live: s.liveText && sum.status === 'busy' && (!s.lastText || s.liveText.ts > s.lastText.ts) ? s.liveText : null,
        tasks: [], tasksTs: null, plan },
      chapters: [],
      current: current(s),
      milestones: milestones(s),
      activity: s.commands.slice(-MAX_ITEMS).reverse().map((c) => ({ ts: c.ts, kind: /\bgit\b[^\n]*\bcommit\b/.test(c.cmd) ? 'commit' : 'command', title: c.cmd, detail: null, agent: null, ok: null })),
      agents: agentsOf(id),
      workflows: [], artifacts: [],
      files: [...s.files.values()].sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs))).slice(0, 400)
        .map((f) => ({ path: f.path, name: path.basename(f.path), ext: path.extname(f.path).slice(1) || null, kind: null, created: f.created, writes: f.ops, ts: f.lastTs, by: null,
          location: s.cwd && f.path.startsWith(s.cwd + path.sep) ? 'project' : 'elsewhere' })),
      tests: s.commands.filter((c) => TEST_RE.test(c.cmd)).slice(-50).reverse().map((c) => ({ ts: c.ts, kind: 'tests', ok: null, pending: false, title: short(c.cmd, 80), command: c.cmd })),
      mcp: [...s.mcp].map(([name, m]) => ({ name, scope: 'unknown', uses: m.uses, lastTs: m.lastTs })),
      tokens: { today: null, total: { total: s.tokens } },
      limits: s.limitHit ? [{ ts: s.limitHit, text: 'Limite Codex atteinte' }] : [],
      trackingDoc: null,
    };
  }

  // Le compte Codex (ton compte ChatGPT) : la consommation la plus récente relevée dans un fil.
  function account() {
    if (!present()) return null;
    let best = null;
    for (const { s } of scan()) if (s.rate && (!best || s.rateTs > best.rateTs)) best = s;
    // Fenêtre déjà remise à zéro depuis le relevé : le pourcentage ne vaut plus rien (inconnu, pas 0).
    const win = (w) => {
      if (!w) return null;
      const resets = w.resets_at ? w.resets_at * 1000 : null;
      const passed = resets !== null && resets <= now();
      return { label: w.window_minutes >= 1440 ? 'Semaine' : 'Session', pct: passed ? null : (w.used_percent ?? null),
        resetsAt: resets !== null && !passed ? new Date(resets).toISOString() : null };
    };
    const r = best?.rate;
    const windows = [r?.primary, r?.secondary].filter(Boolean);
    const week = windows.find((w) => w.window_minutes >= 1440);
    const session = windows.find((w) => w.window_minutes < 1440);
    return { id: 'codex', kind: 'codex', label: 'Codex', email: null,
      connected: fs.existsSync(path.join(codexHome, 'auth.json')), isDefault: false,
      plan: r?.plan_type || null, hook: hookState(), connecting: loginRunning,
      usage: r ? { session: win(session), week: win(week), observedAt: best.rateTs, source: 'session' } : null };
  }

  // Les agents d'une conversation : ses fils « subagent », avec leur état.
  function agentsOf(id) {
    const running = [], done = [];
    for (const e of scan()) {
      if (e.s.parent !== id) continue;
      const st = stateOf(e.s, e.mtimeMs, e.file);
      const name = (e.s.agentPath || '').split('/').pop()?.replace(/_/g, ' ') || 'Agent';
      const v = { id: e.s.id, title: e.s.nickname ? `${name} (${e.s.nickname})` : name, type: 'codex',
        startedAt: e.s.startTs, lastAt: e.s.lastTs, durationMs: Math.max(0, ms(e.s.lastTs) - ms(e.s.startTs)),
        actions: e.s.commands.length, files: e.s.files.size, status: st === 'busy' ? 'running' : 'done',
        lastAction: e.s.commands.at(-1)?.cmd ? short(e.s.commands.at(-1).cmd, 80) : null };
      (st === 'busy' ? running : done).push(v);
    }
    return { running, done };
  }

  // Le hook de Vigie dans Codex : branché (hooks.json), approuvé (trace dans config.toml), vu en action (il a tourné).
  function hookState() {
    let installed = false, trusted = false, seenAt = null;
    try {
      const h = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'))?.hooks || {};
      const ours = (ev) => (h[ev] || []).some((g) => (g.hooks || []).some((x) => /--vigie --codex/.test(String(x.command || ''))));
      installed = ours('PermissionRequest') && ours('PreToolUse');
    } catch { /* pas de hooks.json */ }
    try {
      const conf = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
      // [hooks.state."<…>/hooks.json:pre_tool_use:<groupe>:<hook>"] trusted_hash = "sha256:…" (Codex 0.162)
      const ok = (ev) => new RegExp(`\\[hooks\\.state\\."[^"]*hooks\\.json:${ev}:[^"]*"\\][^\\[]*trusted_hash\\s*=`).test(conf);
      trusted = ok('pre_tool_use') && ok('permission_request');
    } catch { /* pas de config.toml */ }
    if (dataDir) { try { seenAt = fs.readFileSync(path.join(dataDir, 'codex-hook-seen'), 'utf8').trim() || null; } catch { /* jamais vu */ } }
    // un hook pas encore approuvé ne s'exécute jamais : l'avoir vu tourner prouve l'approbation
    return { installed, trusted: trusted || !!seenAt, seenAt };
  }

  // Connexion par le navigateur : `codex login` (page de connexion d'OpenAI), sans Terminal.
  let loginRunning = false;
  function login() {
    const bin = codexBin === undefined ? findCodexBin(home) : codexBin;
    if (!bin) return { ok: false, error: 'Codex est introuvable : installe l\'extension Codex (OpenAI) dans VS Code.' };
    if (loginRunning) return { ok: true, message: 'Connexion déjà en cours : termine-la dans le navigateur.' };
    if (!fs.existsSync(ptyPython)) return { ok: false, error: 'Python du système introuvable : lance « codex login » dans le Terminal.' };
    const env = { ...process.env };
    if (process.env.CODEX_HOME || codexHome !== path.join(home, '.codex')) env.CODEX_HOME = codexHome;
    let child;
    try { child = spawn(ptyPython, ['-I', '-c', PTY_PROG, bin, 'login'], { env, detached: true, stdio: 'ignore' }); } catch { return { ok: false, error: 'Lancement de Codex impossible.' }; }
    loginRunning = true;
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* fini */ } }, 10 * 60_000);
    child.on('exit', () => { loginRunning = false; clearTimeout(t); });
    child.on('error', () => { loginRunning = false; clearTimeout(t); });
    return { ok: true, message: 'Le navigateur s\'ouvre : connecte-toi avec ton compte ChatGPT.' };
  }

  return {
    present, hookState, login,
    summaries: () => scan().filter((e) => !e.s.parent).map((e) => ({ ...summary(e), agentsRunning: agentsOf(e.s.id).running.length })),
    detail,
    has: (id) => scan().some((x) => x.s.id === id),
    account,
  };
}
