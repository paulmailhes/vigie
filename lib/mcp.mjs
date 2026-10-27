// MCP : inventaire des trois étages (projets, Mac, connecteurs de compte) et modifications sûres.
// Règle d'or : aucune valeur secrète ne sort d'ici. Les valeurs d'env et de headers, les paramètres
// d'URL et les arguments qui ressemblent à des clés deviennent •••• avant d'être renvoyés.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { DATA } from './state.mjs';
import { findClaudeBin } from './claude-bin.mjs';

export const MASK = '••••';
// Règle de `claude mcp add` : « Names can only contain letters, numbers, hyphens, and underscores ».
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Entrée de projet par défaut de Claude Code (binaire 2.1.301, `Jme`) : quand on crée une entrée
// absente, on la crée comme lui, sinon il lirait des champs manquants.
const PROJECT_DEFAULTS = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
};
const LOCK_STALE_MS = 10_000; // seuil de proper-lockfile, utilisé par Claude Code pour .claude.json
const NEEDS_AUTH_MAX_AGE_MS = 7 * 86_400_000;

// Erreur dont le message est montré tel quel à l'utilisateur (court, en français, sans secret).
export class McpError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entriesOf = (m) => (m instanceof Map ? [...m.entries()] : isObj(m) ? Object.entries(m) : []);

export function serverType(config) {
  const c = config || {};
  return c.type || (c.url ? 'http' : 'stdio');
}

// Nom tel qu'il apparaît dans les outils (`mcp__<nom>__outil`) : Claude Code remplace le reste par _.
export const toolKey = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

// ---------- service reconnu (pour l'icône) ----------

// Identifiants du contrat (docs/api-v2.md, « Icônes ») d'abord ; quelques services en plus que l'app
// sait aussi reconnaître ; « autre » sinon. L'ordre compte : le premier qui correspond gagne.
const SEP = '[\\s._-]*';
const SERVICES = [
  ['claude-docs', new RegExp(`claude${SEP}docs`)], ['google-drive', new RegExp(`google${SEP}drive|gdrive`)],
  ['google-calendar', new RegExp(`google${SEP}calendar|gcal`)], ['google-sheets', new RegExp(`google${SEP}sheets`)], ['gmail', /gmail/],
  ['figma', /figma/], ['webflow', /webflow/], ['notion', /notion/], ['supabase', /supabase/], ['vercel', /vercel/],
  ['netlify', /netlify/], ['n8n', /n8n/], ['obsidian', /obsidian/], ['artlist', /artlist/], ['anarlog', /anarlog/],
  ['github', /github/], ['paddle', /paddle/], ['fusion', /fusion|autodesk/], ['resend', /resend/], ['stripe', /stripe/],
  ['slack', /slack/], ['pipedrive', /pipedrive/], ['qonto', /qonto/], ['pennylane', /pennylane/], ['gocardless', /gocardless/],
  ['magnific', /magnific/], ['metricool', /metricool/], ['semrush', /semrush/], ['vimeo', /vimeo/],
  // hors liste du contrat : l'app retombe sur le nom si elle ne les connaît pas
  ['linear', /\blinear\b|linear\.app/], ['sentry', /sentry/], ['airtable', /airtable/], ['canva', /canva/], ['hubspot', /hubspot/],
  ['docusign', /docusign/], ['atlassian', /atlassian|jira|confluence/], ['egnyte', /egnyte/], ['playwright', /playwright/],
  ['context7', /context7/], ['cloudflare', /cloudflare/], ['shopify', /shopify/], ['zapier', /zapier/], ['postgres', /postgres/],
  ['lemlist', /lemlist/], ['relume', /relume/], ['pappers', /pappers/], ['legifrance', new RegExp(`open${SEP}legi|legifrance`)],
  ['data-gouv', new RegExp(`data${SEP}gouv`)], ['google', /google/],
];
export const SERVICE_OTHER = 'autre';

// Le nom d'abord (« figma-perso », « claude.ai Gmail »), puis l'hôte de l'URL, puis la commande et ses arguments.
export function service(name, config) {
  const c = config || {};
  let host = '';
  try { host = new URL(String(c.url)).hostname; } catch { /* pas d'URL */ }
  const cmd = [c.command, ...(Array.isArray(c.args) ? c.args : [])].filter(Boolean).map(String).join(' ');
  const label = String(name || '').replace(/^claude\.ai\s+|^claude_ai_/i, '');
  for (const src of [label, host, cmd]) {
    const s = String(src || '').toLowerCase();
    if (!s) continue;
    for (const [id, re] of SERVICES) if (re.test(s)) return id;
  }
  return SERVICE_OTHER;
}

// ---------- masquage ----------

// Préfixes de jetons connus (OpenAI/Anthropic sk-, GitHub, GitLab, Slack, AWS, Google, JWT, Resend…).
const KNOWN_PREFIX = /^(?:(?:sk|rk|pk)[-_]|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|AKIA|ASIA|AIza|ya29\.|eyJ[\w-]{6,}|(?:npm|hf|pypi|sbp|re|fc|ntn|secret|lin_api|key)[_-][A-Za-z0-9]{8,})/;
const SECRET_NAME = /(key|token|secret|passw|pwd|auth|bearer|credential|signature|cookie|session|private)/i;

function looksLikeKey(value) {
  const s = String(value ?? '');
  if (s.length < 8) return false;
  if (KNOWN_PREFIX.test(s)) return true;
  if (s.length < 16 || /^[/.~@$]/.test(s) || /\s/.test(s)) return false; // chemin, paquet npm, ${VAR}
  if (/^[0-9a-f]{32,}$/i.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (!/^[A-Za-z0-9+/=_.\-:~]+$/.test(s)) return false;
  const longest = Math.max(...s.split(/[-_.:~/]/).map((r) => r.length));
  const digit = /\d/.test(s), lower = /[a-z]/.test(s), upper = /[A-Z]/.test(s);
  return (longest >= 16 && digit && (lower || upper)) || (longest >= 24 && lower && upper);
}

const isUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const isFlag = (s) => /^--?[A-Za-z][\w-]*$/.test(s);

export function maskUrl(raw) {
  const s = String(raw ?? '');
  let u;
  try { u = new URL(s); } catch {
    // ${VAR}/mcp ou adresse bancale : on masque au moins les paramètres et les morceaux suspects
    return looksLikeKey(s) ? MASK : scrub(s.replace(/([?&][^=&#]*=)[^&#]*/g, `$1${MASK}`).replace(/#.*$/, ''));
  }
  const auth = u.username || u.password ? `${MASK}@` : '';
  let p = u.pathname.split('/').map((seg) => {
    let d = seg; try { d = decodeURIComponent(seg); } catch { /* tel quel */ }
    return looksLikeKey(d) ? MASK : seg;
  }).join('/');
  if (p === '/' && !s.replace(/[?#].*$/, '').endsWith('/')) p = '';
  const keys = [...new Set(u.searchParams.keys())];
  const q = keys.length ? '?' + keys.map((k) => `${looksLikeKey(k) ? MASK : encodeURIComponent(k)}=${MASK}`).join('&') : '';
  return `${u.protocol}//${auth}${u.host}${p}${q}`;
}

const maskHeader = (h) => { const i = String(h).indexOf(':'); return i > 0 ? `${String(h).slice(0, i)}: ${MASK}` : MASK; };
const maskEnvPair = (e) => { const i = String(e).indexOf('='); return i > 0 ? `${String(e).slice(0, i)}=${MASK}` : MASK; };

function maskArg(arg, prev) {
  const a = String(arg ?? '');
  if (prev !== undefined && isFlag(prev) && !isFlag(a)) {
    if (/^(-H|--header)$/.test(prev)) return maskHeader(a);
    if (/^(-e|--env)$/.test(prev)) return maskEnvPair(a);
    const flag = prev.replace(/^-+/, '');
    if (flag.length > 1 && SECRET_NAME.test(flag) && !/^(no|without|disable)-/.test(flag)) return MASK;
  }
  if (isUrl(a)) return maskUrl(a);
  const kv = /^(-{0,2}[A-Za-z_][\w.-]*)([=:])([\s\S]*)$/.exec(a);
  if (kv && kv[3]) {
    const [, k, sep, v] = kv;
    if (/^(-H|--header)$/.test(k)) return `${k}${sep}${maskHeader(v)}`;
    if (SECRET_NAME.test(k)) return `${k}${sep}${MASK}`;
    if (isUrl(v)) return `${k}${sep}${maskUrl(v)}`;
    if (looksLikeKey(v)) return `${k}${sep}${MASK}`;
  }
  if (looksLikeKey(a)) return MASK;
  return scrub(a);
}

export function maskArgs(args) {
  const a = Array.isArray(args) ? args.map((x) => String(x ?? '')) : [];
  return a.map((x, i) => maskArg(x, i ? a[i - 1] : undefined));
}

// Dernier filet : jetons « Bearer xxx » et morceaux qui ressemblent à des clés dans un texte libre.
function scrub(text) {
  return String(text ?? '')
    .replace(/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, `$1 ${MASK}`)
    .split(/([\s'"=,;&?]+)/)
    .map((t) => (looksLikeKey(t) ? MASK : t))
    .join('');
}

const quote = (s) => (/[\s'"]/.test(s) && s !== MASK ? JSON.stringify(s) : s);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Texte lisible d'un serveur, sans secret : URL masquée ou commande + arguments masqués.
export function mask(config, { home = os.homedir() } = {}) {
  const c = config || {};
  let out;
  if (serverType(c) === 'stdio') {
    let cmd = String(c.command ?? '');
    if (home && cmd.startsWith(home + '/')) cmd = '~' + cmd.slice(home.length);
    const args = maskArgs(c.args).map((a) => (home ? a.split(home + '/').join('~/') : a));
    out = [cmd, ...args].map(quote).join(' ').trim();
  } else {
    out = c.url ? maskUrl(c.url) : '';
  }
  return clip(scrub(out), 200);
}

// Copie de la config pour un formulaire de modification : mêmes clés, valeurs secrètes masquées.
export function maskConfig(config) {
  const c = isObj(config) ? config : {};
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'env' || k === 'headers') out[k] = Object.fromEntries(Object.keys(isObj(v) ? v : {}).map((x) => [x, MASK]));
    else if (k === 'url') out.url = maskUrl(v);
    else if (k === 'args') out.args = maskArgs(v);
    else if (k === 'command' || k === 'type') out[k] = v;
    else if (k === 'oauth' && isObj(v)) out.oauth = { ...v, ...('clientSecret' in v ? { clientSecret: MASK } : {}) };
    else if (k === 'headersHelper') out[k] = MASK;
    else if (typeof v !== 'string' || !looksLikeKey(v)) out[k] = v;
    else out[k] = MASK;
  }
  return out;
}

// Remet les vraies valeurs à la place des •••• renvoyés par l'app (elle ne les a jamais vues).
export function unmask(next, prev) {
  if (!isObj(next)) throw new McpError('Configuration invalide');
  const p = isObj(prev) ? prev : {};
  const out = structuredClone(next);
  for (const k of ['env', 'headers']) {
    if (!isObj(out[k])) continue;
    for (const [key, v] of Object.entries(out[k])) {
      if (typeof v === 'string' && v.includes(MASK)) {
        if (!isObj(p[k]) || !(key in p[k])) throw new McpError(`Valeur masquée de ${key} à ressaisir`);
        out[k][key] = p[k][key];
      }
    }
  }
  if (typeof out.url === 'string' && out.url.includes(MASK)) {
    if (typeof p.url !== 'string' || maskUrl(p.url) !== out.url) throw new McpError('Adresse masquée à ressaisir en entier');
    out.url = p.url;
  }
  if (Array.isArray(out.args)) out.args = unmaskArgs(out.args, Array.isArray(p.args) ? p.args.map(String) : []);
  if (out.headersHelper === MASK) out.headersHelper = p.headersHelper;
  if (isObj(out.oauth) && out.oauth.clientSecret === MASK) out.oauth.clientSecret = p.oauth?.clientSecret;
  if (JSON.stringify(out).includes(MASK)) throw new McpError('Valeur masquée à ressaisir');
  return out;
}

// Arguments : un •••• est rendu à l'argument qui portait la même CLÉ, jamais d'après sa position.
// Clé = la forme masquée elle-même quand elle nomme sa valeur (« --token=•••• », « API_KEY=•••• »,
// « Authorization: •••• », URL masquée) ; pour un •••• seul, l'option qui le précède (« --api-key »).
// Plusieurs arguments de même clé : rendus dans l'ordre seulement s'il y en a autant avant qu'après.
// Tout le reste (clé inconnue, option changée, doublon ambigu) : refus, la valeur est à ressaisir.
function unmaskArgs(next, prevArgs) {
  const prevMasked = maskArgs(prevArgs);
  const keyOf = (form, before) => (form === MASK ? `${before ?? ''}\u0000${MASK}` : form);
  const pool = new Map();
  prevMasked.forEach((m, i) => {
    if (m === prevArgs[i] || !m.includes(MASK)) return;
    const k = keyOf(m, i ? prevMasked[i - 1] : null);
    pool.set(k, [...(pool.get(k) || []), prevArgs[i]]);
  });
  const isMasked = (a) => typeof a === 'string' && a.includes(MASK);
  const keys = next.map((a, i) => (isMasked(a) ? keyOf(a, i ? String(next[i - 1]) : null) : null));
  const wanted = new Map();
  for (const k of keys) if (k !== null) wanted.set(k, (wanted.get(k) || 0) + 1);
  const used = new Map();
  return next.map((a, i) => {
    const k = keys[i];
    if (k === null) return a;
    const vals = pool.get(k) || [];
    const n = used.get(k) || 0;
    if (!vals.length || n >= vals.length || (vals.length > 1 && vals.length !== wanted.get(k))) throw new McpError('Argument masqué à ressaisir');
    used.set(k, n + 1);
    return vals[n];
  });
}

// Valeurs brutes à ne jamais laisser sortir (pour vérifier une sortie et nettoyer les erreurs de la CLI).
export function secretsOf(config) {
  const c = isObj(config) ? config : {};
  const out = new Set();
  const add = (v) => { v = String(v ?? ''); if (v.length >= 6) out.add(v); };
  for (const k of ['env', 'headers']) for (const v of Object.values(isObj(c[k]) ? c[k] : {})) {
    add(v); const m = /^\s*(?:Bearer|Basic|Token)\s+(.+)$/i.exec(String(v)); if (m) add(m[1]);
  }
  if (typeof c.url === 'string') {
    try {
      const u = new URL(c.url);
      add(decodeURIComponent(u.username)); add(decodeURIComponent(u.password));
      for (const v of u.searchParams.values()) add(v);
      for (const seg of u.pathname.split('/')) { let d = seg; try { d = decodeURIComponent(seg); } catch { /* tel quel */ } if (looksLikeKey(d)) { add(seg); add(d); } }
      if (u.hash.length > 1) add(u.hash.slice(1));
    } catch { /* adresse non analysable : rien de plus à extraire */ }
  }
  const args = Array.isArray(c.args) ? c.args.map(String) : [];
  maskArgs(args).forEach((m, i) => {
    if (m === args[i]) return;
    add(args[i]);
    const sep = args[i].search(/[=:]/);
    if (sep > 0) add(args[i].slice(sep + 1).trim());
  });
  if (typeof c.headersHelper === 'string') add(c.headersHelper);
  if (isObj(c.oauth) && c.oauth.clientSecret) add(c.oauth.clientSecret);
  return [...out];
}

// Nombre de secrets retrouvés dans un objet sérialisé (jamais les valeurs elles-mêmes).
export function findLeaks(obj, secrets) {
  const text = JSON.stringify(obj);
  let n = 0;
  for (const s of secrets) if (s.length >= 6 && (text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)))) n++;
  return n;
}

// ---------- dossier de LANCEMENT d'une conversation ----------

// Nom que Claude Code donne au dossier d'un transcript (~/.claude/projects/<nom>) : tout ce qui n'est pas
// lettre ou chiffre ASCII devient « - ». D'anciennes versions gardaient accents ou « & » : on ramène les
// deux côtés à la forme actuelle pour comparer (« Idées SaaS & App » ↔ « -…-Id-es-SaaS---App »).
export const projectKey = (p) => String(p ?? '').normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');

// Les MCP d'une conversation sont ceux de son dossier de lancement : `cd` en cours de route ne les change
// pas, et le transcript reste rangé sous ce dossier. `s.cwd` de l'indexeur est le DERNIER dossier vu ;
// on lui préfère un champ explicite (launchCwd), sinon le dossier (ou parent) dont le nom codé est celui
// du dossier du transcript (`s.projectDir`). null si ce dossier n'a pas pu être retrouvé en chemin.
export function launchCwd(s) {
  if (!s) return null;
  for (const k of ['launchCwd', 'startCwd', 'firstCwd']) if (typeof s[k] === 'string' && s[k]) return s[k];
  const cwd = typeof s.cwd === 'string' && s.cwd ? s.cwd : null;
  const key = typeof s.projectDir === 'string' && s.projectDir.startsWith('-') ? projectKey(s.projectDir) : null;
  if (!key) return cwd;
  for (let d = cwd; d && path.isAbsolute(d); d = path.dirname(d)) {
    if (projectKey(d) === key) return d;
    if (d === path.dirname(d)) break;
  }
  return null;
}

// ---------- usage (pur) ----------

// Usage des 7 derniers jours par serveur à partir des conversations indexées. `s.mcpUses` peut être
// une Map ou un objet serveur → nombre, liste d'horodatages, ou { 'AAAA-MM-JJ': n } (ou { byDay }).
// Rangé par dossier de LANCEMENT (byCwd) ; si ce dossier n'est connu que par le nom codé du transcript,
// par ce nom (byKey), rapproché plus tard des dossiers de projet.
export function usageFromSessions(sessions, { now = Date.now(), days = 7 } = {}) {
  const cutoff = now - days * 86_400_000;
  const cutoffDay = new Date(cutoff).toLocaleDateString('sv-SE');
  const out = new Map();
  for (const s of sessions || []) {
    if (!s) continue;
    const lastTs = s.lastTs ? Date.parse(s.lastTs) : NaN;
    const dir = launchCwd(s);
    const key = !dir && typeof s.projectDir === 'string' && s.projectDir.startsWith('-') ? projectKey(s.projectDir) : null;
    for (const [server, raw] of entriesOf(s.mcpUses)) {
      let n = 0;
      const v = isObj(raw) && raw.byDay ? raw.byDay : raw;
      if (typeof v === 'number') n = Number.isNaN(lastTs) || lastTs >= cutoff ? v : 0;
      else if (Array.isArray(v)) n = v.filter((t) => (typeof t === 'number' ? t : Date.parse(t)) >= cutoff).length;
      else for (const [day, c] of entriesOf(v)) if (day >= cutoffDay) n += Number(c) || 0;
      if (!n) continue;
      const e = out.get(server) || { count7d: 0, byCwd: {} };
      e.count7d += n;
      if (dir) e.byCwd[dir] = (e.byCwd[dir] || 0) + n;
      else if (key) { e.byKey ||= {}; e.byKey[key] = (e.byKey[key] || 0) + n; }
      out.set(server, e);
    }
  }
  return out;
}

function normUsage(u) {
  const m = new Map();
  for (const [k, v] of entriesOf(u)) m.set(k, typeof v === 'number' ? { count7d: v } : isObj(v) ? v : { count7d: 0 });
  return m;
}
const usageEntry = (usage, name) => usage.get(name) ?? usage.get(toolKey(name)) ?? null;

// Dossier le plus profond de `dirs` qui contient `cwd` (une conversation compte pour un seul projet).
function deepest(cwd, dirs) {
  let best = null;
  for (const d of dirs) if ((cwd === d || cwd.startsWith(d + '/')) && (!best || d.length > best.length)) best = d;
  return best;
}
// Même chose pour un dossier de lancement connu seulement par son nom codé.
function deepestByKey(key, dirs) {
  let best = null;
  for (const d of dirs) {
    const k = projectKey(d);
    if (k === key) return d;
    if (key.startsWith(k + '-') && (!best || d.length > best.length)) best = d;
  }
  return best;
}
function usesIn(u, dir, dirs) {
  if (!u) return 0;
  if (!u.byCwd && !u.byKey) return u.count7d || 0;
  let n = 0;
  for (const [cwd, c] of entriesOf(u.byCwd)) if (deepest(cwd, dirs) === dir) n += Number(c) || 0;
  for (const [key, c] of entriesOf(u.byKey)) if (deepestByKey(key, dirs) === dir) n += Number(c) || 0;
  return n;
}

// « claude_ai_Google_Drive » → « Google Drive » ; « claude_ai_Pipedrive__2_ » → « Pipedrive (2) ».
export function connectorName(key) {
  return String(key).replace(/^claude_ai_/, '').replace(/__(\d+)_$/, ' ($1)').replace(/_/g, ' ').trim();
}

// ---------- état réel : sortie de `claude mcp list` (pur) ----------

export const HEALTH_STATUSES = ['connected', 'needs-auth', 'failed', 'pending-approval', 'disabled', 'unknown'];

// Libellés de Claude Code 2.1.x (fonction de liste) : « ✔ Connected », « ! Needs authentication »,
// « ! Connected · tools fetch failed », « ✘ Failed to connect », « ✘ Connection error », « - Not configured »,
// « ⏸ Pending approval (…) », « ✘ Rejected (…) », « ⊘ Disabled for this project (…) », « ✘ <politique> ».
export function healthStatus(label) {
  const s = String(label ?? '').trim();
  if (/^[✔✓√]\s*Connected\b/u.test(s)) return 'connected';
  if (/^!\s*Needs auth/i.test(s)) return 'needs-auth';
  if (/^⏸/u.test(s) || /^\W*Pending approval/i.test(s)) return 'pending-approval';
  if (/^⊘/u.test(s) || /^\W*(Disabled|Rejected)\b/i.test(s)) return 'disabled';
  if (/^[✗✘×!-]/u.test(s) || /Failed|error|Not configured/i.test(s)) return 'failed';
  return 'unknown';
}

// « nom: cible - état » par ligne. La cible (URL ou commande, parfois avec un secret) n'est jamais gardée :
// seuls le nom et l'état sortent d'ici. Les noms peuvent contenir « : » (plugin:legal:slack) mais pas « : ».
const STATUS_AT = / - ((?:[✔✓√]\s*Connected|!\s*Needs auth|!\s*Connected|[✗✘×]\s|⏸|⊘|- Not configured)[^]*)$/u;
export function parseMcpList(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
    const i = line.indexOf(': ');
    if (i <= 0) continue;
    const m = STATUS_AT.exec(line.slice(i + 2));
    if (!m) continue;
    out.push({ name: line.slice(0, i).trim(), status: healthStatus(m[1]) });
  }
  return out;
}

// Relevés en mémoire : [{ accountId, path, checkedAt, ok, servers: Map nom → état }]. Pour un compte :
// - où que ce soit (Mac, connecteurs) : le relevé le plus récent où le serveur apparaît, en préférant un
//   état autre que « coupé pour ce projet » (propre au dossier du relevé) ;
// - pour un dossier (projet, local) : le relevé fait dans ce dossier, sinon le plus récent fait dessous.
function healthIndex(runs) {
  const list = [...(runs || [])].filter((r) => r && r.accountId && r.path);
  const get = (r, name) => {
    const m = r.servers instanceof Map ? r.servers : new Map(Object.entries(r.servers || {}));
    if (m.has(name)) return m.get(name);
    const k = toolKey(name);
    for (const [n, s] of m) if (toolKey(n) === k) return s;
    return null;
  };
  const newest = (a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''));
  const byAccount = new Map();
  for (const r of list) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) || []), r]);
  const entry = (r, status) => ({ accountId: r.accountId, status, checkedAt: r.checkedAt || null });
  const order = (ids) => (a, b) => (ids ? ids.indexOf(a.accountId) - ids.indexOf(b.accountId) : a.accountId.localeCompare(b.accountId));

  // ids : comptes où il est déclaré (un « unknown » s'ils ont un relevé qui ne le montre pas) ; null : là où il est vu
  function anywhere(name, ids = null) {
    const out = [];
    for (const [id, rs] of byAccount) {
      if (ids && !ids.includes(id)) continue;
      const hits = rs.map((r) => [r, get(r, name)]).filter(([, s]) => s).sort(([a], [b]) => newest(a, b));
      const best = hits.find(([, s]) => s !== 'disabled') || hits[0];
      if (best) out.push(entry(best[0], best[1]));
      else if (ids) out.push(entry([...rs].sort(newest)[0], 'unknown'));
    }
    return out.sort(order(ids));
  }
  function inDir(name, dir, ids = null) {
    const out = [];
    for (const [id, rs] of byAccount) {
      if (ids && !ids.includes(id)) continue;
      const r = rs.find((x) => x.path === dir) || rs.filter((x) => x.path.startsWith(dir + '/')).sort(newest)[0];
      if (r) out.push(entry(r, get(r, name) || 'unknown'));
    }
    return out.sort(order(ids));
  }
  // Pour une conversation : le dossier, sinon le plus proche parent relevé ; pour un MCP qui ne dépend
  // pas du dossier (Mac, connecteur), n'importe quel relevé du compte. « Coupé » ne vaut que pour le
  // dossier exact du relevé (Claude Code range les MCP coupés par chemin exact).
  function at(name, { accountId, cwd, anyDir = true }) {
    const rs = byAccount.get(accountId) || [];
    const covering = rs.filter((r) => cwd && (r.path === cwd || cwd.startsWith(r.path === '/' ? '/' : r.path + '/')))
      .sort((a, b) => (b.path.length - a.path.length) || newest(a, b));
    for (const r of covering) {
      const s = get(r, name);
      if (s && (s !== 'disabled' || r.path === cwd)) return entry(r, s);
    }
    if (anyDir) { const e = anywhere(name).find((x) => x.accountId === accountId); if (e) return e; }
    return null;
  }
  const names = () => {
    const out = new Map();
    for (const r of list) for (const n of (r.servers instanceof Map ? r.servers.keys() : Object.keys(r.servers || {}))) out.set(toolKey(n), n);
    return out;
  };
  return { anywhere, inDir, at, names };
}

// ---------- inventaire (pur) ----------

const relName = (p, codeRoot, home) => {
  if (codeRoot && p.startsWith(codeRoot + '/')) return p.slice(codeRoot.length + 1);
  if (home && p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return path.basename(p) || p;
};
const byUsesThenName = (a, b) => (b.uses7d - a.uses7d) || a.name.localeCompare(b.name);
const union = (...lists) => [...new Set(lists.flat().filter((x) => typeof x === 'string'))];

// accounts : [{ id, configDir?, json (contenu du .claude.json ou null), needsAuth: Set }]
// projectFiles : [{ path, file, json | null, error?, readOnly? }] ; settingsDisabled : Map chemin → [noms]
// health : relevés de `claude mcp list` (voir healthIndex) ; check : { running, startedAt, checkedAt }
export function buildInventory({ accounts = [], projectFiles = [], settingsDisabled = new Map(), usage, connectorsDefault = 'off', codeRoot, home, health = [], check = null } = {}) {
  const use = normUsage(usage);
  const H = healthIndex(health);
  const secrets = new Set();
  const view = (name, config) => {
    for (const s of secretsOf(config)) secrets.add(s);
    // `config` masqué : de quoi préremplir le formulaire de modification sans jamais voir un secret
    return { name, type: serverType(config), target: mask(config, { home }), service: service(name, config), config: maskConfig(config) };
  };
  const projectEntry = (json, p) => (isObj(json?.projects) && isObj(json.projects[p]) ? json.projects[p] : null);
  const disabledAt = (p, { mcpjson = false } = {}) => union(...accounts.map((a) => {
    const e = projectEntry(a.json, p);
    return e ? [...(Array.isArray(e.disabledMcpServers) ? e.disabledMcpServers : []), ...(mcpjson && Array.isArray(e.disabledMcpjsonServers) ? e.disabledMcpjsonServers : [])] : [];
  }), mcpjson ? settingsDisabled.get(p) || [] : []);

  // Mac : union par nom sur tous les comptes
  const users = new Map();
  for (const a of accounts) {
    for (const [name, cfg] of Object.entries(isObj(a.json?.mcpServers) ? a.json.mcpServers : {})) {
      if (!isObj(cfg)) continue;
      const cur = users.get(name);
      if (!cur) users.set(name, { cfg, accounts: [a.id], differs: false });
      else {
        cur.accounts.push(a.id);
        if (JSON.stringify(cfg) !== JSON.stringify(cur.cfg)) { cur.differs = true; for (const s of secretsOf(cfg)) secrets.add(s); }
      }
    }
  }
  const allProjectPaths = union(...accounts.map((a) => Object.keys(isObj(a.json?.projects) ? a.json.projects : {})));
  const main = new Set(accounts.filter((a) => !a.configDir).map((a) => a.id));
  const user = [...users].map(([name, u]) => {
    const health = H.anywhere(name, u.accounts);
    // « À reconnecter » : l'état relevé par `claude mcp list` s'il existe, sinon le cache de Claude Code.
    // needsAuth ne vaut que pour le compte principal du Mac (celui des conversations) ; needsAuthIn liste
    // tous les comptes concernés (chacun a ses propres autorisations de MCP).
    const needsAuthIn = u.accounts.filter((id) => {
      const h = health.find((x) => x.accountId === id);
      if (h && h.status !== 'unknown') return h.status === 'needs-auth';
      return !!accounts.find((a) => a.id === id)?.needsAuth?.has(name);
    });
    // Pas encore vérifié mais le cache de Claude Code le sait : l'app montre « Connecter » tout de suite.
    for (const id of needsAuthIn) {
      const i = health.findIndex((x) => x.accountId === id);
      if (i < 0) health.push({ accountId: id, status: 'needs-auth', checkedAt: null });
      else if (health[i].status === 'unknown') health[i] = { ...health[i], status: 'needs-auth' };
    }
    return {
      ...view(name, u.cfg),
      accounts: u.accounts,
      uses7d: usageEntry(use, name)?.count7d || 0,
      needsAuth: needsAuthIn.some((id) => main.has(id)),
      needsAuthIn,
      health,
      differs: u.differs,
      disabledIn: allProjectPaths.filter((p) => disabledAt(p).includes(name)),
    };
  }).sort(byUsesThenName);

  // Projets : .mcp.json
  const projDirsByName = new Map();
  for (const f of projectFiles) for (const n of Object.keys(isObj(f.json?.mcpServers) ? f.json.mcpServers : {})) {
    projDirsByName.set(n, [...(projDirsByName.get(n) || []), f.path]);
  }
  const projects = projectFiles.map((f) => {
    const off = disabledAt(f.path, { mcpjson: true });
    const servers = Object.entries(isObj(f.json?.mcpServers) ? f.json.mcpServers : {})
      .filter(([, c]) => isObj(c))
      .map(([name, cfg]) => ({
        ...view(name, cfg), uses7d: usesIn(usageEntry(use, name), f.path, projDirsByName.get(name) || []), disabled: off.includes(name),
        health: H.inDir(name, f.path),
      }))
      .sort(byUsesThenName);
    return { path: f.path, name: relName(f.path, codeRoot, home), file: f.file, servers, ...(f.error ? { error: f.error } : {}), ...(f.readOnly ? { readOnly: f.readOnly } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Local : projects[chemin].mcpServers de chaque compte
  const locals = new Map();
  for (const a of accounts) {
    for (const [p, e] of Object.entries(isObj(a.json?.projects) ? a.json.projects : {})) {
      if (!isObj(e) || !isObj(e.mcpServers)) continue;
      for (const [name, cfg] of Object.entries(e.mcpServers)) {
        if (!isObj(cfg)) continue;
        const m = locals.get(p) || new Map();
        const cur = m.get(name);
        if (cur) cur.accounts.push(a.id); else m.set(name, { cfg, accounts: [a.id] });
        locals.set(p, m);
      }
    }
  }
  const localDirsByName = new Map();
  for (const [p, m] of locals) for (const n of m.keys()) localDirsByName.set(n, [...(localDirsByName.get(n) || []), p]);
  const local = [...locals].map(([p, m]) => {
    const off = disabledAt(p);
    const servers = [...m].map(([name, s]) => ({
      ...view(name, s.cfg), uses7d: usesIn(usageEntry(use, name), p, localDirsByName.get(name) || []), disabled: off.includes(name), accounts: s.accounts,
      health: H.inDir(name, p, s.accounts),
    })).sort(byUsesThenName);
    return { path: p, name: relName(p, codeRoot, home), servers };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Connecteurs claude.ai vus dans l'usage ; le nom exact vient de claudeAiMcpEverConnected si possible
  const known = new Map();
  for (const a of accounts) {
    for (const full of Array.isArray(a.json?.claudeAiMcpEverConnected) ? a.json.claudeAiMcpEverConnected : []) {
      const k = toolKey(String(full));
      const cur = known.get(k) || { name: String(full).replace(/^claude\.ai\s+/, ''), accounts: [] };
      cur.accounts.push(a.id);
      known.set(k, cur);
    }
  }
  const connectors = [...use].map(([k, u]) => [toolKey(k), u]).filter(([k]) => k.startsWith('claude_ai_')).map(([k, u]) => {
    const kn = known.get(k);
    const name = kn?.name || connectorName(k);
    return {
      name,
      accountId: u.accountId ?? (kn?.accounts.length === 1 ? kn.accounts[0] : null),
      uses7d: u.count7d || 0,
      service: service(name, {}),
      health: H.anywhere(`claude.ai ${name}`),
    };
  });
  // Connecteurs relevés par `claude mcp list` mais jamais utilisés : listés aussi, avec leur état réel.
  const seen = new Set(connectors.map((c) => toolKey(`claude.ai ${c.name}`)));
  for (const [k, full] of H.names()) {
    if (!k.startsWith('claude_ai_') || seen.has(k)) continue;
    seen.add(k);
    const name = String(full).replace(/^claude\.ai\s+/, '');
    const health = H.anywhere(full);
    const ids = union(health.map((h) => h.accountId));
    connectors.push({ name, accountId: ids.length === 1 ? ids[0] : null, uses7d: 0, service: service(name, {}), health });
  }
  connectors.sort(byUsesThenName);

  const inv = { user, projects, local, connectors, connectorsDefault };
  if (check) inv.healthCheck = check;
  // Filet de sécurité : si un secret a survécu au masquage, on réduit la cible à presque rien.
  const list = [...secrets];
  if (list.length && findLeaks(inv, list)) {
    for (const s of [...user, ...projects.flatMap((p) => p.servers), ...local.flatMap((p) => p.servers)]) {
      if (!findLeaks(s, list)) continue;
      s.target = s.type === 'stdio' ? `${path.basename(s.target.split(' ')[0] || '')} ${MASK}` : MASK;
      s.config = { type: s.type };
    }
  }
  return inv;
}

// ---------- lecture des fichiers ----------

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { missing: e.code === 'ENOENT', error: e.code }; }
  try { return { text, json: JSON.parse(text) }; } catch { return { text, error: 'invalid' }; }
}

// .mcp.json jusqu'à `maxDepth` sous codeRoot (même sens que `find -maxdepth 3 -name .mcp.json`),
// sans entrer dans node_modules ni dans les dossiers cachés (.git, .dev, .worktrees…).
export function scanProjects(codeRoot, maxDepth = 3, { home = os.homedir() } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    const file = path.join(dir, '.mcp.json');
    if (fs.existsSync(file)) {
      const r = readJsonFile(file);
      const link = linkedOutside(dir, file, home);
      out.push({ path: dir, file, json: r.json ?? null, ...(r.error ? { error: 'Fichier illisible' } : {}), ...(link ? { readOnly: link } : {}) });
    }
    if (depth + 1 >= maxDepth) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  if (codeRoot && fs.existsSync(codeRoot)) walk(codeRoot, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Un .mcp.json qui est un lien vers un fichier hors de son projet (ex. ~/.claude.json, dont mcpServers sont
// les MCP du Mac) ne s'édite jamais d'ici : on écrirait ailleurs que là où l'utilisateur croit écrire, sans le verrou
// de Claude Code. Renvoie la phrase à montrer, ou null si le fichier est un vrai fichier du projet.
export function linkedOutside(dir, file, home = os.homedir()) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; } // absent : il sera créé dans le projet
  if (!st.isSymbolicLink()) return null;
  let real, realDir;
  try { realDir = fs.realpathSync(dir); } catch { realDir = dir; }
  try { real = fs.realpathSync(file); } catch { return 'Ce .mcp.json est un lien cassé : Vigie ne le modifie pas. Corrige-le à la main.'; }
  if (real.startsWith(realDir + path.sep)) return null;
  const shown = home && real.startsWith(home + path.sep) ? '~' + real.slice(home.length) : real;
  return `Ce .mcp.json est un lien vers ${shown}, hors du projet : Vigie ne le modifie pas. Modifie le fichier d'origine, ou remplace le lien par un vrai fichier.`;
}

function readSettingsDisabled(dir) {
  const names = [];
  for (const f of ['settings.json', 'settings.local.json']) {
    const r = readJsonFile(path.join(dir, '.claude', f));
    if (Array.isArray(r.json?.disabledMcpjsonServers)) names.push(...r.json.disabledMcpjsonServers);
  }
  return union(names);
}

function readNeedsAuth(cacheDir, now) {
  const r = readJsonFile(path.join(cacheDir, 'mcp-needs-auth-cache.json'));
  const out = new Set();
  for (const [k, v] of Object.entries(isObj(r.json) ? r.json : {})) {
    const ts = Number(v?.timestamp);
    if (!ts || now - ts < NEEDS_AUTH_MAX_AGE_MS) out.add(k);
  }
  return out;
}

// ---------- écriture sûre d'un fichier JSON ----------

// Même verrou que Claude Code pour son .claude.json (proper-lockfile : dossier `<fichier>.lock`,
// considéré périmé après 10 s sans mise à jour).
export async function withConfigLock(file, fn, { waitMs = 5000, staleMs = LOCK_STALE_MS } = {}) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st = null;
      try { st = fs.statSync(lock); } catch { continue; } // libéré entre-temps
      if (Date.now() - st.mtimeMs > staleMs) { try { fs.rmdirSync(lock); } catch { /* repris par un autre */ } continue; }
      if (Date.now() - start > waitMs) throw new McpError('Claude Code écrit ce fichier en ce moment, réessaie');
      await sleep(40 + Math.random() * 80);
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(lock); } catch { /* déjà retiré */ } }
}

// Lire, modifier, écrire dans un temporaire, renommer, relire et vérifier. Si le fichier a bougé
// entre la lecture et l'écriture, ou si la vérification échoue, on recommence (3 fois au plus).
// Jamais d'écriture si le JSON lu est invalide. `mutate(data)` renvoie la nouvelle valeur, ou
// `undefined` s'il n'y a rien à changer ; `verify(relu)` dit si le changement est bien là.
export async function safeUpdateJson(file, mutate, { verify = () => true, create = false, lock = false, tries = 3, backup, newMode = 0o644, _beforeRename } = {}) {
  let real = file;
  try { real = fs.realpathSync(file); } catch { /* fichier absent : on le créera au même endroit */ }
  let lastError = 'Fichier modifié pendant l\'écriture, réessaie';
  for (let attempt = 1; attempt <= tries; attempt++) {
    const once = async () => {
      const r = readJsonFile(real);
      if (r.missing && !create) return { done: true, ok: false, error: 'Fichier introuvable' };
      if (r.error && !r.missing) return { retry: true, error: 'Fichier illisible (JSON invalide), rien n\'a été écrit' };
      const before = r.missing ? null : r.text;
      const next = mutate(r.missing ? undefined : r.json);
      if (next === undefined) return { done: true, ok: true, changed: false };
      let out = JSON.stringify(next, null, 2);
      if (before?.endsWith('\n') || before === null) out += '\n';
      let mode = newMode;
      try { mode = fs.statSync(real).mode & 0o777; } catch { /* nouveau fichier */ }
      const tmp = path.join(path.dirname(real), `${path.basename(real)}.vigie-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
      const fd = fs.openSync(tmp, 'wx', mode);
      try { fs.writeFileSync(fd, out); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        await _beforeRename?.(attempt);
        let now = null;
        try { now = fs.readFileSync(real, 'utf8'); } catch { /* absent */ }
        if (now !== before) { fs.rmSync(tmp, { force: true }); return { retry: true, error: 'Fichier modifié pendant l\'écriture, réessaie' }; }
        if (before !== null && backup) { backup(before); backup = null; }
        fs.renameSync(tmp, real);
      } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      const back = readJsonFile(real);
      if (back.error || !verify(back.json)) return { retry: true, error: 'Le changement n\'a pas tenu (fichier réécrit par un autre programme)' };
      return { done: true, ok: true, changed: true };
    };
    let res;
    try { res = lock ? await withConfigLock(file, once) : await once(); } catch (e) {
      if (e instanceof McpError) return { ok: false, error: e.message };
      throw e;
    }
    if (res.done) { delete res.done; return res; }
    lastError = res.error;
    await sleep(20 + Math.random() * 60);
  }
  return { ok: false, error: lastError };
}

// ---------- validation ----------

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new McpError('Nom invalide (lettres, chiffres, - et _)');
}
function checkConfig(config) {
  if (!isObj(config)) throw new McpError('Configuration invalide');
  const t = serverType(config);
  if (!['stdio', 'http', 'sse', 'ws'].includes(t)) throw new McpError('Type inconnu (stdio, http ou sse)');
  if (t === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) throw new McpError('Commande manquante');
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string'))) throw new McpError('Arguments invalides');
    if (config.env !== undefined && (!isObj(config.env) || Object.values(config.env).some((v) => typeof v !== 'string'))) throw new McpError('Variables invalides');
  } else {
    if (typeof config.url !== 'string' || (!/^(https?|wss?):\/\//i.test(config.url) && !/^\$\{/.test(config.url))) throw new McpError('Adresse invalide');
    if (config.headers !== undefined && (!isObj(config.headers) || Object.values(config.headers).some((v) => typeof v !== 'string'))) throw new McpError('En-têtes invalides');
  }
  if (JSON.stringify(config).includes(MASK)) throw new McpError('Valeur masquée à ressaisir');
}

// ---------- commande collée (« claude mcp add … », « claude mcp add-json … » ou JSON) ----------

function shellSplit(text) {
  const out = [];
  let cur = null, q = null;
  const s = String(text).replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur ??= '';
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += ch;
  }
  if (q) throw new McpError('Guillemet non fermé');
  if (cur !== null) out.push(cur);
  return out;
}

const fromJsonMap = (map, scope = null) => {
  const servers = Object.entries(map).filter(([, c]) => isObj(c)).map(([name, config]) => ({ name, config }));
  if (!servers.length) throw new McpError('Aucun serveur trouvé');
  return { ok: true, servers, scope };
};

export function parseAddCommand(text) {
  try {
    const s = String(text ?? '').trim().replace(/^\$\s+/, '');
    if (!s) throw new McpError('Rien à lire');
    if (s.startsWith('{')) {
      let j; try { j = JSON.parse(s); } catch { throw new McpError('JSON invalide'); }
      if (isObj(j.mcpServers)) return fromJsonMap(j.mcpServers);
      if (j.type || j.command || j.url) return { ok: true, servers: [{ name: null, config: j }], scope: null };
      return fromJsonMap(j);
    }
    const t = shellSplit(s);
    let i = 0;
    if (/(^|\/)claude$/.test(t[i] || '')) i++;
    if (t[i] === 'mcp') i++;
    const sub = t[i++];
    if (sub !== 'add' && sub !== 'add-json') throw new McpError('Commande non reconnue (claude mcp add …)');
    let scope = null, transport = null, clientId = null, callbackPort = null;
    const env = {}, headers = {}, pos = [];
    let rest = null;
    for (; i < t.length; i++) {
      const a = t[i];
      const val = () => { if (i + 1 >= t.length) throw new McpError(`Valeur manquante après ${a}`); return t[++i]; };
      if (a === '--') { rest = t.slice(i + 1); break; }
      const eq = /^(--[\w-]+)=(.*)$/s.exec(a);
      const flag = eq ? eq[1] : a;
      const inline = eq ? eq[2] : null;
      const take = () => (inline !== null ? inline : val());
      if (flag === '-s' || flag === '--scope') scope = take();
      else if (flag === '-t' || flag === '--transport') transport = take();
      else if (flag === '--client-id') clientId = take();
      else if (flag === '--callback-port') callbackPort = Number(take());
      else if (flag === '--client-secret') { /* demandé en direct par la CLI : rien à reprendre */ }
      else if (flag === '-e' || flag === '--env') {
        // Comme la CLI, plusieurs KEY=val peuvent suivre un seul -e
        let v = take();
        for (;;) {
          const k = v.indexOf('=');
          if (k <= 0) throw new McpError('Variable mal écrite (KEY=valeur)');
          env[v.slice(0, k)] = v.slice(k + 1);
          if (inline === null && /^[A-Za-z_]\w*=/.test(t[i + 1] || '') && pos.length === 0) v = t[++i]; else break;
        }
      } else if (flag === '-H' || flag === '--header') {
        let v = take();
        for (;;) {
          const k = v.indexOf(':');
          if (k <= 0) throw new McpError('En-tête mal écrit (Nom: valeur)');
          headers[v.slice(0, k).trim()] = v.slice(k + 1).trim();
          if (inline === null && /^[\w-]+:\s/.test(t[i + 1] || '') && pos.length === 0) v = t[++i]; else break;
        }
      } else if (/^-/.test(a) && pos.length < 2) throw new McpError(`Option inconnue : ${a.split('=')[0]}`);
      else pos.push(a);
    }
    if (scope && !['user', 'project', 'local'].includes(scope)) throw new McpError('Portée inconnue (user, project ou local)');
    const name = pos[0];
    if (!name) throw new McpError('Nom du serveur manquant');
    if (sub === 'add-json') {
      if (!pos[1]) throw new McpError('JSON manquant');
      let config; try { config = JSON.parse(pos[1]); } catch { throw new McpError('JSON invalide'); }
      if (!isObj(config)) throw new McpError('JSON invalide');
      return { ok: true, servers: [{ name, config }], scope };
    }
    const target = rest ? rest[0] : pos[1];
    const args = rest ? rest.slice(1) : pos.slice(2);
    if (!target) throw new McpError('Commande ou adresse manquante');
    const type = transport || (isUrl(target) ? 'http' : 'stdio');
    if (!['stdio', 'http', 'sse'].includes(type)) throw new McpError('Transport inconnu (stdio, http ou sse)');
    let config;
    if (type === 'stdio') config = { type: 'stdio', command: target, args, env };
    else {
      config = { type, url: target };
      if (Object.keys(headers).length) config.headers = headers;
      if (clientId || callbackPort) config.oauth = { ...(clientId ? { clientId } : {}), ...(callbackPort ? { callbackPort } : {}) };
    }
    return { ok: true, servers: [{ name, config }], scope };
  } catch (e) {
    if (e instanceof McpError) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------- module ----------

export function createMcp({
  home = os.homedir(),
  codeRoot = path.join(home, 'Code'),
  claudeBin,
  accounts = () => [],
  usage = () => new Map(),
  dataDir = DATA,
  backupDir = path.join(dataDir, 'backups', 'mcp'),
  maxDepth = 3,
  cliTimeoutMs = 30_000,
  now = () => Date.now(),
  // État réel (`claude mcp list`) : dossiers des conversations ouvertes (dossier de lancement), chacun en texte ou
  // { path, accounts } (seulement les comptes de ses conversations)
  checkPaths = () => [],
  checkTimeoutMs = 60_000,
  checkEveryMs = 10 * 60_000,
  checkConcurrency = 2,
  maxCheckPaths = 12,
  // Relevé automatique : seulement les comptes connectés (un compte déconnecté renouvellerait un jeton mort).
  canCheck = () => true,
  // Connexion (`claude mcp login`) : attente de la fin d'un lancement détaché avant de répondre,
  // durée max d'une connexion, nouvelle vérification d'un connecteur (autorisé ensuite sur claude.ai)
  connectWaitMs = 15_000,
  loginTimeoutMs = 10 * 60_000,
  recheckAfterMs = 90_000,
  markerPollMs = 2_000,
  openTerminal = openInTerminal,
  // Pseudo-terminal sans fenêtre pour `claude mcp login` (Python du système) ; absent : Terminal en repli.
  ptyPython = '/usr/bin/python3',
  log = (msg) => console.error(`[vigie] ${msg}`),
} = {}) {
  // Claude Code là où il est (installation officielle, npm, Homebrew, extension VS Code…), voir lib/claude-bin.mjs.
  const bin = claudeBin || process.env.VIGIE_CLAUDE_BIN || findClaudeBin({ home }) || 'claude';
  const listAccounts = () => (accounts() || []).filter((a) => a && a.id && a.claudeJsonPath);
  const cacheDirOf = (a) => a.configDir || path.join(home, '.claude');
  const iso = (t = now()) => new Date(t).toISOString();
  const say = (msg) => { try { log(scrubText(msg)); } catch { /* journal indisponible */ } };

  // Une seule écriture à la fois (les écritures de l'app arrivent par le serveur, dans ce processus).
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const guard = (fn) => async (...a) => {
    try { return await serial(() => fn(...a)); } catch (e) {
      if (e instanceof McpError) return { ok: false, error: e.message };
      throw e;
    }
  };

  function readAccounts() {
    return listAccounts().map((a) => {
      const r = readJsonFile(a.claudeJsonPath);
      return { ...a, json: isObj(r.json) ? r.json : null, needsAuth: readNeedsAuth(cacheDirOf(a), now()) };
    });
  }

  function inventory({ connectorsDefault = 'off' } = {}) {
    const accs = readAccounts();
    const projectFiles = scanProjects(codeRoot, maxDepth, { home });
    const settingsDisabled = new Map(projectFiles.map((f) => [f.path, readSettingsDisabled(f.path)]));
    let use;
    try { use = usage(); } catch { use = new Map(); }
    return buildInventory({ accounts: accs, projectFiles, settingsDisabled, usage: use, connectorsDefault, codeRoot, home,
      health: [...checks.runs.values()], check: healthState() });
  }

  // Noms coupés pour un projet, compte par compte (pour la rubrique MCP d'une conversation).
  function disabledFor(projectPath) {
    const p = normPath(projectPath);
    const byAccount = {};
    for (const a of readAccounts()) {
      const e = a.json?.projects?.[p];
      byAccount[a.id] = union(Array.isArray(e?.disabledMcpServers) ? e.disabledMcpServers : []);
    }
    return { names: union(...Object.values(byAccount)), byAccount };
  }

  // Serveurs vus par une conversation ouverte dans `cwd` avec ce compte : local > projet > Mac.
  // `cwd` doit être le dossier de LANCEMENT de la conversation (voir launchCwd), pas le dernier `cd`.
  // `status` : dernier état relevé par `claude mcp list` pour ce compte et ce dossier.
  function forProject(cwd, { accountId } = {}) {
    const p = normPath(cwd);
    const accs = readAccounts();
    const a = accs.find((x) => x.id === accountId) || accs[0];
    const json = a?.json || {};
    const entry = isObj(json.projects?.[p]) ? json.projects[p] : {};
    const off = union(entry.disabledMcpServers || []);
    const offJson = union(entry.disabledMcpjsonServers || [], readSettingsDisabled(p));
    const out = new Map();
    for (const [name, cfg] of Object.entries(isObj(json.mcpServers) ? json.mcpServers : {})) out.set(name, { name, scope: 'user', service: service(name, cfg), enabled: !off.includes(name) });
    // .mcp.json du dossier puis des parents (le plus proche gagne), sans remonter au-dessus de home
    const dirs = [];
    for (let d = p; d && d !== path.dirname(d) && (d === home || d.startsWith(home + '/')); d = path.dirname(d)) dirs.unshift(d);
    for (const d of dirs) {
      const r = readJsonFile(path.join(d, '.mcp.json'));
      for (const [name, cfg] of Object.entries(isObj(r.json?.mcpServers) ? r.json.mcpServers : {})) {
        out.set(name, { name, scope: 'project', service: service(name, cfg), enabled: !off.includes(name) && !offJson.includes(name) });
      }
    }
    for (const [name, cfg] of Object.entries(isObj(entry.mcpServers) ? entry.mcpServers : {})) out.set(name, { name, scope: 'local', service: service(name, cfg), enabled: !off.includes(name) });
    return [...out.values()].map((s) => ({ ...s, status: statusFor(s.name, { accountId: a?.id, cwd: p, scope: s.scope, enabled: s.enabled }) }));
  }

  // Dernier état connu d'un MCP pour une conversation (compte + dossier de lancement). `name` : nom du
  // serveur, clé d'outil (claude_ai_Gmail) ou nom de connecteur (Gmail). Un MCP coupé pour ce dossier est
  // « disabled » ; un MCP de projet ou local n'est cherché que dans les relevés de ce dossier (ou au-dessus).
  function statusFor(name, { accountId, cwd, scope, enabled } = {}) {
    if (enabled === false) return 'disabled';
    const acc = accountId || listAccounts().find((x) => !x.configDir)?.id || listAccounts()[0]?.id;
    if (!acc || typeof name !== 'string' || !name) return 'unknown';
    if (checks.indexOf !== checks.version) { checks.index = healthIndex([...checks.runs.values()]); checks.indexOf = checks.version; }
    const anyDir = scope !== 'project' && scope !== 'local';
    const dir = typeof cwd === 'string' && path.isAbsolute(cwd) ? normPath(cwd) : null;
    const names = scope === 'connector' || /^claude_ai_/.test(name)
      ? [`claude.ai ${name.startsWith('claude_ai_') ? connectorName(name) : name}`, name] : [name];
    for (const n of names) { const e = checks.index.at(n, { accountId: acc, cwd: dir, anyDir }); if (e) return e.status; }
    return 'unknown';
  }

  // Ce que les relevés de ce compte ont vu (tous dossiers, le plus récent d'abord) : nom → état. Pour trouver un MCP
  // par son service, quel que soit son nom (un agent qui demande « figma » prend figma-pro comme claude.ai Figma).
  function seenFor(accountId) {
    const out = new Map();
    const runs = [...checks.runs.values()].filter((r) => r && r.accountId === accountId)
      .sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || '')));
    for (const r of runs) {
      for (const [n, s] of r.servers instanceof Map ? r.servers : Object.entries(r.servers || {})) {
        if (!out.has(n) || (out.get(n) === 'disabled' && s !== 'disabled')) out.set(n, s);
      }
    }
    return out;
  }

  // ----- MCP du Mac : via la CLI officielle, compte par compte -----

  function pickAccounts(ids) {
    const all = listAccounts();
    if (ids === undefined || ids === null) return all;
    if (!Array.isArray(ids)) throw new McpError('Liste de comptes invalide');
    const out = ids.map((id) => all.find((a) => a.id === id) || id);
    const unknown = out.filter((a) => typeof a === 'string');
    if (unknown.length) throw new McpError(`Compte inconnu : ${unknown.join(', ')}`);
    if (!out.length) throw new McpError('Aucun compte choisi');
    return out;
  }

  function declared(a) {
    const r = readJsonFile(a.claudeJsonPath);
    if (r.error && !r.missing) return { error: 'Fichier du compte illisible' };
    return { servers: isObj(r.json?.mcpServers) ? r.json.mcpServers : {} };
  }

  function runCli(a, args, secrets) {
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    if (a.configDir) env.CLAUDE_CONFIG_DIR = a.configDir;
    return new Promise((resolve) => {
      execFile(bin, args, { env, cwd: home, timeout: cliTimeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const raw = String(stderr || stdout || err.message || '');
        resolve({ ok: false, error: cliError(raw, err, secrets) });
      });
    });
  }

  function cliError(raw, err, secrets) {
    if (err?.code === 'ENOENT') return 'Claude Code introuvable sur ce Mac';
    if (err?.killed) return 'Claude Code ne répond pas';
    if (/already exists/i.test(raw)) return 'Déjà présent dans ce compte';
    if (/No MCP server named/i.test(raw)) return 'Absent de ce compte';
    if (/Invalid name/i.test(raw)) return 'Nom invalide (lettres, chiffres, - et _)';
    if (/Invalid configuration/i.test(raw)) return 'Configuration refusée par Claude Code';
    let msg = raw.split('\n').map((l) => l.trim()).find(Boolean) || 'erreur inconnue';
    for (const s of secrets) msg = msg.split(s).join(MASK);
    return `Échec : ${clip(scrub(msg), 120)}`;
  }

  const sameServer = (a, b) => isObj(a) && isObj(b) && serverType(a) === serverType(b) && (a.url ?? null) === (b.url ?? null) && (a.command ?? null) === (b.command ?? null);

  async function cliAdd(a, name, config) {
    const r = await runCli(a, ['mcp', 'add-json', name, JSON.stringify(config), '--scope', 'user'], secretsOf(config));
    if (!r.ok) return r;
    const d = declared(a);
    return sameServer(d.servers?.[name], config) ? { ok: true } : { ok: false, error: 'Ajout non retrouvé dans le compte' };
  }
  async function cliRemove(a, name) {
    const r = await runCli(a, ['mcp', 'remove', name, '--scope', 'user'], []);
    if (!r.ok) return r;
    return declared(a).servers?.[name] ? { ok: false, error: 'Retrait non constaté dans le compte' } : { ok: true };
  }

  const accountMissing = (a) => (a.configDir && !fs.existsSync(a.configDir) ? 'Compte pas encore créé' : null);

  // Déclaration brute d'un MCP du Mac dans chaque compte (secrets compris) : pour la synchronisation des comptes
  // dans le moteur, jamais renvoyée à l'app.
  function rawUser(name) {
    return listAccounts().map((a) => {
      const d = declared(a);
      return { accountId: a.id, unavailable: accountMissing(a) || d.error || null, config: d.servers?.[name] ?? null };
    });
  }
  const userNames = () => [...new Set(listAccounts().flatMap((a) => Object.keys(declared(a).servers || {})))];
  const summary = (results) => ({ ok: results.every((r) => r.ok), results });

  async function addUser(name, config, accountIds) {
    checkName(name); checkConfig(config);
    const results = [];
    for (const a of pickAccounts(accountIds)) {
      const miss = accountMissing(a);
      if (miss) { results.push({ accountId: a.id, ok: false, error: miss }); continue; }
      const d = declared(a);
      if (d.error) { results.push({ accountId: a.id, ok: false, error: d.error }); continue; }
      if (d.servers[name]) { results.push({ accountId: a.id, ok: false, error: 'Déjà présent dans ce compte' }); continue; }
      results.push({ accountId: a.id, ...(await cliAdd(a, name, config)) });
    }
    return summary(results);
  }

  async function updateUser(name, config, accountIds) {
    checkName(name);
    const targets = pickAccounts(accountIds);
    // Référence pour les valeurs masquées : le compte lui-même, sinon le premier qui le déclare.
    const refs = new Map(listAccounts().map((a) => [a.id, declared(a).servers?.[name]]));
    const fallback = [...refs.values()].find(isObj);
    if (!fallback) throw new McpError('Ce MCP n\'existe dans aucun compte');
    const results = [];
    for (const a of targets) {
      const miss = accountMissing(a);
      if (miss) { results.push({ accountId: a.id, ok: false, error: miss }); continue; }
      const old = refs.get(a.id);
      let full;
      try { full = unmask(config, isObj(old) ? old : fallback); checkConfig(full); } catch (e) {
        if (e instanceof McpError) { results.push({ accountId: a.id, ok: false, error: e.message }); continue; }
        throw e;
      }
      if (!isObj(old)) { results.push({ accountId: a.id, ...(await cliAdd(a, name, full)) }); continue; }
      if (JSON.stringify(old) === JSON.stringify(full)) { results.push({ accountId: a.id, ok: true, changed: false }); continue; }
      const rm = await cliRemove(a, name);
      if (!rm.ok) { results.push({ accountId: a.id, ...rm }); continue; }
      const add = await cliAdd(a, name, full);
      if (!add.ok) {
        // On remet l'ancienne version plutôt que de laisser le compte sans ce MCP.
        const back = await cliAdd(a, name, old);
        results.push({ accountId: a.id, ok: false, error: back.ok ? `${add.error} (ancienne version remise)` : `${add.error} ; ancienne version non remise` });
        continue;
      }
      results.push({ accountId: a.id, ok: true });
    }
    return summary(results);
  }

  async function removeUser(name, accountIds) {
    checkName(name);
    const results = [];
    for (const a of pickAccounts(accountIds)) {
      const d = declared(a);
      if (d.error) { results.push({ accountId: a.id, ok: false, error: d.error }); continue; }
      if (!d.servers[name]) { results.push({ accountId: a.id, ok: true, changed: false }); continue; }
      results.push({ accountId: a.id, ...(await cliRemove(a, name)) });
    }
    return summary(results);
  }

  // ----- MCP de projet : <dossier>/.mcp.json -----

  function projectDir(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new McpError('Dossier invalide');
    let real, root;
    try { real = fs.realpathSync(p); } catch { throw new McpError('Dossier introuvable'); }
    try { root = fs.realpathSync(codeRoot); } catch { throw new McpError('Dossier ~/Code introuvable'); }
    if (!fs.statSync(real).isDirectory()) throw new McpError('Dossier introuvable');
    if (real !== root && !real.startsWith(root + path.sep)) throw new McpError('Dossier hors de ~/Code');
    return { dir: real, root };
  }

  // Sauvegarde dans les données de Vigie, pas dans le projet : une copie posée à côté de .mcp.json
  // échapperait au .gitignore du projet et pourrait partir dans un commit avec ses clés.
  function backupProjectFile({ dir, root }, text) {
    try {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    } catch { throw new McpError('Sauvegarde impossible, rien n\'a été écrit'); }
    const d = new Date(now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const slug = (path.relative(root, dir) || path.basename(dir) || 'racine').replace(/[/\\]/g, '__');
    let file = path.join(backupDir, `${slug}.mcp.json.bak-vigie-${stamp}`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(backupDir, `${slug}.mcp.json.bak-vigie-${stamp}-${n}`);
    try { fs.writeFileSync(file, text, { mode: 0o600 }); } catch { throw new McpError('Sauvegarde impossible, rien n\'a été écrit'); }
    // On garde les 20 dernières par projet.
    const mine = fs.readdirSync(backupDir).filter((f) => f.startsWith(`${slug}.mcp.json.bak-vigie-`)).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - 20))) fs.rmSync(path.join(backupDir, f), { force: true });
    return file;
  }

  async function editProject(p, mutateServers, verifyServers) {
    const where = projectDir(p);
    const file = path.join(where.dir, '.mcp.json');
    const link = linkedOutside(where.dir, file, home);
    if (link) throw new McpError(link);
    let backupFile = null;
    const res = await safeUpdateJson(file, (data) => {
      const base = data === undefined ? {} : data;
      if (!isObj(base) || (base.mcpServers !== undefined && !isObj(base.mcpServers))) throw new McpError('.mcp.json de forme inattendue, rien n\'a été écrit');
      const servers = { ...(base.mcpServers || {}) };
      const next = mutateServers(servers);
      if (next === undefined) return undefined;
      return { ...base, mcpServers: next };
    }, {
      create: true,
      verify: (j) => isObj(j?.mcpServers) && verifyServers(j.mcpServers),
      backup: (text) => { backupFile = backupProjectFile(where, text); },
    });
    return { ...res, ...(res.ok ? { file } : {}), ...(backupFile ? { backup: backupFile } : {}) };
  }

  async function addProject(p, name, config) {
    checkName(name); checkConfig(config);
    return editProject(p, (s) => {
      if (s[name]) throw new McpError('Déjà présent dans ce projet');
      return { ...s, [name]: config };
    }, (s) => sameServer(s[name], config));
  }

  async function updateProject(p, name, config) {
    checkName(name);
    let full;
    return editProject(p, (s) => {
      if (!isObj(s[name])) throw new McpError('Absent de ce projet');
      full = unmask(config, s[name]);
      checkConfig(full);
      if (JSON.stringify(full) === JSON.stringify(s[name])) return undefined;
      return { ...s, [name]: full };
    }, (s) => sameServer(s[name], full));
  }

  async function removeProject(p, name) {
    checkName(name);
    return editProject(p, (s) => {
      if (!s[name]) throw new McpError('Absent de ce projet');
      const { [name]: _, ...rest } = s;
      return rest;
    }, (s) => !(name in s));
  }

  // ----- couper un MCP pour un projet : projects[chemin].disabledMcpServers de chaque compte -----

  async function setDisabled(projectPath, name, disabled, { _beforeRename } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new McpError('Nom invalide');
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw new McpError('Dossier invalide');
    const p = normPath(projectPath);
    const off = !!disabled;
    const results = [];
    for (const a of listAccounts()) {
      if (!fs.existsSync(a.claudeJsonPath)) { results.push({ accountId: a.id, ok: true, changed: false, skipped: 'compte sans fichier' }); continue; }
      const r = await safeUpdateJson(a.claudeJsonPath, (data) => {
        if (!isObj(data)) throw new McpError('Fichier du compte de forme inattendue, rien n\'a été écrit');
        const projects = isObj(data.projects) ? data.projects : {};
        const entry = isObj(projects[p]) ? projects[p] : null;
        const list = Array.isArray(entry?.disabledMcpServers) ? entry.disabledMcpServers : [];
        const listJson = Array.isArray(entry?.disabledMcpjsonServers) ? entry.disabledMcpjsonServers : [];
        if (off) {
          if (list.includes(name)) return undefined;
          const e = entry ? { ...entry } : structuredClone(PROJECT_DEFAULTS);
          e.disabledMcpServers = [...list, name];
          return { ...data, projects: { ...projects, [p]: e } };
        }
        if (!entry || (!list.includes(name) && !listJson.includes(name))) return undefined;
        const e = { ...entry, disabledMcpServers: list.filter((n) => n !== name) };
        if (listJson.includes(name)) e.disabledMcpjsonServers = listJson.filter((n) => n !== name);
        return { ...data, projects: { ...projects, [p]: e } };
      }, {
        lock: true,
        verify: (j) => {
          const e = j?.projects?.[p];
          const has = Array.isArray(e?.disabledMcpServers) && e.disabledMcpServers.includes(name);
          const hasJson = Array.isArray(e?.disabledMcpjsonServers) && e.disabledMcpjsonServers.includes(name);
          return off ? has : !has && !hasJson;
        },
        _beforeRename,
      });
      results.push({ accountId: a.id, ...r });
    }
    return summary(results);
  }

  // ----- lancer la CLI (relevé, connexion) -----

  function cliEnv(a) {
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.ENABLE_CLAUDEAI_MCP_SERVERS; // les connecteurs du compte doivent apparaître
    if (a.configDir) env.CLAUDE_CONFIG_DIR = a.configDir;
    return env;
  }

  // La CLI tourne dans son propre groupe de processus (les MCP stdio qu'elle démarre en font partie) : au
  // délai dépassé, tout le groupe est arrêté. Sortie gardée en mémoire (64 Ko), jamais journalisée telle quelle.
  // `claude mcp login` exige un terminal : il attend le retour du navigateur, ou une adresse collée. pty.fork lui
  // en donne un sans ouvrir de fenêtre ; rien n'y est jamais écrit, donc jamais de fin de saisie (vérifié sur 2.1.304).
  // Pas pty.spawn : sur macOS avec Python 3.9, il boucle sans fin une fois la commande terminée.
  const PTY_PROG = [
    'import os,pty,sys',
    'pid,fd=pty.fork()',
    'if pid==0: os.execvp(sys.argv[1],sys.argv[1:])',
    'while True:',
    ' try: d=os.read(fd,4096)',
    ' except OSError: break',
    ' if not d: break',
    ' os.write(1,d)',
    '_,st=os.waitpid(pid,0)',
    'sys.exit(os.waitstatus_to_exitcode(st))',
  ].join('\n');
  const canPty = () => !!ptyPython && fs.existsSync(ptyPython);

  // low : priorité basse (relevés de fond) ; les MCP que Claude Code lance l'héritent.
  function spawnCli(a, args, { cwd, timeoutMs, pty = false, low = false }) {
    return new Promise((resolve) => {
      let out = '', timedOut = false, settled = false, timer = null, grace = null;
      const launchError = (e) => (e?.code === 'ENOENT' ? 'Claude Code introuvable sur ce Mac' : 'Lancement de Claude Code impossible');
      const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve(r); };
      let child;
      const [cmd, argv] = pty ? [ptyPython, ['-I', '-c', PTY_PROG, bin, ...args]] : [bin, args];
      try { child = spawn(cmd, argv, { cwd, env: cliEnv(a), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
        return resolve({ ok: false, code: null, out: '', error: launchError(e) });
      }
      if (low && child.pid) { try { os.setPriority(child.pid, 15); } catch { /* déjà fini */ } }
      const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* déjà fini */ } };
      timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 2000).unref();
      }, timeoutMs);
      const take = (d) => { if (out.length < 65_536) out += d; };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const result = (code) => (timedOut
        ? { ok: false, code, out, error: `Claude Code ne répond pas (${Math.ceil(timeoutMs / 1000)} s)` }
        : { ok: code === 0, code, out, ...(code === 0 ? {} : { error: null }) });
      child.on('error', (e) => done({ ok: false, code: null, out, error: launchError(e) }));
      // « close » attend la fin des tuyaux ; si un petit-enfant les garde ouverts, on n'attend qu'une seconde.
      child.on('exit', (code) => { grace = setTimeout(() => done(result(code)), 1000); grace.unref?.(); });
      child.on('close', (code) => done(result(code)));
    });
  }

  // ----- état réel : `claude mcp list` par compte et par dossier, gardé en mémoire -----

  const checks = { runs: new Map(), version: 0, index: null, indexOf: -1, running: null, queued: null, checkedAt: null, lastStartedAt: null, first: null, timer: null, later: new Set() };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const shown = (p) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

  function healthState() {
    return { running: !!checks.running, startedAt: checks.running?.startedAt || checks.lastStartedAt, checkedAt: checks.checkedAt };
  }

  // Un dossier n'apporte rien de plus que le relevé de base (Mac + connecteurs) s'il n'a ni .mcp.json
  // (lui ou un parent), ni MCP local, ni MCP coupé : inutile de relancer tous les MCP pour lui.
  function relevant(json, p) {
    for (let d = p; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.mcp.json'))) return true;
      const e = json?.projects?.[d];
      if (isObj(e) && (Object.keys(isObj(e.mcpServers) ? e.mcpServers : {}).length
        || [e.disabledMcpServers, e.disabledMcpjsonServers, e.enabledMcpjsonServers].some((l) => Array.isArray(l) && l.length))) return true;
      if (d === home || d === path.dirname(d)) break;
    }
    return readSettingsDisabled(p).length > 0;
  }

  // req : { accounts?: [ids], paths?: [dossiers exacts], extra?: [dossiers en plus du relevé habituel] }
  // Dossier d'une conversation : seulement pour les comptes de ses conversations (le dossier personnel, lui, pour tous).
  function checkJobs(req) {
    const all = listAccounts().filter((a) => !accountMissing(a) && (req.accounts || canCheck(a)));
    const accs = req.accounts ? all.filter((a) => req.accounts.includes(a.id)) : all;
    const explicit = Array.isArray(req.paths);
    const only = new Map(); // dossier -> comptes de ses conversations (absent : tous)
    let wanted = [];
    if (explicit) wanted = req.paths;
    else {
      let open = [];
      try { open = checkPaths() || []; } catch { open = []; }
      const dirs = [];
      for (const o of open) {
        const p = typeof o === 'string' ? o : o?.path;
        if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
        dirs.push(p);
        if (isObj(o) && Array.isArray(o.accounts)) {
          const k = normPath(p);
          only.set(k, new Set([...(only.get(k) || []), ...o.accounts]));
        }
      }
      wanted = [home, ...(req.extra || []), ...dirs];
    }
    const paths = union(wanted.filter((p) => typeof p === 'string' && path.isAbsolute(p)).map(normPath)).filter(isDir).slice(0, maxCheckPaths + 1);
    const jsons = new Map(readAccounts().map((a) => [a.id, a.json]));
    const extra = new Set((req.extra || []).map(normPath));
    const jobs = [];
    for (const a of accs) for (const p of paths) {
      if (!explicit && p !== home && !extra.has(p) && !relevant(jsons.get(a.id), p)) continue;
      if (!explicit && p !== home && !extra.has(p) && only.has(p) && !only.get(p).has(a.id)) continue;
      jobs.push({ a, p });
    }
    return jobs;
  }

  async function runCheck(req, startedAt, run = {}) {
    const t0 = Date.now();
    const jobs = checkJobs(req);
    const queue = [...jobs];
    let ok = 0;
    // Jamais deux Claude Code du même compte à la fois : ils renouvelleraient ensemble les mêmes jetons.
    // Relevé de fond dépassé par une demande de l'utilisateur (run.yield) : il finit celui en cours et s'arrête ; le
    // reste attendra le relevé suivant.
    const busy = new Set();
    const next = () => {
      if (run.yield) return null;
      const i = queue.findIndex((j) => !busy.has(j.a.id));
      return i < 0 ? null : queue.splice(i, 1)[0];
    };
    const worker = async () => {
      for (let j = next(); j; j = next()) {
        busy.add(j.a.id);
        const r = await spawnCli(j.a, ['mcp', 'list'], { cwd: j.p, timeoutMs: checkTimeoutMs, low: !!req.background }).finally(() => busy.delete(j.a.id));
        const key = `${j.a.id}\u0000${j.p}`;
        const at = iso();
        checks.version++;
        if (r.ok) {
          ok++;
          checks.runs.set(key, { accountId: j.a.id, path: j.p, checkedAt: at, ok: true, servers: new Map(parseMcpList(r.out).map((s) => [s.name, s.status])) });
          continue;
        }
        const error = r.error || cliError(r.out, null, []);
        const prev = checks.runs.get(key);
        // Un relevé raté ne remplace pas le précédent qui avait réussi : on garde l'état connu et sa date.
        checks.runs.set(key, prev?.ok ? { ...prev, error, failedAt: at } : { accountId: j.a.id, path: j.p, checkedAt: at, ok: false, error, servers: new Map() });
        say(`MCP : relevé impossible (${j.a.id}, ${shown(j.p)}) : ${error}`);
      }
    };
    // Relevé de fond : un Claude Code à la fois (chacun démarre tous les MCP du compte) ; demandé par l'utilisateur : plus vite.
    await Promise.all(Array.from({ length: Math.max(1, Math.min(req.background ? 1 : checkConcurrency, jobs.length)) }, worker));
    // Ménage : relevés de comptes disparus ou vieux de plus d'un jour
    const ids = new Set(listAccounts().map((a) => a.id));
    for (const [k, r] of checks.runs) if (!ids.has(r.accountId) || now() - Date.parse(r.checkedAt) > 86_400_000) { checks.runs.delete(k); checks.version++; }
    checks.checkedAt = iso();
    if (jobs.length) say(`MCP : état relevé (${ok}/${jobs.length - queue.length}${queue.length ? `, ${queue.length} remis à plus tard` : ''}, ${Math.round((Date.now() - t0) / 1000)} s)`);
    return { ok: ok === jobs.length - queue.length, startedAt, checkedAt: checks.checkedAt, runs: jobs.length - queue.length, failed: jobs.length - queue.length - ok };
  }

  function startCheck(req) {
    const startedAt = iso();
    checks.lastStartedAt = startedAt;
    const run = { startedAt, background: !!req.background, yield: false };
    run.promise = runCheck(req, startedAt, run)
      .catch((e) => { say(`MCP : relevé interrompu : ${e?.message || e}`); return { ok: false, startedAt, error: 'Relevé interrompu' }; })
      .finally(() => {
        checks.running = null;
        const q = checks.queued;
        checks.queued = null;
        if (q) startCheck(q.req).promise.then(q.resolve);
      });
    checks.running = run;
    return run;
  }

  const normReq = (r = {}) => ({
    ...(r.background ? { background: true } : {}),
    ...(Array.isArray(r.accounts) ? { accounts: union(r.accounts) } : {}),
    ...(Array.isArray(r.paths) ? { paths: union(r.paths) } : {}),
    ...(Array.isArray(r.extra) ? { extra: union(r.extra) } : {}),
  });
  const mergeReq = (a, b) => ({
    ...(a.background && b.background ? { background: true } : {}),
    ...(a.accounts && b.accounts ? { accounts: union(a.accounts, b.accounts) } : {}),
    ...(a.paths && b.paths ? { paths: union(a.paths, b.paths) } : { extra: union(a.paths || [], a.extra || [], b.paths || [], b.extra || []) }),
  });

  // Au plus un relevé à la fois : une demande pendant un relevé est fusionnée dans UN relevé suivant.
  // { accounts?, paths? } : sans `paths`, le dossier personnel (Mac + connecteurs) et les dossiers des
  // conversations (checkPaths) qui ont des MCP propres ; avec `paths`, exactement ces dossiers.
  function checkHealth(req = {}) {
    const r = normReq(req);
    if (!checks.running) return startCheck(r).promise;
    if (!r.background && checks.running.background) checks.running.yield = true; // l'utilisateur attend : il passe devant
    if (!checks.queued) {
      let resolve;
      const promise = new Promise((res) => { resolve = res; });
      checks.queued = { req: r, promise, resolve };
    } else checks.queued.req = mergeReq(checks.queued.req, r);
    return checks.queued.promise;
  }

  // POST /api/v2/mcp/check : { accountId?, path? } ; répond tout de suite, le relevé tourne en fond.
  function requestCheck({ accountId, path: p } = {}) {
    if (accountId !== undefined && accountId !== null && !listAccounts().some((a) => a.id === accountId)) throw new McpError('Compte inconnu');
    if (p !== undefined && p !== null) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new McpError('Dossier invalide');
      if (!isDir(p)) throw new McpError('Dossier introuvable');
    }
    const queued = !!checks.running;
    checkHealth({ ...(accountId ? { accounts: [accountId] } : {}), ...(p ? { paths: [normPath(p)] } : {}) }).catch(() => {});
    return { ok: true, startedAt: checks.running?.startedAt || iso(), ...(queued ? { queued: true } : {}) };
  }

  function later(fn, ms) {
    const t = setTimeout(() => { checks.later.delete(t); fn(); }, ms);
    t.unref?.();
    checks.later.add(t);
  }
  // Le relevé du dossier de la connexion montre aussi les MCP du Mac et les connecteurs de ce compte.
  const recheck = (accountId, cwd) => checkHealth({ accounts: [accountId], paths: [cwd] }).catch(() => {});

  // Relevé toutes les 10 min (et un premier peu après le démarrage) ; renvoie de quoi l'arrêter.
  function startAutoCheck({ everyMs = checkEveryMs, firstDelayMs = 20_000 } = {}) {
    stopAutoCheck();
    const tick = () => { if (!checks.running) checkHealth().catch(() => {}); };
    checks.first = setTimeout(tick, firstDelayMs);
    checks.first.unref?.();
    checks.timer = setInterval(tick, everyMs);
    checks.timer.unref?.();
    return stopAutoCheck;
  }
  function stopAutoCheck() {
    clearTimeout(checks.first);
    clearInterval(checks.timer);
    checks.first = checks.timer = null;
    for (const t of checks.later) { clearTimeout(t); clearInterval(t); }
    checks.later.clear();
  }

  // ----- connecter un MCP « comme dans la conversation » : `claude mcp login <nom>` -----
  // Claude Code 2.1.304 (lu dans le binaire) : pour un connecteur claude.ai, la commande ouvre le navigateur
  // sur claude.ai et se termine tout de suite : lancée détachée. Pour un MCP OAuth (http/sse), elle EFFACE
  // d'abord les jetons existants puis abandonne si son entrée n'est pas un terminal (« stdin isn't a
  // terminal ») : lancée détachée, elle déconnecterait un MCP qui marche. Elle part donc dans Terminal.

  let loginHelpCache = null;
  async function loginHelp(a) {
    let key = bin;
    try { key = `${fs.realpathSync(bin)}:${fs.statSync(bin).mtimeMs}`; } catch { /* binaire du PATH */ }
    if (loginHelpCache?.key === key) return loginHelpCache.value;
    const r = await spawnCli(a, ['mcp', 'login', '--help'], { cwd: home, timeoutMs: 20_000 });
    const text = String(r.out || '');
    const value = r.ok && /mcp login/.test(text) && /<name>/.test(text)
      ? { ok: true, options: [...text.matchAll(/^\s+(--?[\w-]+)/gm)].map((m) => m[1]) }
      : { ok: false, error: r.error && r.code === null ? r.error : 'Cette version de Claude Code ne sait pas connecter un MCP (claude mcp login)' };
    if (value.ok) loginHelpCache = { key, value };
    return value;
  }

  // Configuration du MCP vue par ce compte dans ce dossier (local > projet > Mac), ou null.
  function configFor(a, cwd, name) {
    const json = readJsonFile(a.claudeJsonPath).json;
    for (let d = cwd; ; d = path.dirname(d)) {
      const c = json?.projects?.[d]?.mcpServers?.[name];
      if (isObj(c)) return c;
      if (d === path.dirname(d)) break;
    }
    for (let d = cwd; ; d = path.dirname(d)) {
      const c = readJsonFile(path.join(d, '.mcp.json')).json?.mcpServers?.[name];
      if (isObj(c)) return c;
      if (d === home || d === path.dirname(d)) break;
    }
    const c = json?.mcpServers?.[name];
    return isObj(c) ? c : null;
  }

  // Journal des connexions : sans secret (adresses masquées, jetons retirés), 256 Ko au plus.
  function journal({ name, accountId, mode, code = null, out = '', error = null }) {
    const entry = { ts: new Date().toISOString(), name, accountId, mode, code, ...(error ? { error: scrubText(error) } : {}), out: clip(scrubText(String(out).trim()), 1500) };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const f = path.join(dataDir, 'mcp-connect.log');
      try { if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, `${f}.1`); } catch { /* pas encore de journal */ }
      fs.appendFileSync(f, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch { /* journal facultatif */ }
    say(`MCP : connexion de ${name} (${accountId}, ${mode})${code === null ? '' : ` : code ${code}`}${error ? ` : ${error}` : ''}`);
  }

  function loginError(r) {
    if (r.error) return r.error;
    const t = String(r.out || '');
    if (/awaiting approval/i.test(t)) return 'MCP du projet pas encore approuvé : ouvre Claude Code dans ce dossier pour l\'approuver';
    if (/was rejected/i.test(t)) return 'MCP du projet refusé dans les réglages de ce dossier';
    if (/doesn't support OAuth|only available for HTTP/i.test(t)) return 'Ce MCP n\'a pas de connexion par navigateur';
    if (/Authorization` header|no separate login/i.test(t)) return 'Ce MCP se connecte avec la clé de sa configuration : rien à autoriser';
    if (/authenticates automatically/i.test(t)) return 'Ce MCP utilise la connexion du compte Claude';
    if (/authorization link|claude login/i.test(t)) return 'Compte Claude pas connecté : connecte d\'abord le compte';
    if (/not found|No MCP server|not configured|unknown/i.test(t)) return 'Ce MCP n\'est pas déclaré pour ce compte et ce dossier';
    return cliError(t, null, []);
  }
  const NEEDS_TTY = /stdin isn't a terminal|interactive terminal|not a tty|isn't a tty/i;

  async function loginInTerminal(a, cwd, name, display) {
    const dir = path.join(dataDir, 'mcp-login');
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { throw new McpError('Dossier de Vigie inaccessible'); }
    const marker = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.done`);
    const envPart = a.configDir
      ? `env -u ENABLE_CLAUDEAI_MCP_SERVERS CLAUDE_CONFIG_DIR=${shq(a.configDir)}`
      : 'env -u CLAUDE_CONFIG_DIR -u ENABLE_CLAUDEAI_MCP_SERVERS';
    // La fin de la commande (son code) est notée dans un fichier témoin : Vigie relance alors un relevé.
    const command = `cd ${shq(cwd)} && ${envPart} ${shq(bin)} mcp login ${shq(name)}; echo $? > ${shq(marker)}`;
    let r;
    try { r = await openTerminal(command); } catch { r = { ok: false }; }
    if (!r?.ok) {
      journal({ name, accountId: a.id, mode: 'terminal', error: r?.error || 'Terminal ne s\'est pas ouvert' });
      return { ok: false, error: 'Terminal ne s\'est pas ouvert' };
    }
    journal({ name, accountId: a.id, mode: 'terminal', out: 'Terminal ouvert' });
    const until = Date.now() + loginTimeoutMs;
    const t = setInterval(() => {
      let code = null;
      try { code = fs.readFileSync(marker, 'utf8').trim(); } catch { if (Date.now() < until) return; }
      clearInterval(t);
      checks.later.delete(t);
      try { fs.rmSync(marker, { force: true }); } catch { /* déjà retiré */ }
      journal({ name, accountId: a.id, mode: 'terminal', code: code === null || code === '' ? null : Number(code), out: code === null ? 'fin non constatée' : 'terminé' });
      recheck(a.id, cwd);
    }, markerPollMs);
    t.unref?.();
    checks.later.add(t);
    return { ok: true, mode: 'terminal', message: `Terminal s'ouvre pour connecter ${display} : autorise-le dans le navigateur qui s'affiche.` };
  }

  // MCP OAuth : `claude mcp login` dans un pseudo-terminal, sans fenêtre ; il ouvre lui-même le navigateur sur la
  // page d'autorisation du service et se termine quand l'utilisateur a autorisé. Une connexion à la fois par MCP et compte.
  const logins = new Set();
  const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  function loginInPty(a, cwd, name, display) {
    if (!canPty()) return loginInTerminal(a, cwd, name, display);
    const key = `${a.id}\u0000${name}`;
    const who = a.label || a.id;
    if (logins.has(key)) return { ok: true, mode: 'browser', message: `Connexion de ${display} déjà en cours pour ${who} : autorise-la dans le navigateur.` };
    logins.add(key);
    const finished = spawnCli(a, ['mcp', 'login', name], { cwd, timeoutMs: loginTimeoutMs, pty: true }).then((r) => {
      logins.delete(key);
      const out = String(r.out || '').replace(ANSI, '');
      const ok = r.ok && /Authenticated|now available/i.test(out);
      journal({ name, accountId: a.id, mode: 'navigateur', code: r.code, out, error: ok ? null : (r.error || loginError({ out })) });
      recheck(a.id, cwd);
      return { ...r, ok, out };
    });
    pendingLogins.add(finished);
    finished.finally(() => pendingLogins.delete(finished));
    return { ok: true, mode: 'browser', message: `Le navigateur s'ouvre : autorise ${display} pour ${who}.`, done: finished };
  }
  const pendingLogins = new Set();

  async function loginDetached(a, cwd, name, display) {
    const finished = spawnCli(a, ['mcp', 'login', name], { cwd, timeoutMs: loginTimeoutMs }).then((r) => {
      const tty = !r.ok && NEEDS_TTY.test(r.out);
      journal({ name, accountId: a.id, mode: 'navigateur', code: r.code, out: r.out, error: r.ok || tty ? null : loginError(r) });
      if (r.ok) { recheck(a.id, cwd); later(() => recheck(a.id, cwd), recheckAfterMs); }
      return { ...r, tty };
    });
    let waiter;
    const r = await Promise.race([finished, new Promise((res) => { waiter = setTimeout(() => res(null), connectWaitMs); })]);
    clearTimeout(waiter);
    if (!r) return { ok: true, mode: 'browser', message: `Connexion de ${display} lancée : autorise-la dans le navigateur.` };
    if (r.ok) return { ok: true, mode: 'browser', message: `Le navigateur s'ouvre sur claude.ai : autorise ${display}. L'état sera revérifié ensuite.` };
    if (r.tty) return loginInTerminal(a, cwd, name, display);
    return { ok: false, error: loginError(r) };
  }

  // POST /api/v2/mcp/connect : { name, accountId?, path? } → { ok, message, mode: browser | terminal }
  async function connect({ name, accountId, path: dir } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name) || name.trim().startsWith('-')) throw new McpError('Nom invalide');
    const all = listAccounts();
    const a = accountId !== undefined && accountId !== null ? all.find((x) => x.id === accountId) : (all.find((x) => !x.configDir) || all[0]);
    if (!a) throw new McpError(accountId ? 'Compte inconnu' : 'Aucun compte');
    if (accountMissing(a)) throw new McpError('Compte pas encore créé');
    let cwd = home;
    if (dir !== undefined && dir !== null) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new McpError('Dossier invalide');
      if (!isDir(dir)) throw new McpError('Dossier introuvable');
      cwd = normPath(dir);
    }
    const n = name.trim();
    const connector = /^claude\.ai\s/i.test(n);
    if (!connector) {
      const cfg = configFor(a, cwd, n);
      if (cfg && serverType(cfg) === 'stdio') throw new McpError('Ce MCP tourne sur le Mac : il n\'a pas de connexion par navigateur');
      if (cfg && isObj(cfg.headers) && Object.keys(cfg.headers).some((h) => /^authorization$/i.test(h))) throw new McpError('Ce MCP se connecte avec la clé de sa configuration : rien à autoriser');
    }
    const help = await loginHelp(a);
    if (!help.ok) return { ok: false, error: help.error };
    const display = connector ? n.replace(/^claude\.ai\s+/i, '') : n;
    if (connector) return loginDetached(a, cwd, n, display);
    const { done, ...r } = await loginInPty(a, cwd, n, display); // Terminal en repli : une promesse
    return r;
  }

  // POST /api/v2/mcp/connect { name, everywhere: true } : connecte un MCP OAuth du Mac sur chaque compte qui le
  // demande (relevé « à connecter » ou « en échec »), un compte après l'autre : une page d'autorisation à la fois.
  async function connectEverywhere({ name } = {}) {
    if (typeof name !== 'string' || !name.trim() || /^claude\.ai\s/i.test(name)) throw new McpError('Nom invalide');
    const n = name.trim();
    const wanted = listAccounts().filter((a) => !accountMissing(a) && declared(a).servers?.[n]
      && ['needs-auth', 'failed', 'unknown'].includes(statusFor(n, { accountId: a.id, cwd: home }))
      && ['http', 'sse'].includes(serverType(declared(a).servers[n])));
    if (!wanted.length) return { ok: true, accounts: [], message: `${n} est déjà connecté sur tous tes comptes.` };
    const help = await loginHelp(wanted[0]);
    if (!help.ok) return { ok: false, error: help.error };
    (async () => {
      for (const a of wanted) {
        const r = await loginInPty(a, home, n, n);
        if (r?.done) await r.done.catch(() => {});
      }
    })().catch(() => {});
    const names = wanted.map((a) => a.label || a.id);
    return { ok: true, mode: 'browser', accounts: wanted.map((a) => a.id),
      message: names.length === 1 ? `Le navigateur s'ouvre : autorise ${n} pour ${names[0]}.`
        : `Le navigateur va s'ouvrir ${names.length} fois, un compte après l'autre (${names.join(', ')}) : autorise ${n} à chaque fois.` };
  }

  const safe = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) {
      if (e instanceof McpError) return { ok: false, error: e.message };
      throw e;
    }
  };

  return {
    inventory, disabledFor, forProject, statusFor, seenFor,
    service, mask: (config) => mask(config, { home }), maskConfig, parseAddCommand,
    addUser: guard(addUser), updateUser: guard(updateUser), removeUser: guard(removeUser), rawUser, userNames,
    addProject: guard(addProject), updateProject: guard(updateProject), removeProject: guard(removeProject),
    setDisabled: guard(setDisabled),
    checkHealth, requestCheck: safe(requestCheck), healthState, startAutoCheck, stopAutoCheck,
    connect: safe(connect), connectEverywhere: safe(connectEverywhere),
  };
}

// Ouvre Terminal avec une commande prête (exécutée dans une nouvelle fenêtre, comme si l'utilisateur l'avait tapée).
export function openInTerminal(command, { osascript = '/usr/bin/osascript' } = {}) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    execFile(osascript, ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${esc(command)}"`, '-e', 'end tell'], { timeout: 20_000 }, (err) => {
      resolve(err ? { ok: false, error: err.code === 'ENOENT' ? 'osascript introuvable' : 'Terminal ne s\'est pas ouvert' } : { ok: true });
    });
  });
}

// Guillemets du shell : 'texte' (une apostrophe devient '\'').
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Texte libre (sortie de la CLI, erreur) sans secret : adresses masquées, jetons retirés.
export function scrubText(text) {
  return scrub(String(text ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, (u) => maskUrl(u)));
}

function normPath(p) {
  const r = path.resolve(String(p));
  return r.length > 1 ? r.replace(/\/+$/, '') : r;
}
