// Tests du lanceur bin/claude-account-wrapper : node --test test/
// Un faux binaire « claude » affiche ce qu'il reçoit (arguments, CLAUDE_CONFIG_DIR, connecteurs).
// Tout vit dans un dossier temporaire avec des espaces dans les chemins (HOME, data, comptes, réglages
// VS Code) : rien de réel n'est lu ni écrit, aucun vrai Claude n'est lancé.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(ROOT, 'bin', 'claude-account-wrapper');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie wrapper-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HOME = path.join(TMP, 'maison alex');
const DATA = path.join(TMP, 'data vigie');
const ACC = path.join(TMP, 'comptes alex');
const FAKE_DIR = path.join(TMP, 'faux binaire');
const FAKE = path.join(FAKE_DIR, 'claude');
const VSC = path.join(TMP, 'vscode', 'settings.json');
const VSDB = path.join(TMP, 'vscode', 'state.vscdb');
const LOG = path.join(DATA, 'launches.log');

const S_PERSO = 'b1b9b451-c53c-439e-b804-3689257268e3';   // associée à « perso »
const S_LIBRE = '46536060-8c84-46cc-872f-0a0df63ba2a6';   // sans choix
const S_T2 = '6cc47ef4-1111-4222-8333-944455556666';      // compte pas connecté
const S_CASSE = '7dd58f05-2222-4333-8444-a55566667777';   // dossier sans historique relié
const S_CONN = '8ee69016-3333-4444-8555-b66677778888';    // connecteurs rallumés pour elle

const CONV = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--max-thinking-tokens=31999',
  '--permission-prompt-tool=stdio', '--setting-sources=user,project,local', '--permission-mode=auto',
  '--include-partial-messages', '--enable-auth-status', '--no-chrome', '--replay-user-messages'];

const w = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); };
const wj = (p, o) => w(p, JSON.stringify(o, null, 2));

// --- décor ---
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
wj(path.join(HOME, '.claude', 'settings.json'), { permissions: { defaultMode: 'auto' } });
function account(id, { connected = true, linked = true } = {}) {
  const dir = path.join(ACC, id);
  fs.mkdirSync(dir, { recursive: true });
  if (linked) fs.symlinkSync(path.join(HOME, '.claude', 'projects'), path.join(dir, 'projects'));
  wj(path.join(dir, '.claude.json'), connected ? { oauthAccount: { emailAddress: `${id}@exemple.test` } } : { mcpServers: {} });
  return dir;
}
const PERSO = account('perso');
const T2 = account('travail2', { connected: false });
const CASSE = account('casse', { linked: false });
const MODEL = {
  accounts: [
    { id: 'travail1', label: 'Travail 1', configDir: null },
    { id: 'perso', label: 'Perso', configDir: PERSO },
    { id: 'travail2', label: 'Travail 2', configDir: T2 },
    { id: 'casse', label: 'Cassé', configDir: CASSE },
  ],
  defaultForNew: 'perso',
  sessions: { [S_PERSO]: 'perso', [S_T2]: 'travail2', [S_CASSE]: 'casse' },
  pendingSwitches: {},
};
const setModel = (m = MODEL) => wj(path.join(DATA, 'accounts.json'), m);
const setState = (s = { autoAccept: true, connectorsDefault: 'off', sessions: { [S_CONN]: { connectors: 'on' } } }) => wj(path.join(DATA, 'state.json'), s);
setModel();
setState();
w(VSC, '{\n    "editor.fontSize": 13\n}\n');
function vscodeMode(mode) {
  fs.rmSync(VSDB, { force: true });
  const sql = 'create table ItemTable (key text unique on conflict replace, value blob);'
    + (mode ? `insert into ItemTable values ('Anthropic.claude-code', '${JSON.stringify({ defaultPermissionMode: mode })}');` : '');
  const r = spawnSync('/usr/bin/sqlite3', [VSDB, sql], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
vscodeMode('auto');

// Faux binaire : affiche ce qu'il reçoit, peut lire stdin et sortir avec un code donné.
w(FAKE, `#!/bin/bash
printf 'CFG=%s\\n' "\${CLAUDE_CONFIG_DIR-<absent>}"
printf 'CONN=%s\\n' "\${ENABLE_CLAUDEAI_MCP_SERVERS-<absent>}"
printf 'PID=%s\\n' "$$"
for a in "$@"; do printf 'ARG=%s\\0' "$a"; done
printf '\\n'
if [ -n "$LIRE_STDIN" ]; then IFS= read -r l; printf 'STDIN=%s\\n' "$l"; fi
exit "\${CODE_SORTIE:-0}"
`, 0o755);

function run(args, { env = {}, input, wrapper = WRAPPER, bin = FAKE } = {}) {
  const argv = bin ? [bin, ...args] : args;
  const r = spawnSync(wrapper, argv, {
    encoding: 'utf8', input, timeout: 10000,
    env: { PATH: '/usr/bin:/bin', HOME, VIGIE_DATA: DATA, VIGIE_VSCODE_SETTINGS: VSC, VIGIE_VSCODE_STATE_DB: VSDB, ...env },
  });
  const out = { status: r.status, stderr: r.stderr, cfg: null, conn: null, pid: null, args: [], stdin: null };
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('CFG=')) out.cfg = line.slice(4);
    else if (line.startsWith('CONN=')) out.conn = line.slice(5);
    else if (line.startsWith('PID=')) out.pid = Number(line.slice(4));
    else if (line.startsWith('STDIN=')) out.stdin = line.slice(6);
    else if (line.startsWith('ARG=')) out.args = line.split('\0').filter(Boolean).map((a) => a.replace(/^ARG=/, ''));
  }
  return out;
}
const lastLog = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').pop().split('\t'); } catch { return null; } };
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').length; } catch { return 0; } };

test('appel annexe (auth status) : passe tel quel, sur Travail 1, sans journal', () => {
  const n = logLines();
  const r = run(['auth', 'status', '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.cfg, '<absent>');
  assert.equal(r.conn, '<absent>');
  assert.deepEqual(r.args, ['auth', 'status', '--json']);
  assert.equal(logLines(), n);
  const mcp = run(['mcp', 'add-json', 'x', '{}', '--scope', 'user']);
  assert.equal(mcp.cfg, '<absent>');
});

test('reprise d\'une conversation associée : dossier exact du compte et connecteurs coupés', () => {
  const r = run([...CONV, `--resume=${S_PERSO}`]);
  assert.equal(r.status, 0);
  assert.equal(r.cfg, PERSO);
  assert.equal(r.conn, 'false');
  assert.deepEqual(r.args, [...CONV, `--resume=${S_PERSO}`]);
  const [ts, pid, acc, sid, why] = lastLog();
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 60);
  assert.equal(Number(pid), r.pid, 'le pid journalisé est celui du processus claude (exec)');
  assert.deepEqual([acc, sid, why], ['perso', S_PERSO, 'choisi']);
  // une fiche par processus, lue par le serveur
  assert.equal(fs.readFileSync(path.join(DATA, 'launches', String(r.pid)), 'utf8'), `${ts}\t${pid}\tperso\t${S_PERSO}\tchoisi\n`);
  // forme en deux arguments aussi
  assert.equal(run([...CONV, '--resume', S_PERSO]).cfg, PERSO);
});

test('nouvelle conversation : compte par défaut', () => {
  const r = run(CONV);
  assert.equal(r.cfg, PERSO);
  const [, , acc, sid, why] = lastLog();
  assert.deepEqual([acc, sid, why], ['perso', '-', 'nouvelle']);
  setModel({ ...MODEL, defaultForNew: 'travail1' });
  assert.equal(run(CONV).cfg, '<absent>');
  setModel({ ...MODEL, defaultForNew: 'disparu' });
  assert.equal(run(CONV).cfg, '<absent>');
  setModel();
});

test('reprise sans choix noté : Travail 1, même si le défaut est un autre compte', () => {
  const r = run([...CONV, `--resume=${S_LIBRE}`]);
  assert.equal(r.cfg, '<absent>');
  assert.equal(r.conn, 'false');
  const [, , acc, sid, why] = lastLog();
  assert.deepEqual([acc, sid, why], ['travail1', S_LIBRE, 'sans-choix']);
});

test('connecteurs : réglage par conversation prioritaire, état absent ou abîmé = inchangé', () => {
  assert.equal(run([...CONV, `--resume=${S_CONN}`]).conn, '<absent>');
  setState({ connectorsDefault: 'on', sessions: { [S_PERSO]: { connectors: 'off' } } });
  assert.equal(run([...CONV, `--resume=${S_LIBRE}`]).conn, '<absent>');
  assert.equal(run([...CONV, `--resume=${S_PERSO}`]).conn, 'false');
  setState({ autoAccept: true }); // réglage pas encore posé : coupés par défaut (choix de la conception)
  assert.equal(run(CONV).conn, 'false');
  fs.writeFileSync(path.join(DATA, 'state.json'), '{abîmé');
  const r = run([...CONV, `--resume=${S_PERSO}`]);
  assert.equal(r.cfg, PERSO, 'le compte reste choisi');
  assert.equal(r.conn, '<absent>');
  fs.rmSync(path.join(DATA, 'state.json'));
  assert.equal(run([...CONV, `--resume=${S_PERSO}`]).conn, '<absent>');
  setState();
});

test('compte pas connecté, historique non relié ou dossier absent : rien ne change', () => {
  for (const [sid, why] of [[S_T2, 'non-connecte'], [S_CASSE, 'historique-non-relie']]) {
    const r = run([...CONV, `--resume=${sid}`]);
    assert.equal(r.cfg, '<absent>', why);
    assert.equal(r.conn, '<absent>', why);
    assert.deepEqual(r.args, [...CONV, `--resume=${sid}`]);
    const [, , acc, , got] = lastLog();
    assert.deepEqual([acc, got], ['travail1', why]);
  }
  const gone = structuredClone(MODEL);
  gone.accounts[1].configDir = path.join(ACC, 'nulle part');
  setModel(gone);
  assert.equal(run([...CONV, `--resume=${S_PERSO}`]).cfg, '<absent>');
  gone.accounts[1].configDir = `${PERSO}/`; // barre finale : autre entrée de trousseau, on refuse
  setModel(gone);
  assert.equal(run([...CONV, `--resume=${S_PERSO}`]).cfg, '<absent>');
  setModel();
});

test('accounts.json absent ou abîmé : rien ne change', () => {
  const f = path.join(DATA, 'accounts.json');
  for (const content of [null, '{pas du json', '[]', '"texte"', '{"accounts": 3, "sessions": []}']) {
    if (content === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, content);
    const r = run([...CONV, `--resume=${S_PERSO}`]);
    assert.equal(r.status, 0, String(content));
    assert.equal(r.cfg, '<absent>', String(content));
    assert.equal(r.conn, '<absent>', String(content));
    assert.deepEqual(r.args, [...CONV, `--resume=${S_PERSO}`]);
  }
  setModel();
});

test('sonde de configuration, --continue, reprise par chemin : rien ne change', () => {
  assert.equal(run([...CONV, `--resume=${S_PERSO}`], { env: { CLAUDE_CODE_CONFIG_PROBE: '1' } }).cfg, '<absent>');
  assert.equal(run([...CONV, '--continue']).cfg, '<absent>');
  const r = run([...CONV, '--resume=/tmp/x.jsonl']);
  assert.equal(r.cfg, '<absent>');
  assert.equal(r.conn, '<absent>');
  assert.deepEqual(lastLog().slice(2), ['travail1', '-', 'reprise-illisible']);
});

test('mode de permission : « default » imposé par l\'extension redevient le mode de l\'utilisateur', () => {
  const withMode = (m) => CONV.map((a) => (a === '--permission-mode=auto' ? `--permission-mode=${m}` : a));
  let r = run([...withMode('default'), `--resume=${S_PERSO}`]);
  assert.ok(r.args.includes('--permission-mode=auto'), r.args.join(' '));
  assert.ok(!r.args.includes('--permission-mode=default'));
  assert.equal(r.args.length, CONV.length + 1);
  // forme en deux arguments
  const two = [...CONV.filter((a) => !a.startsWith('--permission-mode')), '--permission-mode', 'default', '--model', 'default'];
  r = run(two);
  assert.deepEqual(r.args.slice(-4), ['--permission-mode', 'auto', '--model', 'default']);
  // un autre mode choisi : intact
  assert.ok(run(withMode('plan')).args.includes('--permission-mode=plan'));
  // L'utilisateur a choisi « default » dans VS Code : intact
  vscodeMode('default');
  assert.ok(run(withMode('default')).args.includes('--permission-mode=default'));
  // jamais choisi : on rend le mode des réglages
  vscodeMode(null);
  assert.ok(run(withMode('default')).args.includes('--permission-mode=auto'));
  // état VS Code illisible : intact
  fs.writeFileSync(VSDB, 'pas une base');
  assert.ok(run(withMode('default')).args.includes('--permission-mode=default'));
  vscodeMode('auto');
  // mode de départ fixé dans les réglages VS Code : intact
  w(VSC, '{\n    // choix de l\'utilisateur\n    "claudeCode.initialPermissionMode": "default",\n}\n');
  assert.ok(run(withMode('default')).args.includes('--permission-mode=default'));
  w(VSC, '{\n    "editor.fontSize": 13\n}\n');
  // réglages Claude sans mode auto : intact
  wj(path.join(HOME, '.claude', 'settings.json'), { permissions: {} });
  assert.ok(run(withMode('default')).args.includes('--permission-mode=default'));
  wj(path.join(HOME, '.claude', 'settings.json'), { permissions: { defaultMode: 'auto' } });
  // appel annexe : jamais touché
  assert.deepEqual(run(['--permission-mode=default', '-p', 'x']).args, ['--permission-mode=default', '-p', 'x']);
});

test('arguments, espaces et caractères spéciaux transmis à l\'identique ; rien de tout ça au journal', () => {
  const secret = 'jeton-de-test-ne-doit-pas-sortir';
  const tricky = [...CONV, `--resume=${S_PERSO}`, '--mcp-config', JSON.stringify({ mcpServers: { ide: { type: 'ws-ide', url: 'ws://127.0.0.1:1', authToken: secret } } }),
    '--append-system-prompt', 'deux  espaces\tet "guillemets" \'simples\' $HOME * ? ~ `cmd` \\ fin', '', 'é à ü 🚀'];
  const r = run(tricky);
  assert.equal(r.cfg, PERSO);
  assert.deepEqual(r.args.filter(Boolean), tricky.filter(Boolean));
  assert.ok(!fs.readFileSync(LOG, 'utf8').includes(secret));
});

test('code de sortie et entrée standard transmis (exec)', () => {
  assert.equal(run([...CONV, `--resume=${S_PERSO}`], { env: { CODE_SORTIE: '3' } }).status, 3);
  const r = run([...CONV, `--resume=${S_PERSO}`], { env: { LIRE_STDIN: '1' }, input: '{"type":"user"}\n' });
  assert.equal(r.stdin, '{"type":"user"}');
});

test('lancé par un lien symbolique, sans VIGIE_DATA : data/ à côté du vrai script', () => {
  const inst = path.join(TMP, 'installation vigie');
  fs.mkdirSync(path.join(inst, 'bin'), { recursive: true });
  fs.copyFileSync(WRAPPER, path.join(inst, 'bin', 'claude-account-wrapper'));
  fs.chmodSync(path.join(inst, 'bin', 'claude-account-wrapper'), 0o755);
  wj(path.join(inst, 'data', 'accounts.json'), MODEL);
  const link = path.join(TMP, 'raccourci', 'lanceur');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join('..', 'installation vigie', 'bin', 'claude-account-wrapper'), link);
  const r = run([...CONV, `--resume=${S_PERSO}`], { wrapper: link, env: { VIGIE_DATA: '' } });
  assert.equal(r.cfg, PERSO);
  assert.ok(fs.existsSync(path.join(inst, 'data', 'launches.log')));
});

test('sans binaire intégré : claude du PATH ; sans rien : erreur 127', () => {
  const r = run(CONV, { bin: null, env: { PATH: `${FAKE_DIR}:/usr/bin:/bin` } });
  assert.equal(r.status, 0);
  assert.deepEqual(r.args, CONV);
  assert.equal(run([], { bin: null }).status, 127);
});

test('rapide : quelques millisecondes par lancement', () => {
  const n = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) run([...CONV, `--resume=${S_PERSO}`]);
  const msWrapped = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) spawnSync(FAKE, CONV, { env: { PATH: '/usr/bin:/bin' } });
  const msBare = Number(process.hrtime.bigint() - t1) / 1e6 / n;
  console.log(`# lanceur : ${msWrapped.toFixed(1)} ms par lancement (faux binaire seul : ${msBare.toFixed(1)} ms)`);
  assert.ok(msWrapped - msBare < 150, `${msWrapped} ms`);
});
