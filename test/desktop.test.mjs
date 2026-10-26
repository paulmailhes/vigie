import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktop, surfaceOf, isScratch, SURFACES } from '../lib/desktop.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-bureau-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('outil d\'une conversation : VS Code, app Claude, Terminal, app ChatGPT', () => {
  assert.equal(surfaceOf({ entrypoint: 'claude-vscode' }), 'vscode');
  assert.equal(surfaceOf({ entrypoint: 'claude-desktop' }), 'claude-app');
  assert.equal(surfaceOf({ entrypoint: 'cli' }), 'terminal');
  assert.equal(surfaceOf({ entrypoint: null }), 'vscode', 'inconnu : comme avant');
  assert.equal(surfaceOf({ agent: 'codex', originator: 'codex_vscode' }), 'vscode');
  assert.equal(surfaceOf({ agent: 'codex', originator: 'codex_cli_rs' }), 'terminal');
  assert.equal(surfaceOf({ agent: 'codex', originator: 'Codex Desktop' }), 'codex-app');
  assert.equal(SURFACES['claude-app'], 'l\'app Claude');
  assert.equal(isScratch('/Users/a/Library/Application Support/Claude/scratch-workspaces/x/y/scratch-2026-10-03-d071dc'), true);
  assert.equal(isScratch('/Users/a/Code/atelier'), false);
});

test('app Claude : titres lus par identifiant de conversation ; outils installés détectés', () => {
  const home = path.join(TMP, 'home');
  const dir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/compte/espace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_1.json'), JSON.stringify({ cliSessionId: 'aaaa-1', title: 'Centralisateur de communications', isArchived: false, enabledMcpTools: { x: true } }));
  fs.writeFileSync(path.join(dir, 'local_2.json'), '{ abîmé');
  fs.writeFileSync(path.join(dir, 'scheduled-tasks.json'), '[]');
  const apps = path.join(TMP, 'Applications');
  const d = createDesktop({ home, apps });
  assert.deepEqual([...d.claudeSessions()], [['aaaa-1', { title: 'Centralisateur de communications', archived: false, localId: 'local_1' }]],
    'id local : le nom du fichier, pour rouvrir la conversation dans l\'app');
  assert.deepEqual(d.tools(), { claudeVSCode: false, claudeApp: false, codexVSCode: false, codexApp: false });
  fs.mkdirSync(path.join(home, '.vscode/extensions/anthropic.claude-code-2.1.304-darwin-arm64'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'Claude.app'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'ChatGPT.app/Contents/Resources'), { recursive: true });
  assert.deepEqual(d.tools(), { claudeVSCode: true, claudeApp: true, codexVSCode: false, codexApp: false }, 'ancienne app ChatGPT : pas de Codex');
  fs.mkdirSync(path.join(apps, 'ChatGPT.app/Contents/Resources/codex-cli/bin'), { recursive: true });
  assert.equal(d.tools().codexApp, true);
});

test('où un agent peut s\'ouvrir : VS Code avec son extension Claude Code, l\'app Claude', () => {
  const home = path.join(TMP, 'home-surfaces');
  const apps = path.join(TMP, 'Applications-surfaces');
  const d = createDesktop({ home, apps });
  assert.deepEqual(d.agentSurfaces(), []);
  fs.mkdirSync(path.join(apps, 'Visual Studio Code.app'), { recursive: true });
  assert.deepEqual(d.agentSurfaces(), [], 'VS Code sans l\'extension Claude Code : pas de lancement');
  for (const e of ['.cursor', '.windsurf', '.vscode-insiders']) fs.mkdirSync(path.join(home, e, 'extensions/anthropic.claude-code-2.1.304-darwin-arm64'), { recursive: true });
  assert.deepEqual(d.agentSurfaces(), [], 'l\'extension dans Cursor, Windsurf ou Insiders seulement : le lien vscode:// ne va qu\'à VS Code');
  fs.mkdirSync(path.join(home, '.vscode/extensions/anthropic.claude-code-2.1.304-darwin-arm64'), { recursive: true });
  assert.deepEqual(d.agentSurfaces(), ['vscode']);
  fs.rmSync(path.join(apps, 'Visual Studio Code.app'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Applications', 'Visual Studio Code.app'), { recursive: true });
  assert.deepEqual(d.agentSurfaces(), ['vscode'], 'VS Code rangé dans ~/Applications');
  fs.mkdirSync(path.join(apps, 'Claude.app'), { recursive: true });
  assert.deepEqual(d.agentSurfaces(), ['vscode', 'claude-app']);
});
