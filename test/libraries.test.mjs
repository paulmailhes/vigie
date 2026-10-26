// Tests des bibliothèques d'agents (lib/libraries.mjs, et leurs agents dans lib/agents.mjs). node --test test/
// Tout vit dans un dossier temporaire. Les dépôts « publiés » sont de vrais dépôts git locaux (serveur/<chemin>), créés
// ici ; Vigie les voit derrière des adresses GitHub par un faux git (faux-git.mjs) qui note ses appels puis lance le vrai
// git en changeant https://github.com/ et git@github.com: en file://<serveur>/ : https et ssh y sont coupés, aucun
// serveur réel n'est jamais contacté. Le faux git pose aussi des hooks dans chaque clone (init.templateDir) : ils ne
// doivent jamais tourner. Sans git sur le Mac, les essais qui clonent sont sautés.
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
const { createAgents } = await import('../lib/agents.mjs');
const { MSG } = L;

const REAL_GIT = L.gitInstalled('/usr/bin/git') ? '/usr/bin/git' : null;
const NO_GIT = REAL_GIT ? false : 'git n\'est pas installé sur ce Mac';
const J = JSON.stringify;
const mode = (p) => fs.statSync(p).mode & 0o777;
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

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
const SLOW = path.join(TMP, 'lent');          // présent : clone et fetch attendent N ms
const LEAK = path.join(TMP, 'bavard');        // présent : clone et fetch échouent avec un jeton dans leur message
const OFFLINE = path.join(TMP, 'hors-ligne'); // présent : clone et fetch échouent faute de réseau
const TEMPLATE = path.join(TMP, 'modele');    // hooks posés dans chaque clone par le faux git
const MARK = path.join(TMP, 'hook-lance');    // un hook a tourné
for (const h of ['post-checkout', 'post-merge', 'reference-transaction', 'post-index-change', 'pre-auto-gc']) {
  w(path.join(TEMPLATE, 'hooks', h), `#!/bin/sh\necho "$0" >> ${J(MARK)}\n`);
  fs.chmodSync(path.join(TEMPLATE, 'hooks', h), 0o755);
}
w(FAKE, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const sub = args.find((a) => ['clone', 'fetch', 'reset', 'ls-files', 'rev-parse'].includes(a)) || null;
const env = process.env;
const gitEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_') || k === 'SSH_ASKPASS' || k === 'GCM_INTERACTIVE'));
fs.appendFileSync(${J(LOG)}, JSON.stringify({ pid: process.pid, sub, args, cwd: process.cwd(), env: gitEnv, start: Date.now() }) + '\\n');
const net = sub === 'clone' || sub === 'fetch';
if (net && fs.existsSync(${J(SLOW)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(${J(SLOW)}, 'utf8')));
if (net && fs.existsSync(${J(LEAK)})) {
  process.stderr.write("remote: Invalid username or password for https://alex:ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com\\nfatal: Authentication failed for 'https://alex:hunter2@github.com/studio/agents/'\\n");
  process.exit(128);
}
if (net && fs.existsSync(${J(OFFLINE)})) {
  process.stderr.write("fatal: unable to access 'https://github.com/studio/agents/': Could not resolve host: github.com\\n");
  process.exit(128);
}
const swap = { 'protocol.file.allow=never': 'protocol.file.allow=always', 'protocol.https.allow=always': 'protocol.https.allow=never', 'protocol.ssh.allow=always': 'protocol.ssh.allow=never' };
const r = spawnSync(${J(REAL_GIT || '/nonexistent')}, [
  '-c', ${J(`url.file://${SERVER}/.insteadOf=https://github.com/`)}, '-c', ${J(`url.file://${SERVER}/.insteadOf=git@github.com:`)},
  '-c', ${J(`init.templateDir=${TEMPLATE}`)}, ...args.map((a) => swap[a] ?? a),
], { stdio: 'inherit', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
fs.appendFileSync(${J(LOG)}, JSON.stringify({ pid: process.pid, sub, end: Date.now(), code: r.status }) + '\\n');
process.exit(r.status ?? 1);
`);
fs.chmodSync(FAKE, 0o755);
const lines = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const calls = () => lines().filter((l) => l.args);
const resetLog = () => fs.rmSync(LOG, { force: true });

// ---------- un monde neuf par essai ----------
let n = 0;
let clock = Date.parse('2026-10-26T10:00:00Z');
function world(opts = {}) {
  const root = path.join(TMP, `monde-${++n}`);
  const data = path.join(root, 'données');
  const home = path.join(root, 'maison');
  fs.mkdirSync(path.join(home, 'Code'), { recursive: true });
  const lowered = [];
  const libs = L.createLibraries({ dataDir: data, gitBin: FAKE, now: () => new Date(clock), lower: (pid) => lowered.push(pid), ...opts });
  const agentsDir = path.join(data, 'agents');
  const agents = createAgents({ dir: agentsDir, home, libraries: () => libs.copies(), now: () => new Date('2026-10-26T14:03:00') });
  const local = (id, text) => w(path.join(agentsDir, id, 'AGENT.md'), text);
  return { root, data, home, libs, agents, agentsDir, local, lowered, copy: (id) => path.join(data, 'agent-libraries', id) };
}
// Tout ce que la copie contient, hors .git : [chemin relatif, 'f' | 'd' | 'l'].
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
  const ok = {
    'https://github.com/studio/agents': ['agents', 'github.com/studio/agents'],
    'https://github.com/studio/agents.git': ['agents', 'github.com/studio/agents'],
    '  https://github.com/studio/agents/\n': ['agents', 'github.com/studio/agents'],
    'git@github.com:studio/agents.git': ['agents', 'github.com/studio/agents'],
    'git@github.com:studio/agents': ['agents', 'github.com/studio/agents'],
    'ssh://git@github.com/studio/agents.git': ['agents', 'github.com/studio/agents'],
    'ssh://git@git.studio.fr:2222/equipe/agents-studio.git': ['agents-studio', 'git.studio.fr/equipe/agents-studio'],
    'https://gitlab.com/studio/outils/Agents_Studio.git': ['Agents_Studio', 'gitlab.com/studio/outils/agents_studio'],
    'https://dev.azure.com/studio/Projet%20Web/_git/agents': ['agents', 'dev.azure.com/studio/projet%20web/_git/agents'],
    'https://140.82.112.3/studio/agents': ['agents', '140.82.112.3/studio/agents'],
  };
  for (const [url, [name, key]] of Object.entries(ok)) {
    const c = L.checkUrl(url);
    assert.deepEqual([c.error, c.name, c.key, c.url], [undefined, name, key, url.trim()], url);
  }
  const refused = [
    '', '   ', null, 42, {}, ['https://github.com/studio/agents'],
    // pas une adresse de dépôt distant
    'file:///Users/alex/agents', 'FILE:///Users/alex/agents', '/Users/alex/agents', './agents', '../agents', '~/Code/agents', 'agents',
    'ext::sh -c touch% /tmp/x', 'ext::ssh', 'git://github.com/studio/agents', 'http://github.com/studio/agents', 'HTTPS://github.com/studio/agents',
    'ftp://github.com/x', 'rsync://github.com/x', 'fd::17', 'transport::x',
    // options, espaces, caractères de contrôle ou hors ASCII, trop long
    '-uhttps://github.com/x', '--upload-pack=touch /tmp/x', '--config=core.sshCommand=x',
    'https://github.com/studio/ agents', 'https://github.com/studio/a\nb', 'https://github.com/studio/a\u0000b', 'https://github.com/studio/a\tb',
    'https://github.com/studio/a b', 'https://gíthub.com/studio/agents', 'https://github.com/studio/agents‮', 'https://github.com/studio/agents​',
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

test('ligne utile de git : le refus, sans jeton ni mot de passe', () => {
  assert.equal(L.gitLine('Cloning into \'/x\'...\nremote: Repository not found.\nfatal: repository \'https://github.com/studio/x/\' not found\n'), 'remote: Repository not found.');
  assert.equal(L.gitLine('git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n'),
    'git@github.com: Permission denied (publickey).');
  assert.equal(L.gitLine('hint: x\nfatal: something odd\nhint: y\n'), 'fatal: something odd');
  assert.equal(L.gitLine(''), '');
  const s = L.gitLine('fatal: Authentication failed for \'https://alex:hunter2@github.com/x\' token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 glpat-abcdefghij1234');
  for (const secret of ['hunter2', 'ghp_A1b2', 'glpat-abc']) assert.ok(!s.includes(secret), s);
  assert.ok(L.gitLine(`fatal: ${'x'.repeat(500)}`).length <= 200);
});

test('environnement de git : jamais de question, aucune variable GIT_* du moteur', () => {
  const env = L.gitEnv({ PATH: '/usr/bin', HOME: '/Users/alex', GIT_DIR: '/x', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_SSH: '/x', SSH_ASKPASS: '/x', SSH_AUTH_SOCK: '/tmp/agent' }, '/data');
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/Users/alex', SSH_AUTH_SOCK: '/tmp/agent', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', GIT_CEILING_DIRECTORIES: '/data',
  }, 'la clé SSH (agent ssh) et le dossier perso (trousseau, ~/.gitconfig) servent tels quels');
});

// ---------- ajout ----------

test('ajout : clonage, copie privée, git lancé sans question ni rien exécuter du dépôt ; la liste ne relance pas git', { skip: NO_GIT }, () => {
  const sha = publish('studio/agents', {
    'README.md': '# Agents du studio\n',
    'demarrer-projet/AGENT.md': agentMd('Démarrer un projet', 'Scripts : {{dossier_agent}}/figma'),
    'demarrer-projet/figma/01-fondations.js': 'figma.root;\n',
    'creer-une-page/AGENT.md': agentMd('Créer une page'),
  });
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
    assert.deepEqual(r.library, { id: 'agents', name: 'agents', url: 'https://github.com/studio/agents', addedAt: at, updatedAt: at, commit: sha.slice(0, 7),
      status: 'ok', error: null, agents: 2 });
    // liste et copie, lisibles par l'utilisateur seul
    const file = path.join(W.data, 'agent-libraries.json');
    assert.equal(mode(file), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'agents', url: 'https://github.com/studio/agents', addedAt: at, updatedAt: at, checkedAt: at, commit: sha, error: null }]);
    assert.equal(mode(W.copy('agents')), 0o700);
    assert.equal(mode(path.join(W.data, 'agent-libraries')), 0o700);
    assert.equal(fs.readFileSync(path.join(W.copy('agents'), 'README.md'), 'utf8'), '# Agents du studio\n');
    assert.deepEqual(fs.readdirSync(path.join(W.data, 'agent-libraries')), ['agents'], 'copie temporaire mise en place, rien d\'autre');
    // git : clone puis lecture de la copie, toujours avec les réglages de sécurité, sans shell, sans question
    const c = calls();
    assert.deepEqual(c.map((x) => x.sub), ['clone', 'ls-files', 'rev-parse']);
    for (const x of c) {
      assert.deepEqual(x.args.slice(0, L.SAFE_CONFIG.length), L.SAFE_CONFIG, 'réglages de sécurité en tête de chaque commande');
      for (const cfg of ['core.hooksPath=/dev/null', 'core.symlinks=false', 'protocol.file.allow=never', 'protocol.allow=never', 'submodule.recurse=false']) {
        assert.ok(x.args.includes(cfg), `${x.sub} : ${cfg}`);
      }
      assert.deepEqual(Object.keys(x.env).sort(), ['GCM_INTERACTIVE', 'GIT_ASKPASS', 'GIT_CEILING_DIRECTORIES', 'GIT_LFS_SKIP_SMUDGE', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'SSH_ASKPASS'],
        'GIT_DIR, GIT_CONFIG_PARAMETERS, GIT_SSH du moteur retirés');
      assert.deepEqual([x.env.GIT_TERMINAL_PROMPT, x.env.GIT_ASKPASS, x.env.SSH_ASKPASS, x.env.GIT_SSH_COMMAND, x.env.GIT_CEILING_DIRECTORIES],
        ['0', '', '', 'ssh -o BatchMode=yes', W.data]);
    }
    const clone = c[0].args.slice(L.SAFE_CONFIG.length);
    const tmp = clone[clone.length - 1];
    assert.deepEqual(clone, ['clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', '-c', 'core.symlinks=false',
      '-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false', '-c', 'core.hooksPath=/dev/null', '--', 'https://github.com/studio/agents', tmp]);
    assert.equal(path.dirname(tmp), path.join(W.data, 'agent-libraries'));
    assert.match(path.basename(tmp), /^\.agents\.[0-9a-f]{12}\.tmp$/);
    assert.equal(c[0].cwd, path.join(W.data, 'agent-libraries'));
    assert.deepEqual(c[1].args.slice(L.SAFE_CONFIG.length), ['-C', tmp, `--git-dir=${tmp}/.git`, `--work-tree=${tmp}`, 'ls-files', '-s', '-z'],
      'la copie est nommée, git ne cherche pas de dépôt ailleurs');
    assert.equal(fs.existsSync(MARK), false, 'aucun hook du dépôt ni du modèle n\'a tourné');
    assert.deepEqual(W.lowered, [], 'demandé par l\'utilisateur : priorité normale');
    // la liste des agents, la vue des bibliothèques : des fichiers lus, jamais git
    const before = calls().length;
    for (let i = 0; i < 3; i++) { W.agents.list(); W.libs.view(); W.agents.get('demarrer-projet'); W.agents.get('inconnu'); }
    assert.equal(calls().length, before, 'aucun git pour lire la liste');
    assert.deepEqual(W.agents.list().map((a) => [a.id, a.source]), [
      ['creer-une-page', { kind: 'library', id: 'agents', name: 'agents' }],
      ['demarrer-projet', { kind: 'library', id: 'agents', name: 'agents' }],
    ]);
  });
});

test('ajout : doublon sous une autre forme, id unique, échecs (introuvable, réseau, délai, jeton), adresse refusée, trop de bibliothèques', { skip: NO_GIT }, async () => {
  publish('studio/agents', { 'a/AGENT.md': agentMd('A') });
  publish('equipe/agents', { 'b/AGENT.md': agentMd('B') });
  const W = world();
  // même liste, délai de 800 ms (90 s pour de vrai)
  const quick = L.createLibraries({ dataDir: W.data, gitBin: FAKE, now: () => new Date(clock), timeoutMs: 800 });
  // copie temporaire laissée par un moteur arrêté en plein clonage : retirée au clonage suivant
  w(path.join(W.data, 'agent-libraries', '.vieux.0123456789ab.tmp', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal((await W.libs.add('https://github.com/studio/agents')).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(W.data, 'agent-libraries')), ['agents']);
  for (const url of ['https://github.com/studio/agents', 'https://github.com/studio/agents.git', 'https://GitHub.com/Studio/Agents/', 'git@github.com:studio/agents.git',
    'ssh://git@github.com/studio/agents']) {
    assert.deepEqual(await W.libs.add(url), { ok: false, status: 400, error: 'Cette bibliothèque est déjà là.' }, url);
  }
  const r = await W.libs.add('https://github.com/equipe/agents');
  assert.deepEqual([r.ok, r.library.id, r.library.name], [true, 'agents-2', 'agents'], 'même nom de dépôt : id suivant');
  const left = () => fs.readdirSync(path.join(W.data, 'agent-libraries')).sort();
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
  assert.deepEqual(calls(), []);
  // 20 bibliothèques au plus
  const full = Array.from({ length: L.LIBRARIES_MAX }, (_, i) => ({ id: `b${i}`, url: `https://github.com/studio/b${i}`, addedAt: null }));
  fs.writeFileSync(path.join(W.data, 'agent-libraries.json'), J(full));
  assert.deepEqual(await W.libs.add('https://github.com/studio/autre'), { ok: false, status: 400, error: '20 bibliothèques au plus : retires-en une, puis réessaie.' });
  assert.deepEqual(calls(), []);
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
  const lib = (id) => ({ kind: 'library', id, name: id });
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
  // dans la copie : aucun lien, ceux du dépôt sont retirés (git les a écrits comme de simples fichiers)
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
  // lancement d'un agent de bibliothèque : {{dossier_agent}} est son dossier dans la copie (chemin réel)
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

test('lien symbolique et sous-module dans le dépôt : ni extraits comme lien, ni suivis', { skip: NO_GIT }, async () => {
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
  const copy = W.copy('pieges');
  assert.deepEqual(walk(copy), [['.gitmodules', 'f'], ['agent', 'd'], ['agent/AGENT.md', 'f'], ['vendor', 'd'], ['vendor/outil', 'd']],
    'liens retirés, sous-module vide');
  assert.deepEqual(fs.readdirSync(path.join(copy, 'vendor', 'outil')), []);
  assert.deepEqual(calls().map((c) => c.sub), ['clone', 'ls-files', 'rev-parse'], 'aucun clonage du sous-module');
  // une nouvelle version avec un autre lien : la mise à jour le retire aussi
  publish('studio/pieges', { 'agent/notes': { link: '/etc/passwd' }, 'agent/AGENT.md': agentMd('Agent v2') });
  assert.equal((await W.libs.update('pieges')).ok, true);
  assert.ok(!walk(copy).some(([p, k]) => k === 'l' || p === 'agent/notes' || p === 'racine'));
  assert.equal(W.agents.get('agent').name, 'Agent v2');
  assert.equal(fs.existsSync(MARK), false, 'aucun hook n\'a tourné');
});

// ---------- mise à jour, retrait ----------

test('mise à jour : nouvelle version publiée, échec qui garde la copie, copie disparue reprise ; retrait', { skip: NO_GIT }, async () => {
  publish('studio/agents', { 'demarrer-projet/AGENT.md': agentMd('Démarrer v1'), 'vieux/AGENT.md': agentMd('Vieux') });
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
  assert.deepEqual(r.libraries, [{ id: 'agents', name: 'agents', url: 'https://github.com/studio/agents', addedAt: t1, updatedAt: t2, commit: v2.slice(0, 7), status: 'ok', error: null, agents: 2 }]);
  assert.notEqual(added.library.commit, v2.slice(0, 7));
  assert.deepEqual(W.agents.list().map((a) => [a.id, a.name]), [['demarrer-projet', 'Démarrer v2'], ['nouveau', 'Nouveau']], 'agent retiré du dépôt : retiré de la copie');
  const copy = W.copy('agents');
  const c = calls();
  assert.deepEqual(c.map((x) => x.sub), ['fetch', 'reset', 'ls-files', 'rev-parse']);
  const pin = ['-C', copy, `--git-dir=${copy}/.git`, `--work-tree=${copy}`];
  assert.deepEqual(c[0].args.slice(L.SAFE_CONFIG.length), [...pin, 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin']);
  assert.deepEqual(c[1].args.slice(L.SAFE_CONFIG.length), [...pin, 'reset', '--hard', '--no-recurse-submodules', 'FETCH_HEAD']);
  assert.deepEqual(W.lowered, []);
  // le dépôt n'est plus là : la copie d'avant reste, l'erreur est gardée, l'heure de la dernière mise à jour aussi
  const gone = path.join(SERVER, 'studio', 'agents-parti');
  fs.renameSync(path.join(SERVER, 'studio', 'agents'), gone);
  clock += 3600_000;
  r = await W.libs.update('agents');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.ok(r.error.startsWith('Mise à jour impossible : dépôt introuvable, ou git n\'a pas accès. Vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH). Git : « '), r.error);
  assert.deepEqual([r.libraries[0].status, r.libraries[0].error, r.libraries[0].updatedAt, r.libraries[0].commit], ['error', r.error, t2, v2.slice(0, 7)]);
  assert.deepEqual(W.agents.list().map((a) => a.name), ['Démarrer v2', 'Nouveau'], 'la dernière bonne copie sert toujours');
  // de retour : l'erreur part
  fs.renameSync(gone, path.join(SERVER, 'studio', 'agents'));
  r = await W.libs.update();
  assert.deepEqual([r.ok, r.message, r.libraries[0].status, r.libraries[0].error], [true, 'Bibliothèque à jour : 2 agents.', 'ok', null]);
  // copie disparue (effacée à la main) : signalée, puis reprise par la mise à jour
  fs.rmSync(copy, { recursive: true });
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
  assert.ok(r.error.startsWith('modeles : Mise à jour impossible'), r.error);
  // retrait : l'entrée et la copie ; plus rien de lancé
  resetLog();
  assert.deepEqual(await W.libs.remove('agents'), { ok: true, message: 'Bibliothèque retirée.' });
  assert.equal(fs.existsSync(copy), false);
  assert.deepEqual(W.libs.entries().map((e) => e.id), ['modeles']);
  assert.deepEqual(await W.libs.remove('agents'), { ok: false, status: 404, error: MSG.notFound });
  for (const id of ['../agents', '', null, '.', '..']) assert.deepEqual(await W.libs.remove(id), { ok: false, status: 404, error: MSG.notFound }, String(id));
  assert.deepEqual(W.agents.list().map((a) => a.id), ['outil']);
  assert.deepEqual(await W.libs.remove('modeles'), { ok: true, message: 'Bibliothèque retirée.' });
  assert.deepEqual([W.libs.view(), fs.readdirSync(path.join(W.data, 'agent-libraries'))], [[], []]);
  assert.deepEqual(calls(), [], 'le retrait ne lance pas git');
  assert.deepEqual(await W.libs.update(), { ok: true, libraries: [], message: 'Aucune bibliothèque à mettre à jour.' });
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
  assert.equal(calls().filter((c) => c.sub === 'fetch').length, 3, 'deux en fond, une demandée');
  // en fond : priorité basse pour chaque git lancé (8 : fetch, reset, ls-files, rev-parse par bibliothèque)
  assert.equal(W.lowered.length, 8);
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
    { id: 'doublon', url: 'https://github.com/studio/a' }, { id: 'doublon', url: 'https://github.com/studio/b' },
    'n\'importe quoi', null,
  ]));
  assert.deepEqual(W.libs.view().map((l) => [l.id, l.status, l.error]), [['locale', 'error', MSG.badUrl], ['doublon', 'error', MSG.missing]]);
  const r = await W.libs.update('locale');
  assert.deepEqual([r.ok, r.error], [false, MSG.badUrl]);
  clock += 2 * 3600_000;
  assert.deepEqual(await W.libs.tick(), ['doublon'], 'l\'adresse refusée n\'est jamais mise à jour');
  assert.ok(calls().every((c) => !c.args.includes('file:///Users/alex/agents')));
  assert.deepEqual(await W.libs.remove('locale'), { ok: true, message: 'Bibliothèque retirée.' }, 'mais elle se retire');
});
