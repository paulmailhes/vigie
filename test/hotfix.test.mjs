// Correctif du 2026-10-20 : garde-fous renforcés, repli du classifieur, attentes.
// Tout se passe dans des dossiers temporaires (VIGIE_DATA, HOME) : rien de réel n'est touché.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-hotfix-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
process.env.VIGIE_DATA = TMP;
const { ROOT, STATE_FILE, HISTORY_FILE, DEFAULT_STATE, writeState } = await import('../lib/state.mjs');
assert.ok(STATE_FILE.startsWith(TMP));
const HOOK = path.join(ROOT, 'hook.mjs');
const REAL_HOME = os.homedir();
const VIGIE_ROOT = path.resolve(import.meta.dirname, '..'); // le dossier où Vigie est installé
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const env = { ...process.env, VIGIE_DATA: TMP, HOME: REAL_HOME };
function setState(patch) { writeState({ ...structuredClone(DEFAULT_STATE), ...patch }); }
function run(input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'test-session', cwd: '/tmp', transcript_path: '/nonexistent', ...input }), encoding: 'utf8', timeout: 20000, env: { ...env, ...extraEnv } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const behavior = (out) => out?.hookSpecificOutput?.decision?.behavior ?? 'prompt';
const perm = (tool_name, tool_input, extra = {}) => behavior(run({ hook_event_name: 'PermissionRequest', tool_name, tool_input, ...extra }));
const bash = (command) => perm('Bash', { command });

test('suppressions massives : toutes les variantes trouvées par la relecture sont bloquées', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  const blocked = [
    'rm -fr ~/Code', 'rm -fr $HOME/Code', 'rm -fr "$HOME/Code"', 'rm -fr ~/Code/', 'rm -fr ~/Code/*', 'rm -fr ${HOME}',
    'rm -fr -- ~', 'rm --recursive --force ~', 'rm -fr --no-preserve-root /', 'rm -fr build ~/', 'rm -fr ./dist /',
    '(cd /tmp && rm -fr ~)', 'echo $(rm -fr ~)', 'cd ~ && rm -fr *', 'find ~ -mindepth 1 -delete',
    `find ${REAL_HOME}/Code -delete`, 'rm -fr "$DIR/"', 'rm -rf ~', 'rm -rf /', `rm -rf ${REAL_HOME}`, 'rm -Rf /Users',
    'diskutil eraseDisk APFS X disk4', 'diskutil apfs deleteContainer disk3', 'dd if=/dev/zero of=/dev/disk2', 'cat x > /dev/rdisk3',
  ];
  for (const c of blocked) assert.equal(bash(c), 'deny', c);
  assert.equal(perm('Monitor', { command: 'rm -fr ~/Code' }), 'deny', 'Monitor');
});

test('commandes de travail normales : jamais bloquées', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  const allowed = [
    'rm -rf node_modules', 'rm -rf ~/Code/x/dist', 'rm -rf /tmp/x', 'cd ~/Code/p && rm -rf .next', 'git rm -r --cached .',
    'rm -f /tmp/a.png; echo ok', 'git push origin main', 'git push -u origin feat', 'git -C ~/Code/boutique push origin v1.4',
    'npm test', 'find . -name "*.log" -delete', 'find ~/Code/atelier/dist -delete', 'echo pseudo-command',
    'cd /Users/alex/Code/atelier/atelier && git add . && git commit -m ok && git push -q origin v1.4',
  ];
  for (const c of allowed) assert.equal(bash(c), 'allow', c);
});

test('git push forcé sous toutes ses formes', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  for (const c of ['git push --force origin main', 'git push -f', 'git push origin +main', 'git push --force-with-lease',
    'git -C "/tmp/a b" push --force', 'git -c core.x=1 push -f', 'git --no-pager push --force', 'git push -uf origin main',
    'git push origin --delete feat', 'git push origin :feat', 'git push --mirror']) assert.equal(bash(c), 'deny', c);
});

test('MCP : paiements et envois attrapés quelle que soit la casse, lectures libres', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  for (const t of ['mcp__claude_ai_Qonto__create_card', 'mcp__claude_ai_GoCardless__create_payment', 'mcp__claude_ai_Gmail__send_message',
    'mcp__claude_ai_gmail__send_message', 'mcp__resend__send-email', 'mcp__claude_ai_Stripe__create_refund', 'mcp__paddle-live__execute',
    'mcp__claude_ai_Metricool__createScheduledPost', 'mcp__x__send_email', 'mcp__claude_ai_Notion__notion-delete-pages']) assert.equal(perm(t, {}), 'deny', t);
  for (const t of ['mcp__claude_ai_Qonto__list_cards', 'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Stripe__list_customers', 'mcp__figma-perso__use_figma', 'mcp__webflow-perso__data_pages_tool', 'mcp__x__send_email_draft']) assert.equal(perm(t, {}), 'allow', t);
});

test('les garde-fous corrigés s\'appliquent même avec un ancien state.json', () => {
  const old = structuredClone(DEFAULT_STATE);
  old.autoAccept = true;
  old.guard = { enabled: true, waitMin: 0, rules: [
    { id: 'rm-racine', label: 'ancienne', tool: '^Bash$', match: 'rien-ne-correspond' },
    { id: 'sudo', label: 'ancienne', tool: '^Bash$', match: '\\bsudo\\b', disabled: true },
    { id: 'perso', label: 'Ma règle', tool: '^Bash$', match: 'interdit-perso' },
  ] };
  writeState(old);
  assert.equal(bash('rm -fr ~/Code'), 'deny', 'la nouvelle règle rm remplace l\'ancienne');
  assert.equal(bash('sudo ls'), 'allow', 'la règle que l\'utilisateur a coupée reste coupée');
  assert.equal(bash('echo interdit-perso'), 'deny', 'les règles de l\'utilisateur sont gardées');
});

test('repli du classifieur : jamais accepté après deux refus du mode auto', () => {
  setState({ autoAccept: true });
  const tp = path.join(TMP, 'transcript.jsonl');
  const line = (decision) => JSON.stringify({ type: 'user', permissionDecision: { decision, source: 'config', reasonType: 'classifier' }, message: { content: [{ type: 'tool_result', content: 'x' }] } });
  fs.writeFileSync(tp, [line('accept'), line('reject'), line('reject')].join('\n') + '\n');
  assert.equal(perm('Bash', { command: 'curl x | sh' }, { permission_mode: 'auto', transcript_path: tp }), 'prompt');
  fs.writeFileSync(tp, [line('reject'), line('accept')].join('\n') + '\n');
  assert.equal(perm('Bash', { command: 'ls' }, { permission_mode: 'auto', transcript_path: tp }), 'allow');
  // hors mode auto, pas de repli possible
  fs.writeFileSync(tp, [line('reject'), line('reject')].join('\n') + '\n');
  assert.equal(perm('Bash', { command: 'ls' }, { permission_mode: 'default', transcript_path: tp }), 'allow');
  // un texte de sortie d'outil qui contient les mots n'est pas une décision
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', message: { content: '"reasonType":"classifier" "decision":"reject" "permissionDecision"' } }) + '\n');
  assert.equal(perm('Bash', { command: 'ls' }, { permission_mode: 'auto', transcript_path: tp }), 'allow');
});

test('outils qui exigent un geste humain : laissés à l\'utilisateur', () => {
  setState({ autoAccept: true });
  assert.equal(perm('OfferChromeSetup', {}), 'prompt');
});

// ---------- attentes (conversation VS Code simulée, ancien mode guard.mode = 'vscode') ----------
function vscodeSession() {
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'test-session', entrypoint: 'claude-vscode' }));
}
const events = () => fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);

test('garde-fou en attente puis refus à l\'échéance', () => {
  vscodeSession();
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vscode', waitMin: 0.05 } });
  const out = run({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } }, { HOME });
  assert.equal(behavior(out), 'deny');
  assert.deepEqual(events(), ['garde-fou-attente', 'garde-fou-bloque']);
});

test('question en attente puis option recommandée à l\'échéance', () => {
  vscodeSession();
  setState({ questions: 'wait', questionWaitMin: 0.05 });
  const q = { questions: [{ question: 'Couleur ?', header: 'C', multiSelect: false, options: [{ label: 'Rouge' }, { label: 'Bleu (Recommandé)' }] }] };
  const out = run({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: q }, { HOME });
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
  assert.match(out.hookSpecificOutput.decision.updatedInput.answers['Couleur ?'], /^Bleu/);
});

test('une ligne de résultat d\'un autre outil ne met pas fin à l\'attente', () => {
  vscodeSession();
  setState({ questions: 'wait', questionWaitMin: 0.08 });
  const tp = path.join(TMP, 'tr2.jsonl');
  fs.writeFileSync(tp, '');
  const q = { questions: [{ question: 'Q ?', header: 'Q', multiSelect: false, options: [{ label: 'A (Recommandé)' }, { label: 'B' }] }] };
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'AskUserQuestion', tool_input: q, transcript_path: tp }));
  setTimeout(() => fs.appendFileSync(tp, JSON.stringify({ permissionDecision: { decision: 'accept', source: 'config' } }) + '\n'), 1000);
  return new Promise((resolve) => p.on('exit', () => { assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow'); resolve(); }));
});

test('L\'utilisateur répond lui-même pendant l\'attente : l\'interruption est notée', () => {
  vscodeSession();
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vscode', waitMin: 5 } });
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME } });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'Bash', tool_input: { command: 'sudo ls' }, transcript_path: '/nonexistent' }));
  setTimeout(() => p.kill('SIGTERM'), 1500);
  return new Promise((resolve) => p.on('exit', () => { assert.deepEqual(events(), ['garde-fou-attente', 'garde-fou-tu-as-repondu']); resolve(); }));
});

test('garde-fou coupé pendant l\'attente : accepté tout de suite', () => {
  vscodeSession();
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vscode', waitMin: 5 } });
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'Bash', tool_input: { command: 'sudo ls' }, transcript_path: '/nonexistent' }));
  setTimeout(() => setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vscode', enabled: false, waitMin: 5 } }), 1000);
  return new Promise((resolve) => p.on('exit', () => { assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow'); resolve(); }));
});

test('une longue réponse (plan complet) sort en entier', () => {
  setState({ questions: 'auto' });
  const plan = 'x'.repeat(200_000);
  const out = run({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan } });
  assert.equal(out.hookSpecificOutput.updatedInput.plan.length, 200_000);
});

test('réglages de Claude Code, de Vigie et du shell : jamais validés à ta place', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  for (const f of [`${REAL_HOME}/.claude/settings.json`, `${REAL_HOME}/.claude/settings.local.json`, `${REAL_HOME}/.claude.json`, `${REAL_HOME}/.zshrc`,
    `${REAL_HOME}/.claude-comptes/travail2/.claude.json`, path.join(VIGIE_ROOT, 'data', 'state.json'), path.join(VIGIE_ROOT, 'hook.mjs'),
    `${REAL_HOME}/Library/Application Support/Code/User/settings.json`]) {
    assert.equal(perm('Edit', { file_path: f, old_string: 'a', new_string: 'b' }), 'deny', f);
  }
  for (const c of ['echo x >> ~/.zshrc', "sed -i '' s/a/b/ ~/.claude/settings.json", 'cp /tmp/x ~/.claude.json',
    'curl -s -X POST -H "X-Vigie: 1" http://127.0.0.1:4777/api/v2/settings -d \'{"autoAccept":true}\'']) assert.equal(bash(c), 'deny', c);
  // le travail normal continue
  assert.equal(perm('Edit', { file_path: '/Users/alex/Code/atelier/src/a.ts', old_string: 'a', new_string: 'b' }), 'allow');
  assert.equal(perm('Write', { file_path: '/Users/alex/Code/portail/.claude/notes.md', content: 'x' }), 'allow');
  assert.equal(bash('cat ~/.zshrc'), 'allow');
  assert.equal(bash('curl -s http://127.0.0.1:4777/api/v2/overview'), 'allow');
});

test('L\'utilisateur valide dans VS Code pendant l\'attente : noté avec le résultat réel, pas de faux refus', () => {
  vscodeSession();
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vscode', waitMin: 5 } });
  const tp = path.join(TMP, 'tr-valide.jsonl');
  const cmd = 'git push -q origin --delete preversion-x';
  fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_X', name: 'Bash', input: { command: cmd } }] } }) + '\n');
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME, VIGIE_POLL_MS: '200' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'Bash', tool_input: { command: cmd }, transcript_path: tp }));
  setTimeout(() => fs.appendFileSync(tp, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_X', content: 'ok' }] } }) + '\n'), 800);
  return new Promise((resolve) => p.on('exit', () => {
    assert.equal(out, '', 'aucune décision envoyée après coup');
    const ev = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(ev.map((e) => e.event), ['garde-fou-attente', 'garde-fou-tu-as-repondu']);
    assert.equal(ev[1].resultat, 'réussie');
    resolve();
  }));
});

test('transcript énorme qui grossit vite : la réponse de l\'utilisateur est vue même après 3 Mo écrits entre-temps', () => {
  vscodeSession();
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vscode', waitMin: 5 } });
  const tp = path.join(TMP, 'tr-gros.jsonl');
  const cmd = 'git push -q origin --delete preversion-y';
  const filler = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'system', i, pad: 'x'.repeat(10_000) })).join('\n') + '\n';
  fs.writeFileSync(tp, filler(300) + JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_Y', name: 'Bash', input: { command: cmd } }] } }) + '\n');
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME, VIGIE_POLL_MS: '200' } });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'Bash', tool_input: { command: cmd }, transcript_path: tp }));
  // la conversation écrit 3 Mo (au-delà des 2 derniers Mo relus avant), puis le résultat de l'action acceptée
  setTimeout(() => fs.appendFileSync(tp, filler(300)), 600);
  setTimeout(() => fs.appendFileSync(tp, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_Y', content: 'ok' }] } }) + '\n'), 1200);
  const guardTimer = setTimeout(() => p.kill('SIGKILL'), 15_000);
  return new Promise((resolve) => p.on('exit', () => {
    clearTimeout(guardTimer);
    const ev = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(ev.map((e) => e.event), ['garde-fou-attente', 'garde-fou-tu-as-repondu']);
    resolve();
  }));
});

// ---------- garde-fous « seulement par Vigie » (guard.mode = 'vigie', par défaut) ----------
const { approve, awaitingApprovals, APPROVALS_FILE } = await import('../lib/approvals.mjs');
assert.ok(APPROVALS_FILE.startsWith(TMP));
const hist = () => fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function vigieRun(command, extra = {}) {
  const t0 = Date.now();
  const out = run({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command }, ...extra }, { HOME });
  return { out, ms: Date.now() - t0, last: hist().at(-1) };
}
function freshVigie() {
  vscodeSession(); // même dans une conversation VS Code : plus de fenêtre pour les actions sensibles
  fs.rmSync(HISTORY_FILE, { force: true });
  fs.rmSync(APPROVALS_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vigie' } }); // seulement par Vigie, délai de 10 min
}

test('mode vigie : action sensible refusée tout de suite, à autoriser dans Vigie (agents compris)', () => {
  assert.equal(DEFAULT_STATE.guard.mode, 'vscode', 'par défaut : dans la conversation et dans Vigie');
  freshVigie();
  const long = `sudo bash -c 'echo ${'x'.repeat(5000)}'`;
  const r = vigieRun(long);
  assert.equal(behavior(r.out), 'deny');
  assert.ok(r.ms < 5000, 'aucune attente');
  assert.equal(r.out.hookSpecificOutput.decision.message,
    'Action sensible en attente de l\'accord de l\'utilisateur dans Vigie (garde-fou : « Commande administrateur (sudo) »). ' +
    'Ne la relance pas tant que l\'utilisateur ne te l\'a pas confirmé ; continue le reste du travail. ' +
    'Quand il l\'aura autorisée, il te le dira : relance-la alors exactement à l\'identique.');
  assert.equal(r.last.event, 'garde-fou-en-attente-vigie');
  assert.match(r.last.approvalId, /^[0-9a-f]{16}$/);
  assert.match(r.last.hash, /^[0-9a-f]{64}$/);
  assert.equal(r.last.action, long.slice(0, 4000), 'commande complète, 4000 caractères au plus');
  assert.equal(r.last.ruleId, 'sudo');
  const a = vigieRun('git push --force origin main', { agent_id: 'agent-fond' });
  assert.equal(behavior(a.out), 'deny');
  assert.equal(a.last.event, 'garde-fou-en-attente-vigie');
  assert.equal(a.last.agentId, 'agent-fond');
  const items = awaitingApprovals({ history: hist() });
  assert.deepEqual(items.map((i) => [i.approvalId, i.state, i.byAgent, i.needsPassword]),
    [[a.last.approvalId, 'awaiting', 'agent-fond', false], [r.last.approvalId, 'awaiting', null, true]]);
  assert.equal(items[1].conversationId, 'test-session');
  assert.equal(items[1].rule, 'Commande administrateur (sudo)');
  // les actions ordinaires passent toujours
  assert.equal(behavior(vigieRun('npm test').out), 'allow');
  // l'auto-accept coupé reste prioritaire : fenêtre normale
  setState({ autoAccept: false });
  assert.equal(behavior(vigieRun('sudo ls').out), 'prompt');
});

test('mode vigie : autorisation à usage unique, consommée une seule fois', () => {
  freshVigie();
  const first = vigieRun('sudo ls /var');
  assert.equal(behavior(first.out), 'deny');
  const ok = approve(first.last.approvalId, undefined, { history: hist() });
  assert.equal(ok.ok, true);
  assert.equal(ok.decision, 'allow');
  assert.ok(Math.abs(Date.parse(ok.expiresAt) - Date.now() - 2 * 3600_000) < 60_000, 'valable 2 h');
  assert.equal(awaitingApprovals({ history: hist() })[0].approved, true, 'autorisée, en attente de la relance');
  const second = vigieRun('sudo ls /var');
  assert.equal(behavior(second.out), 'allow');
  assert.equal(second.last.event, 'garde-fou-autorise-vigie');
  assert.equal(second.last.approvalId, first.last.approvalId);
  assert.deepEqual(awaitingApprovals({ history: hist() }), [], 'retirée une fois consommée');
  assert.equal(approve(first.last.approvalId, 'allow', { history: hist() }).status, 404, 'plus rien à autoriser');
  const third = vigieRun('sudo ls /var');
  assert.equal(behavior(third.out), 'deny', 'une seule fois');
  assert.equal(third.last.event, 'garde-fou-en-attente-vigie');
});

test('mode vigie : commande différente, autre conversation ou autorisation expirée : refusées', () => {
  freshVigie();
  const first = vigieRun('sudo ls /etc');
  assert.equal(approve(first.last.approvalId, 'allow', { history: hist() }).ok, true);
  assert.equal(behavior(vigieRun('sudo ls /etc ').out), 'deny', 'commande différente');
  assert.equal(behavior(vigieRun('sudo ls /etc', { session_id: 'autre-session' }).out), 'deny', 'autre conversation');
  assert.equal(behavior(run({ hook_event_name: 'PermissionRequest', tool_name: 'Monitor', tool_input: { command: 'sudo ls /etc' } }, { HOME })), 'deny', 'autre outil');
  const m = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
  assert.ok(m[first.last.approvalId], 'ces essais n\'ont pas consommé l\'autorisation');
  m[first.last.approvalId].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(m));
  const late = vigieRun('sudo ls /etc');
  assert.equal(behavior(late.out), 'deny', 'expirée');
  assert.equal(late.last.event, 'garde-fou-en-attente-vigie');
});

test('mode vigie : L\'utilisateur refuse, l\'élément sort de la liste et rien ne passe', () => {
  freshVigie();
  const first = vigieRun('git push -f origin main');
  assert.equal(approve(first.last.approvalId, 'peut-être', { history: hist() }).status, 400);
  assert.equal(approve('zzz', 'deny', { history: hist() }).status, 400);
  assert.equal(approve('0123456789abcdef', 'deny', { history: hist() }).status, 404);
  assert.equal(approve(first.last.approvalId, 'deny', { history: hist() }).ok, true);
  assert.deepEqual(awaitingApprovals({ history: hist() }), []);
  assert.equal(behavior(vigieRun('git push -f origin main').out), 'deny');
});

test('mode vigie : approvals.json ne s\'écrit pas sans l\'utilisateur', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, mode: 'vigie' } });
  assert.equal(perm('Write', { file_path: '/Users/alex/Code/auto-accept/data/approvals.json', content: '{}' }), 'deny');
  assert.equal(bash(`node -e "require('fs').writeFileSync('approvals.json', '{}')"`), 'deny');
  assert.equal(bash('curl -s -X POST -H "X-Vigie: 1" http://127.0.0.1:4777/api/v2/approvals -d \'{"approvalId":"0123456789abcdef"}\''), 'deny');
  assert.equal(bash('cat data/approvals.json'), 'allow');
});

// « Seulement par Vigie » avant toute fenêtre : PreToolUse retient l'action le temps que l'utilisateur décide dans l'app.
function preHold(command, act) {
  freshVigie();
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME, VIGIE_POLL_MS: '100' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'test-session', cwd: '/tmp', tool_name: 'Bash', tool_input: { command }, transcript_path: '/nonexistent' }));
  let holding = null;
  const t = setInterval(() => {
    let items = [];
    try { items = awaitingApprovals({ history: hist() }); } catch { return; } // historique pas encore écrit
    if (!items.length) return;
    clearInterval(t);
    holding = items[0].holding;
    act(items[0]);
  }, 100);
  const guardTimer = setTimeout(() => p.kill('SIGKILL'), 15_000); // jamais 10 min de test bloqué
  return new Promise((resolve) => p.on('exit', () => {
    clearInterval(t); clearTimeout(guardTimer);
    assert.equal(holding, true, 'la conversation attendait');
    resolve(out ? JSON.parse(out).hookSpecificOutput : null);
  }));
}

test('seulement par Vigie : l\'action attend, l\'utilisateur l\'autorise dans l\'app, elle part dans sa conversation', async () => {
  const o = await preHold('git push --force origin main', (it) => assert.equal(approve(it.approvalId, 'allow', { history: hist() }).ok, true));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(hist().at(-1).event, 'garde-fou-autorise-vigie');
  assert.deepEqual(awaitingApprovals({ history: hist() }), [], 'plus rien à autoriser');
});

test('seulement par Vigie : L\'utilisateur refuse pendant l\'attente', async () => {
  const o = await preHold('sudo ls /var', (it) => approve(it.approvalId, 'deny', { history: hist() }));
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /^L'utilisateur a refusé cette action dans Vigie/);
  assert.equal(hist().at(-1).event, 'garde-fou-refuse-vigie');
});

test('seulement par Vigie : une lecture qui cite un mot sensible n\'est pas retenue', () => {
  freshVigie();
  for (const c of ['grep -n "sudo" lib/state.mjs', 'git log --oneline | grep force', 'grep -E "sudo|push --force" a b 2>/dev/null']) {
    assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } }, { HOME }), null, c);
  }
  // l'auto-accept coupé : rien n'est retenu, l'utilisateur valide lui-même dans VS Code
  setState({ autoAccept: false });
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo ls' } }, { HOME }), null);
});

test('seulement par Vigie : autorisée en PreToolUse, Claude Code redemande en PermissionRequest : acceptée une fois de plus, pas deux', async () => {
  const o = await preHold('sudo -n true', (it) => approve(it.approvalId, 'allow', { history: hist() }));
  assert.equal(o.permissionDecision, 'allow');
  // le même appel passe ensuite par PermissionRequest (Claude Code demande quand même) : accepté
  const second = vigieRun('sudo -n true');
  assert.equal(behavior(second.out), 'allow', 'même appel, étape suivante');
  assert.equal(second.last.event, 'garde-fou-autorise-vigie');
  // une relance identique ensuite : de nouveau à autoriser
  const third = vigieRun('sudo -n true');
  assert.equal(behavior(third.out), 'deny');
});

test('question en attente, réponse donnée dans VS Code : vue même si l’entrée diffère un peu (champ ajouté, ordre)', () => {
  vscodeSession();
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, questions: 'wait', questionWaitMin: 5 });
  const tp = path.join(TMP, 'tr-question.jsonl');
  const q = { question: 'Quel nom pour la version ?', header: 'Test', multiSelect: false, options: [{ label: 'A (Recommandé)' }, { label: 'B' }] };
  // dans le transcript : champs dans un autre ordre, et un champ en plus
  fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_Q', name: 'AskUserQuestion',
    input: { metadata: { source: 'x' }, questions: [{ options: q.options, multiSelect: false, header: 'Test', question: q.question }] } }] } }) + '\n');
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME, VIGIE_POLL_MS: '200' } });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'AskUserQuestion', tool_input: { questions: [q] }, transcript_path: tp }));
  setTimeout(() => fs.appendFileSync(tp, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_Q', content: 'answered' }] } }) + '\n'), 800);
  const guardTimer = setTimeout(() => p.kill('SIGKILL'), 15_000);
  return new Promise((resolve) => p.on('exit', () => {
    clearTimeout(guardTimer);
    const ev = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
    assert.ok(ev.includes('question-tu-as-repondu') || ev.includes('question-repondue'), ev.join(','));
    assert.ok(!ev.includes('question-auto'), 'aucun choix à la place de l’utilisateur');
    resolve();
  }));
});

test('question : répondue depuis Vigie (mode « toujours me demander »), transmise à Claude telle quelle', async () => {
  vscodeSession();
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, questions: 'ask' });
  const { writeAnswer } = await import('../lib/decisions.mjs');
  const q = { question: 'Quel fond pour la charte ?', header: 'Fond', multiSelect: false, options: [{ label: 'Fond A (Recommandé)' }, { label: 'Fond B' }] };
  const p = spawn(process.execPath, [HOOK], { env: { ...env, HOME, VIGIE_POLL_MS: '100' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'test-session', tool_name: 'AskUserQuestion', tool_input: { questions: [q] }, transcript_path: '/nonexistent' }));
  const t = setInterval(() => {
    let h = [];
    try { h = hist(); } catch { return; }
    const w = h.find((e) => e.event === 'question-pour-toi' && Array.isArray(e.questions));
    if (!w) return;
    clearInterval(t);
    assert.equal(w.questions[0].options[1].label, 'Fond B', 'les choix sont notés pour l’app');
    assert.ok(writeAnswer(String(w.pid), { 'Quel fond pour la charte ?': 'Fond B' }, { sessionId: 'test-session' }));
  }, 100);
  const guardTimer = setTimeout(() => p.kill('SIGKILL'), 15_000);
  await new Promise((resolve) => p.on('exit', resolve));
  clearInterval(t); clearTimeout(guardTimer);
  const o = JSON.parse(out).hookSpecificOutput.decision;
  assert.equal(o.behavior, 'allow');
  assert.deepEqual(o.updatedInput.answers, { 'Quel fond pour la charte ?': 'Fond B' }, 'la réponse de l’utilisateur, sans mention de Vigie');
  assert.equal(hist().at(-1).event, 'question-repondue-app');
});

test('par défaut (dans la conversation et dans Vigie) : la fenêtre de Claude Code s’affiche pour une action sensible, même en mode auto', () => {
  vscodeSession();
  setState({ autoAccept: true });
  const pre = (command) => run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, permission_mode: 'auto' }, { HOME });
  const o = pre('git push --force origin main');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'ask', 'la fenêtre s’affiche');
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /ici ou dans Vigie/);
  assert.equal(pre('npm test'), null, 'le reste passe sans rien demander');
  assert.equal(pre('grep -n "sudo" lib/state.mjs'), null, 'une lecture qui cite un mot sensible non plus');
});
