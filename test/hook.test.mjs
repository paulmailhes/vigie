// Tests du hook, des réglages et de l'installation : node --test test/
// Tout se passe dans un dossier temporaire (VIGIE_DATA, HOME) : les vrais réglages, que lisent les
// conversations ouvertes, ~/.claude et les LaunchAgents ne sont jamais touchés.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-test-'));
process.env.VIGIE_DATA = path.join(TMP, 'data');
const { ROOT, STATE_FILE, HISTORY_FILE, QUESTIONS_FILE, DEFAULT_STATE, writeState, readState, effective, questionsAuto, questionsMode, matchGuard, executedText } = await import('../lib/state.mjs');
const { decide } = await import('../lib/decisions.mjs');
assert.ok(STATE_FILE.startsWith(TMP), 'les tests doivent écrire dans le dossier temporaire');

const HOOK = path.join(ROOT, 'hook.mjs');
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, '.claude', 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });
// Registre factice : « vscode-session » est une conversation VS Code (le hook peut attendre). Un fichier
// abîmé d'une autre session ne doit rien empêcher.
fs.writeFileSync(path.join(SESSIONS, '0.json'), '{abîmé');
fs.writeFileSync(path.join(SESSIONS, '1.json'), JSON.stringify({ pid: 1, sessionId: 'vscode-session', entrypoint: 'claude-vscode' }));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ENV = { ...process.env, HOME, CLAUDE_PID: String(process.pid), VIGIE_POLL_MS: '40' };
delete ENV.CLAUDE_CONFIG_DIR;
const Q = { questions: [{ question: 'Couleur ?', header: 'C', multiSelect: false, options: [{ label: 'Rouge', description: 'chaud' }, { label: 'Bleu (Recommandé)', description: 'calme' }] }] };

function setState(patch) {
  writeState({ ...structuredClone(DEFAULT_STATE), ...patch });
}
function run(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'test-session', cwd: '/tmp', transcript_path: '/nonexistent', ...input }), encoding: 'utf8', timeout: 10000, env: { ...ENV, ...env } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const perm = (tool_name, tool_input, extra = {}) => run({ hook_event_name: 'PermissionRequest', tool_name, tool_input, ...extra });
const behavior = (out) => out?.hookSpecificOutput?.decision?.behavior ?? 'prompt';
const bash = (command) => behavior(perm('Bash', { command }));
const jsonl = (file) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// Bac à sable par test d'attente : chacun son VIGIE_DATA, les tests peuvent donc tourner en parallèle.
function sandbox(patch = {}) {
  const data = fs.mkdtempSync(path.join(TMP, 'sb-'));
  const set = (p) => fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ ...structuredClone(DEFAULT_STATE), ...p }));
  set(patch);
  const history = () => jsonl(path.join(data, 'history.jsonl'));
  const events = () => history().map((h) => h.event);
  const questions = () => jsonl(path.join(data, 'questions.jsonl'));
  function start(input, env = {}) {
    const child = spawn(process.execPath, [HOOK], { env: { ...ENV, VIGIE_DATA: data, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const t0 = Date.now();
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ out: out ? JSON.parse(out) : null, code, ms: Date.now() - t0 })));
    child.stdin.end(JSON.stringify({ session_id: 'vscode-session', cwd: '/tmp/projet', transcript_path: '/nonexistent', ...input }));
    return { child, done };
  }
  async function until(event) {
    for (let i = 0; i < 250; i++) { if (events().includes(event)) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`événement ${event} jamais vu : ${events()}`);
  }
  return { data, set, history, events, questions, start, until };
}

// ---------- décisions immédiates (v1) ----------

test('auto-accept coupé : la fenêtre normale s\'affiche', () => {
  setState({ autoAccept: false });
  assert.equal(bash('ls'), 'prompt');
});

test('auto-accept global : on valide', () => {
  setState({ autoAccept: true });
  assert.equal(bash('cd /x && git add . && git commit -m ok && git push origin main'), 'allow');
  assert.equal(behavior(perm('Write', { file_path: '/tmp/a.ts', content: 'x' })), 'allow');
  assert.equal(behavior(perm('mcp__webflow-perso__data_pages_tool', { action: 'publish' })), 'allow');
});

test('réglage par conversation prioritaire sur le global', () => {
  setState({ autoAccept: true, sessions: { 'test-session': { autoAccept: false } } });
  assert.equal(bash('ls'), 'prompt');
  setState({ autoAccept: false, sessions: { 'test-session': { autoAccept: true } } });
  assert.equal(bash('ls'), 'allow');
});

test('garde-fous bloquent immédiatement quand l\'attente vaut 0', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  const blocked = [
    'sudo rm /etc/hosts', 'git push --force origin main', 'git push -f', 'git push origin +main',
    'git push --force-with-lease', 'rm -rf ~', 'rm -rf ~/', 'rm -rf /', 'rm -rf $HOME', `rm -fr ${os.homedir()}/Code`,
    'diskutil eraseDisk APFS X disk4', 'dd if=/dev/zero of=/dev/disk2',
    // contournements trouvés à la relecture v1
    'rm -fr ~/Code', 'rm -fr "$HOME/Code"', 'rm -fr -- ~', 'rm -fr ./dist /', 'find ~ -mindepth 1 -delete', 'cd ~ && rm -fr *',
    'git push -fu origin main', 'git -C /Users/alex/Code/boutique push --force origin main', 'git push origin --delete main',
    'git push origin :main', 'diskutil apfs deleteVolume disk3s5', 'newfs_apfs /dev/disk4',
  ];
  for (const c of blocked) assert.equal(bash(c), 'deny', c);
  const allowed = [
    'git push origin main', 'git push -u origin feat', 'rm -rf node_modules', 'rm -rf ~/Code/x/dist', 'rm -rf /tmp/x',
    'pseudo-command', 'echo ok', 'git push origin main:main', 'cd ~/Code/p && rm -rf .', 'diskutil list',
  ];
  for (const c of allowed) assert.equal(bash(c), 'allow', c);
  assert.equal(behavior(perm('mcp__claude_ai_Qonto__create_card', {})), 'deny');
  assert.equal(behavior(perm('mcp__claude_ai_Qonto__list_cards', {})), 'allow');
  assert.equal(behavior(perm('mcp__claude_ai_GoCardless__create_payment', {})), 'deny');
  assert.equal(behavior(perm('mcp__claude_ai_GoCardless__list_payments', {})), 'allow');
  assert.equal(behavior(perm('mcp__claude_ai_Gmail__send_message', {})), 'deny');
  assert.equal(behavior(perm('mcp__claude_ai_Gmail__create_draft', {})), 'allow');
  assert.equal(behavior(perm('mcp__claude_ai_Metricool__createScheduledPost', {})), 'deny');
  for (const t of ['mcp__resend__send-email', 'mcp__vercel__buy_domain', 'mcp__stripe__create_refund', 'mcp__gmail__send_email', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__affine__delete_doc']) {
    assert.equal(behavior(perm(t, {})), 'deny', t);
  }
  assert.equal(behavior(perm('mcp__ccd_session_mgmt__send_message', {})), 'allow');
  const msg = perm('Bash', { command: 'sudo ls' }).hookSpecificOutput.decision.message;
  assert.match(msg, /Ne la retente pas/);
});

test('garde-fous : Monitor jugé comme Bash, texte cité non pris pour une commande', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  assert.equal(behavior(perm('Monitor', { command: 'sudo ls' })), 'deny');
  assert.equal(behavior(perm('Monitor', { command: 'tail -f log' })), 'allow');
  assert.equal(bash("git commit -q -F - <<'EOF'\nfix: retire sudo, git push --force\nEOF"), 'allow');
  assert.equal(bash("git commit -m 'ne jamais faire git push -f' && git push origin main"), 'allow');
  assert.equal(bash('gh pr create --title "Retire le sudo de install.sh"'), 'allow');
  assert.equal(bash("git commit -F - <<'EOF'\nmsg\nEOF\nsudo ls"), 'deny');
  assert.equal(bash("ssh nas -t 'sudo reboot'"), 'deny');
  assert.equal(bash('git commit -m "$(sudo cat /x)"'), 'deny');
});

// Relecture v1 « hook-securite-faux-positifs-texte » : un sudo cité (message de commit, PR, fichier écrit)
// ne s'exécute pas ; un vrai sudo reste attrapé, même caché dans un heredoc donné à bash.
const NOT_RUN = [
  `git commit -m "$(cat <<'EOF'\nfix: retire sudo de install.sh\nEOF\n)"`,
  `git add -A && git commit -q -m "$(cat <<'EOF'\nretire sudo, git push --force, rm -rf ~\n\nCo-Authored-By: x\nEOF\n)" && git push origin main`,
  `cat > notes.md <<'EOF'\nlancer sudo make install\nEOF`,
  `cat <<'EOF' > notes.md\nsudo x\nEOF`,
  `cat >> progress.md <<"EOF"\nsudo\nEOF\ngit add progress.md && git commit -m 'notes'`,
  `tee docs/x.md <<'EOF' >/dev/null\nsudo apt\nEOF`,
  `tee -a journal.log <<'EOF'\nsudo\nEOF`,
  `cat <<'EOF'\nsudo ls\nEOF`,
  `cat <<'EOF' >&2\nsudo ls\nEOF`,
  `cat <<'EOF' | git commit -F -\nsudo\nEOF`,
  `git commit -F - <<'EOF'\nsudo\nEOF`,
  `gh pr create --title 'Retire sudo' --body "Plus de sudo dans install.sh pour $USER"`,
  `gh pr create --title "x" --body "$(cat <<'EOF'\n## Résumé\n- plus de sudo\nEOF\n)"`,
  `gh api repos/x/y/issues -X POST --input - <<'EOF'\n{"body":"sudo"}\nEOF`,
  `git commit -m "Retire sudo pour $USER"`,
  `git tag -a v1 -m 'sudo'`,
  `git -C "/tmp/a b" commit --message='sudo rm -rf /'`,
  `git commit -m 'echo x >> ~/.zshrc'`,
];
const STILL_RUN = [
  `bash <<'EOF'\nsudo ls\nEOF`,
  `cat <<'EOF' | bash\nsudo ls\nEOF`,
  `cat <<'EOF' |\nsudo ls\nEOF\nbash`,
  `cat <<'EOF' | sh -s\nsudo ls\nEOF`,
  `cat <<'EOF' | tee x.sh | bash\nsudo ls\nEOF`,
  `python3 - <<'EOF'\nimport os; os.system("sudo ls")\nEOF`,
  `ssh nas <<'EOF'\nsudo reboot\nEOF`,
  `git commit -m "$(sudo cat /x)"`,
  "git commit -m \"`sudo ls`\"",
  `git commit -m 'msg' $(sudo ls)`,
  `git commit -m "x" ; sudo ls`,
  `ls | xargs sudo rm`,
  `find . -exec sudo rm {} \\;`,
  `echo ok && sudo ls`,
  // heredoc sans guillemets : $( ) y est exécuté
  `cat > f <<EOF\n$(sudo ls)\nEOF`,
  // fichier écrit puis lancé dans la même commande
  `cat > /tmp/x.sh <<'EOF'\nsudo ls\nEOF\nbash /tmp/x.sh`,
  `cat > x.sh <<'EOF'\nsudo ls\nEOF\nchmod +x x.sh && ./x.sh`,
  `cat > Makefile <<'EOF'\ni:\n\tsudo cp a /b\nEOF\nmake i`,
  `cat > x.command <<'EOF'\nsudo ls\nEOF\nopen x.command`,
  `cat <<'EOF' > x.sh; bash x.sh\nsudo ls\nEOF`,
  `cat > n.md <<'EOF'\nsudo ls\nEOF\n./n.md`,
  // seuls les documents (.md, .txt…) : un hook git, un script ou un package.json peuvent être lancés plus tard
  `cat > .git/hooks/pre-commit <<'EOF'\nsudo ls\nEOF\ngit commit -m x`,
  `cat > .husky/pre-commit <<'EOF'\nsudo ls\nEOF`,
  `cat > package.json <<'EOF'\n{"scripts":{"x":"sudo ls"}}\nEOF`,
  // la sortie du cat part dans un interpréteur
  `bash -c "$(cat <<'EOF'\nsudo ls\nEOF\n)"`,
  `eval "$(cat <<'EOF'\nsudo ls\nEOF\n)"`,
  `echo "$(cat <<'EOF'\nsudo ls\nEOF\n)" | sh`,
  `source <(cat <<'EOF'\nsudo ls\nEOF\n)`,
  `cat <<'EOF' > >(bash)\nsudo ls\nEOF`,
  `(cat <<'EOF') | bash\nsudo ls\nEOF`,
  `{ cat <<'EOF'; } | bash\nsudo ls\nEOF`,
  `git commit -m "$(cat <<'EOF' | bash\nsudo ls\nEOF\n)"`,
  // faux heredoc dans un message, guillemets trompeurs, case : rien n'est retiré
  `git commit -m "x <<'EOF'"\nsudo ls\nEOF`,
  `git commit --cleanup="x -m 'y" ; sudo ls ; echo "'"`,
  `bash -c $(case 1 in 1) cat <<'EOF'\nsudo ls\nEOF\n;; esac)`,
  `git commit -m 'it'"'"'s' && sudo ls`,
  // alias git inconnu : il pourrait lancer ses arguments
  `git ci -m 'sudo ls'`,
];

test('garde-fou sudo : texte cité non exécuté libre, vrai sudo toujours attrapé', () => {
  const st = { ...structuredClone(DEFAULT_STATE), guard: { enabled: true, waitMin: 0, rules: DEFAULT_STATE.guard.rules } };
  for (const c of NOT_RUN) assert.equal(matchGuard(st, 'Bash', { command: c })?.id ?? null, null, c);
  for (const c of STILL_RUN) assert.ok(matchGuard(st, 'Bash', { command: c }), c);
  for (const c of STILL_RUN) assert.ok(matchGuard(st, 'Monitor', { command: c }), `Monitor : ${c}`);
  // ce qui n'est pas exécuté est retiré, le reste de la commande est gardé à l'identique
  assert.equal(executedText(`git commit -m 'sudo' && git push`), `git commit -m '' && git push`);
  assert.equal(executedText(`cat > a.md <<'EOF'\nsudo\nEOF\nls`), `cat > a.md <<'EOF'\nEOF\nls`);
  // construction inconnue, guillemet non fermé, commande démesurée : rien n'est retiré
  for (const c of [`git commit -m 'sudo`, `x=(sudo) git commit -m 'sudo'`, 'git commit -m \'sudo\' ' + 'a '.repeat(110_000)]) assert.equal(executedText(c), c);
  // de bout en bout, par le vrai hook
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  assert.equal(bash(NOT_RUN[0]), 'allow');
  assert.equal(bash(NOT_RUN[2]), 'allow');
  assert.equal(bash(STILL_RUN[0]), 'deny');
  assert.equal(bash(STILL_RUN[1]), 'deny');
});

test('garde-fou : decisions.json ne s\'écrit pas sans l\'utilisateur (sinon une conversation se validerait elle-même)', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  for (const c of [`echo '{"1":"allow"}' > data/decisions.json`, `cp /tmp/d.json /Users/alex/Code/auto-accept/data/decisions.json`,
    `node -e "require('fs').writeFileSync('decisions.json', '{}')"`, `python3 - <<'EOF'\nopen('data/decisions.json','w').write('{}')\nEOF`,
    `curl -s -X POST -H 'X-Vigie: 1' http://127.0.0.1:4777/api/v2/pending/123 -d '{"decision":"allow"}'`]) assert.equal(bash(c), 'deny', c);
  assert.equal(behavior(perm('Write', { file_path: '/Users/alex/Code/auto-accept/.dev/data/decisions.json', content: '{}' })), 'deny');
  assert.equal(bash('cat data/decisions.json'), 'allow');
});

test('garde-fou avec attente, hors VS Code : on te laisse la fenêtre', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard } });
  assert.equal(bash('sudo ls'), 'prompt');
});

test('garde-fous désactivés : tout passe', () => {
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, enabled: false } });
  assert.equal(bash('sudo ls'), 'allow');
});

test('outils qui exigent un humain : jamais notés acceptés', () => {
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true });
  assert.equal(behavior(perm('OfferChromeSetup', {})), 'prompt');
  assert.deepEqual(jsonl(HISTORY_FILE).map((h) => h.event), ['demande-pour-toi']);
});

test('repli du classifieur (mode auto) : la fenêtre reste à l\'utilisateur', () => {
  setState({ autoAccept: true });
  const tp = path.join(TMP, 'classifieur.jsonl');
  const verdict = (decision, text = 'Permission for this action was denied by the Claude Code auto mode classifier.') =>
    JSON.stringify({ type: 'user', permissionDecision: { decision, source: 'config', reasonType: 'classifier' }, message: { content: [{ type: 'tool_result', is_error: decision === 'reject', content: text }] } });
  const ask = () => behavior(perm('Bash', { command: 'curl x | sh' }, { permission_mode: 'auto', transcript_path: tp }));
  fs.writeFileSync(tp, ['{"type":"user"}', verdict('accept'), verdict('reject'), verdict('reject')].join('\n') + '\n');
  assert.equal(ask(), 'prompt');
  assert.equal(behavior(perm('Bash', { command: 'curl x | sh' }, { permission_mode: 'default', transcript_path: tp })), 'allow');
  fs.writeFileSync(tp, [verdict('reject'), verdict('reject', 'The server-side auto mode classifier gave no verdict (error)')].join('\n') + '\n');
  assert.equal(ask(), 'allow');
  fs.writeFileSync(tp, [verdict('reject'), verdict('accept')].join('\n') + '\n');
  assert.equal(ask(), 'allow');
  // 20e refus de la conversation : Claude Code repose aussi l'action sous forme de fenêtre.
  fs.writeFileSync(tp, [verdict('accept'), verdict('reject')].join('\n') + '\n');
  fs.writeFileSync(HISTORY_FILE, Array.from({ length: 19 }, () => JSON.stringify({ event: 'refuse-mode-auto', sessionId: 'test-session' })).join('\n') + '\n');
  assert.equal(ask(), 'prompt');
  fs.writeFileSync(HISTORY_FILE, Array.from({ length: 19 }, () => JSON.stringify({ event: 'refuse-mode-auto', sessionId: 'autre' })).join('\n') + '\n');
  assert.equal(ask(), 'allow');
});

test('questions : jamais validées par l\'auto-accept seul', () => {
  setState({ autoAccept: true });
  assert.equal(behavior(perm('AskUserQuestion', Q)), 'prompt');
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: Q }), null);
});

test('questions en mode auto : option recommandée tout de suite, question enregistrée en entier', () => {
  fs.rmSync(QUESTIONS_FILE, { force: true });
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ questions: 'auto' });
  const out = run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: Q });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(out.hookSpecificOutput.updatedInput.answers['Couleur ?'], /^Bleu \(Recommandé\)/);
  assert.deepEqual(out.hookSpecificOutput.updatedInput.questions, Q.questions);
  const [rec] = jsonl(QUESTIONS_FILE);
  assert.match(rec.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  assert.equal(rec.sessionId, 'test-session');
  assert.equal(rec.cwd, '/tmp');
  assert.equal(rec.tool, 'AskUserQuestion');
  assert.deepEqual(rec.items, [{ question: 'Couleur ?', header: 'C', multiSelect: false,
    options: [{ label: 'Rouge', description: 'chaud' }, { label: 'Bleu (Recommandé)', description: 'calme' }], chosen: 'Bleu (Recommandé)' }]);
  const h = jsonl(HISTORY_FILE).find((x) => x.event === 'question-auto');
  assert.equal(h.questionId, rec.id);
  const plan = run({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  assert.equal(plan.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(jsonl(QUESTIONS_FILE)[1].items[0].chosen, 'Valider le plan');
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
});

test('plan de plus de 64 Ko : la réponse arrive entière', () => {
  setState({ questions: 'auto' });
  const big = 'étape '.repeat(25_000); // ~175 Ko en UTF-8
  const out = run({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: big } });
  assert.equal(out.hookSpecificOutput.updatedInput.plan, big);
});

test('historique : chaque décision est notée', () => {
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  bash('npm test');
  bash('sudo ls');
  run({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'curl x | sh' }, reason: 'download and execute' });
  const lines = jsonl(HISTORY_FILE);
  assert.deepEqual(lines.map((l) => l.event), ['auto-accepte', 'garde-fou-bloque', 'refuse-mode-auto']);
  assert.equal(lines[0].action, 'npm test');
  assert.equal(lines[1].rule, 'Commande administrateur (sudo)');
  assert.equal(lines[1].ruleId, 'sudo');
  assert.equal(lines[1].raison, 'jamais');
  for (const l of lines) assert.equal(typeof l.pid, 'number');
});

test('historique : action sensible notée en entier (4000 caractères), le reste coupé à 600', () => {
  fs.rmSync(HISTORY_FILE, { force: true });
  setState({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  const long = `sudo bash -c 'echo ${'x'.repeat(5000)}'`;
  bash(long);
  bash(`echo ${'y'.repeat(5000)}`);
  const [g, a] = jsonl(HISTORY_FILE);
  assert.equal(g.event, 'garde-fou-bloque');
  assert.equal(g.action, long.slice(0, 4000));
  assert.equal(a.event, 'auto-accepte');
  assert.equal(a.action.length, 600);
});

test('état illisible : prudence, la fenêtre s\'affiche', () => {
  fs.writeFileSync(STATE_FILE, '{pas du json');
  assert.equal(bash('ls'), 'prompt');
});

test('entrée illisible : aucune sortie, aucun plantage', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'n\'importe quoi', encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ---------- état ----------

test('état : valeurs anormales => valeur prudente', () => {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ autoAccept: 'false', questionWaitMin: 'abc', guard: { rules: null, waitMin: null }, connectorsDefault: 'peut-être' }));
  const s = readState();
  assert.equal(s.autoAccept, false);
  assert.equal(s.questionWaitMin, 20);
  assert.equal(s.guard.waitMin, 10);
  assert.equal(s.guard.rules.length, DEFAULT_STATE.guard.rules.length);
  assert.equal(s.connectorsDefault, 'off');
  fs.writeFileSync(STATE_FILE, JSON.stringify({ autoAccept: true, guard: { rules: 'n\'importe quoi', waitMin: 0 } }));
  assert.equal(bash('sudo ls'), 'deny');
});

test('état : règles d\'origine toujours à jour, seuls les interrupteurs et règles ajoutées sont gardés', () => {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ autoAccept: true, guard: { enabled: true, waitMin: 0, rules: [
    { id: 'sudo', label: 'vieux', tool: '^Bash$', match: 'jamais-ça' },
    { id: 'email', label: 'E-mail', tool: '^x$', disabled: true },
    { id: 'npm-publish', label: 'Publication npm', tool: '^Bash$', match: '\\bnpm\\s+publish\\b' },
  ] } }));
  const rules = readState().guard.rules;
  assert.equal(rules.find((r) => r.id === 'sudo').match, DEFAULT_STATE.guard.rules.find((r) => r.id === 'sudo').match);
  assert.equal(rules.find((r) => r.id === 'email').disabled, true);
  assert.equal(bash('sudo ls'), 'deny');
  assert.equal(bash('npm publish'), 'deny');
  assert.equal(behavior(perm('mcp__resend__send-email', {})), 'allow'); // règle e-mail coupée par l'utilisateur
});

test('état : connecteurs et interrupteur des questions', () => {
  const s = { ...structuredClone(DEFAULT_STATE), sessions: { a: { connectors: 'on' }, b: { connectors: 'n\'importe' } } };
  assert.equal(effective(s, 'a').connectors, 'on');
  assert.equal(effective(s, 'b').connectors, 'off');
  assert.equal(effective(s, 'z').connectors, 'off');
  assert.equal(effective({ ...s, connectorsDefault: 'on' }, 'z').connectors, 'on');
  assert.equal(effective(s, '__proto__').autoAccept, false);
  assert.equal(questionsAuto({ questions: 'ask' }), false);
  assert.equal(questionsAuto({ questions: 'wait' }), true);
  assert.equal(questionsMode(true), 'wait');
  assert.equal(questionsMode(false), 'ask');
});

// ---------- attentes dans VS Code ----------

test('attentes (conversation VS Code)', { concurrency: true }, async (t) => {
  await t.test('garde-fou : refus à l\'échéance', async () => {
    const sb = sandbox({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0.01 } });
    const { out } = await sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } }).done;
    assert.equal(behavior(out), 'deny');
    assert.deepEqual(sb.events(), ['garde-fou-attente', 'garde-fou-bloque']);
    assert.equal(typeof sb.history()[0].pid, 'number');
  });

  await t.test('question en attente : option recommandée à l\'échéance, enregistrée', async () => {
    const sb = sandbox({ questions: 'wait', questionWaitMin: 0.01 });
    const { out } = await sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q }).done;
    assert.equal(behavior(out), 'allow');
    assert.match(out.hookSpecificOutput.decision.updatedInput.answers['Couleur ?'], /^Bleu/);
    assert.deepEqual(sb.events(), ['question-attente', 'question-auto']);
    const [rec] = sb.questions();
    assert.equal(rec.sessionId, 'vscode-session');
    assert.equal(rec.cwd, '/tmp/projet');
    assert.equal(rec.items[0].chosen, 'Bleu (Recommandé)');
    assert.equal(sb.history()[1].questionId, rec.id);
  });

  await t.test('question : le résultat d\'un autre outil n\'est pas pris pour une réponse de l\'utilisateur', async () => {
    const sb = sandbox({ questions: 'wait', questionWaitMin: 0.02 });
    const tp = path.join(sb.data, 'transcript.jsonl');
    fs.writeFileSync(tp, '{"type":"assistant"}\n');
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp });
    await sb.until('question-attente');
    fs.appendFileSync(tp, JSON.stringify({ type: 'user', permissionDecision: { decision: 'accept', reasonType: 'classifier' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_AUTRE' }] } }) + '\n');
    const { out } = await h.done;
    assert.equal(behavior(out), 'allow');
  });

  await t.test('question « me demander » puis interrupteur activé en « tout de suite » : réponse immédiate', async () => {
    const sb = sandbox({ questions: 'ask' });
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q });
    await sb.until('question-pour-toi');
    sb.set({ questions: 'auto' });
    const { out } = await h.done;
    assert.equal(behavior(out), 'allow');
    assert.equal(sb.history().at(-1).now, true);
  });

  await t.test('question : wait → ask (rendue, le hook reste éveillé) → wait (nouvelle attente)', async () => {
    const sb = sandbox({ questions: 'wait', questionWaitMin: 5 });
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q });
    await sb.until('question-attente');
    sb.set({ questions: 'ask', questionWaitMin: 5 });
    await sb.until('question-rendue');
    sb.set({ questions: 'wait', questionWaitMin: 0.005 });
    const { out } = await h.done;
    assert.equal(behavior(out), 'allow');
    assert.deepEqual(sb.events(), ['question-attente', 'question-rendue', 'question-attente', 'question-auto']);
  });

  await t.test('auto-accept activé pendant que la fenêtre est affichée : on valide quand même', async () => {
    const sb = sandbox({ autoAccept: false });
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run deploy' } });
    await sb.until('demande-pour-toi');
    sb.set({ autoAccept: true });
    const { out } = await h.done;
    assert.equal(behavior(out), 'allow');
    assert.deepEqual(sb.events(), ['demande-pour-toi', 'auto-accepte']);
    assert.equal(sb.history()[1].tardif, true);
  });

  await t.test('garde-fou coupé pendant l\'attente : validé tout de suite', async () => {
    const sb = sandbox({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 5 } });
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
    await sb.until('garde-fou-attente');
    sb.set({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, enabled: false } });
    const { out, ms } = await h.done;
    assert.equal(behavior(out), 'allow');
    assert.ok(ms < 10_000);
  });

  await t.test('délai du garde-fou mis à 0 pendant l\'attente : refus tout de suite', async () => {
    const sb = sandbox({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 5 } });
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
    await sb.until('garde-fou-attente');
    sb.set({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
    const { out } = await h.done;
    assert.equal(behavior(out), 'deny');
  });

  await t.test('L\'utilisateur répond dans VS Code (SIGTERM) : interruption notée, aucune réponse', async () => {
    const sb = sandbox({ autoAccept: true, questions: 'wait', questionWaitMin: 5, guard: { ...DEFAULT_STATE.guard, waitMin: 5 } });
    const g = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
    const q = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q });
    await sb.until('garde-fou-attente');
    await sb.until('question-attente');
    g.child.kill('SIGTERM');
    q.child.kill('SIGTERM');
    const [rg, rq] = await Promise.all([g.done, q.done]);
    assert.equal(rg.out, null);
    assert.equal(rq.out, null);
    assert.equal(rg.code, 0);
    assert.deepEqual(sb.events().sort(), ['garde-fou-attente', 'garde-fou-tu-as-repondu', 'question-attente', 'question-tu-as-repondu']);
  });

  await t.test('Claude Code mort pendant l\'attente : rien n\'est répondu ni noté comme choisi', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    const sb = sandbox({ questions: 'wait', questionWaitMin: 5 });
    const { out } = await sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q }, { CLAUDE_PID: dead }).done;
    assert.equal(out, null);
    assert.deepEqual(sb.events(), ['question-attente', 'question-rendue']);
    assert.equal(sb.history()[1].raison, 'orphelin');
    assert.deepEqual(sb.questions(), []);
  });

  await t.test('plafond de vie : le hook s\'arrête seul avant son délai, sans répondre', async () => {
    const sb = sandbox({ autoAccept: false });
    const { out, ms } = await sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, { VIGIE_HOOK_LIFETIME_MS: '300' }).done;
    assert.equal(out, null);
    assert.ok(ms < 5000);
  });

  // Décider depuis l'app : decide() écrit data/decisions.json, le hook le relit à chaque tour.
  const guardState = { autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 5 } };
  const appOpts = (sb) => ({ file: path.join(sb.data, 'decisions.json'), historyFile: path.join(sb.data, 'history.jsonl'), state: { ...structuredClone(DEFAULT_STATE), ...guardState } });
  const decisions = (sb) => { try { return JSON.parse(fs.readFileSync(path.join(sb.data, 'decisions.json'), 'utf8')); } catch { return {}; } };

  await t.test('garde-fou : L\'utilisateur autorise depuis l\'app', async () => {
    const sb = sandbox(guardState);
    const cmd = `sudo launchctl kickstart -k gui/501/x && echo ${'z'.repeat(1000)}`;
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: cmd } });
    await sb.until('garde-fou-attente');
    const a = sb.history()[0];
    assert.equal(a.pid, h.child.pid);
    assert.equal(a.action, cmd, 'commande complète dans l\'historique');
    const r = decide(String(h.child.pid), 'allow', appOpts(sb));
    assert.equal(r.ok, true, r.error);
    const { out, ms } = await h.done;
    assert.equal(behavior(out), 'allow');
    assert.ok(ms < 10_000);
    assert.deepEqual(sb.events(), ['garde-fou-attente', 'garde-fou-autorise-app']);
    assert.equal(sb.history()[1].ruleId, 'sudo');
    assert.deepEqual(decisions(sb), {}, 'entrée effacée une fois lue');
    // l'attente est finie : une nouvelle décision est refusée (404)
    assert.equal(decide(String(h.child.pid), 'deny', appOpts(sb)).status, 404);
  });

  await t.test('garde-fou : L\'utilisateur refuse depuis l\'app', async () => {
    const sb = sandbox(guardState);
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
    await sb.until('garde-fou-attente');
    assert.equal(decide(String(h.child.pid), 'deny', appOpts(sb)).ok, true);
    const { out } = await h.done;
    assert.equal(behavior(out), 'deny');
    assert.match(out.hookSpecificOutput.decision.message, /refusée depuis Vigie\. Ne la retente pas/);
    assert.deepEqual(sb.events(), ['garde-fou-attente', 'garde-fou-refuse-app']);
  });

  await t.test('garde-fou : forme courte acceptée ; décision d\'avant l\'attente ou d\'une autre conversation ignorée', async () => {
    const sb = sandbox({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0.03 } });
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
    await sb.until('garde-fou-attente');
    const pid = String(h.child.pid);
    const file = path.join(sb.data, 'decisions.json');
    // pid réutilisé : une décision datée d'avant l'attente ne vaut rien ; une autre conversation non plus
    fs.writeFileSync(file, JSON.stringify({ [pid]: { decision: 'allow', ts: new Date(Date.now() - 3_600_000).toISOString() } }));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(file, JSON.stringify({ [pid]: { decision: 'allow', ts: new Date().toISOString(), sessionId: 'autre-conversation' } }));
    const { out } = await h.done;
    assert.equal(behavior(out), 'deny', 'refus à l\'échéance');
    assert.deepEqual(sb.events(), ['garde-fou-attente', 'garde-fou-bloque']);
    assert.equal(sb.history()[1].raison, 'delai');

    const sb2 = sandbox(guardState);
    const h2 = sb2.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
    await sb2.until('garde-fou-attente');
    fs.writeFileSync(path.join(sb2.data, 'decisions.json'), JSON.stringify({ [h2.child.pid]: 'allow', 1: 'deny' }));
    assert.equal(behavior((await h2.done).out), 'allow');
    assert.deepEqual(decisions(sb2), { 1: 'deny' }, 'seule l\'entrée lue est effacée');
  });

  await t.test('garde-fou : une décision laissée pour ce pid avant l\'attente est retirée', async () => {
    const sb = sandbox(guardState);
    const h = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } }, { VIGIE_POLL_MS: '5000' });
    // écrite avant que le hook n'ouvre son attente (il lit d'abord son entrée)
    fs.writeFileSync(path.join(sb.data, 'decisions.json'), JSON.stringify({ [h.child.pid]: 'allow' }));
    await sb.until('garde-fou-attente');
    assert.deepEqual(decisions(sb), {});
    h.child.kill('SIGTERM');
    assert.equal((await h.done).out, null);
  });

  await t.test('sous-agent : jamais d\'attente', async () => {
    const sb = sandbox({ autoAccept: false, questions: 'wait', questionWaitMin: 5 });
    const a = await sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'a1' }).done;
    const b = await sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: Q, agent_id: 'a1' }).done;
    assert.equal(a.out, null);
    assert.equal(b.out, null);
    assert.ok(a.ms < 5000 && b.ms < 5000);
  });
});

// ---------- installation ----------

const SETTINGS_SCRIPT = path.join(ROOT, 'scripts', 'settings.mjs');
function settingsEnv(home, data) {
  const env = { ...ENV, HOME: home, VIGIE_DATA: data };
  delete env.VIGIE_CLAUDE_SETTINGS; delete env.CODEX_HOME; delete env.VIGIE_CODEX_HOOKS;
  return env;
}
const oursCount = (s) => Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks).filter((h) => /--vigie|auto-accept\/hook\.mjs/.test(h.command)).length;

test('settings.mjs : branche, rebranche et débranche sans toucher au reste', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const data = fs.mkdtempSync(path.join(TMP, 'data-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const other = { type: 'command', command: 'echo autre-hook' };
  fs.writeFileSync(file, JSON.stringify({ permissions: { defaultMode: 'auto' }, hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [other] }],
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: '/opt/homebrew/bin/node /Users/alex/Code/auto-accept/hook.mjs', timeout: 7300 }] }],
  } }), { mode: 0o600 });
  const exec = (a) => spawnSync(process.execPath, [SETTINGS_SCRIPT, a], { encoding: 'utf8', env: settingsEnv(home, data) });

  for (let i = 0; i < 2; i++) assert.equal(exec('install').status, 0);
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(oursCount(s), 3, 'trois entrées Vigie, l\'ancienne v1 remplacée');
  assert.equal(s.permissions.defaultMode, 'auto');
  assert.deepEqual(s.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks, [other]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'droits du fichier gardés');
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('settings.json.bak-vigie-')));
  assert.ok(fs.existsSync(path.join(data, 'state.json')), 'réglages créés dans VIGIE_DATA');

  // La commande installée tourne vraiment (chemins entre guillemets, via sh -c comme Claude Code).
  const cmd = s.hooks.PermissionDenied[0].hooks[0].command;
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ hook_event_name: 'PermissionDenied', session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }), encoding: 'utf8', env: { ...ENV, VIGIE_DATA: data } });
  assert.equal(r.status, 0);
  assert.equal(jsonl(path.join(data, 'history.jsonl')).at(-1).event, 'refuse-mode-auto');

  assert.equal(exec('uninstall').status, 0);
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(oursCount(s), 0);
  assert.deepEqual(s.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks, [other]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('settings.mjs : fichier absent ou illisible', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const data = fs.mkdtempSync(path.join(TMP, 'data-'));
  const file = path.join(home, '.claude', 'settings.json');
  const exec = (a) => spawnSync(process.execPath, [SETTINGS_SCRIPT, a], { encoding: 'utf8', env: settingsEnv(home, data) });
  assert.equal(exec('uninstall').status, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(exec('install').status, 0);
  assert.equal(oursCount(JSON.parse(fs.readFileSync(file, 'utf8'))), 3);
  fs.writeFileSync(file, '{abîmé');
  assert.notEqual(exec('install').status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{abîmé', 'un fichier illisible n\'est jamais réécrit');
});

test('install.sh / uninstall.sh en mode essai : fichiers corrects, rien de lancé', async () => {
  // Un hook de ce dossier en attente : uninstall.sh doit le viser (et seulement l'afficher en essai).
  const sb = sandbox({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 5 } });
  const waiting = sb.start({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
  await sb.until('garde-fou-attente');
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const data = fs.mkdtempSync(path.join(TMP, 'data-'));
  const la = path.join(home, 'LaunchAgents');
  const env = { ...settingsEnv(home, data), VIGIE_DRY_RUN: '1', VIGIE_LAUNCH_AGENTS: la, VIGIE_PORT: '1' };
  const ins = spawnSync('/bin/bash', [path.join(ROOT, 'scripts', 'install.sh')], { encoding: 'utf8', env });
  assert.equal(ins.status, 0, ins.stderr);
  assert.match(ins.stdout, /\[essai\] launchctl bootstrap gui\/\d+ .*io\.github\.paulmailhes\.vigie\.engine\.plist/);
  assert.match(ins.stdout, /\[essai\] launchctl bootstrap gui\/\d+ .*io\.github\.paulmailhes\.vigie\.menu\.plist/);
  assert.doesNotMatch(ins.stdout, /^(?!\[essai\]).*launchctl/m);
  const server = fs.readFileSync(path.join(la, 'io.github.paulmailhes.vigie.engine.plist'), 'utf8');
  assert.ok(server.includes(`<string>${ROOT}/server.mjs</string>`));
  assert.ok(server.includes('<key>ProcessType</key><string>Standard</string>'));
  const menu = fs.readFileSync(path.join(la, 'io.github.paulmailhes.vigie.menu.plist'), 'utf8');
  assert.match(menu, new RegExp(`<string>${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/mac/Vigie\\.app/Contents/MacOS/[^<]+</string>`));
  assert.equal(oursCount(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))), 3);

  const un = spawnSync('/bin/bash', [path.join(ROOT, 'scripts', 'uninstall.sh')], { encoding: 'utf8', env });
  assert.equal(un.status, 0, un.stderr);
  assert.match(un.stdout, /\[essai\] launchctl bootout/);
  assert.ok(un.stdout.includes(`[essai] kill ${waiting.child.pid}\n`), un.stdout);
  assert.deepEqual(fs.readdirSync(la), []);
  assert.equal(oursCount(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))), 0);
  waiting.child.kill('SIGTERM');
  assert.equal((await waiting.done).out, null);
});

test('Codex : hook branché dans ~/.codex/hooks.json (hooks des autres gardés), puis débranché', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const data = fs.mkdtempSync(path.join(TMP, 'data-'));
  const hooksFile = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const other = { type: 'command', command: 'echo autre-hook-codex' };
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [other] }] } }));
  const env = settingsEnv(home, data);
  assert.equal(spawnSync(process.execPath, [SETTINGS_SCRIPT, 'install'], { encoding: 'utf8', env }).status, 0);
  let h = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const cmds = Object.values(h.hooks).flat().flatMap((g) => g.hooks).map((x) => x.command);
  assert.ok(cmds.includes('echo autre-hook-codex'), 'le hook des autres reste');
  assert.equal(cmds.filter((c) => / --vigie --codex$/.test(c)).length, 2, 'PermissionRequest et PreToolUse');
  assert.equal(h.hooks.PermissionRequest[0].matcher, '*');
  // réinstaller ne double rien
  spawnSync(process.execPath, [SETTINGS_SCRIPT, 'install'], { encoding: 'utf8', env });
  h = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.equal(Object.values(h.hooks).flat().flatMap((g) => g.hooks).filter((x) => /--codex/.test(x.command)).length, 2);
  spawnSync(process.execPath, [SETTINGS_SCRIPT, 'uninstall'], { encoding: 'utf8', env });
  h = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.deepEqual(Object.values(h.hooks).flat().flatMap((g) => g.hooks).map((x) => x.command), ['echo autre-hook-codex']);
});

test('Codex : demande ordinaire acceptée, action sensible retenue pour Vigie, auto-accept coupé : rien', () => {
  const sb = sandbox({ autoAccept: true, guard: { ...DEFAULT_STATE.guard, waitMin: 0 } });
  const codexRun = (tool_name, tool_input, extra = {}) => {
    const r = spawnSync(process.execPath, [HOOK, '--vigie', '--codex'], { input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: '01a12fe9-e384-7742-8e40-074aa1632763', turn_id: 't1', cwd: '/tmp', tool_name, tool_input, ...extra }), encoding: 'utf8', env: { ...ENV, VIGIE_DATA: sb.data } });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  assert.equal(codexRun('Bash', { command: 'npm test' }).hookSpecificOutput.decision.behavior, 'allow');
  const sudo = codexRun('Bash', { command: 'sudo rm -rf /var/x' });
  assert.equal(sudo.hookSpecificOutput.decision.behavior, 'deny', 'attente à 0 : refus, à autoriser dans Vigie');
  assert.match(sudo.hookSpecificOutput.decision.message, /en attente de l'accord de l'utilisateur dans Vigie/);
  const patch = codexRun('apply_patch', { command: `*** Begin Patch\n*** Update File: ${os.homedir()}/.zshrc\n@@\n-a\n+b\n*** End Patch` });
  assert.equal(patch.hookSpecificOutput.decision.behavior, 'deny', 'réglages du shell modifiés par un patch : garde-fou');
  sb.set({ autoAccept: false });
  assert.equal(codexRun('Bash', { command: 'npm test' }), null, 'auto-accept coupé : la fenêtre de Codex');
});
