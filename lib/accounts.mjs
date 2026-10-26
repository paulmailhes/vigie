// Vigie — comptes Claude : un dossier de configuration par compte (CLAUDE_CONFIG_DIR), le choix du
// compte de chaque conversation (data/accounts.json, lu par bin/claude-account-wrapper) et la bascule.
//
// « Travail 1 » = la configuration actuelle (~/.claude + ~/.claude.json, sans CLAUDE_CONFIG_DIR).
// Les autres comptes vivent dans <accountsRoot>/<id>, reliés à ~/.claude par des liens symboliques
// pour l'historique, les réglages et les hooks. Leur .claude.json (connexion, usage, MCP) est à eux.
// Règle d'or : en cas de doute, ne rien faire ; Claude Code doit marcher comme sans Vigie.
// Aucun secret n'est affiché ni journalisé : le trousseau n'est interrogé que pour savoir si une entrée existe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findClaudeBin, isEditorCopy, canRun } from './claude-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAIN_ID = 'travail1';
// Sans nom choisi par l'utilisateur, un compte prend un nom tiré de son adresse : le compte « principal » du Mac
// change quand l'utilisateur fait /login (ce soir : du pro help@ au perso Gmail), un nom figé deviendrait faux.
const MAIN_LABEL = null;
const PUBLIC_MAIL = /^(gmail|googlemail|icloud|me|mac|outlook|hotmail|live|msn|yahoo|proton|protonmail|pm|free|orange|wanadoo|laposte|sfr|bbox|gmx)\./;
// Les trois comptes de l'utilisateur (2026-10-20) : un nom par adresse, quel que soit le dossier où elle est connectée.
// Noms fixés d'avance pour certaines adresses (vide : chaque compte prend le nom qu'on lui donne, sinon son adresse).
export const KNOWN_ACCOUNTS = {};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e) => (typeof e === 'string' && EMAIL_RE.test(e.trim()) ? e.trim().toLowerCase() : null);
export function friendlyLabel(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.toLowerCase().split('@');
  return PUBLIC_MAIL.test(domain) ? 'Perso' : `Pro · ${local}`;
}
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDLE_SETTLE_MS = 2000;   // au repos depuis au moins 2 s : on ne coupe pas au moment où un tour démarre
const PIN_WINDOW_MS = 120_000; // une ligne du lanceur et le démarrage du processus doivent être proches
export const WRAPPER_KEY = 'claudeCode.claudeProcessWrapper';

// Ce que chaque dossier de compte partage avec ~/.claude.
// - projects : indispensable, l'extension ne lit l'historique que dans ~/.claude/projects (sinon reprise vide) ;
// - settings.json : hooks de Vigie (auto-accept) et règles de permission ;
// - sessions : registre des processus, lu par le hook et le serveur (rangé par pid, pas de collision) ;
// - file-history, todos, plans, shell-snapshots, session-env : rangés par conversation, suivent la conversation
//   quand elle change de compte ; ide : fichiers de verrou de VS Code (rangés par port) ;
// - CLAUDE.md, skills, agents, commands : tes instructions et outils, identiques partout ;
// - plugins : enabledPlugins vit dans settings.json (partagé), donc les plugins installés doivent l'être aussi ;
//   les plugins synchronisés depuis claude.ai sont déjà rangés par <org>_<compte> (plugins/synced/…), sans collision.
// Un dossier absent de ~/.claude n'est pas relié : un lien de dossier qui pointe dans le vide fait échouer
// les mkdir de Claude Code. Un fichier absent l'est quand même (écrire à travers le lien le crée dans ~/.claude).
export const SHARED = [
  { name: 'projects', dir: true },
  { name: 'sessions', dir: true },
  { name: 'file-history', dir: true },
  { name: 'todos', dir: true },
  { name: 'plans', dir: true },
  { name: 'shell-snapshots', dir: true },
  { name: 'session-env', dir: true },
  { name: 'ide', dir: true },
  { name: 'settings.json', dir: false },
  { name: 'CLAUDE.md', dir: false },
  { name: 'skills', dir: true },
  { name: 'agents', dir: true },
  { name: 'commands', dir: true },
  { name: 'plugins', dir: true },
];

// Clés de ~/.claude.json recopiées par dossier de projet : la confiance et les MCP, jamais les caches.
const PROJECT_KEYS = [
  'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown',
  'enabledMcpjsonServers', 'disabledMcpjsonServers', 'enableAllProjectMcpServers', 'mcpServers', 'disabledMcpServers',
];

// Nom de l'entrée de trousseau de Claude Code pour un dossier de configuration (binaire 2.1.301) :
// sha256 de la chaîne brute, normalisée NFC. Une barre oblique finale change donc le nom.
export function keychainItem(configDir) {
  if (!configDir) return 'Claude Code-credentials';
  return `Claude Code-credentials-${crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

// Compte d'une conversation : celui qui lui est noté, sinon le compte des nouvelles conversations (le lanceur la
// reprend dessus), sinon Travail 1.
export const chosenAccount = (model, sessionId) => model?.sessions?.[sessionId] || model?.defaultForNew || MAIN_ID;

// .claude.json d'un compte (connexion, MCP), comme Claude Code : un ancien .config.json non vide passe devant.
export function claudeJsonFile(home, configDir) {
  const legacy = path.join(configDir || path.join(home, '.claude'), '.config.json');
  try { if (fs.statSync(legacy).size > 0) return legacy; } catch { /* rien */ }
  return path.join(configDir || home, '.claude.json');
}

function defaultRunner(cmd, args, opts = {}) {
  if (opts.detach) {
    // Processus lancé en fond (connexion d'un compte) : arrêté au bout de 10 min s'il attend encore.
    // Commande introuvable : échec tout de suite (sinon spawn « réussit » puis échoue en silence, et la page
    // annoncée ne s'ouvre jamais ; l'appelant passe alors au repli).
    if (!canRun(cmd, opts.env ? { ...process.env, ...opts.env } : process.env)) return { status: 1, stdout: '', stderr: '' };
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: os.tmpdir(), env: opts.env ? { ...process.env, ...opts.env } : process.env });
      child.on('error', () => {});
      child.unref();
      setTimeout(() => { try { process.kill(child.pid); } catch { /* déjà fini */ } }, 600_000).unref();
      return { status: 0, stdout: '', stderr: '' };
    } catch { return { status: 1, stdout: '', stderr: '' }; }
  }
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 5000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function defaultClaudeBin(home) {
  let real = '';
  try { real = os.userInfo().homedir; } catch { real = os.homedir(); }
  if (path.resolve(home) !== path.resolve(real)) return null;
  return findClaudeBin({ home });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}
function iso(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function slugify(label) {
  return label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'compte';
}
function cleanLabel(label) {
  const s = typeof label === 'string' ? label.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  return s.length >= 1 && s.length <= 40 ? s : null;
}

// « ≈ 152 k tokens relus sur le nouveau compte » : changer de compte, c'est changer d'organisation,
// donc plus de cache : toute la conversation est relue sur le quota du nouveau compte.
export function rereadEstimate(contextTokens) {
  const n = Number(contextTokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  const v = n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : `${Math.max(1, Math.round(n / 1000))} k`;
  return `≈ ${v} tokens relus sur le nouveau compte.`;
}

// ---------- JSONC (réglages VS Code : commentaires et virgules finales possibles) ----------

// Texte JSONC -> objet, sans toucher au fichier. Lève une erreur si illisible.
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const s = i;
      i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(s, i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === ',') {
      // virgule finale : on regarde le prochain caractère utile
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') { while (j < n && text[j] !== '\n') j++; continue; }
        if (text[j] === '/' && text[j + 1] === '*') { const e = text.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
        break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out.trim() === '' ? {} : JSON.parse(out);
}

// Repère les membres du premier niveau d'un objet JSONC, avec leurs positions dans le texte.
function scanTopLevel(text) {
  let i = 0;
  const n = text.length;
  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) throw new Error('commentaire'); i = e + 2; continue; }
      return;
    }
  };
  const str = () => {
    const s = i;
    i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= n) throw new Error('chaîne');
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const value = () => {
    if (text[i] === '"') return str();
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < n) {
        const c = text[i];
        if (c === '"') { str(); continue; }
        if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { ws(); continue; }
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; return; } }
        i++;
      }
      throw new Error('valeur');
    }
    const s = i;
    while (i < n && !/[\s,}\]/]/.test(text[i])) i++;
    if (i === s) throw new Error('valeur');
  };
  ws();
  if (text[i] !== '{') throw new Error('objet');
  const open = i++;
  const members = [];
  let close = -1;
  for (;;) {
    ws();
    if (text[i] === '}') { close = i; break; }
    if (text[i] !== '"') throw new Error('clé');
    const keyStart = i;
    const key = str();
    ws();
    if (text[i] !== ':') throw new Error('deux-points');
    i++;
    ws();
    const valueStart = i;
    value();
    const valueEnd = i;
    ws();
    let comma = -1;
    if (text[i] === ',') { comma = i; i++; }
    members.push({ key, keyStart, valueStart, valueEnd, comma });
    if (comma < 0) { ws(); if (text[i] !== '}') throw new Error('accolade'); close = i; break; }
  }
  i = close + 1;
  ws();
  if (i < n) throw new Error('fin');
  return { open, close, members };
}

const lineStart = (t, p) => { let s = p; while (s > 0 && (t[s - 1] === ' ' || t[s - 1] === '\t')) s--; return s === 0 || t[s - 1] === '\n' ? s : -1; };
// Fin de ligne si le reste n'est qu'espaces et éventuel commentaire // ; sinon -1.
const restOfLine = (t, p) => { const m = /^[ \t]*(\/\/[^\n]*)?(\r?\n|$)/.exec(t.slice(p)); return m ? p + m[0].length : -1; };

// Pose (value !== undefined) ou retire (value === undefined) une clé du premier niveau, en gardant
// commentaires, ordre et mise en forme du reste. Renvoie le nouveau texte.
export function setJsoncKey(text, key, value) {
  if (text.trim() === '') text = '{\n}\n';
  const edits = []; // [début, fin, texte]
  const { open, close, members } = scanTopLevel(text);
  const mine = members.filter((m) => m.key === key);
  if (value !== undefined) {
    const v = JSON.stringify(value);
    if (mine.length) {
      for (const m of mine) edits.push([m.valueStart, m.valueEnd, v]);
    } else if (members.length === 0) {
      // objet vide : on garde un éventuel commentaire qui s'y trouve
      if (text.slice(open + 1, close).trim() === '') edits.push([open + 1, close, `\n    ${JSON.stringify(key)}: ${v}\n`]);
      else edits.push([close, close, `${text[close - 1] === '\n' ? '' : '\n'}    ${JSON.stringify(key)}: ${v}\n`]);
    } else {
      const first = members[0];
      const ls = lineStart(text, first.keyStart);
      const indent = ls >= 0 ? text.slice(ls, first.keyStart) : '    ';
      const last = members[members.length - 1];
      const entry = `${indent}${JSON.stringify(key)}: ${v}`;
      if (last.comma >= 0) {
        // virgule finale déjà là : on garde ce style
        const eol = restOfLine(text, last.comma + 1);
        if (eol >= 0) edits.push([eol, eol, `${text[eol - 1] === '\n' ? '' : '\n'}${entry},\n`]);
        else edits.push([last.comma + 1, last.comma + 1, `\n${entry},`]);
      } else {
        // virgule juste après la valeur, nouvelle ligne après un éventuel commentaire de fin de ligne
        const eol = restOfLine(text, last.valueEnd);
        if (eol >= 0 && text[eol - 1] === '\n') edits.push([last.valueEnd, last.valueEnd, ','], [eol, eol, `${entry}\n`]);
        else if (eol > last.valueEnd) edits.push([last.valueEnd, last.valueEnd, ','], [eol, eol, `\n${entry}`]);
        else edits.push([last.valueEnd, last.valueEnd, `,\n${entry}`]);
      }
    }
  } else {
    if (!mine.length) return text;
    // on retire une occurrence à la fois puis on relit (positions sûres)
    const idx = members.indexOf(mine[0]);
    const m = members[idx];
    const prev = idx > 0 ? members[idx - 1] : null;
    const end0 = m.comma >= 0 ? m.comma + 1 : m.valueEnd;
    const eol = restOfLine(text, end0);
    const ls = lineStart(text, m.keyStart);
    if (ls >= 0 && eol >= 0) {
      // le membre occupe sa ligne : on retire la ligne (et la virgule du précédent s'il était le dernier)
      edits.push([ls, eol, '']);
      if (m.comma < 0 && prev) edits.push([prev.comma, prev.comma + 1, '']);
    } else if (m.comma < 0 && prev && text.slice(prev.comma + 1, m.keyStart).trim() === '') {
      edits.push([prev.comma, m.valueEnd, '']);
    } else {
      let e = end0;
      if (m.comma >= 0) while (text[e] === ' ' || text[e] === '\t') e++;
      edits.push([m.keyStart, e, '']);
      if (m.comma < 0 && prev) edits.push([prev.comma, prev.comma + 1, '']);
    }
    edits.sort((a, b) => b[0] - a[0]);
    let out = text;
    for (const [s, e, t] of edits) out = out.slice(0, s) + t + out.slice(e);
    return setJsoncKey(out, key, undefined);
  }
  edits.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e, t] of edits) out = out.slice(0, s) + t + out.slice(e);
  return out;
}

// ---------- comptes ----------

// Une conversation arrêtée pour une bascule reste « à relancer » 24 h au plus (ensuite : fermée).
const STOPPED_MS = 24 * 3600_000;

export function createAccounts({
  dataDir = process.env.VIGIE_DATA || path.join(ROOT, 'data'),
  home = process.env.VIGIE_HOME || os.homedir(),
  accountsRoot = process.env.VIGIE_ACCOUNTS_ROOT || path.join(home, '.claude-comptes'),
  vscodeSettingsPath = process.env.VIGIE_VSCODE_SETTINGS || path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
  wrapperPath = process.env.VIGIE_WRAPPER || path.join(ROOT, 'bin', 'claude-account-wrapper'),
  // Relevé d'usage externe facultatif (état JSON rangé par accountUuid) : VIGIE_RUNCAT_STATE, sinon aucun.
  runcatPath = process.env.VIGIE_RUNCAT_STATE || null,
  // CLI de Claude Code pour les relevés d'usage (le PATH de launchd ne contient pas ~/.local/bin).
  // Hors du vrai dossier perso (tests), aucun relevé sans VIGIE_CLAUDE_BIN : jamais de vraie requête par erreur.
  claudeBin = process.env.VIGIE_CLAUDE_BIN || defaultClaudeBin(home),
  runner = defaultRunner,
  kill = (pid, sig) => process.kill(pid, sig),
  cacheMs = 60_000,
  // Arrêt d'une conversation : délai avant SIGTERM si SIGINT ne l'a pas arrêtée.
  stopGraceMs = 4000,
} = {}) {
  accountsRoot = path.resolve(accountsRoot); // absolu, sans barre finale : le nom du trousseau en dépend
  const FILE = path.join(dataDir, 'accounts.json');
  const CX_FILE = path.join(dataDir, 'connexions.json');
  const LAUNCH_DIR = path.join(dataDir, 'launches');
  const CLAUDE_DIR = path.join(home, '.claude');
  // D'où vient le modèle (hors JSON) : 'abime' = JSON illisible, 'illisible' = lecture impossible
  // (erreur passagère, droits…). Seul un geste de l'utilisateur remplace un fichier abîmé ; jamais un fichier illisible.
  const FROM = Symbol('origine');

  // ---------- modèle ----------
  function defaultModel() {
    return nameAccounts({ accounts: [{ id: MAIN_ID, label: MAIN_LABEL, configDir: null }], defaultForNew: MAIN_ID, sessions: {}, pendingSwitches: {}, stopped: {}, labelsByEmail: { ...KNOWN_ACCOUNTS } });
  }
  // Lecture directe (pas le cache) : appelée aussi pendant la construction du module.
  // Priorité : le nom que l'utilisateur donne à l'adresse, puis le nom enregistré, puis un nom tiré de l'adresse.
  function nameAccounts(model) {
    const names = model.labelsByEmail || {};
    for (const acc of model.accounts) {
      let email = null;
      try { email = normEmail(JSON.parse(fs.readFileSync(claudeJsonPath(acc), 'utf8'))?.oauthAccount?.emailAddress); } catch { /* pas encore connecté */ }
      const known = names[email || acc.expectedEmail || ''];
      acc.label = known || acc.label || friendlyLabel(email || acc.expectedEmail) || (acc.id === MAIN_ID ? 'Compte du Mac' : acc.id);
    }
    return model;
  }
  function load() {
    const fallback = (from) => Object.assign(defaultModel(), { [FROM]: from });
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? discover() : fallback('illisible'); }
    let m;
    try { m = JSON.parse(raw); } catch { return fallback('abime'); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return fallback('abime');
    const out = defaultModel();
    const seen = new Set([MAIN_ID]);
    for (const a of Array.isArray(m.accounts) ? m.accounts : []) {
      if (!a || typeof a.id !== 'string' || !ID_RE.test(a.id)) continue;
      if (a.id === MAIN_ID) { if (cleanLabel(a.label)) out.accounts[0].label = cleanLabel(a.label); continue; }
      if (seen.has(a.id) || typeof a.configDir !== 'string' || !path.isAbsolute(a.configDir)) continue;
      seen.add(a.id);
      out.accounts.push({ id: a.id, label: cleanLabel(a.label) || null, configDir: a.configDir, ...(normEmail(a.expectedEmail) ? { expectedEmail: normEmail(a.expectedEmail) } : {}) });
    }
    if (typeof m.defaultForNew === 'string' && seen.has(m.defaultForNew)) out.defaultForNew = m.defaultForNew;
    for (const [e, l] of Object.entries(m.labelsByEmail && typeof m.labelsByEmail === 'object' ? m.labelsByEmail : {})) {
      if (normEmail(e) && cleanLabel(l)) out.labelsByEmail[normEmail(e)] = cleanLabel(l);
    }
    nameAccounts(out);
    for (const [sid, id] of Object.entries(m.sessions && typeof m.sessions === 'object' ? m.sessions : {})) {
      if (UUID_RE.test(sid) && typeof id === 'string' && seen.has(id)) out.sessions[sid] = id;
    }
    for (const [sid, p] of Object.entries(m.pendingSwitches && typeof m.pendingSwitches === 'object' ? m.pendingSwitches : {})) {
      if (UUID_RE.test(sid) && p && seen.has(p.to)) out.pendingSwitches[sid] = { to: p.to, since: iso(p.since) || new Date().toISOString() };
    }
    out.stopped = {};
    for (const [sid, p] of Object.entries(m.stopped && typeof m.stopped === 'object' ? m.stopped : {})) {
      if (UUID_RE.test(sid) && p && seen.has(p.to) && Date.now() - Date.parse(p.at) < STOPPED_MS) out.stopped[sid] = { to: p.to, at: iso(p.at) };
    }
    return out;
  }
  // Pas encore de accounts.json (première ouverture, ou réinstallation après effacement) : les comptes déjà
  // connectés de <accountsRoot> sont repris tels quels (même dossier, donc même entrée de trousseau : pas de
  // reconnexion). Enregistré tout de suite : la recherche ne se fait qu'une fois.
  function discover() {
    const model = defaultModel();
    let names = [];
    try { names = fs.readdirSync(accountsRoot).sort(); } catch { return model; }
    for (const id of names) {
      if (!ID_RE.test(id) || id === MAIN_ID) continue;
      const configDir = path.join(accountsRoot, id);
      const email = normEmail(readJson(path.join(configDir, '.claude.json'))?.oauthAccount?.emailAddress);
      if (!email || model.accounts.some((a) => a.expectedEmail === email)) continue;
      model.accounts.push({ id, label: null, configDir, expectedEmail: email });
    }
    if (model.accounts.length === 1) return model;
    nameAccounts(model);
    try { save(model); } catch { /* recherché de nouveau au prochain passage */ }
    return model;
  }
  function save(model) {
    // pas pu lire le fichier : le remplacer effacerait comptes et choix sans copie possible
    if (model[FROM] === 'illisible') throw new Error('accounts.json illisible : rien n\'a été écrit');
    fs.mkdirSync(dataDir, { recursive: true });
    if (model[FROM] === 'abime') {
      // fichier abîmé : on le garde de côté avant de le remplacer
      try { fs.copyFileSync(FILE, `${FILE}.corrupt-${stamp()}`); } catch { /* déjà parti */ }
    }
    // keychainItem : nom de l'entrée de trousseau du compte, recopié pour le lanceur (qui vérifie qu'elle
    // existe avant de lancer une conversation sur ce compte). Recalculé à chaque lecture, jamais lu d'ici.
    const out = { ...model, accounts: model.accounts.map((a) => (a.configDir ? { ...a, keychainItem: keychainItem(a.configDir) } : a)) };
    writeAtomic(FILE, JSON.stringify(out, null, 2) + '\n');
  }
  const find = (model, id) => model.accounts.find((a) => a.id === id) || null;

  // ---------- lecture d'un compte ----------
  // ~/.claude.json pèse plusieurs centaines de Ko et le serveur interroge toutes les 3 s : on relit au changement.
  const jsonCache = new Map(); // chemin -> { key, value }
  function cachedJson(p) {
    let st;
    try { st = fs.statSync(p); } catch { jsonCache.delete(p); return null; }
    const key = `${st.mtimeMs}:${st.size}`;
    const c = jsonCache.get(p);
    if (c && c.key === key) return c.value;
    const value = readJson(p);
    jsonCache.set(p, { key, value });
    return value;
  }
  const claudeJsonPath = (acc) => claudeJsonFile(home, acc.configDir);
  const claudeJson = (acc) => cachedJson(claudeJsonPath(acc));
  const kcCache = new Map(); // nom -> { at, ok }
  function keychainHas(name) {
    const c = kcCache.get(name);
    if (c && Date.now() - c.at < cacheMs) return c.ok;
    let ok = false;
    try { ok = runner('/usr/bin/security', ['find-generic-password', '-s', name], { capture: false }).status === 0; } catch { ok = false; }
    kcCache.set(name, { at: Date.now(), ok });
    return ok;
  }
  // État des connexions publié par le coffre du moteur (lib/vault.mjs, data/connexions.json), le même que lit le
  // lanceur : il regarde ce que l'entrée de trousseau contient, pas seulement qu'elle existe (le 2026-10-23, les
  // entrées étaient là, vidées de leur connexion). Ignoré s'il a plus de 15 min (moteur arrêté) ou s'il est abîmé.
  // Petit fichier réécrit toutes les 20 s : relu à chaque fois.
  function loginStatus() {
    const j = readJson(CX_FILE);
    const t = j?.checkedAtEpoch;
    if (typeof t !== 'number' || Math.abs(Date.now() / 1000 - t) > 900 || !j.accounts || typeof j.accounts !== 'object') return {};
    return j.accounts;
  }
  function isConnected(acc, cj = claudeJson(acc), status = loginStatus()) {
    if (!cj?.oauthAccount || typeof cj.oauthAccount !== 'object') return false;
    if (acc.configDir && !exists(acc.configDir)) return false;
    const st = status[acc.id];
    if (typeof st?.connected === 'boolean') return st.connected; // null : lecture ratée, on regarde nous-mêmes
    // repli en clair de Claude Code quand le trousseau échoue : on ne regarde que l'existence
    if (exists(path.join(acc.configDir || CLAUDE_DIR, '.credentials.json'))) return true;
    return keychainHas(keychainItem(acc.configDir));
  }

  function usageFromClaude(cj) {
    const c = cj?.cachedUsageUtilization;
    const u = c?.utilization;
    if (!u || typeof u !== 'object') return null;
    // relevé d'un autre compte (après un changement de connexion) : on l'ignore
    if (c.accountUuid && cj.oauthAccount?.accountUuid && c.accountUuid !== cj.oauthAccount.accountUuid) return null;
    const lim = Array.isArray(u.limits) ? u.limits.filter((l) => l && typeof l === 'object') : [];
    const win = (l) => (l && num(l.percent) !== null ? { pct: l.percent, resetsAt: iso(l.resets_at) } : null);
    const old = (w) => (w && num(w.utilization) !== null ? { pct: w.utilization, resetsAt: iso(w.resets_at) } : null);
    const scoped = lim.filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name && num(l.percent) !== null)
      .sort((a, b) => b.percent - a.percent)[0];
    return {
      session: win(lim.find((l) => l.kind === 'session')) || old(u.five_hour),
      week: win(lim.find((l) => l.kind === 'weekly_all')) || old(u.seven_day),
      weekModel: scoped ? { label: String(scoped.scope.model.display_name), pct: scoped.percent, resetsAt: iso(scoped.resets_at) }
        : (old(u.seven_day_opus) ? { label: 'Opus', ...old(u.seven_day_opus) } : null),
      observedAt: iso(num(c.fetchedAtMs)),
    };
  }
  // Secours : l'état du script RunCat de l'utilisateur (lecture seule), rangé par accountUuid.
  function usageFromRuncat(cj) {
    const st = cachedJson(runcatPath);
    const accounts = st?.accounts;
    if (!accounts || typeof accounts !== 'object') return null;
    const uuid = cj?.oauthAccount?.accountUuid;
    const email = cj?.oauthAccount?.emailAddress;
    const a = (uuid && accounts[uuid]) || Object.values(accounts).find((x) => email && x?.email === email);
    if (!a || !Array.isArray(a.limits)) return null;
    const win = (l) => (l && num(l.percent) !== null ? { pct: l.percent, resetsAt: iso(l.resets_at) } : null);
    const model = a.limits.filter((l) => typeof l?.key === 'string' && l.key.startsWith('weekly:') && num(l.percent) !== null)
      .sort((x, y) => y.percent - x.percent)[0];
    return {
      session: win(a.limits.find((l) => l?.key === 'session')),
      week: win(a.limits.find((l) => l?.key === 'weekly_all')),
      weekModel: model ? { label: model.key.slice(7), pct: model.percent, resetsAt: iso(model.resets_at) } : null,
      observedAt: num(a.fetchedAt) !== null ? iso(a.fetchedAt * 1000) : null,
    };
  }
  // Jamais de relevé périmé : une fenêtre dont la remise à zéro est passée ne dit plus rien du reste (ex.
  // relevé RunCat d'un mois, « session 100 % » alors qu'elle a repris depuis), et un relevé de plus de 6 h
  // non plus (le 3 septembre, RunCat affichait encore help@ à 100 %). On ne les montre pas, ni ne s'en sert
  // pour la part de la semaine.
  const STALE_MS = 6 * 3600_000;
  function fresh(u, source, now) {
    if (!u || !u.observedAt || !(now - Date.parse(u.observedAt) <= STALE_MS)) return null;
    const ok = (w) => (w && (!w.resetsAt || Date.parse(w.resetsAt) > now) ? w : null);
    const out = { session: ok(u.session), week: ok(u.week), weekModel: ok(u.weekModel), observedAt: u.observedAt, source };
    return out.session || out.week || out.weekModel ? out : null;
  }
  // Relevé fait par une petite requête (voir refresh) : data/usage/<compte>.json
  const PING_DIR = path.join(dataDir, 'usage');
  const usageFromPing = (acc) => (acc ? readJson(path.join(PING_DIR, `${acc.id}.json`)) : null);
  // source : « session » (relevé écrit par une vraie session, ou RunCat) | « ping » (petite requête de relevé)
  function usageOf(cj, acc, now = Date.now()) {
    const cands = [fresh(usageFromClaude(cj), 'session', now), fresh(usageFromPing(acc), 'ping', now), fresh(usageFromRuncat(cj), 'session', now)].filter(Boolean);
    cands.sort((x, y) => Date.parse(y.observedAt) - Date.parse(x.observedAt));
    const best = cands[0];
    if (!best) return { session: null, week: null, weekModel: null, observedAt: null, source: null };
    // la semaine Fable n'arrive que par les vraies sessions : on la reprend d'un relevé plus ancien mais encore valable
    if (!best.weekModel) best.weekModel = cands.find((c) => c.weekModel)?.weekModel || null;
    return best;
  }

  // ---------- relevé d'usage par une requête minimale ----------
  // ~1 000 tokens sur le plus petit modèle (mesuré : 0,0002 $), sans MCP, sans réglages ni hooks, sans
  // conversation enregistrée. La réponse porte les fenêtres de quota du compte (rate_limit_event) ; on
  // n'utilise jamais les jetons nous-mêmes.
  const lastPing = new Map();
  const inflight = new Set();
  const PING_MIN_GAP = 10 * 60_000;
  // Un relevé à la fois : chaque relevé peut renouveler le jeton de son compte, et le trousseau sature vite
  // (2026-10-23 : trois relevés lancés ensemble au démarrage du Mac, avec toutes les conversations de VS Code).
  let pingChain = Promise.resolve();
  function ping(acc) {
    return new Promise((resolve) => {
      if (!claudeBin) return resolve(false);
      const env = { ...process.env };
      if (acc.configDir) env.CLAUDE_CONFIG_DIR = acc.configDir; else delete env.CLAUDE_CONFIG_DIR;
      let out = '';
      let child;
      try {
        child = spawn(claudeBin, ['-p', '.', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose',
          '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--no-session-persistence', '--system-prompt', 'Réponds un seul caractère.'],
        { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { return resolve(false); }
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.on('data', (d) => { out += d; if (out.length > 2_000_000) child.kill(); });
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', () => {
        clearTimeout(timer);
        for (const line of out.split('\n')) {
          let m; try { m = JSON.parse(line); } catch { continue; }
          const w = m?.type === 'rate_limit_event' ? m.rate_limit_info?.unifiedWindows : null;
          if (!w) continue;
          const win = (x) => (x && num(x.utilization) !== null ? { pct: Math.round(x.utilization * 100), resetsAt: num(x.resetsAt) !== null ? iso(x.resetsAt * 1000) : null } : null);
          try {
            fs.mkdirSync(PING_DIR, { recursive: true });
            writeAtomic(path.join(PING_DIR, `${acc.id}.json`), JSON.stringify({ session: win(w.five_hour), week: win(w.seven_day), weekModel: null, observedAt: new Date().toISOString() }) + '\n');
          } catch { /* relevé suivant */ }
          return resolve(true);
        }
        resolve(false);
      });
    });
  }
  function startRefresh(ids, force) {
    const model = load();
    const started = [];
    if (!claudeBin) return started;
    for (const acc of model.accounts) {
      if (ids && !ids.includes(acc.id)) continue;
      if (!isConnected(acc, claudeJson(acc))) continue;
      if (!force && Date.now() - (lastPing.get(acc.id) || 0) < PING_MIN_GAP) continue;
      if (force && Date.now() - (lastPing.get(acc.id) || 0) < 60_000) continue; // un clic répété ne relance pas
      lastPing.set(acc.id, Date.now());
      started.push(acc.id);
      const p = pingChain.then(() => ping(acc));
      pingChain = p.catch(() => {});
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
    return started;
  }

  // ---------- liens ----------
  function inspect(configDir, e) {
    const p = path.join(configDir, e.name);
    const target = path.join(CLAUDE_DIR, e.name);
    const targetExists = exists(target);
    let st;
    try { st = fs.lstatSync(p); } catch { return { state: targetExists || !e.dir ? 'missing' : 'absent', p, target }; }
    if (st.isSymbolicLink()) {
      let same = false;
      try { same = fs.realpathSync(p) === fs.realpathSync(target); } catch {
        try { same = path.resolve(path.dirname(p), fs.readlinkSync(p)) === target; } catch { same = false; }
      }
      if (!same) return { state: 'wrong', p, target };
      if (!targetExists && e.dir) return { state: 'broken', p, target };
      return { state: 'ok', p, target };
    }
    if (st.isDirectory()) {
      let empty = false;
      try { empty = fs.readdirSync(p).length === 0; } catch { /* illisible */ }
      return { state: empty && targetExists ? 'emptyDir' : 'separate', p, target };
    }
    return { state: targetExists ? 'file' : 'separate', p, target };
  }
  function repairOne(acc, e, notices) {
    const r = inspect(acc.configDir, e);
    const out = { name: e.name, state: r.state };
    try {
      if (r.state === 'missing') {
        fs.symlinkSync(r.target, r.p);
        out.state = 'created';
      } else if (r.state === 'wrong') {
        fs.unlinkSync(r.p);
        fs.symlinkSync(r.target, r.p);
        out.state = 'relinked';
      } else if (r.state === 'emptyDir') {
        fs.rmdirSync(r.p);
        fs.symlinkSync(r.target, r.p);
        out.state = 'relinked';
      } else if (r.state === 'file') {
        // Claude Code a remplacé le lien par un fichier (écriture par renommage) : on garde sa copie,
        // on ne fusionne rien, on remet le lien et on le signale.
        const backup = `${r.p}.bak-vigie-${stamp()}`;
        fs.renameSync(r.p, backup);
        fs.symlinkSync(r.target, r.p);
        out.state = 'relinked';
        out.backup = backup;
        notices.push(`${acc.label} : ${e.name} remplacé par Claude Code, copie gardée.`);
      } else if (r.state === 'separate') {
        notices.push(`${acc.label} : ${e.name} séparé de ~/.claude, à vérifier.`);
      } else if (r.state === 'broken') {
        // Claude Code a effacé ce dossier de ~/.claude (ménage des shell-snapshots…) : le recréer vide, comme il le
        // ferait lui-même, répare le lien sans rien toucher d'autre.
        fs.mkdirSync(r.target, { recursive: true, mode: 0o700 });
        out.state = 'created';
      }
    } catch {
      out.state = 'error';
      notices.push(`${acc.label} : ${e.name} n'a pas pu être relié.`);
    }
    return out;
  }
  function dirReady(acc) {
    if (!acc.configDir) return true;
    if (!exists(acc.configDir)) return false;
    const p = inspect(acc.configDir, SHARED[0]).state;
    const s = inspect(acc.configDir, SHARED.find((e) => e.name === 'settings.json')).state;
    return p === 'ok' && (s === 'ok' || s === 'absent');
  }

  // ---------- conversations vivantes ----------
  function registryDirs(model) {
    const dirs = [path.join(CLAUDE_DIR, 'sessions')];
    for (const a of model.accounts) {
      if (!a.configDir) continue;
      const d = path.join(a.configDir, 'sessions');
      try { if (!fs.lstatSync(d).isSymbolicLink()) dirs.push(d); } catch { /* absent */ }
    }
    return dirs;
  }
  function readRegistry(model, pid) {
    for (const d of registryDirs(model)) {
      const r = readJson(path.join(d, `${pid}.json`));
      if (r) return r;
    }
    return null;
  }
  function liveList(model, liveSessions) {
    if (liveSessions instanceof Map) return [...liveSessions.values()];
    if (Array.isArray(liveSessions)) return liveSessions;
    if (liveSessions && typeof liveSessions === 'object') return Object.values(liveSessions);
    const out = [];
    for (const d of registryDirs(model)) {
      let names = [];
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const f of names) {
        if (!/^\d+\.json$/.test(f)) continue;
        const r = readJson(path.join(d, f));
        if (!r?.pid) continue;
        try { process.kill(r.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; } // signal 0 : simple test de vie
        out.push(r);
      }
    }
    return out;
  }
  const findLive = (list, sid) => list.find((s) => s && s.sessionId === sid) || null;
  const pendingLogAt = new Map();
  function quiet(live) {
    if (!live || live.status !== 'idle') return false;
    if (Number(live.agentsRunning) > 0 || Number(live.workflowsRunning) > 0 || live.busy === true) return false;
    const since = Number(live.statusUpdatedAt || live.updatedAt || 0);
    return !since || Date.now() - since >= IDLE_SETTLE_MS;
  }
  // Commandes de fond encore en cours (Bash run_in_background, Monitor, serveur de dev…) : arrêter la
  // conversation les tuerait. Claude Code lance chaque commande par un shell enfant direct
  // (« zsh -c source …/shell-snapshots/snapshot-… ») : au repos, il n'en reste que pour les commandes de fond.
  // Le serveur peut aussi en donner le nombre (bgRunning, lu dans le transcript).
  // Renvoie le nombre, ou -1 si on ne peut pas savoir (alors on ne coupe pas).
  function backgroundCount(live) {
    // Chaque commande de fond (Bash en fond, Monitor, serveur de dev) est un shell enfant direct du processus ;
    // les MCP stdio aussi sont des enfants, mais ce ne sont pas des shells. Le transcript ne fait plus foi : une
    // tâche arrêtée sans notification y restait « en cours » et bloquait la bascule (2026-10-20).
    const pid = Number(live?.pid);
    if (!Number.isInteger(pid) || pid <= 1) return -1;
    let r;
    try { r = runner('/usr/bin/pgrep', ['-P', String(pid)], { capture: true }); } catch { return -1; }
    if (r.status === 1) return 0; // aucun enfant
    if (r.status !== 0) return -1;
    let n = 0;
    for (const c of String(r.stdout).split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l))) {
      let comm;
      try { comm = runner('/bin/ps', ['-o', 'comm=', '-p', c], { capture: true }); } catch { return -1; }
      if (comm.status === 0 && /(^|\/)-?(zsh|bash|sh|dash|fish)$/.test(String(comm.stdout).trim())) n++;
    }
    return n;
  }
  // Au repos et sans commande de fond : la bascule peut se faire. 'background' : on attend qu'elles finissent.
  function readyToStop(live) {
    if (!quiet(live)) return 'busy';
    const bg = backgroundCount(live);
    return bg === 0 ? 'ok' : bg > 0 ? 'background' : 'busy';
  }

  // Seules les conversations de VS Code repartent par le lanceur : arrêter une conversation du terminal
  // la terminerait pour de bon.
  function fromVscode(model, live) {
    const ep = live?.entrypoint ?? readRegistry(model, Number(live?.pid))?.entrypoint;
    return /vscode/i.test(String(ep || ''));
  }

  // data/launches/<pid>, écrit par le lanceur : « epoch  pid  compte  conversation|-  raison ».
  function launchOf(live) {
    const pid = Number(live?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let line;
    try { line = fs.readFileSync(path.join(LAUNCH_DIR, String(pid)), 'utf8').split('\n')[0]; } catch { return null; }
    const [ts, p, account, sid, reason] = line.split('\t');
    if (!/^\d+$/.test(ts || '') || Number(p) !== pid || !ID_RE.test(account || '')) return null;
    const rec = { ts: Number(ts) * 1000, account, sessionId: sid === '-' ? null : sid, reason };
    const started = Number(live.startedAt);
    if (started && Math.abs(rec.ts - started) > PIN_WINDOW_MS) return null; // pid recyclé
    return rec;
  }
  // Lancements notés par le lanceur pour une conversation (data/launches.log) : les 10 derniers.
  function launchHistory(sid) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dataDir, 'launches.log'), 'utf8').split('\n'); } catch { return []; }
    const out = [];
    for (const l of lines) {
      const [ts, , account, s2, reason] = l.split('\t');
      if (s2 === sid && /^\d+$/.test(ts || '') && ID_RE.test(account || '')) out.push({ ts: new Date(Number(ts) * 1000).toISOString(), accountId: account, reason: reason || null });
    }
    return out.slice(-10);
  }
  // Compte sur lequel tourne vraiment le processus : celui du lanceur, sinon Travail 1 (lancé sans lanceur).
  const runningAccount = (live) => launchOf(live)?.account || MAIN_ID;
  // Fichiers de processus disparus : on fait le ménage (signal 0 = simple test de vie).
  function pruneLaunches() {
    let names = [];
    try { names = fs.readdirSync(LAUNCH_DIR); } catch { return; }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      try { process.kill(Number(n), 0); } catch (e) {
        if (e.code === 'ESRCH') { try { fs.unlinkSync(path.join(LAUNCH_DIR, n)); } catch { /* déjà parti */ } }
      }
    }
  }

  // Termine le processus d'une conversation au repos, après avoir vérifié que c'est bien le sien.
  // Arrêt d'une conversation pour la bascule : SIGINT, que Claude Code traite comme une fin propre (code 0 :
  // VS Code n'affiche pas d'erreur, vérifié sur 2.1.304) ; SIGTERM (code 143, bandeau rouge) seulement en secours,
  // si le même processus tourne encore 4 s plus tard (en plein travail, SIGINT peut n'interrompre que le tour).
  function stopProcess(model, live, sid, { force = false } = {}) {
    const pid = Number(live?.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    const reg = readRegistry(model, pid);
    if (!reg || reg.sessionId !== sid || Number(reg.pid) !== pid || (!force && reg.status !== 'idle')) return false;
    if (!/vscode/i.test(String(reg.entrypoint || ''))) return false;
    const comm = runner('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { capture: true });
    if (comm.status !== 0 || path.basename(comm.stdout.trim()) !== 'claude') return false;
    if (reg.procStart) {
      // Claude Code note l'heure de démarrage telle que la donne ps en UTC : un pid recyclé ne colle pas
      const ls = runner('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { capture: true, env: { TZ: 'UTC' } });
      const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
      if (ls.status !== 0 || norm(ls.stdout) !== norm(reg.procStart)) return false;
    }
    try { kill(pid, 'SIGINT'); } catch { return false; }
    const same = () => {
      const r = readRegistry(model, pid);
      if (!r || r.sessionId !== sid || Number(r.pid) !== pid) return false;
      if (!reg.procStart) return true;
      const ls = runner('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { capture: true, env: { TZ: 'UTC' } });
      return ls.status === 0 && ls.stdout.trim().replace(/\s+/g, ' ') === String(reg.procStart).trim().replace(/\s+/g, ' ');
    };
    const t = setTimeout(() => { try { if (same()) kill(pid, 'SIGTERM'); } catch { /* déjà fini */ } }, stopGraceMs);
    t.unref?.();
    return true;
  }

  // Épingle les conversations neuves au compte sur lequel le lanceur les a démarrées : sinon, à la prochaine
  // reprise, elle suivrait le compte par défaut du moment. Jamais un lancement de repli (le compte voulu était
  // déconnecté) ni celui qui sert à connecter le compte du Mac : elles retrouveront leur compte à la reprise.
  function pinLaunched(model, list) {
    const pinned = [];
    for (const live of list) {
      const sid = live?.sessionId;
      if (!sid || !UUID_RE.test(sid) || model.sessions[sid]) continue;
      const rec = launchOf(live);
      if (!rec || !find(model, rec.account) || /^(repli:|connexion-du-mac$)/.test(rec.reason || '')) continue;
      model.sessions[sid] = rec.account;
      pinned.push({ sessionId: sid, accountId: rec.account });
    }
    return pinned;
  }

  // ---------- VS Code ----------
  function settingsFile() {
    try { return fs.realpathSync(vscodeSettingsPath); } catch { return vscodeSettingsPath; } // lien éventuel : on écrit la cible
  }
  function wrapperSetting() {
    let text;
    try { text = fs.readFileSync(settingsFile(), 'utf8'); } catch { return { ok: true, value: null, missing: true }; }
    try {
      const v = parseJsonc(text)?.[WRAPPER_KEY];
      return { ok: true, value: typeof v === 'string' ? v : null, text };
    } catch { return { ok: false, value: null, text }; }
  }
  function wrapperActive() {
    const s = wrapperSetting();
    return s.ok && s.value === wrapperPath;
  }

  // ---------- API ----------
  const api = {
    paths: { dataDir, home, accountsRoot, vscodeSettingsPath, wrapperPath, file: FILE, launches: LAUNCH_DIR },

    load,

    summaries() {
      const model = load();
      const status = loginStatus();
      return model.accounts.map((acc) => {
        const cj = claudeJson(acc);
        const st = status[acc.id];
        return {
          id: acc.id,
          label: acc.label,
          email: typeof cj?.oauthAccount?.emailAddress === 'string' ? cj.oauthAccount.emailAddress : null,
          expectedEmail: acc.expectedEmail || null,
          connected: isConnected(acc, cj, status),
          // vu par le coffre : ok | restored (remise par Vigie à ce passage) | restoring (remise en cours) | lost (perdue,
          // pas de copie à remettre) | dead (refusée par Anthropic) | logged-out | unknown ; null sans état récent
          login: st && typeof st.state === 'string' ? {
            state: st.state,
            since: typeof st.since === 'string' ? st.since : null,
            restoredAt: typeof st.restoredAt === 'string' ? st.restoredAt : null,
          } : null,
          // connecté avec une autre adresse que celle prévue pour ce compte (ex. le perso dans la case Travail 1)
          wrongAccount: !!(acc.expectedEmail && normEmail(cj?.oauthAccount?.emailAddress) && normEmail(cj.oauthAccount.emailAddress) !== acc.expectedEmail),
          isDefault: model.defaultForNew === acc.id,
          usage: usageOf(cj, acc),
        };
      });
    },

    view() {
      const model = load();
      const sums = api.summaries();
      return {
        accounts: sums.map((s) => {
          const acc = find(model, s.id);
          return { ...s, configDir: acc.configDir, keychainItem: keychainItem(acc.configDir), dirReady: dirReady(acc) };
        }),
        defaultForNew: model.defaultForNew,
        wrapper: { path: wrapperPath, active: wrapperActive() },
      };
    },

    create(label, email) {
      const expectedEmail = normEmail(email);
      const model = load();
      const name = cleanLabel(label) || (expectedEmail && (model.labelsByEmail[expectedEmail] || friendlyLabel(expectedEmail)));
      if (!name) return { ok: false, error: 'Donne un nom au compte.' };
      if (expectedEmail && model.accounts.some((a) => a.expectedEmail === expectedEmail)) return { ok: false, error: 'Ce compte existe déjà.' };
      const base = slugify(name);
      let id = base;
      for (let k = 2; model.accounts.some((a) => a.id === id) || id === MAIN_ID; k++) id = `${base}-${k}`;
      const configDir = path.join(accountsRoot, id);
      try {
        fs.mkdirSync(accountsRoot, { recursive: true, mode: 0o700 });
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 }); // déjà là : on l'adopte sans rien écraser
      } catch { return { ok: false, error: 'Impossible de créer le dossier du compte.' }; }
      const acc = { id, label: name, configDir, ...(expectedEmail ? { expectedEmail } : {}) };
      if (expectedEmail) model.labelsByEmail[expectedEmail] = name;
      const notices = [];
      const links = SHARED.map((e) => repairOne(acc, e, notices));
      // .claude.json de départ : MCP et confiance des dossiers, jamais la connexion ni les caches.
      const cjPath = path.join(configDir, '.claude.json');
      let copied = false;
      if (!exists(cjPath)) {
        const src = readJson(path.join(home, '.claude.json'));
        if (src && typeof src === 'object') {
          const init = {};
          if (src.mcpServers && typeof src.mcpServers === 'object') init.mcpServers = structuredClone(src.mcpServers);
          const projects = {};
          for (const [p, v] of Object.entries(src.projects && typeof src.projects === 'object' ? src.projects : {})) {
            if (!v || typeof v !== 'object') continue;
            const keep = {};
            for (const k of PROJECT_KEYS) if (k in v) keep[k] = structuredClone(v[k]);
            if (Object.keys(keep).length) projects[p] = keep;
          }
          if (Object.keys(projects).length) init.projects = projects;
          try {
            // 600 : peut contenir des clés d'API de MCP, comme ~/.claude.json
            fs.writeFileSync(cjPath, JSON.stringify(init, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            copied = true;
          } catch { /* créé entre-temps : on n'y touche pas */ }
        }
      }
      model.accounts.push(acc);
      save(model);
      return {
        ok: true,
        account: { id, label: name, configDir, keychainItem: keychainItem(configDir), dirReady: dirReady(acc) },
        links,
        mcpCopied: copied,
        notices,
        message: 'Dossier prêt. Connecte le compte.',
      };
    },

    health({ repair = true } = {}) {
      const model = load();
      const notices = [];
      const accounts = [];
      for (const acc of model.accounts) {
        if (!acc.configDir) { accounts.push({ id: acc.id, label: acc.label, configDir: null, ready: true, links: [] }); continue; }
        if (!exists(acc.configDir)) {
          notices.push(`${acc.label} : dossier du compte absent.`);
          accounts.push({ id: acc.id, label: acc.label, configDir: acc.configDir, ready: false, links: [] });
          continue;
        }
        const links = SHARED.map((e) => (repair ? repairOne(acc, e, notices) : { name: e.name, state: inspect(acc.configDir, e).state }));
        accounts.push({ id: acc.id, label: acc.label, configDir: acc.configDir, ready: dirReady(acc), links });
      }
      const bad = accounts.some((a) => !a.ready || a.links.some((l) => ['separate', 'broken', 'error', 'wrong', 'file', 'missing', 'emptyDir'].includes(l.state)));
      return { ok: !bad, accounts, notices };
    },

    connect(id) {
      const model = load();
      const acc = find(model, id);
      if (!acc) return { ok: false, error: 'Compte inconnu.' };
      if (acc.configDir) {
        if (!exists(acc.configDir)) return { ok: false, error: 'Dossier du compte absent.' };
        for (const e of SHARED) repairOne(acc, e, []);
      }
      // Sans Terminal : `claude auth login` ouvre la page de connexion dans le navigateur (adresse prévue déjà
      // remplie) et récupère la connexion tout seul (vérifié le 2026-10-20). L'utilisateur se connecte lui-même ; rien
      // d'automatique au-delà. Terminal reste le repli.
      const email = acc.expectedEmail;
      let lr = { status: 1 };
      if (claudeBin) {
        try {
          lr = runner(claudeBin, ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])],
            { detach: true, env: acc.configDir ? { CLAUDE_CONFIG_DIR: acc.configDir } : {} });
        } catch { lr = { status: 1 }; }
      }
      if (lr?.status === 0) return { ok: true, message: `La page de connexion s'ouvre dans ton navigateur${email ? ` : connecte-toi avec ${email}` : ''}.` };
      // Repli : Terminal sur le bon dossier, rien de plus.
      const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const hint = `Compte ${acc.label} : tape /login, avec ce compte ouvert sur claude.ai dans ton navigateur.`;
      // la copie de l'extension VS Code n'est pas dans le PATH de l'utilisateur : nommée en entier
      const bin = isEditorCopy(claudeBin) ? shq(claudeBin) : 'claude';
      const cmd = `clear; printf '%s\\n\\n' ${shq(hint)}; ${acc.configDir ? `CLAUDE_CONFIG_DIR=${shq(acc.configDir)} ` : ''}${bin}`;
      const asq = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const lines = ['tell application "Terminal"', 'activate', `do script ${asq(cmd)}`, 'end tell'];
      let r;
      // appel bloquant dans le serveur : délai court ; si macOS demande l'autorisation, on passe au repli
      try { r = runner('/usr/bin/osascript', lines.flatMap((l) => ['-e', l]), { capture: true, timeout: 5000 }); } catch { r = { status: 1 }; }
      if (r.status !== 0) {
        // osascript refusé (autorisation d'automatisation) : un fichier .command s'ouvre dans Terminal sans elle
        try {
          const f = path.join(dataDir, `connecter-${acc.id}.command`);
          writeAtomic(f, `#!/bin/bash\n${cmd}\n`, 0o700);
          r = runner('/usr/bin/open', ['-a', 'Terminal', f], { capture: true });
        } catch { r = { status: 1 }; }
      }
      if (r.status !== 0) return { ok: false, error: "Impossible d'ouvrir Terminal." };
      return { ok: true, message: 'Terminal est ouvert : tape /login.' };
    },

    setDefault(id) {
      const model = load();
      const acc = find(model, id);
      if (!acc) return { ok: false, error: 'Compte inconnu.' };
      model.defaultForNew = id;
      save(model);
      const ready = !acc.configDir || (dirReady(acc) && isConnected(acc));
      return { ok: true, message: ready ? null : `Pas encore connecté : les nouvelles conversations restent sur ${find(model, MAIN_ID).label} en attendant.` };
    },

    rename(id, label) {
      const name = cleanLabel(label);
      if (!name) return { ok: false, error: 'Donne un nom au compte.' };
      const model = load();
      const acc = find(model, id);
      if (!acc) return { ok: false, error: 'Compte inconnu.' };
      acc.label = name; // l'identifiant et le dossier ne changent jamais (le trousseau en dépend)
      // Le nom suit l'adresse : on le note aussi pour elle (le compte principal change d'adresse au /login).
      const email = normEmail(claudeJson(acc)?.oauthAccount?.emailAddress) || acc.expectedEmail;
      if (email) model.labelsByEmail[email] = name;
      save(model);
      return { ok: true };
    },

    // Compte de la conversation. Sans choix noté, le lanceur la reprend sur le compte des nouvelles conversations.
    accountOf(sessionId) {
      return chosenAccount(load(), sessionId);
    },
    sessionAccount(sessionId) {
      const model = load();
      return { accountId: chosenAccount(model, sessionId), pendingTo: model.pendingSwitches[sessionId]?.to || null };
    },
    // Conversations ouvertes lancées sur un autre compte que le leur, parce que le leur ne marchait pas (journal du
    // lanceur : « repli:<voulu>:<raison> »).
    fallbacks(liveSessions) {
      const model = load();
      const out = [];
      for (const live of liveList(model, liveSessions)) {
        const rec = launchOf(live);
        const m = /^repli:([a-z0-9][a-z0-9-]{0,31}):([a-z-]{1,40})$/.exec(rec?.reason || '');
        if (!m || !live?.sessionId || !UUID_RE.test(live.sessionId)) continue;
        out.push({ sessionId: live.sessionId, wanted: m[1], running: rec.account, why: m[2] });
      }
      return out;
    },

    switchConversation(sessionId, accountId, { liveSessions, contextTokens, now = false } = {}) {
      if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return { ok: false, error: 'Conversation inconnue.' };
      const model = load();
      const acc = find(model, accountId);
      if (!acc) return { ok: false, error: 'Compte inconnu.' };
      if (acc.configDir && !dirReady(acc)) return { ok: false, error: 'Le dossier de ce compte est incomplet.' };
      if (acc.configDir && !isConnected(acc)) return { ok: false, error: `${acc.label} n'est pas connecté.` };
      const estimate = rereadEstimate(contextTokens);
      const say = (state, text, cost = true) => ({ ok: true, switch: { state, message: cost && estimate ? `${text} ${estimate}` : text, estimate } });

      model.sessions[sessionId] = accountId;
      delete model.pendingSwitches[sessionId];
      const live = findLive(liveList(model, liveSessions), sessionId);
      // fermée, ou ouverte dans le terminal (qui ne passe pas par le lanceur) : vaut pour la prochaine reprise
      if (!live || !fromVscode(model, live)) { save(model); return say('done', `C'est noté : elle reprendra sur ${acc.label}.`); }
      if (!wrapperActive()) { save(model); return say('done', "C'est noté. Active le choix du compte par conversation pour l'appliquer.", false); }
      if (runningAccount(live) === accountId) { save(model); return say('done', `Elle est déjà sur ${acc.label}.`, false); }
      const ready = readyToStop(live);
      if (ready === 'ok' && stopProcess(model, live, sessionId)) {
        model.stopped[sessionId] = { to: accountId, at: new Date().toISOString() };
        save(model);
        return say('done', `Envoie un message dans la conversation pour la relancer sur ${acc.label}.`);
      }
      // « Tout de suite » : on interrompt le travail en cours ; L'utilisateur écrit « continue » et elle reprend sur le compte.
      if (now && stopProcess(model, live, sessionId, { force: true })) {
        model.stopped[sessionId] = { to: accountId, at: new Date().toISOString() };
        save(model);
        return say('done', `Interrompue : écris « continue » dans la conversation pour la reprendre sur ${acc.label}.`);
      }
      model.pendingSwitches[sessionId] = { to: accountId, since: new Date().toISOString() };
      save(model);
      return say('pending', ready === 'background'
        ? `Elle passera sur ${acc.label} quand ses commandes de fond (serveur, tests…) seront finies.`
        : `Elle passera sur ${acc.label} dès qu'elle aura fini.`);
    },

    // Compte choisi, compte sur lequel le processus tourne vraiment (journal du lanceur ; sans lui : compte
    // principal), bascule en attente et historique des lancements de la conversation.
    accountInfo(sessionId, liveSessions, model = load()) {
      const live = findLive(liveList(model, liveSessions), sessionId);
      const p = model.pendingSwitches[sessionId];
      return {
        chosen: chosenAccount(model, sessionId),
        running: live ? runningAccount(live) : null,
        pending: p ? { to: p.to, since: p.since } : null,
        history: launchHistory(sessionId),
      };
    },

    // Arrêtée pour une bascule, pas encore relancée : { to, at } ou null (elle attend un message de l'utilisateur).
    stoppedFor(sessionId, model = load()) {
      return model.stopped?.[sessionId] || null;
    },

    // À appeler régulièrement (ex. toutes les 3 s) avec les conversations vivantes (indexer.live).
    processPending(liveSessions) {
      const model = load();
      // Fichier abîmé ou illisible : rien d'automatique (sinon il serait remplacé par un modèle vide en
      // quelques secondes). Le lanceur repart déjà sur Travail 1 en attendant que l'utilisateur le répare.
      if (model[FROM]) return { applied: [], pinned: [] };
      const list = liveList(model, liveSessions);
      const pinned = pinLaunched(model, list);
      pruneLaunches();
      const applied = [];
      let dropped = 0;
      const active = Object.keys(model.pendingSwitches).length ? wrapperActive() : false;
      for (const [sid, p] of Object.entries(model.pendingSwitches)) {
        const acc = find(model, p.to);
        const live = findLive(list, sid);
        // lanceur coupé entre-temps : la bascule n'a plus de sens
        if (!acc || !active) { delete model.pendingSwitches[sid]; dropped++; continue; }
        if (!live) { delete model.pendingSwitches[sid]; applied.push({ sessionId: sid, to: p.to, state: 'closed', message: `Elle reprendra sur ${acc.label}.` }); continue; }
        if (runningAccount(live) === p.to || !fromVscode(model, live)) { delete model.pendingSwitches[sid]; dropped++; continue; }
        const ready = readyToStop(live);
        if (ready === 'ok' && stopProcess(model, live, sid)) {
          delete model.pendingSwitches[sid];
          model.stopped[sid] = { to: p.to, at: new Date().toISOString() };
          applied.push({ sessionId: sid, to: p.to, state: 'done', message: `Envoie un message dans la conversation pour la relancer sur ${acc.label}.` });
        } else {
          // Diagnostic (2026-10-20 : une bascule restée en attente 80 min) : une ligne par minute au plus.
          const k = `${sid}:${ready}`;
          if (Date.now() - (pendingLogAt.get(k) || 0) > 60_000) {
            pendingLogAt.set(k, Date.now());
            console.error(`[vigie] bascule en attente ${sid.slice(0, 8)} → ${p.to} : ${ready === 'ok' ? 'arrêt refusé (vérification du processus)' : ready}`
              + ` (état ${live.status}, agents ${live.agentsRunning || 0}, workflows ${live.workflowsRunning || 0}, fond ${live.bgRunning || 0}, pid ${live.pid})`);
          }
        }
      }
      let resumed = 0;
      for (const [sid, s] of Object.entries(model.stopped)) {
        const live = findLive(list, sid);
        if ((live && Number(live.startedAt) >= Date.parse(s.at) - 1000) || !(Date.now() - Date.parse(s.at) < STOPPED_MS)) {
          delete model.stopped[sid]; resumed++;
        }
      }
      if (pinned.length || applied.length || dropped || resumed) save(model);
      return { applied, pinned };
    },

    wrapperActive,

    // Connecté pour de vrai (état du coffre s'il est frais, sinon trousseau) ?
    connected(id) {
      const acc = find(load(), id);
      return !!acc && isConnected(acc);
    },

    // Relevé automatique : un compte connecté dont le dernier relevé a plus de 30 min (au plus toutes les 10 min).
    // À appeler dans la boucle du serveur (toutes les 60 s suffisent). calm : faux tant que le Mac démarre ou que des
    // conversations se lancent (le serveur en juge) : rien ne part alors.
    autoRefresh({ calm = true } = {}) {
      if (!calm) return [];
      const model = load();
      const due = model.accounts.filter((acc) => {
        const u = usageOf(claudeJson(acc), acc);
        return !u.observedAt || Date.now() - Date.parse(u.observedAt) > 30 * 60_000;
      }).map((a) => a.id);
      return due.length ? startRefresh(due, false) : [];
    },
    // Fin des relevés en cours (tests, arrêt propre du serveur).
    refreshSettled() { return Promise.all([...inflight]); },

    wrapper(enable) {
      const cur = wrapperSetting();
      if (!cur.ok) return { ok: false, error: 'Réglages VS Code illisibles : rien n\'a été changé.' };
      if (enable) {
        if (cur.value === wrapperPath) return { ok: true, active: true, message: 'Déjà activé.' };
        if (cur.value) return { ok: false, error: 'Un autre lanceur est déjà réglé dans VS Code : rien n\'a été changé.' };
        try {
          if (!path.isAbsolute(wrapperPath) || /\.(m?js|tsx?|jsx)$/.test(wrapperPath)) throw new Error('chemin');
          fs.accessSync(wrapperPath, fs.constants.X_OK);
        } catch { return { ok: false, error: 'Lanceur introuvable.' }; }
      } else if (cur.value !== wrapperPath) {
        return { ok: true, active: false, message: cur.value ? "Ce n'est pas le lanceur de Vigie : rien n'a été changé." : 'Déjà désactivé.' };
      }
      const file = settingsFile();
      const before = cur.missing ? '' : cur.text;
      let after;
      let parsedBefore;
      try {
        parsedBefore = before.trim() ? parseJsonc(before) : {};
        after = setJsoncKey(before, WRAPPER_KEY, enable ? wrapperPath : undefined);
        // relecture : seule notre clé a bougé, sinon on n'écrit rien
        const parsedAfter = parseJsonc(after);
        const strip = (o) => { const c = { ...o }; delete c[WRAPPER_KEY]; return JSON.stringify(c); };
        if (strip(parsedAfter) !== strip(parsedBefore)) throw new Error('écart');
        if (enable ? parsedAfter[WRAPPER_KEY] !== wrapperPath : WRAPPER_KEY in parsedAfter) throw new Error('clé');
      } catch { return { ok: false, error: 'Réglages VS Code illisibles : rien n\'a été changé.' }; }
      let backup = null;
      try {
        let mode = 0o644;
        if (!cur.missing) {
          mode = fs.statSync(file).mode & 0o777;
          backup = `${file}.bak-vigie-${stamp()}`;
          fs.copyFileSync(file, backup);
        }
        writeAtomic(file, after, mode);
      } catch { return { ok: false, error: "Impossible d'écrire les réglages de VS Code." }; }
      return {
        ok: true,
        active: enable,
        backup,
        message: enable
          ? 'Activé : chaque conversation prendra son compte à sa prochaine relance.'
          : `Désactivé : les conversations repartent sur ${find(load(), MAIN_ID).label} à leur prochaine relance.`,
      };
    },

    // Raccourci pour POST /api/v2/accounts.
    apply(body = {}) {
      switch (body?.action) {
        case 'create': return api.create(body.label, body.email);
        case 'rename': return api.rename(body.id, body.label);
        case 'setDefault': return api.setDefault(body.id);
        case 'connect': return api.connect(body.id);
        case 'wrapper': return api.wrapper(body.enable === true);
        case 'health': return api.health();
        case 'refresh': {
          if (body.id !== undefined && (typeof body.id !== 'string' || !find(load(), body.id))) return { ok: false, error: 'Compte inconnu.' };
          if (!claudeBin) return { ok: false, error: 'Claude Code introuvable : relevé impossible.' };
          const ids = typeof body.id === 'string' ? [body.id] : null;
          const model = load();
          if (!model.accounts.some((a) => (!ids || ids.includes(a.id)) && isConnected(a, claudeJson(a)))) {
            return { ok: false, error: ids ? 'Ce compte n\'est pas connecté.' : 'Aucun compte connecté.' };
          }
          const started = startRefresh(ids, true);
          return { ok: true, started, message: started.length ? 'Relevé en cours, quelques secondes.' : 'Relevé déjà fait il y a moins d\'une minute.' };
        }
        default: return { ok: false, error: 'Action inconnue.' };
      }
    },
  };
  return api;
}
