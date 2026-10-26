// Branche (ou débranche) le hook Vigie dans ~/.claude/settings.json, sans toucher au reste.
//   node scripts/settings.mjs install [--on]     node scripts/settings.mjs uninstall
// Une sauvegarde horodatée est faite à chaque écriture. Les sessions ouvertes rechargent le fichier seules.
// VIGIE_CLAUDE_SETTINGS remplace le chemin du fichier (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, STATE_FILE, DEFAULT_STATE, DEFAULT_GUARDS, writeState } from '../lib/state.mjs';

const SETTINGS = process.env.VIGIE_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
// Le Node.js choisi par l'installateur (VIGIE_NODE), sinon celui de Homebrew (chemin stable d'une mise à jour à
// l'autre), sinon celui qui exécute ce script.
const NODE = process.env.VIGIE_NODE || (fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath);
const HOOK = path.join(ROOT, 'hook.mjs');
// Chemins entre guillemets (dossier renommé, espaces) ; --vigie marque nos entrées quel que soit le dossier.
const COMMAND = `"${NODE}" "${HOOK}" --vigie`;
const ours = (c) => /\s--vigie\b/.test(c) || c.includes('auto-accept/hook.mjs') || c.includes(HOOK);

// Outils MCP : seulement ceux que visent les garde-fous (paiement, e-mail, réseaux sociaux, suppression en ligne).
// Avant, le hook démarrait avant CHAQUE appel MCP (Webflow, Figma…), pour rien : ~0,1 s de calcul à chaque fois.
// « .* » au bout : la même forme convient que Claude Code ancre le motif ou non.
const MCP_GUARDED = DEFAULT_GUARDS.filter((r) => !r.match && /mcp__/.test(r.tool || '')).map((r) => `(?:${r.tool}).*`).join('|');
const WANTED = {
  // 7300 s : au-delà de l'attente maximale réglable (120 min) ; le hook s'arrête seul juste avant.
  PermissionRequest: { matcher: '*', timeout: 7300 },
  // Questions, et actions sensibles : la fenêtre de la conversation s'affiche (permissionDecision « ask »).
  PreToolUse: { matcher: `AskUserQuestion|ExitPlanMode|Bash|Monitor|PowerShell|Write|Edit|MultiEdit|NotebookEdit|${MCP_GUARDED}`, timeout: 7300 },
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

// ---------- Codex (OpenAI) : ~/.codex/hooks.json, même hook avec --codex ----------
// Seulement si Codex est installé (dossier ~/.codex). Les hooks des autres sont gardés ; une sauvegarde est faite.
// Codex demande de faire confiance une fois à un hook nouveau ou modifié (commande /hooks dans Codex).
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_HOOKS = process.env.VIGIE_CODEX_HOOKS || path.join(CODEX_HOME, 'hooks.json');
if (fs.existsSync(path.dirname(CODEX_HOOKS))) {
  let craw = null;
  try { craw = fs.readFileSync(CODEX_HOOKS, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const conf = craw ? JSON.parse(craw) : {};
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) throw new Error(`${CODEX_HOOKS} n'est pas un objet JSON`);
  const ch = conf.hooks && typeof conf.hooks === 'object' ? conf.hooks : {};
  for (const ev of Object.keys(ch)) {
    if (!Array.isArray(ch[ev])) continue;
    ch[ev] = ch[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(String(h.command || ''))) })).filter((g) => g.hooks.length > 0);
    if (!ch[ev].length) delete ch[ev];
  }
  if (action === 'install') {
    const cmd = `${COMMAND} --codex`;
    (ch.PermissionRequest ||= []).push({ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 7300, statusMessage: 'Vigie' }] });
    (ch.PreToolUse ||= []).push({ matcher: 'Bash|apply_patch|mcp__.*', hooks: [{ type: 'command', command: cmd, timeout: 7300, statusMessage: 'Vigie' }] });
  }
  if (Object.keys(ch).length) conf.hooks = ch; else delete conf.hooks;
  if (craw !== null) fs.writeFileSync(`${CODEX_HOOKS}.bak-vigie-${new Date().toISOString().replace(/[:.]/g, '-')}`, craw, { mode: 0o600 });
  if (craw !== null || action === 'install') {
    const ctmp = `${CODEX_HOOKS}.vigie.tmp`;
    fs.writeFileSync(ctmp, JSON.stringify(conf, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(ctmp, CODEX_HOOKS);
    console.log(action === 'install'
      ? `Hook branché dans ${CODEX_HOOKS} (Codex : fais-lui confiance une fois avec /hooks)`
      : `Hook débranché de ${CODEX_HOOKS}`);
  }
}
