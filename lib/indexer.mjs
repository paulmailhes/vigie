// Indexe les transcripts de Claude Code (~/.claude/projects) : conversations, sous-agents, workflows,
// tests, fichiers écrits, artefacts publiés, tâches, chapitres, MCP, tokens. Lecture incrémentale : chaque
// fichier est lu une fois, puis seulement ce qui s'y ajoute. Les conversations des 7 derniers jours hors
// fenêtre ne sont lues que pour l'usage (poids, MCP), sans rien décoder d'autre.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// VIGIE_CLAUDE_DIR permet aux tests de lire ailleurs que dans le vrai ~/.claude.
export const CLAUDE_DIR = process.env.VIGIE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

const CHUNK = 4 * 1024 * 1024;
const READ_BUF = Buffer.allocUnsafe(CHUNK);
// Fichiers d'agents et de workflows au repos depuis 10 min : revus une fois par minute seulement. Une conversation
// garde des centaines de transcriptions d'agents finis (2026-10-26 : 3 300 stat toutes les 4 s). Le fil principal
// d'une conversation, lui, est revu à chaque tour.
const QUIET_MS = 10 * 60_000, QUIET_RECHECK_MS = 60_000;
// Lecture par tranches de 16 Mo, en rendant la main entre deux (readAll) : un transcript de 700 Mo ne bloque plus le
// moteur d'un seul tenant (au démarrage, il relit tout).
const CHUNKS_PER_CALL = 4;
const HEAD = 700;                 // octets lus en tête de ligne pour la trier sans la décoder
const HOUR = 3600_000;
const MAX_USAGE_IDS = 4000;
const MINUTE = 60_000;
const SERIES_MIN = 24 * 60;      // usage minute par minute : 24 h gardées (graphique, débit, alerte)
const MAX_ACTIVITY = 600;
const MAX_TESTS = 2000;
const MAX_LIMITS = 50;
const MAX_TOOL_USES = 5000;
const MAX_CHAPTERS = 400;
const RUNNING_MS = 3 * 60_000;    // un agent qui a écrit il y a moins de 3 min est « en cours »
const LIVE_RUN_MS = 12 * HOUR;    // au-delà, une tâche de fond sans nouvelles n'est plus « en cours »
// Lignes qu'on ne lit jamais (énormes et inutiles ici).
const SKIP_TYPES = new Set(['api-request-blob', 'api-request', 'api-request-shape', 'frame-link',
  'queue-operation', 'file-history-snapshot', 'file-history-delta', 'mode', 'bridge-session', 'atis-latch',
  'history-suppression', 'artifact-comment-monitor', 'artifact-autoreact-ledger', 'cost-state', 'summary', 'system']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Outils qui publient un document claude.ai : leurs liens comptent comme artefacts, pas les autres.
const PUBLISH_TOOLS = /^mcp__claude_ai_Claude_Docs__(create|batch)$/;

const pad = (n) => String(n).padStart(2, '0');
// AAAA-MM-JJ en heure locale (sans Intl, appelé des millions de fois)
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const usageNums = (u) => ({ input: u.input_tokens || 0, output: u.output_tokens || 0,
  cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
const addTo = (a, n, sign = 1) => {
  if (!a) return;
  a.input += sign * n.input; a.output += sign * n.output; a.cacheRead += sign * n.cacheRead; a.cacheWrite += sign * n.cacheWrite;
};
// Poids d'usage : ce que coûte un message pour la limite d'un compte (sortie ×5, cache relu ×0,1).
export const weightOf = (n) => n.input + 5 * n.output + 1.25 * n.cacheWrite + 0.1 * n.cacheRead;
const tsMax = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

// ---------- classement des commandes et des fichiers ----------

// Découpe une commande shell en commandes simples, sans heredocs ni chaînes entre guillemets, préfixes ôtés
// (cd x &&, VAR=1, npx, timeout…). Sert à reconnaître un vrai lancement de tests, un commit ou un push.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|\)|$)/g;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g;
const PREFIXES = [/^[({!]\s*/, /^(do|then|else|time|exec|nohup|command|builtin)\s+/, /^timeout\s+\S+\s+/,
  /^env(\s+-\S+)*\s+/, /^[A-Za-z_]\w*=(''|""|\S*)\s+/, /^(npx|bunx|pnpx)(\s+-{1,2}[\w-]+)*\s+/,
  /^(pnpm|yarn|npm)\s+(exec|dlx)(\s+-{1,2}[\w-]+)*\s+/, /^(\S*\/)?node_modules\/\.bin\//, /^(uv|poetry|pipenv)\s+run\s+/,
  /^python3?\s+-m\s+/];
export function segments(command) {
  let c = String(command || '');
  if (c.length > 20_000) c = c.slice(0, 20_000);
  c = c.replace(HEREDOC, ' ').replace(QUOTED, '""');
  const out = [];
  for (let seg of c.split(/&&|\|\||[;|\n`]|\$\(/)) {
    seg = seg.trim();
    for (let prev = null; seg !== prev;) { prev = seg; for (const re of PREFIXES) seg = seg.replace(re, ''); }
    if (seg) out.push(seg);
  }
  return out;
}

const PM = '(npm|pnpm|yarn|bun)';
const TEST_KINDS = [
  ['e2e', [/^(playwright\s+test|cypress\s+run)\b/, new RegExp(`^${PM}\\s+(run\\s+)?(e2e|test:e2e)\\b`)]],
  ['tests', [/^(vitest|jest|mocha|pytest|py\.test|ava|unittest|phpunit|rspec|pg_prove)\b/, /^node\b.*\s--test(\s|=|$)/,
    new RegExp(`^${PM}\\s+(run\\s+)?test\\b`), /^(bun|deno|cargo|go|swift|supabase)\s+test\b/, /^xcodebuild\b.*\stest\b/]],
  ['types', [/^(tsc|vue-tsc|svelte-check|mypy|pyright)\b/, new RegExp(`^${PM}\\s+run\\s+(typecheck|type-check|types|check-types|tsc)\\b`)]],
  ['lint', [/^(eslint|oxlint|stylelint|swiftlint)\b/, /^biome\s+(check|lint)\b/, /^ruff\s+check\b/, /^prettier\b.*\s--check\b/,
    new RegExp(`^${PM}\\s+run\\s+lint\\b`)]],
  ['build', [new RegExp(`^${PM}\\s+run\\s+build\\b`), /^(vite|next|astro)\s+build\b/, /^xcodebuild\b/, /^(swift|cargo)\s+build\b/]],
];
// Sorte de vérification lancée par une commande (tests | e2e | types | lint | build), ou null.
export function testKind(command, segs = null) {
  if (!command) return null;
  const sg = segs || segments(command);
  for (const [k, res] of TEST_KINDS) if (sg.some((x) => res.some((re) => re.test(x)))) return k;
  return null;
}
const GIT = '^git\\b(\\s+-[Cc]\\s+\\S+)*\\s+';
const GIT_COMMIT = new RegExp(`${GIT}commit\\b`), GIT_PUSH = new RegExp(`${GIT}push\\b`);
export const isCommit = (command) => segments(command).some((x) => GIT_COMMIT.test(x));

// Type d'icône d'une action : command | commit | push | file | web | mcp | agent | question | other.
export function actionKind(name, input) {
  const i = input || {};
  if (name === 'Bash' || name === 'PowerShell') {
    const sg = segments(i.command);
    if (sg.some((x) => GIT_PUSH.test(x))) return 'push';
    if (sg.some((x) => GIT_COMMIT.test(x))) return 'commit';
    return 'command';
  }
  if (FILE_TOOLS.has(name) || name === 'Read' || name === 'Grep' || name === 'Glob') return 'file';
  if (name === 'WebFetch' || name === 'WebSearch' || name === 'Artifact') return 'web';
  if (name?.startsWith('mcp__')) return 'mcp';
  if (['Agent', 'Task', 'Workflow', 'SendMessage', 'TaskStop', 'TaskOutput'].includes(name)) return 'agent';
  if (name === 'AskUserQuestion' || name === 'ExitPlanMode') return 'question';
  return 'other';
}

// Nom du serveur d'un outil MCP : entre le premier et le second « __ » (claude_ai_* = connecteurs de compte).
export function mcpServer(toolName) {
  if (!toolName?.startsWith('mcp__')) return null;
  const i = toolName.indexOf('__', 5);
  return i > 5 ? toolName.slice(5, i) : null;
}

// Nombres bornés et ancrés (?<!\d) : une longue suite de chiffres dans une sortie ne fait plus tourner la recherche
// en boucle (30 000 chiffres bloquaient le moteur 1,6 s, à chaque relecture). Seule la fin de la sortie compte.
function parseTestOutput(text) {
  const t = String(text || '').slice(-20_000);
  const num = (re) => { let m, n = 0, any = false; const g = new RegExp(re, 'gi'); while ((m = g.exec(t))) { n = Math.max(n, Number(m[1])); any = true; } return any ? n : null; };
  const passed = num('ℹ pass (\\d{1,9})') ?? num('(?<!\\d)(\\d{1,9}) (?:tests? )?passed') ?? num('(?<!\\d)(\\d{1,9}) passing');
  const failed = num('ℹ fail (\\d{1,9})') ?? num('(?<!\\d)(\\d{1,9}) (?:tests? )?failed') ?? num('(?<!\\d)(\\d{1,9}) failing');
  const line = t.split('\n').map((l) => l.trim()).find((l) => /(passed|failed|passing|failing|ℹ (pass|fail)|error TS\d+|✓|✗|×|Tests?:|Test Files)/i.test(l));
  return { passed, failed, line: line ? maskSecrets(line).slice(0, 200) : null, tsErrors: (t.match(/error TS\d+/g) || []).length };
}
// Marques d'échec qu'un bilan chiffré peut cacher (vitest « × », node:test « ✖ », xcodebuild…). Le « ✖ » d'ESLint
// sans erreur (« ✖ 1 problem (0 errors, 1 warning) ») n'en est pas un.
// Échec voulu : l'étape « rouge » du TDD (« write the test and watch it fail », « Run test to verify it fails »,
// « expecting failures », « (expect failures) », « confirm they fail », « Write the failing tabs test », « (expected
// red) »). Montré, mais pas compté comme un échec. Une phrase de diagnostic (« check if it fails », « expect no
// failures », « verify it fails gracefully ») n'en est pas une. « RED » seulement en capitales : le mot « red »
// d'une phrase ordinaire (« fix the red tests ») n'en fait pas un échec voulu.
const NOT_SUBJECT = String.raw`(?!(?:whether|if|why|what|which|where|how|when|no|nothing|none)\b)`;
const EXPECTED_FAIL = new RegExp([
  String.raw`\bwatch(es|ing)?\s+(?:\S+\s+){0,4}?fail(s|ing)?\b`,
  String.raw`\bsee\s+(?:${NOT_SUBJECT}\S+\s+){0,3}?fail(s|ing)?\b`,
  String.raw`\bshould\s+fail`,
  String.raw`\bexpect(ed|ing|s)?\s+(it\s+|them\s+)?to\s+fail`,
  String.raw`\bexpect(ed|ing|s)?\s+(?:(?!(?:no|zero|0|without)\b)\S+\s+){0,3}?(fail(ure|ures|ing|s)?|red)\b`,
  String.raw`\b(confirm|verify|check|ensure|make\s+sure)(s|ing|ed)?\s+(?:that\s+)?(?:${NOT_SUBJECT}\S+\s+){1,3}?(still\s+)?fails?\b(?!\s+(gracefully|safely|closed|open|fast|silently|cleanly))`,
  String.raw`\b(writ(e|es|ing)|add(s|ing)?|creat(e|es|ing))\s+(the\s+|a\s+|some\s+|new\s+)?failing\b`,
  String.raw`\bfails?\s+first`, String.raw`\bred\s+(step|phase|run)`,
  // (\b de JavaScript ne connaît pas les lettres accentuées : « (?<!…) » à la place devant « é ».)
  String.raw`\bvoir\s+échouer`, String.raw`\bdoi(t|vent)\s+échouer`, String.raw`(?<![A-Za-zÀ-ÿ])échoue(nt)?\s+d'abord`, String.raw`(?<![A-Za-zÀ-ÿ])(?<!aucun\s)(?<!sans\s)(?<!pas\sd')échecs?\s+attendus?`,
  String.raw`\bvérifier\s+(l'échec|qu'(il|elle)s?\s+échouen?t?)`, String.raw`\brouge\s+(attendu|voulu)`, String.raw`\b(attendu|voulu)\s+rouge`,
].join('|'), 'i');
const RED_WORD = /\bRED\b/;
export const isExpectedFail = (description) => { const d = String(description || ''); return EXPECTED_FAIL.test(d) || RED_WORD.test(d); };
const FAIL_MARK = /^\s*(✖(?! \d+ problems? \(0 errors?,)|×|✘|not ok\b|FAIL\s)|AssertionError|Failed Tests \d+|# fail [1-9]|\*\* (TEST|BUILD) FAILED \*\*|npm ERR!/m;

const EXT_KINDS = {
  code: 'ts tsx js jsx mjs cjs py swift go rs rb php java kt c h cpp m sql sh zsh bash liquid vue svelte astro lua',
  style: 'css scss sass less',
  page: 'html htm',
  doc: 'md mdx txt pdf docx rtf',
  data: 'json jsonl csv tsv yaml yml toml xml ndjson',
  image: 'png jpg jpeg webp gif svg ico avif heic',
  media: 'mp4 mov webm mp3 wav',
  config: 'env plist gitignore lock conf ini',
};
const EXT_TO_KIND = Object.fromEntries(Object.entries(EXT_KINDS).flatMap(([k, v]) => v.split(' ').map((e) => [e, k])));
export function fileKind(p) {
  const base = path.basename(p);
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return { ext: ext || base, kind: EXT_TO_KIND[ext] || (base.startsWith('.') ? 'config' : 'other') };
}

// Racine du projet d'une conversation : le dépôt git qui contient son dossier (une conversation ouverte dans
// portail/front écrit aussi à la racine et dans les worktrees de portail/.claude), sinon le dossier lui-même.
const roots = new Map();
export function projectRoot(cwd) {
  if (!cwd) return null;
  if (roots.has(cwd)) return roots.get(cwd);
  const home = os.homedir();
  let root = cwd;
  for (let d = cwd; d && d !== path.dirname(d) && d !== home; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
  }
  roots.set(cwd, root);
  return root;
}

// Où est un fichier : dans le projet de la conversation, dans un brouillon (dossiers temporaires, ~/.claude)
// ou ailleurs sur le Mac.
const SCRATCH = /^\/(private\/)?(tmp|var\/folders)\//;
export function fileLocation(p, cwd, root = projectRoot(cwd)) {
  const f = String(p || '');
  if (f.startsWith(CLAUDE_DIR + path.sep)) return 'scratch'; // plans, brouillons de Claude
  const r = root || cwd;
  if (r && r !== path.sep && (f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) return 'project';
  if (SCRATCH.test(f) || f.startsWith(os.tmpdir() + path.sep)) return 'scratch';
  return 'elsewhere';
}

// ---------- secrets ----------

// Masque ce qui ressemble à un secret dans une commande ou un message (variable *KEY/TOKEN/SECRET…=,
// en-tête Authorization, --token, clés sk-/ghp_/xox…/JWT/AKIA, mot de passe dans une URL, ?token=).
// Vigie ne doit jamais afficher un secret, même tapé en clair dans une commande.
const SECRET_RULES = [
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|BEARER)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=••••'],
  [/\b(authorization|x-api-key|api-key|apikey)(["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+)?[^\s"',;]+/gi, '$1$2$3••••'],
  [/(--?(?:token|password|passwd|api-key|apikey|secret|key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1••••'],
  [/\b(sk-[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16})/g, '••••'],
  [/(https?:\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1••••@'],
  [/([?&](?:token|key|api_key|apikey|access_token|secret|sig|signature|password)=)[^&\s"']+/gi, '$1••••'],
];
export function maskSecrets(text) {
  let t = String(text ?? '');
  for (const [re, by] of SECRET_RULES) t = t.replace(re, by);
  return t;
}

// ---------- libellés lisibles pour l'activité ----------

function short(s, n = 160) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
// Coupe sans écraser les retours à la ligne (résultats de workflow, journaux, comptes rendus).
const clip = (s, n) => (s = String(s ?? ''), s.length > n ? s.slice(0, n - 1) + '…' : s);

function label(name, input) {
  const i = input || {};
  const b = (p) => path.basename(String(p || ''));
  switch (name) {
    case 'Bash': return i.description ? short(i.description, 120) : short(maskSecrets(i.command), 120);
    case 'Write': return `Écrit ${b(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Modifie ${b(i.file_path)}`;
    case 'NotebookEdit': return `Modifie ${b(i.notebook_path)}`;
    case 'Read': return `Lit ${b(i.file_path)}`;
    case 'Grep': return `Cherche « ${short(i.pattern, 60)} »`;
    case 'Glob': return `Liste ${short(i.pattern, 60)}`;
    case 'Agent': case 'Task': return `Lance l'agent « ${short(i.description, 80)} »${i.run_in_background ? ' (en fond)' : ''}`;
    case 'Workflow': return `Lance un workflow${i.name ? ` « ${i.name} »` : ''}`;
    case 'Artifact': return `Artefact : ${i.action || 'publish'}${i.file_path ? ` ${b(i.file_path)}` : ''}`;
    case 'WebFetch': return `Ouvre ${short(maskSecrets(i.url), 80)}`;
    case 'WebSearch': return `Recherche web « ${short(i.query, 80)} »`;
    case 'AskUserQuestion': return `Te pose une question : ${short(i.questions?.[0]?.question, 100)}`;
    case 'TodoWrite': return 'Met à jour sa liste de tâches';
    case 'TaskCreate': return `Ajoute une tâche : ${short(i.subject, 80)}`;
    case 'TaskUpdate': return 'Met à jour une tâche';
    case 'Skill': return `Charge la compétence ${i.skill || ''}`;
    case 'SendMessage': return `Écrit à ${short(i.to, 40)}`;
    default:
      if (name?.startsWith('mcp__')) { const srv = mcpServer(name) || ''; return `${srv.replace(/^claude_ai_/, '')} · ${name.slice(7 + srv.length)}`; }
      return name;
  }
}

// Le détail d'une action : la commande, le fichier, l'adresse… (jamais le contenu écrit).
// Jalons d'une commande : le message d'un commit, un déploiement, une demande de fusion.
const DEPLOY_RE = /\b(?:vercel\s+(?:deploy|--prod)\b|netlify\s+deploy\b|wrangler\s+(?:pages\s+)?deploy\b|fly(?:ctl)?\s+deploy\b|firebase\s+deploy\b|railway\s+up\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b|supabase\s+(?:db\s+push|functions\s+deploy)\b)/;
const PR_RE = /\bgh\s+pr\s+(?:create|merge)\b/;
export function commitMessage(cmd) {
  const c = String(cmd || '');
  if (!/\bgit\b[^\n]*\bcommit\b/.test(c)) return null;
  const first = (t) => String(t).split('\n').map((l) => l.trim()).find(Boolean) || null;
  const h = /<<\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/.exec(c);
  if (h) return first(h[2]);
  const m = /\scommit\b[^\n]*?(?:\s-[a-zA-Z]*m|\s--message)[= ]?\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(c);
  return m ? first((m[1] ?? m[2]).replace(/\\(["\\$`])/g, '$1')) : null;
}
function milestoneOf(name, i) {
  if (name !== 'Bash') return null;
  const c = String(i.command || '');
  if (DEPLOY_RE.test(c)) return 'deploy';
  if (PR_RE.test(c)) return 'pr';
  return null;
}

function actDetail(name, i) {
  if (name === 'Bash') return short(maskSecrets(i.command), 300);
  if (FILE_TOOLS.has(name) || name === 'Read') return i.file_path || i.notebook_path || null;
  if (name === 'WebFetch') return short(maskSecrets(i.url), 200);
  if (name === 'WebSearch') return short(i.query, 200);
  if (name === 'Grep' || name === 'Glob') return short(i.path || i.pattern, 200);
  if (name === 'Agent' || name === 'Task') return i.subagent_type || null;
  if (name === 'AskUserQuestion') return short((i.questions?.[0]?.options || []).map((o) => o.label).join(' / '), 200) || null;
  return null;
}

function slimInput(name, input) {
  const i = input || {};
  if (name === 'Bash') return { command: short(maskSecrets(i.command), 3000), description: i.description, background: !!i.run_in_background };
  if (FILE_TOOLS.has(name) || name === 'Read') return { file_path: i.file_path || i.notebook_path };
  if (name === 'Agent' || name === 'Task') return { description: i.description, subagent_type: i.subagent_type, background: !!i.run_in_background };
  if (name === 'Artifact') return { action: i.action || 'publish', file_path: i.file_path, url: i.url, description: i.description };
  if (PUBLISH_TOOLS.test(name)) return { title: short(i.container?.create?.name || i.title || i.name, 120) || null };
  if (name === 'TaskCreate') return { subject: short(i.subject, 200) };
  return null;
}

// Retire les balises techniques (<pasted_content id=…>, <command-message>…) d'un message de l'utilisateur.
function cleanPrompt(t) { return maskSecrets(t || '').replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, ' ').replace(/\s+/g, ' ').trim(); }
// Texte d'un compte rendu de Claude : sans balises ni gras, retours à la ligne gardés.
function cleanText(t, n) {
  const s = maskSecrets(t || '').replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, '').replace(/\*\*|__/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clip(s, n);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  return '';
}

// Le texte d'un vrai message de l'utilisateur, ou null (commande sans demande, interruption, balise technique).
function promptText(text, human) {
  const t = String(text || '').replace(/<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g, '').trim();
  if (!t || t.startsWith('[Request interrupted')) return null;
  if (/^<command-(name|message)>/.test(t)) {
    const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)?.[1];
    const args = cleanPrompt(/<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]);
    return name && args ? `${name} ${args}` : null; // /clear, /model… n'ouvrent pas de chapitre
  }
  if (t.startsWith('<') && !human && !t.startsWith('<pasted')) return null; // sorties de commandes locales
  return cleanPrompt(t) || null;
}

const TODO_STATUS = { completed: 'done', in_progress: 'doing', pending: 'todo' };

// ---------- plans en étapes ----------
// Le plan suivi par une conversation : le plus récent fichier .md de plan qu'elle (ou un de ses agents) a écrit,
// modifié ou lu, par un outil de fichier, une commande (sed, awk, cat…) ou une compétence (« Plan : docs/…md »),
// ou désigné par le registre d'exécution qu'elle tient (.superpowers/sdd/<plan>/progress.md, « Task L2.19: complete »).

const PLAN_REFS = 40;                 // références de plans gardées par conversation (les plus récentes)
const PLAN_CHECK_MS = 5000;           // un plan déjà choisi n'est revérifié (dates des fichiers) qu'au bout de 5 s
const SDD_LIST_MS = 30_000;           // liste des registres d'un dépôt relue au plus toutes les 30 s
const MAX_PLAN_BYTES = 5 * 1024 * 1024;
const MAX_PLAN_STEPS = 400;
const MAX_PLAN_CACHE = 40;
// Un plan resté intact (fichier et registres) plus de 3 jours avant le début de la conversation n'est pas
// celui qu'elle suit : un vieux plan relu en passant (« ÉTAT AU 13 AOÛT », 2026-10-20).
const PLAN_STALE_MS = 3 * 86_400_000;
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');

// Racine du projet d'une conversation : le dossier qui contient .git en remontant depuis son dossier (sans
// dépasser le dossier personnel), sinon son dossier. Un plan rangé ailleurs appartient à un autre projet.
const rootCache = new Map();
export function projectRootOf(cwd) {
  if (!cwd) return null;
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  const home = os.homedir();
  let root = cwd;
  for (let d = cwd; d && d !== home && d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
  }
  if (rootCache.size > 500) rootCache.clear();
  rootCache.set(cwd, root);
  return root;
}
const inside = (file, dir) => !!dir && (file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));

// Un .md rangé dans un dossier plans/ (ou plan/), ou dont le nom parle de plan (plan.md, plan-v6.md, PLAN.md,
// relecture-du-plan.md) ; ni « explanation.md » ni « planning.md ». Les fichiers des registres n'en sont pas.
export function isPlanFile(p) {
  const f = String(p || '');
  if (!/\.md$/i.test(f) || f.includes('/.superpowers/sdd/') || f.includes('/node_modules/')) return false;
  if (/(^|\/)plans?\//i.test(f)) return true;
  return /(^|[_.\s-])plans?([_.\s-]|$)/i.test(path.basename(f).slice(0, -3));
}

const MD_TOKEN = /(?:^|[\s'"`=(<>|;&:])((?:~\/|\.{0,2}\/)?[\w@%+~.\/-]+\.md)(?![\w\/-])/gi;
const SDD_TOKEN = /(?:^|[\s'"`=(<>|;&:])((?:~\/|\.{0,2}\/)?(?:[\w@%+~.\/-]*\/)?\.superpowers\/sdd\/[\w@%+.-]+)/g;
const CD_TOKEN = /(?:^|[;&|(\n{]\s*)cd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|)]+)/g;
// Dossier du registre d'un fichier rangé dedans (…/.superpowers/sdd/<nom>/…), ou null.
function ledgerDirOf(p) {
  const i = String(p || '').indexOf('/.superpowers/sdd/');
  if (i === -1) return null;
  const rest = p.slice(i + 18);
  const name = rest.split('/')[0];
  return name ? p.slice(0, i + 18) + name : null;
}
const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
// Un chemin cité dans une commande : absolu tel quel, relatif résolu contre le premier dossier où il existe.
function resolveCited(p, bases) {
  const f = expandHome(p);
  if (path.isAbsolute(f)) return path.normalize(f);
  for (const b of bases) {
    if (!b) continue;
    const full = path.resolve(b, f);
    try { if (fs.existsSync(full)) return full; } catch { /* ignore */ }
  }
  return null;
}

// Les premiers octets d'un fichier (en-tête d'un registre), '' s'il est illisible.
function readHead(file, n = 2000) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(n);
    return b.toString('utf8', 0, fs.readSync(fd, b, 0, n, 0));
  } catch { return ''; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// Titre d'étape : « Tâche L2.24 : … », « ### Task 2b: … », « ## Lot 6 », « Phase 1 — … », « C217 : … », « J1 — … ».
const STEP_WORDS = new Set(['tâche', 'tache', 'task', 'étape', 'etape', 'step', 'lot', 'phase', 'partie', 'chantier', 'jalon',
  'milestone', 'vague', 'sprint', 'itération', 'iteration', 'livraison', 'jour', 'day', 'stage', 'part', 'chapitre', 'module']);
const ID = String.raw`[A-Za-z]{0,3}\d+[a-z]?(?:\.\d+[a-z]?)*`;
const SEP = String.raw`(?=$|[\s:.·—–,)-])\s*[:.·—–,)-]*\s*`;
const WORD_STEP = new RegExp(String.raw`^(\p{L}+)\s+(${ID}|[A-Z])${SEP}(.*)$`, 'u');
const BARE_STEP = new RegExp(String.raw`^([A-Z]{1,3}\d+[a-z]?(?:\.\d+[a-z]?)*)${SEP}(.*)$`, 'u');
const ID_ONLY = new RegExp(String.raw`^(?:${ID}|[A-Z])$`);
const STEP_TOKEN = new RegExp(String.raw`(?<![A-Za-z0-9.])${ID}`, 'g'); // une étape citée dans un nom d'agent
// Marques d'étape faite ou en cours dans un titre : « (faite le 19/10) », « — FAIT le 8 août », ✅, ~~barré~~.
// (Après une lettre accentuée, \b ne marche pas en JavaScript : « (?=…) » à la place.)
const DONE_MARK = /✅|☑|✔|✓|\[[xX]\]|~~.+~~|\((?:fait|faite|faites|terminée?s?|done|completed?|livrée?s?)(?=\s*[,;)]|\s+(?:le|on)\b)[^)]*\)|[—–-]\s*(?:FAIT|FAITE|DONE|TERMINÉE?)(?=$|[\s,;.)])|[—–-]\s*(?:fait|faite|terminée?|done)(?:\s+le\b|\s*$)/;
const DOING_MARK = /🚧|⏳|\((?:en cours|in progress|wip)\)|[—–-]\s*en cours\b/i;
const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOX_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX✓✔])\]\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

// Texte d'un titre ou d'une case : sans liens, gras ni code, et sans secret (un plan reste un fichier de l'utilisateur).
function cleanMd(t) {
  return maskSecrets(String(t || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '')).replace(/\s+/g, ' ').trim();
}

function stepOf(heading) {
  const t = cleanMd(heading).replace(/^[*_]+|[*_]+$/g, '');
  const w = WORD_STEP.exec(t);
  if (w && STEP_WORDS.has(w[1].toLowerCase())) return { id: w[2], title: w[3] };
  const b = BARE_STEP.exec(t);
  return b ? { id: b[1], title: b[2] } : null;
}

// Analyse d'un plan en Markdown : titre, étapes (titres d'étape au niveau le plus fourni, sinon cases à cocher
// de premier niveau), groupe de chaque étape (titre de niveau supérieur le plus proche), état d'après les cases
// de sa section (- [ ] / - [x]) et les marques de son titre. Les blocs de code sont ignorés.
export function parsePlan(text) {
  const lines = String(text || '').split(/\r?\n/);
  const heads = [], boxes = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    let m = HEADING_LINE.exec(l);
    if (m) { heads.push({ level: m[1].length, text: cleanMd(m[2]), raw: m[2], line: i, step: stepOf(m[2]) }); continue; }
    m = BOX_LINE.exec(l);
    if (m) boxes.push({ line: i, indent: m[1].replace(/\t/g, '    ').length, checked: m[2] !== ' ', text: m[3] });
  }
  const titleIdx = heads.findIndex((h) => h.level === 1);
  const title = titleIdx >= 0 ? short(heads[titleIdx].text, 120) : null;
  // Groupe : le titre de niveau supérieur le plus proche avant la ligne (hors titre du document).
  const groupAt = (line, below) => {
    for (let k = heads.length - 1; k >= 0; k--) {
      const h = heads[k];
      if (h.line >= line || k === titleIdx || h.level >= below) continue;
      return short(h.text, 100) || null;
    }
    return null;
  };
  const steps = [];
  const byLevel = new Map();
  for (const h of heads) if (h.step) byLevel.set(h.level, (byLevel.get(h.level) || 0) + 1);
  if (byLevel.size) {
    let level = 0, best = 0;
    for (const [lv, n] of byLevel) if (n > best || (n === best && lv > level)) { level = lv; best = n; }
    let b = 0;
    for (let k = 0; k < heads.length; k++) {
      const h = heads[k];
      if (h.level !== level || !h.step) continue;
      let end = lines.length;
      for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= level) { end = heads[j].line; break; }
      let total = 0, done = 0;
      while (b < boxes.length && boxes[b].line < h.line) b++;
      for (let j = b; j < boxes.length && boxes[j].line < end; j++) { total++; if (boxes[j].checked) done++; }
      const status = DONE_MARK.test(h.raw) || (total > 0 && done === total) ? 'done'
        : DOING_MARK.test(h.raw) || done > 0 ? 'doing' : 'todo';
      steps.push({ id: h.step.id, text: short(h.step.title.replace(/^[✅☑✔✓\s]+|[✅☑✔✓\s]+$/g, '') || h.text, 140), status, group: groupAt(h.line, level) });
    }
  } else if (boxes.length >= 2) {
    const top = Math.min(...boxes.map((x) => x.indent));
    for (const x of boxes) {
      if (x.indent > top + 1) continue;
      const t = cleanMd(x.text);
      const m = BARE_STEP.exec(t);
      steps.push({ id: m ? m[1] : null, text: short((m && m[2]) || t, 140), status: x.checked ? 'done' : 'todo', group: groupAt(x.line, 7) });
    }
  }
  // Un seul groupe pour toutes les étapes (« Les tâches », « Review Focus ») : il n'apprend rien.
  if (steps.length && steps.every((x) => x.group === steps[0].group)) for (const x of steps) x.group = null;
  return { title, steps };
}

// Registre d'exécution (superpowers, .superpowers/sdd/<plan>/progress.md) : « # SDD ledger — plan: docs/…md »,
// puis des lignes « Task L2.19: complete (…) », « Tasks 5, 6, 9 : complete », « Task 7: implémentée… ».
// Rend le plan déclaré, les étapes finies et la dernière étape citée.
const LEDGER_HEAD = /^#[^\n]*?\bplan\s*:\s*`?([^`\s]+\.md)/im;
const LEDGER_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?Tasks?\s+([^:\n]{1,80}?)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*([\p{L}-]+)/u;
const LEDGER_DONE = new Set(['complete', 'completed', 'done', 'fait', 'faite', 'faites', 'terminé', 'terminée', 'terminées', 'terminés', 'finie', 'finies']);
export function parseLedger(text) {
  const t = String(text || '');
  const complete = new Set();
  let last = null;
  for (const line of t.split(/\r?\n/)) {
    const m = LEDGER_LINE.exec(line);
    if (!m) continue;
    const ids = [];
    // « 11 à 18 », « 11-18 » : toutes les étapes entre les deux (numéros simples seulement).
    const rest = m[1].replace(/\b(\d+)\s*(?:à|-|–|\.\.)\s*(\d+)\b/g, (all, a, z) => {
      if (Number(z) >= Number(a) && Number(z) - Number(a) < 200) for (let k = Number(a); k <= Number(z); k++) ids.push(String(k));
      return ',';
    });
    for (const part of rest.replace(/\s*(?:&|\bet\b|\band\b)\s*/g, ',').split(/\s*,\s*|\s+/)) {
      const id = part.trim().replace(/[.)]+$/, '');
      if (!id) continue;
      if (!ID_ONLY.test(id)) break; // « Task 7 (relecture) » : seuls les numéros en tête comptent
      ids.push(id);
    }
    if (!ids.length) continue;
    if (LEDGER_DONE.has(m[2].toLowerCase())) for (const id of ids) complete.add(id);
    last = ids[ids.length - 1];
  }
  return { plan: LEDGER_HEAD.exec(t.slice(0, 2000))?.[1] || null, complete, last };
}

// ---------- modèle d'une conversation ----------

class Session {
  constructor(id, transcriptPath) {
    this.id = id;
    this.light = false;
    this.transcriptPath = transcriptPath;
    this.dir = transcriptPath.replace(/\.jsonl$/, '');
    this.projectDir = path.basename(path.dirname(transcriptPath));
    this.title = null; this.lastPrompt = null; this.lastUserMessage = null;
    this.cwd = null; this.gitBranch = null; this.firstTs = null; this.lastTs = null;
    this.entrypoint = null;                            // claude-vscode, claude-desktop (app Claude), cli…
    this.org = null;                                   // organisation (compte) en cours, d'après credential_org
    this.usageById = new Map();
    this.total = zero(); this.byDay = new Map(); this.byHour = new Map(); // byHour : heure depuis l'époque
    this.wByHour = new Map();                          // « heure|org » -> poids d'usage
    this.wByMin = new Map(); this.wByMinPruned = 0;    // « minute|org » -> [poids, tokens bruts], 24 h au plus (agents compris)
    this.context = null;                               // { tokens, ts } : taille du contexte de la dernière réponse
    this.toolUses = new Map();
    this.activity = [];
    this.agents = new Map(); this.workflows = new Map(); this.bgTasks = new Map();
    this.tests = []; this.files = new Map(); this.artifacts = new Map();
    this.perms = { toi: 0, auto: 0, regle: 0, refus: 0 };
    this.toolCount = 0;
    this.limits = []; this.limitsTotal = 0;
    this.mcpUses = new Map();                          // serveur -> { count, lastTs, byDay: Map jour -> nombre }
    this.todos = null;                                 // { ts, items: [{ text, status }] } (dernier TodoWrite)
    this.taskList = null;                              // { ts, items: Map id -> { text, status } } (TaskCreate/TaskUpdate)
    this.lastText = null;                              // dernier compte rendu de Claude { text, ts }
    this.liveText = null;                              // dernier message de Claude, même en plein tour { text, ts }
    this.chapters = [];
    this.lastHuman = null;
    this.planRefs = new Map();                         // plan cité (chemin, ou « sdd:<registre> ») -> dernière fois
    this.planRefsVer = 0; this.planChoice = null;      // plan retenu, revérifié toutes les 5 s
    this.shellCwd = null;                              // dossier du terminal de la conversation (dernier cd)
  }
  touch(ts) {
    if (!ts) return;
    if (!this.firstTs || ts < this.firstTs) this.firstTs = ts;
    if (!this.lastTs || ts > this.lastTs) this.lastTs = ts;
  }
  agentLabel(agentId) {
    if (!agentId) return null;
    return this.agents.get(agentId)?.description || agentId;
  }
  // Chapitre (vraie demande de l'utilisateur) en cours à cet instant : le dernier ouvert avant ts.
  chapterAt(ts) {
    const c = this.chapters;
    if (!ts || !c.length || ts < c[0].start) return null;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid].start <= ts) lo = mid; else hi = mid - 1; }
    return c[lo];
  }
}

// Conversation lue pour l'usage seulement (hors fenêtre, moins de 7 jours) : poids et MCP.
class UsageSession {
  constructor(id, transcriptPath) {
    this.id = id;
    this.light = true;
    this.transcriptPath = transcriptPath;
    this.dir = transcriptPath.replace(/\.jsonl$/, '');
    this.projectDir = path.basename(path.dirname(transcriptPath));
    this.org = null; this.cwd = null; this.lastTs = null; this.mtimeMs = 0; this.scannedMtime = -1;
    this.usageById = new Map(); this.wByHour = new Map(); this.mcpUses = new Map();
    this.wByMin = new Map(); this.wByMinPruned = 0;
  }
  static from(s) {
    const l = new UsageSession(s.id, s.transcriptPath);
    // usageById n'est pas repris : ses entrées retiennent les agents, et une conversation au repos n'a plus de message en cours.
    Object.assign(l, { org: s.org, cwd: s.cwd, lastTs: s.lastTs, wByHour: s.wByHour, wByMin: s.wByMin, mcpUses: s.mcpUses });
    return l;
  }
}

function trackUsage(s, id, n, ts, org, agent) {
  const prev = s.usageById.get(id);
  if (prev) { // même message relu (une ligne par bloc) : on remplace
    if (!s.light) { addTo(s.total, prev.n, -1); addTo(s.byDay.get(prev.d), prev.n, -1); addTo(s.byHour.get(prev.h), prev.n, -1); if (prev.a) addTo(prev.a.usage, prev.n, -1); }
    s.wByHour.set(prev.k, (s.wByHour.get(prev.k) || 0) - prev.w);
    const pm = prev.mk ? s.wByMin.get(prev.mk) : null;
    if (pm) { pm[0] -= prev.w; pm[1] -= prev.tok; }
  }
  const t = Date.parse(ts);
  const h = Math.floor(t / HOUR), k = `${h}|${org || ''}`, w = weightOf(n);
  s.wByHour.set(k, (s.wByHour.get(k) || 0) + w);
  // Minute par minute, seulement les dernières 24 h (une relecture complète au démarrage ne garde rien de plus vieux).
  const tok = n.input + n.output + n.cacheRead + n.cacheWrite;
  const mi = Math.floor(t / MINUTE), nowMin = Math.floor(Date.now() / MINUTE);
  let mk = null;
  if (mi > nowMin - SERIES_MIN) {
    mk = `${mi}|${org || ''}`;
    const v = s.wByMin.get(mk);
    if (v) { v[0] += w; v[1] += tok; } else s.wByMin.set(mk, [w, tok]);
    if (s.wByMinPruned < nowMin - 30) pruneMinutes(s, nowMin);
  }
  let d = null;
  if (!s.light) {
    d = dayKey(t);
    if (!s.byDay.has(d)) s.byDay.set(d, zero());
    if (!s.byHour.has(h)) s.byHour.set(h, zero());
    addTo(s.total, n); addTo(s.byDay.get(d), n); addTo(s.byHour.get(h), n);
    if (agent) addTo(agent.usage, n);
  }
  s.usageById.set(id, { n, d, h, k, w, a: agent || null, mk, tok });
  if (s.usageById.size > MAX_USAGE_IDS) {
    let i = 0;
    for (const key of s.usageById.keys()) { s.usageById.delete(key); if (++i >= 1000) break; }
  }
}

function pruneMinutes(s, nowMin) {
  s.wByMinPruned = nowMin;
  for (const k of s.wByMin.keys()) if (Number(k.slice(0, k.indexOf('|'))) <= nowMin - SERIES_MIN) s.wByMin.delete(k);
}

function countMcp(s, name, ts) {
  const srv = mcpServer(name);
  if (!srv) return;
  let m = s.mcpUses.get(srv);
  if (!m) { m = { count: 0, lastTs: null, byDay: new Map() }; s.mcpUses.set(srv, m); }
  m.count++;
  if (ts) {
    m.lastTs = tsMax(m.lastTs, ts);
    const d = dayKey(Date.parse(ts));
    m.byDay.set(d, (m.byDay.get(d) || 0) + 1);
  }
}

// Lecture rapide d'une ligne assistant sans la décoder (mode usage seulement).
const RE_INPUT = /"input_tokens":(\d+)/, RE_OUTPUT = /"output_tokens":(\d+)/;
const RE_CREAD = /"cache_read_input_tokens":(\d+)/, RE_CWRITE = /"cache_creation_input_tokens":(\d+)/;
const RE_MSG_ID = /"id":"(msg_[^"]+)"/, RE_MCP_USE = /"type":"tool_use","id":"[^"]+","name":"(mcp__[^"]+)"/;
const RE_ORG = /"organizationUuid":"([0-9a-fA-F-]{36})"/;
const numIn = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : 0; };
function topTimestamp(line, type) {
  let i = line.lastIndexOf(`"type":"${type}","uuid":"`);
  if (i !== -1) i = line.indexOf('"timestamp":"', i);
  if (i === -1) i = line.lastIndexOf('"timestamp":"');
  if (i === -1) return null;
  const ts = line.toString('latin1', i + 13, i + 13 + 40);
  return ts.slice(0, ts.indexOf('"'));
}

export class Indexer {
  constructor({ windowHours = 48, usageDays = 7, projectsDir = PROJECTS_DIR, sessionsDir = SESSIONS_DIR } = {}) {
    this.windowMs = windowHours * HOUR;
    this.usageMs = Math.max(usageDays * 24 * HOUR, this.windowMs);
    this.projectsDir = projectsDir;
    this.sessionsDir = sessionsDir;
    this.sessions = new Map();     // sessionId -> Session (lue entièrement)
    this.light = new Map();        // sessionId -> UsageSession (usage seulement)
    this.files = new Map();        // chemin jsonl -> { offset, carry, skip, ino, org }
    this.metas = new Map();        // chemin meta.json -> mtimeMs
    this.seen = new Map();         // chemin -> { mtimeMs, at } : dernier stat des fichiers d'agents et méta
    this.live = new Map();         // sessionId -> entrée de ~/.claude/sessions
    this.transcripts = new Map();  // sessionId -> chemin du transcript principal
    this.lastDiscovery = 0;
    this.progress = { done: false, bytes: 0, files: 0, startedAt: Date.now(), durationMs: null };
    this.busy = false;
    this.planCache = new Map();    // fichier de plan -> analyse (tant que sa date ne change pas)
    this.ledgerCache = new Map();  // progress.md d'un registre -> analyse
    this.sddCache = new Map();     // dossier -> registres de <dossier>/.superpowers/sdd (relus toutes les 30 s)
    this.planRefSeq = 0;
  }

  // Conversations ouvertes en ce moment (le registre que Claude Code tient lui-même).
  readLive() {
    const live = new Map();
    let names = [];
    try { names = fs.readdirSync(this.sessionsDir); } catch { /* ignore */ }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf8'));
        try { process.kill(s.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
        live.set(s.sessionId, s);
      } catch { /* fichier en cours d'écriture */ }
    }
    this.live = live;
  }

  discover() {
    const now = Date.now();
    let dirs = [];
    try { dirs = fs.readdirSync(this.projectsDir); } catch { return; }
    for (const d of dirs) {
      const full = path.join(this.projectsDir, d);
      let names;
      try { names = fs.readdirSync(full); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const sid = n.slice(0, -6);
        const p = path.join(full, n);
        this.transcripts.set(sid, p);
        if (this.sessions.has(sid)) continue;
        let st; try { st = fs.statSync(p); } catch { continue; }
        const age = now - st.mtimeMs;
        if (this.live.has(sid) || age < this.windowMs) this.promote(sid, p);
        else if (age < this.usageMs) {
          let l = this.light.get(sid);
          if (!l) { l = new UsageSession(sid, p); this.light.set(sid, l); }
          l.mtimeMs = st.mtimeMs;
        }
      }
    }
    for (const sid of this.live.keys()) {
      if (!this.sessions.has(sid) && this.transcripts.has(sid)) this.promote(sid, this.transcripts.get(sid));
    }
    // Hors fenêtre : la conversation ne garde que son usage (pour les 7 jours), puis disparaît.
    for (const [sid, s] of this.sessions) {
      if (this.live.has(sid)) continue;
      let mt = 0; try { mt = fs.statSync(s.transcriptPath).mtimeMs; } catch { /* supprimé */ }
      let last = Math.max(Date.parse(s.lastTs || 0) || 0, mt);
      for (const a of s.agents.values()) last = Math.max(last, a.mtimeMs || 0);
      if (now - last <= this.windowMs) continue;
      this.sessions.delete(sid);
      if (now - last < this.usageMs) { const l = UsageSession.from(s); l.mtimeMs = mt; l.scannedMtime = mt; this.light.set(sid, l); }
      else this.forgetFiles(s);
    }
    for (const [sid, l] of this.light) {
      if (now - l.mtimeMs > this.usageMs) { this.light.delete(sid); this.forgetFiles(l); }
    }
    this.lastDiscovery = now;
  }

  // Une conversation à lire entièrement (récente ou ouverte) ; si elle n'était lue que pour l'usage, on repart de zéro.
  promote(sid, p) {
    const l = this.light.get(sid);
    if (l) { this.light.delete(sid); this.forgetFiles(l); }
    this.sessions.set(sid, new Session(sid, p));
  }

  forgetFiles(s) {
    const under = s.dir + path.sep;
    for (const k of [...this.files.keys()]) if (k === s.transcriptPath || k.startsWith(under)) this.files.delete(k);
    for (const k of [...this.metas.keys()]) if (k.startsWith(under)) this.metas.delete(k);
    for (const k of [...this.seen.keys()]) if (k.startsWith(under)) this.seen.delete(k);
  }

  // Un fichier a été réécrit (et pas seulement complété) : on relit toute la conversation au prochain passage.
  rebuild(s) {
    this.forgetFiles(s);
    if (s.light) { const l = new UsageSession(s.id, s.transcriptPath); l.mtimeMs = s.mtimeMs; this.light.set(s.id, l); }
    else this.sessions.set(s.id, new Session(s.id, s.transcriptPath));
  }

  // Tous les fichiers à suivre pour une conversation.
  filesFor(s) {
    const out = [{ file: s.transcriptPath, agentId: null, runId: null }];
    const sub = path.join(s.dir, 'subagents');
    let names = [];
    try { names = fs.readdirSync(sub); } catch { /* pas de sous-agents */ }
    for (const n of names) {
      if (n.endsWith('.meta.json')) this.readMeta(s, path.join(sub, n), n.slice(0, -10).replace(/^agent-/, ''), null);
      else if (n.startsWith('agent-') && n.endsWith('.jsonl')) out.push({ file: path.join(sub, n), agentId: n.slice(6, -6), runId: null });
    }
    const wfAgents = path.join(sub, 'workflows');
    let runs = [];
    try { runs = fs.readdirSync(wfAgents); } catch { /* pas de workflows */ }
    for (const runId of runs) {
      const rd = path.join(wfAgents, runId);
      let rn = [];
      try { rn = fs.readdirSync(rd); } catch { continue; }
      this.ensureWorkflow(s, runId);
      for (const n of rn) {
        if (n.endsWith('.meta.json')) this.readMeta(s, path.join(rd, n), n.slice(0, -10).replace(/^agent-/, ''), runId);
        else if (n.startsWith('agent-') && n.endsWith('.jsonl')) out.push({ file: path.join(rd, n), agentId: n.slice(6, -6), runId });
        else if (n === 'journal.jsonl') out.push({ file: path.join(rd, n), agentId: null, runId, journal: true });
      }
    }
    this.readWorkflowFiles(s);
    return out;
  }

  lightFiles(l) {
    const out = [{ file: l.transcriptPath, agentId: null }];
    const sub = path.join(l.dir, 'subagents');
    let names = [];
    try { names = fs.readdirSync(sub); } catch { return out; }
    for (const n of names) if (n.startsWith('agent-') && n.endsWith('.jsonl')) out.push({ file: path.join(sub, n), agentId: n.slice(6, -6) });
    let runs = [];
    try { runs = fs.readdirSync(path.join(sub, 'workflows')); } catch { return out; }
    for (const runId of runs) {
      let rn = [];
      try { rn = fs.readdirSync(path.join(sub, 'workflows', runId)); } catch { continue; }
      for (const n of rn) if (n.startsWith('agent-') && n.endsWith('.jsonl')) out.push({ file: path.join(sub, 'workflows', runId, n), agentId: n.slice(6, -6) });
    }
    return out;
  }

  // stat d'un fichier secondaire (agent, méta) : celui d'il y a moins d'une minute s'il ne bouge plus depuis 10 min.
  quietStat(p) {
    const t = Date.now();
    const k = this.seen.get(p);
    if (k && t - k.mtimeMs > QUIET_MS && t - k.at < QUIET_RECHECK_MS) return null;
    let st; try { st = fs.statSync(p); } catch { this.seen.delete(p); return undefined; }
    this.seen.set(p, { mtimeMs: st.mtimeMs, at: t });
    return st;
  }

  readMeta(s, p, agentId, runId) {
    const st = this.quietStat(p);
    if (!st) return;
    if (this.metas.get(p) === st.mtimeMs) return;
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      const a = this.ensureAgent(s, agentId, runId);
      a.description = m.description || a.description;
      a.type = m.agentType || a.type;
      a.background = m.requestShape === 'background';
      a.phase = m.workflowPhase || a.phase;
      a.finished = a.finished || !!m.finished; // ne pas effacer une fin déjà connue
      a.toolUseId = m.toolUseId || a.toolUseId;
      this.metas.set(p, st.mtimeMs);
    } catch { /* meta en cours d'écriture */ }
  }

  ensureAgent(s, agentId, runId) {
    let a = s.agents.get(agentId);
    if (!a) {
      a = { id: agentId, description: null, type: null, background: false, phase: null, finished: false, status: null, runId,
        firstTs: null, lastTs: null, mtimeMs: 0, tools: 0, files: 0, tests: 0, usage: zero(), lastAction: null, resultSeen: false };
      s.agents.set(agentId, a);
    }
    if (runId) a.runId = runId;
    return a;
  }

  ensureWorkflow(s, runId) {
    let w = s.workflows.get(runId);
    if (!w) {
      w = { runId, name: null, summary: null, status: 'running', startTs: null, launchTs: null, endTs: null, durationMs: null,
        agentCount: null, totalTokens: null, totalToolCalls: null, phases: [], result: null, logs: [], scriptPath: null,
        taskId: null, jsonStatus: null, jsonTaskId: null };
      s.workflows.set(runId, w);
    }
    return w;
  }

  readWorkflowFiles(s) {
    const wd = path.join(s.dir, 'workflows');
    let names = [];
    try { names = fs.readdirSync(wd); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const p = path.join(wd, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (this.metas.get(p) === st.mtimeMs) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const w = this.ensureWorkflow(s, j.runId || n.slice(0, -5));
        const meta = /description:\s*(["'`])([\s\S]*?)\1/.exec(j.script || '');
        const startTs = j.startTime ? new Date(Number(j.startTime)).toISOString() : (j.timestamp || w.startTs);
        Object.assign(w, {
          name: j.workflowName || w.name,
          summary: j.summary || (meta && meta[2]) || w.summary,
          // Le statut du fichier ne vaut que pour le lancement qu'il décrit (taskId) : une relance le remet à zéro.
          jsonStatus: j.status || null,
          jsonTaskId: j.taskId || null,
          startTs,
          durationMs: j.durationMs ?? w.durationMs,
          agentCount: j.agentCount ?? w.agentCount,
          totalTokens: j.totalTokens ?? w.totalTokens,
          totalToolCalls: j.totalToolCalls ?? w.totalToolCalls,
          phases: (j.phases || []).map((ph) => ph.title),
          result: j.result != null ? clip(maskSecrets(typeof j.result === 'string' ? j.result : JSON.stringify(j.result, null, 1)), 2500) : w.result,
          logs: Array.isArray(j.logs) ? j.logs.slice(-12).map((l) => clip(maskSecrets(l), 300)) : w.logs,
          scriptPath: j.scriptPath || w.scriptPath,
        });
        if (j.status && j.status !== 'running' && startTs && j.durationMs != null && !w.endTs) w.endTs = new Date(Date.parse(startTs) + j.durationMs).toISOString();
        this.metas.set(p, st.mtimeMs);
      } catch { /* en cours d'écriture */ }
    }
  }

  // Lit ce qui s'est ajouté à un fichier depuis la dernière fois. Renvoie -1 si le fichier a été réécrit.
  readIncrement(entry, s, handler) {
    let st;
    if ((entry.agentId || entry.runId) && !s.light) { st = this.quietStat(entry.file); if (!st) return 0; }
    else { try { st = fs.statSync(entry.file); } catch { return 0; } }
    let f = this.files.get(entry.file);
    if (!f) { f = { offset: 0, carry: [], carryLen: 0, skip: false, ino: st.ino, org: null }; this.files.set(entry.file, f); }
    if (entry.agentId && !s.light) { const a = this.ensureAgent(s, entry.agentId, entry.runId); a.mtimeMs = st.mtimeMs; }
    if (f.offset > 0 && (st.ino !== f.ino || st.size < f.offset)) return -1;
    if (st.size === f.offset) return 0;
    entry.f = f;
    const fd = fs.openSync(entry.file, 'r');
    let read = 0;
    try {
      const buf = READ_BUF;
      let chunks = 0;
      while (f.offset < st.size) {
        if (chunks++ === CHUNKS_PER_CALL) { entry.more = true; break; }
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - f.offset), f.offset);
        if (n <= 0) break;
        f.offset += n; read += n;
        const data = buf.subarray(0, n);
        let start = 0, nl;
        while ((nl = data.indexOf(10, start)) !== -1) {
          if (f.skip) f.skip = false; // fin d'une ligne ignorée
          else if (f.carry.length) {
            f.carry.push(data.subarray(start, nl));
            const line = Buffer.concat(f.carry);
            f.carry = []; f.carryLen = 0;
            handler.call(this, line, 0, line.length, s, entry);
          } else handler.call(this, data, start, nl, s, entry);
          start = nl + 1;
        }
        if (start < data.length && !f.skip) {
          // Ligne incomplète : on la garde pour le morceau suivant, sauf si on sait déjà qu'on l'ignorera.
          const piece = data.subarray(start);
          const have = f.carryLen;
          if (have < HEAD && have + piece.length >= HEAD) {
            const head = have ? Buffer.concat([...f.carry, piece.subarray(0, HEAD - have)]) : piece;
            if (this.ignorable(head, s.light)) { f.carry = []; f.carryLen = 0; f.skip = true; }
          }
          if (!f.skip) { f.carry.push(Buffer.from(piece)); f.carryLen += piece.length; }
        }
      }
    } finally { fs.closeSync(fd); }
    return read;
  }

  // Tout ce qui s'est ajouté à un fichier, tranche par tranche, en rendant la main entre deux.
  async readAll(entry, s, handler) {
    let total = 0;
    for (;;) {
      entry.more = false;
      const n = this.readIncrement(entry, s, handler);
      if (n < 0) return n;
      if (n) { total += n; this.progress.bytes += n; await new Promise((r) => setImmediate(r)); }
      if (!entry.more) break;
    }
    if (total) this.progress.files++;
    return total;
  }

  // Une ligne qu'on n'utilisera pas, reconnue à sa tête (pour ne pas garder en mémoire une ligne de 20 Mo).
  ignorable(head, light) {
    const h = head.toString('latin1', 0, HEAD);
    if (h.startsWith('{"type":"')) return SKIP_TYPES.has(h.slice(9, h.indexOf('"', 9)));
    if (h.includes('"attachment":{"type":"')) return !h.includes('"attachment":{"type":"queued_command"') && !h.includes('"attachment":{"type":"credential_org"');
    if (light) return !h.includes('"role":"assistant"');
    return false;
  }

  line(data, start, end, s, entry) {
    if (end - start < 2) return;
    const head = data.toString('latin1', start, Math.min(end, start + HEAD));
    if (head.startsWith('{"type":"')) {
      const type = head.slice(9, head.indexOf('"', 9));
      if (SKIP_TYPES.has(type)) return;
    } else if (head.includes('"attachment":{')) {
      // Pièces jointes : seules la file d'attente (messages de l'utilisateur, fins de tâches) et le compte comptent.
      if (head.includes('"attachment":{"type":"') && !head.includes('"attachment":{"type":"queued_command"')
        && !head.includes('"attachment":{"type":"credential_org"')) return;
    } else if (head.includes('"role":"user"') && this.fastToolResult(data.subarray(start, end), s, entry)) return;
    let r;
    try { r = JSON.parse(data.toString('utf8', start, end)); } catch { return; }
    this.record(r, s, entry);
  }

  // Résultat d'un outil dont on ne veut que « réussi ou non » (Read, Grep, MCP…) : sans décoder la ligne,
  // souvent énorme. Renvoie false s'il faut tout décoder.
  fastToolResult(line, s, entry) {
    const i = line.indexOf('"type":"tool_result"');
    if (i === -1 || line.indexOf('"type":"tool_result"', i + 20) !== -1) return false;
    if (line.indexOf('<task-notification>') !== -1) return false;
    const j = line.indexOf('"tool_use_id":"');
    if (j === -1) return false;
    const id = line.toString('latin1', j + 15, line.indexOf(34, j + 15));
    const t = s.toolUses.get(id);
    if (t && this.needsResult(t)) return false;
    if (!entry.agentId) {
      const k = line.indexOf('"permissionDecision":{');
      if (k !== -1) {
        const w = line.toString('latin1', k, k + 300);
        this.countPerm(s, { decision: /"decision":"(\w+)"/.exec(w)?.[1], source: /"source":"(\w+)"/.exec(w)?.[1] });
      }
    }
    if (t) { t.act.ok = line.indexOf('"is_error":true') === -1; s.toolUses.delete(id); }
    return true;
  }

  needsResult(t) {
    if (t.name === 'Bash') return !!(t.kind || t.input?.background);
    return FILE_TOOLS.has(t.name) || ['Artifact', 'Workflow', 'Agent', 'Task', 'TaskCreate'].includes(t.name) || PUBLISH_TOOLS.test(t.name);
  }

  countPerm(s, p) {
    if (!p?.decision) return;
    if (p.decision === 'reject') s.perms.refus++;
    else if (p.source === 'user_temporary') s.perms.toi++;
    else if (p.source === 'user_permanent') s.perms.regle++;
    else s.perms.auto++;
  }

  // Mode usage seulement : poids et MCP, sans JSON.parse.
  lightLine(data, start, end, l, entry) {
    if (end - start < 50) return;
    const line = data.subarray(start, end);
    const head = line.toString('latin1', 0, Math.min(line.length, HEAD));
    if (head.includes('"attachment":{"type":"credential_org"')) {
      const org = RE_ORG.exec(head)?.[1];
      if (org) { entry.f.org = org; if (!entry.agentId) l.org = org; }
      return;
    }
    if (!head.includes('"role":"assistant"') || head.startsWith('{"type":"')) return;
    const ts = topTimestamp(line, 'assistant');
    if (!ts || Number.isNaN(Date.parse(ts))) return;
    l.lastTs = tsMax(l.lastTs, ts);
    if (!l.cwd && !entry.agentId) { const i = line.lastIndexOf('"cwd":"'); if (i !== -1) l.cwd = line.toString('utf8', i + 7, line.indexOf(34, i + 7)) || null; }
    const ui = line.lastIndexOf('"usage":{"input_tokens":');
    const id = RE_MSG_ID.exec(head)?.[1];
    if (ui !== -1 && id) {
      const w = line.toString('latin1', ui, Math.min(line.length, ui + 600));
      trackUsage(l, id, { input: numIn(RE_INPUT, w), output: numIn(RE_OUTPUT, w), cacheRead: numIn(RE_CREAD, w), cacheWrite: numIn(RE_CWRITE, w) },
        ts, entry.f.org || l.org, null);
    }
    const m = RE_MCP_USE.exec(head);
    if (m) countMcp(l, m[1], ts);
  }

  // Journal d'un workflow : agents lancés (nom, phase) et terminés.
  journalLine(data, start, end, s, entry) {
    const head = data.toString('latin1', start, Math.min(end, start + 400));
    if (head.startsWith('{"type":"started"')) {
      try {
        const r = JSON.parse(data.toString('utf8', start, end));
        if (r.agentId) { const a = this.ensureAgent(s, r.agentId, entry.runId); a.description ||= r.label || null; a.phase ||= r.phase || null; }
      } catch { /* ligne abîmée */ }
    } else if (head.startsWith('{"type":"result"')) {
      const id = /"agentId":"([\w-]+)"/.exec(head)?.[1];
      if (id) this.ensureAgent(s, id, entry.runId).resultSeen = true;
    }
  }

  record(r, s, entry) {
    const { agentId, runId } = entry;
    const ts = r.timestamp;
    const main = !agentId;
    if (r.type === 'ai-title') { if (main && r.aiTitle) s.title = r.aiTitle; return; }
    if (r.type === 'last-prompt') { if (main && r.lastPrompt) s.lastPrompt = cleanPrompt(r.lastPrompt); return; }
    if (r.type === 'attachment') return this.attachment(r, s, entry);
    if (r.type !== 'assistant' && r.type !== 'user') return;
    if (main) { s.touch(ts); if (r.cwd) s.cwd = r.cwd; if (r.gitBranch) s.gitBranch = r.gitBranch; if (r.entrypoint) s.entrypoint = r.entrypoint; }
    const agent = agentId ? this.ensureAgent(s, agentId, runId) : null;
    if (agent && ts) { if (!agent.firstTs || ts < agent.firstTs) agent.firstTs = ts; if (!agent.lastTs || ts > agent.lastTs) agent.lastTs = ts; }
    const ch = s.chapterAt(ts);
    const content = r.message?.content;

    if (r.type === 'assistant') { if (ch && ts > ch.end) ch.end = ts; return this.assistant(r, s, entry, agent, ch, content); }

    // user : résultats d'outils, décisions de permission, notifications de tâches de fond, messages de l'utilisateur
    if (r.permissionDecision && main) this.countPerm(s, r.permissionDecision);
    if (typeof content === 'string' || (Array.isArray(content) && content.every((c) => c.type === 'text' || c.type === 'image'))) {
      const text = typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text.includes('<task-notification>')) return this.notification(s, text, ts);
      if (main && !r.isMeta && !r.isCompactSummary && !r.isVisibleInTranscriptOnly && (!r.origin || r.origin.kind === 'human')) {
        this.humanMessage(s, r.uuid, text, ts, r.origin?.kind === 'human');
      }
      return;
    }
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c.type === 'text' && c.text?.includes('<task-notification>')) this.notification(s, c.text, ts);
      if (c.type !== 'tool_result') continue;
      const t = s.toolUses.get(c.tool_use_id);
      if (!t) continue;
      if (ch && ts > ch.end) ch.end = ts;
      const ok = !c.is_error;
      t.act.ok = ok;
      s.toolUses.delete(c.tool_use_id);
      this.toolResult(s, t, c, r.toolUseResult, ok, ts, agent, agentId);
    }
  }

  assistant(r, s, { agentId, runId, f }, agent, ch, content) {
    const ts = r.timestamp;
    const main = !agentId;
    const m = r.message || {};
    if (m.usage && m.id && ts) {
      const n = usageNums(m.usage);
      trackUsage(s, m.id, n, ts, f?.org || s.org, agent);
      // Taille du contexte de la dernière réponse : ce que coûterait une relecture complète sur un autre compte.
      if (main && !r.isApiErrorMessage && !r.isSidechain && (!s.context || ts >= s.context.ts)) {
        const tokens = n.input + n.cacheRead + n.cacheWrite;
        if (tokens > 0) s.context = { tokens, ts };
      }
    }
    if (r.isApiErrorMessage && r.error === 'rate_limit' && ts) {
      s.limits.push({ ts, text: short(textOf(content), 200), agent: agentId });
      s.limitsTotal++;
      if (s.limits.length > MAX_LIMITS) { s.limits.sort((a, b) => String(a.ts).localeCompare(String(b.ts))); s.limits.splice(0, s.limits.length - MAX_LIMITS); }
    }
    if (!Array.isArray(content)) return;
    // Message de Claude en plein travail (« Je relance les tests… ») : où il en est, en direct.
    if (main && !r.isApiErrorMessage && !r.isSidechain && ts && m.role === 'assistant') {
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text && (!s.liveText || ts >= s.liveText.ts)) s.liveText = { text: cleanText(text, 400), ts };
    }
    // Fin de tour de la conversation principale : son compte rendu.
    if (main && m.stop_reason === 'end_turn' && !r.isApiErrorMessage && !r.isSidechain && ts) {
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) {
        const out = { text: cleanText(text, 600), ts };
        if (!s.lastText || ts >= s.lastText.ts) s.lastText = out;
        if (ch && (!ch.outcome || ts >= ch.outcome.ts)) ch.outcome = out;
      }
    }
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      const name = c.name, inp = c.input || {};
      const segs = name === 'Bash' ? segments(inp.command) : null;
      const kind = actionKind(name, inp);
      // sig : empreinte des paramètres exacts — sert à reconnaître une vraie boucle (même appel répété),
      // pas 37 requêtes SQL différentes d'un même outil (fausse alerte du 2026-10-20).
      const act = { ts, agent: agentId, tool: name, kind, title: label(name, inp), detail: actDetail(name, inp), ok: undefined,
        ...(kind === 'commit' ? { msg: short(maskSecrets(commitMessage(inp.command) || ''), 160) || null } : {}),
        ...(milestoneOf(name, inp) ? { milestone: milestoneOf(name, inp) } : {}),
        sig: crypto.createHash('sha1').update(JSON.stringify(inp ?? null)).digest('hex').slice(0, 12) };
      const t = { name, input: slimInput(name, inp), ts, agentId, runId, act, kind: segs ? testKind(inp.command, segs) : null };
      s.toolUses.set(c.id, t);
      if (s.toolUses.size > MAX_TOOL_USES) { let i = 0; for (const k of s.toolUses.keys()) { s.toolUses.delete(k); if (++i >= 1000) break; } }
      s.toolCount++;
      if (ch) ch.actions++;
      if (agent) { agent.tools++; agent.lastAction = act.title; }
      s.activity.push(act);
      if (s.activity.length > MAX_ACTIVITY * 1.5) {
        s.activity.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
      }
      if (name.startsWith('mcp__')) countMcp(s, name, ts);
      if (ts && (name === 'Bash' || name === 'Skill' || name === 'Read' || FILE_TOOLS.has(name))) this.notePlanRefs(s, agent, r.cwd, name, inp, ts);
      if (segs && ch && segs.some((x) => GIT_COMMIT.test(x))) ch.commits++;
      if (name === 'Bash' && inp.run_in_background) s.bgTasks.set(c.id, { id: c.id, ts, agentId, command: t.input.command, description: inp.description, status: 'running' });
      if (main && name === 'TodoWrite' && Array.isArray(inp.todos)) {
        s.todos = { ts, items: inp.todos.map((x) => ({ text: short(x.content || x.activeForm, 200), status: TODO_STATUS[x.status] || 'todo' })) };
      }
      if (main && name === 'TaskUpdate' && inp.taskId != null && s.taskList) {
        const it = s.taskList.items.get(String(inp.taskId));
        if (it) {
          if (inp.status === 'deleted') s.taskList.items.delete(String(inp.taskId));
          else { if (TODO_STATUS[inp.status]) it.status = TODO_STATUS[inp.status]; if (inp.subject) it.text = short(inp.subject, 200); }
          s.taskList.ts = ts;
        }
      }
    }
  }

  toolResult(s, t, c, tur, ok, ts, agent, agentId) {
    const ch = s.chapterAt(ts);
    if (t.name === 'Bash') {
      if (t.kind) {
        const out = typeof tur === 'object' && tur ? `${tur.stdout || ''}\n${tur.stderr || ''}` : textOf(c.content);
        const bg = t.input.background && s.bgTasks.get(c.tool_use_id);
        const test = { ts, agentId, kind: t.kind, command: short(t.input.command, 1500), description: t.input.description, toolUseId: c.tool_use_id, ch: ch || null,
          red: isExpectedFail(t.input.description) };
        if (bg) Object.assign(test, { ok: null, pending: true, passed: null, failed: null, line: null, tsErrors: 0 }); // le vrai résultat viendra avec la notification
        else {
          const p = parseTestOutput(out);
          Object.assign(test, { ok: !(!ok || (p.failed ?? 0) > 0 || p.tsErrors > 0 || FAIL_MARK.test(out)), pending: false, ...p });
        }
        s.tests.push(test);
        if (bg) bg.test = test;
        if (ch) { ch.tests++; if (test.ok === false && !test.red) ch.testsFailed++; }
        if (agent) agent.tests++;
        if (s.tests.length > MAX_TESTS * 1.25) { s.tests.sort((a, b) => String(a.ts).localeCompare(String(b.ts))); s.tests.splice(0, s.tests.length - MAX_TESTS); }
      }
      if (t.input.background && s.bgTasks.has(c.tool_use_id) && typeof tur === 'object' && tur?.backgroundTaskId) s.bgTasks.get(c.tool_use_id).taskId = tur.backgroundTaskId;
    } else if (FILE_TOOLS.has(t.name) && ok) {
      const fp = (typeof tur === 'object' && tur?.filePath) || t.input.file_path;
      if (fp) {
        let f = s.files.get(fp);
        if (!f) { f = { path: fp, ...fileKind(fp), created: false, ops: 0, firstTs: ts, lastTs: ts, agents: new Set(), lastBy: null }; s.files.set(fp, f); }
        if (t.name === 'Write' && tur?.type === 'create') f.created = true;
        f.ops++; f.lastTs = tsMax(f.lastTs, ts); f.agents.add(agentId || 'main');
        if (!f.lastTs || ts >= f.lastTs) f.lastBy = agentId || null;
        if (ch) ch.files.add(fp);
        if (agent) agent.files++;
      }
    } else if (t.name === 'Artifact' && ok && typeof tur === 'object' && tur?.url) {
      const a = this.ensureArtifact(s, tur.url, ts, agentId);
      Object.assign(a, { title: tur.title || a.title, path: tur.path || t.input.file_path || a.path, version: tur.seq ?? a.version, description: t.input.description || a.description });
      if ((t.input.action || 'publish') === 'publish') { a.publishes++; if (ch) a.chapters.add(ch); }
    } else if (t.name === 'Workflow' && typeof tur === 'object' && tur?.runId) {
      const w = this.ensureWorkflow(s, tur.runId);
      w.name = w.name || tur.workflowName; w.summary = w.summary || tur.summary; w.startTs = w.startTs || ts;
      // Relance d'un workflow : nouveau lancement, l'ancienne fin ne vaut plus.
      if (tur.taskId && tur.taskId !== w.taskId) { w.taskId = tur.taskId; w.status = 'running'; w.endTs = null; w.launchTs = ts; }
    } else if ((t.name === 'Agent' || t.name === 'Task') && typeof tur === 'object' && tur?.agentId) {
      const a = this.ensureAgent(s, tur.agentId, null);
      a.description = a.description || t.input.description; a.type = a.type || t.input.subagent_type; a.background = a.background || t.input.background;
      a.toolUseId = c.tool_use_id;
      if (!a.firstTs) a.firstTs = t.ts;
      if (tur.status === 'completed') { a.finished = true; a.status = 'completed'; } // agent au premier plan : fini avec son résultat
    } else if (t.name === 'TaskCreate' && ok) {
      const id = tur?.task?.id ?? tur?.taskId ?? tur?.id ?? /#(\d+)/.exec(textOf(c.content))?.[1];
      if (id != null && t.input?.subject) {
        if (!s.taskList) s.taskList = { ts, items: new Map() };
        s.taskList.items.set(String(id), { text: t.input.subject, status: 'todo' });
        s.taskList.ts = ts;
      }
    } else if (PUBLISH_TOOLS.test(t.name) && ok) {
      // Documents claude.ai : seul l'outil qui publie compte (un lien lu ailleurs n'est pas un artefact).
      for (const m of textOf(c.content).matchAll(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g)) {
        const a = this.ensureArtifact(s, m[0], ts, agentId);
        a.title = a.title || t.input?.title || 'Document';
        a.publishes++;
        if (ch) a.chapters.add(ch);
      }
    }
  }

  ensureArtifact(s, url, ts, agentId) {
    let a = s.artifacts.get(url);
    if (!a) { a = { url, title: null, path: null, description: null, firstTs: ts, lastTs: ts, publishes: 0, agents: new Set(), chapters: new Set() }; s.artifacts.set(url, a); }
    if (ts && (!a.firstTs || ts < a.firstTs)) a.firstTs = ts;
    a.lastTs = tsMax(a.lastTs, ts);
    a.agents.add(agentId || 'main');
    return a;
  }

  attachment(r, s, entry) {
    const at = r.attachment;
    if (!at) return;
    if (at.type === 'credential_org') {
      if (at.organizationUuid) { if (entry.f) entry.f.org = at.organizationUuid; if (!entry.agentId) s.org = at.organizationUuid; }
      return;
    }
    if (at.type !== 'queued_command') return;
    // Message mis en file pendant que Claude travaillait : fin de tâche de fond, ou vraie demande de l'utilisateur
    // (jamais réécrite ensuite en ligne « user »).
    const text = textOf(at.prompt);
    if (text.includes('<task-notification>')) return this.notification(s, text, r.timestamp);
    if (!entry.agentId && at.origin?.kind === 'human' && !at.isMeta && r.timestamp) {
      s.touch(r.timestamp);
      this.humanMessage(s, r.uuid, text, r.timestamp, true);
    }
  }

  // Un vrai message de l'utilisateur : dernier message connu, et début d'un chapitre.
  humanMessage(s, uuid, text, ts, human) {
    const prompt = promptText(text, human);
    if (!prompt || !ts) return;
    s.lastUserMessage = { text: short(prompt, 400), ts };
    // Le même message vu deux fois (file d'attente puis ligne normale) n'ouvre qu'un chapitre.
    const key = prompt.slice(0, 200);
    if (s.lastHuman && s.lastHuman.key === key && Math.abs(Date.parse(ts) - Date.parse(s.lastHuman.ts)) < 15 * 60_000) return;
    s.lastHuman = { key, ts };
    const ch = { id: uuid || ts, prompt: short(prompt, 300), start: ts, end: ts, outcome: null,
      actions: 0, files: new Set(), tests: 0, testsFailed: 0, commits: 0 };
    const c = s.chapters;
    if (!c.length || c[c.length - 1].start <= ts) c.push(ch);
    else { let i = c.length; while (i > 0 && c[i - 1].start > ts) i--; c.splice(i, 0, ch); }
    if (c.length > MAX_CHAPTERS) c.splice(0, c.length - MAX_CHAPTERS);
  }

  notification(s, text, ts) {
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = m[1];
      const get = (tag) => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body) || [])[1];
      const toolUseId = get('tool-use-id'), status = get('status'), taskId = get('task-id'), summary = get('summary');
      const b = toolUseId && s.bgTasks.get(toolUseId);
      if (b) {
        Object.assign(b, { status, endTs: ts, summary: short(maskSecrets(summary), 200) });
        // Test lancé en fond : son vrai résultat arrive ici.
        if (b.test?.pending && status) {
          const okRun = status === 'completed' && !/exit code [1-9]/.test(summary || '');
          Object.assign(b.test, { ok: okRun, pending: false, ts: ts || b.test.ts });
          if (!okRun && !b.test.red && b.test.ch) b.test.ch.testsFailed++;
        }
      }
      for (const w of s.workflows.values()) if (taskId && w.taskId === taskId && status) { w.status = status; w.endTs = ts; }
      for (const a of s.agents.values()) if (toolUseId && a.toolUseId === toolUseId && status) { a.finished = true; a.status = status; }
    }
  }

  // ---------- plans suivis ----------

  // Plans cités par un appel d'outil (conversation ou agent) : fichier lu ou écrit, chemins d'une commande ou des
  // arguments d'une compétence, registre d'exécution. Les chemins relatifs sont résolus contre les « cd » de la
  // commande, le dossier du terminal (dernier cd connu) puis le dossier de la conversation.
  notePlanRefs(s, agent, cwd, name, inp, ts) {
    const add = (key) => {
      const prev = s.planRefs.get(key);
      if (prev && prev.ts > ts) return;
      s.planRefs.set(key, { ts, n: ++this.planRefSeq }); s.planRefsVer++; // n : à heure égale, le dernier cité
      if (s.planRefs.size > PLAN_REFS) {
        let old = null;
        for (const e of s.planRefs) if (!old || e[1].ts < old[1].ts) old = e;
        s.planRefs.delete(old[0]);
      }
    };
    if (name !== 'Bash' && name !== 'Skill') {
      const fp = inp.file_path || inp.notebook_path;
      if (typeof fp !== 'string' || !path.isAbsolute(fp)) return;
      if (isPlanFile(fp)) add(path.normalize(fp));
      const l = ledgerDirOf(fp);
      if (l) add('sdd:' + l);
      return;
    }
    let text = name === 'Bash' ? inp.command : inp.args;
    if (typeof text !== 'string' || !text) return;
    if (text.length > 20_000) text = text.slice(0, 20_000);
    const sh = agent || s;
    const cds = [];
    if (name === 'Bash' && text.includes('cd ')) {
      let base = sh.shellCwd || cwd || s.cwd || null;
      for (const m of text.matchAll(CD_TOKEN)) {
        const t = m[1].replace(/^(["'])(.*)\1$/, '$2');
        if (!t || t.startsWith('$') || t.startsWith('-')) continue;
        const e = expandHome(t);
        if (!path.isAbsolute(e) && !base) continue;
        base = path.resolve(base || path.sep, e);
        cds.push(base);
      }
      if (cds.length) sh.shellCwd = cds[cds.length - 1];
    }
    const hasMd = text.includes('.md'), hasSdd = text.includes('.superpowers/sdd/');
    if (!hasMd && !hasSdd) return;
    const bases = [...new Set([...cds.reverse(), sh.shellCwd, cwd, s.cwd].filter(Boolean))];
    if (hasMd) {
      const files = new Set();
      for (const m of text.matchAll(MD_TOKEN)) {
        if (!isPlanFile(m[1])) continue;
        const f = resolveCited(m[1], bases);
        if (f) files.add(f);
        if (files.size > 3) break;
      }
      // Plus de trois plans dans une commande : un inventaire (ls, grep, boucle), pas un plan qu'on suit.
      if (files.size <= 3) for (const f of files) add(f);
    }
    if (hasSdd) {
      for (const m of text.matchAll(SDD_TOKEN)) {
        const d = resolveCited(m[1], bases);
        if (d) add('sdd:' + d);
      }
    }
  }

  // Plan suivi par une conversation : sa référence la plus récente qui mène à un plan d'au moins deux étapes
  // (un README ou une spécification sans étapes est sauté). Revérifié au plus toutes les 5 s.
  planOf(s) {
    if (!s.planRefs?.size) return null;
    const now = Date.now();
    const c = s.planChoice;
    if (c && c.ver === s.planRefsVer && now - c.at < PLAN_CHECK_MS) return c.plan;
    let plan = null;
    const refs = [...s.planRefs].sort((a, b) => (a[1].ts < b[1].ts ? 1 : a[1].ts > b[1].ts ? -1 : b[1].n - a[1].n)).slice(0, 12);
    const tried = new Set();
    const root = projectRootOf(s.cwd);
    const start = Date.parse(s.firstTs) || 0;
    for (const [key] of refs) {
      const file = key.startsWith('sdd:') ? this.ledgerPlan(key.slice(4)) : key;
      if (!file || tried.has(file)) continue;
      tried.add(file);
      // un plan d'un autre projet (lu en passant, cité dans une commande) n'est pas celui de la conversation
      if (root && root !== os.homedir() && !inside(file, root) && !inside(file, PLANS_DIR)) continue;
      const view = this.planView(file);
      if (!view) continue;
      const touched = Math.max(Date.parse(view.updatedAt) || 0, Date.parse(view.lastAt) || 0);
      if (start && touched < start - PLAN_STALE_MS) continue;
      plan = this.planState(s, view);
      break;
    }
    s.planChoice = { ver: s.planRefsVer, at: now, plan };
    return plan;
  }

  // Un plan analysé, avec ce qu'en disent ses registres : étapes finies, dernière étape citée et date du registre.
  planView(file) {
    const p = this.readPlan(file);
    if (!p || p.steps.length < 2) return null;
    const ledgers = this.ledgersFor(file).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const complete = new Set();
    let last = null, lastAt = null;
    for (const l of ledgers) {
      for (const id of l.complete) complete.add(id);
      if (l.last) { last = l.last; lastAt = new Date(l.mtimeMs).toISOString(); }
    }
    return { title: p.title || path.basename(file, '.md'), file, updatedAt: new Date(Math.round(p.mtimeMs)).toISOString(), last, lastAt,
      steps: p.steps.map((x) => (x.id && complete.has(x.id) ? { ...x, status: 'done' } : x)) };
  }

  // Le plan vu par une conversation. Ses agents qui portent une étape dans leur nom (« faire:L2.22 »,
  // « refuter:L2.22 ») complètent le registre, souvent en retard sur un workflow : une étape dont un agent a fini,
  // suivie d'un agent sur une étape plus loin dans le plan, est faite ; l'étape du dernier agent lancé est en cours
  // (s'il est plus récent que le registre). Sinon, l'étape en cours est celle que le registre cite en dernier si
  // elle n'est pas finie, sinon la première non faite après elle, sinon la première non faite du plan.
  planState(s, view) {
    const steps = view.steps.map((x) => ({ ...x }));
    const index = new Map();
    for (let i = 0; i < steps.length; i++) {
      const id = steps[i].id;
      if (id && /[A-Za-z.]/.test(id) && !index.has(id)) index.set(id, i); // « 12 » seul : trop ambigu dans un nom d'agent
    }
    let hint = -1;
    if (index.size && s.agents.size) {
      const seen = [];
      for (const a of s.agents.values()) {
        if (!a.description || !a.firstTs) continue;
        for (const m of String(a.description).matchAll(STEP_TOKEN)) {
          if (index.has(m[0])) { seen.push({ i: index.get(m[0]), ts: a.firstTs, st: this.agentStatus(s, a) }); break; }
        }
      }
      if (seen.length) {
        seen.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
        let further = -1;
        for (let k = seen.length - 1; k >= 0; k--) {
          const e = seen[k];
          if (e.st === 'done' && further > e.i) steps[e.i].status = 'done';
          if (e.i > further) further = e.i;
        }
        const latest = seen[seen.length - 1];
        if ((!view.lastAt || latest.ts > view.lastAt) && steps[latest.i].status !== 'done') hint = latest.i;
      }
    }
    const firstOpen = (from) => { for (let i = from; i < steps.length; i++) if (steps[i].status !== 'done') return i; return -1; };
    let cur = hint;
    if (cur < 0 && view.last) {
      const i = steps.findIndex((x) => x.id === view.last);
      if (i >= 0) cur = steps[i].status !== 'done' ? i : firstOpen(i + 1);
    }
    if (cur < 0) { cur = steps.findIndex((x) => x.status === 'doing'); if (cur < 0) cur = firstOpen(0); }
    if (cur >= 0 && steps[cur].status === 'todo') steps[cur].status = 'doing';
    let done = 0;
    for (const x of steps) if (x.status === 'done') done++;
    return { title: view.title, file: view.file, updatedAt: view.updatedAt, steps: steps.slice(0, MAX_PLAN_STEPS),
      done, total: steps.length, current: cur >= 0 ? (steps[cur].id || steps[cur].text) : null };
  }

  // Analyse d'un fichier de plan, gardée tant que le fichier ne change pas (le texte n'est pas gardé).
  readPlan(file) {
    let st; try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) return null;
    const c = this.planCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
    let parsed; try { parsed = parsePlan(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const out = { mtimeMs: st.mtimeMs, size: st.size, title: parsed.title, steps: parsed.steps };
    this.planCache.delete(file); this.planCache.set(file, out);
    if (this.planCache.size > MAX_PLAN_CACHE) this.planCache.delete(this.planCache.keys().next().value);
    return out;
  }

  readLedger(file) {
    let st; try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) return null;
    const c = this.ledgerCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
    let parsed; try { parsed = parseLedger(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const out = { mtimeMs: st.mtimeMs, size: st.size, complete: parsed.complete, last: parsed.last };
    this.ledgerCache.delete(file); this.ledgerCache.set(file, out);
    if (this.ledgerCache.size > MAX_PLAN_CACHE) this.ledgerCache.delete(this.ledgerCache.keys().next().value);
    return out;
  }

  // Les registres de <dossier>/.superpowers/sdd, avec le plan que chacun déclare (fichier plan-path, sinon
  // l'en-tête de progress.md). Relus au plus toutes les 30 s.
  sddIndex(root) {
    const now = Date.now();
    const c = this.sddCache.get(root);
    if (c && now - c.at < SDD_LIST_MS) return c.entries;
    const entries = [];
    let names = [];
    try { names = fs.readdirSync(path.join(root, '.superpowers', 'sdd'), { withFileTypes: true }); } catch { /* aucun registre */ }
    for (const d of names) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, '.superpowers', 'sdd', d.name);
      let decl = null;
      try { decl = fs.readFileSync(path.join(dir, 'plan-path'), 'utf8').split('\n')[0].trim() || null; } catch { /* absent */ }
      if (!decl) decl = LEDGER_HEAD.exec(readHead(path.join(dir, 'progress.md')))?.[1] || null;
      const plan = decl ? (path.isAbsolute(decl) ? path.normalize(decl) : path.resolve(root, decl)) : null;
      entries.push({ dir, name: d.name, decl, plan, progress: path.join(dir, 'progress.md') });
    }
    this.sddCache.delete(root); this.sddCache.set(root, { at: now, entries });
    if (this.sddCache.size > 300) this.sddCache.delete(this.sddCache.keys().next().value);
    return entries;
  }

  // Plan déclaré par un registre (<racine>/.superpowers/sdd/<nom>), s'il existe.
  ledgerPlan(dir) {
    const root = path.dirname(path.dirname(path.dirname(dir)));
    const e = this.sddIndex(root).find((x) => x.dir === dir);
    if (!e?.plan) return null;
    try { return fs.existsSync(e.plan) ? e.plan : null; } catch { return null; }
  }

  // Registres qui suivent ce plan : dans son dépôt ou un dossier parent (un worktree a son registre dans le dépôt
  // principal : le chemin relatif déclaré suffit alors).
  ledgersFor(file) {
    const out = [];
    const home = os.homedir();
    const base = path.basename(file, '.md');
    for (let d = path.dirname(file), i = 0; i < 12 && d !== path.dirname(d); d = path.dirname(d), i++) {
      for (const e of this.sddIndex(d)) {
        const same = e.decl ? e.plan === file || (!path.isAbsolute(e.decl) && file.endsWith(path.sep + path.normalize(e.decl)))
          : e.name === base;
        if (!same) continue;
        const l = this.readLedger(e.progress);
        if (l) out.push(l);
      }
      if (d === home) break;
    }
    return out;
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.readLive();
      if (Date.now() - this.lastDiscovery > 20_000 || [...this.live.keys()].some((k) => !this.sessions.has(k))) this.discover();
      for (const s of [...this.sessions.values()]) {
        for (const entry of this.filesFor(s)) {
          if (await this.readAll(entry, s, entry.journal ? this.journalLine : this.line) < 0) { this.rebuild(s); break; }
        }
      }
      for (const l of [...this.light.values()]) {
        // Une conversation au repos ne bouge plus : on ne relit que si son transcript a changé.
        let mt = -1; try { mt = fs.statSync(l.transcriptPath).mtimeMs; } catch { /* supprimé */ }
        if (mt === l.scannedMtime) continue;
        let broken = false;
        for (const entry of this.lightFiles(l)) {
          if (await this.readAll(entry, l, this.lightLine) < 0) { this.rebuild(l); broken = true; break; }
        }
        if (!broken) { l.scannedMtime = mt; l.mtimeMs = Math.max(l.mtimeMs, mt); }
      }
      if (!this.progress.done) { this.progress.done = true; this.progress.durationMs = Date.now() - this.progress.startedAt; }
    } finally { this.busy = false; }
  }

  // ---------- états ----------

  workflowStatus(s, w) {
    // Le fichier du workflow fait foi s'il décrit le lancement en cours.
    if (w.jsonStatus && w.jsonStatus !== 'running' && (!w.taskId || w.jsonTaskId === w.taskId)) return w.jsonStatus;
    if (w.status !== 'running') return w.status;
    const now = Date.now();
    // Lancé, sans fin connue, conversation ouverte : il tourne, même si ses agents n'écrivent rien (longue commande).
    if (w.taskId && this.live.has(s.id) && now - Date.parse(w.launchTs || w.startTs || 0) < LIVE_RUN_MS) return 'running';
    for (const a of s.agents.values()) if (a.runId === w.runId && now - a.mtimeMs < RUNNING_MS) return 'running';
    return 'idle';
  }

  agentStatus(s, a) {
    if (a.finished || a.resultSeen) return a.status === 'failed' || a.status === 'killed' || a.status === 'stopped' ? a.status : 'done';
    const w = a.runId ? s.workflows.get(a.runId) : null;
    const ws = w ? this.workflowStatus(s, w) : null;
    if (w && ws !== 'running' && ws !== 'idle') return ws === 'completed' ? 'done' : ws;
    const now = Date.now();
    if (now - a.mtimeMs < RUNNING_MS) return 'running';
    // Agent au premier plan dont Claude attend encore le résultat.
    if (a.toolUseId && s.toolUses.has(a.toolUseId) && this.live.has(s.id) && now - Date.parse(a.firstTs || 0) < LIVE_RUN_MS) return 'running';
    // Agent de fond ou de workflow sans fin connue, conversation ouverte, lancé il y a moins de 12 h.
    if ((a.background || ws === 'running') && this.live.has(s.id) && now - Date.parse(a.firstTs || 0) < LIVE_RUN_MS) return 'running';
    return 'idle';
  }

  // Une tâche de fond sans notification de fin depuis 12 h : on n'en sait plus rien.
  bgStatus(b) {
    if (b.status !== 'running') return b.status;
    return Date.now() - Date.parse(b.ts) > LIVE_RUN_MS ? 'unknown' : 'running';
  }

  // ---------- usage ----------

  // Toutes les conversations connues : lues entièrement, puis lues pour l'usage seulement (7 jours).
  // Chacune a id, cwd, lastTs, org, mcpUses et wByHour.
  allSessions() { return [...this.sessions.values(), ...this.light.values()]; }

  // Poids d'usage d'une conversation depuis sinceIso (toutes organisations, ou une seule).
  usageWeight(sessionOrId, sinceIso, org) {
    const s = typeof sessionOrId === 'string' ? (this.sessions.get(sessionOrId) || this.light.get(sessionOrId)) : sessionOrId;
    if (!s) return 0;
    const h0 = sinceIso ? Math.floor(Date.parse(sinceIso) / HOUR) : -Infinity;
    let w = 0;
    for (const [k, v] of s.wByHour) {
      const bar = k.indexOf('|');
      if (Number(k.slice(0, bar)) < h0) continue;
      if (org !== undefined && k.slice(bar + 1) !== (org || '')) continue;
      w += v;
    }
    return Math.round(w);
  }

  // Usage minute par minute d'une conversation (24 h au plus, agents et workflows compris), rangé en `count`
  // seaux de `stepMin` minutes à partir de fromMs. w : poids de l'organisation `org` (toutes si org est
  // undefined), all : poids toutes organisations, tok : tokens bruts (entrée + sortie + cache).
  usageBuckets(sessionOrId, fromMs, stepMin, count, org) {
    const s = typeof sessionOrId === 'string' ? (this.sessions.get(sessionOrId) || this.light.get(sessionOrId)) : sessionOrId;
    const w = new Array(count).fill(0), all = new Array(count).fill(0), tok = new Array(count).fill(0);
    if (!s?.wByMin?.size) return { w, all, tok };
    const m0 = Math.floor(fromMs / MINUTE), nowMin = Math.floor(Date.now() / MINUTE);
    if (s.wByMinPruned < nowMin - 30) pruneMinutes(s, nowMin);
    const want = org === undefined ? null : (org || '');
    for (const [k, v] of s.wByMin) {
      const bar = k.indexOf('|');
      const i = Math.floor((Number(k.slice(0, bar)) - m0) / stepMin);
      if (i < 0 || i >= count) continue;
      all[i] += v[0]; tok[i] += v[1];
      if (want === null || k.slice(bar + 1) === want) w[i] += v[0];
    }
    return { w, all, tok };
  }

  // Même découpage, toutes conversations confondues, par organisation : Map org -> { w, tok }.
  usageBucketsByOrg(fromMs, stepMin, count) {
    const out = new Map();
    const m0 = Math.floor(fromMs / MINUTE), nowMin = Math.floor(Date.now() / MINUTE);
    for (const s of this.allSessions()) {
      if (!s.wByMin?.size) continue;
      if (s.wByMinPruned < nowMin - 30) pruneMinutes(s, nowMin);
      for (const [k, v] of s.wByMin) {
        const bar = k.indexOf('|');
        const i = Math.floor((Number(k.slice(0, bar)) - m0) / stepMin);
        if (i < 0 || i >= count) continue;
        const org = k.slice(bar + 1);
        let b = out.get(org);
        if (!b) { b = { w: new Array(count).fill(0), tok: new Array(count).fill(0) }; out.set(org, b); }
        b.w[i] += v[0]; b.tok[i] += v[1];
      }
    }
    return out;
  }

  // Poids par organisation (compte) depuis sinceIso, toutes conversations confondues : le dénominateur de la
  // part de la semaine. byOrg[''] = organisation inconnue.
  usageTotals(sinceIso) {
    const h0 = sinceIso ? Math.floor(Date.parse(sinceIso) / HOUR) : -Infinity;
    const byOrg = {};
    let total = 0;
    for (const s of this.allSessions()) {
      for (const [k, v] of s.wByHour) {
        const bar = k.indexOf('|');
        if (Number(k.slice(0, bar)) < h0) continue;
        const org = k.slice(bar + 1);
        byOrg[org] = (byOrg[org] || 0) + v;
        total += v;
      }
    }
    for (const k of Object.keys(byOrg)) byOrg[k] = Math.round(byOrg[k]);
    return { total: Math.round(total), byOrg };
  }

  // Appels MCP de toutes les conversations lues (y compris celles des 7 derniers jours lues pour l'usage) :
  // Map serveur -> { count, lastTs, byDay: Map jour -> nombre, sessions: nombre de conversations }.
  get mcpUses() {
    const out = new Map();
    for (const s of this.allSessions()) {
      for (const [srv, m] of s.mcpUses) {
        let o = out.get(srv);
        if (!o) { o = { count: 0, lastTs: null, byDay: new Map(), sessions: 0 }; out.set(srv, o); }
        o.count += m.count; o.lastTs = tsMax(o.lastTs, m.lastTs); o.sessions++;
        for (const [d, n] of m.byDay) o.byDay.set(d, (o.byDay.get(d) || 0) + n);
      }
    }
    return out;
  }

  // Appels MCP depuis sinceIso (au jour près) : Map serveur -> nombre.
  mcpUsesSince(sinceIso) {
    const d0 = sinceIso ? dayKey(Date.parse(sinceIso)) : '';
    const out = new Map();
    for (const [srv, m] of this.mcpUses) {
      let n = 0;
      for (const [d, c] of m.byDay) if (d >= d0) n += c;
      out.set(srv, n);
    }
    return out;
  }

  // ---------- vues de la v1 (tableau de bord web, gardées tant que le serveur les sert) ----------

  summary(s) {
    const live = this.live.get(s.id);
    const now = Date.now();
    const today = s.byDay.get(dayKey(now)) || zero();
    const lastHour = s.byHour.get(Math.floor(now / HOUR)) || zero();
    const prevHour = s.byHour.get(Math.floor(now / HOUR) - 1) || zero();
    const agents = [...s.agents.values()].filter((a) => !a.runId);
    const wfs = [...s.workflows.values()];
    const tests = s.tests;
    const lastTest = tests.reduce((m, t) => (t.pending ? m : !m || String(t.ts) > String(m.ts) ? t : m), null);
    const lastLimit = s.limits.reduce((m, l) => (!m || l.ts > m.ts ? l : m), null);
    const agentLast = [...s.agents.values()].reduce((m, a) => (a.lastTs && a.lastTs > m ? a.lastTs : m), s.lastTs || '');
    return {
      id: s.id,
      title: s.title || live?.name || s.projectDir,
      name: live?.name || null,
      cwd: live?.cwd || s.cwd,
      project: path.basename(live?.cwd || s.cwd || s.projectDir),
      running: !!live,
      pid: live?.pid || null,
      status: live?.status || (live ? 'busy' : 'closed'),
      waitingFor: live?.waitingFor || null,
      entrypoint: live?.entrypoint || s.entrypoint || null,
      startedAt: live?.startedAt ? new Date(live.startedAt).toISOString() : s.firstTs,
      firstTs: s.firstTs, lastTs: s.lastTs, lastActivity: agentLast || null,
      lastLimit,
      lastPrompt: s.lastPrompt, lastUserMessage: s.lastUserMessage,
      gitBranch: s.gitBranch,
      counts: {
        tools: s.toolCount,
        agents: agents.length,
        agentsRunning: agents.filter((a) => this.agentStatus(s, a) === 'running').length,
        workflows: wfs.length,
        workflowsRunning: wfs.filter((w) => this.workflowStatus(s, w) === 'running').length,
        workflowAgents: [...s.agents.values()].filter((a) => a.runId).length,
        bgRunning: [...s.bgTasks.values()].filter((b) => this.bgStatus(b) === 'running').length,
        tests: tests.length,
        testsFailed: tests.filter((t) => t.ok === false && !t.red).length,
        files: s.files.size,
        filesCreated: [...s.files.values()].filter((f) => f.created).length,
        artifacts: s.artifacts.size,
      },
      lastTest: lastTest ? { ts: lastTest.ts, ok: lastTest.ok, kind: lastTest.kind, line: lastTest.line, description: lastTest.description } : null,
      tokens: { today, lastHour, prevHour, total: s.total },
      perms: s.perms,
      transcriptPath: s.transcriptPath,
    };
  }

  detail(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const agentName = (aid) => (aid ? s.agentLabel(aid) : null);
    const byTsDesc = (a, b) => String(b.ts).localeCompare(String(a.ts));
    const strip = ({ ch, ...t }) => t;
    return {
      summary: this.summary(s),
      totals: { activity: s.toolCount, background: s.bgTasks.size, tests: s.tests.length, limits: s.limitsTotal },
      activity: [...s.activity].sort(byTsDesc).slice(0, 800)
        .map((e) => ({ ...e, label: e.title, command: e.tool === 'Bash' ? e.detail : undefined, path: e.kind === 'file' ? e.detail : undefined, agent: agentName(e.agent) })),
      agents: [...s.agents.values()].filter((a) => !a.runId).map((a) => ({ ...a, usage: a.usage, status: this.agentStatus(s, a) }))
        .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || ''))),
      workflows: [...s.workflows.values()].map((w) => ({
        ...w,
        status: this.workflowStatus(s, w),
        agents: [...s.agents.values()].filter((a) => a.runId === w.runId).map((a) => ({ ...a, status: this.agentStatus(s, a) }))
          .sort((a, b) => String(a.firstTs || '').localeCompare(String(b.firstTs || ''))),
      })).sort((a, b) => String(b.startTs || '').localeCompare(String(a.startTs || ''))),
      background: [...s.bgTasks.values()].sort(byTsDesc).slice(0, 200)
        .map(({ test, ...b }) => ({ ...b, status: this.bgStatus(b), agent: agentName(b.agentId) })),
      tests: [...s.tests].sort(byTsDesc).slice(0, 600).map((t) => ({ ...strip(t), agent: agentName(t.agentId) })),
      limits: [...s.limits].sort(byTsDesc).map((l) => ({ ...l, agent: agentName(l.agent) })),
      files: [...s.files.values()].map((f) => ({ ...f, agents: [...f.agents].map((x) => (x === 'main' ? 'Conversation' : agentName(x))) }))
        .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs))),
      artifacts: [...s.artifacts.values()].map(({ chapters, ...a }) => ({ ...a, agents: [...a.agents].map((x) => (x === 'main' ? 'Conversation' : agentName(x))) }))
        .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs))),
    };
  }
}
