// Vues « conversations » de l'API v2 (docs/api-v2.md), tirées de l'indexeur. Rien ici n'écrit de fichier, et
// rien n'en lit sinon par l'indexeur (plans suivis) : le serveur ajoute ce qui vient des réglages, des comptes et
// du hook (compte, auto-accept, connecteurs, part de la semaine, « à regarder », décisions acceptées, MCP activés).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLocation, projectRootOf } from './indexer.mjs';

const WEEK = 7 * 24 * 3600_000;
const RECENT_FAIL_MS = 2 * 3600_000;  // carte : échecs des 2 dernières heures
const LIVE_RUN_MS = 12 * 3600_000;    // test de fond sans nouvelles depuis 12 h : plus « en cours »
// Dossiers temporaires : une conversation lancée là (essai, claude -p, brouillon) est jetable.
const TEMP_DIR = /^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/;
const TEMP_PROJECT = /^-(?:private-)?(?:tmp|var-folders)-/;
export function isTempPath(p) {
  const f = String(p || '');
  if (!f) return false;
  const home = os.homedir();
  if (f === home || f.startsWith(home + path.sep)) return false; // le dossier personnel n'est jamais jetable
  const tmp = os.tmpdir();
  return TEMP_DIR.test(f) || f === tmp || f.startsWith(tmp + path.sep) || /\/scratchpad(?:\/|$)/.test(f);
}
const MAX_CHAPTERS = 30, MAX_ACTIVITY = 300, MAX_DONE_AGENTS = 150, MAX_FILES = 400, MAX_TESTS = 300, MAX_MILESTONES = 150;
// Une fin de mission mérite un rapport si la demande a donné du travail (pas un simple échange) et si l'utilisateur
// n'était pas là pour la voir : resté au moins 10 min sans répondre, ou conversation au repos maintenant.
const MISSION_MIN_ACTIONS = 5, MISSION_MIN_MS = 5 * 60_000, MISSION_AWAY_MS = 10 * 60_000;

const byTsDesc = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''));
const ms = (iso) => Date.parse(iso || '') || 0;
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// États internes (meta, notifications, fichiers de workflow) -> vocabulaire de l'API.
const RUN_STATUS = { completed: 'done', done: 'done', failed: 'failed', killed: 'killed', stopped: 'killed', running: 'running', idle: 'idle' };

export function createConversations(ix) {
  const titleOf = (s) => s.title || ix.live.get(s.id)?.name || s.projectDir;

  // État vu de l'utilisateur : working | idle | waiting | blocked | closed (le serveur précise blocked grâce au hook).
  function statusOf(s) {
    const live = ix.live.get(s.id);
    if (!live) return 'closed';
    if (live.status === 'waiting' || live.waitingFor) return 'waiting';
    if (live.status === 'blocked') return 'blocked';
    if (live.status === 'idle') return 'idle';
    return 'working'; // busy, shell, ou registre sans statut
  }

  const lastActivity = (s) => {
    let m = s.lastTs || '';
    for (const a of s.agents.values()) if (a.lastTs && a.lastTs > m) m = a.lastTs;
    return m || null;
  };

  // Conversation jetable (lancée dans un dossier temporaire ou un brouillon) : hors de la vue d'ensemble, sauf ouverte.
  function throwaway(s) {
    if (ix.live.has(s.id)) return false;
    const cwd = s.cwd;
    return cwd ? isTempPath(cwd) : TEMP_PROJECT.test(s.projectDir || '');
  }

  // Liste de tâches courante : la plus récente (TodoWrite ou TaskCreate/TaskUpdate), si elle date de la demande en cours.
  function taskListOf(s) {
    const cur = s.chapters[s.chapters.length - 1];
    const lists = [];
    if (s.todos) lists.push({ ts: s.todos.ts, items: s.todos.items });
    if (s.taskList?.items.size) lists.push({ ts: s.taskList.ts, items: [...s.taskList.items.values()] });
    const best = lists.sort(byTsDesc)[0];
    if (!best || (cur && best.ts < cur.start)) return null;
    return { ts: best.ts, items: best.items.map((t) => ({ text: t.text, status: t.status })) };
  }

  // Progression de la carte : le plan suivi (étapes faites / toutes), sinon la liste de tâches.
  function progressOf(plan, list) {
    if (plan) {
      const st = plan.steps.find((x) => (x.id || x.text) === plan.current && x.status !== 'done');
      const current = st ? short(st.id ? `${st.id} ${st.text}` : st.text, 90) : null;
      return { done: plan.done, total: plan.total, label: short(plan.title, 60), current };
    }
    if (!list?.items.length) return null;
    let done = 0;
    for (const t of list.items) if (t.status === 'done') done++;
    const cur = list.items.find((t) => t.status === 'doing') || list.items.find((t) => t.status === 'todo');
    return { done, total: list.items.length, label: 'Tâches', current: cur ? short(cur.text, 90) : null };
  }

  const testTitle = (t, n) => (t.description ? short(t.description, n) : short(t.command, n));

  // Tests de la carte : échecs récents non rattrapés (une réussite du même genre après l'échec l'efface ; l'étape
  // rouge voulue ne compte pas), tests lancés en fond pas encore finis (conversation ouverte), dernier résultat.
  function testsOf(s, now = Date.now()) {
    const okAt = new Map();
    for (const t of s.tests) if (t.ok === true && !t.pending && !(okAt.get(t.kind) >= t.ts)) okAt.set(t.kind, t.ts);
    const since = new Date(now - RECENT_FAIL_MS).toISOString();
    const live = ix.live.has(s.id);
    let failedRecent = 0, running = 0, last = null;
    for (const t of s.tests) {
      if (t.pending) { if (live && now - ms(t.ts) < LIVE_RUN_MS) running++; continue; }
      if (t.ok == null || (t.ok === false && t.red)) continue;
      if (t.ok === false && t.ts >= since && !(okAt.get(t.kind) > t.ts)) failedRecent++;
      if (!last || t.ts > last.ts) last = t;
    }
    return { failedRecent, running, lastOk: last ? last.ok : null, lastTs: last?.ts || null, lastTitle: last ? testTitle(last, 80) || null : null };
  }

  function artifactsOf(s) {
    let last = null;
    for (const a of s.artifacts.values()) if (!last || String(a.lastTs || '') > String(last.lastTs || '')) last = a;
    return { count: s.artifacts.size,
      last: last ? { title: last.title || (last.path && path.basename(last.path)) || 'Artefact', url: last.url || null, ts: last.lastTs || null } : null };
  }

  function headlineOf(s, tasks) {
    const doing = tasks.find((t) => t.status === 'doing');
    if (doing) return short(doing.text, 90);
    if (!s.lastText) return null;
    const first = s.lastText.text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
    return short(first, 90) || null;
  }

  function summaryOf(s, sinceIso) {
    const live = ix.live.get(s.id);
    const cwd = live?.cwd || s.cwd || null;
    const list = taskListOf(s);
    const tasks = list?.items || [];
    let agentsRunning = 0, workflowsRunning = 0;
    for (const a of s.agents.values()) if (ix.agentStatus(s, a) === 'running') agentsRunning++;
    for (const w of s.workflows.values()) if (ix.workflowStatus(s, w) === 'running') workflowsRunning++;
    const usageByOrg = {};
    for (const [k, v] of s.wByHour) {
      const bar = k.indexOf('|');
      if (Number(k.slice(0, bar)) * 3600_000 + 3600_000 <= ms(sinceIso)) continue;
      const org = k.slice(bar + 1);
      usageByOrg[org] = (usageByOrg[org] || 0) + v;
    }
    for (const k of Object.keys(usageByOrg)) usageByOrg[k] = Math.round(usageByOrg[k]);
    return {
      id: s.id,
      title: titleOf(s),
      project: cwd ? path.basename(cwd) : s.projectDir,
      cwd,
      status: statusOf(s),
      running: !!live,
      agentsRunning,
      workflowsRunning,
      lastActivity: lastActivity(s),
      headline: headlineOf(s, tasks),
      waitingFor: live?.waitingFor || null,
      // Outil d'où elle vient : claude-vscode, claude-desktop (app Claude), cli…
      entrypoint: live?.entrypoint || s.entrypoint || null,
      // Pour la part de la semaine : poids d'usage depuis sinceIso (toutes organisations) et par organisation.
      usageWeight: ix.usageWeight(s, sinceIso),
      usageByOrg,
      org: s.org,
      // Pour le coût d'une bascule de compte : taille du contexte de la dernière réponse.
      contextTokens: s.context?.tokens ?? null,
      // Carte de la vue d'ensemble (accepted vient de l'historique du hook : le serveur l'ajoute).
      progress: progressOf(ix.planOf(s), list),
      tests: testsOf(s),
      artifacts: artifactsOf(s),
    };
  }

  // Conversations ouvertes d'abord, puis les plus récentes ; les jetables fermées n'y sont pas.
  function summaries(sinceIso = new Date(Date.now() - WEEK).toISOString()) {
    return [...ix.sessions.values()].filter((s) => !throwaway(s)).map((s) => summaryOf(s, sinceIso))
      .sort((a, b) => (b.running - a.running) || String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  }

  function agentView(s, a) {
    const w = a.runId ? s.workflows.get(a.runId) : null;
    const st = ix.agentStatus(s, a);
    return {
      id: a.id,
      title: a.description || a.type || a.id,
      type: a.type,
      workflow: w ? (w.name || w.runId) : null,
      phase: a.phase || null,
      startedAt: a.firstTs,
      lastAt: a.lastTs,
      durationMs: a.firstTs && a.lastTs ? ms(a.lastTs) - ms(a.firstTs) : null,
      actions: a.tools,
      files: a.files,
      tests: a.tests,
      status: RUN_STATUS[st] || st,
      lastAction: a.lastAction,
    };
  }

  function chapterStats(s, ch, next) {
    const end = next ? next.start : '￿';
    const inside = (ts) => ts && ts >= ch.start && ts < end;
    let agents = 0, workflows = 0, artifacts = 0;
    for (const a of s.agents.values()) if (inside(a.firstTs)) agents++;
    for (const w of s.workflows.values()) if (inside(w.launchTs || w.startTs)) workflows++;
    for (const a of s.artifacts.values()) if (a.chapters.has(ch)) artifacts++;
    return { workflows, agents, artifacts, files: ch.files.size, tests: ch.tests, testsFailed: ch.testsFailed, commits: ch.commits };
  }

  function chaptersOf(s) {
    const c = s.chapters;
    const out = [];
    for (let i = c.length - 1; i >= 0 && out.length < MAX_CHAPTERS; i--) {
      const ch = c[i];
      out.push({ id: ch.id, prompt: ch.prompt, start: ch.start, end: ch.end, durationMs: Math.max(0, ms(ch.end) - ms(ch.start)),
        stats: chapterStats(s, ch, c[i + 1]), outcome: ch.outcome?.text || null });
    }
    return out;
  }

  // Le fil d'une conversation : ce qui compte, sans les centaines de petites actions (lectures, commandes).
  // Tes demandes, ses comptes rendus, commits, push, déploiements, agents et workflows finis, tests qui
  // passent au rouge puis reviennent au vert, artefacts publiés, limites. Plus récent d'abord.
  function milestonesOf(s, doneAgents, workflows) {
    const out = [];
    const add = (m) => { if (m.ts) out.push(m); };
    const firstSentence = (t) => short(String(t || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '', 220);
    for (const ch of s.chapters) {
      add({ ts: ch.start, kind: 'prompt', title: ch.prompt });
      if (ch.outcome?.text) {
        const lines = String(ch.outcome.text).split('\n').map((l) => l.trim()).filter(Boolean);
        const rest = short(lines.slice(1).join(' '), 500);
        add({ ts: ch.outcome.ts, kind: 'report', title: firstSentence(ch.outcome.text), detail: rest || null });
      }
    }
    for (const e of s.activity) {
      const by = e.agent ? s.agentLabel(e.agent) : null;
      if (e.kind === 'commit') add({ ts: e.ts, kind: 'commit', title: e.msg || e.title || 'Commit', by });
      else if (e.kind === 'push') add({ ts: e.ts, kind: 'push', title: e.title || 'Push', by });
      else if (e.milestone) add({ ts: e.ts, kind: e.milestone, title: e.title || (e.milestone === 'deploy' ? 'Déploiement' : 'Demande de fusion'), by, ok: e.ok ?? null });
    }
    for (const a of doneAgents) {
      add({ ts: a.lastAt, kind: 'agent', title: a.title || 'Agent', ok: a.status !== 'failed',
        detail: [a.durationMs ? `${Math.max(1, Math.round(a.durationMs / 60_000))} min` : null, a.files ? `${a.files} fichiers` : null].filter(Boolean).join(' · ') || null });
    }
    for (const w of workflows) {
      if (w.status === 'running') continue;
      const end = w.startedAt && w.durationMs ? new Date(ms(w.startedAt) + w.durationMs).toISOString() : w.startedAt;
      add({ ts: end, kind: 'workflow', title: w.name, detail: w.summary || null, ok: w.status !== 'failed' });
    }
    // tests : le passage au rouge (une seule ligne par série d'échecs), puis le retour au vert
    let red = false;
    for (const t of [...s.tests].filter((x) => !x.pending).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
      if (t.ok === false && !t.red && !red) { red = true; add({ ts: t.ts, kind: 'tests', ok: false, title: t.description || short(t.command, 80) || 'Tests', detail: t.line || null }); }
      else if (t.ok === true && red) { red = false; add({ ts: t.ts, kind: 'tests', ok: true, title: t.description || short(t.command, 80) || 'Tests' }); }
    }
    for (const a of s.artifacts.values()) add({ ts: a.lastTs, kind: 'artifact', title: a.title || 'Artefact', url: a.url || null });
    let lastLimit = 0;
    for (const l of [...s.limits].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
      if (ms(l.ts) - lastLimit < 10 * 60_000) continue; // une limite touchée par plusieurs agents à la fois : une ligne
      lastLimit = ms(l.ts);
      add({ ts: l.ts, kind: 'limit', title: 'Limite atteinte', detail: l.text || null });
    }
    return out.sort(byTsDesc).slice(0, MAX_MILESTONES);
  }

  // Où en est la demande en cours : le dernier message de l'utilisateur, depuis quand, ce qui en est sorti.
  // Sa feuille de route quand elle n'a pas de plan reconnu : le document d'état qu'elle tient à jour (ETAT.md,
  // STATUS, ROADMAP, TODO, suivi, retours… sinon le .md du projet qu'elle a modifié le plus récemment, au moins
  // deux fois en 7 jours), découpé en sections (titres « ## »). Ce que chaque projet range à sa façon.
  const docCache = new Map();
  const STATE_DOC = /(?:^|[-_ ])(?:etat|état|state|status|roadmap|todo|suivi|avancement|retours|progress)(?:[-_ .]|$)/i;
  const NOT_DOC = /^(?:CLAUDE|AGENTS|README|CHANGELOG|LICENSE|CONTRIBUTING)\.md$/i;
  function trackingDocOf(s, cwd) {
    const root = projectRootOf(cwd || s.cwd);
    const week = Date.now() - 7 * 86_400_000;
    const docs = [...s.files.values()].filter((f) => /\.md$/i.test(f.path) && f.ops >= 2 && ms(f.lastTs) > week
      && !NOT_DOC.test(path.basename(f.path)) && !f.path.includes('/.claude/') && (!root || f.path.startsWith(root + path.sep)));
    if (!docs.length) return null;
    docs.sort((a, b) => (STATE_DOC.test(path.basename(b.path, '.md')) - STATE_DOC.test(path.basename(a.path, '.md'))) || (ms(b.lastTs) - ms(a.lastTs)));
    const f = docs[0];
    let st; try { st = fs.statSync(f.path); } catch { return null; }
    const c = docCache.get(f.path);
    if (c && c.mtimeMs === st.mtimeMs) return c.doc;
    let text; try { text = fs.readFileSync(f.path, 'utf8').slice(0, 200_000); } catch { return null; }
    let title = path.basename(f.path), intro = [];
    const sections = [];
    for (const line of text.split('\n')) {
      const h1 = /^#\s+(.+)/.exec(line), h2 = /^##\s+(.+)/.exec(line);
      if (h1 && !sections.length && !intro.length) { title = h1[1].trim(); continue; }
      if (h2) { sections.push({ title: h2[1].trim(), lines: [] }); continue; }
      (sections.length ? sections[sections.length - 1].lines : intro).push(line);
    }
    const clip = (lines) => lines.join('\n').trim().slice(0, 6000);
    const doc = { path: f.path, title, updatedAt: new Date(st.mtimeMs).toISOString(), edits: f.ops,
      intro: clip(intro) || null,
      sections: sections.slice(0, 12).map((x) => ({ title: x.title, text: clip(x.lines) })).filter((x) => x.text),
      others: docs.slice(1, 4).map((d) => ({ path: d.path, ts: d.lastTs, edits: d.ops })) };
    if (docCache.size > 50) docCache.clear();
    docCache.set(f.path, { mtimeMs: st.mtimeMs, doc });
    return doc;
  }

  // Une relance (« continue », « ok », « vas-y ») ne dit pas ce qui est demandé : la vraie demande est avant.
  const RELAUNCH = /^\s*(?:continu[eé]?|ok(?:ay)?|oui|vas[- ]y|go|reprends?|on reprend|c'est bon|parfait|merci)\b[\s.!,]*$/i;
  function currentOf(s) {
    const last = s.chapters[s.chapters.length - 1];
    if (!last) return null;
    let i = s.chapters.length - 1;
    const relaunchLike = (p) => { const t = String(p || '').trim(); return RELAUNCH.test(t) || t.length < 12; };
    while (i > 0 && relaunchLike(s.chapters[i].prompt)) i--;
    const ch = s.chapters[i];
    const relaunch = ch !== last ? { prompt: last.prompt, ts: last.start } : null;
    let deploys = 0, pushes = 0, testsOk = 0, testsFailed = 0;
    for (const e of s.activity) {
      if (!(e.ts >= ch.start)) continue;
      if (e.milestone === 'deploy') deploys++;
      if (e.kind === 'push') pushes++;
    }
    for (const t of s.tests) {
      if (!(t.ts >= ch.start) || t.pending) continue;
      if (t.ok === true) testsOk++; else if (t.ok === false && !t.red) testsFailed++;
    }
    return { prompt: ch.prompt, start: ch.start, ...chapterStats(s, ch, null), deploys, pushes, testsOk, testsFailed, relaunch };
  }

  // Contenu de GET /api/v2/conversation/:id, sans ce que le serveur ajoute (compte, auto-accept, connecteurs,
  // part de la semaine, needsYou, accepted, mcp[].enabled).
  function detail(id, sinceIso) {
    const s = ix.sessions.get(id);
    if (!s) return null;
    const live = ix.live.get(s.id);
    const agentName = (aid) => (aid ? s.agentLabel(aid) : null);
    const cwd = live?.cwd || s.cwd;
    const sum = summaryOf(s, sinceIso || new Date(Date.now() - WEEK).toISOString());

    const running = [], done = [];
    for (const a of s.agents.values()) { const v = agentView(s, a); (v.status === 'running' ? running : done).push(v); }
    running.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    done.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));

    const today = s.byDay.get(new Date().toLocaleDateString('sv-SE'));
    const list = taskListOf(s);
    const out = {
      summary: { ...sum, branch: s.gitBranch || null,
        startedAt: live?.startedAt ? new Date(live.startedAt).toISOString() : s.firstTs },
      now: { text: s.lastText?.text || null, ts: s.lastText?.ts || null,
        // dernier message de Claude en plein tour, s'il est plus récent que son dernier compte rendu
        live: s.liveText && (!s.lastText || s.liveText.ts > s.lastText.ts) ? { text: s.liveText.text, ts: s.liveText.ts } : null,
        tasks: list?.items || [], tasksTs: list?.ts || null,
        plan: ix.planOf(s) },
      chapters: chaptersOf(s),
      current: currentOf(s),
      trackingDoc: trackingDocOf(s, cwd),
      activity: [...s.activity].sort(byTsDesc).slice(0, MAX_ACTIVITY)
        .map((e) => ({ ts: e.ts, kind: e.kind, title: e.title, detail: e.detail, agent: agentName(e.agent), ok: e.ok ?? null })),
      agents: { running, done: done.slice(0, MAX_DONE_AGENTS) },
      workflows: [...s.workflows.values()].map((w) => {
        const st = ix.workflowStatus(s, w);
        const start = w.launchTs || w.startTs;
        const agents = [...s.agents.values()].filter((a) => a.runId === w.runId).length;
        return { id: w.runId, name: w.name || w.runId, summary: w.summary, status: RUN_STATUS[st] || st, startedAt: start,
          durationMs: w.durationMs ?? (start ? (w.endTs ? ms(w.endTs) : Date.now()) - ms(start) : null),
          agents: w.agentCount ?? agents, tokens: w.totalTokens ?? null, phases: w.phases };
      }).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''))),
      artifacts: [...s.artifacts.values()].map((a) => ({ title: a.title || a.path && path.basename(a.path) || 'Artefact', url: a.url,
        description: a.description || null, ts: a.lastTs, publishes: a.publishes })).sort(byTsDesc),
      files: [...s.files.values()].sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs))).slice(0, MAX_FILES)
        .map((f) => ({ path: f.path, name: path.basename(f.path), ext: f.ext, kind: f.kind, created: f.created, writes: f.ops,
          ts: f.lastTs, by: agentName(f.lastBy), location: fileLocation(f.path, cwd) })),
      tests: [...s.tests].sort(byTsDesc).slice(0, MAX_TESTS).map((t) => ({ ts: t.ts, kind: t.kind, ok: t.ok, pending: !!t.pending,
        expectedFail: t.ok === false && !!t.red,
        passed: t.passed, failed: t.failed, title: t.description || short(t.command, 80), command: short(t.command, 300), line: t.line || null,
        by: agentName(t.agentId) })),
      // Le serveur précise la portée (project | user | local | plugin) et ajoute enabled.
      mcp: [...s.mcpUses].map(([name, m]) => ({ name, scope: name.startsWith('claude_ai_') ? 'connector' : 'unknown', uses: m.count, lastTs: m.lastTs }))
        .sort((a, b) => b.uses - a.uses),
      tokens: { today: today || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, total: s.total },
      limits: [...s.limits].sort(byTsDesc).map((l) => ({ ts: l.ts, text: l.text })),
    };
    out.milestones = milestonesOf(s, done, out.workflows);
    return out;
  }

  // Une demande terminée : la conversation est passée au repos (ou une nouvelle demande a suivi) avec un compte rendu.
  function missionsOf(s) {
    const out = [];
    const st = statusOf(s);
    const c = s.chapters;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (!ch.outcome) continue;
      const next = c[i + 1];
      const last = Math.max(ms(ch.end), ms(ch.outcome.ts));
      const away = next ? ms(next.start) - last >= MISSION_AWAY_MS : st !== 'working';
      const big = ch.actions >= MISSION_MIN_ACTIONS || ms(ch.end) - ms(ch.start) >= MISSION_MIN_MS;
      if (away && big) out.push({ ch, ts: ch.outcome.ts });
    }
    return out;
  }

  // Rapports depuis sinceIso : artefacts publiés, workflows terminés, fins de mission. Plus récent d'abord.
  function reports(sinceIso) {
    const since = sinceIso || '';
    const out = [];
    for (const s of ix.sessions.values()) {
      if (throwaway(s)) continue;
      const base = { conversationId: s.id, conversationTitle: titleOf(s) };
      for (const a of s.artifacts.values()) {
        if ((a.lastTs || '') < since) continue;
        out.push({ kind: 'artifact', ...base, title: a.title || (a.path && path.basename(a.path)) || 'Artefact',
          detail: a.description ? short(a.description, 200) : null, url: a.url, ts: a.lastTs });
      }
      for (const w of s.workflows.values()) {
        const st = ix.workflowStatus(s, w);
        if (st === 'running' || st === 'idle') continue;
        const end = w.endTs || null;
        if (!end || end < since) continue;
        const prefix = st === 'completed' ? '' : st === 'failed' ? 'Échec · ' : 'Arrêté · ';
        out.push({ kind: 'workflowDone', ...base, title: w.name || w.runId,
          detail: (prefix + short(w.summary || '', 200)) || null, url: null, ts: end });
      }
      for (const { ch, ts } of missionsOf(s)) {
        if (ts < since) continue;
        out.push({ kind: 'missionDone', ...base, title: short(ch.prompt, 90), detail: short(ch.outcome.text, 240), url: null, ts });
      }
    }
    return out.sort(byTsDesc);
  }

  // Compteurs « depuis une heure » qui viennent des transcripts.
  function sinceCounts(sinceIso) {
    const since = sinceIso || '';
    let testsFailed = 0, limits = 0;
    for (const s of ix.sessions.values()) {
      if (throwaway(s)) continue;
      for (const t of s.tests) if (t.ok === false && !t.red && t.ts >= since) testsFailed++;
      for (const l of s.limits) if (l.ts >= since) limits++;
    }
    return { testsFailed, limits, reports: reports(since).length };
  }

  return {
    summaries,
    detail,
    reports,
    sinceCounts,
    // Pour le serveur (« À regarder », limites atteintes) : conversation jetable à laisser hors de la vue d'ensemble.
    isThrowaway: (id) => { const s = ix.sessions.get(id); return s ? throwaway(s) : false; },
    // Dénominateur de la part de la semaine : poids de toutes les conversations par organisation depuis sinceIso.
    usageTotals: (sinceIso) => ix.usageTotals(sinceIso),
    usageWeight: (id, sinceIso, org) => ix.usageWeight(id, sinceIso, org),
  };
}
