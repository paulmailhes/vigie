// Vigie — bibliothèques d'agents : un dépôt git (GitHub ou autre) qui contient un dossier par agent, ajouté par son
// adresse et tenu à jour toutes les heures (docs/agents.md, « Partager des agents : les bibliothèques »). L'auteur
// modifie ses agents et fait git push ; chaque Vigie qui a ajouté la bibliothèque la récupère tout seul, sans nouvelle
// version de Vigie.
//
// Versions figées : chaque version publiée est extraite dans un dossier neuf, data/agent-libraries/<id>/<commit7>/,
// qui ne change plus jamais. {{dossier_agent}} nomme ce dossier : une conversation lancée y lit toujours les scripts
// de sa consigne, même après une mise à jour. Une version d'avant reste 24 h (500 Mo au plus pour toutes les versions
// d'avant d'une bibliothèque), puis elle est retirée.
// Une mise à jour fait comme l'ajout : la version publiée est lue (git ls-remote, une petite requête) ; si elle a
// changé, le dépôt est cloné sans rien extraire dans un dossier temporaire, ses fichiers sont comptés (10 000 et
// 200 Mo au plus) AVANT d'extraire, puis seuls les fichiers ordinaires sont extraits dans la nouvelle version, et la
// liste passe à elle d'un seul coup. Aucun dépôt git ne reste sur le disque : pas de verrou laissé par un git arrêté,
// pas de réglage de copie qu'une conversation pourrait modifier, une branche par défaut renommée suivie d'elle-même.
//
// git est lancé sans shell, avec des arguments, sans jamais poser de question (GIT_TERMINAL_PROMPT=0, SSH en
// BatchMode) : les identifiants du Mac (trousseau, gh, clé SSH) servent tels quels. Rien du dépôt n'est exécuté : pas
// de hook (core.hooksPath=/dev/null), pas de sous-module, pas de filtre git-lfs, ni lien symbolique ni sous-module
// extraits ; seuls https et ssh sont permis. Un hôte https est résolu avant git : une adresse privée est refusée, et
// l'adresse vérifiée est figée pour git (http.curloptResolve). La liste des agents ne lance jamais git : elle lit les
// fichiers de la version en service (lib/agents.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { maskSecrets } from './indexer.mjs';
import { libraryFolders, slugOf, assignIds } from './agents.mjs';

export const GIT_TIMEOUT_MS = 90_000;
export const URL_MAX = 2048;
export const LIBRARIES_MAX = 20;
export const REPO_FILES_MAX = 10_000;
export const REPO_BYTES_MAX = 200 * 1024 * 1024;
export const UPDATE_EVERY_MS = 3600_000;
// Versions d'avant gardées pour les conversations déjà lancées : 24 h, 500 Mo au plus pour elles toutes (les plus
// récentes d'abord), 24 au plus.
export const RETIRED_KEEP_MS = 24 * 3600_000;
export const RETIRED_MAX = 24;
export const RETIRED_BYTES_MAX = 500 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const LIB_ID_MAX = 40;
const OUT_MAX = 8 * 1024 * 1024, ERR_MAX = 64 * 1024;
const LOW_PRIORITY = 15; // comme les relevés de fond des comptes et des MCP

const sshCommand = (target) => `ssh -T ${target}`;
export const MSG = {
  badUrl: 'Adresse refusée : colle l\'adresse du dépôt (https://github.com/… ou git@github.com:…).',
  credentials: 'N\'écris pas d\'identifiant dans l\'adresse : git utilise ceux de ton Mac.',
  page: (repo) => `Colle l'adresse du dépôt lui-même (${repo}), pas celle d'une page.`,
  localHost: (host) => `Adresse refusée : ${host} mène à ton réseau local. Colle l'adresse d'un dépôt en ligne (https://github.com/… ou git@github.com:…).`,
  duplicate: 'Cette bibliothèque est déjà là.',
  cloneFail: 'Dépôt introuvable, ou git n\'a pas accès : vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH).',
  updateFail: 'Mise à jour impossible : dépôt introuvable, ou git n\'a pas accès. Vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH).',
  unknownHost: (target) => `Ton Mac ne connaît pas encore ce serveur : connecte-toi une fois avec ${sshCommand(target)} et accepte son empreinte, puis réessaie.`,
  empty: 'Dépôt vide : pousse au moins un agent (un dossier avec son AGENT.md).',
  noGit: 'git n\'est pas installé sur ton Mac : installe les outils de développement (xcode-select --install), puis réessaie.',
  offlineAdd: 'Pas de connexion au serveur du dépôt : vérifie ta connexion à internet, puis réessaie.',
  offline: 'Pas de connexion au serveur du dépôt : vérifie ta connexion à internet. Vigie réessaiera dans une heure.',
  slowAdd: 'Le dépôt n\'a pas répondu en 90 s : vérifie ta connexion à internet, puis réessaie.',
  slow: 'Le dépôt n\'a pas répondu en 90 s : vérifie ta connexion à internet. Vigie réessaiera dans une heure.',
  slowLocalAdd: 'La copie de la bibliothèque a pris plus de 90 s sur ton Mac : réessaie dans un instant.',
  slowLocal: 'La copie de la bibliothèque a pris plus de 90 s sur ton Mac. Vigie réessaiera dans une heure.',
  extractFail: 'Fichiers de la bibliothèque impossibles à copier sur ton Mac : demande à son auteur de vérifier le dépôt (un chemin trop long, par exemple).',
  tooBig: `Dépôt trop gros pour une bibliothèque : ${REPO_FILES_MAX.toLocaleString('fr-FR').replace(/ /g, ' ')} fichiers et ${REPO_BYTES_MAX / 1024 / 1024} Mo au plus. Garde dans ce dépôt les agents et leurs fichiers seulement.`,
  tooMany: `${LIBRARIES_MAX} bibliothèques au plus : retires-en une, puis réessaie.`,
  notFound: 'Bibliothèque introuvable : elle a déjà été retirée. Rouvre la page Agents.',
  missing: 'Copie de la bibliothèque absente : clique sur « Mettre à jour » pour la récupérer.',
  stopped: 'Le moteur de Vigie s\'arrête : réessaie dans un instant.',
  removed: 'Bibliothèque retirée.',
};

// ---------- adresses ----------
// Acceptées : https://<hôte public>/<chemin>, git@<hôte>:<chemin>(.git), ssh://git@<hôte>[:port]/<chemin>. Tout le
// reste est refusé : file://, chemins locaux, ext::, http://, une option (« - » en tête), des espaces, des caractères
// de contrôle ou hors ASCII (même encodés : %0a, %0d, %00…), plus de 2 048 caractères. Lu par des expressions
// strictes (pas par new URL, qui ne lit pas une adresse comme git et curl) : l'hôte est fait de lettres, chiffres,
// points et tirets, son dernier élément n'est jamais un nombre (1.2.3 ou 0x7f.1 se liraient comme une adresse IP), une
// adresse IP n'est permise qu'en quatre nombres sans zéro en tête, et publique. L'adresse d'une page web du dépôt
// (…/tree/main, …/blob/…, …/-/tree/…) est refusée avec l'adresse du dépôt à coller. Rend { url, key, name, repo,
// scheme, host, port, ssh }, ou { error } : key reconnaît un doublon quelle que soit la forme de l'adresse ; name :
// « propriétaire/dépôt » ; repo : le nom du dépôt (d'où vient l'id) ; ssh : ce qu'il faut taper pour se connecter
// une fois (ssh -T …).
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
// Adresse IPv6 → ses 8 groupes de 16 bits (une IPv4 écrite au bout comprise), ou null.
function hextets(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (!IPV4.test(v4[1])) return null;
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || !all.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16));
}
// Adresse qui ne mène pas à un serveur public : réseau local, la machine elle-même, réservée, ou illisible. Une IPv4
// dans une IPv6 (::ffff:a.b.c.d, NAT64 64:ff9b::/96) est jugée comme une IPv4.
export function privateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v !== 6) return true;
  const h = hextets(ip);
  if (!h) return true;
  const v4 = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return h[5] === 0 && h[6] === 0 ? true : privateV4(v4());
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return privateV4(v4());
  return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] & 0xff00) === 0xff00
    || (h[0] === 0x2001 && h[1] === 0x0db8) || (h[0] === 0x0100 && h.slice(1, 4).every((x) => x === 0));
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
// « .. », dont aucun ne commence par « - », sans caractère de contrôle encodé (%00 à %1f, %7f).
function repoPath(p) {
  const parts = p.replace(/\/+$/, '').split('/');
  if (!parts.length || parts.some((s) => !/^[A-Za-z0-9._~%+-]+$/.test(s) || s === '.' || s === '..' || s.startsWith('-') || /%(?:[01][0-9a-f]|7f)/i.test(s))) return null;
  return parts;
}
// Page web d'un dépôt plutôt que le dépôt : GitHub (tout ce qui suit propriétaire/dépôt), GitLab (…/-/…), et les
// pages courantes des autres (propriétaire/dépôt/tree, blob, src…). Rend les éléments du dépôt, ou null.
const PAGE_WORDS = new Set(['tree', 'blob', 'blame', 'raw', 'src', 'commit', 'commits', 'compare', 'branches', 'tags', 'releases',
  'pull', 'pulls', 'issues', 'actions', 'wiki', 'merge_requests']);
function pageBase(host, parts) {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (h === 'github.com' && parts.length > 2) return parts.slice(0, 2);
  const dash = parts.indexOf('-');
  if (dash >= 2) return parts.slice(0, dash);
  if (parts.length > 2 && PAGE_WORDS.has(parts[2].toLowerCase())) return parts.slice(0, 2);
  return null;
}
const CTRL = /[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/gu;
const clip100 = (s) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);
// Nom montré : « propriétaire/dépôt » (Azure DevOps : « projet/dépôt »), décodé, sur une ligne ; et le nom du dépôt seul.
function namesFrom(parts) {
  const dec = (s) => { let v = s; try { v = decodeURIComponent(s); } catch { /* tel quel */ } return v.replace(CTRL, ' ').trim(); };
  const repo = dec(parts[parts.length - 1].replace(/\.git$/i, ''));
  let i = parts.length - 2;
  if (i >= 1 && parts[i] === '_git') i--;
  const owner = i >= 0 ? dec(parts[i]) : '';
  return { repo: clip100(repo), name: clip100(owner && repo ? `${owner}/${repo}` : repo) };
}
const keyOf = (host, parts) => `${host.toLowerCase()}/${parts.join('/').replace(/\.git$/i, '').toLowerCase()}`;
const portOk = (p) => !p || (Number(p) >= 1 && Number(p) <= 65535);

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
    if (!hp || !publicHost(hp[1]) || !portOk(hp[2])) return no;
    if (!m[2] || m[2].includes('@')) return m[2]?.includes('@') ? { error: MSG.credentials } : no;
    const raw = m[2].slice(1).replace(/\/+$/, '').split('/');
    const base = raw.every(Boolean) ? pageBase(hp[1], raw) : null;
    if (base && repoPath(base.join('/'))) return { error: MSG.page(`https://${m[1]}/${base.join('/').replace(/\.git$/i, '')}`) };
    const parts = repoPath(m[2].slice(1));
    if (!parts) return no;
    return { url, key: keyOf(hp[1], parts), ...namesFrom(parts), scheme: 'https', host: hp[1].toLowerCase(), port: hp[2] ? Number(hp[2]) : 443 };
  }
  m = /^ssh:\/\/([^/]*)(\/.*)$/.exec(url);
  if (m) {
    const at = m[1].lastIndexOf('@');
    if (at < 0) return no;
    const user = m[1].slice(0, at);
    if (user.includes(':')) return { error: MSG.credentials };
    const hp = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(m[1].slice(at + 1));
    if (user !== 'git' || !hp || !publicHost(hp[1]) || !portOk(hp[2])) return no;
    const parts = repoPath(m[2].slice(1));
    if (!parts) return no;
    const port = hp[2] ? Number(hp[2]) : 22;
    return { url, key: keyOf(hp[1], parts), ...namesFrom(parts), scheme: 'ssh', host: hp[1].toLowerCase(), port,
      ssh: `${port !== 22 ? `-p ${port} ` : ''}git@${hp[1].toLowerCase()}` };
  }
  m = /^git@([A-Za-z0-9.-]+):([^:]+)$/.exec(url);
  if (m) {
    const parts = !m[2].startsWith('/') && repoPath(m[2]);
    if (!publicHost(m[1]) || !parts) return no;
    return { url, key: keyOf(m[1], parts), ...namesFrom(parts), scheme: 'ssh', host: m[1].toLowerCase(), port: 22, ssh: `git@${m[1].toLowerCase()}` };
  }
  // « https://alex:jeton@… » mal écrit, « user:pass@hôte:chemin » : la même aide que pour une adresse https.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url)) return { error: MSG.credentials };
  return no;
}

// ---------- hôte https : résolu, vérifié, figé ----------
// Le nom seul ne suffit pas (127.0.0.1.nip.io, localtest.me mènent à la machine elle-même) : l'hôte est résolu, une
// adresse privée ou locale est refusée, et les adresses vérifiées sont données à git (http.curloptResolve) pour qu'il
// ne résolve pas de nouveau (un second avis du DNS pourrait mener ailleurs). Sans attendre plus que le délai.
export function systemResolve(host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('délai'), { code: 'ETIMEOUT' })), Math.max(1, timeoutMs));
    dns.promises.lookup(host, { all: true }).then((list) => { clearTimeout(t); resolve(list.map((x) => x.address)); },
      (e) => { clearTimeout(t); reject(e); });
  });
}
// Résolveur fixe (essais, VIGIE_RESOLVE) : { "hôte": ["adresse", …] } ; un hôte absent est introuvable.
export function staticResolve(map) {
  return async (host) => {
    const list = map && Object.hasOwn(map, host) ? map[host] : null;
    if (!Array.isArray(list) || !list.length) throw Object.assign(new Error(`introuvable : ${host}`), { code: 'ENOTFOUND' });
    return list.map(String);
  };
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
// Réglages passés à chaque commande (en ligne de commande : ils passent avant tout réglage du Mac). git-lfs coupé :
// un fichier suivi par LFS reste son petit fichier pointeur (le filtre ne tourne pas, et rien ne l'exige).
export const SAFE_CONFIG = [
  'core.hooksPath=/dev/null', 'core.symlinks=false', 'core.fsmonitor=false', 'core.protectHFS=true', 'core.protectNTFS=true',
  'protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always', 'protocol.file.allow=never',
  'submodule.recurse=false', 'transfer.fsckObjects=true', 'gc.auto=0', 'maintenance.auto=false', 'credential.interactive=false',
  'filter.lfs.process=', 'filter.lfs.smudge=', 'filter.lfs.required=false',
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

// Ligne utile de ce que git a écrit, montrée après « Git : » : celle qui dit le refus (introuvable, accès refusé…),
// sinon la dernière « fatal: », sinon la dernière ligne ; sans jeton ni mot de passe, 200 caractères au plus. Jamais
// une ligne écrite par le serveur (« remote: … », « remote error: … ») : elle pourrait se faire passer pour Vigie.
const NOISE = /^(?:hint:|Cloning into|(?:Receiving|Resolving|Updating) )/;
const FROM_SERVER = /^remote:|\bremote error:/i;
const TELLING = /permission denied|not found|authentication failed|could not read (?:username|password)|terminal prompts disabled|host key verification failed|does not exist|does not appear to be a git repository|access denied|not authorized|forbidden|couldn't find remote ref/i;
const NETWORK = /could not resolve host|could not resolve hostname|failed to connect|connection timed out|operation timed out|network is unreachable|connection refused|no route to host|temporary failure in name resolution|nodename nor servname|connection reset|ssl_error|unable to access .*: (?:recv|send) failure/i;
export function mask(s) {
  return maskSecrets(String(s))
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1••••@')
    .replace(/\bglpat-[A-Za-z0-9_-]{10,}/g, '••••')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '••••');
}
export function gitLine(stderr) {
  const lines = String(stderr || '').split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !NOISE.test(l) && !FROM_SERVER.test(l));
  const line = lines.find((l) => TELLING.test(l)) ?? lines.filter((l) => /^fatal:/.test(l)).pop() ?? lines.pop() ?? '';
  const s = mask(line).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// Une commande git : { ok, code, out, buf, err, timedOut, tooBig }. Sans shell, dans son propre groupe de processus (au
// bout du délai, ou quand le moteur s'arrête, git et ce qu'il a lancé, ssh ou https, sont arrêtés ensemble) ; priorité
// basse si demandé ; `input` : ce que git lit (--stdin). `running` : les commandes en cours, pour les arrêter.
function runGit(bin, args, { cwd, env, timeoutMs, low, lower, input = null, running }) {
  return new Promise((resolve) => {
    const none = { ok: false, code: null, out: '', buf: Buffer.alloc(0), err: '', timedOut: false, tooBig: false };
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true }); } catch { return resolve(none); }
    if (low && child.pid) { try { lower(child.pid); } catch { /* déjà fini */ } }
    running.add(child);
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, timedOut = false, tooBig = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* déjà fini */ } } };
    const t = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, timeoutMs));
    if (input) { child.stdin.on('error', () => { /* git a fini avant de tout lire */ }); child.stdin.end(input); }
    child.stdout.on('data', (c) => { outBytes += c.length; if (outBytes > OUT_MAX) { tooBig = true; kill(); } else out.push(c); });
    child.stderr.on('data', (c) => { if (errBytes < ERR_MAX) { err.push(c); errBytes += c.length; } });
    child.on('error', () => { clearTimeout(t); running.delete(child); resolve({ ...none, timedOut, tooBig }); });
    child.on('close', (code) => {
      clearTimeout(t);
      running.delete(child);
      const buf = Buffer.concat(out);
      resolve({ ok: code === 0 && !timedOut && !tooBig, code, out: buf.toString('utf8'), buf, err: Buffer.concat(err).toString('utf8'), timedOut, tooBig });
    });
  });
}

// Arbre d'une version (git ls-tree -r -l -z) : nombre de fichiers, octets, et la liste des fichiers ordinaires à
// extraire (chemins tels quels, terminés par \0, pour checkout-index --stdin). Liens symboliques et sous-modules :
// comptés, jamais extraits. Un seul passage.
function treeOf(buf) {
  let files = 0, bytes = 0;
  const regular = [];
  const ZERO = Buffer.from([0]);
  for (let start = 0; start < buf.length;) {
    let end = buf.indexOf(0, start);
    if (end < 0) end = buf.length;
    const tab = buf.indexOf(9, start);
    if (tab > start && tab < end) {
      const [mode, type, , size] = buf.toString('latin1', start, tab).trim().split(/\s+/);
      if (type === 'blob') {
        files++;
        const n = Number(size);
        if (Number.isFinite(n) && n > 0) bytes += n;
        if (mode === '100644' || mode === '100755') regular.push(buf.subarray(tab + 1, end), ZERO);
      }
    }
    start = end + 1;
  }
  return { files, bytes, list: Buffer.concat(regular) };
}

class LibError extends Error {}

// ---------- bibliothèques ----------
// dataDir : données du moteur. Injectables pour les essais : gitBin (VIGIE_GIT_BIN), gitReady (git présent ?), now,
// timeoutMs (délai de toute une opération : 90 s), lower (priorité basse d'un processus), env, resolve (résolution
// d'un hôte https, VIGIE_RESOLVE), limits ({ files, bytes } d'une version, keptBytes : place des versions d'avant),
// takenIds (ids des agents locaux, pour que ceux d'une bibliothèque ne les prennent pas).
export function createLibraries({
  dataDir, gitBin = '/usr/bin/git', gitReady = () => gitInstalled(gitBin), now = () => new Date(), timeoutMs = GIT_TIMEOUT_MS,
  lower = (pid) => os.setPriority(pid, LOW_PRIORITY), env = process.env, resolve = systemResolve,
  limits: limitsIn = {}, takenIds = () => [],
} = {}) {
  if (!dataDir) throw new Error('dataDir manquant');
  const limits = { files: REPO_FILES_MAX, bytes: REPO_BYTES_MAX, keptBytes: RETIRED_BYTES_MAX, ...limitsIn };
  const FILE = path.resolve(dataDir, 'agent-libraries.json');
  const ROOT = path.resolve(dataDir, 'agent-libraries');
  const busy = new Set();
  const running = new Set();
  let stopped = false;
  const iso = () => now().toISOString();

  // Une opération à la fois (ajout, mise à jour, retrait), dans l'ordre des demandes.
  let chain = Promise.resolve();
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // Liste : [{ id, url, addedAt, updatedAt, checkedAt, commit, bytes, error, agents, retired }] ; illisible : vide.
  // bytes : taille de la version en service ; agents : Map nom du dossier → id attribué (retenu d'une mise à jour à
  // l'autre) ; retired : versions d'avant encore gardées, la plus récente d'abord, [{ commit, at, bytes }]. Une entrée
  // dont l'adresse ne passe plus la vérification reste listée (pour pouvoir la retirer), avec l'erreur, et git ne la
  // voit jamais.
  function entries() {
    let j;
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
    if (!Array.isArray(j)) return [];
    const seen = new Set();
    const out = [];
    const str = (v) => (typeof v === 'string' && v.length <= 2000 ? v : null);
    for (const e of j) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID_RE.test(e.id) || seen.has(e.id) || typeof e.url !== 'string') continue;
      seen.add(e.id);
      const c = checkUrl(e.url);
      const agents = new Map();
      if (e.agents && typeof e.agents === 'object' && !Array.isArray(e.agents)) {
        const used = new Set();
        for (const [k, v] of Object.entries(e.agents).slice(0, 1000)) {
          if (k && k.length <= 255 && typeof v === 'string' && ID_RE.test(v) && !used.has(v)) { agents.set(k, v); used.add(v); }
        }
      }
      const commit = typeof e.commit === 'string' && COMMIT_RE.test(e.commit) ? e.commit : null;
      const size = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
      const retired = (Array.isArray(e.retired) ? e.retired : [])
        .filter((r) => r && typeof r === 'object' && typeof r.commit === 'string' && COMMIT_RE.test(r.commit) && r.commit !== commit && str(r.at))
        .slice(0, RETIRED_MAX).map((r) => ({ commit: r.commit, at: r.at, bytes: size(r.bytes) }));
      out.push({
        id: e.id, url: e.url.slice(0, URL_MAX), addedAt: str(e.addedAt), updatedAt: str(e.updatedAt), checkedAt: str(e.checkedAt),
        commit, bytes: size(e.bytes), error: c.error ?? str(e.error), valid: !c.error, name: c.name || e.id, key: c.key || null, check: c, agents, retired,
      });
    }
    return out.slice(0, LIBRARIES_MAX);
  }
  function save(list) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const rows = list.map((e) => ({ id: e.id, url: e.url, addedAt: e.addedAt, updatedAt: e.updatedAt, checkedAt: e.checkedAt, commit: e.commit,
      bytes: e.bytes ?? 0, error: e.error, agents: Object.fromEntries(e.agents ?? []), retired: e.retired ?? [] }));
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

  // Dossiers : data/agent-libraries/<id>/ pour une bibliothèque, <id>/<commit7>/ pour chacune de ses versions (le
  // commit entier si deux versions gardées commencent par les mêmes 7 caractères). Jamais ailleurs.
  const libDir = (id) => {
    if (!ID_RE.test(id)) throw new Error('id invalide');
    return path.join(ROOT, id);
  };
  const realDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
  const versionName = (id, commit) => (realDir(path.join(libDir(id), commit)) ? commit : commit.slice(0, 7));
  const versionDir = (e) => (e.commit ? path.join(libDir(e.id), versionName(e.id, e.commit)) : null);
  const present = (e) => !!e.commit && realDir(versionDir(e));
  // Retire un dossier de data/agent-libraries (bibliothèque, version, copie temporaire), sans suivre aucun lien et
  // sans bloquer le moteur (fs.promises.rm).
  function inside(p) {
    const rel = path.relative(ROOT, p);
    const parts = rel.split(path.sep);
    return rel && !path.isAbsolute(rel) && parts.length <= 2 && parts.every((s) => s && s !== '.' && s !== '..');
  }
  async function wipe(p) {
    if (!inside(p)) throw new Error('hors des bibliothèques');
    await fs.promises.rm(p, { recursive: true, force: true });
  }
  function ensureRoot() {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(ROOT, 0o700); } catch { /* lu tel quel */ }
    if (!realDir(ROOT)) throw new LibError('Dossier des bibliothèques illisible : vérifie les droits de ~/.vigie/data, puis réessaie.');
  }
  // Copies temporaires laissées par un moteur arrêté en pleine opération (data/agent-libraries/.<id>.<hasard>.tmp).
  async function sweep() {
    let names = [];
    try { names = fs.readdirSync(ROOT); } catch { return; }
    for (const n of names) if (/^\..+\.tmp$/.test(n)) { try { await wipe(path.join(ROOT, n)); } catch { /* suivant */ } }
  }
  // Ménage d'une bibliothèque : les versions d'avant de plus de 24 h, ou au-delà de 500 Mo pour elles toutes (les plus
  // récentes passent d'abord), sont retirées de la liste ; puis tout ce qui, dans <id>/, n'est ni la version en service
  // ni une version gardée (extraction coupée, ancienne copie).
  async function tidy(id) {
    const e = entries().find((x) => x.id === id);
    if (!e) return;
    const t = now().getTime();
    const keep = [];
    let total = 0;
    for (const r of e.retired) {
      const at = Date.parse(r.at);
      // une date dans le futur (horloge changée) compte comme récente : la version n'est jamais retirée trop tôt
      if (!Number.isFinite(at) || t - at >= RETIRED_KEEP_MS) continue;
      if (keep.length >= RETIRED_MAX || total + r.bytes > limits.keptBytes) break;
      keep.push(r);
      total += r.bytes;
    }
    if (keep.length !== e.retired.length) patch(id, { retired: keep });
    const names = new Set([...(e.commit ? [versionName(id, e.commit)] : []), ...keep.map((r) => versionName(id, r.commit))]);
    let all = [];
    try { all = fs.readdirSync(libDir(id)); } catch { return; }
    for (const n of all) if (!names.has(n)) { try { await wipe(path.join(libDir(id), n)); } catch { /* suivant */ } }
  }

  // GIT_CEILING_DIRECTORIES : git ne cherche jamais de dépôt au-dessus de data/agent-libraries (une installation
  // depuis les sources a son propre .git plus haut). Chaque commande a le temps qui reste avant `deadline` (90 s pour
  // toute l'opération).
  const git = async (args, { cwd = ROOT, low = false, deadline, input = null } = {}) => {
    const halted = { ok: false, code: null, out: '', buf: Buffer.alloc(0), err: '', timedOut: false, tooBig: false, stopped: true };
    if (stopped) return halted;
    const r = await runGit(gitBin, [...SAFE_CONFIG, ...args], { cwd, env: gitEnv(env, path.resolve(dataDir)), timeoutMs: deadline - Date.now(), low, lower, input, running });
    return stopped ? halted : r;
  };

  // Échec de git → phrase. Réseau (ls-remote, clone) : délai, hôte SSH inconnu, pas de réseau, sinon accès refusé
  // (avec la ligne utile de git). Sur le Mac (lecture, extraction) : délai sans parler de connexion, sinon extraction
  // impossible.
  function failure(r, { adding, network, c }) {
    if (r.stopped) return MSG.stopped;
    if (r.timedOut) return network ? (adding ? MSG.slowAdd : MSG.slow) : (adding ? MSG.slowLocalAdd : MSG.slowLocal);
    if (network && c?.ssh && /host key verification failed/i.test(r.err)) return MSG.unknownHost(c.ssh);
    if (network && NETWORK.test(r.err)) return adding ? MSG.offlineAdd : MSG.offline;
    const line = gitLine(r.err);
    return `${network ? (adding ? MSG.cloneFail : MSG.updateFail) : MSG.extractFail}${line ? ` Git : « ${line} »` : ''}`;
  }
  // Hôte https résolu et vérifié : les réglages qui figent ses adresses pour git, ou { error }.
  async function pinOf(c, deadline, adding) {
    if (c.scheme !== 'https' || net.isIP(c.host)) return { config: [] };
    let list, timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('délai'), { code: 'ETIMEOUT' })), Math.max(1, deadline - Date.now())); });
    try { list = await Promise.race([resolve(c.host, deadline - Date.now()), late]); } catch (e) {
      return { error: e?.code === 'ETIMEOUT' ? (adding ? MSG.slowAdd : MSG.slow) : (adding ? MSG.offlineAdd : MSG.offline) };
    } finally { clearTimeout(timer); }
    const addrs = [...new Set((Array.isArray(list) ? list : []).filter((a) => typeof a === 'string' && net.isIP(a)))];
    if (!addrs.length) return { error: adding ? MSG.offlineAdd : MSG.offline };
    if (addrs.some(privateAddress)) return { error: MSG.localHost(c.host) };
    const shown = addrs.slice(0, 8).map((a) => (net.isIP(a) === 6 ? `[${a}]` : a)).join(',');
    return { config: ['-c', `http.curloptResolve=${c.host}:${c.port}:${shown}`] };
  }

  // La dernière version publiée, figée dans <id>/<commit7>/ si elle a changé (rien n'est touché à la version en
  // service `current`). Rend { commit, unchanged, bytes } ; lève LibError avec la phrase.
  async function fetchVersion(id, c, { adding, low, current }) {
    const deadline = Date.now() + timeoutMs;
    const opts = { low, deadline };
    const pin = await pinOf(c, deadline, adding);
    if (pin.error) throw new LibError(pin.error);
    ensureRoot();
    const head = await git([...pin.config, 'ls-remote', '--', c.url, 'HEAD'], opts);
    if (!head.ok) throw new LibError(failure(head, { adding, network: true, c }));
    const published = /^([0-9a-f]{40,64})\tHEAD$/m.exec(head.out)?.[1];
    if (!published) throw new LibError(MSG.empty);
    if (current && published === current) return { commit: current, unchanged: true };
    await sweep();
    const rand = () => crypto.randomBytes(6).toString('hex');
    const tmp = path.join(ROOT, `.${id}.${rand()}.tmp`);
    const gd = path.join(tmp, '.git');
    let work = null;
    try {
      // 1. le dépôt, sans rien extraire
      const r = await git([...pin.config, 'clone', '--no-checkout', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', '--', c.url, tmp], opts);
      if (!r.ok) throw new LibError(failure(r, { adding, network: true, c }));
      const local = (args, o = {}) => git([`--git-dir=${gd}`, ...args], { ...opts, cwd: tmp, ...o });
      const rev = await local(['rev-parse', '--verify', 'HEAD^{commit}']);
      const commit = rev.out.trim();
      if (!rev.ok || !COMMIT_RE.test(commit)) throw new LibError(rev.ok ? MSG.empty : failure(rev, { adding }));
      if (current && commit === current) return { commit, unchanged: true };
      // 2. compter avant d'extraire : trop gros, rien n'est écrit
      const ls = await local(['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
      if (ls.tooBig) throw new LibError(MSG.tooBig);
      if (!ls.ok) throw new LibError(failure(ls, { adding }));
      const tree = treeOf(ls.buf);
      if (tree.files > limits.files || tree.bytes > limits.bytes) throw new LibError(MSG.tooBig);
      // 3. extraire les fichiers ordinaires dans un dossier neuf, puis le mettre à sa place d'un seul coup
      const lib = libDir(id);
      fs.mkdirSync(lib, { recursive: true, mode: 0o700 });
      fs.chmodSync(lib, 0o700);
      work = path.join(lib, `.${commit.slice(0, 7)}.${rand()}.tmp`);
      fs.mkdirSync(work, { mode: 0o700 });
      const wt = { cwd: work };
      const rt = await local([`--work-tree=${work}`, 'read-tree', commit], wt);
      if (!rt.ok) throw new LibError(failure(rt, { adding }));
      if (tree.list.length) {
        // -f : deux noms qui ne diffèrent que par la casse (un seul fichier sur le disque du Mac) ne bloquent pas tout
        const co = await local([`--work-tree=${work}`, 'checkout-index', '-f', '-z', '--stdin'], { ...wt, input: tree.list });
        if (!co.ok) throw new LibError(failure(co, { adding }));
      }
      const name = current && versionName(id, current) === commit.slice(0, 7) ? commit : commit.slice(0, 7);
      const dest = path.join(lib, name);
      if (fs.existsSync(dest)) await wipe(dest);
      fs.renameSync(work, dest);
      work = null;
      return { commit, unchanged: false, bytes: tree.bytes };
    } finally {
      try { await wipe(tmp); } catch { /* déjà parti */ }
      if (work) { try { await wipe(work); } catch { /* déjà parti */ } }
    }
  }

  const diskError = (e) => {
    if (e instanceof LibError) return e.message;
    const why = { ENOSPC: 'disque plein', EACCES: 'droits insuffisants', EPERM: 'droits insuffisants', EROFS: 'disque en lecture seule' }[e?.code];
    return why ? `Bibliothèque impossible à enregistrer : ${why}. Libère de la place ou vérifie les droits de ~/.vigie, puis réessaie.`
      : 'Bibliothèque impossible à enregistrer : réessaie dans un instant.';
  };

  // Ids des agents d'une version, retenus d'une mise à jour à l'autre (premier arrivé, premier servi) : un id déjà
  // attribué à un dossier lui reste, même si une bibliothèque ajoutée avant publie un dossier du même nom ou qu'une
  // autre est retirée. Pris ailleurs : les agents locaux, et les ids des autres bibliothèques.
  function idsFor(id, commit, stored) {
    const taken = new Set();
    try { for (const x of takenIds() || []) taken.add(x); } catch { /* aucun */ }
    for (const o of entries()) if (o.id !== id) for (const v of o.agents.values()) taken.add(v);
    return assignIds(libraryFolders(path.join(libDir(id), versionName(id, commit))), id, stored, taken);
  }

  const count = (e) => (present(e) ? libraryFolders(versionDir(e)).length : 0);
  const agentsWord = (n) => `${n} agent${n > 1 ? 's' : ''}`;

  // Vue d'une bibliothèque (GET /api/v2/agents, réponses des écritures).
  function viewOf(e) {
    const here = present(e);
    const error = e.error ?? (here ? null : MSG.missing);
    return {
      id: e.id, name: e.name, url: e.url, addedAt: e.addedAt, updatedAt: e.updatedAt, commit: e.commit ? e.commit.slice(0, 7) : null,
      status: busy.has(e.id) ? 'updating' : error ? 'error' : 'ok', error, agents: here ? count(e) : 0,
    };
  }
  const view = () => entries().map(viewOf);

  // Versions en service, pour la liste des agents : [{ id, name, dir, ids }], dans l'ordre d'ajout.
  const copies = () => entries().filter(present).map((e) => ({ id: e.id, name: e.name, dir: versionDir(e), ids: e.agents }));

  // Ajout : adresse vérifiée, git présent, pas de doublon, puis la version publiée (jusqu'à 90 s). { ok, library,
  // message } ou { ok: false, status, error }.
  function add(rawUrl) {
    const c = checkUrl(rawUrl);
    if (c.error) return Promise.resolve({ ok: false, status: 400, error: c.error });
    return exclusive(async () => {
      if (!gitReady()) return { ok: false, status: 400, error: MSG.noGit };
      const list = entries();
      if (list.some((e) => e.key === c.key || e.url === c.url)) return { ok: false, status: 400, error: MSG.duplicate };
      if (list.length >= LIBRARIES_MAX) return { ok: false, status: 400, error: MSG.tooMany };
      const base = slugOf(c.repo, LIB_ID_MAX) || 'bibliotheque';
      const ids = new Set(list.map((e) => e.id));
      let id = base;
      for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
      let v = null;
      try {
        v = await fetchVersion(id, c, { adding: true, low: false, current: null });
        const at = iso();
        save([...entries(), { id, url: c.url, addedAt: at, updatedAt: at, checkedAt: at, commit: v.commit, bytes: v.bytes, error: null,
          agents: idsFor(id, v.commit, new Map()), retired: [] }]);
      } catch (e) {
        try { await wipe(libDir(id)); } catch { /* rien à retirer */ }
        return { ok: false, status: 400, error: diskError(e) };
      }
      try { await tidy(id); } catch { /* au prochain relevé */ }
      const lib = viewOf(entries().find((e) => e.id === id));
      const n = lib.agents;
      return { ok: true, library: lib, message: n ? `Bibliothèque ajoutée : ${agentsWord(n)}.` : 'Bibliothèque ajoutée, sans agent pour l\'instant : chaque agent est un dossier du dépôt avec son AGENT.md.' };
    });
  }

  // Mise à jour d'une bibliothèque (déjà dans la file) : la version publiée, figée à côté de celle en service, qui
  // devient une version gardée ; version en service absente : récupérée de nouveau. Échec : la version en service
  // reste, l'erreur est gardée. Puis le ménage (versions d'avant de plus de 24 h). Rend l'entrée à jour, ou null.
  async function updateOne(id, { low }) {
    const e = entries().find((x) => x.id === id);
    if (!e) return null;
    if (!e.valid) return patch(id, { checkedAt: iso() });
    busy.add(id);
    try {
      if (!gitReady()) return patch(id, { checkedAt: iso(), error: MSG.noGit });
      const here = present(e);
      const v = await fetchVersion(id, e.check, { adding: false, low, current: here ? e.commit : null });
      const at = iso();
      const change = { updatedAt: at, checkedAt: at, error: null };
      if (!v.unchanged) {
        change.commit = v.commit;
        change.bytes = v.bytes;
        change.retired = [...(here ? [{ commit: e.commit, at, bytes: e.bytes }] : []), ...e.retired].filter((r) => r.commit !== v.commit).slice(0, RETIRED_MAX);
      }
      change.agents = idsFor(id, v.commit, e.agents);
      return patch(id, change);
    } catch (err) {
      try { return patch(id, { checkedAt: iso(), error: diskError(err) }); } catch { return entries().find((x) => x.id === id) ?? null; }
    } finally {
      busy.delete(id);
      try { await tidy(id); } catch { /* au prochain relevé */ }
    }
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
    if (!failed.length) {
      const only = entries().find((e) => e.id === ids[0]);
      return { ok: true, libraries: view(), message: ids.length > 1 ? 'Bibliothèques à jour.' : `Bibliothèque à jour : ${agentsWord(only ? count(only) : 0)}.` };
    }
    const first = `${failed[0].name} : ${failed[0].error}`;
    return { ok: false, status: 400, error: failed.length > 1 ? `${failed.length} bibliothèques pas à jour. ${first}` : first, libraries: view() };
  }

  // Retrait : l'entrée, puis la bibliothèque et toutes ses versions.
  function remove(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return Promise.resolve({ ok: false, status: 404, error: MSG.notFound });
    return exclusive(async () => {
      const list = entries();
      if (!list.some((e) => e.id === id)) return { ok: false, status: 404, error: MSG.notFound };
      try {
        save(list.filter((e) => e.id !== id));
        await wipe(libDir(id));
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
    if (ticking || stopped) return [];
    ticking = true;
    try {
      const ids = entries().filter((e) => e.valid && due(e)).map((e) => e.id);
      for (const id of ids) await exclusive(() => updateOne(id, { low: true }));
      return ids;
    } finally { ticking = false; }
  }

  // Arrêt du moteur : chaque git en cours est arrêté avec ce qu'il a lancé (son groupe de processus), et plus aucun
  // n'est lancé. Synchrone : appelé aussi à la sortie du processus.
  function stop() {
    stopped = true;
    for (const child of running) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* déjà fini */ } }
  }

  return { file: FILE, root: ROOT, entries, view, copies, add, update, remove, tick, stop, gitReady, versionDir, running: () => running.size, idle: () => chain };
}
