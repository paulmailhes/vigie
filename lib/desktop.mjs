// Vigie — les outils de l'utilisateur : Claude Code (extension VS Code ou app Claude de bureau) et Codex (extension
// VS Code ou app ChatGPT de bureau). Les conversations de l'app Claude écrivent leur historique dans
// ~/.claude/projects comme VS Code (marque « claude-desktop ») et suivent les mêmes hooks ; l'app garde à côté leur
// vrai titre (claude-code-sessions/<compte>/<espace>/local_*.json, champ cliSessionId). Vérifié le 2026-10-21.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SURFACES = {
  vscode: 'VS Code',
  'claude-app': 'l\'app Claude',
  'codex-app': 'l\'app ChatGPT',
  terminal: 'le Terminal',
};

// D'où vient une conversation : Claude (entrypoint du transcript) ou Codex (originator du fil).
export function surfaceOf({ agent = null, entrypoint = null, originator = null } = {}) {
  if (agent === 'codex') {
    const o = String(originator || '');
    if (/vscode/i.test(o)) return 'vscode';
    if (/cli|exec/i.test(o)) return 'terminal';
    return 'codex-app';
  }
  const e = String(entrypoint || '');
  if (/desktop/i.test(e)) return 'claude-app';
  if (/^(cli|sdk-cli)$/i.test(e)) return 'terminal';
  return 'vscode';
}

// Dossier « brouillon » de l'app Claude (conversation sans projet) : pas un nom de projet à montrer.
export const isScratch = (cwd) => /\/Library\/Application Support\/Claude\/scratch-workspaces\//.test(String(cwd || ''));

export function createDesktop({ home = os.homedir(), now = () => Date.now(), apps = '/Applications' } = {}) {
  const SESS = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  let cache = { at: -Infinity, map: new Map() };
  const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

  // cliSessionId → { title, archived } ; relu au plus toutes les 30 s.
  function claudeSessions() {
    if (now() - cache.at < 30_000) return cache.map;
    const map = new Map();
    let n = 0;
    for (const a of list(SESS)) {
      for (const b of list(path.join(SESS, a))) {
        for (const f of list(path.join(SESS, a, b)).filter((x) => /^local_.*\.json$/.test(x))) {
          if (++n > 3000) break;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(SESS, a, b, f), 'utf8'));
            if (typeof j?.cliSessionId === 'string') map.set(j.cliSessionId, { title: typeof j.title === 'string' ? j.title.slice(0, 200) : null, archived: !!j.isArchived });
          } catch { /* fichier en cours d'écriture */ }
        }
      }
    }
    cache = { at: now(), map };
    return map;
  }

  // Ce qui est installé (pour pré-cocher l'accueil) : jamais une obligation.
  function tools() {
    const ext = (prefix) => ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].some((e) => list(path.join(home, e, 'extensions')).some((d) => d.startsWith(prefix)));
    const app = (name) => [path.join(apps, name), path.join(home, 'Applications', name)].find(exists) || null;
    const claudeApp = app('Claude.app');
    const chatgpt = app('ChatGPT.app') || app('Codex.app');
    return {
      claudeVSCode: ext('anthropic.claude-code-'),
      claudeApp: !!claudeApp,
      codexVSCode: ext('openai.chatgpt-'),
      // seule l'app de nouvelle génération embarque Codex (l'ancienne app ChatGPT n'a que les tâches dans le cloud)
      codexApp: !!chatgpt && exists(path.join(chatgpt, 'Contents', 'Resources', 'codex-cli')),
    };
  }

  return { claudeSessions, tools };
}
