// Vigie — coffre des connexions : une copie chiffrée de la connexion de chaque compte Claude (et de Codex), tenue à
// jour, et remise quand une app la perd sans que l'utilisateur se soit déconnecté.
//
// Pourquoi (2026-10-23) : au démarrage du Mac, VS Code relance toutes les conversations pendant que Vigie fait ses
// relevés ; les jetons ont expiré dans la nuit, des dizaines de Claude Code les renouvellent en même temps et le
// trousseau répond lentement (159 écritures en 12 min). Claude Code (2.1.306) peut alors relire son entrée « vide »
// et la réécrire avec un seul jeton de MCP : la connexion Claude disparaît, sur tous les comptes.
//
// Règles :
// - copie : la connexion Claude (claudeAiOauth) d'une entrée saine, seulement si .claude.json nomme le même compte et
//   la bonne adresse ; refaite à chaque renouvellement. Chiffrée (AES-256-GCM) dans data/coffre/, la clé dans le
//   trousseau (« Vigie connexions »). Rien en clair sur le disque, dans les journaux ou dans l'état publié. La clé et
//   les petites écritures passent par l'entrée standard de security ; seule la remise dans l'entrée de Claude Code,
//   quand elle est trop longue pour elle, passe par les arguments, comme Claude Code l'écrit lui-même.
// - remise : la connexion a disparu de l'entrée alors que .claude.json nomme toujours le même compte (une vraie
//   déconnexion retire aussi oauthAccount et révoque le jeton) ; constaté deux fois à 15 s d'écart ; sous le verrou
//   d'écriture de Claude Code (<dossier>/.storage-write.lock, celui de proper-lockfile) ; relu sous le verrou ;
//   jamais après une lecture ratée (c'est l'erreur de Claude Code qu'on répare).
// - jamais : une connexion refusée par Anthropic (jetons vidés par Claude Code), une déconnexion ou une connexion
//   lancée depuis VS Code il y a moins de 10 min (journal du lanceur), plus de 3 remises par heure pour un compte.
// - Vigie ne se sert jamais de ces jetons : il ne fait que recopier. Il ne peut donc pas lui-même renouveler un jeton
//   en même temps qu'une conversation.
// Codex : ~/.codex/auth.json copié de même ; remis seulement s'il est abîmé ou vidé (le retirer, c'est se déconnecter).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { keychainItem, claudeJsonFile } from './accounts.mjs';

export const VAULT_SERVICE = 'Vigie connexions';
// Leurre au compte de la session, rangé avant « Claude Code-credentials » dans l'ordre alphabétique du service :
// le trousseau rend les entrées d'un même compte dans cet ordre, et une app qui cherche « l'entrée du compte
// <utilisateur> » sans préciser le service prend la première. Nextcloud le fait au démarrage quand son utilisateur
// porte le nom de la session (vu les 2026-10-25 : il réservait l'entrée de Claude Code à sa propre signature, et
// chaque lecture demandait ensuite le mot de passe de session ; Claude Code finissait par perdre la connexion).
// Bug de Nextcloud (nextcloud/desktop#10976, correctif en attente : #10981) : le leurre n'est posé que si une app
// connue pour le faire est installée. À retirer quand le correctif sera publié.
export const SHIELD_SERVICE = '0 Vigie - leurre - ne pas supprimer';
const SHIELD_APPS = ['Nextcloud.app'];
const SHIELD_TEXT = 'Vigie : cette entrée ne contient rien. Elle protège les connexions de Claude Code des apps qui cherchent une entrée par le seul nom du compte.';
const KEY_ACCOUNT = 'cle';
// security -i lit des lignes bornées : au-delà, Claude Code passe par les arguments (même valeur que lui).
export const STDIN_MAX = 4032;
const KC_ABSENT = 44;
const HOUR = 3600_000;
const SAFE_NAME = /^[\w .@+-]{1,128}$/;

// Compte des entrées de trousseau de Claude Code (son yP()) : $USER, sinon le nom de session.
export function keychainUser(env = process.env) {
  let u;
  try { u = env.USER || os.userInfo().username; } catch { u = ''; }
  return /^[a-zA-Z0-9._-]+$/.test(u || '') ? u : 'claude-code-user';
}

function runSecurity(bin, args, { input, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] }); } catch { return resolve({ code: null, stdout: '' }); }
    let out = '';
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* déjà fini */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 2_000_000) out += d; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// security -w rend en hexadécimal une valeur qui n'est pas imprimable telle quelle.
function decode(raw) {
  if (/^(?:[0-9a-f]{2})+$/i.test(raw)) {
    const t = Buffer.from(raw, 'hex').toString('utf8');
    if (/^\s*[{[]/.test(t)) return t;
  }
  return raw;
}

// Trousseau par /usr/bin/security, comme Claude Code (même compte, même format) : ses entrées gardent ainsi le même
// contrôle d'accès, et Claude Code continue de les lire sans fenêtre de mot de passe.
export function createKeychain({ bin = '/usr/bin/security', user = keychainUser(), timeoutMs = 5000 } = {}) {
  async function read(service, account = user) {
    if (!SAFE_NAME.test(service) || !SAFE_NAME.test(account)) return { state: 'error' };
    const r = await runSecurity(bin, ['find-generic-password', '-a', account, '-s', service, '-w'], { timeoutMs });
    if (r.code === 0) return { state: 'ok', text: decode(r.stdout.replace(/\r?\n$/, '')) };
    if (r.code === KC_ABSENT) return { state: 'absent' };
    // pas de réponse dans le délai : le plus souvent, une fenêtre de mot de passe attend l'utilisateur
    return r.code === null ? { state: 'error', timedOut: true } : { state: 'error' };
  }
  // Dates de création et de modification d'une entrée, sans son secret : jamais de fenêtre de mot de passe.
  async function attrs(service, account = user) {
    if (!SAFE_NAME.test(service) || !SAFE_NAME.test(account)) return { state: 'error' };
    const r = await runSecurity(bin, ['find-generic-password', '-a', account, '-s', service], { timeoutMs });
    if (r.code === KC_ABSENT) return { state: 'absent' };
    if (r.code !== 0) return { state: 'error' };
    const date = (k) => /"(\d{14})Z/.exec(r.stdout.split('\n').find((l) => l.includes(`"${k}"<timedate>`)) || '')?.[1] || null;
    const cdat = date('cdat');
    const mdat = date('mdat');
    const at = mdat ? Date.UTC(+mdat.slice(0, 4), +mdat.slice(4, 6) - 1, +mdat.slice(6, 8), +mdat.slice(8, 10), +mdat.slice(10, 12), +mdat.slice(12, 14)) : null;
    return { state: 'ok', stamp: cdat && mdat ? `${cdat}/${mdat}` : null, modifiedAt: at };
  }
  // Par l'entrée standard ; trop long pour elle : seulement si `argv` (l'entrée de Claude Code elle-même, qu'il écrit
  // déjà ainsi quand elle grossit), sinon refusé.
  async function write(service, text, { account = user, argv = false } = {}) {
    if (!SAFE_NAME.test(service) || !SAFE_NAME.test(account) || service.includes('"') || account.includes('"')) return false;
    const hex = Buffer.from(text, 'utf8').toString('hex');
    const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    let r;
    if (line.length <= STDIN_MAX) r = await runSecurity(bin, ['-i'], { input: line, timeoutMs });
    else if (argv) r = await runSecurity(bin, ['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex], { timeoutMs });
    else return false;
    return r.code === 0;
  }
  return { read, attrs, write, user };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
// objet JSON, null si autre chose, undefined si illisible
function parseObj(text) { try { const v = JSON.parse(text); return isObj(v) ? v : null; } catch { return undefined; } }
const normEmail = (e) => (typeof e === 'string' && e.includes('@') ? e.trim().toLowerCase() : null);
const fp = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
// Connexion Claude vivante (jetons présents) ; un objet aux jetons vides = refusée par Anthropic (Claude Code l'a vidée).
const alive = (o) => isObj(o) && (!!str(o.accessToken) || !!str(o.refreshToken));
const codexAlive = (o) => isObj(o) && (!!str(o.tokens?.refresh_token) || !!str(o.tokens?.access_token) || !!str(o.OPENAI_API_KEY));
function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function createVault({
  dataDir,
  home = os.homedir(),
  // [{ id, label, configDir, expectedEmail }] : comptes Claude (configDir null = ~/.claude)
  accounts = () => [],
  codexHome = null,
  keychain = createKeychain(),
  now = () => Date.now(),
  log = (m) => console.error(`[vigie] ${m}`),
  confirmMs = 15_000,
  maxRestoresPerHour = 3,
  lockWaitMs = 8_000,
  staleLockMs = 15_000, // celui de Claude Code (proper-lockfile, stale 15 s)
  // Une lecture du secret sans réponse (fenêtre de mot de passe ouverte) : plus de lecture de cette entrée pendant ce
  // temps (2026-10-25 : une entrée devenue réservée à une autre app ouvrait une fenêtre à chaque passage, toutes les 20 s).
  blockMs = 15 * 60_000,
  // Entrée inchangée : son secret n'est relu qu'à ce rythme, par prudence (sinon seulement quand sa date change).
  fullEveryMs = 10 * 60_000,
  // Dossiers où chercher les apps qui rendent le leurre nécessaire.
  appDirs = ['/Applications', path.join(home, 'Applications')],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const COFFRE = path.join(dataDir, 'coffre');
  const STATUS = path.join(dataDir, 'connexions.json');
  const LAUNCHES = path.join(dataDir, 'launches.log');
  const mem = new Map(); // emplacement -> { lostSince, restores, lastFp, restoredAt, connected, state, since }
  let key = null;
  let last = null;

  const memOf = (slot) => { if (!mem.has(slot)) mem.set(slot, { lostSince: null, restores: [], lastFp: undefined, restoredAt: null, connected: null, state: null, since: null }); return mem.get(slot); };
  const iso = (t) => (t ? new Date(t).toISOString() : null);

  // ---------- clé et copies chiffrées ----------
  async function ensureKey() {
    if (key) return key;
    const r = await keychain.read(VAULT_SERVICE, KEY_ACCOUNT);
    if (r.state === 'ok' && /^[0-9a-f]{64}$/.test(r.text.trim())) return (key = Buffer.from(r.text.trim(), 'hex'));
    if (r.state !== 'absent') return null; // trousseau indisponible : on réessaiera
    const fresh = crypto.randomBytes(32).toString('hex');
    if (!(await keychain.write(VAULT_SERVICE, fresh, { account: KEY_ACCOUNT }))) return null;
    const back = await keychain.read(VAULT_SERVICE, KEY_ACCOUNT);
    if (back.state !== 'ok' || back.text.trim() !== fresh) return null;
    // copies faites avec une clé disparue : illisibles, on repart de zéro
    try { for (const f of fs.readdirSync(COFFRE)) fs.rmSync(path.join(COFFRE, f), { force: true }); } catch { /* pas encore de coffre */ }
    for (const m of mem.values()) m.lastFp = undefined;
    return (key = Buffer.from(fresh, 'hex'));
  }
  function seal(slot, obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(`vigie:${slot}`));
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n';
  }
  function readCopy(slot) {
    if (!key) return null;
    const box = readJson(path.join(COFFRE, `${slot}.json`));
    if (!isObj(box) || box.v !== 1) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
      d.setAAD(Buffer.from(`vigie:${slot}`));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      const v = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
      return isObj(v) ? v : null;
    } catch { return null; }
  }
  function writeCopy(slot, obj) {
    if (!key) return false;
    try {
      fs.mkdirSync(COFFRE, { recursive: true, mode: 0o700 });
      fs.chmodSync(COFFRE, 0o700);
      writeAtomic(path.join(COFFRE, `${slot}.json`), seal(slot, obj), 0o600);
      return true;
    } catch { return false; }
  }

  // ---------- verrou d'écriture de Claude Code ----------
  // proper-lockfile : un dossier « .storage-write.lock », périmé quand il n'a pas bougé depuis 15 s (Claude Code le
  // rafraîchit toutes les 7,5 s tant qu'il écrit). L'âge se mesure à l'heure réelle, jamais à l'horloge des tests.
  // Toujours borné dans le temps : un verrou périmé qu'on ne peut pas retirer (pas un dossier vide, droits, lien
  // cassé) fait renoncer, jamais insister (une boucle ici figerait tout le moteur).
  async function withStorageLock(dir, fn) {
    const lock = path.join(dir, '.storage-write.lock');
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > lockWaitMs) return { ok: false, busy: true };
      let got = false;
      try { fs.mkdirSync(lock); got = true; } catch (e) { if (e?.code !== 'EEXIST') return { ok: false }; }
      if (got) break;
      let st = null;
      try { st = fs.lstatSync(lock); } catch (e) { if (e?.code !== 'ENOENT') return { ok: false }; }
      if (st && Date.now() - st.mtimeMs > staleLockMs) {
        // périmé : retiré une fois, puis un seul essai (comme proper-lockfile)
        try { fs.rmdirSync(lock); } catch (e) { if (e?.code !== 'ENOENT') return { ok: false }; }
        try { fs.mkdirSync(lock); break; } catch (e) { if (e?.code !== 'EEXIST') return { ok: false }; }
      }
      await sleep(100 + Math.floor(Math.random() * 150));
    }
    try { return { ok: true, value: await fn(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch { /* rendu */ } }) }; } finally {
      try { fs.rmdirSync(lock); } catch { /* déjà retiré */ }
    }
  }

  // Déconnexion ou connexion passée par le lanceur (VS Code) il y a moins de 10 min pour ce compte.
  function authCommandRecently(id) {
    let lines = [];
    try { lines = fs.readFileSync(LAUNCHES, 'utf8').split('\n').slice(-200); } catch { return false; }
    return lines.some((l) => {
      const [ts, , acc, , why] = l.split('\t');
      return acc === id && (why === 'deconnexion' || why === 'connexion') && now() - Number(ts) * 1000 < 10 * 60_000;
    });
  }

  // État publié : rien de secret ; les remises de l'heure y sont gardées pour le prochain démarrage du moteur.
  const recentRestores = (m) => (m.restores = m.restores.filter((t) => now() - t < HOUR)).map(iso);
  function set(m, state, connected, extra = {}) {
    if (m.state !== state) m.since = now();
    m.state = state;
    m.connected = connected;
    return { connected, state, since: iso(m.since), restoredAt: iso(m.restoredAt), restores: recentRestores(m), ...extra };
  }
  // lecture ratée : on garde ce qu'on savait
  const unknown = (m, extra = {}) => ({ connected: m.connected, state: 'unknown', since: iso(m.since), restoredAt: iso(m.restoredAt), restores: recentRestores(m), ...extra });
  // Remise en cours : pendant ses 2 premières minutes, le compte reste utilisable (null = « on ne sait pas » pour le
  // lanceur) ; sinon, au démarrage du Mac, toutes les conversations reprises partiraient sur un autre compte, qui
  // relirait chacune en entier. Au-delà, il n'est plus compté connecté.
  const restoring = (m, extra) => set(m, 'restoring', now() - (m.lostSince ?? now()) < 2 * 60_000 ? null : false, extra);
  // Remises d'avant le démarrage du moteur (un moteur qui redémarre en boucle ne remet pas plus souvent).
  {
    const prev = readJson(STATUS);
    const seed = (slot, a) => {
      if (!isObj(a)) return;
      const m = memOf(slot);
      m.restores = (Array.isArray(a.restores) ? a.restores : []).map((t) => Date.parse(t)).filter(Number.isFinite);
      m.restoredAt = Date.parse(a.restoredAt) || null;
    };
    for (const [id, a] of Object.entries(isObj(prev?.accounts) ? prev.accounts : {})) seed(`claude-${id}`, a);
    seed('codex', prev?.codex);
  }
  function blockReads(m, label) {
    m.blockedUntil = now() + blockMs;
    log(`coffre : le trousseau n'a pas donné la connexion de ${label} à temps (une fenêtre de mot de passe l'attend sans doute) : plus de lecture de cette entrée pendant ${Math.round(blockMs / 60_000)} min`);
  }
  const dropCopy = (slot, m) => { try { fs.rmSync(path.join(COFFRE, `${slot}.json`), { force: true }); } catch { /* déjà partie */ } m.lastFp = null; };
  // Perte constatée : deux fois à confirmMs d'écart, et pas plus de maxRestoresPerHour remises dans l'heure.
  function readyToRestore(m, label) {
    if (!m.lostSince) { m.lostSince = now(); return false; }
    if (now() - m.lostSince < confirmMs) return false;
    m.restores = m.restores.filter((t) => now() - t < HOUR);
    if (m.restores.length >= maxRestoresPerHour) {
      if (!m.tooMany) log(`coffre : la connexion de ${label} se perd trop souvent, plus de remise automatique pendant une heure`);
      m.tooMany = true;
      return false;
    }
    m.tooMany = false;
    return true;
  }

  // ---------- un compte Claude ----------
  async function syncClaude(acc) {
    const slot = `claude-${acc.id}`;
    const m = memOf(slot);
    const label = acc.label || acc.id;
    const dir = acc.configDir || path.join(home, '.claude');
    const item = keychainItem(acc.configDir);
    const cjPath = claudeJsonFile(home, acc.configDir);
    const cj = readJson(cjPath);
    const who = isObj(cj?.oauthAccount) ? { uuid: str(cj.oauthAccount.accountUuid), email: normEmail(cj.oauthAccount.emailAddress) } : null;
    const extra = { email: who?.email || null };
    // D'abord la date de l'entrée, sans son secret (jamais de fenêtre de mot de passe). Inchangée depuis le dernier
    // constat sûr : rien à relire. Sinon, une seule lecture du secret ; sans réponse, plus rien pendant blockMs.
    const a = await keychain.attrs(item);
    if (a.state === 'error') return unknown(m, extra);
    const seen = `${a.state}|${a.stamp || ''}|${who?.uuid || ''}|${who?.email || ''}`;
    if (a.state === 'ok' && seen === m.seen && now() - (m.fullAt || 0) < fullEveryMs && (m.state === 'ok' || m.state === 'dead')) return set(m, m.state, m.connected, extra);
    if (a.state === 'ok' && m.blockedUntil && now() < m.blockedUntil) return unknown(m, extra);
    // une date de la seconde en cours peut encore changer dans la même seconde : on ne s'y fie qu'ensuite
    const settled = !a.modifiedAt || Date.now() - a.modifiedAt > 2000;
    const remember = () => { m.seen = settled ? seen : null; m.fullAt = now(); };
    m.seen = null;
    const r = a.state === 'absent' ? { state: 'absent' } : await keychain.read(item);
    if (r.state === 'error') {
      if (r.timedOut) blockReads(m, label);
      return unknown(m, extra);
    }
    m.blockedUntil = null;
    const creds = r.state === 'ok' ? parseObj(r.text) : null;
    if (creds === undefined) return unknown(m, extra);
    // Claude Code lit le trousseau, puis sa copie en clair (.credentials.json) si l'entrée n'existe pas.
    const store = r.state === 'ok' ? (creds ?? {}) : readJson(path.join(dir, '.credentials.json'));
    const login = isObj(store) ? store.claudeAiOauth : undefined;

    if (alive(login)) {
      m.lostSince = null;
      const right = who?.uuid && (!acc.expectedEmail || who.email === normEmail(acc.expectedEmail));
      if (right && key) {
        const f = fp(`${login.refreshToken || ''}\u0000${login.accessToken || ''}\u0000${who.uuid}`);
        if (m.lastFp === undefined) m.lastFp = readCopy(slot)?.fp ?? null;
        if (m.lastFp !== f && writeCopy(slot, { v: 1, accountUuid: who.uuid, email: who.email, savedAt: iso(now()), fp: f, claudeAiOauth: login })) m.lastFp = f;
      }
      if (r.state === 'ok') remember();
      return set(m, 'ok', true, extra);
    }
    // Refusée par Anthropic : sa copie porte le même jeton refusé (ou un plus ancien), elle est jetée pour ne jamais
    // être remise après une perte (y compris une remise qu'Anthropic vient de refuser).
    if (isObj(login)) { m.lostSince = null; if (key) dropCopy(slot, m); remember(); return set(m, 'dead', false, extra); }
    // Une valeur qui n'est pas une connexion (null…) : on ne sait pas qui l'a mise là, on n'y touche pas.
    if (login !== undefined) { m.lostSince = null; return set(m, 'lost', false, extra); }
    // Plus de connexion du tout.
    if (!who?.uuid || authCommandRecently(acc.id)) { m.lostSince = null; return set(m, 'logged-out', false, extra); }
    const copy = readCopy(slot);
    if (!copy || copy.accountUuid !== who.uuid || !alive(copy.claudeAiOauth)) { m.lostSince ??= now(); return set(m, 'lost', false, extra); }
    if (!readyToRestore(m, label)) return m.tooMany ? set(m, 'lost', false, extra) : restoring(m, extra);

    const res = await withStorageLock(dir, async (touch) => {
      const again = await keychain.read(item);
      if (again.state === 'error') { if (again.timedOut) blockReads(m, label); return 'busy'; }
      const cur = again.state === 'ok' ? parseObj(again.text) : {};
      if (cur === undefined) return 'busy';
      const base = cur ?? {};
      if (Object.hasOwn(base, 'claudeAiOauth')) return 'changed'; // quelqu'un a écrit entre-temps : on revoit au prochain passage
      if (again.state === 'absent' && alive(readJson(path.join(dir, '.credentials.json'))?.claudeAiOauth)) return 'changed';
      if (readJson(cjPath)?.oauthAccount?.accountUuid !== who.uuid) return 'changed';
      touch();
      return (await keychain.write(item, JSON.stringify({ ...base, claudeAiOauth: copy.claudeAiOauth }), { argv: true })) ? 'restored' : 'failed';
    });
    if (res.ok && res.value === 'restored') {
      m.restores.push(now());
      m.restoredAt = now();
      m.lostSince = null;
      m.lastFp = copy.fp ?? null;
      log(`coffre : connexion de ${label} remise (perdue sans déconnexion ; copie du ${copy.savedAt || '?'})`);
      return set(m, 'restored', true, extra);
    }
    if (res.ok && res.value === 'failed') log(`coffre : la connexion de ${label} n'a pas pu être remise (écriture refusée par le trousseau)`);
    return restoring(m, extra);
  }

  // ---------- Codex ----------
  async function syncCodex() {
    const m = memOf('codex');
    const f = path.join(codexHome, 'auth.json');
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) {
      if (e?.code === 'ENOENT') { m.lostSince = null; return set(m, 'logged-out', false); } // retiré : déconnexion
      return unknown(m);
    }
    const j = parseObj(text);
    if (codexAlive(j)) {
      m.lostSince = null;
      if (key) {
        const h = fp(text);
        if (m.lastFp === undefined) m.lastFp = readCopy('codex')?.fp ?? null;
        if (m.lastFp !== h && writeCopy('codex', { v: 1, savedAt: iso(now()), fp: h, text })) m.lastFp = h;
      }
      return set(m, 'ok', true);
    }
    // abîmé ou vidé
    const copy = readCopy('codex');
    if (!copy || !codexAlive(parseObj(copy.text))) { m.lostSince ??= now(); return set(m, 'lost', false); }
    if (!readyToRestore(m, 'Codex')) return m.tooMany ? set(m, 'lost', false) : restoring(m);
    try {
      if (fs.readFileSync(f, 'utf8') !== text) return restoring(m); // Codex vient de l'écrire : on revoit
      writeAtomic(f, copy.text, 0o600);
    } catch { return restoring(m); }
    m.restores.push(now());
    m.restoredAt = now();
    m.lostSince = null;
    m.lastFp = copy.fp ?? null;
    log(`coffre : connexion de Codex remise (fichier abîmé ; copie du ${copy.savedAt || '?'})`);
    return set(m, 'restored', true);
  }

  // ---------- passage complet ----------
  // Un compte après l'autre (jamais plusieurs security à la fois) ; état publié dans data/connexions.json pour le
  // lanceur et le serveur : connecté ou non, jamais rien de secret.
  // Le leurre : seulement si une app qui en a besoin est installée ; regardé par sa seule date (jamais lu), recréé
  // s'il manque. Déjà posé et l'app retirée : il reste (vide, il ne gêne rien).
  let shieldNoted = false;
  const shieldNeeded = () => appDirs.some((dir) => SHIELD_APPS.some((app) => fs.existsSync(path.join(dir, app))));
  async function ensureShield() {
    if (!shieldNeeded()) return;
    const a = await keychain.attrs(SHIELD_SERVICE);
    if (a.state !== 'absent') return;
    if (await keychain.write(SHIELD_SERVICE, SHIELD_TEXT) && !shieldNoted) {
      shieldNoted = true;
      log('coffre : leurre posé devant les connexions de Claude Code dans le trousseau');
    }
  }

  async function sync() {
    await ensureKey();
    try { await ensureShield(); } catch { /* prochain passage */ }
    const out = { v: 1, checkedAt: iso(now()), checkedAtEpoch: Math.floor(now() / 1000), accounts: {}, codex: null };
    for (const acc of accounts() || []) {
      if (!acc?.id) continue;
      try { out.accounts[acc.id] = await syncClaude(acc); } catch { out.accounts[acc.id] = unknown(memOf(`claude-${acc.id}`)); }
    }
    if (codexHome && fs.existsSync(codexHome)) {
      try { out.codex = await syncCodex(); } catch { out.codex = unknown(memOf('codex')); }
    }
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      writeAtomic(STATUS, JSON.stringify(out, null, 2) + '\n', 0o644);
    } catch { /* prochain passage */ }
    last = out;
    return out;
  }

  return { sync, status: () => last, paths: { coffre: COFFRE, status: STATUS } };
}
