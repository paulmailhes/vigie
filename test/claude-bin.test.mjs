import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeBin, isEditorCopy, canRun, claudeBinResolver } from '../lib/claude-bin.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-claude-bin-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const exe = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };

test('claude introuvable dans le PATH du moteur : la copie la plus récente de l\'extension VS Code', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'h-'));
  const env = { PATH: '/usr/bin:/bin' };
  assert.equal(findClaudeBin({ home, env }), null, 'rien d\'installé');
  exe(path.join(home, '.vscode/extensions/anthropic.claude-code-2.1.9-darwin-arm64/resources/native-binary/claude'));
  const newest = exe(path.join(home, '.vscode/extensions/anthropic.claude-code-2.1.304-darwin-arm64/resources/native-binary/claude'));
  fs.mkdirSync(path.join(home, '.vscode/extensions/autre.extension-1.0.0'), { recursive: true });
  assert.equal(findClaudeBin({ home, env }), newest, '2.1.304 avant 2.1.9');
  assert.equal(isEditorCopy(newest), true);
  // installé en ligne de commande : passe avant l'extension
  const local = exe(path.join(home, '.local/bin/claude'));
  assert.equal(findClaudeBin({ home, env }), local);
  assert.equal(isEditorCopy(local), false);
  assert.equal(findClaudeBin({ home, env: { ...env, VIGIE_CLAUDE_BIN: '/choisi/claude' } }), '/choisi/claude');
});

test('nvm et PATH ; une commande absente n\'est pas lançable', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'h-'));
  const viaNvm = exe(path.join(home, '.nvm/versions/node/v22.3.0/bin/claude'));
  exe(path.join(home, '.nvm/versions/node/v20.1.0/bin/claude'));
  assert.equal(findClaudeBin({ home, env: { PATH: '' } }), viaNvm);
  const bin = exe(path.join(TMP, 'pathdir', 'claude'));
  assert.equal(canRun('claude', { PATH: path.dirname(bin) }), true);
  assert.equal(canRun('claude', { PATH: '/usr/bin' }), false);
  assert.equal(canRun('/nulle/part/claude'), false);
  assert.equal(canRun(bin), true);
});

test('la copie de l\'app Claude (pas celle de sa machine virtuelle) ; retrouvé quand l\'extension ou l\'app se met à jour', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'h-'));
  const env = { PATH: '/usr/bin:/bin' };
  const app = path.join(home, 'Library/Application Support/Claude');
  exe(path.join(app, 'claude-code-vm/2.1.304/claude'));
  assert.equal(findClaudeBin({ home, env }), null, 'la copie Linux de la machine virtuelle ne compte pas');
  const v1 = exe(path.join(app, 'claude-code/2.1.304/6bbba6adc37f/claude.app/Contents/MacOS/claude'));
  assert.equal(findClaudeBin({ home, env }), v1);
  assert.equal(isEditorCopy(v1), true, 'pas dans le PATH : nommée en entier dans un Terminal de repli');
  // le moteur a démarré avant : le chemin retenu disparaît à la mise à jour, le suivant est trouvé
  const now = claudeBinResolver({ find: () => findClaudeBin({ home, env }) });
  assert.equal(now(), v1);
  fs.rmSync(path.join(app, 'claude-code/2.1.304'), { recursive: true });
  const v2 = exe(path.join(app, 'claude-code/2.1.320/a1b2c3d4e5f6/claude.app/Contents/MacOS/claude'));
  assert.equal(now(), v2, 'retrouvé après la mise à jour');
  // rien au démarrage, installé ensuite : trouvé sans redémarrer
  const empty = fs.mkdtempSync(path.join(TMP, 'h-'));
  const later = claudeBinResolver({ find: () => findClaudeBin({ home: empty, env }) });
  assert.equal(later(), null);
  const local = exe(path.join(empty, '.local/bin/claude'));
  assert.equal(later(), local);
  assert.equal(claudeBinResolver({ fixed: '/choisi/claude', find: () => local })(), '/choisi/claude', 'un chemin imposé reste');
});
