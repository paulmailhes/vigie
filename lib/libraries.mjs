// Vigie — bibliothèques d'agents : un dépôt git (GitHub ou autre) qui contient un dossier par agent, ajouté par son
// adresse, cloné dans data/agent-libraries/<id>/ et tenu à jour toutes les heures (docs/agents.md, « Partager des
// agents : les bibliothèques »). L'auteur modifie ses agents et fait git push ; chaque Vigie qui a ajouté la
// bibliothèque la récupère tout seul, sans nouvelle version de Vigie.
//
// git est lancé sans shell, avec des arguments, sans jamais poser de question (GIT_TERMINAL_PROMPT=0, SSH en
// BatchMode) : les identifiants du Mac (trousseau, gh, clé SSH) servent tels quels. Rien du dépôt n'est exécuté : pas
// de hook (core.hooksPath=/dev/null, où rien ne peut exister), pas de sous-module, liens symboliques extraits comme de
// simples fichiers puis retirés de la copie ; seuls https et ssh sont permis. La copie est en lecture seule pour Vigie :
// une mise à jour la remplace par la dernière version publiée (fetch puis reset --hard), et garde la copie d'avant si
// elle échoue. La liste des agents ne lance jamais git : elle lit les fichiers de la copie (lib/agents.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { maskSecrets } from './indexer.mjs';
import { libraryFolders, slugOf } from './agents.mjs';

export const GIT_TIMEOUT_MS = 90_000;
export const URL_MAX = 2048;
export const LIBRARIES_MAX = 20;
export const REPO_FILES_MAX = 10_000;
export const UPDATE_EVERY_MS = 3600_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LIB_ID_MAX = 40;
const OUT_MAX = 8 * 1024 * 1024, ERR_MAX = 64 * 1024;
const LOW_PRIORITY = 15; // comme les relevés de fond des comptes et des MCP

export const MSG = {
  badUrl: 'Adresse refusée : colle l\'adresse du dépôt (https://github.com/… ou git@github.com:…).',
  credentials: 'N\'écris pas d\'identifiant dans l\'adresse : git utilise ceux de ton Mac.',
  duplicate: 'Cette bibliothèque est déjà là.',
  cloneFail: 'Dépôt introuvable, ou git n\'a pas accès : vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH).',
  updateFail: 'Mise à jour impossible : dépôt introuvable, ou git n\'a pas accès. Vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH).',
  noGit: 'git n\'est pas installé sur ton Mac : installe les outils de développement (xcode-select --install), puis réessaie.',
  offlineAdd: 'Pas de connexion au serveur du dépôt : vérifie ta connexion à internet, puis réessaie.',
  offline: 'Pas de connexion au serveur du dépôt : vérifie ta connexion à internet. Vigie réessaiera dans une heure.',
  slowAdd: 'Le dépôt n\'a pas répondu en 90 s : vérifie ta connexion à internet, puis réessaie.',
  slow: 'Le dépôt n\'a pas répondu en 90 s : vérifie ta connexion à internet. Vigie réessaiera dans une heure.',
  tooBig: `Dépôt trop gros pour une bibliothèque : ${REPO_FILES_MAX.toLocaleString('fr-FR').replace(/ /g, ' ')} fichiers au plus. Garde dans ce dépôt les agents et leurs fichiers seulement.`,
  tooMany: `${LIBRARIES_MAX} bibliothèques au plus : retires-en une, puis réessaie.`,
  notFound: 'Bibliothèque introuvable : elle a déjà été retirée. Rouvre la page Agents.',
  missing: 'Copie de la bibliothèque absente : clique sur « Mettre à jour » pour la récupérer.',
  removed: 'Bibliothèque retirée.',
};

// ---------- adresses ----------
// Acceptées : https://<hôte public>/<chemin>, git@<hôte>:<chemin>(.git), ssh://git@<hôte>[:port]/<chemin>. Tout le
// reste est refusé : file://, chemins locaux, ext::, http://, une option (« - » en tête), des espaces, des caractères de
// contrôle ou hors ASCII, plus de 2 048 caractères. Lu par des expressions strictes (pas par new URL, qui ne lit pas
// une adresse comme git et curl) : l'hôte est fait de lettres, chiffres, points et tirets, son dernier élément n'est
// jamais un nombre (1.2.3 ou 0x7f.1 se liraient comme une adresse IP), une adresse IP n'est permise qu'en quatre nombres
// sans zéro en tête, et publique. Rend { url, key, name } (key : la même adresse quelle que soit sa forme, pour
// reconnaître un doublon ; name : le nom du dépôt), ou { error }.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Noms qui ne mènent jamais à un serveur public (réseau local, réservés aux essais).
const LOCAL_TLD = new Set(['localhost', 'local', 'internal', 'lan', 'home', 'corp', 'intranet', 'private', 'arpa', 'test', 'invalid', 'example', 'onion']);
function privateV4(h) {
  const [a, b, c] = h.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}
function publicHost(raw) {
  const h = raw.toLowerCase();
  if (!h || h.length > 253) return false;
  if (IPV4.test(h)) return !privateV4(h);
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  const tld = labels[labels.length - 1];
  return !/^\d+$/.test(tld) && !/^0x/.test(tld) && !LOCAL_TLD.has(tld);
}
// Chemin d'un dépôt : des éléments faits de lettres, chiffres et . _ ~ % + -, séparés par « / », ni vides ni « . » ou
// « .. », et dont aucun ne commence par « - ».
function repoPath(p) {
  const parts = p.replace(/\/+$/, '').split('/');
  if (!parts.length || parts.some((s) => !/^[A-Za-z0-9._~%+-]+$/.test(s) || s === '.' || s === '..' || s.startsWith('-'))) return null;
  return parts;
}
function nameFrom(parts) {
  let n = parts[parts.length - 1].replace(/\.git$/i, '');
  try { n = decodeURIComponent(n); } catch { /* tel quel */ }
  n = n.replace(/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/gu, ' ').trim();
  return n.length > 100 ? `${n.slice(0, 99)}…` : n;
}
const keyOf = (host, parts) => `${host.toLowerCase()}/${parts.join('/').replace(/\.git$/i, '').toLowerCase()}`;

export function checkUrl(input) {
  const no = { error: MSG.badUrl };
  if (typeof input !== 'string') return no;
  const url = input.trim();
  if (!url || url.length > URL_MAX || url.startsWith('-') || !/^[\x21-\x7e]+$/.test(url)) return no;
  // Un identifiant écrit avant l'hôte (« alex:jeton@ ») : la phrase qui dit de l'enlever. Autre chose avant un « @ »
  // (« github.com\@127.0.0.1 ») : une adresse refusée.
  const userinfo = (s) => /^[A-Za-z0-9._~%!$&'()*+,;=:-]*@/.test(s);
  let m = /^https:\/\/([^/?#]*)(\/[^?#]*)?$/.exec(url);
  if (m) {
    if (m[1].includes('@')) return userinfo(m[1]) ? { error: MSG.credentials } : no;
    const hp = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(m[1]);
    if (!hp || !publicHost(hp[1]) || (hp[2] && (Number(hp[2]) < 1 || Number(hp[2]) > 65535))) return no;
    if (!m[2] || m[2].includes('@')) return m[2]?.includes('@') ? { error: MSG.credentials } : no;
    const parts = repoPath(m[2].slice(1));
    if (!parts) return no;
    return { url, key: keyOf(hp[1], parts), name: nameFrom(parts) };
  }
  m = /^ssh:\/\/([^/]*)(\/.*)$/.exec(url);
  if (m) {
    const at = m[1].lastIndexOf('@');
    if (at < 0) return no;
    const user = m[1].slice(0, at);
    if (user.includes(':')) return { error: MSG.credentials };
    const hp = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(m[1].slice(at + 1));
    if (user !== 'git' || !hp || !publicHost(hp[1]) || (hp[2] && (Number(hp[2]) < 1 || Number(hp[2]) > 65535))) return no;
    const parts = repoPath(m[2].slice(1));
    if (!parts) return no;
    return { url, key: keyOf(hp[1], parts), name: nameFrom(parts) };
  }
  m = /^git@([A-Za-z0-9.-]+):([^:]+)$/.exec(url);
  if (m) {
    const parts = !m[2].startsWith('/') && repoPath(m[2]);
    if (!publicHost(m[1]) || !parts) return no;
    return { url, key: keyOf(m[1], parts), name: nameFrom(parts) };
  }
  // « https://alex:jeton@… » mal écrit, « user:pass@hôte:chemin » : la même aide que pour une adresse https.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url)) return { error: MSG.credentials };
  return no;
}

// ---------- git est-il là ? ----------
// /usr/bin/git n'est qu'un relais : sans outils de développement, le lancer ouvre la fenêtre d'installation d'Apple.
// On regarde donc les fichiers, sans rien lancer : le dossier des outils choisi (DEVELOPER_DIR, sinon le choix de
// xcode-select, sinon Xcode puis les outils en ligne de commande, dans l'ordre où le relais les cherche) doit contenir
// usr/bin/git. Un autre git (VIGIE_GIT_BIN) : présent et exécutable.
export const DEV_DIRS = ['/Applications/Xcode.app/Contents/Developer', '/Library/Developer/CommandLineTools'];
export const SELECT_LINKS = ['/var/db/xcode_select_link', '/var/select/developer_dir'];
const executable = (p) => { try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export function gitInstalled(bin, { env = process.env, shim = '/usr/bin/git', devDirs = DEV_DIRS, selectLinks = SELECT_LINKS } = {}) {
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) return false;
  if (path.resolve(bin) !== shim) return executable(bin);
  let dirs = null;
  if (env.DEVELOPER_DIR) dirs = [env.DEVELOPER_DIR];
  else {
    for (const l of selectLinks) {
      try { const t = fs.readlinkSync(l); dirs = [path.resolve(path.dirname(l), t)]; break; } catch { /* pas de choix ici */ }
    }
  }
  for (const d of dirs ?? devDirs) if (isDir(d)) return executable(path.join(d, 'usr', 'bin', 'git'));
  return false;
}

// ---------- lancer git ----------
// Réglages passés à chaque commande (en ligne de commande : ils passent avant tout réglage du Mac ou de la copie).
export const SAFE_CONFIG = [
  'core.hooksPath=/dev/null', 'core.symlinks=false', 'core.fsmonitor=false', 'core.protectHFS=true', 'core.protectNTFS=true',
  'protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always', 'protocol.file.allow=never',
  'submodule.recurse=false', 'transfer.fsckObjects=true', 'gc.auto=0', 'maintenance.auto=false', 'credential.interactive=false',
].flatMap((c) => ['-c', c]);
// Environnement : celui du moteur sans aucune variable GIT_* (GIT_DIR, GIT_CONFIG_PARAMETERS… ne doivent rien
// changer), et jamais de question : ni terminal, ni fenêtre de mot de passe, ni question de SSH.
export function gitEnv(base = process.env, ceiling = null) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('GIT_') && k !== 'SSH_ASKPASS' && k !== 'SSH_ASKPASS_REQUIRE') env[k] = v;
  return {
    ...env, PATH: env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1', ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}),
  };
}

// Ligne utile de ce que git a écrit : celle qui dit le refus (introuvable, accès refusé…), sinon la dernière
// « fatal: », sinon la dernière ligne ; sans jeton ni mot de passe, 200 caractères au plus.
const NOISE = /^(?:hint:|Cloning into|remote: (?:Enumerating|Counting|Compressing|Total)|(?:Receiving|Resolving|Updating) )/;
const TELLING = /permission denied|not found|authentication failed|could not read (?:username|password)|terminal prompts disabled|host key verification failed|does not exist|does not appear to be a git repository|access denied|not authorized|forbidden|couldn't find remote ref/i;
const NETWORK = /could not resolve host|could not resolve hostname|failed to connect|connection timed out|operation timed out|network is unreachable|connection refused|no route to host|temporary failure in name resolution|nodename nor servname|connection reset|ssl_error|unable to access .*: (?:recv|send) failure/i;
export function mask(s) {
  return maskSecrets(String(s))
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1••••@')
    .replace(/\bglpat-[A-Za-z0-9_-]{10,}/g, '••••')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '••••');
}
export function gitLine(stderr) {
  const lines = String(stderr || '').split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  const line = lines.find((l) => TELLING.test(l)) ?? lines.filter((l) => /^fatal:/.test(l)).pop() ?? lines.pop() ?? '';
  const s = mask(line).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// Une commande git : { ok, code, out, err, timedOut, tooBig }. Sans shell, dans son propre groupe de processus (au
// bout du délai, git et ce qu'il a lancé, ssh ou https, sont arrêtés ensemble) ; priorité basse si demandé.
function runGit(bin, args, { cwd, env, timeoutMs, low, lower }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } catch { return resolve({ ok: false, code: null, out: '', err: '', timedOut: false }); }
    if (low && child.pid) { try { lower(child.pid); } catch { /* déjà fini */ } }
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, timedOut = false, tooBig = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* déjà fini */ } } };
    const t = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', (c) => { outBytes += c.length; if (outBytes > OUT_MAX) { tooBig = true; kill(); } else out.push(c); });
    child.stderr.on('data', (c) => { if (errBytes < ERR_MAX) { err.push(c); errBytes += c.length; } });
    child.on('error', () => { clearTimeout(t); resolve({ ok: false, code: null, out: '', err: '', timedOut, tooBig }); });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0 && !timedOut && !tooBig, code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), timedOut, tooBig });
    });
  });
}

class LibError extends Error {}

// ---------- bibliothèques ----------
// dataDir : données du moteur. Injectables pour les essais : gitBin (VIGIE_GIT_BIN), gitReady (git présent ?), now,
// timeoutMs, lower (priorité basse d'un processus), env.
export function createLibraries({
  dataDir, gitBin = '/usr/bin/git', gitReady = () => gitInstalled(gitBin), now = () => new Date(), timeoutMs = GIT_TIMEOUT_MS,
  lower = (pid) => os.setPriority(pid, LOW_PRIORITY), env = process.env,
} = {}) {
  if (!dataDir) throw new Error('dataDir manquant');
  const FILE = path.resolve(dataDir, 'agent-libraries.json');
  const ROOT = path.resolve(dataDir, 'agent-libraries');
  const busy = new Set();
  const iso = () => now().toISOString();

  // Une opération à la fois (ajout, mise à jour, retrait), dans l'ordre des demandes.
  let chain = Promise.resolve();
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // Liste : [{ id, url, addedAt, updatedAt, checkedAt, commit, error }] ; illisible : vide. Une entrée dont l'adresse
  // ne passe plus la vérification reste listée (pour pouvoir la retirer), avec l'erreur, et git ne la voit jamais.
  function entries() {
    let j;
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
    if (!Array.isArray(j)) return [];
    const seen = new Set();
    const out = [];
    for (const e of j) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID_RE.test(e.id) || seen.has(e.id) || typeof e.url !== 'string') continue;
      seen.add(e.id);
      const c = checkUrl(e.url);
      const str = (v) => (typeof v === 'string' && v.length <= 2000 ? v : null);
      out.push({
        id: e.id, url: e.url.slice(0, URL_MAX), addedAt: str(e.addedAt), updatedAt: str(e.updatedAt), checkedAt: str(e.checkedAt),
        commit: typeof e.commit === 'string' && /^[0-9a-f]{40,64}$/.test(e.commit) ? e.commit : null,
        error: c.error ?? str(e.error), valid: !c.error, name: c.name || e.id, key: c.key || null,
      });
    }
    return out.slice(0, LIBRARIES_MAX);
  }
  function save(list) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const rows = list.map((e) => ({ id: e.id, url: e.url, addedAt: e.addedAt, updatedAt: e.updatedAt, checkedAt: e.checkedAt, commit: e.commit, error: e.error }));
    const tmp = `${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, FILE); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* déjà parti */ } throw e; }
  }
  // Une seule entrée changée, relue juste avant (une autre a pu changer entre-temps).
  function patch(id, change) {
    const list = entries();
    const e = list.find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, change);
    save(list);
    return e;
  }

  // Dossier de la copie : data/agent-libraries/<id>, jamais ailleurs.
  const dirOf = (id) => {
    if (!ID_RE.test(id)) throw new Error('id invalide');
    return path.join(ROOT, id);
  };
  const realDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
  const present = (id) => realDir(dirOf(id)) && realDir(path.join(dirOf(id), '.git'));
  // Retire un dossier de data/agent-libraries (copie, copie temporaire), sans suivre aucun lien.
  function wipe(p) {
    if (path.dirname(p) !== ROOT || !path.basename(p) || path.basename(p) === '..') throw new Error('hors des bibliothèques');
    fs.rmSync(p, { recursive: true, force: true });
  }
  function ensureRoot() {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(ROOT, 0o700); } catch { /* lu tel quel */ }
    if (!realDir(ROOT)) throw new LibError('Dossier des bibliothèques illisible : vérifie les droits de ~/.vigie/data, puis réessaie.');
  }

  // GIT_CEILING_DIRECTORIES : git ne cherche jamais de dépôt au-dessus de data/agent-libraries (une installation
  // depuis les sources a son propre .git plus haut).
  const git = (args, { cwd = ROOT, low = false } = {}) => runGit(gitBin, [...SAFE_CONFIG, ...args], { cwd, env: gitEnv(env, path.resolve(dataDir)), timeoutMs, low, lower });
  // Commande sur une copie : le dépôt et l'arbre nommés tous les deux (git ne cherche pas de dépôt plus haut, et un
  // réglage de la copie ne peut pas envoyer l'arbre ailleurs).
  const inCopy = (dir, args, opts) => git(['-C', dir, `--git-dir=${path.join(dir, '.git')}`, `--work-tree=${dir}`, ...args], { ...opts, cwd: dir });

  // Échec de git → phrase : délai, réseau, sinon accès (avec la ligne utile de git).
  function failure(r, { adding }) {
    if (r.timedOut) return adding ? MSG.slowAdd : MSG.slow;
    if (NETWORK.test(r.err)) return adding ? MSG.offlineAdd : MSG.offline;
    const line = gitLine(r.err);
    return `${adding ? MSG.cloneFail : MSG.updateFail}${line ? ` Git : « ${line} »` : ''}`;
  }
  // Après une extraction : fichiers comptés (trop : refusé), liens symboliques retirés (git les a écrits comme de
  // simples fichiers qui portent le chemin visé : ils ne servent à rien), et le commit extrait.
  async function settle(dir, { low = false, adding = false } = {}) {
    const ls = await inCopy(dir, ['ls-files', '-s', '-z'], { low });
    if (ls.tooBig) throw new LibError(MSG.tooBig);
    if (!ls.ok) throw new LibError(failure(ls, { adding }));
    const items = ls.out.split('\0').filter(Boolean);
    if (items.length > REPO_FILES_MAX) throw new LibError(MSG.tooBig);
    for (const it of items) {
      const tab = it.indexOf('\t');
      if (tab < 0 || !it.startsWith('120000 ')) continue;
      const p = path.resolve(dir, it.slice(tab + 1));
      const rel = path.relative(dir, p);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue; // jamais hors de la copie
      try { if (!fs.lstatSync(p).isDirectory()) fs.unlinkSync(p); } catch { /* déjà parti */ }
    }
    const head = await inCopy(dir, ['rev-parse', '--verify', 'HEAD'], { low });
    const commit = head.out.trim();
    if (!head.ok || !/^[0-9a-f]{40,64}$/.test(commit)) throw new LibError(failure(head, { adding }));
    return commit;
  }
  // Clone dans une copie temporaire (data/agent-libraries/.<id>.<hasard>.tmp), puis la met en place. Rend le commit.
  // Toujours dans la file : les copies temporaires d'avant (moteur arrêté en plein clonage) ne servent plus à personne.
  async function cloneInto(id, url, { adding, low = false }) {
    ensureRoot();
    sweep();
    const tmp = path.join(ROOT, `.${id}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      const r = await git(['clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules',
        '-c', 'core.symlinks=false', '-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false', '-c', 'core.hooksPath=/dev/null',
        '--', url, tmp], { low });
      if (!r.ok) throw new LibError(failure(r, { adding }));
      const commit = await settle(tmp, { low, adding });
      const dest = dirOf(id);
      if (fs.existsSync(dest) || isLink(dest)) wipe(dest);
      fs.renameSync(tmp, dest);
      fs.chmodSync(dest, 0o700);
      return commit;
    } finally {
      try { wipe(tmp); } catch { /* déjà en place */ }
    }
  }
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  // Copies temporaires laissées par un arrêt du moteur en plein clonage.
  function sweep() {
    let names = [];
    try { names = fs.readdirSync(ROOT); } catch { return; }
    for (const n of names) if (/^\..+\.tmp$/.test(n)) { try { wipe(path.join(ROOT, n)); } catch { /* suivant */ } }
  }
  const diskError = (e) => {
    if (e instanceof LibError) return e.message;
    const why = { ENOSPC: 'disque plein', EACCES: 'droits insuffisants', EPERM: 'droits insuffisants', EROFS: 'disque en lecture seule' }[e?.code];
    return why ? `Bibliothèque impossible à enregistrer : ${why}. Libère de la place ou vérifie les droits de ~/.vigie, puis réessaie.`
      : 'Bibliothèque impossible à enregistrer : réessaie dans un instant.';
  };

  const count = (id) => (present(id) ? libraryFolders(dirOf(id)).length : 0);
  const agentsWord = (n) => `${n} agent${n > 1 ? 's' : ''}`;

  // Vue d'une bibliothèque (GET /api/v2/agents, réponses des écritures).
  function viewOf(e) {
    const here = present(e.id);
    const error = e.error ?? (here ? null : MSG.missing);
    return {
      id: e.id, name: e.name, url: e.url, addedAt: e.addedAt, updatedAt: e.updatedAt, commit: e.commit ? e.commit.slice(0, 7) : null,
      status: busy.has(e.id) ? 'updating' : error ? 'error' : 'ok', error, agents: here ? count(e.id) : 0,
    };
  }
  const view = () => entries().map(viewOf);

  // Copies présentes, pour la liste des agents : [{ id, name, dir }], dans l'ordre d'ajout.
  const copies = () => entries().filter((e) => present(e.id)).map((e) => ({ id: e.id, name: e.name, dir: dirOf(e.id) }));

  // Ajout : adresse vérifiée, git présent, pas de doublon, puis clonage (jusqu'à 90 s). { ok, library, message } ou
  // { ok: false, status, error }.
  function add(rawUrl) {
    const c = checkUrl(rawUrl);
    if (c.error) return Promise.resolve({ ok: false, status: 400, error: c.error });
    return exclusive(async () => {
      if (!gitReady()) return { ok: false, status: 400, error: MSG.noGit };
      const list = entries();
      if (list.some((e) => e.key === c.key || e.url === c.url)) return { ok: false, status: 400, error: MSG.duplicate };
      if (list.length >= LIBRARIES_MAX) return { ok: false, status: 400, error: MSG.tooMany };
      const base = slugOf(c.name, LIB_ID_MAX) || 'bibliotheque';
      const ids = new Set(list.map((e) => e.id));
      let id = base;
      for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
      let commit;
      try {
        commit = await cloneInto(id, c.url, { adding: true });
        const at = iso();
        save([...entries(), { id, url: c.url, addedAt: at, updatedAt: at, checkedAt: at, commit, error: null }]);
      } catch (e) {
        if (commit) { try { wipe(dirOf(id)); } catch { /* rien à retirer */ } }
        return { ok: false, status: 400, error: diskError(e) };
      }
      const lib = viewOf(entries().find((e) => e.id === id));
      const n = lib.agents;
      return { ok: true, library: lib, message: n ? `Bibliothèque ajoutée : ${agentsWord(n)}.` : 'Bibliothèque ajoutée, sans agent pour l\'instant : chaque agent est un dossier du dépôt avec son AGENT.md.' };
    });
  }

  // Mise à jour d'une bibliothèque (déjà dans la file) : fetch puis reset --hard sur la copie ; copie absente ou
  // abîmée : clonée de nouveau. Échec : la copie d'avant reste, l'erreur est gardée. Rend l'entrée à jour, ou null.
  async function updateOne(id, { low }) {
    const e = entries().find((x) => x.id === id);
    if (!e) return null;
    if (!e.valid) return patch(id, { checkedAt: iso() });
    busy.add(id);
    try {
      if (!gitReady()) return patch(id, { checkedAt: iso(), error: MSG.noGit });
      const dir = dirOf(id);
      let commit;
      if (!present(id)) commit = await cloneInto(id, e.url, { adding: false, low });
      else {
        const f = await inCopy(dir, ['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin'], { low });
        if (!f.ok) return patch(id, { checkedAt: iso(), error: failure(f, { adding: false }) });
        const r = await inCopy(dir, ['reset', '--hard', '--no-recurse-submodules', 'FETCH_HEAD'], { low });
        if (!r.ok) return patch(id, { checkedAt: iso(), error: failure(r, { adding: false }) });
        commit = await settle(dir, { low });
      }
      const at = iso();
      return patch(id, { commit, updatedAt: at, checkedAt: at, error: null });
    } catch (err) {
      try { return patch(id, { checkedAt: iso(), error: diskError(err) }); } catch { return entries().find((x) => x.id === id) ?? null; }
    } finally { busy.delete(id); }
  }

  // Mise à jour demandée (POST) : une bibliothèque, ou toutes, l'une après l'autre. { ok, libraries, message } ou
  // { ok: false, status, error, libraries }.
  async function update(id = null) {
    if (id !== null && id !== undefined) {
      if (typeof id !== 'string' || !entries().some((e) => e.id === id)) return { ok: false, status: 404, error: MSG.notFound };
      const e = await exclusive(() => updateOne(id, { low: false }));
      if (!e) return { ok: false, status: 404, error: MSG.notFound };
      const v = viewOf(e);
      if (v.error) return { ok: false, status: 400, error: v.error, libraries: view() };
      return { ok: true, libraries: view(), message: `Bibliothèque à jour : ${agentsWord(v.agents)}.` };
    }
    const ids = entries().map((e) => e.id);
    if (!ids.length) return { ok: true, libraries: [], message: 'Aucune bibliothèque à mettre à jour.' };
    const failed = [];
    for (const x of ids) {
      const e = await exclusive(() => updateOne(x, { low: false }));
      if (e?.error) failed.push(e);
    }
    if (!failed.length) return { ok: true, libraries: view(), message: ids.length > 1 ? 'Bibliothèques à jour.' : `Bibliothèque à jour : ${agentsWord(count(ids[0]))}.` };
    const first = `${failed[0].name} : ${failed[0].error}`;
    return { ok: false, status: 400, error: failed.length > 1 ? `${failed.length} bibliothèques pas à jour. ${first}` : first, libraries: view() };
  }

  // Retrait : l'entrée, puis la copie.
  function remove(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return Promise.resolve({ ok: false, status: 404, error: MSG.notFound });
    return exclusive(() => {
      const list = entries();
      if (!list.some((e) => e.id === id)) return { ok: false, status: 404, error: MSG.notFound };
      try {
        save(list.filter((e) => e.id !== id));
        wipe(dirOf(id));
      } catch (e) { return { ok: false, status: 400, error: diskError(e) }; }
      return { ok: true, message: MSG.removed };
    });
  }

  // Mise à jour de fond : les bibliothèques relevées il y a plus d'une heure (ou jamais, ou à une date dans le futur :
  // horloge changée), une à la fois, en priorité basse ; silencieuse (l'erreur reste dans la liste). Une minute de
  // marge : la tâche du serveur passe toutes les 10 min. Rend les ids mis à jour.
  const due = (e) => {
    const at = Date.parse(e.checkedAt ?? ''), t = now().getTime();
    return !Number.isFinite(at) || at > t || t - at >= UPDATE_EVERY_MS - 60_000;
  };
  let ticking = false;
  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const ids = entries().filter((e) => e.valid && due(e)).map((e) => e.id);
      for (const id of ids) await exclusive(() => updateOne(id, { low: true }));
      return ids;
    } finally { ticking = false; }
  }

  return { file: FILE, root: ROOT, entries, view, copies, add, update, remove, tick, gitReady, idle: () => chain };
}
