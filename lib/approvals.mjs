// Vigie — garde-fous « seulement par Vigie » (contrat : « Ajouts du tour 3 », guard.mode = 'vigie').
//
// Une action sensible est refusée sur le moment par le hook, qui note dans l'historique
// « garde-fou-en-attente-vigie » avec un approvalId, l'action complète (4000 caractères au plus) et
// l'empreinte de l'appel (hash : conversation + outil + paramètres exacts). L'utilisateur l'autorise dans l'app
// (POST /api/v2/approvals) : le serveur écrit dans data/approvals.json
//   { "<approvalId>": { "decision": "allow", "sessionId", "tool", "hash", "ts", "expiresAt" } }
// À la relance, le hook cherche une autorisation de même conversation, même outil, même empreinte, non
// expirée : il la retire (usage unique), répond « allow » et note « garde-fou-autorise-vigie ».
// Un refus de l'utilisateur est noté { "decision": "deny", … } : l'élément sort de « À regarder », rien n'est envoyé.
// Ce fichier est protégé comme decisions.json (lib/state.mjs) : une conversation ne peut pas s'autoriser.
// Module léger : le hook l'importe à chaque demande.
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, HISTORY_FILE } from './state.mjs';
import { readDecisions, lockedUpdate, guardHistory, needsPassword, MAX_COMMAND } from './decisions.mjs';

export const APPROVALS_FILE = path.join(DATA, 'approvals.json');
export const APPROVAL_MS = 2 * 3600_000;        // une autorisation vaut 2 h
const AWAITING_MS = 24 * 3600_000;              // un élément « à autoriser » reste listé 24 h
const KEEP_DENY_MS = 72 * 3600_000;
export const APPROVAL_ID = /^[0-9a-f]{16}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// JSON aux clés triées : le même appel donne toujours la même empreinte, quel que soit l'ordre des clés.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export function callHash(sessionId, tool, input) {
  return crypto.createHash('sha256').update(`${String(sessionId ?? '')}\u0000${String(tool ?? '')}\u0000${canon(input ?? null)}`).digest('hex');
}
export const newApprovalId = () => crypto.randomBytes(8).toString('hex');

const validAllow = (e, now) => isObj(e) && e.decision === 'allow' && Date.parse(e.expiresAt) > now;

// Côté hook : autorisation à usage unique pour cet appel exact (conversation, outil, empreinte). Un même appel
// passe parfois par deux hooks : PreToolUse (où Vigie le retient), puis PermissionRequest (Claude Code demande
// quand même l'autorisation). L'autorisation prise en PreToolUse reste donc valable 2 min pour le PermissionRequest
// du même appel, puis disparaît ; une relance identique par le même hook redemande l'accord.
// Renvoie { approvalId } ou null.
const SECOND_STEP_MS = 120_000;
export function takeApproval({ sessionId, tool, hash, event = 'PermissionRequest', now = Date.now(), file = APPROVALS_FILE } = {}) {
  try {
    const sid = String(sessionId ?? '');
    const fits = (e) => validAllow(e, now) && e.sessionId === sid && e.tool === tool && e.hash === hash;
    const m = readDecisions(file);
    const id = Object.keys(m).find((k) => APPROVAL_ID.test(k) && fits(m[k]));
    if (!id) return null;
    let took = false;
    const ok = lockedUpdate(file, (mm) => {
      const e = mm[id];
      if (!fits(e)) return;
      if (e.usedAt) {
        // déjà prise : seulement l'étape suivante du même appel, dans les 2 min
        took = e.usedBy !== event && now - Date.parse(e.usedAt) < SECOND_STEP_MS;
        delete mm[id];
      } else if (event === 'PreToolUse') {
        mm[id] = { ...e, usedAt: new Date(now).toISOString(), usedBy: event };
        took = true;
      } else {
        delete mm[id];
        took = true;
      }
    });
    return ok && took ? { approvalId: id } : null;
  } catch { return null; }
}

// Côté hook, pendant l'attente : L'utilisateur a-t-il refusé cet élément dans l'app ?
export function deniedApproval(approvalId, file = APPROVALS_FILE) {
  try { return readDecisions(file)[approvalId]?.decision === 'deny'; } catch { return false; }
}

// ---------- côté serveur ----------

const keyOf = (h) => `${h.sessionId ?? ''}\u0000${h.hash}`;
// Refus « seulement par Vigie » encore à autoriser : un seul élément par appel identique (le dernier),
// retiré quand l'appel a été autorisé puis lancé (garde-fou-autorise-vigie ensuite) ou refusé par l'utilisateur.
function scan(list, m, now) {
  const byKey = new Map();
  const byId = new Map();
  for (const h of list) {
    if (!isObj(h) || typeof h.hash !== 'string') continue;
    if (h.event === 'garde-fou-en-attente-vigie' && APPROVAL_ID.test(String(h.approvalId))) {
      byKey.set(keyOf(h), h);
      byId.set(h.approvalId, h);
    } else if (h.event === 'garde-fou-autorise-vigie' || h.event === 'garde-fou-vigie-clos') byKey.delete(keyOf(h));
    else if (h.event === 'garde-fou-delai-vigie' && byId.has(h.approvalId)) byId.get(h.approvalId).holdUntil = null;
  }
  const open = new Map();
  for (const [k, h] of byKey) {
    const age = now - Date.parse(h.ts);
    if (!(age <= AWAITING_MS)) continue;
    if (m[h.approvalId]?.decision === 'deny') continue;
    open.set(k, h);
  }
  return { open, byId };
}

function item(h, m, now) {
  const agentId = typeof h.agentId === 'string' && h.agentId ? h.agentId : null;
  const allow = Object.entries(m).find(([k, e]) => APPROVAL_ID.test(k) && validAllow(e, now) && e.sessionId === (h.sessionId ?? '') && e.tool === h.tool && e.hash === h.hash);
  return {
    approvalId: h.approvalId,
    state: 'awaiting',
    sessionId: h.sessionId ?? null,
    conversationId: h.sessionId ?? null,
    cwd: h.cwd ?? null,
    tool: h.tool ?? null,
    rule: h.rule ?? null,
    ruleId: h.ruleId ?? null,
    command: String(h.action ?? '').slice(0, MAX_COMMAND),
    description: h.description ?? null,
    byAgent: agentId,
    agentId,
    needsPassword: needsPassword(h),
    hash: h.hash,
    ts: h.ts,
    approved: !!allow,                    // autorisée, la relance n'a pas encore eu lieu
    // la conversation attend encore l'accord (PreToolUse) : une autorisation part tout de suite, sans relance
    holding: Date.parse(h.holdUntil) > now,
    approvedUntil: allow ? allow[1].expiresAt : null,
  };
}

// Éléments « à autoriser », plus récents d'abord.
export function awaitingApprovals({ history, historyFile = HISTORY_FILE, file = APPROVALS_FILE, now = Date.now() } = {}) {
  const list = Array.isArray(history) ? history : guardHistory(historyFile);
  const m = readDecisions(file);
  return [...scan(list, m, now).open.values()].map((h) => item(h, m, now)).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

// POST /api/v2/approvals { approvalId, decision? } : 'allow' (par défaut) écrit l'autorisation à usage unique
// (2 h) ; 'deny' retire l'élément (et une autorisation pas encore utilisée pour le même appel).
// Renvoie { ok: true, approvalId, decision, expiresAt?, item } ou { ok: false, status, error }.
export function approve(approvalId, decision = 'allow', { history, historyFile = HISTORY_FILE, file = APPROVALS_FILE, now = Date.now() } = {}) {
  const d = decision === undefined || decision === null ? 'allow' : decision;
  if (d !== 'allow' && d !== 'deny') return { ok: false, status: 400, error: 'Décision inconnue : allow ou deny.' };
  if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) return { ok: false, status: 400, error: 'Identifiant d\'autorisation illisible.' };
  const list = Array.isArray(history) ? history : guardHistory(historyFile);
  const m = readDecisions(file);
  const { open, byId } = scan(list, m, now);
  const h = byId.get(approvalId);
  if (!h || !open.has(keyOf(h))) return { ok: false, status: 404, error: 'Cette action n\'attend plus ton accord.' };
  const ts = new Date(now).toISOString();
  const expiresAt = new Date(now + APPROVAL_MS).toISOString();
  const sessionId = h.sessionId ?? '';
  const written = lockedUpdate(file, (mm) => {
    for (const k of Object.keys(mm)) { // ménage : autorisations expirées, refus de plus de 3 jours, entrées illisibles
      const e = mm[k];
      if (!APPROVAL_ID.test(k) || !isObj(e)) { delete mm[k]; continue; }
      if (e.decision === 'allow' ? !(Date.parse(e.expiresAt) > now) : !(now - Date.parse(e.ts) < KEEP_DENY_MS)) { delete mm[k]; continue; }
      if (d === 'deny' && e.decision === 'allow' && e.sessionId === sessionId && e.tool === h.tool && e.hash === h.hash) delete mm[k];
    }
    mm[approvalId] = d === 'allow'
      ? { decision: 'allow', sessionId, tool: h.tool ?? null, hash: h.hash, ts, expiresAt }
      : { decision: 'deny', sessionId, tool: h.tool ?? null, hash: h.hash, ts };
  });
  if (!written) return { ok: false, status: 503, error: 'Décision non enregistrée, réessaie dans un instant.' };
  return { ok: true, approvalId, decision: d, ...(d === 'allow' ? { expiresAt } : {}), item: item(h, readDecisions(file), now) };
}
