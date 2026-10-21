// Tests de lib/decisions.mjs (décider d'une action sensible depuis l'app) : node --test test/
// Tout se passe dans un dossier temporaire (VIGIE_DATA, HOME) : ni les vrais réglages ni l'historique de
// L'utilisateur ne sont lus ou touchés.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie décisions-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.VIGIE_DATA = DATA;
const { ROOT, DEFAULT_STATE, STATE_FILE } = await import('../lib/state.mjs');
const D = await import('../lib/decisions.mjs');
assert.ok(D.DECISIONS_FILE.startsWith(TMP) && STATE_FILE.startsWith(TMP), 'les tests restent dans le dossier temporaire');

const FILE = path.join(DATA, 'decisions.json');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const STATE = (waitMin = 10) => ({ ...structuredClone(DEFAULT_STATE), autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin } });
const yes = () => true;

test('lecture d\'une décision par le hook : forme longue ou courte, date, conversation, effacée une fois lue', () => {
  const since = Date.now() - 1000;
  wj(FILE, { 101: { decision: 'allow', ts: iso(), sessionId: 's1' }, 102: 'deny', 103: { decision: 'peut-être', ts: iso() }, 104: { decision: 'allow', ts: iso(3_600_000) }, 105: { decision: 'allow', ts: iso(), sessionId: 's2' } });
  assert.equal(D.takeDecision('101', { since, sessionId: 's1', file: FILE }), 'allow');
  assert.equal(Object.hasOwn(rj(FILE), '101'), false, 'effacée');
  assert.equal(D.takeDecision('102', { since, allowBare: false, file: FILE }), null, 'forme courte refusée si une ancienne entrée est restée');
  assert.equal(D.takeDecision('102', { since, file: FILE }), 'deny');
  assert.equal(D.takeDecision('103', { since, file: FILE }), null, 'valeur inconnue');
  assert.equal(D.takeDecision('104', { since, file: FILE }), null, 'datée d\'avant l\'attente (pid réutilisé)');
  assert.equal(D.takeDecision('105', { since, sessionId: 's1', file: FILE }), null, 'autre conversation');
  assert.equal(D.takeDecision('999', { since, file: FILE }), null);
  assert.deepEqual(Object.keys(rj(FILE)).sort(), ['103', '104', '105'], 'les entrées non lues restent');
  // au début d'une attente : l'entrée du pid est retirée
  assert.equal(D.clearDecision('104', { file: FILE }), true);
  assert.equal(D.clearDecision('777', { file: FILE }), true, 'rien à retirer');
  assert.deepEqual(Object.keys(rj(FILE)).sort(), ['103', '105']);
  // fichier abîmé ou absent : aucune décision, aucune erreur
  fs.writeFileSync(FILE, '{abîmé');
  assert.equal(D.takeDecision('103', { file: FILE }), null);
  fs.rmSync(FILE);
  assert.equal(D.takeDecision('103', { file: FILE }), null);
  assert.equal(D.clearDecision('103', { file: FILE }), true);
  assert.equal(fs.existsSync(FILE), false, 'rien n\'est créé pour rien');
});

test('écritures simultanées (serveur et hooks) : aucune décision perdue, fichier toujours lisible', async () => {
  fs.rmSync(FILE, { force: true });
  const lib = path.join(ROOT, 'lib', 'decisions.mjs');
  const code = `const D = await import(${JSON.stringify(lib)}); const [from] = process.argv.slice(1).map(Number);
    for (let i = 0; i < 25; i++) if (!D.writeDecision(String(from + i), i % 2 ? 'allow' : 'deny', { file: ${JSON.stringify(FILE)} })) process.exit(3);`;
  const runs = Array.from({ length: 6 }, (_, k) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, String(1000 * (k + 1))], { env: { ...process.env, VIGIE_DATA: DATA }, stdio: 'ignore' });
    p.on('exit', resolve);
  }));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0]);
  const m = rj(FILE);
  assert.equal(Object.keys(m).length, 150);
  assert.deepEqual(m['1001'].decision, 'allow');
  assert.ok(!fs.readdirSync(DATA).some((f) => f.endsWith('.tmp') || f.endsWith('.lock')), 'ni fichier temporaire ni verrou oublié');
  assert.equal((fs.statSync(FILE).mode & 0o777), 0o600);
});

test('verrou : abandonné (vieux) repris, tenu par un autre écrivain respecté', () => {
  const lock = `${FILE}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(D.writeDecision('42', 'allow', { file: FILE }), true);
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, '');
  const t0 = Date.now();
  assert.equal(D.writeDecision('43', 'allow', { file: FILE }), false, 'pas d\'écriture sans le verrou');
  assert.ok(Date.now() - t0 >= 1500);
  assert.equal(Object.hasOwn(rj(FILE), '43'), false);
  fs.rmSync(lock);
  assert.equal(D.writeDecision('x', 'allow', { file: FILE }), false, 'identifiant invalide');
  assert.equal(D.writeDecision('44', 'oui', { file: FILE }), false, 'décision invalide');
});

// ---------- attentes ----------
const H = (event, pid, msAgo, extra = {}) => ({ ts: iso(msAgo), event, pid, sessionId: `conv-${pid}`, cwd: `/Users/alex/Code/p${pid}`, tool: 'Bash', action: 'ls', ...extra });

test('attentes en cours : processus vivant, bien un hook, échéance pas passée ; plus récente d\'abord', () => {
  const sudo = `sudo rm -rf /opt/x && ${'a'.repeat(4500)}`;
  const history = [
    { ts: iso(5000), event: 'auto-accepte', sessionId: 'x' },                                      // sans pid : ignorée
    H('garde-fou-attente', 1001, 60_000, { rule: 'Commande administrateur (sudo)', ruleId: 'sudo', minutes: 10, action: sudo.slice(0, 4000), description: 'Nettoie /opt' }),
    H('garde-fou-attente', 1002, 50_000, { rule: 'git push forcé', ruleId: 'force-push', minutes: 10 }),
    H('garde-fou-bloque', 1002, 40_000),                                                             // finie
    H('garde-fou-attente', 1003, 20 * 60_000, { minutes: 10 }),                                      // échéance passée
    H('garde-fou-attente', 1004, 30_000, { minutes: 10 }),                                           // processus mort
    H('garde-fou-attente', 1005, 30_000, { minutes: 10 }),                                           // pid réutilisé par autre chose
    H('garde-fou-attente', 1006, 45_000, { rule: 'git push forcé', ruleId: 'force-push', minutes: 10, action: 'git push -f' }),
    H('garde-fou-rendu', 1006, 44_000),                                                              // auto-accept coupé…
    H('garde-fou-attente', 1006, 10_000, { rule: 'git push forcé', ruleId: 'force-push', minutes: 10, action: 'git push -f', agentId: 'a7f3' }), // …puis rallumé
    H('garde-fou-attente', 1007, 20_000, { minutes: 10 }),
    H('auto-accepte', 1007, 19_000, { tardif: true }),                                               // règle coupée pendant l'attente
  ];
  const opts = { history, state: STATE(10), alive: (pid) => pid !== 1004, isHook: (pid) => pid !== 1005 };
  const list = D.pendingGuards(opts);
  assert.deepEqual(list.map((p) => p.pendingId), ['1006', '1001']);
  const [p6, p1] = list;
  assert.equal(p1.state, 'waiting');
  assert.equal(p1.command, sudo.slice(0, 4000), 'commande complète (4000 caractères au plus)');
  assert.equal(p1.needsPassword, true);
  assert.equal(p1.rule, 'Commande administrateur (sudo)');
  assert.equal(p1.ruleId, 'sudo');
  assert.equal(p1.cwd, '/Users/alex/Code/p1001');
  assert.equal(p1.conversationId, 'conv-1001');
  assert.equal(p1.byAgent, null);
  assert.equal(p1.description, 'Nettoie /opt');
  assert.equal(Date.parse(p1.expiresAt), Date.parse(history[1].ts) + 10 * 60_000);
  assert.equal(p6.needsPassword, false);
  assert.equal(p6.byAgent, 'a7f3');
  // le délai suit le réglage actuel, comme dans le hook
  assert.deepEqual(D.pendingGuards({ ...opts, state: STATE(30) }).map((p) => p.pendingId), ['1006', '1001', '1003']);
  assert.deepEqual(D.pendingGuards({ ...opts, state: STATE(0) }), []);
  assert.deepEqual(D.pendingGuards({ ...opts, now: Date.now() + 11 * 60_000 }), []);
});

test('mot de passe : sudo vraiment exécuté, pas seulement cité', () => {
  assert.equal(D.needsPassword({ ruleId: 'sudo', tool: 'Bash', action: 'sudo ls' }), true);
  assert.equal(D.needsPassword({ rule: 'Commande administrateur (sudo)', tool: 'Bash', action: 'x' }), true, 'ancienne ligne sans ruleId');
  assert.equal(D.needsPassword({ ruleId: 'force-push', tool: 'Bash', action: 'git push -f && sudo ls' }), true);
  assert.equal(D.needsPassword({ ruleId: 'force-push', tool: 'Bash', action: "git commit -m 'sans sudo' && git push -f" }), false);
  assert.equal(D.needsPassword({ ruleId: 'argent', tool: 'mcp__claude_ai_Qonto__create_card', action: '{"sudo":1}' }), false);
});

test('décider : vérifie l\'attente, écrit une entrée datée, fait le ménage', () => {
  fs.rmSync(FILE, { force: true });
  const history = [H('garde-fou-attente', 2001, 30_000, { ruleId: 'sudo', rule: 'Commande administrateur (sudo)', minutes: 10, action: 'sudo ls' }),
    H('garde-fou-attente', 2002, 30_000, { ruleId: 'force-push', rule: 'git push forcé', minutes: 10, action: 'git push -f' })];
  const opts = { history, state: STATE(10), alive: (pid) => pid !== 3001, isHook: yes, file: FILE };
  assert.deepEqual(D.decide('2001', 'oui', opts), { ok: false, status: 400, error: 'Décision inconnue : allow ou deny.' });
  for (const id of ['9999', 'abc', '', null, '../x']) assert.equal(D.decide(id, 'allow', opts).status, 404, String(id));
  wj(FILE, { 3001: 'allow', 2002: { decision: 'deny', ts: iso(4 * 3_600_000) }, x: 'allow' });
  const r = D.decide('2001', 'allow', opts);
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Autorisée.', 'court : seul un échec est signalé ensuite');
  const m = rj(FILE);
  assert.deepEqual(Object.keys(m), ['2001'], 'hooks disparus, vieilles entrées et clés invalides retirés');
  assert.equal(m['2001'].decision, 'allow');
  assert.equal(m['2001'].sessionId, 'conv-2001');
  assert.ok(Date.now() - Date.parse(m['2001'].ts) < 5000);
  const d = D.decide('2002', 'deny', opts);
  assert.deepEqual([d.ok, d.message], [true, 'Refusée : Claude passe à la suite.']);
  assert.equal(D.decide('2002', 'allow', opts).message, 'Autorisée.');
});

test('actions bloquées depuis le dernier passage : commande complète, raison, refus de l\'utilisateur', () => {
  const history = [
    H('garde-fou-bloque', 4001, 3 * 3_600_000, { raison: 'delai' }),
    H('garde-fou-bloque', 4002, 3_600_000, { ruleId: 'sudo', rule: 'Commande administrateur (sudo)', raison: 'sous-agent', agentId: 'b1', action: 'sudo make install' }),
    H('garde-fou-refuse-app', 4003, 60_000, { ruleId: 'force-push', action: 'git push -f' }),
    H('auto-accepte', 4004, 1000),
  ];
  const list = D.recentBlocked({ history, since: iso(2 * 3_600_000) });
  assert.deepEqual(list.map((b) => [b.ts, b.by, b.state]), [[history[2].ts, 'you', 'blocked'], [history[1].ts, 'sous-agent', 'blocked']]);
  assert.equal(list[1].command, 'sudo make install');
  assert.equal(list[1].needsPassword, true);
  assert.equal(list[1].byAgent, 'b1');
  assert.equal(D.recentBlocked({ history, limit: 1 }).length, 1);
  assert.equal(D.recentBlocked({ history }).length, 3);
});

test('historique lu sur disque : lecture incrémentale, fichier recommencé', () => {
  const hf = path.join(TMP, 'history-disque.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(hf, line({ ts: iso(), event: 'auto-accepte', sessionId: 'x' }) + line(H('garde-fou-attente', 5001, 1000, { minutes: 10 })));
  const opts = { historyFile: hf, state: STATE(10), alive: yes, isHook: yes };
  assert.deepEqual(D.pendingGuards(opts).map((p) => p.pendingId), ['5001']);
  fs.appendFileSync(hf, '{"ts":"' + iso() + '","event":"garde-fou-bl'); // ligne en cours d'écriture
  assert.deepEqual(D.pendingGuards(opts).map((p) => p.pendingId), ['5001']);
  fs.appendFileSync(hf, 'oque","pid":5001}\n');
  assert.deepEqual(D.pendingGuards(opts), []);
  fs.writeFileSync(hf, line(H('garde-fou-attente', 5002, 1000, { minutes: 10 }))); // fichier recommencé (plus court)
  assert.deepEqual(D.pendingGuards(opts).map((p) => p.pendingId), ['5002']);
  assert.deepEqual(D.pendingGuards({ ...opts, historyFile: path.join(TMP, 'absent.jsonl') }), []);
});

test('de bout en bout : un vrai hook en attente est reconnu (vrai ps), puis libéré par la décision', async () => {
  const home = path.join(TMP, 'maison');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'conv-vscode', entrypoint: 'claude-vscode' }));
  const data = fs.mkdtempSync(path.join(TMP, 'sb-'));
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(STATE(5)));
  const env = { ...process.env, HOME: home, VIGIE_DATA: data, CLAUDE_PID: String(process.pid), VIGIE_POLL_MS: '40' };
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, [path.join(ROOT, 'hook.mjs')], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', resolve));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'conv-vscode', cwd: '/tmp/projet', transcript_path: '/nonexistent',
    tool_name: 'Bash', tool_input: { command: 'sudo softwareupdate -i -a', description: 'Mises à jour' } }));
  const opts = { historyFile: path.join(data, 'history.jsonl'), state: STATE(5), file: path.join(data, 'decisions.json') };
  let list = [];
  for (let i = 0; i < 200 && !list.length; i++) { await new Promise((r) => setTimeout(r, 25)); list = D.pendingGuards(opts); }
  try {
    assert.equal(list.length, 1);
    assert.equal(list[0].pendingId, String(child.pid));
    assert.deepEqual([list[0].command, list[0].cwd, list[0].needsPassword, list[0].sessionId], ['sudo softwareupdate -i -a', '/tmp/projet', true, 'conv-vscode']);
    // un pid vivant qui n'est pas un hook (ce processus de test) n'est jamais une attente
    assert.deepEqual(D.pendingGuards({ ...opts, history: [{ ...H('garde-fou-attente', process.pid, 1000, { minutes: 10 }) }] }), []);
    assert.equal(D.decide(String(child.pid), 'deny', opts).ok, true);
    await done;
    assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'deny');
    assert.deepEqual(D.pendingGuards(opts), []);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); }
});
