// Relecture de sécurité des écritures (2026-10-20) : node --test test/
// Tout vit dans un dossier temporaire ; aucun vrai réglage, compte ou processus n'est touché.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie verif-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'maison');
const DATA = path.join(TMP, 'data');
const ACC = path.join(TMP, 'comptes');
const VSC = path.join(TMP, 'vscode', 'settings.json');
Object.assign(process.env, { VIGIE_DATA: DATA, VIGIE_HOME: HOME, VIGIE_ACCOUNTS_ROOT: ACC, VIGIE_VSCODE_SETTINGS: VSC, VIGIE_RUNCAT_STATE: path.join(TMP, 'rc.json'), VIGIE_WRAPPER: path.join(TMP, 'lanceur') });
for (const d of ['projects', 'sessions']) fs.mkdirSync(path.join(HOME, '.claude', d), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), '{}');

const { createAccounts } = await import('../lib/accounts.mjs');
const runner = (cmd) => ({ status: cmd === '/usr/bin/security' ? 0 : 1, stdout: '', stderr: '' });
const A = createAccounts({ dataDir: DATA, home: HOME, accountsRoot: ACC, runner, kill: () => { throw new Error('aucun arrêt attendu'); }, cacheMs: 0 });
const FILE = path.join(DATA, 'accounts.json');

test('accounts.json abîmé ou illisible : jamais remplacé en tâche de fond', () => {
  const c = A.create('Perso', 'perso@exemple.test');
  assert.equal(c.ok, true);
  fs.writeFileSync(path.join(c.account.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'perso@exemple.test' } }));
  A.setDefault(c.account.id);
  const good = fs.readFileSync(FILE, 'utf8');
  // une conversation lancée par le lanceur sur Travail 1, pas encore notée : elle serait épinglée
  const pid = process.pid;
  fs.mkdirSync(path.join(DATA, 'launches'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'launches', String(pid)), `${Math.floor(Date.now() / 1000)}\t${pid}\ttravail1\t-\tnouvelle\n`);
  const live = [{ pid, sessionId: '11111111-2222-4333-8444-555555555555', status: 'busy', entrypoint: 'claude-vscode', startedAt: Date.now() }];

  // retouche à la main ratée : le fichier reste tel quel (L'utilisateur peut le réparer), aucune copie
  const bad = good.replace('"sessions"', '"sessions" ,,');
  fs.writeFileSync(FILE, bad);
  assert.deepEqual(A.processPending(live), { applied: [], pinned: [] });
  assert.equal(fs.readFileSync(FILE, 'utf8'), bad);
  assert.equal(fs.readdirSync(DATA).some((f) => f.startsWith('accounts.json.corrupt-')), false);

  // lecture impossible : ni la tâche de fond ni un geste de l'utilisateur ne l'écrasent
  fs.writeFileSync(FILE, good);
  fs.chmodSync(FILE, 0o000);
  try {
    assert.deepEqual(A.processPending(live), { applied: [], pinned: [] });
    assert.throws(() => A.setDefault('travail1'), /illisible/);
  } finally { fs.chmodSync(FILE, 0o644); }
  assert.equal(fs.readFileSync(FILE, 'utf8'), good);

  // fichier sain : l'épinglage reprend normalement
  assert.deepEqual(A.processPending(live).pinned, [{ sessionId: live[0].sessionId, accountId: 'travail1' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).accounts.map((a) => a.id), ['travail1', c.account.id]);

  // abîmé puis geste explicite de l'utilisateur : remplacé, avec une copie gardée (comportement d'avant)
  fs.writeFileSync(FILE, bad);
  A.setDefault('travail1');
  assert.ok(fs.readdirSync(DATA).some((f) => f.startsWith('accounts.json.corrupt-')));
});

test('uninstall.sh retire aussi le lanceur de VS Code, seulement s\'il désigne ce dossier', () => {
  // Le morceau de uninstall.sh est extrait tel quel et lancé seul (sans launchctl ni kill).
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'uninstall.sh'), 'utf8');
  const js = /--input-type=module -e '([^']*)' "\$ROOT\/lib\/accounts\.mjs"/.exec(sh)?.[1];
  assert.ok(js, 'le retrait du lanceur est bien dans uninstall.sh');
  const wrap = path.join(ROOT, 'bin', 'claude-account-wrapper');
  const env = { PATH: '/usr/bin:/bin', HOME, VIGIE_HOME: HOME, VIGIE_DATA: DATA, VIGIE_VSCODE_SETTINGS: VSC, VIGIE_ACCOUNTS_ROOT: ACC, VIGIE_RUNCAT_STATE: path.join(TMP, 'rc.json') };
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', js, path.join(ROOT, 'lib', 'accounts.mjs')], { env, encoding: 'utf8' });
  fs.mkdirSync(path.dirname(VSC), { recursive: true });

  fs.writeFileSync(VSC, `{\n  // mon réglage\n  "editor.fontSize": 13,\n  "claudeCode.claudeProcessWrapper": ${JSON.stringify(wrap)},\n}\n`);
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(VSC, 'utf8'), '{\n  // mon réglage\n  "editor.fontSize": 13,\n}\n');
  assert.ok(fs.readdirSync(path.dirname(VSC)).some((f) => f.startsWith('settings.json.bak-vigie-')), 'sauvegarde avant écriture');

  const other = '{ "claudeCode.claudeProcessWrapper": "/autre/lanceur" }\n';
  fs.writeFileSync(VSC, other);
  r = run();
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(VSC, 'utf8'), other, 'le lanceur d\'un autre outil n\'est jamais retiré');

  fs.writeFileSync(VSC, '{ abîmé');
  r = run();
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(VSC, 'utf8'), '{ abîmé', 'réglages illisibles : rien d\'écrit');
});
