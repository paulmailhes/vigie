// État partagé entre le hook et le serveur : réglages (state.json) et historique (history.jsonl).
// Le hook ne fait que lire l'état ; seul le serveur (ou l'installeur) l'écrit, de façon atomique.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// VIGIE_DATA permet aux tests de travailler ailleurs que sur les vrais réglages.
export const DATA = process.env.VIGIE_DATA || path.join(ROOT, 'data');
export const STATE_FILE = path.join(DATA, 'state.json');
export const HISTORY_FILE = path.join(DATA, 'history.jsonl');
// Questions auxquelles Vigie a répondu à la place de l'utilisateur, et ce qu'il en a pensé ensuite.
export const QUESTIONS_FILE = path.join(DATA, 'questions.jsonl');
export const QUESTIONS_REVIEW_FILE = path.join(DATA, 'questions-review.json');

// Fichiers de configuration de Claude Code, des comptes, de Vigie elle-même et du shell.
// decisions.json et approvals.json : réponses et autorisations de l'utilisateur pour les actions sensibles, données
// depuis l'app (voir lib/decisions.mjs, lib/approvals.mjs) ; une conversation qui les écrirait se validerait elle-même.
// Le dossier où Vigie est installé (ses réglages et son hook ne se modifient jamais depuis une conversation).
const ROOT_RE = path.basename(ROOT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CONFIG_PATHS = String.raw`(?:\.claude/settings(?:\.local)?\.json|\.claude\.json|\.claude-comptes/|/(?:\.zshrc|\.zprofile|\.zshenv|\.bashrc|\.bash_profile|\.profile|\.gitconfig)\b|` + ROOT_RE + String.raw`/(?:data/|hook\.mjs|lib/state\.mjs)|Application Support/Code/User/settings\.json|\b(?:decisions|approvals)\.json\b)`;

// Garde-fous : actions qu'on ne valide jamais à ta place, même en auto-accept.
// `tool` est une regex sur le nom de l'outil (sans tenir compte de la casse), `match` (facultatif) une
// regex sur le texte de l'action (la commande pour Bash/Monitor/PowerShell, le JSON des paramètres sinon).
// Regex revues contre les contournements trouvés à la relecture v1 (rm -fr ~/Code, git -C … push -f,
// resend send-email, diskutil apfs…), sans toucher les commandes de tous les jours.
const SHELL = '^(Bash|Monitor|PowerShell)$';
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Dossier perso réel (passwd), même si HOME est changé (tests), plus HOME s'il diffère.
const HOMES = [...new Set([(() => { try { return os.userInfo().homedir; } catch { return ''; } })(), os.homedir()])]
  .filter((h) => h && h !== '/').map((h) => `|${reEscape(h)}`).join('');
const PROT = String.raw`(?:/|/Users|(?:~|\$\{?HOME\}?${HOMES})(?:/Code)?)`;
const PROT_END = String.raw`/?(?:\*|\.\*?)?["']?(?=$|[\s;&|)\x60])`;
const RM = [
  String.raw`\brm\s[^;&|\n]*?(?:^|\s|--\s)["']?` + PROT + PROT_END,
  String.raw`\brm\b[^;&|\n]*?\s["']?\$\{?\w+\}?/\*?["']?(?=$|[\s;&|)\x60])`, // "$DIR/" : variable vide = /
  String.raw`\bfind\s+["']?` + PROT + String.raw`/?["']?\s[^;&|\n]*(?:-delete\b|-exec\s+(?:\S*/)?rm\b)`,
  String.raw`\b(?:echo|printf)\s+["']?` + PROT + String.raw`/?["']?\s*\|\s*xargs\s+(?:\S*/)?rm\b`,
  String.raw`\bcd\s+["']?` + PROT + String.raw`/?["']?\s*(?:&&|;)\s*rm\s+-\w*[rR]\w*\s+(?:\*|\.)`,
].map((r) => `(?:${r})`).join('|');

export const DEFAULT_GUARDS = [
  { id: 'sudo', label: 'Commande administrateur (sudo)', tool: SHELL, match: String.raw`\bsudo\b` },
  { id: 'force-push', label: 'git push forcé ou suppression de branche distante', tool: SHELL,
    match: String.raw`\bgit\b(?:\s+(?:-[cC]\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)|--[\w-]+(?:=\S+)?))*\s+push\b[^;&|\n]*?(?:\s(?:--force(?:-with-lease|-if-includes)?\b|--mirror\b|--delete\b|-[a-zA-Z]*[fd][a-zA-Z]*\b)|\s["']?\+[\w./@^~-]+|\s["']?:[\w./-]+)` },
  { id: 'rm-racine', label: 'Suppression de /, de ton dossier perso ou de ~/Code', tool: SHELL, match: RM },
  { id: 'disque', label: 'Effacement de disque', tool: SHELL,
    match: String.raw`(?:\b(?:diskutil\s+(?:apfs\s+)?(?:erase\w*|zero\w*|secureErase|partition\w*|reformat|delete\w*)|newfs_\w+|mkfs|dd\s+[^;\n]*of=/dev/)|>\s*/dev/r?disk\d)` },
  { id: 'argent', label: 'Paiement ou opération bancaire',
    tool: String.raw`^mcp__.*(gocardless__(create|cancel)_|qonto__(?!get_|list_)|stripe.*__(create|cancel|refund|delete|update|finalize|pay|void|capture|stripe_api_write|manage_stripe_accounts)|pennylane__run_operations|paddle-live__execute|vercel__(buy|create_or_transfer)|__(buy|purchase|checkout|pay|charge|transfer|refund)([_-]|$))` },
  { id: 'email', label: 'Envoi ou suppression d\'e-mail',
    tool: String.raw`^(?!mcp__ccd_session_mgmt__)mcp__.*(gmail__(send_message|forward|reply|trash_|delete_)|resend__(send|create-api-key)|lemlist__(?!get|list|search|authenticate|complete_auth)|(__|_)send[_-]?(e?mail|message|campaign|broadcast)(?!_draft)|__(forward|reply|reply_all|trash_message|trash_thread)$)` },
  { id: 'reseaux', label: 'Publication sur les réseaux sociaux', tool: '^mcp__.*Metricool__(createScheduledPost|updateScheduledPost|sendScheduledPostForReview)' },
  // Claude Code demande toujours confirmation avant de toucher à ses propres réglages ou à tes profils de shell :
  // ce sont justement les demandes que Vigie ne doit jamais valider à ta place.
  { id: 'config-claude', label: 'Modification des réglages de Claude Code, de Vigie ou de ton shell',
    tool: '^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$', match: CONFIG_PATHS },
  { id: 'config-claude-shell', label: 'Modification des réglages de Claude Code, de Vigie ou de ton shell', tool: SHELL,
    match: String.raw`(?:>>?|\btee\b|\bsed\s+(?:-\w+\s+)*-i|\b(?:cp|mv|rm|ln|chmod|truncate)\b)[^;&|\n]*(?:` + CONFIG_PATHS + ')' },
  // POST sur l'API de Vigie, ou script qui touche aux décisions ou autorisations de l'utilisateur (decisions.json, approvals.json).
  { id: 'api-vigie', label: 'Réglage de Vigie depuis une commande', tool: SHELL,
    match: String.raw`\b(?:curl|wget|http|node|python3?)\b[^\n]*(?:127\.0\.0\.1|localhost):4777[^\n]*(?:-X\s*['"]?POST|--data|\s-d\s|method\s*:\s*['"]POST)|\b(?:node|deno|bun|python[\d.]*|perl|ruby|osascript|swift)\b[\s\S]*\b(?:decisions|approvals)\.json\b` },
  { id: 'cloud', label: 'Suppression ou partage dans tes comptes en ligne',
    tool: '^mcp__.*(Google_Drive__(trash_file|share_file)|Notion__notion-delete|Calendar__delete_event|N8N__archive_workflow|notion-calendar-cancel|affine__delete_)' },
];

export const QUESTION_MODES = ['ask', 'wait', 'auto'];
export const GUARD_MODES = ['vigie', 'vscode'];

export const DEFAULT_STATE = {
  version: 1,
  autoAccept: false,        // valeur par défaut pour toutes les conversations
  questions: 'ask',         // 'ask' : toujours te demander · 'wait' : option recommandée après N min sans réponse · 'auto' : tout de suite (ancien réglage)
  questionWaitMin: 20,
  connectorsDefault: 'off', // connecteurs de compte (claude.ai) : coupés sauf demande contraire
  // mode : 'vigie' (action sensible refusée sur le moment, l'utilisateur l'autorise une fois dans Vigie) | 'vscode' (fenêtre
  // VS Code proposée waitMin minutes, ancien comportement).
  guard: { enabled: true, mode: 'vigie', waitMin: 10, rules: DEFAULT_GUARDS },
  sessions: {},             // { [sessionId]: { autoAccept?: bool, questions?: string, connectors?: 'on'|'off' } } — absent = suit le réglage global
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const minutes = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

// Les règles d'origine viennent toujours du code (un correctif de regex doit atteindre le hook en
// production) ; de state.json on ne garde que leur interrupteur et les règles ajoutées à la main.
export function mergeGuardRules(saved) {
  const list = Array.isArray(saved) ? saved.filter(isObj) : [];
  const byId = new Map(list.filter((r) => typeof r.id === 'string').map((r) => [r.id, r]));
  const ids = new Set(DEFAULT_GUARDS.map((r) => r.id));
  return [
    ...DEFAULT_GUARDS.map((d) => ({ ...d, disabled: byId.get(d.id)?.disabled === true })),
    ...list.filter((r) => !ids.has(r.id) && typeof r.label === 'string' && (typeof r.tool === 'string' || typeof r.match === 'string')),
  ];
}

// Toute valeur anormale retombe sur la valeur prudente, jamais l'inverse.
export function readState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return structuredClone(DEFAULT_STATE); }
  if (!isObj(s)) return structuredClone(DEFAULT_STATE);
  const g = isObj(s.guard) ? s.guard : {};
  return {
    ...DEFAULT_STATE,
    ...s,
    autoAccept: s.autoAccept === true,
    questions: QUESTION_MODES.includes(s.questions) ? s.questions : 'ask',
    questionWaitMin: minutes(s.questionWaitMin, DEFAULT_STATE.questionWaitMin),
    connectorsDefault: s.connectorsDefault === 'on' ? 'on' : 'off',
    guard: { ...g, enabled: g.enabled !== false, mode: g.mode === 'vscode' ? 'vscode' : 'vigie', waitMin: minutes(g.waitMin, DEFAULT_STATE.guard.waitMin), rules: mergeGuardRules(g.rules ?? DEFAULT_GUARDS) },
    sessions: isObj(s.sessions) ? s.sessions : {},
  };
}

export function writeState(state) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

export function effective(state, sessionId) {
  const all = isObj(state.sessions) ? state.sessions : {};
  const s = (Object.hasOwn(all, String(sessionId)) && isObj(all[sessionId])) ? all[sessionId] : {};
  return {
    autoAccept: typeof s.autoAccept === 'boolean' ? s.autoAccept : state.autoAccept === true,
    questions: QUESTION_MODES.includes(s.questions) ? s.questions : QUESTION_MODES.includes(state.questions) ? state.questions : 'ask',
    connectors: s.connectors === 'on' || s.connectors === 'off' ? s.connectors : state.connectorsDefault === 'on' ? 'on' : 'off',
  };
}

// L'API v2 n'expose qu'un interrupteur « Claude choisit l'option recommandée quand je ne suis pas là ».
// Activé = 'wait'. L'ancien 'auto' (réponse immédiate) est montré activé lui aussi, pour ne pas faire
// croire à l'utilisateur que Claude l'attend alors qu'il répond à sa place.
export const questionsAuto = (state) => state.questions === 'wait' || state.questions === 'auto';
export const questionsMode = (on) => (on ? 'wait' : 'ask');

export function appendHistory(entry) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* l'historique ne doit jamais bloquer une décision */ }
}

// Texte sur lequel portent les garde-fous et qu'on affiche dans l'historique.
export function actionText(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'AskUserQuestion') return (input.questions || []).map((q) => `${q.question} [${(q.options || []).map((o) => o.label).join(' / ')}]`).join('\n');
  if (toolName === 'ExitPlanMode') return 'Valider le plan proposé';
  if (SHELL_TOOLS.has(toolName)) return String(input.command || '');
  if (input.file_path) return String(input.file_path);
  if (input.url) return String(input.url);
  return JSON.stringify(input);
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

// ---------- texte vraiment exécuté (Bash, Monitor) ----------
// Un message de commit ou de PR, ou un fichier écrit avec cat, qui CITE « sudo » ou « git push --force » :
// ce texte ne s'exécute pas. executedText lit la commande comme le shell (guillemets, $( ), heredocs…)
// et n'en retire que deux sortes de texte :
//  - le corps d'un heredoc à délimiteur entre guillemets ('EOF' ou "EOF") donné à git commit/tag/notes,
//    gh ou glab ; ou à cat/tee qui l'affichent, l'écrivent dans un document (.md, .txt…), ou le passent
//    au message d'un git commit / gh (« git commit -m "$(cat <<'EOF' … EOF)" ») ;
//  - l'argument de -m/--message/--title/--body/-t/-b de git commit/tag/merge/stash/notes, gh ou glab,
//    entre apostrophes ou entre guillemets sans $( ) ni ` (une variable $X ne lance rien).
// Le reste est gardé : bash <<'EOF', « | bash », $(sudo …), xargs sudo, un script, un Makefile ou un
// hook git écrits avec cat (ils peuvent être lancés ensuite), un document lancé dans la même commande
// (bash notes.md, make, npm…). Au moindre doute (case, sous-shell inattendu, guillemet non fermé,
// construction inconnue), rien n'est retiré : le garde-fou voit la commande entière.
const PARSED_TOOLS = new Set(['Bash', 'Monitor']);
const MSG_FLAGS = new Set(['-m', '--message', '--title', '--body', '-t', '-b']);
const MSG_EQ = /^--(?:message|title|body)=(?=['"])/;
const MSG_CMDS = new Set(['gh', 'glab']);
const MSG_GIT = new Set(['commit', 'tag', 'merge', 'stash', 'notes']); // git : seulement ces commandes (un alias pourrait lancer ses arguments)
const GIT_OPT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/;
const PREFIX_WORDS = new Set(['command', 'builtin', 'env', 'nohup', 'time', 'noglob', 'exec', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
// Lecteurs de texte : ce qu'on leur passe par un tuyau n'est pas exécuté.
const SAFE_SINKS = new Set(['cat', 'tee', 'pbcopy', 'wc', 'head', 'tail', 'grep', 'sort', 'uniq', 'less', 'more']);
// Fichiers où l'on peut écrire du texte qui cite une commande : documents, notes, journaux.
const DOC_FILE = /^(?:.*\.(?:md|markdown|mdx|txt|text|rst|adoc|org|csv|tsv|log|html?)|\/dev\/(?:null|stdout|stderr)|\d+|-)$/i;
// Dans la suite de la commande, de quoi lancer un fichier qu'on vient d'écrire.
const RUNS_FILES = /(?:^|[\s;&|(`])(?:\S*\/)?(?:bash|sh|zsh|dash|ksh|fish|source|eval|exec|python[\d.]*|node|deno|bun|bunx|perl|ruby|php|osascript|open|make|xargs|chmod|npm|npx|pnpm|yarn|launchctl|crontab)(?=$|[\s;&|)`])|(?:^|[\s;&|(`])\.{1,2}\/|(?:^|[\s;&|(`])\.(?=\s)/;
const unq = (w) => String(w).replace(/\\(.)/g, '$1').replace(/['"]/g, '');

function cmdInfo(words) {
  const ws = words.map(unq);
  let k = 0;
  while (k < ws.length && (/^[A-Za-z_]\w*=/.test(ws[k]) || PREFIX_WORDS.has(ws[k]))) k++;
  const name = ws[k] ? ws[k].replace(/^.*\//, '') : '';
  let sub = null;
  if (name === 'git') {
    for (let j = k + 1; j < ws.length; j++) {
      if (GIT_OPT_VALUE.test(ws[j])) { j++; continue; }
      if (ws[j].startsWith('-')) continue;
      sub = ws[j];
      break;
    }
  }
  return { name, sub, args: ws.slice(k + 1) };
}
// Commandes qui font du texte reçu un message (commit, tag, PR…), jamais une commande.
const consumer = (info) => (info.name === 'git' && ['commit', 'tag', 'notes'].includes(info.sub)) || info.name === 'gh' || info.name === 'glab';

export function executedText(cmd) {
  const src = String(cmd ?? '');
  try { return stripQuoted(src); } catch { return src; }
}

function stripQuoted(src) {
  const n = src.length;
  if (n > 200_000) return src; // commande démesurée : on ne retire rien
  const cuts = [];      // [début, fin[ : texte qui ne s'exécute pas
  const docs = [];      // heredocs lus, jugés à la fin (quand toute la commande est connue)
  let pending = [];     // heredocs ouverts sur la ligne en cours : leur corps commence à la ligne suivante
  let doubt = false;    // construction mal comprise : on ne retire rien
  let grouping = false; // ( … ) ou { … } : la sortie d'un cat peut partir ailleurs
  const mkCtx = (opener, parentCmd) => ({ kind: 'cmd', opener, parentCmd, cmd: null, word: null, redir: false, pipeFrom: null });
  const stack = [mkCtx('root', null)];
  const top = () => stack[stack.length - 1];
  function cmdOf(ctx) {
    if (!ctx.cmd) {
      ctx.cmd = { words: [], redir: [], next: null, procSubst: false, name: null, sub: null, skip: false };
      if (ctx.pipeFrom) { ctx.pipeFrom.next = ctx.cmd; ctx.pipeFrom = null; }
    }
    return ctx.cmd;
  }
  function endWord(ctx) {
    if (ctx.word === null) return;
    const c = cmdOf(ctx);
    if (ctx.redir) { c.redir.push(ctx.word); ctx.redir = false; } else {
      if (c.words.length === 0 && ctx.word === '{') grouping = true;
      if (ctx.word === 'case' || ctx.word === 'esac') doubt = true; // motifs « a) » : parenthèses sans pareille
      c.words.push(ctx.word);
      // nom de la commande (et sous-commande de git), notés au fil des mots : pas de relecture à chaque mot
      const w = unq(ctx.word);
      if (c.name === null) { if (!/^[A-Za-z_]\w*=/.test(w) && !PREFIX_WORDS.has(w)) c.name = w.replace(/^.*\//, ''); }
      else if (c.name === 'git' && c.sub === null) {
        if (c.skip) c.skip = false;
        else if (GIT_OPT_VALUE.test(w)) c.skip = true;
        else if (!w.startsWith('-')) c.sub = w;
      }
    }
    ctx.word = null;
  }
  const boundary = (ctx) => { endWord(ctx); ctx.cmd = null; ctx.redir = false; };
  const startWord = (ctx) => { if (ctx.word === null) { cmdOf(ctx); ctx.word = ''; } };
  // Retour dans le contexte parent après ) ou ` : le mot qui contenait la substitution continue.
  const resume = (text) => { const p = top(); if (p.kind === 'cmd') p.word = (p.word ?? '') + text; else p.owner.word += text; };

  // -m 'texte' / --body="texte" juste après git, gh ou glab : renvoie la position après l'argument, ou -1.
  function messageAt(ctx, i) {
    const cm = ctx.cmd;
    if (!cm || ctx.redir || !(MSG_CMDS.has(cm.name) || (cm.name === 'git' && MSG_GIT.has(cm.sub)))) return -1;
    let q = i;
    if (src[i] === '-') {
      const m = MSG_EQ.exec(src.slice(i, i + 12));
      if (!m) return -1;
      q = i + m[0].length;
    } else if (!MSG_FLAGS.has(unq(cm.words.at(-1) ?? ''))) return -1;
    let end;
    if (src[q] === "'") {
      end = src.indexOf("'", q + 1);
      if (end < 0) return -1;
    } else if (src[q] === '"') {
      let j = q + 1;
      for (; j < n && src[j] !== '"'; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) return -1;
      }
      if (j >= n) return -1;
      end = j;
    } else return -1;
    if (end + 1 < n && !/[\s;&|)<>]/.test(src[end + 1])) return -1; // l'argument continue : on ne s'y fie pas
    if (pending.length && src.slice(q, end).includes('\n')) return -1;
    cuts.push([q + 1, end]);
    ctx.word = src.slice(i, q + 1) + src[q];
    return end + 1;
  }

  function heredocOp(ctx, i) {
    let j = i + 2;
    const dash = src[j] === '-';
    if (dash) j++;
    while (src[j] === ' ' || src[j] === '\t') j++;
    let delim = '';
    let quoted = false;
    while (j < n && !/[\s;&|<>()]/.test(src[j])) {
      const ch = src[j];
      if (ch === "'" || ch === '"') {
        const e = src.indexOf(ch, j + 1);
        if (e < 0) throw new Error('délimiteur');
        delim += src.slice(j + 1, e);
        quoted = true;
        j = e + 1;
        continue;
      }
      if (ch === '\\') { delim += src[j + 1] ?? ''; quoted = true; j += 2; continue; }
      if (ch === '$' || ch === '`') doubt = true;
      delim += ch;
      j++;
    }
    if (!delim) doubt = true;
    endWord(ctx);
    pending.push({ ctx, cmd: cmdOf(ctx), delim, quoted, dash, opEnd: j, inBacktick: stack.some((s) => s.opener === '`') });
    return j;
  }

  // Corps des heredocs ouverts sur la ligne qui vient de finir : jusqu'à la ligne qui vaut exactement le
  // délimiteur (tabulations de tête retirées pour <<-), comme bash et zsh.
  function bodies(i) {
    for (const d of pending) {
      const bodyStart = i;
      let k = i;
      let found = false;
      while (k < n) {
        let e = src.indexOf('\n', k);
        if (e < 0) e = n;
        const line = d.dash ? src.slice(k, e).replace(/^\t+/, '') : src.slice(k, e);
        if (line === d.delim) { docs.push({ ...d, bodyStart, bodyEnd: k, after: Math.min(e + 1, n) }); i = Math.min(e + 1, n); found = true; break; }
        k = e + 1;
      }
      if (!found) { docs.push({ ...d, bodyStart, bodyEnd: n, after: n, open: true }); i = n; }
    }
    pending = [];
    return i;
  }

  let i = 0;
  while (i < n) {
    const ctx = top();
    const c = src[i];
    if (ctx.kind === 'dq') { // "…" ou ${…} : seuls $( ), $(( )) et ` y lancent quelque chose
      const o = ctx.owner;
      if (c === '\\') { o.word += src.slice(i, i + 2); i += 2; continue; }
      if (c === ctx.close) { o.word += c; stack.pop(); i++; continue; }
      if (c === '`') { o.word += c; stack.push(mkCtx('`', cmdOf(o))); i++; continue; }
      if (c === '$' && src[i + 1] === '(') {
        if (src[i + 2] === '(') { o.word += '$(('; stack.push({ kind: 'arith', depth: 0, owner: o }); i += 3; continue; }
        o.word += '$('; stack.push(mkCtx('$(', cmdOf(o))); i += 2; continue;
      }
      if (c === '\n' && pending.length) doubt = true;
      o.word += c;
      i++;
      continue;
    }
    if (ctx.kind === 'arith') { // $(( … )) : des $( ) peuvent s'y cacher
      if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') { stack.push(mkCtx('$(', cmdOf(ctx.owner))); i += 2; continue; }
      if (c === '`' || (c === '\n' && pending.length)) doubt = true;
      if (c === '(') ctx.depth++;
      else if (c === ')') {
        if (ctx.depth > 0) ctx.depth--;
        else if (src[i + 1] === ')') { stack.pop(); ctx.owner.word += '))'; i += 2; continue; } else doubt = true;
      }
      i++;
      continue;
    }
    // contexte de commande
    if (c === '`' && ctx.opener === '`') { endWord(ctx); if (pending.length) doubt = true; stack.pop(); resume('`'); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(ctx); i++; continue; }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; } // suite de ligne
      startWord(ctx);
      ctx.word += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '\n') {
      boundary(ctx);
      i++;
      if (pending.length) i = bodies(i);
      continue;
    }
    if (c === '#' && ctx.word === null) { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === ';') { if (src[i + 1] === ';' || src[i + 1] === '&') doubt = true; boundary(ctx); ctx.pipeFrom = null; i++; continue; }
    if (c === '&') {
      if (src[i + 1] === '>') { endWord(ctx); ctx.redir = true; i += src[i + 2] === '>' ? 3 : 2; continue; }
      boundary(ctx);
      ctx.pipeFrom = null;
      i += src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') { boundary(ctx); ctx.pipeFrom = null; i += 2; continue; }
      endWord(ctx);
      ctx.pipeFrom = ctx.cmd || ctx.pipeFrom;
      ctx.cmd = null;
      ctx.redir = false;
      i += src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '<' || c === '>') {
      if (src[i + 1] === '(') { // <( … ) >( … ) : la sortie part dans une autre commande
        startWord(ctx);
        const cm = cmdOf(ctx);
        cm.procSubst = true;
        ctx.word += `${c}(`;
        stack.push(mkCtx(`${c}(`, cm));
        i += 2;
        continue;
      }
      if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') { endWord(ctx); i += 3; continue; } // <<< : le mot qui suit est une chaîne
      if (c === '<' && src[i + 1] === '<') { i = heredocOp(ctx, i); continue; }
      endWord(ctx);
      ctx.redir = true;
      i += /[>|&]/.test(src[i + 1] ?? '') ? 2 : 1;
      continue;
    }
    if (c === '(') {
      if (ctx.word !== null) doubt = true; // mot( … : glob zsh, tableau, fonction… : on ne s'y fie pas
      else { grouping = true; cmdOf(ctx).words.push('('); }
      stack.push(mkCtx('(', ctx.cmd));
      i++;
      continue;
    }
    if (c === ')') {
      endWord(ctx);
      if (['$(', '(', '<(', '>('].includes(ctx.opener)) {
        if (pending.length) doubt = true;
        stack.pop();
        if (ctx.opener !== '(') resume(')');
        i++;
        continue;
      }
      doubt = true; // ) sans ( : motif de case, ou construction inconnue
      i++;
      continue;
    }
    if (ctx.word === null && (c === "'" || c === '"' || c === '-')) {
      const j = messageAt(ctx, i);
      if (j >= 0) { i = j; continue; }
    }
    if (c === "'") {
      startWord(ctx);
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error('apostrophe');
      if (pending.length && src.slice(i, j).includes('\n')) doubt = true;
      ctx.word += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') { startWord(ctx); ctx.word += c; stack.push({ kind: 'dq', close: '"', owner: ctx }); i++; continue; }
    if (c === '`') { startWord(ctx); ctx.word += c; stack.push(mkCtx('`', cmdOf(ctx))); i++; continue; }
    if (c === '$') {
      startWord(ctx);
      if (src[i + 1] === '(' && src[i + 2] === '(') { ctx.word += '$(('; stack.push({ kind: 'arith', depth: 0, owner: ctx }); i += 3; continue; }
      if (src[i + 1] === '(') { ctx.word += '$('; stack.push(mkCtx('$(', cmdOf(ctx))); i += 2; continue; }
      if (src[i + 1] === '{') { ctx.word += '${'; stack.push({ kind: 'dq', close: '}', owner: ctx }); i += 2; continue; }
      if (src[i + 1] === "'") { // $'…' : échappements à la C
        let j = i + 2;
        while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
        if (j >= n) throw new Error('apostrophe');
        ctx.word += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      ctx.word += c;
      i++;
      continue;
    }
    startWord(ctx);
    ctx.word += c;
    i++;
  }
  endWord(top());
  if (doubt || pending.length || stack.length !== 1) return src;

  function strippable(d) {
    if (!d.quoted || d.open || d.inBacktick || d.cmd.procSubst) return false;
    const info = cmdInfo(d.cmd.words);
    const files = [...d.cmd.redir];
    if (info.name === 'tee') files.push(...info.args.filter((a) => !a.startsWith('-')));
    for (let c = d.cmd.next; c; c = c.next) { // tuyau : la suite doit seulement lire du texte
      const ni = cmdInfo(c.words);
      if (c.procSubst || !(SAFE_SINKS.has(ni.name) || consumer(ni))) return false;
      files.push(...c.redir);
      if (ni.name === 'tee') files.push(...ni.args.filter((a) => !a.startsWith('-')));
    }
    if (consumer(info)) return true;
    if (info.name !== 'cat' && info.name !== 'tee') return false;
    // cat dans « $( ) » : le texte devient le message du git commit / gh qui l'entoure
    if (d.ctx.opener === '$(') return files.length === 0 && !!d.ctx.parentCmd && consumer(cmdInfo(d.ctx.parentCmd.words));
    if (d.ctx.opener !== 'root' || grouping) return false;
    // seulement un document, que la suite de la commande (fin de la ligne d'ouverture comprise) ne lance pas
    if (!files.every((f) => DOC_FILE.test(unq(f)))) return false;
    const rest = `${src.slice(d.opEnd, d.bodyStart)}\n${src.slice(d.after)}`;
    if (RUNS_FILES.test(rest)) return false;
    for (const f of files) {
      const base = unq(f).replace(/^.*\//, '');
      // lancé directement : en tête de commande (./notes.md, ~/x/notes.md…)
      if (base && new RegExp(String.raw`(?:^|(?<![<>])[;&|(\x60\n])\s*["']?(?:[^\s;&|<>()'"\x60]*/)?${reEscape(base)}(?=$|[\s;&|)'"])`).test(rest)) return false;
    }
    return true;
  }
  for (const d of docs) if (strippable(d)) cuts.push([d.bodyStart, d.bodyEnd]);
  if (!cuts.length) return src;
  cuts.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of cuts) {
    if (s < pos) continue;
    out += src.slice(pos, s);
    pos = e;
  }
  return out + src.slice(pos);
}

// Commande de lecture seule (grep, cat, ls, git log…) qui ne fait que CITER un mot sensible : Claude Code ne
// demande pas de permission pour elle, l'attente « seulement par Vigie » (PreToolUse) ne la retient donc pas.
// Au moindre doute ($( ), backquote, <( ), écriture dans un fichier, commande inconnue) : pas lecture seule.
const READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'less', 'more', 'ls', 'wc', 'jq', 'echo',
  'printf', 'sort', 'uniq', 'cut', 'tr', 'diff', 'stat', 'file', 'which', 'nl', 'column', 'true', 'pwd', 'basename',
  'dirname', 'realpath', 'find', 'git']);
const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'grep', 'blame', 'rev-parse', 'ls-files', 'shortlog', 'describe', 'reflog']);
export function readOnlyShell(toolName, input) {
  if (toolName !== 'Bash' && toolName !== 'Monitor') return false;
  const text = executedText(String(input?.command ?? ''));
  if (/`|\$\(|[<>]\(/.test(text)) return false;
  const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');
  if (/['"]/.test(bare)) return false; // guillemet non fermé
  if (/>/.test(bare.replace(/(?:\d|&)?>>?\s*(?:&\d|\/dev\/null)/g, ''))) return false;
  for (const seg of bare.split(/\|\||&&|[;|&\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
    if (!words.length) continue;
    const name = words[0].replace(/^.*\//, '');
    const args = words.slice(1);
    if (!READERS.has(name)) return false;
    if (name === 'sort' && args.some((a) => /^-[a-zA-Z]*o|^--output/.test(a))) return false; // écrit un fichier
    if (name === 'rg' && args.some((a) => /^--pre/.test(a))) return false;                    // lance une commande
    if (name === 'find' && args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(a))) return false;
    if (name === 'git') {
      // -c / --config-env peuvent régler un pager ou un outil qui lance n'importe quoi ; --output écrit un fichier
      if (args.some((a) => /^(?:-c|--config-env|--output|--ext-diff|--exec-path)/.test(a))) return false;
      let k = 0;
      while (k < args.length && args[k].startsWith('-')) k += args[k] === '-C' ? 2 : 1;
      if (!GIT_READ.has(args[k])) return false;
    }
  }
  return true;
}

export function matchGuard(state, toolName, input) {
  if (!state.guard?.enabled) return null;
  const raw = actionText(toolName, input);
  const text = PARSED_TOOLS.has(toolName) ? executedText(raw) : raw;
  for (const r of state.guard.rules || []) {
    try {
      if (r.disabled) continue;
      if (r.tool && !new RegExp(r.tool, 'i').test(toolName)) continue;
      if (r.match && !new RegExp(r.match, 'i').test(text)) continue;
      return r;
    } catch { /* une regex invalide ne casse pas les autres */ }
  }
  return null;
}
