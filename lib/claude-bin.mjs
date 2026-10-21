// Où trouver Claude Code. Le moteur tourne sous launchd avec un PATH minimal : chercher « claude » dans le PATH ne
// suffit pas. Dans l'ordre : l'installation officielle, les gestionnaires habituels (npm, Homebrew, Volta, Bun, nvm),
// le PATH, et à défaut la copie livrée avec l'extension VS Code (ou Cursor, Windsurf) : quiconque utilise Claude Code
// dans son éditeur l'a, même sans l'avoir jamais installé en ligne de commande. null : introuvable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isExec = (p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
};
// « 2.1.304-darwin-arm64 » → [2, 1, 304] ; les dossiers sont triés du plus récent au plus ancien.
const version = (name) => (/(\d+)\.(\d+)\.(\d+)/.exec(name) || [0, 0, 0, 0]).slice(1).map(Number);
const newestFirst = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

export function claudeCandidates({ home = os.homedir(), env = process.env } = {}) {
  const out = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
  ];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  for (const v of list(nvm).sort(newestFirst)) out.push(path.join(nvm, v, 'bin', 'claude'));
  for (const dir of String(env.PATH || '').split(':').filter(Boolean)) out.push(path.join(dir, 'claude'));
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const ext = path.join(home, editor, 'extensions');
    for (const d of list(ext).filter((n) => n.startsWith('anthropic.claude-code-')).sort(newestFirst)) {
      out.push(path.join(ext, d, 'resources', 'native-binary', 'claude'));
    }
  }
  return out;
}

export function findClaudeBin(opts = {}) {
  const env = opts.env || process.env;
  if (env.VIGIE_CLAUDE_BIN) return env.VIGIE_CLAUDE_BIN;
  return claudeCandidates(opts).find(isExec) || null;
}

// La copie de l'extension n'est jamais dans le PATH de l'utilisateur : un Terminal de repli doit la nommer en entier.
export const isEditorCopy = (bin) => /\/extensions\/anthropic\.claude-code-[^/]+\/resources\/native-binary\/claude$/.test(String(bin || ''));

// Une commande lançable ? Chemin absolu exécutable, ou nom présent dans le PATH donné.
export function canRun(cmd, env = process.env) {
  if (!cmd) return false;
  if (cmd.includes('/')) return isExec(cmd);
  return String(env.PATH || '').split(':').filter(Boolean).some((dir) => isExec(path.join(dir, cmd)));
}
