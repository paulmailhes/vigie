#!/usr/bin/env node
// Vigie — moteur local (http://127.0.0.1:4777), lancé au démarrage par launchd (io.github.paulmailhes.vigie.engine).
// API JSON v2 pour l'app Mac (docs/api-v2.md).
// Aucune dépendance. Le hook ne dépend pas de ce serveur : s'il s'arrête, l'auto-accept continue.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Indexer, actionKind, maskSecrets } from './lib/indexer.mjs';
import { createCodex } from './lib/codex.mjs';
import { createConversations } from './lib/conversations.mjs';
import { createAccounts, MAIN_ID, chosenAccount } from './lib/accounts.mjs';
import { createVault, createKeychain } from './lib/vault.mjs';
import { createMcp, usageFromSessions, toolKey, connectorName, service as mcpService, SERVICE_OTHER, launchCwd, openInTerminal, shq } from './lib/mcp.mjs';
import { createQuestions, reviewEntry } from './lib/questions.mjs';
import { pendingGuards, recentBlocked, decide, MAX_COMMAND, writeAnswer, readDecisions } from './lib/decisions.mjs';
import { ROOT, DATA, AGENTS, HISTORY_FILE, readState, writeState, effective, questionsAuto, questionsMode, DEFAULT_GUARDS, QUESTION_MODES } from './lib/state.mjs';
import { awaitingApprovals, approve } from './lib/approvals.mjs';
import { createUpdater } from './lib/update.mjs';
import { createGateway, GatewayError } from './lib/gateway.mjs';
import { createDesktop, surfaceOf, SURFACES, isScratch } from './lib/desktop.mjs';
import { createAgents, folderConversations } from './lib/agents.mjs';
import { createOpener, runBin, vscodeLink, chooseSurface, launchMessage } from './lib/opener.mjs';
import { rateOf, runawayAlert, RATE_MINUTES, SERIES_WINDOWS, SERIES_POINTS, seriesFrom, seriesPoints, weekRatio } from './lib/usage.mjs';

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
// État réel des MCP (`claude mcp list`) : premier relevé quand le Mac est calme (voir calm), puis toutes les heures.
// Chaque relevé lance un Claude Code par compte et par dossier, qui démarre tous les MCP du compte (Python, npx…) et
// peut renouveler des jetons (2026-10-26 : 21 lancements toutes les 20 min, jusqu'à 520 Mo d'un coup) : en fond, un
// seul à la fois, en priorité basse, et seulement pour les conversations ouvertes et leurs comptes.
const MCP_CHECK = process.env.VIGIE_MCP_CHECK !== '0';
const MCP_CHECK_EVERY_MS = 60 * 60_000, MCP_CHECK_FIRST_MS = 20_000;
// Coffre des connexions (lib/vault.mjs) : passage toutes les 20 s au démarrage, au réveil et tant qu'une connexion
// est à remettre ou inconnue ; toutes les 60 s quand tout est en ordre.
const VAULT_EVERY_MS = 20_000, VAULT_CALM_MS = 60_000;

process.on('unhandledRejection', (e) => console.error('[vigie] promesse rejetée :', clean(e)));

// Données de Vigie lisibles par l'utilisateur seul (commandes, comptes, adresses e-mail) : fichiers créés en 0600,
// dossiers en 0700 ; l'existant remis d'aplomb au démarrage (avant 0.3.4 : data/ en 0755, fichiers en 0644).
process.umask(0o077);
function privatize(dir, depth = 2) {
  let entries;
  try { fs.chmodSync(dir, 0o700); entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try { if (e.isDirectory()) { if (depth > 0) privatize(p, depth - 1); } else if (e.isFile()) fs.chmodSync(p, 0o600); } catch { /* suivant */ }
  }
}
privatize(DATA);

const indexer = new Indexer({ windowHours: Number(process.env.VIGIE_WINDOW_HOURS || 48), usageDays: 7 });
const conv = createConversations(indexer);
// Conversations Codex (OpenAI), lues dans ~/.codex/sessions : même liste, même détail, compte « Codex ».
const codex = createCodex({ dataDir: DATA });
const accounts = createAccounts();
const updater = createUpdater({ root: ROOT, dataDir: DATA });
// Apps de bureau (Claude, ChatGPT/Codex) : titres de l'app Claude, outils installés (lib/desktop.mjs). VIGIE_APPS_DIR :
// un faux /Applications pour les essais.
const desktop = createDesktop({ home: accounts.paths.home, apps: process.env.VIGIE_APPS_DIR || '/Applications' });
// Passerelle MCP : une autorisation par service pour tous les comptes (lib/gateway.mjs). Port lu au moment voulu
// (les tests lancent le moteur sur un port libre).
const gateway = createGateway({ dataDir: DATA, port: () => server.address()?.port || PORT, log: (m) => console.error(`[vigie] ${m}`) });
const HOME = accounts.paths.home;
// Coffre des connexions : copie chiffrée de la connexion de chaque compte, remise si une app la perd (lib/vault.mjs).
// Le vrai trousseau seulement sur le vrai dossier perso (jamais pendant les tests), sinon un faux security
// (VIGIE_SECURITY_BIN) ; VIGIE_NO_VAULT le coupe.
const SECURITY_BIN = (() => {
  if (process.env.VIGIE_NO_VAULT) return null;
  if (process.env.VIGIE_SECURITY_BIN) return process.env.VIGIE_SECURITY_BIN;
  let real = '';
  try { real = os.userInfo().homedir; } catch { real = os.homedir(); }
  return path.resolve(HOME) === path.resolve(real) ? '/usr/bin/security' : null;
})();
const vault = SECURITY_BIN ? createVault({
  dataDir: DATA, home: HOME, codexHome: codex.paths.codexHome, keychain: createKeychain({ bin: SECURITY_BIN }),
  accounts: () => accounts.load().accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir, expectedEmail: a.expectedEmail })),
}) : null;
// Jeton d'accès à l'API (data/api-token, 0600), exigé sur toutes les routes /api/ sauf /api/v2/health. L'app et les
// scripts de Vigie le lisent ; un autre compte du Mac, un conteneur (host.docker.internal) ou une commande lancée par
// une conversation atteignent bien 127.0.0.1, mais n'ont rien sans lui. Sa lecture par une conversation est retenue
// par le garde-fou (règle jeton-vigie). Recréé s'il disparaît.
const TOKEN_FILE = path.join(DATA, 'api-token');
const API_TOKEN = (() => {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(t)) return t; } catch { /* premier démarrage */ }
  return crypto.randomBytes(32).toString('hex');
})();
function keepToken() {
  try { if (fs.readFileSync(TOKEN_FILE, 'utf8').trim() === API_TOKEN) return; } catch { /* absent : on le repose */ }
  try {
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${API_TOKEN}\n`, { mode: 0o600 });
    fs.renameSync(tmp, TOKEN_FILE);
  } catch (e) { console.error('[vigie] jeton d\'accès :', String(e?.message || e)); }
}
keepToken();
const TOKEN_BUF = Buffer.from(API_TOKEN);
const tokenOk = (v) => { const b = Buffer.from(String(v || '')); return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF); };
const QUOTA_FILE = process.env.VIGIE_QUOTA_FILE || null;
const mcp = createMcp({
  home: HOME,
  codeRoot: process.env.VIGIE_CODE_ROOT || path.join(HOME, 'Code'),
  accounts: () => accounts.load().accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir, claudeJsonPath: claudeJsonPath(a) })),
  usage: () => mcpUsage(),
  checkPaths: () => mcpCheckPaths(),
  canCheck: (a) => accounts.connected(a.id),
  openTerminal: (command) => openInTerminal(command, { osascript: OSASCRIPT }),
});
const questions = createQuestions({ dataDir: DATA, sessionsDir: indexer.sessionsDir, projectsDir: indexer.projectsDir });
// Agents : recettes livrées avec Vigie (agents/<id>/AGENT.md, remplacées à chaque mise à jour), lancées dans une
// conversation de VS Code ou de l'app Claude (lib/agents.mjs). Personne n'en ajoute : elles arrivent avec les versions.
const agents = createAgents({ dir: AGENTS, home: HOME });
// Ouvreur : VS Code (le lien part quand la fenêtre du dossier est prête) ou l'app Claude (lib/opener.mjs).
// VIGIE_IDE_WAIT_MS : attente maximale de la fenêtre (25 s ; plus courte dans les essais).
const IDE_WAIT_MS = Number(process.env.VIGIE_IDE_WAIT_MS);
const opener = createOpener({ home: HOME, openBin: OPEN_BIN, timing: Number.isFinite(IDE_WAIT_MS) && IDE_WAIT_MS >= 0 ? { max: IDE_WAIT_MS } : {} });

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
const ui = () => { const u = readJson(UI_FILE, null); return isObj(u) ? u : {}; };
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
  // Décision ou réponse déjà donnée dans Vigie, que le hook n'a pas encore lue : l'attente n'est plus montrée
  // (sinon elle réapparaît le temps qu'il la prenne, et on croit que le clic n'a pas marché).
  const decided = new Set(Object.keys(readDecisions()));
  const open = new Map();
  for (const h of history) {
    if (!h.sessionId) continue;
    const k = `${h.sessionId}\u0000${h.action}`;
    // « toujours me demander » : la question attend aussi, et peut se répondre depuis Vigie (choix notés)
    if (WAIT_EVENTS.has(h.event) || (h.event === 'question-pour-toi' && Array.isArray(h.questions))) open.set(k, h);
    else if (CLOSES_WAIT.test(String(h.event || ''))) open.delete(k);
  }
  const bySession = new Map();
  const add = (sid, w) => bySession.set(sid, [...(bySession.get(sid) || []), w]);
  const openGuards = new Set();
  for (const h of open.values()) {
    if (h.event === 'garde-fou-attente') { openGuards.add(`${h.sessionId}\u0000${h.ts}`); continue; }
    if (!indexer.live.has(h.sessionId)) continue;
    // « toujours me demander » : pas d'échéance, la question attend tant que la fenêtre est ouverte
    const ask = h.event === 'question-pour-toi';
    const m = h.minutes === null || h.minutes === undefined || h.minutes === '' ? NaN : Number(h.minutes);
    const minutes = Number.isFinite(m) ? m : state.questionWaitMin;
    const deadline = ask ? Infinity : Date.parse(h.ts) + minutes * 60_000;
    if (!(deadline + 2 * 60_000 > now) || !pidAlive(h.pid)) continue;
    if (ask && !Array.isArray(h.questions)) continue; // ancienne ligne, ou hook qui n'attend pas
    if (decided.has(String(h.pid))) continue;
    add(h.sessionId, { ...h, question: true, deadline, ask });
  }
  let guards = [];
  try { guards = pendingGuards({ history, state, now }); } catch (e) { console.error('[vigie] attentes des garde-fous :', clean(e)); }
  for (const g of guards) {
    if (!g.sessionId || !indexer.live.has(g.sessionId) || !openGuards.has(`${g.sessionId}\u0000${g.ts}`)) continue;
    if (decided.has(String(g.pendingId))) continue;
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
  const tier = typeof j?.oauthAccount?.organizationRateLimitTier === 'string' ? j.oauthAccount.organizationRateLimitTier : null;
  orgCache.set(p, { key, org, tier });
  return org;
}
// Abonnement du compte (ex. default_claude_max_20x) : deux comptes du même abonnement consomment au même rythme.
function tierOf(acc) { orgOf(acc); return orgCache.get(claudeJsonPath(acc))?.tier ?? null; }
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

// Part de la semaine prise par un usage : poids d'usage × ratio (points de % de la semaine par unité de poids).
// Le pourcentage d'un compte compte TOUT son usage, même ailleurs (autre Mac, collègue sur un compte partagé) :
// « pct / poids vu ici » n'est qu'un plafond (un compte entamé à 46 % ailleurs donnait « 202 %/h »). Le ratio
// vient donc, dans l'ordre : de la hausse mesurée du compte sur les dernières 24 h (relevés gardés dans
// data/usage/semaine.json) ; sinon du plus petit plafond des comptes du même abonnement (même rythme).
const WEEK_LOG = path.join(DATA, 'usage', 'semaine.json');
let weekLog = null, weekLogSaved = 0;
const sameWeek = (a, b) => Math.round(Date.parse(a) / 60_000) === Math.round(Date.parse(b) / 60_000);
function noteWeek(accountId, w, observedAt, now) {
  weekLog ??= readJson(WEEK_LOG, {}) || {};
  const t = observedAt && Date.parse(observedAt) <= now ? observedAt : new Date(now).toISOString();
  let list = Array.isArray(weekLog[accountId]) ? weekLog[accountId] : [];
  const last = list.at(-1);
  if (last && last.pct === w.pct && sameWeek(last.resetsAt, w.resetsAt)) return;
  if (last && Date.parse(t) <= Date.parse(last.t)) return;
  list = [...list.filter((o) => now - Date.parse(o.t) <= 8 * DAY), { t, pct: w.pct, resetsAt: w.resetsAt }].slice(-500);
  weekLog[accountId] = list;
  if (now - weekLogSaved < 30_000) return;
  weekLogSaved = now;
  try { fs.mkdirSync(path.dirname(WEEK_LOG), { recursive: true }); fs.writeFileSync(WEEK_LOG, JSON.stringify(weekLog) + '\n'); } catch { /* relevé suivant */ }
}
// Hausse d'au moins 3 points depuis le plus ancien relevé de cette semaine des dernières 24 h, rapportée au poids
// vu ici depuis ce relevé (minute par minute). null tant qu'il n'y a pas de quoi mesurer.
function measuredRatio(accountId, w, org, now) {
  const first = (weekLog?.[accountId] || []).find((o) => sameWeek(o.resetsAt, w.resetsAt) && now - Date.parse(o.t) <= DAY);
  if (!first || w.pct - first.pct < 3) return null;
  const from = Math.floor(Date.parse(first.t) / 60_000) * 60_000;
  const b = indexer.usageBucketsByOrg(from, 1, Math.max(1, Math.ceil((now - from) / 60_000))).get(org);
  const used = b ? b.w.reduce((s, x) => s + x, 0) : 0;
  return used > 0 ? (w.pct - first.pct) / used : null;
}
function weekBase(ctx, accountId) {
  ctx.weekBase ??= new Map();
  if (ctx.weekBase.has(accountId)) return ctx.weekBase.get(accountId);
  let info = null;
  const sum = ctx.accSums.find((a) => a.id === accountId);
  const acc = ctx.model.accounts.find((a) => a.id === accountId);
  const w = sum?.usage?.week;
  const reset = Date.parse(w?.resetsAt || '');
  const org = acc ? orgOf(acc) : null;
  if (org && typeof w?.pct === 'number' && Number.isFinite(w.pct) && Number.isFinite(reset)) {
    noteWeek(accountId, w, sum.usage.observedAt, ctx.now);
    const start = new Date(reset - WEEK).toISOString();
    const den = conv.usageTotals(start).byOrg[org] || 0;
    if (den > 0) info = { org, start, pct: w.pct, den, tier: tierOf(acc), upper: w.pct / den, measured: measuredRatio(accountId, w, org, ctx.now) };
  }
  ctx.weekBase.set(accountId, info);
  return info;
}
function weekInfo(ctx, accountId) {
  if (ctx.week.has(accountId)) return ctx.week.get(accountId);
  const base = weekBase(ctx, accountId);
  let info = null;
  if (base) {
    const peers = base.measured === null ? ctx.model.accounts.filter((a) => a.id !== accountId).map((a) => weekBase(ctx, a.id)) : [];
    info = { ...base, ratio: weekRatio(base, peers) };
  }
  ctx.week.set(accountId, info);
  return info;
}
function weekPct(ctx, id, accountId) {
  const w = weekInfo(ctx, accountId);
  if (!w) return null;
  return Math.round(conv.usageWeight(id, w.start, w.org) * w.ratio * 10) / 10;
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
    const accountId = chosenAccount(ctx.model, s.id);
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

// Dossiers où relever l'état réel des MCP : ceux des conversations ouvertes, les plus récentes d'abord, chacun avec
// les comptes de ses conversations (lib/mcp.mjs n'en garde que ceux qui ont des MCP propres, 12 au plus). Une
// conversation fermée n'a pas besoin d'un relevé : elle relira ses MCP en rouvrant.
function mcpCheckPaths() {
  const out = new Map();
  const model = accounts.load();
  const live = [...indexer.live.values()].sort((a, b) => Number(b.updatedAt || b.startedAt || 0) - Number(a.updatedAt || a.startedAt || 0));
  for (const v of live) {
    const p = launchDirOf(v.sessionId);
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    if (!out.has(p)) out.set(p, new Set());
    out.get(p).add(chosenAccount(model, v.sessionId));
  }
  return [...out].map(([p, ids]) => ({ path: p, accounts: [...ids] }));
}

// ---------- vues v2 ----------
function context() {
  const state = readState();
  const now = Date.now();
  const u = ui();
  // « Depuis une heure » : fenêtre glissante (à la minute, pour les caches), plus de « J'ai tout vu » à cliquer.
  // Ce qui a mal tourné (refus, échecs, limites) reste 24 h, ou jusqu'à ce que l'utilisateur le retire.
  const lastSeen = new Date(Math.floor((now - HOUR) / 60_000) * 60_000).toISOString();
  return { state, now, lastSeen, reviewSince: new Date(now - DAY).toISOString(), dismissed: dismissedOf(u), wrapperActive: accounts.wrapperActive(),
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
    autoUpdate: state.autoUpdate,
    guard: {
      enabled: state.guard.enabled,
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
const BLOCKED_WHY = { delai: 'Refusée faute de réponse', jamais: 'Refusée d\'office (réglage : toujours refuser)', 'sous-agent': 'Refusée : un agent ne peut pas demander une action sensible', echec: 'Autorisée, mais elle a échoué' };

// ---------- connexions des comptes (coffre, lib/vault.mjs) ----------
const hhmm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
// « À regarder » : un compte à reconnecter (sa connexion a disparu sans copie à remettre, ou Anthropic l'a refusée,
// ou la remise traîne), le compte du Mac déconnecté (VS Code dit « déconnecté » partout sans lui), une conversation
// ouverte partie sur un autre compte parce que le sien ne marchait pas.
function connectionItems(ctx, title) {
  const out = [];
  const label = (id) => ctx.accSums.find((a) => a.id === id)?.label || id;
  const fix = 'Dans Comptes, « Connecter » ouvre la page de connexion sur ce compte.';
  for (const a of ctx.accSums) {
    const st = a.login?.state;
    const main = a.id === MAIN_ID;
    const since = a.login?.since || new Date(ctx.now).toISOString();
    const why = st === 'dead' ? 'Anthropic a refusé sa connexion'
      : st === 'lost' ? 'Sa connexion a disparu et Vigie n\'avait pas de quoi la remettre'
      : st === 'restoring' && ctx.now - Date.parse(since) > 2 * 60_000 ? 'Sa connexion a disparu et Vigie n\'arrive pas à la remettre'
      : st === 'logged-out' && main ? 'Il n\'est pas connecté' : null;
    if (!why) continue;
    out.push({ id: `cx:${a.id}:${st}`, kind: 'waiting', conversationId: null, conversationTitle: a.label,
      title: `${a.label} : à reconnecter`,
      detail: `${why}. ${main ? 'C\'est le compte que VS Code utilise de base : sans lui, VS Code affiche « déconnecté » dans toutes ses fenêtres.' : 'Ses conversations partent sur un autre compte en attendant.'} ${fix}`,
      ts: since });
  }
  let falls = [];
  try { falls = accounts.fallbacks(indexer.live); } catch { /* journal du lanceur illisible */ }
  for (const f of falls) {
    out.push({ id: `cf:${f.sessionId}:${f.running}`, kind: 'waiting', conversationId: f.sessionId, conversationTitle: title(f.sessionId),
      title: `Lancée sur ${label(f.running)} au lieu de ${label(f.wanted)}`,
      detail: `${label(f.wanted)} ${f.why === 'non-connecte' ? 'n\'était pas connecté' : 'ne pouvait pas servir'} quand elle a démarré. Elle reprendra sur ${label(f.wanted)} quand il sera reconnecté (au prochain démarrage de la conversation).`,
      ts: new Date(Number(indexer.live.get(f.sessionId)?.startedAt) || ctx.now).toISOString() });
  }
  return out;
}
// Connexions remises par le coffre dans l'heure : un mot dans la vue d'ensemble.
function connectionNotices(sums) {
  const out = [];
  const recent = (iso) => typeof iso === 'string' && Date.now() - Date.parse(iso) < HOUR;
  for (const a of sums) {
    if (recent(a.login?.restoredAt)) out.push(`Connexion de ${a.label} remise par Vigie à ${hhmm(a.login.restoredAt)} : elle avait disparu sans que tu te déconnectes.`);
  }
  const cx = vault?.status()?.codex;
  if (recent(cx?.restoredAt)) out.push(`Connexion de Codex remise par Vigie à ${hhmm(cx.restoredAt)} : son fichier de connexion était abîmé.`);
  return out;
}

// « À regarder » : ce qui attend l'utilisateur maintenant d'abord, puis ce qui a mal tourné ces dernières 24 h.
// Chaque garde-fou porte de quoi décider ou refaire l'action : state, pendingId, expiresAt, rule, command
// (masquée, 4000 caractères au plus), byAgent, cwd, needsPassword.
function reviewItems(ctx, sums) {
  const titles = new Map(sums.map((s) => [s.id, s.title]));
  const title = (sid) => titles.get(sid) ?? null;
  // « dans VS Code », « dans l'app Claude »… selon l'outil de la conversation
  const surfaces = new Map(sums.map((s) => [s.id, surfaceOf(s)]));
  const where = (sid) => SURFACES[surfaces.get(sid) || 'vscode'];
  const live = [], past = [];
  for (const [sid, list] of ctx.waits) {
    for (const w of list) {
      const left = minutesLeft(w.deadline, ctx.now);
      const when = left > 0 ? `dans ${left} min` : 'dans un instant';
      if (w.question) {
        const answerable = Array.isArray(w.questions) && w.questions.length && w.pid;
        live.push({ id: `w:${sid}:${w.ts}`, kind: 'waiting', conversationId: sid, conversationTitle: title(sid),
          title: short(w.tool === 'ExitPlanMode' ? 'Plan à valider' : questionText(w.action) || 'Question de Claude', 120),
          detail: w.ask ? (answerable ? `Réponds ici ou dans ${where(sid)}.` : `Réponds dans ${where(sid)}.`)
            : `Réponds ${answerable ? 'ici ou ' : ''}dans ${where(sid)}, sinon Vigie choisit l'option recommandée ${when}.`,
          ...(answerable ? { pendingId: String(w.pid), questions: w.questions } : {}), ts: w.ts });
      } else {
        live.push({ id: `g:${sid}:${w.ts}`, kind: 'blocked', state: 'waiting', pendingId: w.pendingId, expiresAt: w.expiresAt,
          conversationId: sid, conversationTitle: title(sid), cwd: w.cwd ?? null,
          rule: w.rule || 'Action sensible', ruleId: w.ruleId ?? null, command: mask(w.command).slice(0, MAX_COMMAND),
          byAgent: agentName(sid, w.agentId), needsPassword: !!w.needsPassword,
          title: short(w.rule || 'Action sensible', 120), detail: `${what(w)} · décide ici ou dans ${where(sid)}, sinon refusée ${when}.`, ts: w.ts });
      }
    }
  }
  for (const s of sums) {
    if (s.status !== 'waiting' || ctx.waits.has(s.id)) continue;
    live.push({ id: `c:${s.id}`, kind: 'waiting', conversationId: s.id, conversationTitle: s.title,
      title: `Attend ta réponse dans ${where(s.id)}`, detail: s.headline || null, ts: s.lastActivity || new Date(ctx.now).toISOString() });
  }
  // Codex : actions sensibles retenues dans Vigie (lib/approvals.mjs), à autoriser ici (une fois, pour l'appel exact).
  let awaiting = [];
  try { awaiting = awaitingApprovals({ history, now: ctx.now }); } catch (e) { console.error('[vigie] autorisations :', clean(e)); }
  for (const a of awaiting) {
    if (a.sessionId && conv.isThrowaway(a.sessionId) && !indexer.live.has(a.sessionId)) continue;
    if (a.approved) continue; // autorisée : plus rien à décider
    live.push({ id: `v:${a.approvalId}`, kind: 'blocked', state: 'awaiting', approvalId: a.approvalId,
      approved: a.approved, approvedUntil: a.approvedUntil, holding: a.holding,
      conversationId: a.sessionId, conversationTitle: title(a.sessionId), cwd: a.cwd,
      rule: a.rule || 'Action sensible', ruleId: a.ruleId, command: mask(a.command).slice(0, MAX_COMMAND),
      byAgent: agentName(a.sessionId, a.agentId), needsPassword: a.needsPassword,
      title: short(a.rule || 'Action sensible', 120),
      detail: a.holding ? `${what(a)} · en pause, elle attend ton accord ici (rien ne s'affiche dans VS Code)`
        : a.approved ? `${what(a)} · autorisée : elle peut la relancer à l'identique.`
        : `${what(a)} · elle a continué sans cette action : autorise-la ici, elle pourra la relancer.`,
      ts: a.ts });
  }
  const cx = safeCodex(() => codex.account(), null);
  if (cx?.connected && cx.hook?.installed && !cx.hook.trusted) {
    live.push({ id: 'codex-hook', kind: 'waiting', conversationId: null, conversationTitle: 'Codex',
      title: 'Codex : accepte le module de Vigie',
      detail: 'Sans lui, Vigie ne peut rien accepter pour Codex. Dans Codex (panneau de VS Code ou app ChatGPT) : « Review hooks », puis accepte les deux lignes « Vigie ».',
      ts: new Date(ctx.now).toISOString() });
  }
  for (const n of switchNotices) {
    live.push({ id: `s:${n.sessionId}:${n.ts}`, kind: 'waiting', conversationId: n.sessionId, conversationTitle: title(n.sessionId),
      title: 'Compte changé', detail: n.message, ts: n.ts });
  }
  for (const item of connectionItems(ctx, title)) live.push(item);
  for (const r of questions.toReview()) if (!conv.isThrowaway(r.sessionId)) past.push(reviewEntry(r, title(r.sessionId)));
  // Refusées ou ratées ces dernières 24 h, à faire soi-même (un refus de l'utilisateur depuis l'app n'en est pas une).
  for (const b of recentBlocked({ history, since: ctx.reviewSince, limit: MAX_REVIEW })) {
    if (b.by === 'you' || (b.sessionId && conv.isThrowaway(b.sessionId))) continue;
    past.push({ id: `b:${b.sessionId}:${b.ts}`, kind: 'blocked', state: 'blocked', reason: b.by,
      conversationId: b.sessionId ?? null, conversationTitle: title(b.sessionId), cwd: b.cwd ?? null,
      rule: b.rule || 'Action sensible', ruleId: b.ruleId ?? null, command: mask(b.command).slice(0, MAX_COMMAND),
      byAgent: agentName(b.sessionId, b.agentId), needsPassword: !!b.needsPassword,
      title: short(b.rule || 'Action sensible', 120),
      detail: b.by === 'echec'
        ? `${BLOCKED_WHY.echec} : ${what(b)}${b.extrait ? ` · « ${short(mask(b.extrait.replace(/^Exit code \d+\n?/, '')), 160)} »` : ''}.`
        : `${BLOCKED_WHY[b.by] || 'Refusée'} : ${what(b)}. À faire toi-même.`, ts: b.ts });
  }
  // Limite atteinte ces dernières 24 h, tant qu'elle n'est pas remise à zéro.
  // (conversations ouvertes seulement : une conversation fermée n'attend rien, la carte du compte dit déjà la limite)
  for (const s of indexer.sessions.values()) {
    if (conv.isThrowaway(s.id) || !indexer.live.has(s.id)) continue;
    const l = s.limits.reduce((m, x) => (x.ts >= ctx.reviewSince && (!m || x.ts > m.ts) ? x : m), null);
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
// depuis une heure. Un seul passage sur l'historique, mis en cache tant qu'il ne change pas.
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
  const accountId = chosenAccount(ctx.model, sum.id); // sans choix noté : le compte des nouvelles conversations, comme le lanceur
  const waits = ctx.waits.get(sum.id) || [];
  let status = sum.status;
  if (sum.running && waits.some((w) => !w.question)) status = 'blocked';
  else if (sum.running && waits.length) status = 'waiting';
  // arrêtée pour changer de compte : elle attend un message de l'utilisateur dans VS Code pour repartir sur le nouveau compte
  const stopped = !sum.running ? accounts.stoppedFor(sum.id, ctx.model) : null;
  if (stopped) status = 'waiting';
  const tests = sum.tests ? { ...sum.tests } : null;
  if (tests?.failedRecent > 0) tests.failures = cardFailures(sum.id, ctx.now);
  const surface = surfaceOf(sum);
  const fromApp = surface === 'claude-app' ? desktop.claudeSessions().get(sum.id) : null;
  const out = {
    id: sum.id,
    title: fromApp?.title || sum.title,
    project: isScratch(sum.cwd) ? 'App Claude' : sum.project,
    cwd: sum.cwd,
    surface,
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
  const codexSums = safeCodex(() => codex.summaries(), []);
  const review = reviewItems(ctx, [...sums, ...codexSums]);
  const needs = countBy(review);
  const accepted = acceptedCounts(ctx);
  const counts = conv.sinceCounts(ctx.lastSeen);
  const ev = eventCounts(ctx.lastSeen);
  // Rapports : les dernières 24 h.
  const dayAgo = new Date(ctx.now - DAY).toISOString();
  return {
    now: new Date(ctx.now).toISOString(),
    settings: settingsView(ctx.state),
    since: ctx.lastSeen,
    sinceSummary: {
      accepted: ev['auto-accepte'] || 0,
      questionsAuto: ev['question-auto'] || 0,
      // comment chaque action s'est terminée (le début d'une attente n'est pas un blocage)
      blocked: (ev['garde-fou-bloque'] || 0) + (ev['garde-fou-delai-vigie'] || 0),
      refused: (ev['garde-fou-refuse-app'] || 0) + (ev['garde-fou-refuse-vigie'] || 0),
      failed: ev['garde-fou-echec'] || 0,
      reports: counts.reports,
      testsFailed: counts.testsFailed,
      limits: counts.limits,
    },
    toReview: review,
    reports: conv.reports(ctx.lastSeen < dayAgo ? ctx.lastSeen : dayAgo).slice(0, MAX_REPORTS),
    accounts: withCodexAccount(ctx.accSums),
    conversations: [...sums.map((s) => decorate(s, ctx, needs, accepted)), ...codexSums.map((s) => decorateCodex(s, ctx, needs, accepted))],
    recentAccepted: recentAccepted(ctx, sums),
    engine: { indexing: !indexer.progress.done, wrapperActive: ctx.wrapperActive, notices: [...healthNotices, ...connectionNotices(ctx.accSums)] },
    update: updater.status(),
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

// ---------- historique : toutes les demandes, avec leur issue ----------
// GET /api/v2/history?window=60|1440|10080&status=…&conversation=…&q=… : une ligne par issue (le début d'une attente
// n'en est pas une, sauf si elle attend encore), la plus récente d'abord, et le nombre de lignes par statut.
// status : accepted (autorisée, par Vigie ou par toi) · refused (par toi, ou par le mode auto de Claude) · blocked
// (personne n'a répondu à temps, ou jamais validée à ta place) · failed (autorisée mais en échec) · question ·
// vscode (laissée à ta fenêtre VS Code) · waiting (attend encore).
const HISTORY_WINDOWS = new Set([60, 1440, 10080]);
const HISTORY_STATUS = {
  'auto-accepte': 'accepted', 'garde-fou-autorise-app': 'accepted', 'garde-fou-autorise-vigie': 'accepted',
  'garde-fou-tu-as-repondu': 'vscode', 'demande-pour-toi': 'vscode', 'garde-fou-pour-toi': 'vscode', 'refus-classifieur-pour-toi': 'vscode',
  'garde-fou-rendu': 'vscode', 'reponse-perdue': 'vscode',
  'garde-fou-refuse-app': 'refused', 'garde-fou-refuse-vigie': 'refused', 'refuse-mode-auto': 'refused',
  'garde-fou-bloque': 'blocked', 'garde-fou-delai-vigie': 'blocked',
  'garde-fou-echec': 'failed',
  'question-auto': 'question', 'question-repondue-app': 'question', 'question-tu-as-repondu': 'question', 'question-rendue': 'question', 'question-pour-toi': 'question',
  'garde-fou-attente': 'waiting', 'garde-fou-en-attente-vigie': 'waiting', 'question-attente': 'waiting',
};
function historyReason(h) {
  const rule = h.rule ? ` (garde-fou : « ${h.rule} »)` : '';
  switch (h.event) {
    case 'auto-accepte': return 'Acceptée automatiquement par Vigie';
    case 'garde-fou-autorise-app': case 'garde-fou-autorise-vigie': return `Autorisée par toi dans Vigie${rule}`;
    case 'garde-fou-tu-as-repondu': return `Décidée par toi dans VS Code${rule}${h.resultat ? ` · ${h.resultat}` : ''}`;
    case 'demande-pour-toi': case 'garde-fou-pour-toi': case 'garde-fou-rendu': return `Laissée à toi dans VS Code${rule}`;
    case 'refus-classifieur-pour-toi': return 'Laissée à toi dans VS Code (le mode automatique de Claude a refusé plusieurs fois)';
    case 'reponse-perdue': return 'Réponse de Vigie arrivée trop tard : décidée dans VS Code';
    case 'garde-fou-refuse-app': case 'garde-fou-refuse-vigie': return `Refusée par toi dans Vigie${rule}`;
    case 'refuse-mode-auto': return `Refusée par le mode automatique de Claude${h.reason ? ` : ${short(String(h.reason), 200)}` : ''}`;
    case 'garde-fou-bloque': case 'garde-fou-delai-vigie': return `${BLOCKED_WHY[h.raison] || BLOCKED_WHY.delai}${rule}`;
    case 'garde-fou-echec': return `Autorisée, mais elle a échoué${h.extrait ? ` : « ${short(mask(String(h.extrait).replace(/^Exit code \d+\n?/, '')), 200)} »` : ''}`;
    case 'question-auto': return 'Réponse choisie à ta place (option recommandée)';
    case 'question-repondue-app': return 'Répondue par toi dans Vigie';
    case 'question-tu-as-repondu': return 'Répondue par toi dans VS Code';
    default: return WAIT_EVENTS.has(h.event) || h.event === 'garde-fou-en-attente-vigie' ? `Attend ta décision${rule}` : null;
  }
}
function historyView(url) {
  const win = Number(url.searchParams.get('window') ?? 1440);
  if (!HISTORY_WINDOWS.has(win)) return bad('Période : 60, 1440 ou 10080 min.');
  const status = url.searchParams.get('status') || null;
  const only = url.searchParams.get('conversation') || null;
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 200);
  const ctx = { now: Date.now() };
  const since = new Date(ctx.now - win * 60_000).toISOString();
  const sums = new Map([...conv.summaries(), ...safeCodex(() => codex.summaries(), [])].map((s) => [s.id, s]));
  let open = new Set();
  try { open = new Set([...pendingWaits(readState(), ctx.now).values()].flat().map((w) => `${w.sessionId}\u0000${w.ts}`)); } catch { /* aucune attente */ }
  try { for (const a of awaitingApprovals({ history, now: ctx.now })) if (!a.approved) open.add(`${a.sessionId}\u0000${a.ts}`); } catch { /* aucune */ }
  const counts = {};
  const items = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h?.ts || String(h.ts) < since) break;
    let st = HISTORY_STATUS[h.event];
    if (!st) continue;
    const sid = typeof h.sessionId === 'string' ? h.sessionId : null;
    // un début d'attente : seulement s'il attend encore (sinon sa fin est déjà dans la liste)
    if (st === 'waiting' && !open.has(`${sid}\u0000${h.ts}`)) continue;
    if (st === 'question' && h.event === 'question-pour-toi') continue;
    if (sid && conv.isThrowaway(sid)) continue;
    if (only && sid !== only) continue;
    const s = sid ? sums.get(sid) : null;
    const item = {
      id: `${h.ts}|${h.pid ?? ''}|${h.event}`, ts: h.ts, status: st, event: h.event,
      app: h.app === 'codex' || s?.agent === 'codex' ? 'codex' : 'claude',
      tool: h.tool ?? null, title: acceptedTitle(h), command: mask(String(h.action ?? '')).slice(0, MAX_COMMAND),
      rule: h.rule ?? null, ruleId: h.ruleId ?? null, reason: historyReason(h),
      conversationId: sid, conversationTitle: s?.title ?? indexer.sessions.get(sid)?.title ?? null,
      project: s?.project ?? (h.cwd ? path.basename(String(h.cwd)) : null), cwd: h.cwd ?? null,
      agent: sid ? agentName(sid, h.agentId) : null,
      needsPassword: h.ruleId === 'sudo' || /\bsudo\b/.test(String(h.action ?? '')),
    };
    if (q && ![item.title, item.command, item.reason, item.conversationTitle, item.project].some((x) => String(x ?? '').toLowerCase().includes(q))) continue;
    counts[st] = (counts[st] || 0) + 1;
    if ((!status || status === st) && items.length < 1000) items.push(item);
  }
  return [200, { window: win, since, counts, items }];
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

// Codex : ses erreurs de lecture ne doivent jamais faire tomber la vue d'ensemble.
function safeCodex(fn, fallback) {
  try { return fn(); } catch (e) { console.error('[vigie] Codex :', e?.message || e); return fallback; }
}
const withCodexAccount = (list) => { const a = safeCodex(() => codex.account(), null); return a ? [...list, a] : list; };

// Une conversation Codex, au format des conversations Claude (compte « codex », pas de bascule ni de connecteurs).
function decorateCodex(sum, ctx, needs, accepted) {
  const eff = effective(ctx.state, sum.id);
  const ov = Object.hasOwn(ctx.state.sessions, sum.id) ? ctx.state.sessions[sum.id] : null;
  const waits = ctx.waits.get(sum.id) || [];
  return {
    id: sum.id, agent: 'codex', title: sum.title, project: sum.project, cwd: sum.cwd, surface: surfaceOf(sum),
    status: sum.running && waits.length ? 'blocked' : sum.status, running: sum.running,
    accountId: 'codex', account: null,
    autoAccept: eff.autoAccept, autoAcceptOverride: typeof ov?.autoAccept === 'boolean' ? ov.autoAccept : null,
    connectors: null, agentsRunning: sum.agentsRunning || 0, workflowsRunning: 0, weekPct: null,
    rate: sum.rate, alert: null, lastActivity: sum.lastActivity, needsYou: needs.get(sum.id) || 0,
    headline: sum.headline, contextTokens: null, pendingAccountId: null,
    progress: sum.progress ?? null, tests: null, accepted: accepted.get(sum.id) || { today: 0, sinceSeen: 0 }, artifacts: null,
    startedAt: sum.startedAt,
  };
}

function conversationV2(id) {
  if (safeCodex(() => codex.has(id), false)) {
    const d = codex.detail(id);
    const ctx = context();
    const needs = countBy(reviewItems(ctx, [d.summary]));
    return { ...d, summary: decorateCodex(d.summary, ctx, needs, acceptedCounts(ctx)), accepted: acceptedFor(id, ctx) };
  }
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
  if ('autoUpdate' in body) { if (typeof body.autoUpdate !== 'boolean') return bad('Mises à jour automatiques : oui ou non.'); s.autoUpdate = body.autoUpdate; }
  if ('tools' in body) {
    const t = body.tools;
    const keys = ['claudeVSCode', 'claudeApp', 'codexVSCode', 'codexApp'];
    if (!isObj(t) || !keys.every((k) => typeof t[k] === 'boolean')) return bad('Outils illisibles.');
    s.tools = Object.fromEntries(keys.map((k) => [k, t[k]]));
    if (s.tools.claudeVSCode) setImmediate(ensureWrapper);
  }
  if ('guard' in body) {
    const g = body.guard;
    if (!isObj(g)) return bad('Garde-fous illisibles.');
    if ('enabled' in g) { if (typeof g.enabled !== 'boolean') return bad('Garde-fous : oui ou non.'); s.guard.enabled = g.enabled; }
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
  if (!UUID.test(id)) return bad('Cette conversation n\'existe plus.', 404);
  const keys = ['autoAccept', 'accountId', 'connectors'].filter((k) => k in body);
  if (!keys.length) return bad('Rien à régler.');
  if ('autoAccept' in body && body.autoAccept !== null && typeof body.autoAccept !== 'boolean') return bad('Auto-accept : oui, non ou par défaut.');
  if ('connectors' in body && ![null, 'on', 'off'].includes(body.connectors)) return bad('Connecteurs : on, off ou par défaut.');
  if ('accountId' in body && typeof body.accountId !== 'string') return bad('Compte inconnu.');
  if ('accountId' in body && safeCodex(() => codex.has(id), false)) return bad('Une conversation Codex utilise ton compte ChatGPT : pas de changement de compte.');
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
  // Réponse à une question en attente : { answers: { "<question>": "<choix>" } }
  if (body && typeof body.answers === 'object' && body.answers !== null) {
    const ctx = context();
    const w = [...ctx.waits.values()].flat().find((x) => x.question && String(x.pid) === id && Array.isArray(x.questions));
    if (!w) return bad('Cette question n\'attend plus de réponse.', 404);
    if (!writeAnswer(id, body.answers, { sessionId: w.sessionId })) return bad('Réponse non envoyée : réessaie.');
    return [200, { ok: true, pendingId: id, message: 'Réponse envoyée à Claude.' }];
  }
  const r = decide(id, body.decision, { history, state: readState() });
  return r.ok ? [200, { ok: true, pendingId: r.pendingId, decision: r.decision, message: r.message }] : bad(r.error || 'Ça n\'a pas marché : réessaie dans un instant.', r.status || 400);
}

// POST /api/v2/approvals { approvalId, decision?: 'deny' } (actions Codex retenues dans Vigie, lib/approvals.mjs).
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
  if (!r.ok) return bad(r.error || 'Ça n\'a pas marché : réessaie dans un instant.', r.status || 400);
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
  try { id = decodeURIComponent(raw); } catch { return bad('Cet élément n\'existe plus.', 404); }
  if (!REVIEW_ID.test(id)) return bad('Cet élément n\'existe plus.', 404);
  if (id.startsWith('q:')) { const r = questions.review(id, { action: 'ok' }); if (!r.ok && r.status !== 404) return bad(r.error || 'Ça n\'a pas marché : réessaie dans un instant.', r.status || 400); }
  const u = ui();
  const now = Date.now();
  const kept = Object.entries(dismissedOf(u)).filter(([, at]) => now - Date.parse(at) < DISMISS_KEEP_MS);
  kept.push([id, new Date(now).toISOString()]);
  writeJson(UI_FILE, { ...u, dismissed: Object.fromEntries(kept.slice(-DISMISS_MAX)) });
  return [200, { ok: true, id }];
}

// runBin (lib/opener.mjs) lance un programme du Mac sans shell.

// { kind: "conversation", id } : VS Code s'ouvre sur le dossier de la conversation, puis, quand sa fenêtre est prête,
// sur la conversation elle-même (lien de l'extension Claude Code : rien n'est envoyé, la saisie reste vide). Fenêtre
// pas prête à temps : le lien ne part pas (il ouvrirait la conversation dans la fenêtre d'un autre projet).
// L'app de bureau qui porte la conversation : pas de lien vers une conversation précise (non documenté), l'app
// s'ouvre et la conversation est dans sa liste.
async function openApp(bundleId, name, message) {
  const r = await runBin(OPEN_BIN, ['-b', bundleId]);
  if (!r.ok && !(await runBin(OPEN_BIN, ['-a', name])).ok) return bad(`${name} ne s'est pas ouverte.`);
  return [200, { ok: true, message }];
}
async function openConversation(id) {
  if (typeof id !== 'string' || !UUID.test(id)) return bad('Cette conversation n\'existe plus.', 404);
  const cx = safeCodex(() => codex.summaries(), []).find((s) => s.id === id);
  if (cx) {
    const surface = surfaceOf(cx);
    if (surface === 'codex-app') return openApp('com.openai.codex', 'ChatGPT', `L'app ChatGPT est ouverte : « ${short(cx.title, 60)} » est dans Codex.`);
    if (!cx.cwd || !isDir(cx.cwd)) return bad('Le dossier de cette conversation n\'existe plus.', 404);
    if (!(await runBin(OPEN_BIN, ['-a', 'Visual Studio Code', cx.cwd])).ok) return bad('VS Code ne s\'est pas ouvert.');
    return [200, { ok: true, message: `VS Code est ouvert sur ${path.basename(cx.cwd)} : la conversation est dans le panneau Codex.` }];
  }
  const s = indexer.sessions.get(id);
  if (surfaceOf({ entrypoint: indexer.live.get(id)?.entrypoint || s?.entrypoint }) === 'claude-app') {
    const t = desktop.claudeSessions().get(id)?.title || s?.title;
    return openApp('com.anthropic.claudefordesktop', 'Claude', `L'app Claude est ouverte${t ? ` : « ${short(t, 60)} » est dans Code` : ''}.`);
  }
  const dir = launchDirOf(id);
  if (!dir) return bad('Conversation introuvable : elle date sans doute de plus de 7 jours.', 404);
  if (!isDir(dir)) return bad('Le dossier de cette conversation n\'existe plus.', 404);
  const openUrl = vscodeLink({ session: id });
  const opened = await opener.vscode(dir, openUrl);
  if (opened === 'none') return bad('VS Code ne s\'est pas ouvert : vérifie qu\'il est installé, puis réessaie.');
  if (opened === 'folder') {
    return [200, { ok: true, opened, openUrl: null,
      message: `VS Code est ouvert sur ${path.basename(dir)}, mais Claude Code n'a pas répondu à temps : ouvre la conversation depuis son panneau.` }];
  }
  return [200, { ok: true, opened, message: `Conversation ouverte dans VS Code (${path.basename(dir)}).`, openUrl }];
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
  if (!found) return bad('Commande vide : rien à lancer.');
  if (found.masked) return bad('Commande introuvable (elle contenait une clé masquée) : relance-la depuis la conversation.');
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
  if (mask(command) !== command) return bad('Cette commande contient une clé secrète : Vigie ne la copie pas. Relance-la depuis la conversation.');
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

function accountLabel(id) { return accounts.load().accounts.find((a) => a.id === id)?.label || id || 'Compte'; }
// Résultat d'une action MCP : un échec compte par compte devient une phrase lisible.
function mcpReply(r) {
  if (r?.ok) return [200, r];
  const error = r?.error || (Array.isArray(r?.results) ? r.results.filter((x) => !x.ok).map((x) => `${accountLabel(x.accountId)} : ${x.error}`).join(' · ') : '') || 'Ça n\'a pas marché : réessaie dans un instant.';
  return [400, { ...r, ok: false, error }];
}
// ---------- passerelle MCP ----------
// Chaque compte Claude déclare chaque MCP de la passerelle (même adresse locale, même clé) ; les autres MCP du Mac
// sont recopiés dans les comptes où ils manquent (jamais modifiés ni retirés ; s'ils diffèrent d'un compte à
// l'autre, rien n'est touché). Au démarrage, toutes les 5 min et après chaque changement.
let mcpSyncing = null;
function syncMcpAccounts() {
  if (mcpSyncing) return mcpSyncing;
  mcpSyncing = (async () => {
    const changed = [];
    // seulement les MCP prêts : tant qu'un MCP n'est pas autorisé, les comptes gardent leur branchement direct
    for (const name of gateway.names().filter((n) => gateway.ready(n))) {
      const want = gateway.accountConfig(name);
      const raw = mcp.rawUser(name).filter((x) => !x.unavailable);
      const missing = raw.filter((x) => !x.config).map((x) => x.accountId);
      const differ = raw.filter((x) => x.config && JSON.stringify(x.config) !== JSON.stringify(want)).map((x) => x.accountId);
      if (missing.length) { await mcp.addUser(name, want, missing); changed.push(name); }
      if (differ.length) { await mcp.updateUser(name, want, differ); changed.push(name); }
    }
    for (const name of mcp.userNames()) {
      if (gateway.has(name)) continue;
      const raw = mcp.rawUser(name).filter((x) => !x.unavailable);
      const present = raw.filter((x) => x.config);
      if (!present.length || new Set(present.map((x) => JSON.stringify(x.config))).size > 1) continue;
      const missing = raw.filter((x) => !x.config).map((x) => x.accountId);
      if (missing.length) { await mcp.addUser(name, present[0].config, missing); changed.push(name); }
    }
    if (changed.length) console.error(`[vigie] MCP recopiés dans tous les comptes : ${[...new Set(changed)].join(', ')}`);
    return changed;
  })().catch((e) => { console.error('[vigie] synchronisation des MCP :', clean(e)); return []; }).finally(() => { mcpSyncing = null; });
  return mcpSyncing;
}

// POST /api/v2/gateway { action, name, … } : ajouter (bibliothèque), faire passer par Vigie un MCP existant,
// autoriser (un espace de plus avec label), changer d'espace, renommer ou retirer un espace, revenir en direct, retirer.
async function postGateway(body) {
  const { action, name } = body || {};
  try {
    if (action === 'add' || action === 'migrate') {
      let url = body.url;
      if (action === 'migrate') {
        const cfg = mcp.rawUser(name).map((x) => x.config).find(Boolean);
        if (!cfg) return bad('Ce MCP n\'existe dans aucun compte.');
        if (!cfg.url || (cfg.type && !['http', 'streamable-http'].includes(cfg.type))) return bad('Seuls les MCP en ligne peuvent passer par Vigie.');
        if (cfg.headers && Object.keys(cfg.headers).length) return bad('Ce MCP a ses propres en-têtes (clé d\'API) : il reste en direct.');
        url = cfg.url;
      } else if (mcp.userNames().includes(name) && !gateway.has(name)) {
        return bad(`Un MCP « ${name} » existe déjà sur ce Mac.`);
      }
      // Les comptes ne basculent qu'une fois l'autorisation réussie (retour du navigateur) : si le service refuse,
      // ou si la page est abandonnée, ils gardent leur branchement d'avant.
      const existed = gateway.has(name);
      gateway.add(name, url);
      let a;
      try { a = await gateway.authorize(name, body.label ? { label: body.label } : {}); } catch (e) { if (!existed) gateway.remove(name); throw e; }
      if (a.open) await syncMcpAccounts();
      return [200, { ok: true, ...a, gateway: gateway.status() }];
    }
    if (action === 'authorize') return [200, { ok: true, ...(await gateway.authorize(name, { id: body.profileId, label: body.label })), gateway: gateway.status() }];
    if (action === 'activate') { gateway.activate(name, body.profileId); await gateway.verify(name); return [200, { ok: true, gateway: gateway.status() }]; }
    if (action === 'rename') { gateway.renameProfile(name, body.profileId, body.label); return [200, { ok: true, gateway: gateway.status() }]; }
    if (action === 'removeProfile') { gateway.removeProfile(name, body.profileId); return [200, { ok: true, gateway: gateway.status() }]; }
    if (action === 'restore') {
      const url = gateway.status()[name]?.url;
      if (!url) return bad('Ce MCP ne passe pas par Vigie.');
      const ids = mcp.rawUser(name).filter((x) => x.config).map((x) => x.accountId);
      const r = await mcp.updateUser(name, { type: 'http', url }, ids);
      if (!r.ok) return mcpReply(r);
      gateway.remove(name);
      return [200, { ok: true, gateway: gateway.status() }];
    }
    if (action === 'remove') {
      const r = await mcp.removeUser(name, mcp.rawUser(name).map((x) => x.accountId));
      if (!r.ok) return mcpReply(r);
      gateway.remove(name);
      return [200, { ok: true, gateway: gateway.status() }];
    }
    return bad('Action inconnue.');
  } catch (e) {
    if (e instanceof GatewayError) return bad(e.message);
    throw e;
  }
}

// Retour du navigateur après une autorisation : une page simple, et les comptes remis à jour.
async function oauthCallback(url, res) {
  const r = await gateway.callback(url.searchParams);
  if (r.ok) syncMcpAccounts();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = r.ok ? `« ${esc(r.name)} » est connecté` : 'Connexion non aboutie';
  const text = r.ok ? `Espace : ${esc(r.label)}. Il marche maintenant dans tous tes comptes Claude. Tu peux fermer cet onglet.` : esc(r.error);
  return send(res, r.ok ? 200 : 400, `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Vigie</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f5f5f7;color:#1d1d1f}
main{max-width:460px;padding:32px;border-radius:16px;background:#fff;box-shadow:0 4px 24px #0001}h1{font-size:22px;margin:0 0 8px}p{color:#555;line-height:1.5}
@media(prefers-color-scheme:dark){body{background:#1d1d1f;color:#f5f5f7}main{background:#2c2c2e}p{color:#aaa}}</style></head>
<body><main><h1>${r.ok ? '✓ ' : ''}${title}</h1><p>${text}</p></main></body></html>`, 'text/html; charset=utf-8');
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
    return bad('Déjà connecté : rien à faire (le reconnecter couperait la connexion actuelle).');
  }
  return mcpReply(await mcp.connect({ name, accountId: body.accountId, path: body.path }));
}
function postAccounts(body) {
  // Codex : connexion par le navigateur (codex login), son compte n'est pas géré par le modèle des comptes Claude
  if (body?.action === 'codexLogin') {
    const c = safeCodex(() => codex.login(), { ok: false, error: 'Codex : connexion impossible.' });
    return c.ok ? [200, c] : [400, c];
  }
  const r = accounts.apply(body);
  return r.ok ? [200, r] : [400, { ...r, ok: false, error: r.error || 'Ça n\'a pas marché : réessaie dans un instant.' }];
}

// ---------- agents (lib/agents.mjs) ----------
// GET /api/v2/agents : la bibliothèque, avec l'état de chaque MCP nécessaire pour le compte des nouvelles
// conversations (celui sur lequel partira la conversation de l'agent, comme le lanceur). MCP de la passerelle : prêt
// s'il est autorisé ; les autres : dernier relevé de `claude mcp list` pour ce compte, MCP du Mac (dossier perso), et
// à défaut le connecteur claude.ai de ce nom (« Gmail » comme « claude.ai Gmail »).
// Un MCP demandé par un service (« figma », ou un nom qui le dit : « figma-pro ») se contente de n'importe quel MCP de
// ce service, quel que soit son nom (Mac, passerelle, connecteur claude.ai), le mieux connecté d'abord ; aucun :
// « missing ». Un autre nom : ce MCP-là. `connect` : le nom à passer à POST /api/v2/mcp/connect (pas la passerelle).
const NEED_RANK = ['connected', 'pending-approval', 'needs-auth', 'failed', 'unknown', 'disabled'];
function agentsView() {
  const model = accounts.load();
  const accountId = chosenAccount(model, null);
  const acc = model.accounts.find((a) => a.id === accountId);
  const status = (name) => {
    try {
      if (gateway.has(name)) return gateway.ready(name) ? 'connected' : 'needs-auth';
      const s = mcp.statusFor(name, { accountId, cwd: HOME });
      return s !== 'unknown' ? s : mcp.statusFor(name, { accountId, cwd: HOME, scope: 'connector' });
    } catch { return 'unknown'; }
  };
  let gw = {};
  try { gw = gateway.status(); } catch { /* passerelle illisible : sans elle */ }
  const need = (req) => {
    const svc = mcpService(req);
    if (svc === SERVICE_OTHER) return { name: req, service: null, status: status(req), servers: [req], connect: gateway.has(req) ? null : req };
    const found = new Map();
    for (const [n, g] of Object.entries(gw)) if (mcpService(n, { url: g.url }) === svc) found.set(n, status(n));
    try {
      for (const s of mcp.forProject(HOME, { accountId })) if (s.service === svc && !found.has(s.name)) found.set(s.name, status(s.name));
      // les connecteurs claude.ai, sous leur nom court (« Figma ») ; les MCP d'un projet ne comptent pas (pas dans le
      // dossier du nouveau projet)
      for (const [n, st] of mcp.seenFor(accountId)) {
        const short = n.replace(/^claude\.ai\s+/, '');
        if (short !== n && mcpService(n) === svc && !found.has(short)) found.set(short, st);
      }
    } catch { /* relevés illisibles : ce qu'on a */ }
    const servers = [...found].sort(([, a], [, b]) => NEED_RANK.indexOf(a) - NEED_RANK.indexOf(b)).map(([n]) => n);
    const best = servers[0];
    return { name: req, service: svc, status: best ? found.get(best) : 'missing', servers, connect: best && !gateway.has(best) ? best : null };
  };
  const available = desktop.agentSurfaces();
  return [200, {
    account: acc ? { id: acc.id, label: acc.label || acc.id } : null,
    // où un agent peut s'ouvrir, et celui proposé (le dernier utilisé s'il est encore là)
    surfaces: { available, chosen: chooseSurface(available, readState().agentsSurface) },
    agents: agents.list().map((a) => ({ ...a, mcp: a.mcp.map(need) })),
  }];
}

// Conversations Claude Code lancées dans ce dossier, connues de l'indexeur (lib/agents.mjs, folderConversations).
// limit 0 : toutes (pour vérifier une conversation à reprendre, même si d'autres l'ont poussée hors des 5 montrées).
function conversationsIn(target, limit = 5) {
  return folderConversations(target, {
    sessions: indexer.sessions, light: indexer.light, live: indexer.live, app: desktop.claudeSessions(), surfaceOf,
    launchDir: (s) => (s.light ? launchCwd(s) || s.cwd : launchDirOf(s.id)),
  }, limit);
}

// GET /api/v2/agents/folder?path=… : ce que le formulaire montre pour le dossier choisi (docs/api-v2.md).
function agentFolder(url) {
  const raw = url.searchParams.get('path');
  if (raw === null || !raw.trim()) return bad('Indique un dossier.');
  const f = agents.folder(raw);
  return [200, { path: f.path, exists: f.exists, error: f.error, conversations: f.error ? [] : conversationsIn(f.path), sources: f.sources }];
}

// POST /api/v2/agents/launch { id, values, folder, files?, surface?, session? } : tout est vérifié (surface installée,
// conversation à reprendre dans ce dossier) avant de rien créer ; puis dossier créé, fichiers joints copiés, consigne
// écrite, message préparé, et le moteur ouvre VS Code ou l'app Claude (lib/opener.mjs). Jusqu'à ~30 s : l'attente de
// la fenêtre de VS Code passe par des minuteries, le moteur répond aux autres requêtes pendant ce temps.
const SURFACE_MISSING = {
  vscode: 'VS Code et son extension Claude Code ne sont pas sur ton Mac : choisis l\'app Claude, ou installe-les.',
  'claude-app': 'L\'app Claude n\'est pas sur ton Mac : choisis VS Code, ou installe-la.',
};
const NO_SURFACE = 'Ni VS Code (avec son extension Claude Code) ni l\'app Claude ne sont sur ton Mac : installe l\'un des deux, puis relance l\'agent.';
const SESSION_GONE = 'Cette conversation n\'est plus dans ce dossier : relance en nouvelle conversation.';
async function postAgentLaunch(body) {
  const available = desktop.agentSurfaces();
  const surface = body.surface ?? chooseSurface(available, readState().agentsSurface);
  if (surface === null) return bad(NO_SURFACE);
  if (!Object.hasOwn(SURFACE_MISSING, surface)) return bad('Où ouvrir l\'agent ? « vscode » ou « claude-app ».');
  const session = body.session ?? null;
  if (session !== null && (typeof session !== 'string' || !UUID.test(session))) return bad(SESSION_GONE);
  const r = agents.launch({
    id: body.id, values: body.values, folder: body.folder, files: body.files, session,
    // après toutes les vérifications du dossier et des fichiers, avant la première écriture
    before: (target) => {
      if (!available.length) return { error: NO_SURFACE };
      if (!available.includes(surface)) return { error: SURFACE_MISSING[surface] };
      if (session && !conversationsIn(target, 0).some((c) => c.id === session)) return { error: SESSION_GONE };
      return null;
    },
  });
  if (!r.ok) return bad(r.error || 'Ça n\'a pas marché : réessaie dans un instant.', r.status || 400);
  try {
    const s = readState();
    if (s.agentsSurface !== surface) { s.agentsSurface = surface; writeState(s); }
  } catch (e) { console.error('[vigie] surface des agents :', clean(e)); }
  const localId = session && surface === 'claude-app' ? desktop.claudeSessions().get(session)?.localId ?? null : null;
  let opened = 'none';
  try { opened = await opener.launch({ surface, folder: r.folder, prompt: r.prompt, session, localId }); } catch (e) { console.error('[vigie] ouverture de l\'agent :', clean(e)); }
  const title = session ? conversationsIn(r.folder, 0).find((c) => c.id === session)?.title ?? null : null;
  return [200, { ok: true, folder: r.folder, briefFile: r.briefFile, prompt: r.prompt, surface, opened, copied: r.copied, message: launchMessage(opened, surface, { resume: !!session, title }) }];
}

function postQuestionReview(raw, body) {
  let id;
  try { id = decodeURIComponent(raw); } catch { return bad('Question introuvable.', 404); }
  if (!/^(q:)?[\w-]{1,100}$/.test(id)) return bad('Question introuvable.', 404);
  const r = questions.review(id, body);
  return r.ok ? [200, r] : bad(r.error || 'Ça n\'a pas marché : réessaie dans un instant.', r.status || 400);
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
  ['GET', /^\/api\/v2\/mcp$/, () => [200, { ...mcp.inventory({ connectorsDefault: readState().connectorsDefault }), gateway: gateway.status() }]],
  ['POST', /^\/api\/v2\/gateway$/, (_, b) => postGateway(b)],
  ['GET', /^\/api\/v2\/accounts$/, () => { const v = accounts.view(); return [200, { ...v, accounts: withCodexAccount(v.accounts || []) }]; }],
  ['GET', /^\/api\/v2\/health$/, () => [200, health()]],
  ['GET', /^\/api\/v2\/usage\/series$/, (_, __, url) => usageSeries(url)],
  ['POST', /^\/api\/v2\/settings$/, (_, b) => postSettings(b)],
  ['GET', /^\/api\/v2\/update$/, () => [200, updater.status()]],
  ['GET', /^\/api\/v2\/tools$/, () => [200, { detected: desktop.tools(), chosen: readState().tools }]],
  ['GET', /^\/api\/v2\/history$/, (_, __, url) => historyView(url)],
  ['POST', /^\/api\/v2\/update$/, async (_, b) => {
    if (b?.action === 'check') return [200, { ok: true, ...(await updater.check({ force: true })) }];
    if (b?.action !== 'install') return bad('Action : check ou install.');
    const r = updater.install();
    return r.ok ? [200, { ...r, update: updater.status() }] : bad(r.error, r.status);
  }],
  ['POST', new RegExp(`^/api/v2/conversation/${S}/settings$`), ([id], b) => postConversationSettings(id, b)],
  ['POST', new RegExp(`^/api/v2/questions/${S}/review$`), ([id], b) => postQuestionReview(id, b)],
  ['POST', /^\/api\/v2\/mcp\/user$/, (_, b) => postMcpUser(b)],
  ['POST', /^\/api\/v2\/mcp\/project$/, (_, b) => postMcpProject(b)],
  ['POST', /^\/api\/v2\/mcp\/disable$/, (_, b) => postMcpDisable(b)],
  ['POST', /^\/api\/v2\/mcp\/check$/, (_, b) => postMcpCheck(b)],
  ['POST', /^\/api\/v2\/mcp\/connect$/, (_, b) => postMcpConnect(b)],
  ['POST', /^\/api\/v2\/accounts$/, (_, b) => postAccounts(b)],
  ['GET', /^\/api\/v2\/agents$/, () => agentsView()],
  ['GET', /^\/api\/v2\/agents\/folder$/, (_, __, url) => agentFolder(url)],
  ['POST', /^\/api\/v2\/agents\/launch$/, (_, b) => postAgentLaunch(b)],
  ['POST', new RegExp(`^/api/v2/pending/${S}$`), ([id], b) => postPending(id, b)],
  ['POST', /^\/api\/v2\/approvals$/, (_, b) => postApprovals(b)],
  ['POST', /^\/api\/v2\/review\/([^/]{1,400})\/dismiss$/, ([id]) => postDismiss(id)],
  ['POST', /^\/api\/v2\/open$/, (_, b) => postOpen(b)],
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
  // Passerelle MCP : relayée telle quelle (pas de lecture JSON ni d'en-tête X-Vigie : la clé du MCP suffit).
  const relay = /^\/mcp\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (relay) return gateway.proxy(req, res, decodeURIComponent(relay[1]), relay[2] || '', url.search);
  if (req.method === 'GET' && url.pathname === '/oauth/callback') return oauthCallback(url, res);
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/v2/health' && !tokenOk(req.headers['x-vigie-token'])) {
    return send(res, 401, { ok: false, error: 'Accès refusé : jeton de Vigie absent ou périmé. Quitte Vigie et rouvre-le.' });
  }

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

function onRequest(req, res) {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message });
    console.error('[vigie] requête :', clean(e));
    send(res, 500, { ok: false, error: 'Erreur interne de Vigie.' });
  });
}
const server = http.createServer(onRequest);
// Le même port sur ::1 : « localhost » (adresse de retour des autorisations MCP) peut viser IPv6 d'abord, et aucun
// autre programme ne doit pouvoir y attendre ces retours à la place de Vigie. Sans IPv6 local : rien.
const server6 = http.createServer(onRequest);
server6.on('error', () => {});

// ---------- tâches de fond ----------
// Le Mac est-il calme ? Pas pendant ses 5 premières minutes, ni dans les 2 minutes qui suivent le démarrage du moteur,
// ni dans la minute qui suit le lancement d'une conversation : c'est là que les conversations de VS Code renouvellent
// toutes leurs jetons. Les relevés automatiques de Vigie (usage, MCP), qui lancent eux aussi Claude Code, attendent
// (2026-10-23 : relevés et conversations ensemble au démarrage, trousseau saturé, comptes déconnectés).
// Réveil après une veille : même tempête qu'au démarrage (jetons expirés pendant la nuit), alors que os.uptime()
// compte le temps de veille. Repéré à un trou de plus d'une minute entre deux tours de la boucle (toutes les 4 s).
const ENGINE_STARTED = Date.now();
let lastTickAt = Date.now(), wokeAt = 0;
function noteTick() {
  const t = Date.now();
  if (t - lastTickAt > 60_000) wokeAt = t;
  lastTickAt = t;
}
function calm() {
  if (process.env.VIGIE_CALM === '1') return true;
  if (os.uptime() < 300 || Date.now() - ENGINE_STARTED < 120_000 || Date.now() - wokeAt < 300_000) return false;
  try { if (Date.now() - fs.statSync(path.join(DATA, 'launches.log')).mtimeMs < 60_000) return false; } catch { /* aucun lancement noté */ }
  return true;
}
// Coffre des connexions : un passage à la fois, le premier dès le démarrage (c'est là que les connexions se perdent).
let vaultBusy = false, vaultAt = 0;
async function vaultTick() {
  if (!vault || vaultBusy) return;
  if (Date.now() - vaultAt < VAULT_CALM_MS - 1000 && vault.settled() && calm()) return;
  vaultBusy = true;
  try { await vault.sync(); } catch (e) { console.error('[vigie] coffre :', clean(e)); } finally { vaultBusy = false; vaultAt = Date.now(); }
}
let healthNotices = [];
let switchNotices = []; // bascules appliquées : L'utilisateur doit envoyer un message pour relancer la conversation
let ticking = false;
let lastHealth = 0;
let nextMcpCheck = Date.now() + MCP_CHECK_FIRST_MS;
async function tick() {
  noteTick(); // avant le garde : un tour long n'est pas pris pour une veille
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
      keepToken();
      healthNotices = accounts.health().notices || [];
      accounts.autoRefresh({ calm: calm() });
    }
  } catch (e) { console.error('[vigie] comptes :', clean(e)); }
  // État réel des MCP (`claude mcp list`, aucune requête au modèle) : en fond, un relevé à la fois, Mac calme.
  try {
    if (MCP_CHECK && Date.now() >= nextMcpCheck && calm()) {
      nextMcpCheck = Date.now() + MCP_CHECK_EVERY_MS;
      if (!mcp.healthState().running) mcp.checkHealth({ background: true }).catch((e) => console.error('[vigie] MCP :', clean(e)));
    }
  } catch (e) { console.error('[vigie] MCP :', clean(e)); }
  finally { ticking = false; }
}

rotateHistory();
setInterval(rotateHistory, HOUR);
// Mises à jour : relevé GitHub toutes les heures ; automatique (réglage autoUpdate) seulement quand rien n'attend
// l'utilisateur (décision ou question en cours). Pas pendant les tests (VIGIE_NO_UPDATE).
function updateTick() {
  if (process.env.VIGIE_NO_UPDATE) return;
  const state = readState();
  let busy = true;
  try { busy = pendingWaits(state).size > 0; } catch { /* prudence : on attend */ }
  updater.tick({ auto: state.autoUpdate, busy }).catch((e) => console.error('[vigie] mise à jour :', clean(e)));
}
// Choix du compte de chaque conversation dans VS Code : toujours actif, sans réglage à montrer, dès que VS Code est
// sur le Mac et que l'utilisateur s'en sert (outils de l'accueil). Le lanceur d'un autre outil n'est jamais remplacé.
function ensureWrapper() {
  if (process.env.VIGIE_NO_WRAPPER_AUTO) return;
  const tools = readState().tools;
  if (tools && !tools.claudeVSCode) return;
  if (!fs.existsSync(path.dirname(accounts.paths.vscodeSettingsPath)) || accounts.wrapperActive()) return;
  const r = accounts.wrapper(true);
  console.error(r.ok ? '[vigie] choix du compte de chaque conversation activé dans VS Code' : `[vigie] choix du compte dans VS Code : ${r.error}`);
}

server.listen(PORT, HOST, () => {
  console.log(`[vigie] http://${HOST}:${server.address().port}`);
  server6.listen(server.address().port, '::1');
  ensureWrapper();
  vaultTick();
  setInterval(vaultTick, VAULT_EVERY_MS);
  tick();
  setInterval(tick, 4000);
  setTimeout(updateTick, 60_000);
  setInterval(updateTick, 30 * 60_000);
  if (!process.env.VIGIE_NO_MCP_SYNC) {
    // espaces de la passerelle encore acceptés par leur service ?
    setTimeout(() => { for (const n of gateway.names()) gateway.verify(n).catch(() => {}); }, 10_000);
    setTimeout(syncMcpAccounts, 30_000);
    setInterval(syncMcpAccounts, 5 * 60_000);
  }
});
