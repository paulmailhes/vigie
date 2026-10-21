// Branche (ou débranche) le hook Vigie dans ~/.claude/settings.json, sans toucher au reste.
//   node scripts/settings.mjs install [--on]     node scripts/settings.mjs uninstall
// Une sauvegarde horodatée est faite à chaque écriture. Les sessions ouvertes rechargent le fichier seules.
// VIGIE_CLAUDE_SETTINGS remplace le chemin du fichier (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, STATE_FILE, DEFAULT_STATE, writeState } from '../lib/state.mjs';

const SETTINGS = process.env.VIGIE_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const NODE = fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
const HOOK = path.join(ROOT, 'hook.mjs');
// Chemins entre guillemets (dossier renommé, espaces) ; --vigie marque nos entrées quel que soit le dossier.
const COMMAND = `"${NODE}" "${HOOK}" --vigie`;
const ours = (c) => /\s--vigie\b/.test(c) || c.includes('auto-accept/hook.mjs') || c.includes(HOOK);

const WANTED = {
  // 7300 s : au-delà de l'attente maximale réglable (120 min) ; le hook s'arrête seul juste avant.
  PermissionRequest: { matcher: '*', timeout: 7300 },
  // Questions, et actions sensibles « seulement par Vigie » retenues avant toute fenêtre (attente ≤ 120 min).
  PreToolUse: { matcher: 'AskUserQuestion|ExitPlanMode|Bash|Monitor|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*', timeout: 7300 },
  PermissionDenied: { matcher: '*', timeout: 30 },
};

const action = process.argv[2];
if (action !== 'install' && action !== 'uninstall') {
  console.error('usage: node scripts/settings.mjs install [--on] | uninstall');
  process.exit(1);
}

let raw = null;
let mode = 0o600;
try {
  raw = fs.readFileSync(SETTINGS, 'utf8');
  mode = fs.statSync(SETTINGS).mode & 0o777;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (raw === null && action === 'uninstall') {
  console.log(`Rien à débrancher : ${SETTINGS} n'existe pas.`);
  process.exit(0);
}
// Un fichier illisible n'est jamais réécrit : on s'arrête avant d'écrire quoi que ce soit.
const settings = raw === null ? {} : JSON.parse(raw);
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${SETTINGS} n'est pas un objet JSON`);
const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

// Retire nos anciennes entrées (idempotent, y compris celles de la v1), garde celles des autres.
for (const ev of Object.keys(hooks)) {
  if (!Array.isArray(hooks[ev])) continue;
  hooks[ev] = hooks[ev]
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(String(h.command || ''))) }))
    .filter((g) => g.hooks.length > 0);
  if (hooks[ev].length === 0) delete hooks[ev];
}

if (action === 'install') {
  for (const [ev, { matcher, timeout }] of Object.entries(WANTED)) {
    (hooks[ev] ||= []).push({ matcher, hooks: [{ type: 'command', command: COMMAND, timeout }] });
  }
  if (!fs.existsSync(STATE_FILE)) writeState({ ...structuredClone(DEFAULT_STATE), autoAccept: process.argv.includes('--on') });
}

if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
let backup = null;
if (raw !== null) {
  backup = `${SETTINGS}.bak-vigie-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, raw, { mode });
}
// Écriture atomique, avec les mêmes droits que l'original (souvent 600).
const tmp = `${SETTINGS}.vigie.tmp`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
fs.chmodSync(tmp, mode);
fs.renameSync(tmp, SETTINGS);
console.log(`${action === 'install' ? 'Hook branché' : 'Hook débranché'} dans ${SETTINGS}${backup ? ` (sauvegarde : ${backup})` : ''}`);
