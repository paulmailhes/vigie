// Ce que les conversations ont laissé tourner (outil « En fond ») : les processus que Claude Code a lancés, reconnus
// à leur environnement, regroupés, nommés avec des mots simples, et arrêtés sur demande.
//
// Le lien : Claude Code pose dans l'environnement de chaque commande CLAUDE_CODE_SESSION_ID (la conversation) et
// CLAUDE_PID (son processus), et tous les descendants en héritent, même devenus orphelins. Les MCP de la conversation
// portent la conversation mais pas CLAUDE_PID : ils ne sont jamais listés. Un programme lancé à la main n'a aucun
// marquage : il n'apparaît jamais.
//
// Sécurité : `ps -E` montre tout l'environnement, secrets compris. Seules ces deux valeurs sont gardées, le reste est
// jeté à la lecture, jamais écrit, journalisé ni renvoyé. Un arrêt relit le processus juste avant (numéro, heure de
// démarrage, marquage) et ne vise un groupe de processus que s'il ne contient rien d'autre.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets } from './indexer.mjs';

const SCAN_EVERY_MS = 30_000;      // relevé de fond (≈ 0,2 % d'un cœur)
const FRESH_MS = 4_000;            // page ouverte : relevé au plus toutes les 4 s
const FOOTPRINT_MS = 30_000;       // vraie mémoire : relevée au plus toutes les 30 s, seulement page ouverte
const MIN_AGE_WORKING_MS = 60_000; // conversation qui travaille : ses commandes du moment ne sont pas « en fond »
const KILL_AFTER_MS = 5_000;       // demande polie, puis arrêt forcé
const AUTO_AFTER_MS = 6 * 3600_000; // ménage automatique : Chrome oublié depuis 6 h…
const QUIET_MS = 10 * 60_000;       // …et qui ne consomme plus rien (moins de 1 % sur 10 min)
const QUIET_PCT = 1;
const LOG_MAX = 500;

const ENV = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const SID_RE = / CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})(?= |$)/;
const CPID_RE = / CLAUDE_PID=(\d+)(?= |$)/;
// pid ppid pgid uid lstart(5 mots) etime rss time stat comm
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/;

const clip = (s, n) => (s = String(s ?? '').replace(/\s+/g, ' ').trim(), s.length > n ? s.slice(0, n - 1) + '…' : s);
const startKey = (lstart) => String(lstart || '').replace(/\s+/g, ' ').trim();

// « 1-02:03:04 », « 02:03:04 », « 03:04 » → ms
export function parseElapsed(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s || '').trim());
  if (!m) return 0;
  return (((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +m[3]) * 60 + +m[4]) * 1000;
}
// Temps processeur « 12:34.56 », « 1:02:03.45 », « 1-02:03:04 » → secondes
export function parseCpu(s) {
  const t = String(s || '').trim();
  const d = /^(\d+)-(.*)$/.exec(t);
  const days = d ? +d[1] : 0;
  const parts = (d ? d[2] : t).split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return 0;
  return days * 86400 + parts.reduce((a, x) => a * 60 + x, 0);
}

export function parsePs(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    out.set(+m[1], { pid: +m[1], ppid: +m[2], pgid: +m[3], uid: +m[4], lstart: startKey(m[5]), elapsedMs: parseElapsed(m[6]),
      rssKb: +m[7], cpuSec: parseCpu(m[8]), stat: m[9], comm: m[10].trim() });
  }
  return out;
}

// Environnement : seules la conversation et le processus de Claude Code sont gardés ; la ligne est jetée aussitôt.
export function parseMarks(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const p = /^\s*(\d+)\s/.exec(line);
    if (!p) continue;
    const sid = SID_RE.exec(line);
    if (!sid) continue;
    const cpid = CPID_RE.exec(line);
    out.set(+p[1], { sid: sid[1], cpid: cpid ? +cpid[1] : null });
  }
  return out;
}

export function parseArgs(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(+m[1], m[2]);
  }
  return out;
}

// lsof -Fpn : ports en écoute par processus.
export function parsePorts(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'n' && pid) {
      const port = /:(\d+)$/.exec(line)?.[1];
      if (port) { if (!out.has(pid)) out.set(pid, new Set()); out.get(pid).add(+port); }
    }
  }
  return out;
}

// lsof -d cwd -Fpn : dossier courant par processus.
export function parseCwds(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// footprint : vraie mémoire (Mo) par processus, et processus avec qui chacun partage de la mémoire.
export function parseFootprint(text) {
  const mb = new Map(), shared = new Map();
  let cur = null;
  const unit = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 };
  for (const line of String(text || '').split('\n')) {
    const h = /\[(\d+)\]:.*Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(line);
    if (h) { cur = +h[1]; mb.set(cur, +h[2] * unit[h[3]]); continue; }
    const s = /^Shared with (.+):$/.exec(line.trim());
    if (s && cur) {
      const pids = [...s[1].matchAll(/\[(\d+)\]/g)].map((x) => +x[1]);
      if (!shared.has(cur)) shared.set(cur, new Set());
      for (const p of pids) shared.get(cur).add(p);
    }
  }
  return { mb, shared };
}

// Une app du Mac (pas un Chrome sans fenêtre caché dans un cache) : son paquet le plus extérieur.
function bundleOf(comm) {
  const m = /^((?:\/System)?\/Applications\/[^/]+\.app|\/Users\/[^/]+\/Applications\/[^/]+\.app)\/Contents\//.exec(comm || '');
  return m ? m[1] : null;
}
const isHeadless = (p, args) => /(?:^|\s)--headless(?:=\S+)?(?:\s|$)/.test(args || '') || /(?:chrome-headless-shell|headless_shell)$/.test(p.comm || '');
// Un navigateur piloté (Playwright, Puppeteer…) : sans fenêtre, ou automatisé, ou sur un profil jetable. Jamais une app
// à « quitter » (ce serait aussi quitter ton vrai navigateur).
const isAutomated = (p, args) => isHeadless(p, args)
  || /--enable-automation|--remote-debugging-(?:pipe|port)|(?:playwright|puppeteer)[\w-]*profile|\/T\/(?:playwright|puppeteer)/.test(args || '');
// Les navigateurs ne sont jamais rangés comme « app ouverte par un agent » : tu t'en sers toi-même.
const BROWSER = /^(?:Google Chrome(?: (?:Beta|Dev|Canary|for Testing))?|Chromium|Safari|Firefox|Arc|Dia|Brave Browser|Microsoft Edge|Opera|Vivaldi|Orion|Zen)$/;
const isCrashpad = (p) => /chrome_crashpad_handler$/.test(p.comm || '');
const isClaudeBin = (p) => /(?:^|\/)claude$/.test(p.comm || '');

const DEV_SERVER = /\b(?:vite|next(?:\s+dev)?|nuxt|astro|webpack(?:-dev-server)?|wrangler|remix|svelte-kit|parcel|gatsby|expo|storybook|turbo|nodemon|rails\s+s(?:erver)?|flask|uvicorn|gunicorn|django|manage\.py\s+runserver|hugo\s+server|jekyll\s+serve|eleventy|bun\s+--hot)\b/i;
const WEB_SERVER = /\b(?:http\.server|http-server|live-server|SimpleHTTPServer|serve)\b/;
const TESTS = /\b(?:vitest|jest|playwright\s+test|pytest|mocha|cypress|ava|tap)\b/;
const WATCH = /(?:\s--watch\b|\s-w\b|\bwatchexec\b|\bchokidar\b|\bfswatch\b|\btail\s+-f\b|\btsc\b.*\s--watch)/;
const DB = /\b(?:postgres|mysqld|mariadbd|redis-server|mongod|clickhouse)\b/;
// Vigie : son installation, son app (jamais listés)
const VIGIE_PATH = /\/\.vigie\/|\/Vigie\.app\/Contents\//;
const RENDER = /\b(?:remotion(?:\.js)?\s+render|ffmpeg|blender\s+-b)\b/;
const TOOL_OF = [[/ms-playwright|playwright/i, 'Playwright'], [/puppeteer/i, 'Puppeteer'], [/remotion/i, 'Remotion']];

// Nom court d'une commande : « node render.mjs », « npm run dev », « python3 -m http.server ».
export function commandName(args) {
  const t = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return '';
  const base = (x) => path.basename(x);
  const head = base(t[0]);
  if (/^(?:npm|npx|pnpm|yarn|bunx?)$/.test(head)) return clip(t.slice(0, 3).map(base).join(' '), 40);
  if (/^(?:node|python\d?(?:\.\d+)?|Python|ruby|deno|bun|php|perl)$/.test(head)) {
    const i = t.findIndex((x, k) => k > 0 && !x.startsWith('-'));
    if (t[1] === '-m' && t[2]) return clip(`${head} -m ${t[2]}`, 40);
    return clip(i > 0 ? `${head} ${base(t[i])}` : head, 40);
  }
  return clip(head, 40);
}

function describe(members, args, ports, bundle) {
  const all = members.map((p) => ({ p, a: args.get(p.pid) || p.comm }));
  const text = all.map((x) => x.a).join('\n');
  const root = all[0];
  // Chrome piloté : son processus principal (les annexes --type=… sont comptées dans « N processus »)
  const chrome = all.filter((x) => isAutomated(x.p, x.a) && !/--type=/.test(x.a)).length;
  const portList = [...new Set(members.flatMap((p) => [...(ports.get(p.pid) || [])]))].sort((a, b) => a - b);
  const tool = TOOL_OF.find(([re]) => re.test(text))?.[1] || null;
  const name = commandName(root.a);
  if (bundle && !chrome) return { kind: 'app', label: path.basename(bundle, '.app'), detail: `${members.length} processus` };
  if (RENDER.test(text)) return { kind: 'render', label: 'Rendu vidéo', detail: [name, chrome ? `${chrome} Chrome sans fenêtre` : null].filter(Boolean).join(' · ') };
  if (chrome && all.every((x) => isAutomated(x.p, x.a) || isCrashpad(x.p) || /Chrom|chrome|headless_shell/.test(x.p.comm))) {
    return { kind: 'chrome', label: 'Chrome sans fenêtre', detail: [`${members.length} processus`, tool].filter(Boolean).join(' · ') };
  }
  if (portList.length || DEV_SERVER.test(text)) {
    const label = DEV_SERVER.test(text) ? 'Serveur de dev' : WEB_SERVER.test(text) ? 'Serveur web' : 'Serveur';
    return { kind: 'server', label: portList.length ? `${label} sur ${portList.length > 1 ? 'les ports' : 'le port'} ${portList.join(', ')}` : label, detail: name, ports: portList };
  }
  if (TESTS.test(text)) return { kind: 'tests', label: 'Tests', detail: name };
  if (WATCH.test(text)) return { kind: 'watch', label: 'Surveillance', detail: name };
  if (DB.test(text)) return { kind: 'db', label: 'Base de données', detail: name };
  if (chrome) return { kind: 'chrome', label: 'Chrome sans fenêtre', detail: [name, `${chrome} Chrome`].join(' · ') };
  return { kind: 'command', label: name || 'Commande', detail: members.length > 1 ? `${members.length} processus` : null };
}

// Mac saturé (des Chrome à 100 %) : ps peut mettre plus de 5 s ; un relevé raté garde le précédent.
function defaultRun(cmd, args, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: ENV }, (err, stdout) => {
      // Jamais le texte d'erreur : il peut contenir l'environnement des processus.
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {() => Map<string, {pid:number, procStart?:string, status?:string}>} o.live  conversations ouvertes (registre)
 * @param {(sid:string) => ({title?:string, project?:string, cwd?:string, lastTs?:string}|null)} o.conversation
 * @param {() => boolean} [o.autoStop]  réglage « arrêter seuls les Chrome oubliés »
 */
export function createProcesses({ dataDir, live, conversation, autoStop = () => false, run = defaultRun,
  kill = (pid, sig) => process.kill(pid, sig), now = () => Date.now(), uid = process.getuid?.() ?? -1, selfPid = process.pid,
  log = () => {}, onChange = () => {} }) {
  const LOG = path.join(dataDir, 'processes-log.jsonl');
  let last = null;            // dernier relevé
  let scanning = null;        // relevé en cours (promesse partagée)
  let footprintAt = 0;
  let footprint = { mb: new Map(), shared: new Map() };
  const cpuHistory = new Map(); // id de groupe → [{ at, cpuSec }] (10 min)
  const stopping = new Map();   // id de groupe → heure de l'arrêt demandé (l'app l'a déjà retiré de l'écran)
  let autoStopped = [];         // derniers arrêts automatiques, pour la notification de l'app

  async function scan({ withFootprint = false } = {}) {
    const [ps, marks, argsOut] = await Promise.all([
      run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,etime=,rss=,time=,stat=,comm=']),
      run('/bin/ps', ['-E', '-ww', '-axo', 'pid=,command=']),
      run('/bin/ps', ['-axww', '-o', 'pid=,args=']),
    ]);
    if (!ps.ok) {
      if (last) return { ...last, stale: true }; // le Mac est trop chargé : on garde le dernier relevé
      throw new Error('Impossible de lire les processus.');
    }
    const procs = parsePs(ps.stdout);
    const mark = parseMarks(marks.stdout);
    marks.stdout = ''; // l'environnement ne reste pas en mémoire
    const args = parseArgs(argsOut.stdout);
    const liveMap = live();
    const livePids = new Set([...liveMap.values()].map((l) => Number(l.pid)).filter(Boolean));

    // Les processus listés : marqués par une commande (CLAUDE_PID), à l'utilisateur, ni Claude Code ni Vigie.
    const listed = new Map();
    // Vigie lui-même (son crochet hook.mjs, son moteur, son app) : jamais listé, jamais arrêté.
    const isVigie = (p) => VIGIE_PATH.test(p.comm || '') || VIGIE_PATH.test(args.get(p.pid) || '');
    const eligible = (pid, p) => p.uid === uid && pid !== selfPid && !livePids.has(pid) && !isClaudeBin(p) && !isVigie(p);
    for (const [pid, p] of procs) {
      const m = mark.get(pid);
      if (!m || !m.cpid || !eligible(pid, p)) continue;
      listed.set(pid, { ...p, sid: m.sid, cpid: m.cpid, marked: true });
    }
    // Leur descendance, même sans marquage lisible : Google Chrome (runtime durci) cache son environnement à macOS ;
    // un Chrome lancé par un script de la conversation lui appartient quand même.
    const children = new Map();
    for (const p of procs.values()) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p);
    }
    const queue = [...listed.values()];
    while (queue.length) {
      const parent = queue.shift();
      for (const c of children.get(parent.pid) || []) {
        if (listed.has(c.pid) || !eligible(c.pid, c)) continue;
        const child = { ...c, sid: parent.sid, cpid: parent.cpid, marked: false };
        listed.set(c.pid, child);
        queue.push(child);
      }
    }
    // Chrome automatisé (Playwright, Puppeteer) orphelin, sans marquage lisible : oublié, d'une conversation inconnue.
    // Jamais ton Chrome à toi : il faut --enable-automation ET un profil jetable ou --headless.
    for (const [pid, p] of procs) {
      if (listed.has(pid) || p.ppid !== 1 || !eligible(pid, p)) continue;
      const a = args.get(pid) || '';
      if (!/--enable-automation/.test(a) || !(/--headless/.test(a) || /(?:playwright|puppeteer)[\w-]*profile|\/T\/(?:playwright|puppeteer)/.test(a))) continue;
      const root = { ...p, sid: null, cpid: null, marked: false };
      listed.set(pid, root);
      const stack = [root];
      while (stack.length) {
        const parent = stack.pop();
        for (const c of children.get(parent.pid) || []) {
          if (listed.has(c.pid) || !eligible(c.pid, c)) continue;
          const child = { ...c, sid: null, cpid: null, marked: false };
          listed.set(c.pid, child);
          stack.push(child);
        }
      }
    }
    // Groupes : un processus et sa descendance listée ; une app, tous ses processus de la même conversation.
    const groups = new Map();
    // Une app se décide sur la racine de sa lignée : les processus d'un Chrome piloté (rendu, GPU…) suivent leur
    // racine, même sans --headless.
    const rootOf = (p) => { let r = p; while (listed.has(r.ppid) && listed.get(r.ppid).sid === p.sid) r = listed.get(r.ppid); return r; };
    const appOf = (r) => {
      const b = bundleOf(r.comm);
      if (!b || isAutomated(r, args.get(r.pid)) || BROWSER.test(path.basename(b, '.app'))) return null;
      return b;
    };
    for (const p of listed.values()) {
      const root = rootOf(p);
      const sidKey = p.sid ? p.sid.slice(0, 8) : 'inconnue';
      const appBundle = appOf(root);
      const key = appBundle ? `a:${sidKey}:${path.basename(appBundle, '.app').replace(/[^\w.-]+/g, '-')}`
        : `p:${root.pid}-${Math.round(Date.parse(root.lstart + ' UTC') / 1000) || 0}`;
      if (!groups.has(key)) groups.set(key, { id: key, sid: p.sid, cpid: p.cpid, bundle: appBundle, root: appBundle ? null : root, members: [] });
      groups.get(key).members.push(p);
    }
    for (const [key, g] of groups) {
      // un navigateur non piloté (ouvert par « open -a » : c'est le tien) n'est jamais listé
      const b = bundleOf(g.root?.comm || g.members[0]?.comm);
      if (b && BROWSER.test(path.basename(b, '.app')) && !g.members.some((m) => isAutomated(m, args.get(m.pid)))) groups.delete(key);
    }
    // Racine d'une app : son processus le plus ancien.
    for (const g of groups.values()) {
      g.members.sort((a, b) => b.elapsedMs - a.elapsedMs);
      if (!g.root) g.root = g.members[0];
      else g.members.sort((a, b) => (a === g.root ? -1 : b === g.root ? 1 : b.elapsedMs - a.elapsedMs));
    }

    const ports = new Map();
    if (groups.size) {
      const lsof = await run('/usr/sbin/lsof', ['-b', '-w', '-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-u', String(uid), '-Fpn'], { timeout: 10_000 });
      for (const [pid, set] of parsePorts(lsof.stdout)) if (listed.has(pid)) ports.set(pid, set);
    }
    const cwds = new Map();
    const roots = [...groups.values()].map((g) => g.root.pid);
    if (roots.length) {
      const lsof = await run('/usr/sbin/lsof', ['-b', '-w', '-a', '-d', 'cwd', '-Fpn', '-p', roots.join(',')], { timeout: 10_000 });
      for (const [pid, dir] of parseCwds(lsof.stdout)) cwds.set(pid, dir);
    }
    const at = now();
    if (withFootprint && groups.size && at - footprintAt > FOOTPRINT_MS) {
      footprintAt = at;
      // Les machines virtuelles (Docker, OrbStack…) ne portent pas de marquage : rattachées par leur mémoire partagée.
      const vms = [...procs.values()].filter((p) => p.uid === uid && /com\.apple\.Virtualization\.VirtualMachine$/.test(p.comm)).map((p) => p.pid);
      const pids = [...listed.keys(), ...vms].slice(0, 400);
      const fp = await run('/usr/bin/footprint', pids.flatMap((p) => ['-p', String(p)]), { timeout: 8000 });
      if (fp.ok) footprint = parseFootprint(fp.stdout);
    }

    const out = [];
    for (const g of groups.values()) {
      const conv = (g.sid && conversation(g.sid)) || {};
      const l = g.sid ? liveMap.get(g.sid) : null;
      const open = !!l && Number(l.pid) === g.cpid;
      const d = describe(g.members, args, ports, g.bundle);
      const oldest = Math.max(...g.members.map((p) => p.elapsedMs));
      const state = d.kind === 'app' ? 'app' : open ? (l.status === 'idle' ? 'idle' : l.status === 'waiting' ? 'waiting' : 'working') : 'forgotten';
      if (state === 'working' && oldest < MIN_AGE_WORKING_MS) continue; // la commande du moment, pas « en fond »
      if (stopping.has(g.id) && at - stopping.get(g.id) < 60_000) continue;
      const rssMb = g.members.reduce((s, p) => s + p.rssKb, 0) / 1024;
      let realMb = null;
      if (footprint.mb.size) {
        const own = g.members.reduce((s, p) => s + (footprint.mb.get(p.pid) || 0), 0);
        // Toute la mémoire « partagée » ne prouve rien (le cache système l'est par tous) : seule une app (Docker,
        // OrbStack…) reçoit la machine virtuelle avec qui elle partage de la mémoire.
        const vms = d.kind !== 'app' ? [] : [...footprint.shared].filter(([vm, with_]) => /Virtualization/.test(procs.get(vm)?.comm || '') && g.members.some((p) => with_.has(p.pid)));
        realMb = own + vms.reduce((s, [vm]) => s + (footprint.mb.get(vm) || 0), 0);
        if (vms.length) d.detail = [d.detail, 'et sa machine virtuelle'].filter(Boolean).join(' ');
      }
      const cpuSec = g.members.reduce((s, p) => s + p.cpuSec, 0);
      // Processeur : écart de temps processeur entre deux relevés (le %cpu de ps est une moyenne lissée).
      const hist = (cpuHistory.get(g.id) || []).filter((x) => at - x.at <= 3 * QUIET_MS);
      const prev = hist[hist.length - 1];
      const base = [...hist].reverse().find((x) => at - x.at >= QUIET_MS);
      hist.push({ at, cpuSec });
      cpuHistory.set(g.id, hist);
      const pct = (from) => Math.max(0, (cpuSec - from.cpuSec) / ((at - from.at) / 1000) * 100);
      const cpu = prev && at > prev.at ? pct(prev) : null;
      const quiet = !!base && pct(base) < QUIET_PCT;
      const startedAt = new Date(at - oldest).toISOString();
      const cwd = cwds.get(g.root.pid) || null;
      const project = conv.project || path.basename(conv.cwd || cwd || '') || null;
      // Oublié depuis : la fin de sa conversation (dernière activité), sinon son démarrage.
      const forgottenSince = state === 'forgotten' ? new Date(Math.max(Date.parse(conv.lastTs || '') || 0, at - oldest)).toISOString() : null;
      out.push({
        id: g.id, kind: d.kind, label: d.label, detail: d.detail || null, ports: d.ports || [],
        processes: g.members.length, memoryMb: Math.round(realMb ?? rssMb), memoryReal: realMb !== null,
        cpu: cpu === null ? null : Math.round(cpu), quiet,
        startedAt, state, forgottenSince,
        conversationId: g.sid, conversationTitle: conv.title || null, project, cwd: cwd || conv.cwd || null,
        command: clip(maskSecrets(args.get(g.root.pid) || g.root.comm), 300), bundle: g.bundle,
        members: g.members.map((p) => ({ pid: p.pid, lstart: p.lstart, pgid: p.pgid, marked: !!p.marked })),
      });
    }
    for (const id of cpuHistory.keys()) if (!groups.has(id)) cpuHistory.delete(id);
    const order = { forgotten: 0, app: 1, working: 2, waiting: 2, idle: 3 };
    out.sort((a, b) => (order[a.state] - order[b.state]) || (b.memoryMb - a.memoryMb));
    last = { at, groups: out, procs };
    return last;
  }

  async function snapshot({ fresh = false, withFootprint = false } = {}) {
    if (scanning) return scanning;
    if (last && !withFootprint && now() - last.at < (fresh ? FRESH_MS : SCAN_EVERY_MS)) return last;
    scanning = scan({ withFootprint }).finally(() => { scanning = null; });
    return scanning;
  }

  // Vue pour l'API : sans les numéros de processus ni la liste détaillée (seulement ce qu'il faut afficher).
  function view(snap = last) {
    if (!snap) return { scannedAt: null, groups: [], total: { groups: 0, processes: 0, memoryMb: 0 }, forgotten: { groups: 0, processes: 0, memoryMb: 0 }, autoStop: autoStop(), autoStopped };
    const groups = snap.groups.map(({ members, ...g }) => g);
    const forgotten = groups.filter((g) => g.state === 'forgotten');
    return {
      scannedAt: new Date(snap.at).toISOString(),
      total: { groups: groups.length, processes: groups.reduce((s, g) => s + g.processes, 0), memoryMb: groups.reduce((s, g) => s + g.memoryMb, 0) },
      forgotten: { groups: forgotten.length, processes: forgotten.reduce((s, g) => s + g.processes, 0), memoryMb: forgotten.reduce((s, g) => s + g.memoryMb, 0) },
      autoStop: autoStop(), autoStopped, groups,
    };
  }

  function writeLog(entry) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
      const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
      if (lines.length > LOG_MAX) fs.writeFileSync(LOG, lines.slice(-LOG_MAX).join('\n') + '\n', { mode: 0o600 });
    } catch { /* le journal ne doit jamais empêcher un arrêt */ }
  }

  // Relit juste avant d'agir : même numéro, même heure de démarrage, même conversation.
  async function verified(group) {
    const pids = group.members.map((m) => m.pid);
    const [ps, marks] = await Promise.all([
      run('/bin/ps', ['-o', 'pid=,ppid=,pgid=,uid=,lstart=,etime=,rss=,time=,stat=,comm=', '-p', pids.join(',')]),
      run('/bin/ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')]),
    ]);
    const now_ = parsePs(ps.stdout);
    const mk = parseMarks(marks.stdout);
    marks.stdout = '';
    return group.members.filter((m) => {
      const p = now_.get(m.pid);
      // même numéro, même heure de démarrage, même conversation (pour ceux dont le marquage se lit)
      return p && p.lstart === m.lstart && p.uid === uid && (!m.marked || mk.get(m.pid)?.sid === group.conversationId)
        && !isClaudeBin(p) && m.pid !== selfPid;
    });
  }

  // Un groupe de processus n'est signalé que s'il ne contient rien d'autre que ce groupe (jamais celui de VS Code).
  function soleGroup(group, procs) {
    const pgids = new Set(group.members.map((m) => m.pgid));
    if (pgids.size !== 1) return null;
    const [pgid] = pgids;
    if (pgid <= 1) return null;
    const mine = new Set(group.members.map((m) => m.pid));
    for (const p of procs.values()) if (p.pgid === pgid && !mine.has(p.pid)) return null;
    return pgid;
  }

  async function stopGroup(group, { reason = 'user', procs, grace = KILL_AFTER_MS } = {}) {
    const alive = await verified(group);
    if (!alive.length) return { ok: true, gone: true };
    const pgid = alive.length === group.members.length ? soleGroup(group, procs || last?.procs || new Map()) : null;
    let sent = 0;
    try {
      if (pgid) { kill(-pgid, 'SIGTERM'); sent = alive.length; }
      else for (const m of alive) { try { kill(m.pid, 'SIGTERM'); sent++; } catch { /* déjà parti */ } }
    } catch (e) {
      return { ok: false, error: e.code === 'EPERM' ? 'macOS refuse cet arrêt.' : 'Arrêt impossible.' };
    }
    stopping.set(group.id, now());
    writeLog({ action: reason === 'auto' ? 'auto' : 'stop', kind: group.kind, label: group.label, project: group.project,
      processes: alive.length, memoryMb: group.memoryMb });
    // Ceux qui résistent : arrêt forcé 5 s plus tard, après avoir relu qu'il s'agit toujours d'eux.
    setTimeout(async () => {
      try {
        const left = await verified({ ...group, members: alive });
        for (const m of left) { try { kill(m.pid, 'SIGKILL'); } catch { /* parti entre-temps */ } }
      } catch { /* rien à faire */ }
      onChange();
    }, grace).unref?.();
    return { ok: true, signalled: sent };
  }

  // POST /api/v2/processes/stop { ids, confirm?, app? }
  // app : une app ouverte par un agent dont macOS ne voit plus la fenêtre (Docker sans son interface, mais avec son
  // moteur et sa machine virtuelle) : arrêt poli, 30 s pour qu'elle s'éteigne proprement, puis arrêt forcé.
  async function stop(ids, { confirm = false, app = false } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((x) => typeof x === 'string' && x.length < 200)) {
      return { ok: false, status: 400, error: 'Indique ce qu\'il faut arrêter.' };
    }
    const snap = await scan();
    const results = [];
    for (const id of ids) {
      const g = snap.groups.find((x) => x.id === id);
      if (!g) { results.push({ id, ok: true, gone: true }); continue; }
      if (g.state === 'app' && !app) { results.push({ id, ok: false, error: 'Une app se quitte comme avec ⌘Q : Vigie te la propose à part.' }); continue; }
      if (g.state === 'app') { results.push({ id, ...(await stopGroup(g, { procs: snap.procs, grace: 30_000 })) }); continue; }
      if ((g.state === 'working' || g.state === 'waiting') && !confirm) {
        results.push({ id, ok: false, needsConfirm: true, error: 'Sa conversation travaille encore : l\'arrêter peut casser son travail.' });
        continue;
      }
      results.push({ id, ...(await stopGroup(g, { procs: snap.procs })) });
    }
    onChange();
    return { ok: results.every((r) => r.ok), results };
  }

  // Ménage automatique : Chrome sans fenêtre dont la conversation est fermée depuis 6 h et qui ne consomme plus rien.
  let failures = 0;
  async function tick() {
    let snap;
    try { snap = await snapshot(); failures = 0; } catch (e) {
      // une ligne de journal par série d'échecs, pas une toutes les 30 s
      if (failures++ === 0) log(`processus : ${e.message}`);
      return null;
    }
    if (!autoStop()) return snap;
    const at = now();
    for (const g of snap.groups) {
      if (g.kind !== 'chrome' || g.state !== 'forgotten' || !g.quiet) continue;
      if (at - Date.parse(g.forgottenSince) < AUTO_AFTER_MS) continue;
      const r = await stopGroup(g, { reason: 'auto', procs: snap.procs });
      if (r.ok && !r.gone) {
        autoStopped = [{ id: `${g.id}:${at}`, ts: new Date(at).toISOString(), label: g.label, project: g.project,
          processes: g.processes, memoryMb: g.memoryMb }, ...autoStopped].slice(0, 20);
        log(`processus : ${g.label} (${g.project || '?'}) arrêté seul, ${g.processes} processus`);
      }
    }
    return snap;
  }

  // Ce que la page d'une conversation montre : ses groupes en fond (résumé).
  function byConversation(sid) {
    if (!last) return null;
    const mine = last.groups.filter((g) => g.conversationId === sid);
    if (!mine.length) return null;
    const top = mine[0];
    return { count: mine.length, memoryMb: mine.reduce((s, g) => s + g.memoryMb, 0), label: top.label, state: top.state };
  }

  return { snapshot, view, stop, tick, byConversation, everyMs: SCAN_EVERY_MS, last: () => last };
}

export const _test = { describe, bundleOf, isHeadless };
