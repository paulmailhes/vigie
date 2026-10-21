// Tests de l'indexeur et des vues « conversations » : node --test test/
// Tout se passe dans un faux ~/.claude (dossier temporaire) avec des transcripts synthétiques qui
// reprennent la forme des vrais (ordre des clés, une ligne par bloc, pièces jointes, journaux de workflow).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-conv-'));
const CLAUDE = path.join(TMP, 'home', '.claude');
process.env.HOME = path.join(TMP, 'home');
process.env.VIGIE_DATA = path.join(TMP, 'data');
process.env.VIGIE_CLAUDE_DIR = CLAUDE;
const { Indexer, testKind, actionKind, segments, fileLocation, weightOf, mcpServer, maskSecrets, CLAUDE_DIR,
  isExpectedFail, isPlanFile, parsePlan, parseLedger } = await import('../lib/indexer.mjs');
const { createConversations, isTempPath } = await import('../lib/conversations.mjs');
assert.equal(CLAUDE_DIR, CLAUDE, 'les tests doivent lire le faux ~/.claude');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PROJECTS = path.join(CLAUDE, 'projects');
const SESSIONS = path.join(CLAUDE, 'sessions');
const CWD = path.join(TMP, 'home', 'Code', 'atelier');
const ORG_A = '11111111-2222-4333-8444-555555555555';
fs.mkdirSync(SESSIONS, { recursive: true });

// ---------- fabrique de lignes (forme réelle) ----------
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const BASE = Date.now() - 3 * 3600_000;
const T = (min) => new Date(BASE + min * 60_000).toISOString();
const U = (i = 10, cw = 100, cr = 1000, o = 20) => ({ input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o,
  server_tool_use: { web_search_requests: 0 }, service_tier: 'standard', cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cw },
  iterations: [{ input_tokens: 999999, output_tokens: 999999, cache_read_input_tokens: 999999 }] });

function mk(sid, extra = {}) {
  const meta = { cwd: CWD, sessionId: sid, version: '2.1.301', gitBranch: 'main', ...extra };
  const user = (content, ts, more = {}) => ({ parentUuid: null, isSidechain: false, promptId: uid(), type: 'user', message: { role: 'user', content }, uuid: uid(), timestamp: ts, ...more, userType: 'external', entrypoint: 'claude-vscode', ...meta });
  let msg = 0;
  const asst = (blocks, ts, { stop = 'tool_use', usage = U(), id = `msg_${sid.slice(0, 4)}_${extra.agentId || 'm'}_${++msg}`, more = {} } = {}) =>
    ({ parentUuid: null, isSidechain: false, message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: blocks, stop_reason: stop, stop_sequence: null, usage },
      requestId: 'req_1', type: 'assistant', uuid: uid(), timestamp: ts, userType: 'external', entrypoint: 'claude-vscode', ...meta, ...more });
  let tool = 0;
  // Un appel d'outil et son résultat : deux lignes.
  const call = (name, input, { ts, tsr, content = 'ok', tur, isError = false, usage, perm } = {}) => {
    const id = `toolu_${sid.slice(0, 4)}${++tool}`;
    return [asst([{ type: 'tool_use', id, name, input }], ts, { usage }),
      user([{ tool_use_id: id, type: 'tool_result', content, is_error: isError }], tsr || ts, { ...(perm ? { permissionDecision: perm } : {}), toolUseResult: tur ?? { stdout: typeof content === 'string' ? content : '', stderr: '' } })];
  };
  const human = (text, ts, more = {}) => user(text, ts, { origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human', ...more });
  const say = (text, ts, usage) => asst([{ type: 'text', text }], ts, { stop: 'end_turn', usage });
  const att = (attachment, ts) => ({ parentUuid: null, isSidechain: false, attachment, type: 'attachment', uuid: uid(), timestamp: ts, ...meta });
  return { user, asst, call, human, say, att, id: () => `toolu_${sid.slice(0, 4)}${tool}` };
}
const notif = (toolUseId, status, summary, taskId = 'x') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/o</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
const write = (p, lines, append = false) => { fs.mkdirSync(path.dirname(p), { recursive: true }); (append ? fs.appendFileSync : fs.writeFileSync)(p, lines.flat().map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); };
const newIndexer = (o = {}) => new Indexer({ projectsDir: PROJECTS, sessionsDir: SESSIONS, ...o });

// ---------- classement ----------

test('tests : seuls les vrais lancements comptent', () => {
  assert.equal(testKind('cd /x && npx vitest run 2>&1 | tail -20'), 'tests');
  assert.equal(testKind('node --test test/'), 'tests');
  assert.equal(testKind('NODE_ENV=test timeout 120 npx --yes jest --ci'), 'tests');
  assert.equal(testKind('./node_modules/.bin/vitest run'), 'tests');
  assert.equal(testKind('npm run test:e2e'), 'e2e');
  assert.equal(testKind('npx playwright test --project=chromium'), 'e2e');
  assert.equal(testKind('npx tsc -b && echo fini'), 'types');
  assert.equal(testKind('xcodebuild -scheme Vigie test'), 'tests');
  assert.equal(testKind('npm run build'), 'build');
  assert.equal(testKind('npx eslint src'), 'lint');
  // faux positifs de la v1
  assert.equal(testKind('cat test/e2e/css-livre.e2e.mjs'), null);
  assert.equal(testKind('git add test/e2e/css-livre.e2e.mjs && git commit -m "fix e2e"'), null);
  assert.equal(testKind("cat >> progress.md <<'EOF'\nlancer npx vitest run puis node --test\nEOF"), null);
  assert.equal(testKind('grep -rn vitest package.json'), null);
  assert.equal(testKind('node scripts/run.mjs --test-name x'), null);
  assert.equal(testKind('echo "npm test" && ls'), null);
});

test('type d\'icône de chaque action', () => {
  assert.equal(actionKind('Bash', { command: 'git add . && git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"' }), 'commit');
  assert.equal(actionKind('Bash', { command: 'git -C /x commit -m a && git push origin main' }), 'push');
  assert.equal(actionKind('Bash', { command: 'echo "git commit" && ls' }), 'command');
  assert.equal(actionKind('Write', { file_path: '/a' }), 'file');
  assert.equal(actionKind('WebFetch', {}), 'web');
  assert.equal(actionKind('mcp__claude_ai_Gmail__search_threads', {}), 'mcp');
  assert.equal(actionKind('Agent', {}), 'agent');
  assert.equal(actionKind('AskUserQuestion', {}), 'question');
  assert.equal(actionKind('Skill', {}), 'other');
  assert.equal(mcpServer('mcp__claude_ai_Google_Drive__search_files'), 'claude_ai_Google_Drive');
  assert.equal(mcpServer('mcp__figma-perso__get_screenshot'), 'figma-perso');
  assert.deepEqual(segments('cd /x && FOO=1 npx vitest run; echo ok'), ['cd /x', 'vitest run', 'echo ok']);
});

test('secrets masqués dans les commandes et les messages', () => {
  const fake = 'abcdef0123456789abcdef0123456789';
  const cases = [
    `SUPABASE_SERVICE_ROLE_KEY=${fake} npx vitest run`,
    `curl -H "Authorization: Bearer ${fake}" https://api.x.dev`,
    `gh auth login --token ${fake}`,
    `voici la clé sk-ant-${fake}`,
    `git clone https://alex:${fake}@github.com/x/y`,
    `curl "https://x.dev/api?token=${fake}&a=1"`,
    `export GITHUB_TOKEN='${fake}'`,
  ];
  for (const c of cases) assert.ok(!maskSecrets(c).includes(fake), c);
  assert.equal(maskSecrets('npx vitest run && git push origin main'), 'npx vitest run && git push origin main');
  assert.equal(testKind(maskSecrets(`API_KEY=${fake} npx vitest run`)), 'tests');
});

test('emplacement des fichiers', () => {
  assert.equal(fileLocation(path.join(CWD, 'src/a.ts'), CWD), 'project');
  assert.equal(fileLocation('/private/tmp/claude-501/x/scratchpad/a.md', CWD), 'scratch');
  assert.equal(fileLocation(path.join(CLAUDE, 'plans', 'p.md'), CWD), 'scratch');
  assert.equal(fileLocation('/Users/quelquun/Code/autre/b.ts', CWD), 'elsewhere');
  assert.equal(fileLocation('/Users/alex/Code/atelier-old/c.ts', '/Users/alex/Code/atelier'), 'elsewhere');
  assert.equal(fileLocation('/Users/alex/Code/atelier/c.ts', '/Users/alex/Code/atelier'), 'project');
  // conversation ouverte dans un sous-dossier d'un dépôt : la racine du dépôt et ses worktrees sont « projet »
  const repo = path.join(TMP, 'home', 'Code', 'portail');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(path.join(repo, 'front'), { recursive: true });
  assert.equal(fileLocation(path.join(repo, '.claude/worktrees/x/src/a.ts'), path.join(repo, 'front')), 'project');
  assert.equal(fileLocation(path.join(repo, 'DECISIONS.md'), path.join(repo, 'front')), 'project');
});

// ---------- une conversation complète ----------

const SID = 'b1b9b451-c53c-439e-b804-3689257268e3';
const PDIR = path.join(PROJECTS, '-Users-alex-Code-atelier');
const TRANSCRIPT = path.join(PDIR, `${SID}.jsonl`);
const SDIR = path.join(PDIR, SID);
const L = mk(SID);
fs.writeFileSync(path.join(SESSIONS, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, startedAt: BASE, name: 'atelier-de', status: 'busy' }));

// Partie 1 : chapitre 1 (tests, commit, fichiers, workflow, agent, artefacts, MCP, gros résultats)
const bgCall = L.call('Bash', { command: 'npx vitest run', run_in_background: true, description: 'Tests en fond' }, { ts: T(9), content: 'Command running in background', tur: { backgroundTaskId: 'b1' } });
const bgId = L.id();
const agentCall = L.call('Agent', { description: 'Vérifier la charte', subagent_type: 'general-purpose', prompt: 'x', run_in_background: true }, { ts: T(11), tur: { isAsync: true, status: 'async_launched', agentId: 'agentsolo1' } });
const agentToolId = L.id();
const part1 = [
  { type: 'ai-title', aiTitle: 'Refaire le site Horizon', sessionId: SID },
  L.att({ type: 'credential_org', organizationUuid: ORG_A }, T(0)),
  L.human('<ide_opened_file>The user opened /x.ts</ide_opened_file>Fais la partie A du plan', T(1)),
  L.call('TodoWrite', { todos: [{ content: 'Étape A1', status: 'completed', activeForm: 'A1' }, { content: 'Étape A2', status: 'in_progress', activeForm: 'A2' }, { content: 'Étape A3', status: 'pending', activeForm: 'A3' }] }, { ts: T(2) }),
  // tests : bilan « passed » mais 2 échecs marqués × (vitest) → échec
  L.call('Bash', { command: 'cd /x && npx vitest run', description: 'Lancer vitest' }, { ts: T(3), content: 'x', tur: { stdout: ' × a > b\n × c > d\n Test Files  1 failed | 3 passed\n Tests  40 passed', stderr: '' } }),
  L.call('Bash', { command: 'STRIPE_SECRET_KEY=sk_live_zzzzzzzzzzzzzzzzzzzz npx tsc -b' }, { ts: T(4), tur: { stdout: '', stderr: '' } }),
  // étape rouge du TDD : échec voulu, montré mais pas compté
  L.call('Bash', { command: 'npx vitest run src/jauge.test.ts', description: 'Write the gauge test and watch it fail' }, { ts: T(4), isError: true, tur: { stdout: ' Test Files  1 failed (1)', stderr: '' } }),
  L.call('Bash', { command: 'cat test/e2e/a.e2e.mjs' }, { ts: T(4) }),
  L.call('Bash', { command: 'git add -A && git commit -m "partie A"', description: 'Commit' }, { ts: T(5) }),
  L.call('Write', { file_path: path.join(CWD, 'src/Pastille.tsx'), content: 'x' }, { ts: T(6), tur: { type: 'create', filePath: path.join(CWD, 'src/Pastille.tsx') } }),
  L.call('Edit', { file_path: '/Users/quelquun/Code/autre/b.ts', old_string: 'a', new_string: 'b' }, { ts: T(6), tur: { filePath: '/Users/quelquun/Code/autre/b.ts' } }),
  L.call('Write', { file_path: '/private/tmp/claude-501/scratchpad/notes.md', content: 'x' }, { ts: T(6), tur: { type: 'create', filePath: '/private/tmp/claude-501/scratchpad/notes.md' } }),
  L.call('mcp__claude_ai_Gmail__search_threads', { q: 'x' }, { ts: T(7), content: [{ type: 'text', text: 'r' }], perm: { decision: 'accept', source: 'config' } }),
  L.call('mcp__figma-perso__get_screenshot', { nodeId: '1' }, { ts: T(7), content: [{ type: 'text', text: 'r' }] }),
  L.call('mcp__figma-perso__get_metadata', { nodeId: '1' }, { ts: T(7), content: 'boom', isError: true }),
  // énorme résultat de Read (plus gros qu'un morceau de lecture) : lu sans être décodé
  L.call('Read', { file_path: path.join(CWD, 'big.txt') }, { ts: T(8), content: 'y'.repeat(5_000_000), tur: { type: 'text', file: { filePath: path.join(CWD, 'big.txt'), content: 'y'.repeat(100) } } }),
  // énorme ligne technique à ignorer
  { type: 'api-request-blob', sessionId: SID, hash: 'h', message: 'z'.repeat(5_000_000) },
  bgCall,
  // workflow : lancé, puis relancé
  L.call('Workflow', { script: 'x' }, { ts: T(10), tur: { status: 'async_launched', taskId: 'task1', taskType: 'local_workflow', workflowName: 'partie-a', runId: 'wf_aaa', summary: 'Partie A en parallèle' } }),
  agentCall,
  // un lien claude.ai lu dans une sortie Bash n'est pas un artefact
  L.call('Bash', { command: 'grep -r artifact notes.md' }, { ts: T(12), content: 'https://claude.ai/artifact/aaaa-bbbb' }),
  L.call('Artifact', { action: 'publish', file_path: '/x/charte.html', description: 'Charte 1.4' }, { ts: T(13), tur: { url: 'https://claude.ai/artifact/charte14', title: 'Charte atelier 1.4', seq: 2 } }),
  L.call('mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project', create: { name: 'Plan atelier' } }, batch: [] }, { ts: T(14), content: 'Créé : https://claude.ai/artifact/plan-doc-1' }),
  L.asst([{ type: 'text', text: 'You\'ve hit your session limit · resets 11:40pm' }], T(15), { stop: 'stop_sequence', usage: U(0, 0, 0, 0), more: { isApiErrorMessage: true, error: 'rate_limit' } }),
  L.say('Partie A faite.\n<b>Tout</b> est **vert** sauf 2 tests.', T(20), U(5, 300, 9000, 50)),
  // messages qui n'ouvrent pas de chapitre
  L.user([{ type: 'text', text: '[Request interrupted by user]' }], T(21)),
  L.user('Caveat: local command', T(21), { isMeta: true }),
  L.user('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', T(21)),
  L.user('Résumé de la conversation…', T(21), { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  L.user('Front : la v2 est prête', T(21), { isMeta: true, origin: { kind: 'peer', name: 'front-4c' } }),
  L.user(notif('toolu_inconnu', 'completed', 'x'), T(21), { origin: { kind: 'task-notification' } }),
];
write(TRANSCRIPT, part1);

// Agent de fond (sous-agent direct), et un ancien agent dont les vieilles limites ne doivent pas évincer les récentes.
const oldLimits = Array.from({ length: 60 }, (_, i) => mk(SID, { agentId: 'agentold' }).asst([{ type: 'text', text: 'limit' }], new Date(BASE - 30 * 86400_000 + i * 60_000).toISOString(), { stop: 'stop_sequence', usage: U(0, 0, 0, 0), more: { isApiErrorMessage: true, error: 'rate_limit', isSidechain: true } }));
const A = mk(SID, { agentId: 'agentsolo1' });
write(path.join(SDIR, 'subagents', 'agent-agentsolo1.jsonl'), [A.call('Read', { file_path: '/x' }, { ts: T(12) })]);
write(path.join(SDIR, 'subagents', 'agent-agentold.jsonl'), oldLimits);
fs.writeFileSync(path.join(SDIR, 'subagents', 'agent-agentold.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Ancien agent', finished: true }));
fs.writeFileSync(path.join(SDIR, 'subagents', 'agent-agentsolo1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Vérifier la charte', requestShape: 'background', toolUseId: agentToolId }));

// Workflow wf_aaa : deux agents, l'un fini (journal), l'autre non.
const WF = path.join(SDIR, 'subagents', 'workflows', 'wf_aaa');
const W1 = mk(SID, { agentId: 'wfagent1' }), W2 = mk(SID, { agentId: 'wfagent2' });
write(path.join(WF, 'agent-wfagent1.jsonl'), [W1.call('Bash', { command: 'npm test' }, { ts: T(11), tur: { stdout: 'ℹ pass 12\nℹ fail 0', stderr: '' } })]);
write(path.join(WF, 'agent-wfagent2.jsonl'), [W2.call('mcp__figma-perso__get_screenshot', {}, { ts: T(12) })]);
fs.writeFileSync(path.join(WF, 'agent-wfagent1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'faire:A1', workflowPhase: 'Faire', requestShape: 'foreground' }));
write(path.join(WF, 'journal.jsonl'), [{ type: 'launched' }, { type: 'started', key: 'v2:1', agentId: 'wfagent1', label: 'faire:A1', phase: 'Faire' },
  { type: 'started', key: 'v2:2', agentId: 'wfagent2', label: 'faire:A2', phase: 'Faire' }, { type: 'result', key: 'v2:1', agentId: 'wfagent1', result: { ok: true } }]);
// Les agents n'ont rien écrit depuis 10 min (sinon « en cours » d'après la date du fichier).
const tenMin = (Date.now() - 10 * 60_000) / 1000;
for (const f of ['subagents/agent-agentsolo1.jsonl', 'subagents/agent-agentold.jsonl', 'subagents/workflows/wf_aaa/agent-wfagent1.jsonl', 'subagents/workflows/wf_aaa/agent-wfagent2.jsonl']) fs.utimesSync(path.join(SDIR, f), tenMin, tenMin);
// Le fichier du workflow dit « completed »… pour le premier lancement.
write(path.join(SDIR, 'workflows', 'wf_aaa.json'), [{ runId: 'wf_aaa', taskId: 'task1', workflowName: 'partie-a', status: 'completed', startTime: Date.parse(T(10)), durationMs: 60_000, agentCount: 2, totalTokens: 5000, phases: [{ title: 'Faire' }], result: { a: 1, b: [1, 2] }, logs: ['l1\nl2'] }]);

test('conversation : résumé, où ça en est, tâches, contexte', async () => {
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const [s] = conv.summaries();
  assert.equal(s.id, SID);
  assert.equal(s.title, 'Refaire le site Horizon');
  assert.equal(s.project, 'atelier');
  assert.equal(s.status, 'working');
  assert.equal(s.running, true);
  assert.equal(s.org, ORG_A);
  assert.equal(s.contextTokens, 5 + 300 + 9000);
  assert.equal(s.headline, 'Étape A2');
  // carte : pas de plan suivi, donc la liste de tâches ; tests ; artefacts
  assert.deepEqual(s.progress, { done: 1, total: 3, label: 'Tâches', current: 'Étape A2' });
  assert.deepEqual(s.tests, { failedRecent: 0, running: 1, lastOk: true, lastTs: T(11), lastTitle: 'npm test' },
    'échecs de plus de 2 h non comptés ; test de fond en cours ; l\'étape rouge n\'est pas le dernier résultat');
  assert.deepEqual(s.artifacts, { count: 2, last: { title: 'Plan atelier', url: 'https://claude.ai/artifact/plan-doc-1', ts: T(14) } });
  const d = conv.detail(SID);
  assert.equal(d.now.text, 'Partie A faite.\nTout est vert sauf 2 tests.');
  assert.deepEqual(d.now.tasks, [{ text: 'Étape A1', status: 'done' }, { text: 'Étape A2', status: 'doing' }, { text: 'Étape A3', status: 'todo' }]);
  assert.equal(d.now.tasksTs, T(2));
  assert.equal(d.now.plan, null);
  assert.equal(d.summary.branch, 'main');
  // l'énorme ligne technique n'a rien cassé, le gros Read est passé (réussi)
  assert.ok(d.activity.find((a) => a.title === 'Lit big.txt' && a.ok === true));
  assert.equal(ix.sessions.get(SID).perms.auto, 1);
});

test('conversation : chapitres, tests, fichiers, agents, workflows, artefacts, MCP', async () => {
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const d = conv.detail(SID);
  assert.equal(d.chapters.length, 1, 'interruptions, commandes, résumés, pairs et notifications n\'ouvrent pas de chapitre');
  const ch = d.chapters[0];
  assert.equal(ch.prompt, 'Fais la partie A du plan');
  assert.equal(ch.outcome, 'Partie A faite.\nTout est vert sauf 2 tests.');
  assert.deepEqual(ch.stats, { workflows: 1, agents: 3, artifacts: 2, files: 3, tests: 5, testsFailed: 1, commits: 1 });
  const red = d.tests.find((t) => t.title === 'Write the gauge test and watch it fail');
  assert.equal(red.ok, false); assert.equal(red.expectedFail, true);

  const vitest = d.tests.find((t) => t.title === 'Lancer vitest');
  assert.equal(vitest.ok, false, 'les × de vitest cachés derrière « 40 passed »');
  assert.ok(!d.tests.find((t) => /cat test/.test(t.command)), 'un cat n\'est pas un test');
  assert.ok(!JSON.stringify(d).includes('sk_live_zzzz') && !JSON.stringify(ix.detail(SID)).includes('sk_live_zzzz'), 'aucun secret dans les vues');
  const bg = d.tests.find((t) => t.title === 'Tests en fond');
  assert.equal(bg.ok, null); assert.equal(bg.pending, true);

  assert.deepEqual(Object.fromEntries(d.files.map((f) => [f.name, f.location])), { 'Pastille.tsx': 'project', 'b.ts': 'elsewhere', 'notes.md': 'scratch' });
  assert.equal(d.files.find((f) => f.name === 'Pastille.tsx').created, true);

  const kinds = new Set(d.activity.map((a) => a.kind));
  for (const k of ['command', 'commit', 'file', 'mcp', 'agent', 'web', 'other']) assert.ok(kinds.has(k), k);

  // workflow relancé : le « completed » du fichier vaut pour l'ancien lancement → toujours en cours (si relancé)
  assert.equal(d.workflows[0].status, 'done', 'avant relance, le fichier fait foi');
  assert.equal(d.workflows[0].agents, 2);
  const titles = (arr) => arr.map((a) => a.title).sort();
  assert.deepEqual(titles(d.agents.done), ['Ancien agent', 'faire:A1', 'faire:A2'], 'workflow fini : ses agents aussi');
  assert.deepEqual(titles(d.agents.running), ['Vérifier la charte'], 'agent de fond sans notification, conversation ouverte');

  assert.deepEqual(d.artifacts.map((a) => a.url).sort(), ['https://claude.ai/artifact/charte14', 'https://claude.ai/artifact/plan-doc-1']);
  assert.equal(d.artifacts.find((a) => a.url.endsWith('charte14')).title, 'Charte atelier 1.4');

  assert.deepEqual(d.mcp.map((m) => [m.name, m.scope, m.uses]), [['figma-perso', 'unknown', 3], ['claude_ai_Gmail', 'connector', 1], ['claude_ai_Claude_Docs', 'connector', 1]]);
  const all = ix.mcpUses;
  assert.equal(all.get('figma-perso').count, 3);
  assert.equal([...all.get('claude_ai_Gmail').byDay.values()].reduce((a, b) => a + b, 0), 1);

  assert.equal(d.limits.length, 50);
  assert.equal(d.limits[0].ts, T(15), 'la limite récente reste en tête malgré 60 vieilles limites lues après');
  assert.equal(ix.sessions.get(SID).limitsTotal, 61);
});

test('poids d\'usage : formule, organisation, dédoublonnage par message', async () => {
  const ix = newIndexer();
  await ix.refresh();
  const s = ix.sessions.get(SID);
  // Somme attendue : chaque message compté une fois (un message par appel d'outil ici).
  let expected = 0;
  const lines = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter((l) => l.includes('"type":"assistant"'));
  const seen = new Map();
  for (const l of lines) { const r = JSON.parse(l); const u = r.message.usage; seen.set(r.message.id, u); }
  for (const u of seen.values()) expected += weightOf({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
  const agentsW = ix.usageWeight(s) - Math.round(expected);
  assert.ok(agentsW > 0, 'les agents comptent aussi');
  const conv = createConversations(ix);
  const sum = conv.summaries(new Date(BASE - 3600_000).toISOString())[0];
  assert.equal(sum.usageWeight, ix.usageWeight(s, new Date(BASE - 3600_000).toISOString()));
  assert.ok(sum.usageByOrg[ORG_A] > 0);
  // une ligne répétée (même message, autre bloc) ne double pas le poids
  const before = ix.usageWeight(s);
  const again = JSON.parse(lines.find((l) => l.includes('"stop_reason":"end_turn"'))); again.uuid = uid();
  write(TRANSCRIPT, [again], true);
  await ix.refresh();
  assert.equal(ix.usageWeight(ix.sessions.get(SID)), before);
});

test('suite de la conversation : relance du workflow, fin des tâches de fond, nouveau chapitre en file', async () => {
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const W = mk(SID);
  write(TRANSCRIPT, [
    W.call('Workflow', { script: 'x' }, { ts: T(30), tur: { status: 'async_launched', taskId: 'task2', workflowName: 'partie-a', runId: 'wf_aaa' } }),
    // fin du test lancé en fond : en échec ; fin de l'agent de fond
    W.att({ type: 'queued_command', prompt: notif(bgId, 'completed', 'Background command "Tests en fond" completed (exit code 1)', 'b1'), commandMode: 'task-notification', origin: { kind: 'task-notification' } }, T(31)),
    W.user(notif(agentToolId, 'completed', 'Agent "Vérifier la charte" completed', 'a1'), T(31), { origin: { kind: 'task-notification' } }),
    // L'utilisateur écrit pendant que Claude travaille : message en file, jamais réécrit en ligne « user »
    W.att({ type: 'queued_command', prompt: [{ type: 'text', text: 'Et maintenant la partie B' }], commandMode: 'prompt', origin: { kind: 'human' } }, T(45)),
    W.call('Bash', { command: 'ls' }, { ts: T(46) }),
  ], true);
  await ix.refresh();
  const d = conv.detail(SID);
  assert.equal(d.workflows[0].status, 'running', 'relancé : l\'ancien « completed » ne vaut plus');
  const bg = d.tests.find((t) => t.title === 'Tests en fond');
  assert.equal(bg.ok, false); assert.equal(bg.pending, false);
  assert.equal(d.chapters.length, 2);
  assert.equal(d.chapters[0].prompt, 'Et maintenant la partie B');
  assert.equal(d.chapters[1].stats.testsFailed, 2, 'l\'échec du test de fond revient à son chapitre');
  assert.equal(d.chapters[0].outcome, null);
  assert.deepEqual(d.now.tasks, [], 'la liste de tâches de la demande précédente ne s\'affiche plus');
  assert.equal(ix.sessions.get(SID).lastUserMessage.text, 'Et maintenant la partie B');
  assert.ok(d.agents.done.find((a) => a.title === 'Vérifier la charte'));
  assert.ok(d.agents.running.find((a) => a.title === 'faire:A2'), 'agent du workflow relancé, sans résultat : en cours');
});

test('rapports et compteurs depuis un instant', async () => {
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const since = new Date(BASE).toISOString();
  const r = conv.reports(since);
  const kinds = r.map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'artifact').length, 2);
  assert.ok(kinds.includes('missionDone'), 'chapitre 1 fini, l\'utilisateur absent 15 min avant la demande suivante');
  const m = r.find((x) => x.kind === 'missionDone');
  assert.equal(m.title, 'Fais la partie A du plan');
  assert.equal(m.conversationTitle, 'Refaire le site Horizon');
  assert.ok(!kinds.includes('workflowDone'), 'workflow relancé, pas terminé');
  assert.deepEqual(conv.sinceCounts(since), { testsFailed: 2, limits: 1, reports: r.length });
  assert.equal(conv.reports(new Date(Date.now() + 60_000).toISOString()).length, 0);
});

test('fin de mission : pas de rapport si l\'utilisateur a répondu tout de suite', async () => {
  const sid = 'f0f0f0f0-0000-4000-8000-000000000004';
  const F = mk(sid);
  const p = path.join(PROJECTS, '-Users-alex-Code-vite', `${sid}.jsonl`);
  const work = (t0) => Array.from({ length: 6 }, (_, i) => F.call('Bash', { command: 'ls' }, { ts: T(t0 + i) }));
  write(p, [F.human('première demande', T(0)), work(1), F.say('Fait.', T(8)), F.human('deuxième', T(10)), work(11), F.say('Fait aussi.', T(18)),
    F.human('troisième', T(40)), F.say('ok', T(41))]);
  const ix = newIndexer();
  await ix.refresh();
  const r = createConversations(ix).reports(new Date(BASE - 60_000).toISOString()).filter((x) => x.conversationId === sid);
  assert.deepEqual(r.map((x) => x.title), ['deuxième'], 'réponse 2 min après la première : déjà vue ; la deuxième est restée 22 min sans réponse');
  fs.rmSync(path.dirname(p), { recursive: true });
});

test('conversation des 7 derniers jours : lue pour l\'usage seulement, mêmes poids qu\'une lecture complète', async () => {
  const OLD = 'c0c0c0c0-0000-4000-8000-000000000001';
  const O = mk(OLD);
  const p = path.join(PROJECTS, '-Users-alex-Code-boutique', `${OLD}.jsonl`);
  const lines = [
    O.att({ type: 'credential_org', organizationUuid: ORG_A }, T(-3000)),
    O.human('vieille demande', T(-3000)),
    O.call('mcp__webflow-perso__data_pages_tool', { a: 1 }, { ts: T(-2999), usage: U(1, 2, 3, 4) }),
    O.call('Read', { file_path: '/x' }, { ts: T(-2998), content: 'q'.repeat(4_500_000), usage: U(7, 8, 9, 10) }),
    O.say('fini', T(-2997), U(11, 12, 13, 14)),
  ];
  write(p, lines);
  const old = (Date.now() - 3 * 86400_000) / 1000;
  fs.utimesSync(p, old, old);
  const ix = newIndexer();
  await ix.refresh();
  assert.ok(!ix.sessions.has(OLD) && ix.light.has(OLD), 'hors fenêtre de 48 h : usage seulement');
  const full = newIndexer({ windowHours: 24 * 30 });
  await full.refresh();
  assert.ok(full.sessions.has(OLD));
  assert.equal(ix.usageWeight(OLD), full.usageWeight(OLD));
  assert.equal(ix.usageWeight(OLD), Math.round(weightOf({ input: 19, output: 28, cacheRead: 25, cacheWrite: 22 })));
  assert.equal(ix.light.get(OLD).mcpUses.get('webflow-perso').count, 1);
  assert.equal(ix.light.get(OLD).cwd, CWD, 'le module MCP range l\'usage par dossier');
  assert.ok(ix.allSessions().some((x) => x.id === OLD));
  const tot = ix.usageTotals(new Date(Date.now() - 7 * 86400_000).toISOString());
  assert.equal(tot.byOrg[ORG_A], tot.total, 'tout est attribué au compte ORG_A');
  assert.ok(ix.mcpUsesSince(new Date(Date.now() - 7 * 86400_000).toISOString()).get('webflow-perso') >= 1);
  assert.equal(createConversations(ix).summaries().find((x) => x.id === OLD), undefined, 'pas dans la liste des conversations');
});

test('tâches TaskCreate / TaskUpdate (forme supposée, absente des vrais transcripts) : prises si plus récentes', async () => {
  const sid = 'a1a1a1a1-0000-4000-8000-000000000005';
  const K = mk(sid);
  const p = path.join(PROJECTS, '-Users-alex-Code-tasks', `${sid}.jsonl`);
  write(p, [K.human('demande', T(0)),
    K.call('TodoWrite', { todos: [{ content: 'vieille liste', status: 'pending' }] }, { ts: T(1) }),
    K.call('TaskCreate', { subject: 'Écrire la jauge', description: 'x' }, { ts: T(2), content: 'Task #1 created successfully', tur: { task: { id: '1', subject: 'Écrire la jauge' } } }),
    K.call('TaskCreate', { subject: 'Brancher la jauge' }, { ts: T(3), content: 'Task #2 created successfully: Brancher la jauge', tur: 'Task #2 created' }),
    K.call('TaskUpdate', { taskId: '1', status: 'completed' }, { ts: T(4) }),
    K.call('TaskUpdate', { taskId: '2', status: 'in_progress' }, { ts: T(5) })]);
  const ix = newIndexer();
  await ix.refresh();
  const d = createConversations(ix).detail(sid);
  assert.deepEqual(d.now.tasks, [{ text: 'Écrire la jauge', status: 'done' }, { text: 'Brancher la jauge', status: 'doing' }]);
  assert.equal(d.summary.headline, 'Brancher la jauge');
  fs.rmSync(path.dirname(p), { recursive: true });
});

test('lecture par morceaux : ligne ignorée à cheval sur deux morceaux, message suivant intact', async () => {
  const sid = 'b2b2b2b2-0000-4000-8000-000000000006';
  const B = mk(sid);
  const p = path.join(PROJECTS, '-Users-alex-Code-chunks', `${sid}.jsonl`);
  const CHUNK = 4 * 1024 * 1024;
  const head = '{"type":"cost-state","pad":"';
  const first = head + 'x'.repeat(CHUNK - 300 - 1 - head.length - 2) + '"}'; // la 2e ligne commence 300 octets avant la fin du morceau
  assert.equal(Buffer.byteLength(first) + 1, CHUNK - 300);
  write(p, [first, { type: 'api-request-blob', sessionId: sid, message: 'z'.repeat(5_000_000) }, B.human('après les gros blocs', T(1)),
    B.call('Read', { file_path: '/x' }, { ts: T(2), content: 'w'.repeat(6_000_000) }), B.human('et encore après', T(3))]);
  const ix = newIndexer();
  await ix.refresh();
  const s = ix.sessions.get(sid);
  assert.deepEqual(s.chapters.map((c) => c.prompt), ['après les gros blocs', 'et encore après']);
  assert.equal(s.activity[0].ok, true);
  fs.rmSync(path.dirname(p), { recursive: true });
});

test('fichier réécrit : la conversation est relue sans doublons', async () => {
  const sid = 'd0d0d0d0-0000-4000-8000-000000000002';
  const R = mk(sid);
  const p = path.join(PROJECTS, '-Users-alex-Code-rw', `${sid}.jsonl`);
  const base = [R.human('demande', T(0)), R.call('Bash', { command: 'npx vitest run' }, { ts: T(1), tur: { stdout: 'Tests 3 passed', stderr: '' } }), R.say('ok', T(2))];
  write(p, [...base, R.call('Bash', { command: 'ls' }, { ts: T(3) })]);
  const ix = newIndexer();
  await ix.refresh();
  assert.equal(ix.sessions.get(sid).toolCount, 2);
  write(p, base); // plus court : réécrit
  await ix.refresh(); // détecte et repart de zéro
  await ix.refresh();
  const s = ix.sessions.get(sid);
  assert.equal(s.toolCount, 1);
  assert.equal(s.tests.length, 1);
  assert.equal(s.chapters.length, 1);
});

test('conversation fermée depuis plus de 48 h : sort de la liste mais garde son usage', async () => {
  const sid = 'e0e0e0e0-0000-4000-8000-000000000003';
  const E = mk(sid);
  const p = path.join(PROJECTS, '-Users-alex-Code-old', `${sid}.jsonl`);
  write(p, [E.human('demande', T(0)), E.say('ok', T(1), U(100, 0, 0, 10))]);
  const ix = newIndexer();
  await ix.refresh();
  assert.ok(ix.sessions.has(sid));
  const w = ix.usageWeight(sid);
  const old = (Date.now() - 3 * 86400_000) / 1000;
  fs.utimesSync(p, old, old);
  ix.sessions.get(sid).lastTs = new Date(Date.now() - 3 * 86400_000).toISOString();
  ix.discover();
  assert.ok(!ix.sessions.has(sid) && ix.light.has(sid));
  assert.equal(ix.usageWeight(sid), w);
});

test('état de la conversation vu de l\'utilisateur', async () => {
  const reg = path.join(SESSIONS, `${process.pid}.json`);
  const set = (o) => fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, startedAt: BASE, ...o }));
  const ix = newIndexer();
  const conv = createConversations(ix);
  const status = async (o) => { set(o); await ix.refresh(); return conv.summaries().find((x) => x.id === SID).status; };
  assert.equal(await status({ status: 'busy' }), 'working');
  assert.equal(await status({ status: 'shell' }), 'working');
  assert.equal(await status({ status: 'idle' }), 'idle');
  assert.equal(await status({ status: 'busy', waitingFor: 'permission prompt' }), 'waiting');
  fs.rmSync(reg);
  ix.readLive();
  assert.equal(conv.summaries().find((x) => x.id === SID).status, 'closed');
  set({ status: 'busy' });
});

// ---------- tour 2 : cartes de la vue d'ensemble, plans en étapes, conversations jetables ----------

test('étape rouge voulue : les tournures réelles, pas les phrases de diagnostic', () => {
  for (const d of ['Write the gauge test and watch it fail', 'Run tests expecting failures', 'Run tests (expect failures)',
    'Run the new tests and confirm they fail', 'Run test to verify it fails', 'Run the new test expecting module-not-found failure',
    'Rerun smudges tests; confirm new test fails without prints', 'Write the failing tokens test and run it', 'Add failing L2.24 tests and run them',
    'Run the new reglages e2e spec (expected red)', 'Watch Profil/startup fail and read Home skeleton code', 'Run new test to see it fail (RED)',
    'Lancer le test et le voir échouer', 'Il échoue d\'abord', 'échec attendu (étape rouge)']) assert.ok(isExpectedFail(d), d);
  for (const d of ['Run the embeds-map test, expected green', 'Check if it fails on CI', 'Run all tests, expect no failures',
    'Verify it fails gracefully on bad input', 'Fix the red tests', 'Make sure nothing fails', 'unexpected failure investigation',
    'Rerun after fixing the failing test', 'Lancer les tests (aucun échec attendu)', 'Lancer vitest']) assert.ok(!isExpectedFail(d), d);
});

test('fichiers de plan reconnus', () => {
  for (const p of ['/x/docs/superpowers/plans/2026-10-19-1.4-execution.md', '/x/PLAN.md', '/x/docs/plan-v6-pro.md', '/x/relecture-front-du-plan.md',
    'docs/songeries-3d/plans/B-moteur-3d.md', '/Users/p/.claude/plans/je-t-ai-mis-un-wild-emerson.md']) assert.ok(isPlanFile(p), p);
  for (const p of ['/x/explanation.md', '/x/planning-6-jours.md', '/x/.superpowers/sdd/plan-a/progress.md', '/x/plans/a.txt', '/x/node_modules/plans/a.md'])
    assert.ok(!isPlanFile(p), p);
});

// Plan aux formes des vrais plans de l'utilisateur (atelier : lots, parties A/B/C, « ### Tâche L2.24 : … », cases par étape).
const PLAN_MD = `# Plan d'exécution 1.4

> **For agentic workers:** cases à cocher (\`- [ ]\`).

## Global Constraints

- [ ] Ne rien casser (case hors étape)

## Lot L2 : Fondations

## A. Le socle

### Tâche L2.1 : Le banc de captures

- [x] **Étape 1 : le test**
- [x] **Étape 2 : le code**

### Tâche L2.2 : Un seul bloc de jetons

- [x] **Étape 1 : le test**
- [ ] **Étape 2 : le code**

\`\`\`bash
### Tâche L9.9 : un faux titre dans un bloc de code
- [x] fausse case
\`\`\`

### Tâche L2.3 : Les briques **communes**

- [ ] **Étape 1**

## C. La charte appliquée aux écrans

### Tâche L2.18 : Validation par l'utilisateur (faite le 19/10)

### Tâche L2.24 : Icônes de fin de partie

- [ ] **Étape 1**
`;

test('analyse d\'un plan : étapes, groupes, cases, blocs de code ignorés', () => {
  const p = parsePlan(PLAN_MD);
  assert.equal(p.title, 'Plan d\'exécution 1.4');
  assert.deepEqual(p.steps.map((x) => [x.id, x.status, x.group]), [
    ['L2.1', 'done', 'A. Le socle'], ['L2.2', 'doing', 'A. Le socle'], ['L2.3', 'todo', 'A. Le socle'],
    ['L2.18', 'done', 'C. La charte appliquée aux écrans'], ['L2.24', 'todo', 'C. La charte appliquée aux écrans']]);
  assert.equal(p.steps[2].text, 'Les briques communes');
  // boutique : « ## Lot 0 · Fondations » puis « ### Task 2b: … » ; plan-mode : « ## C217 : … » ; lots seuls ; phases faites
  assert.deepEqual(parsePlan('# B\n## Lot 0 · Fondations\n### Task 1: Dépôt\n- [x] a\n### Task 2b: Faux DOM\n- [ ] b\n## Lot 2 · Assets\n### Task 11: Pages\n').steps
    .map((x) => [x.id, x.text, x.status, x.group]), [['1', 'Dépôt', 'done', 'Lot 0 · Fondations'], ['2b', 'Faux DOM', 'todo', 'Lot 0 · Fondations'], ['11', 'Pages', 'todo', 'Lot 2 · Assets']]);
  assert.deepEqual(parsePlan('# Plan\n## Contexte\n## C217 : Le Maquettiste\n## C218 : La charte\n## Vérification\n').steps.map((x) => x.id), ['C217', 'C218']);
  assert.deepEqual(parsePlan('# P\n## Lot 6\n- [x] a\n## Lot 7\n- [ ] b\n').steps.map((x) => [x.id, x.status]), [['6', 'done'], ['7', 'todo']]);
  assert.deepEqual(parsePlan('# P\n## Phase 1 — Préalables\n## Phase 2 — Backend — FAIT le 8 août\n## Phase 3 — Extension ✅\n## Phase 4 — Site (terminée)\n## Phase 5 — Doc (fait par Claude plus tard)\n').steps
    .map((x) => x.status), ['todo', 'done', 'done', 'done', 'todo']);
  // sans titre d'étape : les cases de premier niveau ; une spécification numérotée n'a pas d'étapes
  assert.deepEqual(parsePlan('# Itérations\n## 1. Rapide\n- [x] A1 Le menu\n  - [ ] sous-case\n- [ ] Le pied\n').steps
    .map((x) => [x.id, x.text, x.status]), [['A1', 'Le menu', 'done'], [null, 'Le pied', 'todo']]);
  assert.deepEqual(parsePlan('# Spec\n## 1. Intention\n### 3.1 Les ressources\n').steps, []);
  const fake = 'abcdef0123456789abcdef0123456789';
  assert.ok(!JSON.stringify(parsePlan(`# Plan API_KEY=${fake}\n## Lot 1\n### Tâche 1 : brancher STRIPE_SECRET_KEY=${fake}\n### Tâche 2 : sk-ant-${fake}\n`)).includes(fake), 'aucun secret');
});

test('registre d\'exécution : plan déclaré, étapes finies, dernière citée', () => {
  const l = parseLedger(['# SDD ledger — plan: docs/superpowers/plans/x.md (lot 2 seulement)', 'Spec : y',
    'Task L2.1: complete (commit abc, tests: vitest 3/3)', 'Task L2.1: minor (deferred): un détail',
    'Tasks 5, 6, 9 : complete (fa61596)', 'Tasks 11 à 13: complete', 'Relecture: fixed x', 'Task 7: implémentée (04f6892), relue',
    'Task 21: ALEX en attente — étape 8'].join('\n'));
  assert.equal(l.plan, 'docs/superpowers/plans/x.md');
  assert.deepEqual([...l.complete].sort(), ['11', '12', '13', '5', '6', '9', 'L2.1']);
  assert.equal(l.last, '21');
});

test('plan suivi par une conversation : cd, registre, inventaires écartés, agents du workflow', async () => {
  const sid = 'a7a7a7a7-0000-4000-8000-000000000007';
  const CODE = path.join(TMP, 'home', 'Code');
  const REPO = path.join(CODE, 'projetplan');
  const PLAN = path.join(REPO, 'docs', 'superpowers', 'plans', '2026-10-19-exec.md');
  const README = path.join(REPO, 'docs', 'superpowers', 'plans', 'README.md');
  const LEDGER = path.join(REPO, '.superpowers', 'sdd', '2026-10-19-exec', 'progress.md');
  fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(PLAN), { recursive: true });
  fs.writeFileSync(PLAN, PLAN_MD);
  fs.utimesSync(PLAN, new Date(T(-60)), new Date(T(-60)));
  fs.writeFileSync(README, '# Les plans\n\n| Fichier | Tâches |\n| --- | --- |\n| exec | 5 |\n');
  for (const x of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(REPO, 'docs', `${x}-plan.md`), '# X\n## Phase 1\n## Phase 2\n');
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, '# SDD ledger — plan: docs/superpowers/plans/2026-10-19-exec.md\nTask L2.1: complete (commit abc)\nTask L2.2: Ruling: une décision\n');
  fs.utimesSync(LEDGER, (BASE + 5 * 60_000) / 1000, (BASE + 5 * 60_000) / 1000);
  const P = mk(sid, { cwd: CODE }); // ouverte dans ~/Code : les chemins relatifs suivent le cd
  const tp = path.join(PROJECTS, '-Users-alex-Code', `${sid}.jsonl`);
  write(tp, [P.human('applique le plan', T(1)),
    P.call('Read', { file_path: README }, { ts: T(2) }),
    P.call('Bash', { command: `cd ${REPO} && sed -n 1,40p docs/superpowers/plans/2026-10-19-exec.md` }, { ts: T(3) }),
    P.call('Skill', { skill: 'superpowers:executing-plans', args: 'Plan : docs/superpowers/plans/2026-10-19-exec.md' }, { ts: T(3) }),
    P.call('Bash', { command: 'cat >> .superpowers/sdd/2026-10-19-exec/progress.md <<\'EOF\'\nTask L2.2: Ruling: une décision\nEOF' }, { ts: T(4) }),
    // inventaire de plusieurs plans (pas un plan suivi), puis le README relu (sans étapes) : rien ne change
    P.call('Bash', { command: 'for f in docs/a-plan.md docs/b-plan.md docs/c-plan.md docs/d-plan.md; do wc -l $f; done' }, { ts: T(6) }),
    P.call('Read', { file_path: README }, { ts: T(7) })]);
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const refs = [...ix.sessions.get(sid).planRefs.keys()];
  assert.ok(refs.includes(PLAN) && refs.includes(`sdd:${path.dirname(LEDGER)}`), 'plan cité par sed et par la compétence, registre par cat >>');
  assert.ok(!refs.some((k) => k.endsWith('a-plan.md')), 'inventaire de quatre plans écarté');
  let d = conv.detail(sid);
  assert.equal(d.now.plan.file, PLAN);
  assert.equal(d.now.plan.title, 'Plan d\'exécution 1.4');
  assert.equal(d.now.plan.updatedAt, T(-60), 'date de dernière modification du fichier');
  assert.deepEqual(d.now.plan.steps.map((x) => [x.id, x.status]), [['L2.1', 'done'], ['L2.2', 'doing'], ['L2.3', 'todo'], ['L2.18', 'done'], ['L2.24', 'todo']]);
  assert.deepEqual([d.now.plan.done, d.now.plan.total, d.now.plan.current], [2, 5, 'L2.2'], 'registre : L2.1 finie, L2.2 citée en dernier');
  assert.deepEqual(d.summary.progress, { done: 2, total: 5, label: 'Plan d\'exécution 1.4', current: 'L2.2 Un seul bloc de jetons' });

  // Le workflow avance plus vite que le registre : « faire:L2.2 » et « refuter:L2.2 » finis, « faire:L2.3 » en cours.
  const sub = path.join(PROJECTS, '-Users-alex-Code', sid, 'subagents');
  const agent = (id, label, ts, finished) => {
    write(path.join(sub, `agent-${id}.jsonl`), [mk(sid, { cwd: REPO, agentId: id }).call('Bash', { command: 'ls' }, { ts })]);
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: label, finished }));
    if (finished) fs.utimesSync(path.join(sub, `agent-${id}.jsonl`), (Date.now() - 600_000) / 1000, (Date.now() - 600_000) / 1000);
  };
  agent('faire22', 'faire:L2.2', T(20), true);
  agent('refuter22', 'refuter:L2.2', T(25), true);
  agent('faire23', 'faire:L2.3', T(30), false);
  const ix2 = newIndexer();
  await ix2.refresh();
  d = createConversations(ix2).detail(sid);
  assert.deepEqual(d.now.plan.steps.map((x) => [x.id, x.status]), [['L2.1', 'done'], ['L2.2', 'done'], ['L2.3', 'doing'], ['L2.18', 'done'], ['L2.24', 'todo']]);
  assert.deepEqual([d.now.plan.done, d.now.plan.current], [3, 'L2.3']);
  assert.equal(d.summary.progress.current, 'L2.3 Les briques communes');
  fs.rmSync(path.dirname(tp), { recursive: true });
  fs.rmSync(REPO, { recursive: true });
});

test('carte : échecs récents non rattrapés, tests en fond, dernier résultat, artefacts', async () => {
  const sid = 'a8a8a8a8-0000-4000-8000-000000000008';
  const now = Date.now();
  const N = (min) => new Date(now + min * 60_000).toISOString();
  const C = mk(sid);
  const tp = path.join(PROJECTS, '-Users-alex-Code-cartes', `${sid}.jsonl`);
  const reg = path.join(SESSIONS, 'cartes.json');
  write(tp, [C.human('lance tout', N(-210)),
    C.call('Bash', { command: 'npx playwright test', description: 'e2e de la veille' }, { ts: N(-200), isError: true, tur: { stdout: '2 failed', stderr: '' } }),
    C.call('Bash', { command: 'npx vitest run', description: 'Lancer vitest' }, { ts: N(-90), isError: true, tur: { stdout: 'Tests 2 failed | 3 passed', stderr: '' } }),
    C.call('Bash', { command: 'npx vitest run', description: 'Relancer vitest' }, { ts: N(-80), tur: { stdout: 'Tests 5 passed', stderr: '' } }),
    C.call('Bash', { command: 'npx tsc -b', description: 'Vérifier les types' }, { ts: N(-70), isError: true, tur: { stdout: 'src/a.ts(1,1): error TS2322: x', stderr: '' } }),
    C.call('Bash', { command: 'npx vitest run src/jetons.test.ts', description: 'Write the failing tokens test and run it' }, { ts: N(-60), isError: true, tur: { stdout: 'Tests 1 failed', stderr: '' } }),
    C.call('Artifact', { action: 'publish', file_path: '/x/charte.html' }, { ts: N(-50), tur: { url: 'https://claude.ai/artifact/c1', title: 'Charte' } }),
    C.call('Artifact', { action: 'publish', file_path: '/x/plan.html' }, { ts: N(-40), tur: { url: 'https://claude.ai/artifact/c2', title: 'Plan des écrans' } }),
    C.call('TodoWrite', { todos: [{ content: 'Jetons', status: 'completed' }, { content: 'Écrans', status: 'in_progress' }, { content: 'Textes', status: 'pending' }] }, { ts: N(-30) }),
    C.call('Bash', { command: 'npx vitest run', run_in_background: true, description: 'Tests en fond' }, { ts: N(-10), content: 'Command running in background', tur: { backgroundTaskId: 'bz' } })]);
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: sid, cwd: CWD, startedAt: Date.now() - 4 * 3600_000, status: 'busy' }));
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const s = conv.summaries().find((x) => x.id === sid);
  assert.deepEqual(s.tests, { failedRecent: 1, running: 1, lastOk: false, lastTs: N(-70), lastTitle: 'Vérifier les types' },
    'vitest rattrapé par une réussite, e2e trop ancien, étape rouge ignorée : reste tsc');
  assert.deepEqual(s.artifacts, { count: 2, last: { title: 'Plan des écrans', url: 'https://claude.ai/artifact/c2', ts: N(-40) } });
  assert.equal(conv.detail(sid).now.tasksTs, N(-30));
  assert.deepEqual(s.progress, { done: 1, total: 3, label: 'Tâches', current: 'Écrans' });
  // conversation fermée : un test lancé en fond ne finira plus, il n'est plus « en cours »
  fs.rmSync(reg);
  ix.readLive();
  assert.equal(createConversations(ix).summaries().find((x) => x.id === sid).tests.running, 0);
  fs.rmSync(path.dirname(tp), { recursive: true });
});

test('conversations jetables (dossiers temporaires, brouillons) : hors de la vue d\'ensemble, sauf ouvertes', async () => {
  assert.ok(isTempPath('/private/tmp/claude-501/-x/scratchpad/permtest/proj'));
  assert.ok(isTempPath('/private/var/folders/9k/abc/T/tmp.9sCCuHiDzr'));
  assert.ok(isTempPath('/tmp/essai'));
  assert.ok(!isTempPath(CWD), 'le dossier personnel n\'est jamais jetable (même s\'il est dans un dossier temporaire, comme ici)');
  assert.ok(!isTempPath('/Users/alex/Code/tmp-app'));
  const X = 'a9a9a9a9-0000-4000-8000-000000000009', Y = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const tmpCwd = '/private/tmp/claude-501/-x/scratchpad/permtest/proj';
  const J = mk(X, { cwd: tmpCwd });
  const px = path.join(PROJECTS, '-private-tmp-claude-501--x-scratchpad-permtest-proj', `${X}.jsonl`);
  write(px, [J.human('essai', T(100)), ...Array.from({ length: 6 }, (_, i) => J.call('Bash', { command: 'ls' }, { ts: T(101 + i) })),
    J.call('Bash', { command: 'npx vitest run' }, { ts: T(110), isError: true, tur: { stdout: 'Tests 1 failed', stderr: '' } }),
    J.call('Artifact', { action: 'publish', file_path: '/x/a.html' }, { ts: T(111), tur: { url: 'https://claude.ai/artifact/jetable', title: 'Essai' } }),
    J.say('Fini.', T(120))]);
  const O = mk(Y, { cwd: '/private/var/folders/zz/abc/T/tmp.Q1' });
  const py = path.join(PROJECTS, '-private-var-folders-zz-abc-T-tmp-Q1', `${Y}.jsonl`);
  write(py, [O.human('essai ouvert', T(100)), O.say('ok', T(101))]);
  const reg = path.join(SESSIONS, 'jetable.json');
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: Y, cwd: '/private/var/folders/zz/abc/T/tmp.Q1', startedAt: BASE, status: 'idle' }));
  const ix = newIndexer();
  await ix.refresh();
  const conv = createConversations(ix);
  const ids = conv.summaries().map((x) => x.id);
  assert.ok(!ids.includes(X), 'jetable fermée : pas de carte');
  assert.ok(ids.includes(Y), 'jetable ouverte : montrée');
  assert.ok(ids.includes(SID));
  assert.equal(conv.isThrowaway(X), true);
  assert.equal(conv.isThrowaway(Y), false);
  const since = new Date(BASE + 99 * 60_000).toISOString();
  assert.ok(!conv.reports(since).some((r) => r.conversationId === X), 'ni ses artefacts ni sa fin de mission dans les rapports');
  assert.equal(conv.sinceCounts(since).testsFailed, 0, 'ni ses tests en échec');
  assert.ok(conv.detail(X), 'son détail reste lisible');
  fs.rmSync(reg);
  fs.rmSync(path.dirname(px), { recursive: true });
  fs.rmSync(path.dirname(py), { recursive: true });
});
