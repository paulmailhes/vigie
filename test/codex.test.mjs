// Conversations Codex : lecture des fils ~/.codex/sessions (faux dossier, rien de réel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodex, commandsOf, patchFiles } from '../lib/codex.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-codex-'));
const HOME = path.join(TMP, 'codex');
const DAY = path.join(HOME, 'sessions', '2026', '10', '20');
fs.mkdirSync(DAY, { recursive: true });
const NOW = Date.parse('2026-10-20T10:10:00Z');
const ID = '01a12fe9-e384-7742-8e40-074aa1632763';
// Codex tourne mais n'a aucun fil chargé (les tests ne dépendent pas des processus du Mac)
const CODEX_RUNS = () => ({ running: true, files: new Set() });
const SUB = '01a12fe9-0000-7000-8000-000000000001';
const line = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
const resets = Math.floor(Date.parse('2026-10-25T10:00:00Z') / 1000);

fs.writeFileSync(path.join(DAY, `rollout-2026-10-20T10-00-00-${ID}.jsonl`), [
  line('2026-10-20T10:00:00Z', 'session_meta', { id: ID, cwd: '/Users/alex/Code/atelier', originator: 'codex_vscode', source: 'vscode', thread_source: 'user' }),
  line('2026-10-20T10:00:01Z', 'event_msg', { type: 'task_started', turn_id: 't1' }),
  line('2026-10-20T10:00:02Z', 'event_msg', { type: 'user_message', message: 'Refais la page d’accueil et publie-la' }),
  line('2026-10-20T10:00:05Z', 'response_item', { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ explanation: 'Refonte de l’accueil', plan: [
    { step: 'Lire la page', status: 'completed' }, { step: 'Réécrire le haut', status: 'in_progress' }, { step: 'Publier', status: 'pending' }] }) }),
  line('2026-10-20T10:01:00Z', 'response_item', { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"git commit -m \\"Accueil : nouveau haut\\"","max_output_tokens":2000}));' }),
  line('2026-10-20T10:01:30Z', 'response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /Users/alex/Code/atelier/index.html\n@@\n-a\n+b\n*** End Patch' }),
  line('2026-10-20T10:02:00Z', 'response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'relire' }) }),
  line('2026-10-20T10:05:00Z', 'event_msg', { type: 'agent_message', message: 'Je relance le serveur pour vérifier le haut.', phase: 'commentary' }),
  line('2026-10-20T10:05:01Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 50000 }, last_token_usage: { total_tokens: 4000 } },
    rate_limits: { primary: { used_percent: 12, window_minutes: 10080, resets_at: resets }, secondary: null, plan_type: 'pro' } }),
].join('\n') + '\n');

fs.writeFileSync(path.join(DAY, `rollout-2026-10-20T10-02-00-${SUB}.jsonl`), [
  line('2026-10-20T10:02:00Z', 'session_meta', { id: SUB, cwd: '/Users/alex/Code/atelier', thread_source: 'subagent', parent_thread_id: ID, agent_nickname: 'Peirce', agent_path: '/root/relire' }),
  line('2026-10-20T10:02:01Z', 'event_msg', { type: 'task_started', turn_id: 's1' }),
].join('\n') + '\n');

test('outils : commandes du mode code et d’un appel shell, fichiers d’un patch', () => {
  assert.deepEqual(commandsOf('exec', { type: 'custom_tool_call', input: 'text(await tools.exec_command({cmd:"ls -la","max_output_tokens":10}));\ntext(await tools.exec_command({cmd:"npm test"}));' }), ['ls -la', 'npm test']);
  assert.deepEqual(commandsOf('shell_command', { type: 'function_call', arguments: '{"command":"git status","workdir":"/x"}' }), ['git status']);
  assert.deepEqual(patchFiles('*** Add File: /a.txt\n*** Update File: /b.js\n*** Delete File: /c.css'), [{ op: 'add', path: '/a.txt' }, { op: 'update', path: '/b.js' }, { op: 'delete', path: '/c.css' }]);
});

test('une conversation Codex : en cours, son plan, son commit, son agent, sa consommation', () => {
  // fichiers « modifiés maintenant » : la conversation est au travail
  for (const f of fs.readdirSync(DAY)) fs.utimesSync(path.join(DAY, f), NOW / 1000, NOW / 1000);
  const c = createCodex({ codexHome: HOME, now: () => NOW, liveFiles: CODEX_RUNS });
  const list = c.summaries();
  assert.deepEqual(list.map((s) => s.id), [ID], 'l’agent n’est pas listé à part');
  const s = list[0];
  assert.equal(s.agent, 'codex');
  assert.equal(s.status, 'busy');
  assert.equal(s.project, 'atelier');
  assert.equal(s.title, 'Refais la page d’accueil et publie-la');
  assert.deepEqual([s.progress.done, s.progress.total, s.progress.current], [1, 3, 'Réécrire le haut']);
  assert.equal(s.agentsRunning, 1);
  const d = c.detail(ID);
  assert.equal(d.now.live.text, 'Je relance le serveur pour vérifier le haut.');
  assert.equal(d.now.plan.steps[1].status, 'doing');
  assert.ok(d.milestones.some((m) => m.kind === 'commit' && m.title === 'Accueil : nouveau haut'));
  assert.equal(d.current.commits, 1);
  assert.equal(d.files[0].path, '/Users/alex/Code/atelier/index.html');
  assert.equal(d.agents.running[0].title, 'relire (Peirce)');
  const a = c.account();
  assert.deepEqual([a.id, a.plan, a.usage.week.pct], ['codex', 'pro', 12]);
  // après la remise à zéro, l’ancien pourcentage ne vaut plus rien
  const later = createCodex({ codexHome: HOME, now: () => Date.parse('2026-10-26T00:00:00Z'), liveFiles: CODEX_RUNS });
  assert.equal(later.account().usage.week.pct, null);
});

test('conversation Codex ouverte : fil chargé par Codex, ou active depuis moins de 30 min ; Codex fermé : aucune', () => {
  const file = path.join(DAY, fs.readdirSync(DAY).find((f) => f.includes(ID)));
  const quiet = NOW + 45 * 60_000; // 45 min après la dernière activité, plus de tour en cours
  for (const f of fs.readdirSync(DAY)) fs.utimesSync(path.join(DAY, f), NOW / 1000, NOW / 1000);
  const state = (liveFiles, at = quiet) => createCodex({ codexHome: HOME, now: () => at, liveFiles }).summaries().find((s) => s.id === ID).status;
  assert.equal(state(() => ({ running: true, files: new Set([file]) })), 'idle', 'chargée par Codex : ouverte, même sans activité récente');
  assert.equal(state(() => ({ running: true, files: new Set() })), 'closed', 'plus chargée, rien depuis 45 min : fermée (avant : 12 h)');
  assert.equal(state(() => ({ running: true, files: null })), 'closed', 'relevé illisible : la règle des 30 min');
  assert.equal(state(() => ({ running: false, files: new Set() }), NOW), 'closed', 'Codex ne tourne pas : rien d’ouvert, même en plein tour');
  assert.notEqual(state(() => ({ running: true, files: null }), NOW + 10 * 60_000), 'closed', 'active il y a 10 min : ouverte');
});
