#!/usr/bin/env node
// Vigie — hook Claude Code branché sur PermissionRequest, PreToolUse (questions) et PermissionDenied.
//
// PermissionRequest tourne EN MÊME TEMPS que la fenêtre de validation de VS Code : la première
// réponse gagne (vérifié sur le binaire 2.1.301). Répondre tout de suite = auto-accept ;
// attendre N minutes puis répondre = « je te laisse la main, sinon je décide ».
// Si l'utilisateur répond lui-même, Claude Code tue le hook (SIGTERM) : on note l'interruption, sans répondre.
// L'utilisateur peut aussi décider d'une action sensible depuis l'app Vigie (data/decisions.json, lib/decisions.mjs).
// Mode « seulement par Vigie » (guard.mode = 'vigie', par défaut) : PreToolUse retient l'action sensible AVANT
// toute fenêtre de validation, le temps que l'utilisateur l'autorise dans Vigie (guard.waitMin minutes) : elle part alors
// dans sa conversation. Sans réponse : refus, la conversation continue le reste ; une autorisation donnée plus
// tard vaut pour la relance à l'identique (data/approvals.json, lib/approvals.mjs).
// Toute erreur => on ne répond rien => la fenêtre normale s'affiche. Jamais l'inverse.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState, effective, appendHistory, actionText, matchGuard, readOnlyShell, QUESTIONS_FILE, HISTORY_FILE, DATA } from './lib/state.mjs';
import { pickRecommended, buildRecord, appendRecord } from './lib/questions.mjs';
import { clearDecision, takeDecision, takeAnswer, MAX_COMMAND } from './lib/decisions.mjs';
import { callHash, newApprovalId, takeApproval, deniedApproval } from './lib/approvals.mjs';

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Branché pour Codex (~/.codex/hooks.json) : « hook.mjs --vigie --codex ».
const CODEX = process.argv.includes('--codex');
// Outils qui exigent un humain : Claude Code ignore un « allow » sans réponse fournie.
const HUMAN_ONLY = new Set(['OfferChromeSetup', 'PublishPlugin', 'ShowOnboardingRolePicker']);
// VIGIE_POLL_MS et VIGIE_HOOK_LIFETIME_MS ne servent qu'aux tests.
const POLL_MS = Math.max(20, Number(process.env.VIGIE_POLL_MS) || 3000);
// Le hook s'arrête de lui-même avant son délai dans settings.json (7300 s), sans répondre.
const HARD_END = Date.now() + (Number(process.env.VIGIE_HOOK_LIFETIME_MS) || 7_250_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

// Écrit la réponse et attend qu'elle soit partie : un tube macOS n'avale que 64 Ko d'un coup, et
// un plan de 80 Ko coupé par process.exit() serait ignoré par Claude Code.
process.stdout.on('error', () => { /* Claude Code ne lit plus : rien à faire */ });
function reply(obj) {
  return new Promise((resolve) => {
    try { process.stdout.write(JSON.stringify(obj), (err) => resolve(!err)); } catch { resolve(false); }
  });
}

// Dès qu'un garde-fou est en jeu, l'action est notée en entier (4000 caractères au plus) : L'utilisateur la relit
// dans l'app avant de décider, ou la lance lui-même dans Terminal. Sinon 600 caractères suffisent.
let guarded = false;
// pid : le serveur et l'app reconnaissent ainsi les lignes d'une même attente (et si elle vit encore).
function log(input, event, extra = {}) {
  const ti = input.tool_input || {};
  appendHistory({
    event,
    sessionId: input.session_id,
    cwd: input.cwd,
    agentId: input.agent_id || undefined,
    tool: input.tool_name,
    action: actionText(input.tool_name, ti).slice(0, guarded ? MAX_COMMAND : 600),
    description: typeof ti.description === 'string' ? ti.description.slice(0, 200) : undefined,
    pid: process.pid,
    ...(CODEX ? { app: 'codex' } : {}),
    ...extra,
  });
}
const ruleInfo = (rule) => ({ rule: rule.label, ruleId: typeof rule.id === 'string' ? rule.id : undefined });

// Pendant une attente, un SIGTERM veut dire « L'utilisateur a répondu dans VS Code » : on le note pour que
// le tableau de bord n'affiche pas une attente fantôme, et on sort sans répondre.
let onKill = null;
let killed = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (killed) return;
    killed = true;
    try { onKill?.(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// Conversation lancée depuis VS Code (ou le SDK) : la fenêtre et le hook tournent en parallèle,
// on peut donc attendre sans rien bloquer. Dans le terminal, on ne prend pas ce risque.
function canWait(input) {
  if (input.agent_id) return false; // sous-agent : personne ne peut lui répondre
  const dirs = [path.join(os.homedir(), '.claude', 'sessions')];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'));
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; } // un fichier abîmé ne compte pas
      if (s?.sessionId === input.session_id) return /vscode|sdk|desktop/i.test(String(s.entrypoint || ''));
    }
  }
  return false;
}

// Claude Code est mort (fenêtre rechargée, plantage) : la demande n'attend plus personne.
function orphan() {
  if (process.ppid === 1) return true;
  const cp = Number(process.env.CLAUDE_PID) || 0;
  if (cp > 1) { try { process.kill(cp, 0); } catch (e) { if (e?.code === 'ESRCH') return true; } }
  return false;
}

// Attend en relisant les réglages toutes les POLL_MS. `still(state)` renvoie true pour continuer, ou
// une raison qui termine l'attente ; `deadline()` est relu à chaque tour (L'utilisateur peut changer le délai).
// Renvoie aussi 'timeout' (échéance), 'orphelin' ou 'fin' (plafond de vie du hook).
// Le transcript n'est lu que pour retrouver l'appel d'outil identique à la demande et son résultat
// (transcriptWatcher) : le résultat d'un autre outil n'est jamais pris pour une réponse de l'utilisateur.
async function waitFor(deadline, still) {
  for (;;) {
    const d = deadline();
    if (Number.isNaN(d)) return 'fin'; // délai incompréhensible : on ne répond rien
    const end = Math.min(d, HARD_END);
    const left = end - Date.now();
    if (left <= 0) return end >= HARD_END ? 'fin' : 'timeout';
    await sleep(Math.min(POLL_MS, left));
    if (orphan()) return 'orphelin';
    const r = still(readState());
    if (r !== true) return r;
  }
}

// Repli du mode auto : après 2 refus du classifieur d'affilée, Claude Code transforme le 3e refus
// en fenêtre de validation. L'accepter reviendrait à valider ce que le classifieur vient de bloquer.
function transcriptFor(input) {
  const tp = String(input.transcript_path || '');
  if (!tp || !input.agent_id) return tp || null;
  if (!/^[\w-]+$/.test(String(input.agent_id))) return null;
  const sub = path.join(tp.replace(/\.jsonl$/, ''), 'subagents');
  const direct = path.join(sub, `agent-${input.agent_id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const wf of fs.readdirSync(path.join(sub, 'workflows'))) {
      const p = path.join(sub, 'workflows', wf, `agent-${input.agent_id}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* pas de workflow */ }
  return null;
}

// L'utilisateur a-t-il déjà répondu dans VS Code ? On cherche, dans la fin du transcript, l'appel d'outil
// identique à cette demande (même outil, mêmes paramètres, après le début de l'attente) puis son résultat.
// Claude Code ne tue pas toujours le hook quand l'utilisateur répond (vu le 2026-10-20 : branche supprimée en 20 s,
// « refus » noté 10 min plus tard) ; ce suivi précis remplace l'ancienne lecture trop large du transcript.
// Suivi du transcript pendant une attente : au premier passage, ses 2 derniers Mo (l'appel d'outil vient d'y
// être écrit) ; ensuite, seulement ce qui s'y ajoute. Un transcript peut dépasser 200 Mo et grossir de plusieurs
// Mo par minute : relire chaque fois les 2 derniers Mo laissait passer la réponse de l'utilisateur (2026-10-20).
// Même appel d'outil : son identifiant si Claude Code le donne, sinon les mêmes paramètres (ordre des champs
// ignoré), sinon, pour une question, le même texte (Claude Code 2.1.304 ajoute parfois des champs à l'entrée).
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
function transcriptWatcher(input, sinceMs) {
  const tp = transcriptFor(input);
  const want = canon(input.tool_input ?? null);
  const firstQuestion = (i) => (Array.isArray(i?.questions) ? i.questions[0]?.question : null) ?? null;
  const question = QUESTION_TOOLS.has(input.tool_name) ? firstQuestion(input.tool_input) || (input.tool_input?.plan ? String(input.tool_input.plan).slice(0, 200) : null) : null;
  const same = (b) => b.name === input.tool_name && (canon(b.input ?? null) === want
    || (question && (firstQuestion(b.input) === question || (b.input?.plan && String(b.input.plan).slice(0, 200) === question))));
  const ids = new Set();
  if (typeof input.tool_use_id === 'string' && input.tool_use_id) ids.add(input.tool_use_id);
  let offset = null, carry = '';
  const scan = (line) => {
    if (!line.includes(input.tool_name) && !(ids.size && line.includes('tool_result'))) return null;
    let r; try { r = JSON.parse(line); } catch { return null; }
    const content = r?.message?.content;
    if (!Array.isArray(content)) return null;
    if (r.type === 'assistant' && Date.parse(r.timestamp || 0) >= sinceMs - 120_000) {
      for (const b of content) if (b?.type === 'tool_use' && same(b)) ids.add(b.id);
    } else if (r.type === 'user') {
      for (const b of content) {
        if (b?.type === 'tool_result' && ids.has(b.tool_use_id)) {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          return { ok: !b.is_error, extrait: text.slice(0, 300) };
        }
      }
    }
    return null;
  };
  return () => {
    if (!tp) return null;
    try {
      const st = fs.statSync(tp);
      if (offset === null || st.size < offset) { offset = Math.max(0, st.size - 2 * 1024 * 1024); carry = ''; }
      if (st.size <= offset) return null;
      const len = Math.min(st.size - offset, 64 * 1024 * 1024); // au plus 64 Mo par passage
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(tp, 'r');
      try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
      offset += len;
      const lines = (carry + buf.toString('utf8')).split('\n');
      carry = lines.pop() ?? '';
      if (carry.length > 32 * 1024 * 1024) carry = ''; // ligne démesurée : abandonnée
      for (const line of lines) { const done = scan(line); if (done) return done; }
    } catch { /* en cas de doute : on continue d'attendre */ }
    return null;
  };
}

function classifierFallback(input) {
  if (input.permission_mode !== 'auto') return false;
  try {
    const tp = transcriptFor(input);
    if (!tp) return false;
    const st = fs.statSync(tp);
    const len = Math.min(st.size, 1 << 20);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(tp, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const verdicts = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"reasonType":"classifier"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const pd = d?.permissionDecision;
      if (pd?.reasonType !== 'classifier') continue;
      const reject = pd.decision === 'reject' || pd.decision === 'deny';
      // « gave no verdict » : panne passagère du classifieur, non comptée par Claude Code.
      if (reject && /gave no verdict|was not reviewed/.test(JSON.stringify(d.message?.content ?? ''))) continue;
      verdicts.push(reject);
    }
    const last = verdicts.slice(-2);
    if (last.length === 2 && last.every(Boolean)) return true;
    // Au-delà de 19 refus du mode auto dans la conversation, chaque nouveau refus devient une fenêtre.
    if (verdicts.at(-1) === true) {
      const n = tail(HISTORY_FILE).filter((l) => l.includes('"refuse-mode-auto"') && l.includes(String(input.session_id))).length;
      if (n >= 19) return true;
    }
    return false;
  } catch { return false; /* en cas de doute : pas de repli détecté, les garde-fous restent */ }
}

function tail(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 1 << 20);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    if (st.size > len) lines.shift(); // première ligne coupée
    return lines;
  } catch { return []; }
}

// Répond à la place de l'utilisateur (option recommandée, ou plan validé) et enregistre la question
// complète dans data/questions.jsonl pour qu'il puisse la relire.
async function answerQuestion(input, hookEventName, extra = {}) {
  const ti = input.tool_input || {};
  const chosen = {};
  let updatedInput = ti;
  // Réponse donnée par l'utilisateur dans Vigie : transmise telle quelle, rien à relire ensuite.
  const given = extra.given;
  if (input.tool_name === 'AskUserQuestion' && given) {
    updatedInput = { ...ti, answers: given };
    const out = { hookSpecificOutput: { hookEventName, decision: { behavior: 'allow', updatedInput } } };
    onKill = null;
    if (!(await reply(out))) return log(input, 'reponse-perdue');
    return log(input, 'question-repondue-app', { answers: given });
  }
  if (input.tool_name === 'AskUserQuestion') {
    const answers = {};
    for (const q of ti.questions || []) {
      const pick = pickRecommended(q);
      if (pick) { answers[q.question] = `${pick.label} — choisi automatiquement par Vigie (utilisateur absent)`; chosen[q.question] = pick.label; }
    }
    updatedInput = { ...ti, answers };
  }
  const out = hookEventName === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName, permissionDecision: 'allow', updatedInput } }
    : { hookSpecificOutput: { hookEventName, decision: { behavior: 'allow', updatedInput } } };
  onKill = null;
  if (!(await reply(out))) return log(input, 'reponse-perdue');
  const record = buildRecord(input, chosen);
  appendRecord(QUESTIONS_FILE, record);
  log(input, 'question-auto', { answers: updatedInput.answers, questionId: record.id, ...extra });
}

async function onQuestionRequest(input) {
  const sid = input.session_id;
  const state = readState();
  let mode = effective(state, sid).questions;
  // Terminal, sous-agent, ou mode « tout de suite » (PreToolUse a déjà répondu) : comme la v1.
  if (mode === 'auto' || !canWait(input)) return log(input, 'question-pour-toi');

  let since = Date.now();
  let waitMin = state.questionWaitMin;
  const resolved = transcriptWatcher(input, since);
  // Réponse donnée dans Vigie (decisions.json, à ce pid) : une entrée laissée par un ancien processus ne compte pas.
  const pendingId = String(process.pid);
  clearDecision(pendingId);
  let given = null;
  // Les questions et leurs choix, pour répondre depuis Vigie (sans les longues descriptions).
  const questions = (input.tool_input?.questions || []).slice(0, 4).map((q) => ({ question: String(q.question || '').slice(0, 500),
    header: q.header ? String(q.header).slice(0, 40) : null, multiSelect: !!q.multiSelect,
    options: (q.options || []).slice(0, 6).map((o) => ({ label: String(o.label || '').slice(0, 200), description: o.description ? String(o.description).slice(0, 300) : null })) }));
  const asked = input.tool_name === 'AskUserQuestion' && questions.length ? { questions } : {};
  // pid (noté par log) : le serveur sait ainsi si l'attente est encore en cours (un hook tué par SIGKILL ne note rien).
  log(input, mode === 'wait' ? 'question-attente' : 'question-pour-toi', mode === 'wait' ? { minutes: waitMin, ...asked } : asked);
  // La fenêtre reste affichée ; on reste en éveil pour suivre un changement de réglage fait dans Vigie.
  for (;;) {
    onKill = mode === 'wait' ? () => log(input, 'question-tu-as-repondu') : null;
    let done = null;
    const r = await waitFor(() => (mode === 'wait' ? since + waitMin * 60_000 : Infinity), (s) => {
      if ((given = takeAnswer(pendingId, { since, sessionId: sid }))) return 'app';
      if ((done = resolved())) return 'repondu';
      const m = effective(s, sid).questions;
      if (m !== mode) return `mode:${m}`;
      waitMin = s.questionWaitMin;
      return true;
    });
    if (r === 'app') return answerQuestion(input, 'PermissionRequest', { given });
    if (r === 'timeout') return answerQuestion(input, 'PermissionRequest');
    if (r === 'mode:auto') return answerQuestion(input, 'PermissionRequest', { now: true });
    if (r === 'mode:wait') {
      mode = 'wait'; since = Date.now(); waitMin = readState().questionWaitMin;
      log(input, 'question-attente', { minutes: waitMin });
      continue;
    }
    if (r === 'mode:ask') { mode = 'ask'; log(input, 'question-rendue'); continue; }
    onKill = null;
    if (r === 'repondu') return log(input, 'question-tu-as-repondu', { extrait: done.extrait });
    if (mode === 'wait') log(input, 'question-rendue', { raison: r });
    return;
  }
}

function denyOutput(rule, why) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: 'deny',
    message: `Action sensible non validée automatiquement (garde-fou Vigie : « ${rule.label} »). ${why} ` +
      'Ne la retente pas et ne cherche pas à la contourner par un autre moyen : continue le reste du travail, ' +
      'et signale-la clairement dans ton compte rendu final comme une action que l\'utilisateur doit faire ou valider lui-même.',
  } } };
}

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

// Mode « seulement par Vigie » : refus immédiat, la conversation continue le reste du travail.
function vigieDenyOutput(rule) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: 'deny',
    message: `Action sensible en attente de l'accord de l'utilisateur dans Vigie (garde-fou : « ${rule.label} »). ` +
      'Ne la relance pas tant que l\'utilisateur ne te l\'a pas confirmé ; continue le reste du travail. ' +
      'Quand il l\'aura autorisée, il te le dira : relance-la alors exactement à l\'identique.',
  } } };
}

// Autorisation à usage unique de l'utilisateur pour cet appel exact (même conversation, même outil, mêmes paramètres,
// non expirée) : consommée, l'action passe. Sinon : refus tout de suite et un élément « à autoriser » dans Vigie
// (approvalId, empreinte de l'appel, action complète). Agents de fond compris.
async function onVigieGuard(input, rule) {
  const hash = callHash(input.session_id, input.tool_name, input.tool_input);
  const ok = takeApproval({ sessionId: input.session_id, tool: input.tool_name, hash });
  if (ok) return decide(input, 'garde-fou-autorise-vigie', ALLOW, { ...ruleInfo(rule), approvalId: ok.approvalId, hash });
  return decide(input, 'garde-fou-en-attente-vigie', vigieDenyOutput(rule), { ...ruleInfo(rule), approvalId: newApprovalId(), hash });
}

async function decide(input, event, out, extra = {}) {
  onKill = null;
  log(input, (await reply(out)) ? event : 'reponse-perdue', extra);
}

async function onPermissionRequest(input) {
  const tool = input.tool_name;
  if (QUESTION_TOOLS.has(tool)) return onQuestionRequest(input);
  if (HUMAN_ONLY.has(tool)) return log(input, 'demande-pour-toi', { raison: 'réponse humaine obligatoire' });
  if (classifierFallback(input)) return log(input, 'refus-classifieur-pour-toi');

  const sid = input.session_id;
  const wait = canWait(input);
  let late = false; // décision prise après un changement de réglage, fenêtre déjà affichée
  for (;;) {
    const state = readState();
    if (!effective(state, sid).autoAccept) {
      log(input, 'demande-pour-toi');
      if (!wait) return;
      // Si l'utilisateur active l'auto-accept pendant que la fenêtre est affichée, on valide quand même.
      onKill = null;
      const r = await waitFor(() => Infinity, (s) => (effective(s, sid).autoAccept ? 'on' : true));
      if (r !== 'on') return;
      late = true;
      continue;
    }

    let rule = matchGuard(state, tool, input.tool_input);
    if (!rule) return decide(input, 'auto-accepte', ALLOW, late ? { tardif: true } : {});
    guarded = true;
    if (state.guard.mode !== 'vscode') return onVigieGuard(input, rule);

    let minutes = state.guard.waitMin;
    if (minutes <= 0 || input.agent_id) {
      return decide(input, 'garde-fou-bloque', denyOutput(rule, 'L\'utilisateur a demandé de ne jamais la valider à sa place.'),
        { ...ruleInfo(rule), raison: input.agent_id ? 'sous-agent' : 'jamais' });
    }
    if (!wait) return log(input, 'garde-fou-pour-toi', ruleInfo(rule));

    // Décision depuis l'app : une entrée laissée pour ce pid par un ancien processus ne compte pas.
    const start = Date.now();
    const resolved = transcriptWatcher(input, start);
    const pendingId = String(process.pid);
    const bare = clearDecision(pendingId);
    log(input, 'garde-fou-attente', { ...ruleInfo(rule), minutes });
    onKill = () => log(input, 'garde-fou-tu-as-repondu', ruleInfo(rule));
    let done = null;
    // Les réglages sont relus à chaque tour : garde-fou coupé, règle désactivée ou délai changé
    // s'appliquent tout de suite. La décision de l'utilisateur (app ou VS Code) passe avant tout le reste.
    const r = await waitFor(() => start + minutes * 60_000, (s) => {
      const d = takeDecision(pendingId, { since: start, sessionId: sid, allowBare: bare });
      if (d) return d === 'allow' ? 'app-allow' : 'app-deny';
      if ((done = resolved())) return 'repondu';
      if (!effective(s, sid).autoAccept) return 'off';
      const g = matchGuard(s, tool, input.tool_input);
      if (!g) return 'allow';
      rule = g;
      minutes = s.guard.waitMin;
      return minutes <= 0 ? 'zero' : true;
    });
    if (r === 'app-allow') return decide(input, 'garde-fou-autorise-app', ALLOW, ruleInfo(rule));
    if (r === 'app-deny') return decide(input, 'garde-fou-refuse-app', denyOutput(rule, 'L\'utilisateur l\'a refusée depuis Vigie.'), ruleInfo(rule));
    if (r === 'timeout') return decide(input, 'garde-fou-bloque', denyOutput(rule, `L'utilisateur n'a pas répondu en ${minutes} min.`), { ...ruleInfo(rule), raison: 'delai' });
    if (r === 'zero') return decide(input, 'garde-fou-bloque', denyOutput(rule, 'L\'utilisateur a demandé de ne jamais la valider à sa place.'), { ...ruleInfo(rule), raison: 'jamais' });
    if (r === 'allow') return decide(input, 'auto-accepte', ALLOW, { tardif: true });
    onKill = null;
    if (r === 'repondu') return log(input, 'garde-fou-tu-as-repondu', { ...ruleInfo(rule), resultat: done.ok ? 'réussie' : 'erreur', extrait: done.extrait });
    log(input, 'garde-fou-rendu', r === 'off' ? ruleInfo(rule) : { ...ruleInfo(rule), raison: r });
    if (r !== 'off') return;
    late = true; // auto-accept coupé pendant l'attente : la fenêtre reste à l'utilisateur, on suit le réglage
  }
}

const preOutput = (permissionDecision, permissionDecisionReason) =>
  ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });

// « Seulement par Vigie », avant toute fenêtre : l'action attend l'accord de l'utilisateur dans l'app (aucune fenêtre
// VS Code n'est affichée pendant ce temps, rien à cliquer par erreur). Autorisée : elle part dans sa
// conversation. Refusée, ou sans réponse dans le délai : refus, la conversation continue le reste du travail.
async function onPreToolUseGuard(input) {
  const state = readState();
  const sid = input.session_id;
  if (!effective(state, sid).autoAccept) return; // L'utilisateur valide lui-même dans VS Code
  const tool = input.tool_name;
  const rule = matchGuard(state, tool, input.tool_input);
  if (!rule || readOnlyShell(tool, input.tool_input)) return;
  // « Dans la conversation et dans Vigie » : Claude Code affiche sa fenêtre (même en mode auto, qui l'aurait
  // validée seul) ; PermissionRequest attend alors en parallèle la décision prise dans Vigie.
  if (state.guard.mode === 'vscode') {
    return reply(preOutput('ask', `Action sensible (garde-fou Vigie : « ${rule.label} ») : à valider par l'utilisateur, ici ou dans Vigie.`));
  }
  return holdForVigie(input, rule, state, 'PreToolUse');
}

// Réponses selon l'événement : PreToolUse (permissionDecision) ou PermissionRequest (decision.behavior).
// Codex exige, pour autoriser en PreToolUse, l'entrée (même inchangée) dans updatedInput.
function verdict(event, allow, reason) {
  if (event === 'PermissionRequest') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: reason } } };
  }
  const out = preOutput(allow ? 'allow' : 'deny', reason);
  if (allow && CODEX && input?.tool_input) out.hookSpecificOutput.updatedInput = input.tool_input;
  return out;
}

async function holdForVigie(input, rule, state, event) {
  const sid = input.session_id;
  const tool = input.tool_name;
  guarded = true;
  const preOutput = (decision, reason) => verdict(event, decision === 'allow', reason);
  const hash = callHash(sid, tool, input.tool_input);
  const info = { ...ruleInfo(rule), hash };
  const ok = takeApproval({ sessionId: sid, tool, hash, event });
  if (ok) return decide(input, 'garde-fou-autorise-vigie', preOutput('allow', 'Autorisée par l\'utilisateur dans Vigie'), { ...info, approvalId: ok.approvalId });
  const approvalId = newApprovalId();
  const minutes = state.guard.waitMin;
  if (minutes <= 0) return decide(input, 'garde-fou-en-attente-vigie', preOutput('deny', vigieDenyOutput(rule).hookSpecificOutput.decision.message), { ...info, approvalId });
  const start = Date.now();
  log(input, 'garde-fou-en-attente-vigie', { ...info, approvalId, holdUntil: new Date(start + minutes * 60_000).toISOString() });
  onKill = () => log(input, 'garde-fou-vigie-clos', { ...info, approvalId, raison: 'interrompue' });
  const r = await waitFor(() => start + minutes * 60_000, (s) => {
    if (takeApproval({ sessionId: sid, tool, hash, event })) return 'allow';
    if (deniedApproval(approvalId)) return 'deny';
    if (!matchGuard(s, tool, input.tool_input)) return 'off';
    return true;
  });
  if (r === 'allow') return decide(input, 'garde-fou-autorise-vigie', preOutput('allow', 'Autorisée par l\'utilisateur dans Vigie'), { ...info, approvalId });
  if (r === 'deny') {
    return decide(input, 'garde-fou-refuse-vigie', preOutput('deny', `L'utilisateur a refusé cette action dans Vigie (garde-fou : « ${rule.label} »). ` +
      'Ne la retente pas et ne cherche pas à la contourner : continue le reste du travail et signale-la dans ton compte rendu.'), { ...info, approvalId });
  }
  if (r === 'timeout') return decide(input, 'garde-fou-delai-vigie', preOutput('deny', vigieDenyOutput(rule).hookSpecificOutput.decision.message), { ...info, approvalId });
  onKill = null;
  // garde-fou coupé pendant l'attente : rien à décider ici, Claude Code suit son cours (PermissionRequest)
  log(input, 'garde-fou-vigie-clos', { ...info, approvalId, raison: r });
}

// ---------- Codex (OpenAI) : hooks au même format, branchés dans ~/.codex/hooks.json avec --codex ----------
// Son hook passe AVANT sa fenêtre d'autorisation : une action sensible peut attendre l'accord dans Vigie sans
// fenêtre en parallèle. Les actions sensibles sont retenues dès PreToolUse, quel que soit le mode : Codex lance
// sans rien demander ce qui tient dans son bac à sable (un sudo, un rm dans le projet…). Une autorisation donnée
// en PreToolUse vaut aussi pour le PermissionRequest du même appel (lib/approvals.mjs).
async function onCodex(input) {
  const ev = input.hook_event_name;
  // Preuve que Codex fait confiance au hook : il ne lance jamais un hook pas encore approuvé.
  try { fs.writeFileSync(path.join(DATA, 'codex-hook-seen'), new Date().toISOString()); } catch { /* facultatif */ }
  const state = readState();
  const sid = input.session_id;
  if (!effective(state, sid).autoAccept) {
    if (ev === 'PermissionRequest') log(input, 'demande-pour-toi');
    return;
  }
  const tool = input.tool_name;
  const rule = matchGuard(state, tool, input.tool_input);
  if (ev === 'PreToolUse') {
    if (!rule || readOnlyShell(tool, input.tool_input)) return;
    // Codex ne sait pas afficher sa fenêtre à la demande : l'action attend dans Vigie, quel que soit le mode
    return holdForVigie(input, rule, state, 'PreToolUse');
  }
  if (ev !== 'PermissionRequest') return;
  if (!rule) return decide(input, 'auto-accepte', ALLOW);
  guarded = true;
  if (state.guard.mode === 'vscode') return log(input, 'garde-fou-pour-toi', ruleInfo(rule)); // la fenêtre de Codex s'en charge
  return holdForVigie(input, rule, state, 'PermissionRequest');
}

async function onPreToolUse(input) {
  if (!QUESTION_TOOLS.has(input.tool_name)) return onPreToolUseGuard(input);
  if (input.agent_id) return;
  if (effective(readState(), input.session_id).questions !== 'auto') return;
  await answerQuestion(input, 'PreToolUse', { immediate: true });
}

function onPermissionDenied(input) {
  log(input, 'refuse-mode-auto', { reason: String(input.reason || '').slice(0, 400) });
}

const input = readStdin();
try {
  if (CODEX) await onCodex(input);
  else if (input?.hook_event_name === 'PermissionRequest') await onPermissionRequest(input);
  else if (input?.hook_event_name === 'PreToolUse') await onPreToolUse(input);
  else if (input?.hook_event_name === 'PermissionDenied') onPermissionDenied(input);
} catch (e) {
  try { appendHistory({ event: 'erreur-hook', error: String(e?.stack || e).slice(0, 500), sessionId: input?.session_id }); } catch { /* ignore */ }
}
process.exit(0);
