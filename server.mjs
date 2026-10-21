#!/usr/bin/env node
// Vigie — moteur local (http://127.0.0.1:4777), lancé au démarrage par launchd (io.github.paulmailhes.vigie.engine).
// API JSON v2 pour l'app Mac (docs/api-v2.md). L'API v1 reste servie tant que l'ancienne app tourne.
// Aucune dépendance. Le hook ne dépend pas de ce serveur : s'il s'arrête, l'auto-accept continue.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Indexer, actionKind, maskSecrets } from './lib/indexer.mjs';
import { createConversations } from './lib/conversations.mjs';
import { createAccounts, MAIN_ID } from './lib/accounts.mjs';
import { createMcp, usageFromSessions, toolKey, connectorName, service as mcpService, launchCwd, openInTerminal, shq } from './lib/mcp.mjs';
import { createQuestions, reviewEntry } from './lib/questions.mjs';
import { pendingGuards, recentBlocked, decide, MAX_COMMAND } from './lib/decisions.mjs';
import { ROOT, DATA, HISTORY_FILE, readState, writeState, effective, questionsAuto, questionsMode, DEFAULT_GUARDS, QUESTION_MODES, GUARD_MODES } from './lib/state.mjs';
import { awaitingApprovals, approve } from './lib/approvals.mjs';
import { rateOf, runawayAlert, RATE_MINUTES, SERIES_WINDOWS, SERIES_POINTS, seriesFrom, seriesPoints } from './lib/usage.mjs';

const PORT = Number(process.env.VIGIE_PORT || 4777); // 0 : port libre (tests)
const HOST = '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const UI_FILE = path.join(DATA, 'ui.json');
const HISTORY_MAX = 30_000;
const HISTORY_ROTATE_BYTES = 50 * 1024 * 1024;
const HOUR = 3600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const MAX_ACCEPTED = 300, MAX_REVIEW = 100, MAX_REPORTS = 60, MAX_BODY = 1_000_000, MAX_RECENT_ACCEPTED = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Programmes du Mac que Vigie lance pour l'utilisateur (remplacés par de faux programmes dans les tests).
const OPEN_BIN = process.env.VIGIE_OPEN_BIN || '/usr/bin/open';
const OSASCRIPT = process.env.VIGIE_OSASCRIPT || '/usr/bin/osascript';
const PBCOPY = process.env.VIGIE_PBCOPY || '/usr/bin/pbcopy';
// État réel des MCP (`claude mcp list`) : premier relevé 20 s après le démarrage, puis toutes les 10 min.
const MCP_CHECK = process.env.VIGIE_MCP_CHECK !== '0';
const MCP_CHECK_EVERY_MS = 10 * 60_000, MCP_CHECK_FIRST_MS = 20_000;

process.on('unhandledRejection', (e) => console.error('[vigie] promesse rejetée :', clean(e)));

const indexer = new Indexer({ windowHours: Number(process.env.VIGIE_WINDOW_HOURS || 48), usageDays: 7 });
const conv = createConversations(indexer);
const accounts = createAccounts();
const HOME = accounts.paths.home;
const QUOTA_FILE = process.env.VIGIE_QUOTA_FILE || null;
const mcp = createMcp({
  home: HOME,
  codeRoot: process.env.VIGIE_CODE_ROOT || path.join(HOME, 'Code'),
  accounts: () => accounts.load().accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir, claudeJsonPath: claudeJsonPath(a) })),
  usage: () => mcpUsage(),
  checkPaths: () => mcpCheckPaths(),
  openTerminal: (command) => openInTerminal(command, { osascript: OSASCRIPT }),
});
const questions = createQuestions({ dataDir: DATA, sessionsDir: indexer.sessionsDir, projectsDir: indexer.projectsDir });

// ---------- petits outils ----------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const byTsDesc = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''));
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// Masquage de tout ce qui sort du serveur : règles de l'indexeur, plus un jeton « Bearer » nu
// (`curl -H "Bearer abc…"` sans « Authorization: »), que l'indexeur ne masque pas encore.
const mask = (text) => maskSecrets(text).replace(/\b(Bearer)\s+(?!••••)[A-Za-z0-9._~+/-]{6,}=*/gi, '$1 ••••');
// Les messages d'erreur peuvent citer une commande : on masque avant de journaliser.
function clean(e) { return mask(String(e?.stack || e)).slice(0, 2000); }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(v, null, 2));
  fs.renameSync(t, p);
}
const ui = () => {
  const u = readJson(UI_FILE, null);
  const ok = isObj(u) && typeof u.lastSeen === 'string' && !Number.isNaN(Date.parse(u.lastSeen));
  return ok ? u : { ...(isObj(u) ? u : {}), lastSeen: new Date(Date.now() - 12 * HOUR).toISOString() };
};
// Éléments de « À regarder » écartés par l'utilisateur : { id: date }. Un élément reste caché tant qu'il ne change
// pas (son ts n'est pas plus récent que la date où il a été écarté) ; gardés 14 jours, 500 au plus.
const DISMISS_KEEP_MS = 14 * DAY, DISMISS_MAX = 500;
function dismissedOf(u) {
  const d = isObj(u?.dismissed) ? u.dismissed : {};
  const out = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v;
  return out;
}

// ---------- historique des décisions du hook ----------
const history = [];
let historyOffset = 0;
let historyCarry = '';
function rotateHistory() {
  try {
    if (fs.statSync(HISTORY_FILE).size < HISTORY_ROTATE_BYTES) return;
    fs.renameSync(HISTORY_FILE, HISTORY_FILE.replace(/\.jsonl$/, `-${new Date().toISOString().slice(0, 10)}.jsonl`));
    historyOffset = 0; historyCarry = '';
  } catch { /* pas encore d'historique */ }
}
function readHistory() {
  let st; try { st = fs.statSync(HISTORY_FILE); } catch { return; }
  if (st.size < historyOffset) { historyOffset = 0; historyCarry = ''; }
  if (st.size === historyOffset) return;
  const fd = fs.openSync(HISTORY_FILE, 'r');
  const buf = Buffer.alloc(st.size - historyOffset);
  fs.readSync(fd, buf, 0, buf.length, historyOffset);
  fs.closeSync(fd);
  historyOffset = st.size;
  const lines = (historyCarry + buf.toString('utf8')).split('\n');
  historyCarry = lines.pop();
  for (const l of lines) { try { const h = JSON.parse(l); if (isObj(h)) history.push(h); } catch { /* ligne abîmée */ } }
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}
// Nombre d'événements par type depuis `since` (l'historique est dans l'ordre d'écriture).
function eventCounts(since) {
  const ev = {};
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (String(h.ts || '') < since) break;
    ev[h.event] = (ev[h.event] || 0) + 1;
  }
  return ev;
}

// Attentes du hook encore ouvertes (une fenêtre est affichée dans VS Code et le hook décidera seul).
// Quand l'utilisateur répond lui-même, Claude Code tue le hook, qui n'écrit parfois rien (« attente fantôme ») :
// on écarte donc aussi les attentes dont le délai est passé, dont le processus est mort, ou dont la
// conversation est fermée.
const WAIT_EVENTS = new Set(['garde-fou-attente', 'question-attente']);
// « garde-fou-refuse-app » / « garde-fou-autorise-app » : L'utilisateur a décidé depuis l'app.
const CLOSES_WAIT = /bloque|auto|repondu|rendu|-app$/;
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return true; // ancien format sans pid : seul le délai compte
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // signal 0 : simple test de vie
}
// Attentes en cours, par conversation ouverte :
// - questions : d'après l'historique (délai + 2 min, processus du hook vivant) ;
// - garde-fous : lib/decisions.mjs (pid vivant ET bien un hook.mjs, échéance d'après guard.waitMin actuel),
//   et pas fermées par une ligne de fin (ancien format sans pid sur la ligne de fin).
function pendingWaits(state, now = Date.now()) {
  const open = new Map();
  for (const h of history) {
    if (!h.sessionId) continue;
    const k = `${h.sessionId}\u0000${h.action}`;
    if (WAIT_EVENTS.has(h.event)) open.set(k, h);
    else if (CLOSES_WAIT.test(String(h.event || ''))) open.delete(k);
  }
  const bySession = new Map();
  const add = (sid, w) => bySession.set(sid, [...(bySession.get(sid) || []), w]);
  const openGuards = new Set();
  for (const h of open.values()) {
    if (h.event === 'garde-fou-attente') { openGuards.add(`${h.sessionId}\u0000${h.ts}`); continue; }
    if (!indexer.live.has(h.sessionId)) continue;
    const m = h.minutes === null || h.minutes === undefined || h.minutes === '' ? NaN : Number(h.minutes);
    const minutes = Number.isFinite(m) ? m : state.questionWaitMin;
    const deadline = Date.parse(h.ts) + minutes * 60_000;
    if (!(deadline + 2 * 60_000 > now) || !pidAlive(h.pid)) continue;
    add(h.sessionId, { ...h, question: true, deadline });
  }
  let guards = [];
  try { guards = pendingGuards({ history, state, now }); } catch (e) { console.error('[vigie] attentes des garde-fous :', clean(e)); }
  for (const g of guards) {
    if (!g.sessionId || !indexer.live.has(g.sessionId) || !openGuards.has(`${g.sessionId}\u0000${g.ts}`)) continue;
    add(g.sessionId, { ...g, action: g.command, question: false, deadline: Date.parse(g.expiresAt) });
  }
  return bySession;
}

// ---------- comptes : organisation, part de la semaine ----------
// Même règle que lib/accounts.mjs (et Claude Code) : un ancien .config.json non vide passe devant.
function claudeJsonPath(acc) {
  const legacy = path.join(acc.configDir || path.join(HOME, '.claude'), '.config.json');
  try { if (fs.statSync(legacy).size > 0) return legacy; } catch { /* absent */ }
  return path.join(acc.configDir || HOME, '.claude.json');
}
// L'usage des transcripts est rangé par organisation (pièces jointes credential_org) ; celle d'un compte
// est dans son .claude.json. Le fichier pèse plusieurs centaines de Ko : relu seulement s'il change.
const orgCache = new Map();
function orgOf(acc) {
  const p = claudeJsonPath(acc);
  let st; try { st = fs.statSync(p); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const c = orgCache.get(p);
  if (c?.key === key) return c.org;
  const j = readJson(p, null);
  const org = typeof j?.oauthAccount?.organizationUuid === 'string' ? j.oauthAccount.organizationUuid : null;
  orgCache.set(p, { key, org });
  return org;
}
function accountByOrg(model) {
  const m = new Map();
  for (const a of model.accounts) { const o = orgOf(a); if (o && !m.has(o)) m.set(o, a.id); }
  return m;
}

// Usage des MCP sur 7 jours ; un connecteur claude.ai est rattaché au compte des conversations qui l'ont utilisé.
function mcpUsage() {
  const sessions = indexer.allSessions();
  const use = usageFromSessions(sessions);
  const byOrg = accountByOrg(accounts.load());
  for (const [srv, u] of use) {
    if (!srv.startsWith('claude_ai_')) continue;
    const ids = new Set();
    for (const s of sessions) if (s.mcpUses.has(srv) && byOrg.has(s.org)) ids.add(byOrg.get(s.org));
    if (ids.size === 1) u.accountId = [...ids][0];
  }
  return use;
}

// Part de la semaine du compte prise par une conversation : son poids d'usage depuis le début de la
// fenêtre hebdomadaire du compte, divisé par celui de toutes les conversations de ce compte, multiplié
// par le pourcentage hebdomadaire du compte. null si l'un des trois manque.
function weekInfo(ctx, accountId) {
  if (ctx.week.has(accountId)) return ctx.week.get(accountId);
  let info = null;
  const sum = ctx.accSums.find((a) => a.id === accountId);
  const acc = ctx.model.accounts.find((a) => a.id === accountId);
  const w = sum?.usage?.week;
  const reset = Date.parse(w?.resetsAt || '');
  const org = acc ? orgOf(acc) : null;
  if (org && typeof w?.pct === 'number' && Number.isFinite(w.pct) && Number.isFinite(reset)) {
    const start = new Date(reset - WEEK).toISOString();
    const den = conv.usageTotals(start).byOrg[org] || 0;
    if (den > 0) info = { org, start, pct: w.pct, den };
  }
  ctx.week.set(accountId, info);
  return info;
}
function weekPct(ctx, id, accountId) {
  const w = weekInfo(ctx, accountId);
  if (!w) return null;
  return Math.round((conv.usageWeight(id, w.start, w.org) / w.den) * w.pct * 10) / 10;
}

// Consommation en direct (rate) et alerte « s'emballe » d'une conversation (lib/usage.mjs) : poids minute par
// minute des 2 dernières heures, agents et workflows compris, converti en % de la semaine du compte comme weekPct.
function usageLive(ctx, sum, accountId) {
  const w = weekInfo(ctx, accountId);
  const from = (Math.floor(ctx.now / 60_000) - RATE_MINUTES + 1) * 60_000;
  const buckets = indexer.usageBuckets(sum.id, from, 1, RATE_MINUTES, w ? w.org : undefined);
  const rate = rateOf(buckets, w);
  let alert = null;
  const s = indexer.sessions.get(sum.id);
  if (sum.running && s) {
    try {
      alert = runawayAlert({ now: ctx.now, buckets, week: w, tests: s.tests, activity: s.activity, agentLabel: (a) => s.agentLabel(a), mask });
    } catch (e) { console.error('[vigie] alerte :', clean(e)); }
  }
  return { rate, alert };
}

// GET /api/v2/usage/series?window=60|600|1200 : toutes les conversations des 20 dernières heures (ouvertes et
// fermées, sauf les jetables fermées), agents et workflows compris, et chaque compte ; 60 points par série.
function usageSeries(url) {
  const raw = url.searchParams.get('window') ?? '60';
  const win = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  const stepMin = SERIES_WINDOWS[win];
  if (!stepMin) return bad('Fenêtre : 60, 600 ou 1200 min.');
  const now = Date.now();
  const ctx = { now, model: accounts.load(), accSums: accounts.summaries(), week: new Map() };
  const from = seriesFrom(now, stepMin);
  const cutoff = new Date(now - 20 * HOUR).toISOString();
  const sums = new Map(conv.summaries().map((x) => [x.id, x]));
  const conversations = [];
  for (const s of indexer.sessions.values()) {
    const running = indexer.live.has(s.id);
    if (!running && !(String(s.lastTs || '') >= cutoff)) continue;
    if (!running && conv.isThrowaway(s.id)) continue;
    const accountId = ctx.model.sessions[s.id] || MAIN_ID;
    const w = weekInfo(ctx, accountId);
    const b = indexer.usageBuckets(s, from, stepMin, SERIES_POINTS, w ? w.org : undefined);
    const sum = sums.get(s.id);
    conversations.push({ id: s.id, title: sum?.title ?? s.title ?? null, project: sum?.project ?? (s.cwd ? path.basename(s.cwd) : null),
      accountId, running, lastActivity: sum?.lastActivity ?? s.lastTs ?? null, points: seriesPoints(from, stepMin, b.w, b.tok, w) });
  }
  conversations.sort((a, b) => (b.running - a.running) || String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  const byOrg = indexer.usageBucketsByOrg(from, stepMin, SERIES_POINTS);
  const empty = new Array(SERIES_POINTS).fill(0);
  const accountsOut = [];
  for (const a of ctx.model.accounts) {
    const org = orgOf(a);
    if (!org) continue;
    const b = byOrg.get(org) || { w: empty, tok: empty };
    accountsOut.push({ id: a.id, label: a.label, points: seriesPoints(from, stepMin, b.w, b.tok, weekInfo(ctx, a.id)) });
  }
  return [200, { from: new Date(from).toISOString(), to: new Date(now).toISOString(), stepMin, unit: 'weekPct', conversations, accounts: accountsOut }];
}

// Conversations ouvertes, avec ce qui tourne encore en fond : une bascule de compte n'arrête jamais
// une conversation dont des agents, des workflows ou des commandes de fond travaillent.
function liveEnriched() {
  const out = new Map();
  for (const [sid, v] of indexer.live) {
    const s = indexer.sessions.get(sid);
    let agentsRunning = 0, workflowsRunning = 0, bgRunning = 0;
    if (s) {
      for (const a of s.agents.values()) if (indexer.agentStatus(s, a) === 'running') agentsRunning++;
      for (const w of s.workflows.values()) if (indexer.workflowStatus(s, w) === 'running') workflowsRunning++;
      for (const b of s.bgTasks.values()) if (indexer.bgStatus(b) === 'running') bgRunning++;
    } else agentsRunning = 1; // pas encore lue : prudence, on la croit occupée
    out.set(sid, { ...v, agentsRunning, workflowsRunning, bgRunning });
  }
  return out;
}

// Dossier de LANCEMENT d'une conversation (celui de ses MCP et de sa fenêtre VS Code) : le registre de
// Claude Code pour une conversation ouverte, sinon le dossier du transcript, sinon le dernier dossier vu.
function launchDirOf(id) {
  const live = indexer.live.get(id);
  if (typeof live?.cwd === 'string' && live.cwd) return live.cwd;
  const s = indexer.sessions.get(id) || indexer.light.get(id);
  if (!s) return null;
  return launchCwd(s) || s.cwd || null;
}

// Dossiers où relever l'état réel des MCP : conversations ouvertes, puis fermées depuis moins de 48 h,
// les plus récentes d'abord (lib/mcp.mjs n'en garde que ceux qui ont des MCP propres, 12 au plus).
function mcpCheckPaths() {
  const out = [];
  const add = (p) => { if (typeof p === 'string' && path.isAbsolute(p) && !out.includes(p)) out.push(p); };
  const live = [...indexer.live.values()].sort((a, b) => Number(b.updatedAt || b.startedAt || 0) - Number(a.updatedAt || a.startedAt || 0));
  for (const v of live) add(launchDirOf(v.sessionId));
  const cutoff = new Date(Date.now() - 48 * HOUR).toISOString();
  const closed = [...indexer.sessions.values()].filter((s) => !indexer.live.has(s.id) && String(s.lastTs || '') >= cutoff && !conv.isThrowaway(s.id))
    .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  for (const s of closed) add(launchDirOf(s.id));
  return out;
}

// ---------- vues v2 ----------
function context() {
  const state = readState();
  const now = Date.now();
  const u = ui();
  return { state, now, lastSeen: u.lastSeen, dismissed: dismissedOf(u), wrapperActive: accounts.wrapperActive(),
    model: accounts.load(), accSums: accounts.summaries(), waits: pendingWaits(state, now), week: new Map() };
}

// Connecteurs de compte effectifs : sans le lanceur, rien ne les coupe (ENABLE_CLAUDEAI_MCP_SERVERS n'est
// posé que par lui) : ils sont chargés dans toutes les conversations, quel que soit le réglage.
const connectorsOf = (eff, wrapperActive) => (wrapperActive ? eff.connectors : 'on');

function settingsView(state) {
  return {
    autoAccept: state.autoAccept,
    questionsAuto: questionsAuto(state),
    questionWaitMin: Math.round(state.questionWaitMin),
    connectorsDefault: state.connectorsDefault,
    guard: {
      enabled: state.guard.enabled,
      mode: state.guard.mode,
      waitMin: Math.round(state.guard.waitMin),
      rules: state.guard.rules.map((r) => ({ id: String(r.id || r.label), label: r.label, disabled: !!r.disabled })),
    },
  };
}

// Une question telle que le hook l'écrit : « question [opt / opt] » (une ligne par question). Les anciennes
// lignes gardaient l'entrée brute de l'outil en JSON, coupée à 600 caractères : on en tire la même forme.
function questionAction(action) {
  const a = String(action ?? '');
  if (!a.trimStart().startsWith('{')) return a;
  const line = (q, labels) => `${String(q ?? '').trim()}${labels.length ? ` [${labels.join(' / ')}]` : ''}`;
  try {
    const qs = JSON.parse(a)?.questions;
    if (Array.isArray(qs) && qs.length) {
      return qs.map((q) => line(q?.question, (Array.isArray(q?.options) ? q.options : []).map((o) => o?.label).filter((l) => typeof l === 'string' && l))).join('\n');
    }
  } catch { /* JSON coupé : on lit ce qui est lisible */ }
  const strings = (text, key) => [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g'))]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } });
  const first = strings(a, 'question')[0];
  if (!first) return a;
  const at = a.indexOf('"question"');
  const next = a.indexOf('"question"', at + 10);
  return line(first, strings(next > 0 ? a.slice(at, next) : a.slice(at), 'label'));
}
const questionText = (action) => firstLine(questionAction(action)).replace(/\s*\[[^\]]*\]?$/, '');
const what = (h) => (h.description ? short(h.description, 100) : short(mask(firstLine(h.action ?? h.command)), 100)) || 'Action';
const minutesLeft = (deadline, now) => Math.ceil((deadline - now) / 60_000);
const agentName = (sid, agentId) => (agentId ? (indexer.sessions.get(sid)?.agentLabel(agentId) || null) : null);

// Remise à zéro d'une limite atteinte, lue dans le texte de Claude Code (heure locale du Mac) :
// « resets 11:40pm », « resets Oct 26, 7pm », « resets Oct 22 at 9am », « will reset at 3pm (Europe/Paris) ».
// Sans heure lisible : 5 h pour une limite de session, sinon 7 jours. Renvoie une date en ms, ou null.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_RE = /\breset(?:s)?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\b\.?)?/i;
function limitResetAt(text, ts) {
  const t0 = Date.parse(ts || '');
  if (!Number.isFinite(t0)) return null;
  const m = RESET_RE.exec(String(text || ''));
  if (m && (m[4] || m[5])) {
    let h = Number(m[3]);
    const min = Number(m[4] || 0);
    if (m[5]) h = (h % 12) + (m[5].toLowerCase() === 'p' ? 12 : 0);
    if (h <= 23 && min <= 59) {
      const d = new Date(t0);
      if (m[1] && m[2]) {
        const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
        if (mon >= 0) {
          const r = new Date(d.getFullYear(), mon, Number(m[2]), h, min);
          if (r.getTime() < t0 - DAY) r.setFullYear(r.getFullYear() + 1);
          return r.getTime();
        }
      } else {
        const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min);
        if (r.getTime() <= t0) r.setDate(r.getDate() + 1);
        return r.getTime();
      }
    }
  }
  return t0 + (/session|5-hour|5h\b/i.test(String(text || '')) ? 5 * HOUR : WEEK);
}

// Pourquoi un garde-fou a refusé (lib/decisions.mjs : by).
const BLOCKED_WHY = { delai: 'Refusée faute de réponse', jamais: 'Refusée d\'office', 'sous-agent': 'Refusée (demandée par un agent)' };

// « À regarder » : ce qui attend l'utilisateur maintenant d'abord, puis ce qui s'est passé depuis son dernier passage.
// Chaque garde-fou porte de quoi décider ou refaire l'action : state, pendingId, expiresAt, rule, command
// (masquée, 4000 caractères au plus), byAgent, cwd, needsPassword.
function reviewItems(ctx, sums) {
  const titles = new Map(sums.map((s) => [s.id, s.title]));
  const title = (sid) => titles.get(sid) ?? null;
  const live = [], past = [];
  for (const [sid, list] of ctx.waits) {
    for (const w of list) {
      const left = minutesLeft(w.deadline, ctx.now);
      const when = left > 0 ? `dans ${left} min` : 'dans un instant';
      if (w.question) {
        live.push({ id: `w:${sid}:${w.ts}`, kind: 'waiting', conversationId: sid, conversationTitle: title(sid),
          title: short(w.tool === 'ExitPlanMode' ? 'Plan à valider' : questionText(w.action) || 'Question de Claude', 120),
          detail: `Réponds dans VS Code, sinon Claude choisit l'option recommandée ${when}.`, ts: w.ts });
      } else {
        live.push({ id: `g:${sid}:${w.ts}`, kind: 'blocked', state: 'waiting', pendingId: w.pendingId, expiresAt: w.expiresAt,
          conversationId: sid, conversationTitle: title(sid), cwd: w.cwd ?? null,
          rule: w.rule || 'Action sensible', ruleId: w.ruleId ?? null, command: mask(w.command).slice(0, MAX_COMMAND),
          byAgent: agentName(sid, w.agentId), needsPassword: !!w.needsPassword,
          title: short(w.rule || 'Action sensible', 120), detail: `${what(w)} · décide ici ou dans VS Code, sinon refusée ${when}.`, ts: w.ts });
      }
    }
  }
  for (const s of sums) {
    if (s.status !== 'waiting' || ctx.waits.has(s.id)) continue;
    live.push({ id: `c:${s.id}`, kind: 'waiting', conversationId: s.id, conversationTitle: s.title,
      title: 'Attend ta réponse dans VS Code', detail: s.headline || null, ts: s.lastActivity || new Date(ctx.now).toISOString() });
  }
  // Mode « seulement par Vigie » : refusées sur le moment, à autoriser ici (une fois, pour l'appel exact).
  let awaiting = [];
  try { awaiting = awaitingApprovals({ history, now: ctx.now }); } catch (e) { console.error('[vigie] autorisations :', clean(e)); }
  for (const a of awaiting) {
    if (a.sessionId && conv.isThrowaway(a.sessionId) && !indexer.live.has(a.sessionId)) continue;
    live.push({ id: `v:${a.approvalId}`, kind: 'blocked', state: 'awaiting', approvalId: a.approvalId,
      approved: a.approved, approvedUntil: a.approvedUntil,
      conversationId: a.sessionId, conversationTitle: title(a.sessionId), cwd: a.cwd,
      rule: a.rule || 'Action sensible', ruleId: a.ruleId, command: mask(a.command).slice(0, MAX_COMMAND),
      byAgent: agentName(a.sessionId, a.agentId), needsPassword: a.needsPassword,
      title: short(a.rule || 'Action sensible', 120),
      detail: a.approved ? `${what(a)} · autorisée : Claude peut la relancer à l'identique.` : `${what(a)} · refusée sur le moment : autorise-la ici pour cette commande exacte.`,
      ts: a.ts });
  }
  for (const n of switchNotices) {
    live.push({ id: `s:${n.sessionId}:${n.ts}`, kind: 'waiting', conversationId: n.sessionId, conversationTitle: title(n.sessionId),
      title: 'Compte changé', detail: n.message, ts: n.ts });
  }
  for (const r of questions.toReview()) if (!conv.isThrowaway(r.sessionId)) past.push(reviewEntry(r, title(r.sessionId)));
  // Refusées depuis le dernier passage, à faire soi-même (un refus de l'utilisateur depuis l'app n'en est pas une).
  for (const b of recentBlocked({ history, since: ctx.lastSeen, limit: MAX_REVIEW })) {
    if (b.by === 'you' || (b.sessionId && conv.isThrowaway(b.sessionId))) continue;
    past.push({ id: `b:${b.sessionId}:${b.ts}`, kind: 'blocked', state: 'blocked', reason: b.by,
      conversationId: b.sessionId ?? null, conversationTitle: title(b.sessionId), cwd: b.cwd ?? null,
      rule: b.rule || 'Action sensible', ruleId: b.ruleId ?? null, command: mask(b.command).slice(0, MAX_COMMAND),
      byAgent: agentName(b.sessionId, b.agentId), needsPassword: !!b.needsPassword,
      title: short(b.rule || 'Action sensible', 120), detail: `${BLOCKED_WHY[b.by] || 'Refusée'} : ${what(b)}. À faire toi-même.`, ts: b.ts });
  }
  // Limite atteinte depuis le dernier passage, tant qu'elle n'est pas remise à zéro.
  for (const s of indexer.sessions.values()) {
    if (conv.isThrowaway(s.id)) continue;
    const l = s.limits.reduce((m, x) => (x.ts >= ctx.lastSeen && (!m || x.ts > m.ts) ? x : m), null);
    if (!l || !(limitResetAt(l.text, l.ts) > ctx.now)) continue;
    past.push({ id: `l:${s.id}:${l.ts}`, kind: 'limit', conversationId: s.id, conversationTitle: title(s.id), title: 'Limite atteinte', detail: short(l.text, 200), ts: l.ts });
  }
  const shown = (it) => { const at = ctx.dismissed[it.id]; return !at || String(it.ts || '') > at; };
  return [...live.filter(shown).sort(byTsDesc), ...past.filter(shown).sort(byTsDesc)].slice(0, MAX_REVIEW);
}

function countBy(items) {
  const m = new Map();
  for (const it of items) if (it.conversationId) m.set(it.conversationId, (m.get(it.conversationId) || 0) + 1);
  return m;
}

// Acceptations de Vigie par conversation (auto-accepte, question-auto) : depuis minuit (heure locale) et
// depuis le dernier passage de l'utilisateur. Un seul passage sur l'historique, mis en cache tant qu'il ne change pas.
const ACCEPT_EVENTS = new Set(['auto-accepte', 'question-auto']);
let acceptCache = { key: '', map: new Map() };
function acceptedCounts(ctx) {
  const midnight = new Date(ctx.now); midnight.setHours(0, 0, 0, 0);
  const today = midnight.toISOString();
  const last = history[history.length - 1];
  const key = `${history.length}|${history[0]?.ts}|${last?.ts}|${today}|${ctx.lastSeen}`;
  if (acceptCache.key === key) return acceptCache.map;
  const from = today < ctx.lastSeen ? today : ctx.lastSeen;
  const map = new Map();
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const ts = String(h.ts || '');
    if (ts < from) break;
    if (!ACCEPT_EVENTS.has(h.event) || !h.sessionId) continue;
    const c = map.get(h.sessionId) || { today: 0, sinceSeen: 0 };
    if (ts >= today) c.today++;
    if (ts >= ctx.lastSeen) c.sinceSeen++;
    map.set(h.sessionId, c);
  }
  acceptCache = { key, map };
  return map;
}

// Échecs de la carte (ceux que compte tests.failedRecent) : 2 dernières heures, pas l'étape rouge voulue,
// pas rattrapés par une réussite du même genre ; 5 au plus, plus récent d'abord.
function cardFailures(sid, now) {
  const s = indexer.sessions.get(sid);
  if (!s) return [];
  const okAt = new Map();
  for (const t of s.tests) if (t.ok === true && !t.pending && !(okAt.get(t.kind) >= t.ts)) okAt.set(t.kind, t.ts);
  const since = new Date(now - 2 * HOUR).toISOString();
  return s.tests.filter((t) => !t.pending && t.ok === false && !t.red && t.ts >= since && !(okAt.get(t.kind) > t.ts))
    .sort(byTsDesc).slice(0, 5)
    .map((t) => ({ title: short(mask(t.description || t.command), 80) || 'Tests', line: t.line ? short(mask(t.line), 200) : null,
      kind: t.kind, ts: t.ts, by: t.agentId ? s.agentLabel(t.agentId) : null }));
}

// ConversationSummary du contrat, à partir de la vue de lib/conversations.mjs.
function decorate(sum, ctx, needs, accepted) {
  const eff = effective(ctx.state, sum.id);
  const ov = Object.hasOwn(ctx.state.sessions, sum.id) ? ctx.state.sessions[sum.id] : null;
  const accountId = ctx.model.sessions[sum.id] || MAIN_ID; // sans choix noté, le lanceur la reprend sur Travail 1
  const waits = ctx.waits.get(sum.id) || [];
  let status = sum.status;
  if (sum.running && waits.some((w) => !w.question)) status = 'blocked';
  else if (sum.running && waits.length) status = 'waiting';
  // arrêtée pour changer de compte : elle attend un message de l'utilisateur dans VS Code pour repartir sur le nouveau compte
  const stopped = !sum.running ? accounts.stoppedFor(sum.id, ctx.model) : null;
  if (stopped) status = 'waiting';
  const tests = sum.tests ? { ...sum.tests } : null;
  if (tests?.failedRecent > 0) tests.failures = cardFailures(sum.id, ctx.now);
  const out = {
    id: sum.id,
    title: sum.title,
    project: sum.project,
    cwd: sum.cwd,
    status,
    running: sum.running,
    accountId,
    account: sum.running ? accounts.accountInfo(sum.id, ctx.live || (ctx.live = liveEnriched()), ctx.model) : null,
    autoAccept: eff.autoAccept,
    autoAcceptOverride: typeof ov?.autoAccept === 'boolean' ? ov.autoAccept : null,
    connectors: connectorsOf(eff, ctx.wrapperActive),
    agentsRunning: sum.agentsRunning,
    workflowsRunning: sum.workflowsRunning,
    weekPct: weekPct(ctx, sum.id, accountId),
    ...usageLive(ctx, sum, accountId),
    lastActivity: sum.lastActivity,
    needsYou: needs.get(sum.id) || 0,
    headline: sum.headline,
    contextTokens: sum.contextTokens ?? null,
    pendingAccountId: ctx.model.pendingSwitches[sum.id]?.to || null,
    // carte de la vue d'ensemble
    progress: sum.progress ?? null,
    tests,
    accepted: accepted.get(sum.id) || { today: 0, sinceSeen: 0 },
    artifacts: sum.artifacts ?? null,
  };
  if (typeof sum.waitingFor === 'string') out.waitingFor = sum.waitingFor;
  if (stopped) {
    const label = ctx.model.accounts.find((a) => a.id === stopped.to)?.label || stopped.to;
    out.resume = { to: stopped.to, at: stopped.at };
    out.waitingFor = `Écris-lui un message dans VS Code : elle reprendra sur ${label}.`;
  }
  if ('branch' in sum) out.branch = sum.branch;
  if ('startedAt' in sum) out.startedAt = sum.startedAt;
  return out;
}

function overviewV2() {
  const ctx = context();
  const sums = conv.summaries();
  const review = reviewItems(ctx, sums);
  const needs = countBy(review);
  const accepted = acceptedCounts(ctx);
  const counts = conv.sinceCounts(ctx.lastSeen);
  const ev = eventCounts(ctx.lastSeen);
  // Rapports : tout depuis le dernier passage, et au moins les dernières 24 h.
  const dayAgo = new Date(ctx.now - DAY).toISOString();
  return {
    now: new Date(ctx.now).toISOString(),
    settings: settingsView(ctx.state),
    since: ctx.lastSeen,
    sinceSummary: {
      accepted: ev['auto-accepte'] || 0,
      questionsAuto: ev['question-auto'] || 0,
      blocked: (ev['garde-fou-bloque'] || 0) + (ev['garde-fou-en-attente-vigie'] || 0),
      reports: counts.reports,
      testsFailed: counts.testsFailed,
      limits: counts.limits,
    },
    toReview: review,
    reports: conv.reports(ctx.lastSeen < dayAgo ? ctx.lastSeen : dayAgo).slice(0, MAX_REPORTS),
    accounts: ctx.accSums,
    conversations: sums.map((s) => decorate(s, ctx, needs, accepted)),
    recentAccepted: recentAccepted(ctx, sums),
    engine: { indexing: !indexer.progress.done, wrapperActive: ctx.wrapperActive, notices: healthNotices },
  };
}

// Décisions de Vigie (history.jsonl) -> accepted[] du contrat.
const DECISIONS = {
  'auto-accepte': 'auto', 'question-auto': 'auto',
  'garde-fou-bloque': 'blocked',
  'garde-fou-attente': 'waiting', 'question-attente': 'waiting',
  'garde-fou-tu-as-repondu': 'you', 'question-tu-as-repondu': 'you',
  'refus-classifieur-pour-toi': 'you', 'demande-pour-toi': 'you', 'question-pour-toi': 'you', 'garde-fou-pour-toi': 'you',
  'garde-fou-rendu': 'you', 'question-rendue': 'you', 'reponse-perdue': 'you',
  'garde-fou-autorise-app': 'you', 'garde-fou-refuse-app': 'denied',
  'garde-fou-en-attente-vigie': 'blocked', 'garde-fou-autorise-vigie': 'you',
  'refuse-mode-auto': 'denied',
};
const SHELL = new Set(['Bash', 'PowerShell', 'Monitor']);
const VERBS = { Write: 'Écrit', Edit: 'Modifie', MultiEdit: 'Modifie', NotebookEdit: 'Modifie', Read: 'Lit' };
const AUTO_SUFFIX = / — choisi automatiquement par Vigie \(utilisateur absent\)$/;

function acceptedTitle(h) {
  const tool = String(h.tool || '');
  if (tool === 'AskUserQuestion') return short(questionText(h.action) || 'Question de Claude', 120);
  if (tool === 'ExitPlanMode') return 'Valider le plan';
  if (h.description) return short(h.description, 120);
  if (VERBS[tool]) return `${VERBS[tool]} ${path.basename(String(h.action || ''))}`;
  if (tool.startsWith('mcp__')) {
    const [, srv = '', name = ''] = tool.split('__');
    return short(`${name.replace(/[_-]+/g, ' ')} · ${srv.startsWith('claude_ai_') ? connectorName(srv) : srv}`, 120);
  }
  if (SHELL.has(tool)) return short(mask(firstLine(h.action)), 120) || 'Commande';
  return tool || 'Action';
}
function acceptedDetail(h) {
  if (h.tool === 'AskUserQuestion') {
    const picked = isObj(h.answers) ? Object.values(h.answers).map((v) => String(v).replace(AUTO_SUFFIX, '')).filter(Boolean) : [];
    if (picked.length) return short(`Choisi : ${picked.join(' · ')}`, 300);
    return clip(questionAction(h.action), 400) || null;
  }
  if (h.tool === 'ExitPlanMode') return null;
  const action = clip(mask(h.action), 400) || null;
  return h.rule ? `${h.rule} · ${action || ''}`.trim() : action;
}
function acceptedKind(h) {
  const tool = String(h.tool || '');
  if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return 'question';
  return actionKind(SHELL.has(tool) ? 'Bash' : tool, SHELL.has(tool) ? { command: String(h.action || '') } : {});
}
// Service d'un appel MCP (icône de l'app) : « mcp__figma-perso__… » → figma ; connecteur → gmail…
function acceptedService(h) {
  const tool = String(h.tool || '');
  if (!tool.startsWith('mcp__')) return null;
  const srv = tool.split('__')[1] || '';
  return mcpService(srv.startsWith('claude_ai_') ? connectorName(srv) : srv, {});
}
// Ligne d'historique à montrer (une attente finie n'en a pas : sa suite a sa propre ligne).
const pendingTs = (ctx) => new Set([...ctx.waits.values()].flat().map((w) => `${w.sessionId}\u0000${w.ts}`));
function acceptedFor(sid, ctx) {
  const pending = pendingTs(ctx);
  const out = [];
  for (let i = history.length - 1; i >= 0 && out.length < MAX_ACCEPTED; i--) {
    const h = history[i];
    if (h.sessionId !== sid) continue;
    const decision = DECISIONS[h.event];
    if (!decision) continue;
    if (WAIT_EVENTS.has(h.event) && !pending.has(`${sid}\u0000${h.ts}`)) continue;
    out.push({ ts: h.ts, kind: acceptedKind(h), title: acceptedTitle(h), detail: acceptedDetail(h), decision,
      agent: agentName(sid, h.agentId), service: acceptedService(h) });
  }
  return out;
}

// Fil des dernières décisions de Vigie, toutes conversations confondues (hors conversations jetables).
function recentAccepted(ctx, sums) {
  const byId = new Map(sums.map((s) => [s.id, s]));
  const pending = pendingTs(ctx);
  const out = [];
  for (let i = history.length - 1; i >= 0 && out.length < MAX_RECENT_ACCEPTED; i--) {
    const h = history[i];
    const decision = DECISIONS[h.event];
    if (!decision || !h.ts) continue;
    const sid = typeof h.sessionId === 'string' ? h.sessionId : null;
    if (WAIT_EVENTS.has(h.event) && !pending.has(`${sid}\u0000${h.ts}`)) continue;
    if (sid && conv.isThrowaway(sid)) continue;
    const s = sid ? byId.get(sid) : null;
    const s2 = sid && !s ? indexer.sessions.get(sid) : null;
    out.push({
      ts: h.ts, conversationId: sid,
      conversationTitle: s?.title ?? s2?.title ?? null,
      project: s?.project ?? (h.cwd ? path.basename(String(h.cwd)) : null),
      kind: acceptedKind(h), title: acceptedTitle(h), detail: acceptedDetail(h), decision,
      agent: sid ? agentName(sid, h.agentId) : null, service: acceptedService(h),
    });
  }
  return out;
}

// Rubrique MCP d'une conversation : ce qui est branché pour son dossier de LANCEMENT et son compte, ce
// qu'elle a utilisé, et le dernier état réel relevé (status) pour ce compte et ce dossier.
function conversationMcp(used, cwd, accountId, connectors) {
  const uses = new Map(used.map((m) => [m.name, m]));
  const out = new Map();
  let configured = [];
  try { configured = cwd ? mcp.forProject(cwd, { accountId }) : []; } catch (e) { console.error('[vigie] MCP de la conversation :', clean(e)); }
  for (const c of configured) {
    const key = toolKey(c.name);
    const u = uses.get(key);
    out.set(key, { name: c.name, scope: c.scope, service: c.service, uses: u?.uses || 0, lastTs: u?.lastTs || null, enabled: c.enabled, status: c.status || 'unknown' });
  }
  for (const [key, u] of uses) {
    if (out.has(key)) continue;
    const scope = key.startsWith('claude_ai_') ? 'connector' : key.startsWith('plugin_') ? 'plugin' : 'unknown';
    const name = scope === 'connector' ? connectorName(key) : key;
    const enabled = scope === 'connector' ? connectors === 'on' : scope === 'plugin' ? true : null;
    let status = 'unknown';
    try { status = mcp.statusFor(key, { scope, accountId, cwd, enabled }); } catch { /* pas encore de relevé */ }
    out.set(key, { name, scope, service: mcpService(name, {}), uses: u.uses, lastTs: u.lastTs || null, enabled, status });
  }
  return [...out.values()].sort((a, b) => (b.uses - a.uses) || a.name.localeCompare(b.name));
}

function conversationV2(id) {
  const d = conv.detail(id);
  if (!d) return null;
  const ctx = context();
  const needs = countBy(reviewItems(ctx, conv.summaries()));
  const summary = decorate(d.summary, ctx, needs, acceptedCounts(ctx));
  return {
    summary,
    now: d.now,
    chapters: d.chapters,
    accepted: acceptedFor(id, ctx),
    activity: d.activity,
    agents: d.agents,
    workflows: d.workflows,
    artifacts: d.artifacts,
    files: d.files,
    tests: d.tests,
    mcp: conversationMcp(d.mcp, launchDirOf(id) || summary.cwd, summary.accountId, summary.connectors),
    tokens: d.tokens,
    limits: d.limits,
    current: d.current ?? null,
    milestones: d.milestones || [],
    trackingDoc: d.trackingDoc ?? null,
  };
}

// ---------- écritures v2 ----------
const bad = (error, status = 400) => [status, { ok: false, error }];
function minutesIn(v, lo, hi) {
  if (v === '' || v === null || typeof v === 'boolean' || (typeof v !== 'number' && typeof v !== 'string')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= lo && r <= hi ? r : null;
}

function postSettings(body) {
  const s = readState();
  if ('autoAccept' in body) { if (typeof body.autoAccept !== 'boolean') return bad('Auto-accept : oui ou non.'); s.autoAccept = body.autoAccept; }
  if ('questionsAuto' in body) {
    if (typeof body.questionsAuto !== 'boolean') return bad('Questions : oui ou non.');
    if (body.questionsAuto !== questionsAuto(s)) s.questions = questionsMode(body.questionsAuto); // garde l'ancien « tout de suite » s'il est déjà actif
  }
  if ('questionWaitMin' in body) {
    const n = minutesIn(body.questionWaitMin, 1, 120);
    if (n === null) return bad('Indique un délai entre 1 et 120 min.');
    s.questionWaitMin = n;
  }
  if ('connectorsDefault' in body) {
    if (body.connectorsDefault !== 'on' && body.connectorsDefault !== 'off') return bad('Connecteurs : on ou off.');
    s.connectorsDefault = body.connectorsDefault;
  }
  if ('guard' in body) {
    const g = body.guard;
    if (!isObj(g)) return bad('Garde-fous illisibles.');
    if ('enabled' in g) { if (typeof g.enabled !== 'boolean') return bad('Garde-fous : oui ou non.'); s.guard.enabled = g.enabled; }
    if ('mode' in g) { if (!GUARD_MODES.includes(g.mode)) return bad('Garde-fous : mode vigie ou vscode.'); s.guard.mode = g.mode; }
    if ('waitMin' in g) {
      const n = minutesIn(g.waitMin, 0, 120);
      if (n === null) return bad('Indique un délai entre 0 et 120 min.');
      s.guard.waitMin = n;
    }
    if ('rules' in g) {
      if (!Array.isArray(g.rules)) return bad('Garde-fous illisibles.');
      for (const r of g.rules) {
        if (!isObj(r) || typeof r.id !== 'string' || typeof r.disabled !== 'boolean') return bad('Garde-fous illisibles.');
        const rule = s.guard.rules.find((x) => String(x.id || x.label) === r.id);
        if (!rule) return bad('Garde-fou inconnu.');
        rule.disabled = r.disabled;
      }
    }
  }
  writeState(s);
  return [200, { ok: true, settings: settingsView(readState()) }];
}

function postConversationSettings(id, body) {
  if (!UUID.test(id)) return bad('Conversation inconnue.', 404);
  const keys = ['autoAccept', 'accountId', 'connectors'].filter((k) => k in body);
  if (!keys.length) return bad('Rien à régler.');
  if ('autoAccept' in body && body.autoAccept !== null && typeof body.autoAccept !== 'boolean') return bad('Auto-accept : oui, non ou par défaut.');
  if ('connectors' in body && ![null, 'on', 'off'].includes(body.connectors)) return bad('Connecteurs : on, off ou par défaut.');
  if ('accountId' in body && typeof body.accountId !== 'string') return bad('Compte inconnu.');
  let sw = null;
  // La bascule d'abord : si elle est refusée, rien d'autre n'est changé.
  if ('accountId' in body) {
    const contextTokens = indexer.sessions.get(id)?.context?.tokens ?? null;
    const r = accounts.switchConversation(id, body.accountId, { liveSessions: liveEnriched(), contextTokens, now: body.now === true });
    if (!r.ok) return bad(r.error || 'Bascule impossible.');
    sw = r.switch;
  }
  if ('autoAccept' in body || 'connectors' in body) {
    const s = readState();
    const cur = { ...(Object.hasOwn(s.sessions, id) && isObj(s.sessions[id]) ? s.sessions[id] : {}) };
    if ('autoAccept' in body) { if (typeof body.autoAccept === 'boolean') cur.autoAccept = body.autoAccept; else delete cur.autoAccept; }
    if ('connectors' in body) { if (body.connectors === 'on' || body.connectors === 'off') cur.connectors = body.connectors; else delete cur.connectors; }
    if (Object.keys(cur).length) s.sessions[id] = cur; else delete s.sessions[id];
    writeState(s);
  }
  const state = readState();
  const eff = effective(state, id);
  const ov = Object.hasOwn(state.sessions, id) ? state.sessions[id] : null;
  return [200, { ok: true, ...(sw ? { switch: sw } : {}),
    conversation: { autoAccept: eff.autoAccept, autoAcceptOverride: typeof ov?.autoAccept === 'boolean' ? ov.autoAccept : null,
      connectors: connectorsOf(eff, accounts.wrapperActive()), accountId: accounts.accountOf(id) } }];
}

// ---------- actions sensibles, « À regarder », ouvrir VS Code ou Terminal ----------

// POST /api/v2/pending/:pendingId { decision: allow | deny } : comme un clic dans VS Code (lib/decisions.mjs).
function postPending(raw, body) {
  let id;
  try { id = decodeURIComponent(raw); } catch { return bad('Cette action n\'attend plus ta décision.', 404); }
  const r = decide(id, body.decision, { history, state: readState() });
  return r.ok ? [200, { ok: true, pendingId: r.pendingId, decision: r.decision, message: r.message }] : bad(r.error || 'Échec.', r.status || 400);
}

// POST /api/v2/approvals { approvalId, decision?: 'deny' } (mode « seulement par Vigie », lib/approvals.mjs).
// allow : autorisation à usage unique (2 h) pour l'appel exact. Si la conversation attend encore (holding),
// l'action part tout de suite (delivered: true) ; sinon l'app copie le message et ouvre la bonne fenêtre.
const shellTool = (t) => SHELL.has(String(t || ''));
function approvalWhat(a) {
  const cmd = mask(a.command);
  if (shellTool(a.tool)) return short(firstLine(cmd), 160) || 'la commande';
  return short(`${a.tool || 'action'} ${cmd}`, 160);
}
function postApprovals(body) {
  const r = approve(body.approvalId, body.decision, { history });
  if (!r.ok) return bad(r.error || 'Échec.', r.status || 400);
  if (r.decision === 'deny') return [200, { ok: true, approvalId: r.approvalId, decision: 'deny', message: 'Refusée : rien n\'est envoyé à Claude.' }];
  // La conversation attend encore (PreToolUse) : l'action part d'elle-même, rien à ouvrir ni à coller.
  if (r.item.holding) {
    return [200, { ok: true, approvalId: r.approvalId, decision: 'allow', expiresAt: r.expiresAt, delivered: true,
      message: 'Autorisée : elle se lance dans sa conversation.', openUrl: null, needsPassword: r.item.needsPassword }];
  }
  // Elle a continué sans : le message est à coller dans SA conversation (l'app ouvre la bonne fenêtre par
  // POST /api/v2/open, jamais un lien vscode:// direct qui s'ouvrirait dans la fenêtre au premier plan).
  const message = `L'utilisateur a autorisé : ${approvalWhat(r.item)}. Relance-la exactement à l'identique.`;
  return [200, { ok: true, approvalId: r.approvalId, decision: 'allow', expiresAt: r.expiresAt, message, delivered: false,
    openUrl: null, needsPassword: r.item.needsPassword }];
}

// POST /api/v2/review/:id/dismiss : retire l'élément de « À regarder » (noté dans data/ui.json).
// Une question écartée est aussi notée relue (comme « Ça me va »).
const REVIEW_ID = /^(?:[gwsbl]:[\w.:-]{1,200}|c:[0-9a-f-]{36}|q:[\w-]{1,100}|v:[0-9a-f]{16})$/i;
function postDismiss(raw) {
  let id;
  try { id = decodeURIComponent(raw); } catch { return bad('Élément inconnu.', 404); }
  if (!REVIEW_ID.test(id)) return bad('Élément inconnu.', 404);
  if (id.startsWith('q:')) { const r = questions.review(id, { action: 'ok' }); if (!r.ok && r.status !== 404) return bad(r.error || 'Échec.', r.status || 400); }
  const u = ui();
  const now = Date.now();
  const kept = Object.entries(dismissedOf(u)).filter(([, at]) => now - Date.parse(at) < DISMISS_KEEP_MS);
  kept.push([id, new Date(now).toISOString()]);
  writeJson(UI_FILE, { ...u, dismissed: Object.fromEntries(kept.slice(-DISMISS_MAX)) });
  return [200, { ok: true, id }];
}

// Lance un programme du Mac sans shell ; résultat { ok, code }. La sortie n'est jamais journalisée.
function runBin(bin, args, { input = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: [input === null ? 'ignore' : 'pipe', 'ignore', 'ignore'] }); } catch { return resolve({ ok: false, code: null }); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* déjà fini */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(t); resolve({ ok: false, code: null }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code }); });
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// { kind: "conversation", id } : VS Code s'ouvre sur le dossier de la conversation, puis sur la conversation
// elle-même (lien de l'extension Claude Code : rien n'est envoyé, la saisie reste vide).
async function openConversation(id) {
  if (typeof id !== 'string' || !UUID.test(id)) return bad('Conversation inconnue.', 404);
  const dir = launchDirOf(id);
  if (!dir) return bad('Conversation introuvable : plus de 7 jours, ou inconnue.', 404);
  if (!isDir(dir)) return bad('Le dossier de cette conversation n\'existe plus.', 404);
  if (!(await runBin(OPEN_BIN, ['-a', 'Visual Studio Code', dir])).ok) return bad('VS Code ne s\'est pas ouvert.');
  const openUrl = `vscode://anthropic.claude-code/open?session=${id}`;
  const tab = await runBin(OPEN_BIN, [openUrl]);
  return [200, { ok: true, message: tab.ok ? `Conversation ouverte dans VS Code (${path.basename(dir)}).` : `VS Code est ouvert sur ${path.basename(dir)}.`, openUrl }];
}

// La commande exacte d'un garde-fou : l'app ne reçoit que le texte masqué (clés remplacées par ••••).
// On la retrouve par l'élément (g:/b:), par l'attente (pendingId), ou par son texte masqué.
function guardCommand(body) {
  const pid = body.pendingId;
  if (typeof pid === 'string' || typeof pid === 'number') {
    try {
      const p = pendingGuards({ history, state: readState() }).find((x) => x.pendingId === String(pid));
      if (p) return { command: p.command, cwd: p.cwd };
    } catch { /* attente introuvable : on essaie autrement */ }
  }
  const m = typeof body.id === 'string' ? /^[gb]:([^:]*):(.+)$/.exec(body.id) : null;
  for (let i = history.length - 1; m && i >= 0; i--) {
    const h = history[i];
    if (String(h.sessionId) === m[1] && h.ts === m[2] && String(h.event || '').startsWith('garde-fou')) return { command: String(h.action || ''), cwd: h.cwd ?? null };
  }
  const text = typeof body.command === 'string' ? body.command : '';
  if (!text.includes('••••')) return text ? { command: text, cwd: null } : null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!String(h.event || '').startsWith('garde-fou') || typeof h.action !== 'string') continue;
    if (mask(h.action).slice(0, MAX_COMMAND) === text || mask(h.action.slice(0, MAX_COMMAND)) === text) return { command: h.action, cwd: h.cwd ?? null };
  }
  return { masked: true };
}

// { kind: "terminal", command, cwd, id?, pendingId? } : Terminal s'ouvre avec la commande TAPÉE mais pas lancée
// (zsh : `print -rz` la place dans la ligne de saisie ; L'utilisateur relit, appuie sur Entrée, tape son mot de passe).
// La commande passe par un fichier 0600 effacé aussitôt lu, jamais par le texte de la fenêtre.
// Sans zsh, ou si macOS refuse à Vigie de piloter Terminal : commande copiée, Terminal ouvert, sauf si elle
// contient une clé (jamais copiée).
const TERM_DIR = path.join(DATA, 'terminal');
const loginShell = () => { try { return process.env.VIGIE_SHELL || os.userInfo().shell || process.env.SHELL || ''; } catch { return process.env.SHELL || ''; } };
async function openTerminalWith(body) {
  const found = guardCommand(body);
  if (!found) return bad('Quelle commande ? Elle est vide.');
  if (found.masked) return bad('Commande masquée introuvable : ouvre la conversation pour la relancer.');
  const command = found.command;
  if (!command.trim() || command.length > MAX_COMMAND || command.includes('\u0000')) return bad('Commande refusée : vide ou trop longue.');
  const okDir = (d) => typeof d === 'string' && path.isAbsolute(d) && !/[\u0000-\u001f\u007f]/.test(d) && isDir(d);
  const cwd = okDir(body.cwd) ? body.cwd : okDir(found.cwd) ? found.cwd : HOME;
  const cut = command.length >= MAX_COMMAND ? ' Elle a été coupée à 4000 caractères : relis-la.' : '';
  if (/(^|\/)zsh$/.test(loginShell())) {
    try {
      fs.mkdirSync(TERM_DIR, { recursive: true, mode: 0o700 });
      for (const f of fs.readdirSync(TERM_DIR)) { // fichiers que Terminal n'a pas lus (plus de 10 min)
        const p = path.join(TERM_DIR, f);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60_000) fs.rmSync(p, { force: true }); } catch { /* déjà parti */ }
      }
      const file = path.join(TERM_DIR, `${crypto.randomBytes(8).toString('hex')}.txt`);
      fs.writeFileSync(file, command, { mode: 0o600 });
      const script = `clear; cd ${shq(cwd)} && print -rz -- "$(<${shq(file)})"; rm -f ${shq(file)}`;
      const r = await openInTerminal(script, { osascript: OSASCRIPT });
      if (r?.ok) return [200, { ok: true, mode: 'typed', message: `Terminal est ouvert, commande prête : relis-la, appuie sur Entrée.${cut}` }];
      fs.rmSync(file, { force: true });
    } catch (e) { console.error('[vigie] Terminal :', clean(e)); }
  }
  if (mask(command) !== command) return bad('Cette commande contient une clé : je ne la copie pas. Relance-la depuis la conversation.');
  const copied = await runBin(PBCOPY, [], { input: command });
  const opened = await runBin(OPEN_BIN, ['-a', 'Terminal', cwd]);
  if (!copied.ok || !opened.ok) return bad('Terminal ne s\'est pas ouvert.');
  return [200, { ok: true, mode: 'clipboard', message: `Commande copiée, Terminal ouvert : colle-la (⌘V), puis Entrée.${cut}` }];
}

async function postOpen(body) {
  if (body.kind === 'conversation') return openConversation(body.id);
  if (body.kind === 'terminal') return openTerminalWith(body);
  return bad('Que faut-il ouvrir ? « conversation » ou « terminal ».');
}

function postSeen(body) {
  const t = typeof body.ts === 'string' ? Date.parse(body.ts) : NaN;
  const ts = Number.isFinite(t) && t <= Date.now() + 60_000 ? new Date(t).toISOString() : new Date().toISOString();
  writeJson(UI_FILE, { ...ui(), lastSeen: ts });
  return [200, { ok: true, since: ts }];
}

function accountLabel(id) { return accounts.load().accounts.find((a) => a.id === id)?.label || id || 'Compte'; }
// Résultat d'une action MCP : un échec compte par compte devient une phrase lisible.
function mcpReply(r) {
  if (r?.ok) return [200, r];
  const error = r?.error || (Array.isArray(r?.results) ? r.results.filter((x) => !x.ok).map((x) => `${accountLabel(x.accountId)} : ${x.error}`).join(' · ') : '') || 'Échec.';
  return [400, { ...r, ok: false, error }];
}
async function postMcpUser(body) {
  const { action, name, config, accounts: ids } = body;
  if (action === 'add') return mcpReply(await mcp.addUser(name, config, ids));
  if (action === 'update') return mcpReply(await mcp.updateUser(name, config, ids));
  if (action === 'remove') return mcpReply(await mcp.removeUser(name, ids));
  return bad('Action inconnue.');
}
async function postMcpProject(body) {
  const { action, path: p, name, config } = body;
  if (action === 'add') return mcpReply(await mcp.addProject(p, name, config));
  if (action === 'update') return mcpReply(await mcp.updateProject(p, name, config));
  if (action === 'remove') return mcpReply(await mcp.removeProject(p, name));
  return bad('Action inconnue.');
}
async function postMcpDisable(body) {
  if (typeof body.disabled !== 'boolean') return bad('Couper : oui ou non.');
  return mcpReply(await mcp.setDisabled(body.path, body.name, body.disabled)); // jamais le 4e paramètre (tests)
}
// POST /api/v2/mcp/check { accountId?, path? } → { ok, startedAt, queued? } : le relevé tourne en fond.
async function postMcpCheck(body) {
  return mcpReply(await mcp.requestCheck({ accountId: body.accountId, path: body.path }));
}
// POST /api/v2/mcp/connect { name, accountId?, path?, scope? } → { ok, message, mode: browser | terminal }.
// L'app montre un connecteur sous son nom (« Gmail ») : la CLI l'appelle « claude.ai Gmail ».
function connectName(body) {
  const raw = typeof body.name === 'string' ? body.name.trim() : body.name;
  if (typeof raw !== 'string' || !raw || /^claude\.ai\s/i.test(raw)) return raw;
  if (raw.startsWith('claude_ai_')) return `claude.ai ${connectorName(raw)}`;
  if (body.scope === 'connector') return `claude.ai ${raw}`;
  try {
    const dir = typeof body.path === 'string' && path.isAbsolute(body.path) ? body.path : HOME;
    const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
    if (mcp.forProject(dir, { accountId }).some((c) => c.name === raw)) return raw;
    const inv = mcp.inventory({ connectorsDefault: readState().connectorsDefault });
    if ((inv.connectors || []).some((c) => c.name === raw)) return `claude.ai ${raw}`;
  } catch (e) { console.error('[vigie] MCP à connecter :', clean(e)); }
  return raw;
}
// `claude mcp login` EFFACE d'abord les jetons d'un MCP OAuth : relancé sur un MCP qui marche, il le
// déconnecte jusqu'à la nouvelle autorisation. Un MCP relevé « connected » n'est donc reconnecté que sur
// demande explicite (force: true).
function lastStatus(name, body) {
  try {
    const dir = typeof body.path === 'string' && path.isAbsolute(body.path) ? body.path : HOME;
    const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
    if (/^claude\.ai\s/i.test(name)) return mcp.statusFor(name.replace(/^claude\.ai\s+/i, ''), { accountId, cwd: dir, scope: 'connector' });
    return mcp.forProject(dir, { accountId }).find((c) => c.name === name)?.status || 'unknown';
  } catch { return 'unknown'; }
}
async function postMcpConnect(body) {
  // « Connecter partout » : chaque compte qui le demande, l'un après l'autre (MCP du Mac seulement)
  if (body.everywhere === true) return mcpReply(await mcp.connectEverywhere({ name: body.name }));
  const name = connectName(body);
  if (body.force !== true && typeof name === 'string' && name && lastStatus(name, body) === 'connected') {
    return bad('Déjà connecté : rien à faire (reconnecter effacerait l\'autorisation en place).');
  }
  return mcpReply(await mcp.connect({ name, accountId: body.accountId, path: body.path }));
}
function postAccounts(body) {
  const r = accounts.apply(body);
  return r.ok ? [200, r] : [400, { ...r, ok: false, error: r.error || 'Échec.' }];
}
function postQuestionReview(raw, body) {
  let id;
  try { id = decodeURIComponent(raw); } catch { return bad('Question introuvable.', 404); }
  if (!/^(q:)?[\w-]{1,100}$/.test(id)) return bad('Question introuvable.', 404);
  const r = questions.review(id, body);
  return r.ok ? [200, r] : bad(r.error || 'Échec.', r.status || 400);
}

// ---------- vues et réglages v1 (ancienne app de la barre des menus) ----------
function quotas() {
  const j = readJson(QUOTA_FILE, null);
  if (!Array.isArray(j?.metrics)) return null;
  return { metrics: j.metrics.map((m) => ({ title: m.title, value: m.formattedValue, ratio: m.normalizedValue })) };
}
function sessionNames() {
  const m = new Map();
  for (const s of indexer.sessions.values()) {
    const live = indexer.live.get(s.id);
    m.set(s.id, { title: s.title || live?.name || s.projectDir, project: path.basename(live?.cwd || s.cwd || s.projectDir) });
  }
  return m;
}
function awaySummary(since) {
  const ev = {};
  for (const h of history) if (h.ts >= since) ev[h.event] = (ev[h.event] || 0) + 1;
  const per = [];
  let tests = 0, testsFailed = 0, files = 0, artifacts = 0, limits = 0;
  for (const s of indexer.sessions.values()) {
    const t = s.tests.filter((x) => x.ts >= since);
    const failed = t.filter((x) => x.ok === false && !x.red).length;
    const f = [...s.files.values()].filter((x) => x.lastTs >= since).length;
    const a = [...s.artifacts.values()].filter((x) => (x.lastTs || x.firstTs) >= since).length;
    const l = s.limits.filter((x) => x.ts >= since);
    tests += t.length; testsFailed += failed; files += f; artifacts += a; limits += l.length;
    if (t.length || f || a || l.length) per.push({ id: s.id, tests: t.length, testsFailed: failed, files: f, artifacts: a, limits: l.length });
  }
  return { since, events: ev, tests, testsFailed, files, artifacts, limits, sessions: per };
}
function overviewV1() {
  const state = readState();
  const u = ui();
  const waits = pendingWaits(state);
  const sessions = [...indexer.sessions.values()].map((s) => {
    const x = indexer.summary(s);
    const ov = Object.hasOwn(state.sessions, s.id) ? state.sessions[s.id] : {};
    const hs = history.filter((h) => h.sessionId === s.id);
    return {
      ...x,
      settings: { effective: effective(state, s.id), override: { autoAccept: ov.autoAccept ?? null, questions: ov.questions ?? null } },
      hook: {
        accepted: hs.filter((h) => h.event === 'auto-accepte').length,
        acceptedSinceSeen: hs.filter((h) => h.event === 'auto-accepte' && h.ts >= u.lastSeen).length,
        blocked: hs.filter((h) => h.event === 'garde-fou-bloque').length,
        questionsAuto: hs.filter((h) => h.event === 'question-auto').length,
        waitingForYou: x.running ? (waits.get(s.id) || []).length : 0,
        // séparés : une question en attente n'est pas une action sensible (constat « alerte-question »)
        guardsWaiting: x.running ? (waits.get(s.id) || []).filter((w) => !w.question).length : 0,
        questionsWaiting: x.running ? (waits.get(s.id) || []).filter((w) => w.question).length : 0,
        last: hs.length ? hs[hs.length - 1] : null,
      },
    };
  }).sort((a, b) => (b.running - a.running) || String(b.lastActivity || b.lastTs || '').localeCompare(String(a.lastActivity || a.lastTs || '')));
  return {
    now: new Date().toISOString(),
    state: { autoAccept: state.autoAccept, questions: state.questions, questionWaitMin: state.questionWaitMin, guard: state.guard },
    defaultGuards: DEFAULT_GUARDS,
    ui: u,
    away: awaySummary(u.lastSeen),
    quotas: quotas(),
    indexing: indexer.progress,
    sessions,
  };
}
function historyV1(q) {
  const names = sessionNames();
  const since = q.get('since') || '';
  const sid = q.get('session');
  const ev = q.get('event');
  const n = Number(q.get('limit'));
  const limit = Math.min(Number.isFinite(n) && n > 0 ? n : 1000, 5000);
  const out = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const h = history[i];
    if (since && h.ts < since) break;
    if (sid && h.sessionId !== sid) continue;
    if (ev && !String(h.event || '').startsWith(ev)) continue;
    const nm = names.get(h.sessionId);
    out.push({ ...h, sessionTitle: nm?.title || null, project: nm?.project || (h.cwd ? path.basename(h.cwd) : null) });
  }
  return out;
}
// Une saisie vide ne devient jamais 0 (garde-fous refusés tout de suite) ni 1 min (constat « saisie vide »).
const filled = (v) => v !== '' && v !== null && v !== undefined && typeof v !== 'boolean' && Number.isFinite(Number(v));
const clampMin = (v) => Math.max(0, Math.min(120, Math.round(Number(v))));
function settingsV1(body) {
  const s = readState();
  if (typeof body.autoAccept === 'boolean') s.autoAccept = body.autoAccept;
  if (QUESTION_MODES.includes(body.questions)) s.questions = body.questions;
  if (filled(body.questionWaitMin)) s.questionWaitMin = Math.max(1, clampMin(body.questionWaitMin));
  if (isObj(body.guard)) {
    if (typeof body.guard.enabled === 'boolean') s.guard.enabled = body.guard.enabled;
    if (filled(body.guard.waitMin)) s.guard.waitMin = clampMin(body.guard.waitMin);
    if (Array.isArray(body.guard.rules)) {
      s.guard.rules = body.guard.rules.filter((r) => isObj(r) && typeof r.label === 'string' && (r.tool || r.match)).map((r) => {
        for (const k of ['tool', 'match']) if (r[k]) new RegExp(r[k]); // lève une erreur (400) si la regex est invalide
        return { id: String(r.id || r.label).slice(0, 60), label: r.label.slice(0, 120), tool: r.tool || undefined, match: r.match || undefined, disabled: !!r.disabled };
      });
    }
    if (body.guard.reset === true) s.guard.rules = structuredClone(DEFAULT_GUARDS);
  }
  writeState(s);
  return [200, { ok: true }];
}
function sessionSettingsV1(id, body) {
  if (!UUID.test(id)) return bad('Conversation inconnue.', 404);
  const s = readState();
  const cur = { ...(Object.hasOwn(s.sessions, id) && isObj(s.sessions[id]) ? s.sessions[id] : {}) };
  if ('autoAccept' in body) { if (typeof body.autoAccept === 'boolean') cur.autoAccept = body.autoAccept; else delete cur.autoAccept; }
  if ('questions' in body) { if (QUESTION_MODES.includes(body.questions)) cur.questions = body.questions; else delete cur.questions; }
  if (Object.keys(cur).length) s.sessions[id] = cur; else delete s.sessions[id];
  writeState(s);
  return [200, { ok: true }];
}
function sessionV1(id) {
  const d = indexer.detail(id);
  if (!d) return bad('Conversation inconnue.', 404);
  const state = readState();
  return [200, { ...d, settings: { effective: effective(state, id), override: (Object.hasOwn(state.sessions, id) && state.sessions[id]) || {} },
    history: historyV1(new URLSearchParams({ session: id, limit: '1500' })) }];
}

// ---------- HTTP ----------
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // Une page tierce ne peut ni intégrer Vigie dans un cadre (clic piégé) ni y injecter de script.
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
};
function send(res, code, body, type = 'application/json; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Trop gros : on lit jusqu'au bout sans garder, pour pouvoir répondre proprement.
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('error', () => reject(new HttpError(400, 'Requête interrompue.')));
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'Requête trop grosse.'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      let v;
      try { v = JSON.parse(text); } catch { return reject(new HttpError(400, 'JSON illisible.')); } // jamais le texte reçu : il peut contenir une clé
      if (!isObj(v)) return reject(new HttpError(400, 'Un objet JSON est attendu.'));
      resolve(v);
    });
  });
}

const S = '([^/]{1,120})';
const ROUTES = [
  // v2 : l'app Mac
  ['GET', /^\/api\/v2\/overview$/, () => [200, overviewV2()]],
  ['GET', new RegExp(`^/api/v2/conversation/${S}$`), ([id]) => {
    const d = UUID.test(id) ? conversationV2(id) : null;
    return d ? [200, d] : bad('Conversation introuvable : plus de 48 h, ou inconnue.', 404);
  }],
  ['GET', /^\/api\/v2\/mcp$/, () => [200, mcp.inventory({ connectorsDefault: readState().connectorsDefault })]],
  ['GET', /^\/api\/v2\/accounts$/, () => [200, accounts.view()]],
  ['GET', /^\/api\/v2\/health$/, () => [200, health()]],
  ['GET', /^\/api\/v2\/usage\/series$/, (_, __, url) => usageSeries(url)],
  ['POST', /^\/api\/v2\/settings$/, (_, b) => postSettings(b)],
  ['POST', new RegExp(`^/api/v2/conversation/${S}/settings$`), ([id], b) => postConversationSettings(id, b)],
  ['POST', new RegExp(`^/api/v2/questions/${S}/review$`), ([id], b) => postQuestionReview(id, b)],
  ['POST', /^\/api\/v2\/seen$/, (_, b) => postSeen(b)],
  ['POST', /^\/api\/v2\/mcp\/user$/, (_, b) => postMcpUser(b)],
  ['POST', /^\/api\/v2\/mcp\/project$/, (_, b) => postMcpProject(b)],
  ['POST', /^\/api\/v2\/mcp\/disable$/, (_, b) => postMcpDisable(b)],
  ['POST', /^\/api\/v2\/mcp\/check$/, (_, b) => postMcpCheck(b)],
  ['POST', /^\/api\/v2\/mcp\/connect$/, (_, b) => postMcpConnect(b)],
  ['POST', /^\/api\/v2\/accounts$/, (_, b) => postAccounts(b)],
  ['POST', new RegExp(`^/api/v2/pending/${S}$`), ([id], b) => postPending(id, b)],
  ['POST', /^\/api\/v2\/approvals$/, (_, b) => postApprovals(b)],
  ['POST', /^\/api\/v2\/review\/([^/]{1,400})\/dismiss$/, ([id]) => postDismiss(id)],
  ['POST', /^\/api\/v2\/open$/, (_, b) => postOpen(b)],
  // v1 : ancienne app de la barre des menus, tant qu'elle tourne
  ['GET', /^\/api\/overview$/, () => [200, overviewV1()]],
  ['GET', /^\/api\/history$/, (_, __, url) => [200, historyV1(url.searchParams)]],
  ['GET', /^\/api\/health$/, () => [200, health()]],
  ['GET', new RegExp(`^/api/session/${S}$`), ([id]) => sessionV1(id)],
  ['POST', /^\/api\/settings$/, (_, b) => settingsV1(b)],
  ['POST', new RegExp(`^/api/session/${S}/settings$`), ([id], b) => sessionSettingsV1(id, b)],
  ['POST', /^\/api\/seen$/, (_, b) => postSeen(b)],
];
const STATIC = { '/': 'index.html', '/index.html': 'index.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function health() { return { ok: true, version: 2, indexing: indexer.progress, history: history.length }; }

async function handle(req, res) {
  // On refuse tout autre hôte (protection contre le « DNS rebinding ») et, pour les écritures, toute requête
  // sans l'en-tête maison, qu'une page web tierce ne peut pas envoyer sans autorisation CORS (jamais donnée).
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { ok: false, error: 'Hôte refusé.' });
  let url;
  try { url = new URL(req.url, `http://${host}`); } catch { return send(res, 400, { ok: false, error: 'Adresse invalide.' }); }

  const found = ROUTES.map(([method, re, fn]) => ({ method, m: re.exec(url.pathname), fn })).filter((r) => r.m);
  if (!found.length) {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(PUBLIC, STATIC[url.pathname]);
      return fs.readFile(file, (err, data) => (err ? send(res, 404, 'Introuvable.', 'text/plain; charset=utf-8')
        : send(res, 200, data, MIME[path.extname(file)])));
    }
    return send(res, 404, { ok: false, error: 'Adresse inconnue.' });
  }
  const route = found.find((r) => r.method === req.method);
  if (!route) return send(res, 405, { ok: false, error: 'Méthode non prise en charge.' });

  let body = {};
  if (req.method === 'POST') {
    if (req.headers['x-vigie'] !== '1') return send(res, 403, { ok: false, error: 'En-tête X-Vigie manquant.' });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { ok: false, error: 'Origine refusée.' });
    body = await readBody(req);
  }
  const [status, out] = await route.fn(route.m.slice(1), body, url);
  return send(res, status, out);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message });
    if (e instanceof SyntaxError && /regular expression/i.test(e.message)) return send(res, 400, { ok: false, error: 'Expression régulière invalide.' });
    console.error('[vigie] requête :', clean(e));
    send(res, 500, { ok: false, error: 'Erreur interne de Vigie.' });
  });
});

// ---------- tâches de fond ----------
let healthNotices = [];
let switchNotices = []; // bascules appliquées : L'utilisateur doit envoyer un message pour relancer la conversation
let ticking = false;
let lastHealth = 0;
let nextMcpCheck = Date.now() + MCP_CHECK_FIRST_MS;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { readHistory(); await indexer.refresh(); } catch (e) { console.error('[vigie] indexation :', clean(e)); }
  try {
    const r = accounts.processPending(liveEnriched());
    const now = new Date().toISOString();
    for (const a of r.applied) if (a.state === 'done') switchNotices.push({ sessionId: a.sessionId, message: a.message, ts: now });
    // Une bascule n'est plus à signaler une fois la conversation relancée, ou après 6 h.
    switchNotices = switchNotices.filter((n) => {
      const live = indexer.live.get(n.sessionId);
      return Date.now() - Date.parse(n.ts) < 6 * HOUR && !(live && Number(live.startedAt) > Date.parse(n.ts));
    });
    // Toutes les 60 s : liens des dossiers de comptes réparés (quelques lstat), et relevés d'usage frais pour
    // les comptes qui ne travaillent pas (requête minimale, au plus toutes les 10 min par compte).
    if (Date.now() - lastHealth > 60_000) {
      lastHealth = Date.now();
      healthNotices = accounts.health().notices || [];
      accounts.autoRefresh();
    }
  } catch (e) { console.error('[vigie] comptes :', clean(e)); }
  // État réel des MCP (`claude mcp list`, aucune requête au modèle) : en fond, un relevé à la fois.
  try {
    if (MCP_CHECK && Date.now() >= nextMcpCheck) {
      nextMcpCheck = Date.now() + MCP_CHECK_EVERY_MS;
      if (!mcp.healthState().running) mcp.checkHealth().catch((e) => console.error('[vigie] MCP :', clean(e)));
    }
  } catch (e) { console.error('[vigie] MCP :', clean(e)); }
  finally { ticking = false; }
}

rotateHistory();
setInterval(rotateHistory, HOUR);
server.listen(PORT, HOST, () => {
  console.log(`[vigie] http://${HOST}:${server.address().port}`);
  tick();
  setInterval(tick, 4000);
});
