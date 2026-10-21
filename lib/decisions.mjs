// Vigie — décider d'une action sensible depuis l'app (contrat : « Actions sensibles : décider depuis l'app »).
//
// Pendant l'attente d'un garde-fou, le hook relit data/decisions.json toutes les 3 s. Une entrée pour son
// identifiant d'attente (son pid, noté dans l'événement garde-fou-attente) vaut réponse de l'utilisateur :
//   { "<pendingId>": { "decision": "allow" | "deny", "ts": "…", "sessionId": "…" } }
// (la forme courte { "<pendingId>": "allow" | "deny" } est aussi comprise), puis le hook efface l'entrée.
// Le serveur écrit avec decide(), qui vérifie d'abord que l'attente existe encore.
//
// Précautions :
//  - un pid peut resservir : au début de chaque attente, le hook retire l'entrée déjà là pour son pid,
//    et il ignore une entrée datée d'avant le début de son attente ;
//  - une attente n'est « en cours » que si le processus vit, est bien un hook de Vigie et que son échéance
//    n'est pas passée ;
//  - écritures atomiques (fichier temporaire puis rename) sous verrou : le serveur et un hook peuvent écrire
//    en même temps sans perdre de décision ;
//  - une conversation ne peut pas écrire ce fichier sans passer par un garde-fou (lib/state.mjs).
// Ce module reste léger : le hook l'importe à chaque demande.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA, HISTORY_FILE, readState, executedText } from './state.mjs';

export const DECISIONS_FILE = path.join(DATA, 'decisions.json');
export const MAX_COMMAND = 4000;
const DECISIONS = new Set(['allow', 'deny']);
const ID_RE = /^\d{1,10}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* rien */ } };

// ---------- fichier des décisions ----------

export function readDecisions(file = DECISIONS_FILE) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(m) ? m : {};
  } catch { return {}; }
}

// { decision, ts, sessionId } ou null si l'entrée est illisible.
function entry(v) {
  if (typeof v === 'string') return DECISIONS.has(v) ? { decision: v, ts: null, sessionId: null } : null;
  if (!isObj(v) || !DECISIONS.has(v.decision)) return null;
  const t = typeof v.ts === 'string' ? Date.parse(v.ts) : NaN;
  if (v.ts !== undefined && v.ts !== null && !Number.isFinite(t)) return null;
  return { decision: v.decision, ts: Number.isFinite(t) ? t : null, sessionId: typeof v.sessionId === 'string' ? v.sessionId : null };
}

// Lecture-modification-écriture sous verrou. Renvoie false si le verrou n'a pas pu être pris (rien d'écrit).
function update(file, mutate) {
  const lock = `${file}.lock`;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return false; }
  const deadline = Date.now() + 2000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; } catch (e) {
      if (e?.code !== 'EEXIST') return false;
      // verrou abandonné (processus tué au mauvais moment) : repris après 5 s
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) return false;
      sleepSync(15);
    }
  }
  try {
    const m = readDecisions(file);
    const before = JSON.stringify(m);
    mutate(m);
    if (JSON.stringify(m) === before) return true;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; } finally {
    try { fs.unlinkSync(lock); } catch { /* déjà parti */ }
  }
}

// Côté hook, au début d'une attente : retire une entrée laissée pour ce pid par un autre processus.
// Renvoie true si plus rien ne traîne (rien à retirer, ou retiré), false si l'entrée n'a pas pu être retirée.
export function clearDecision(pendingId, { file = DECISIONS_FILE } = {}) {
  try {
    const id = String(pendingId);
    if (!Object.hasOwn(readDecisions(file), id)) return true;
    return update(file, (m) => { delete m[id]; });
  } catch { return false; }
}

// Côté hook, à chaque tour de l'attente : 'allow' | 'deny' si l'utilisateur a décidé depuis l'app, sinon null.
// since : début de l'attente (une entrée plus ancienne vient d'un autre processus au même pid).
// allowBare : accepter la forme courte, sans date (seulement si aucune ancienne entrée n'est restée).
export function takeDecision(pendingId, { since = 0, sessionId = null, allowBare = true, file = DECISIONS_FILE } = {}) {
  try {
    const id = String(pendingId);
    const m = readDecisions(file);
    if (!Object.hasOwn(m, id)) return null;
    const raw = m[id];
    const d = entry(raw);
    if (!d) return null;
    if (d.ts === null ? !allowBare : d.ts < since - 1000) return null;
    if (d.sessionId && sessionId && d.sessionId !== String(sessionId)) return null;
    const seen = JSON.stringify(raw);
    update(file, (mm) => { if (JSON.stringify(mm[id]) === seen) delete mm[id]; }); // effacée une fois lue
    return d.decision;
  } catch { return null; }
}

// Réponse à une question donnée depuis l'app : { decision: 'answer', answers: { "<question>": "<choix>" }, ts, sessionId }.
// Côté hook : les réponses (une fois, puis effacées), ou null.
export function takeAnswer(pendingId, { since = 0, sessionId = null, file = DECISIONS_FILE } = {}) {
  try {
    const id = String(pendingId);
    const raw = readDecisions(file)[id];
    if (!isObj(raw) || raw.decision !== 'answer' || !isObj(raw.answers)) return null;
    const t = Date.parse(raw.ts);
    if (!(t >= since - 1000)) return null;
    if (raw.sessionId && sessionId && raw.sessionId !== String(sessionId)) return null;
    const seen = JSON.stringify(raw);
    update(file, (mm) => { if (JSON.stringify(mm[id]) === seen) delete mm[id]; });
    return raw.answers;
  } catch { return null; }
}
export function writeAnswer(pendingId, answers, { sessionId = null, file = DECISIONS_FILE } = {}) {
  const id = String(pendingId ?? '');
  if (!ID_RE.test(id) || !isObj(answers)) return false;
  const clean = {};
  for (const [q, a] of Object.entries(answers)) if (typeof a === 'string' && a.trim()) clean[String(q).slice(0, 2000)] = a.slice(0, 2000);
  if (!Object.keys(clean).length) return false;
  return update(file, (m) => { m[id] = { decision: 'answer', answers: clean, ts: new Date().toISOString(), ...(sessionId ? { sessionId: String(sessionId) } : {}) }; });
}

// Écriture brute (sans vérifier que l'attente existe) : le serveur passe par decide().
export function writeDecision(pendingId, decision, { sessionId = null, file = DECISIONS_FILE } = {}) {
  const id = String(pendingId ?? '');
  if (!DECISIONS.has(decision) || !ID_RE.test(id)) return false;
  return update(file, (m) => { m[id] = { decision, ts: new Date().toISOString(), ...(sessionId ? { sessionId: String(sessionId) } : {}) }; });
}

// ---------- attentes en cours (lues dans l'historique du hook) ----------

// Les lignes du hook utiles ici : celles qui portent un pid (fin d'attente) et les garde-fous (blocages).
// Lecture incrémentale : au premier passage, seulement la fin du fichier.
const caches = new Map(); // fichier -> { offset, carry, list }
const TAIL_BYTES = 8 * 1024 * 1024;
const KEEP_PID_MS = 4 * 3600_000;    // une attente dure au plus 2 h (garde-fou : 120 min max)
const KEEP_GUARD_MS = 72 * 3600_000; // actions bloquées ou ratées : « À regarder » en montre 24 h
function guardEvents(file) {
  let c = caches.get(file);
  let st;
  try { st = fs.statSync(file); } catch { caches.delete(file); return []; }
  if (!c || st.size < c.offset) {
    c = { offset: Math.max(0, st.size - TAIL_BYTES), carry: '', list: [], skipFirst: st.size > TAIL_BYTES };
    caches.set(file, c);
  }
  if (st.size > c.offset) {
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - c.offset);
        const got = fs.readSync(fd, buf, 0, buf.length, c.offset);
        text = buf.subarray(0, got).toString('utf8');
        c.offset += got;
      } finally { fs.closeSync(fd); }
    } catch { return c.list; }
    const lines = (c.carry + text).split('\n');
    c.carry = lines.pop() ?? '';
    if (c.skipFirst) { lines.shift(); c.skipFirst = false; } // première ligne coupée
    for (const line of lines) {
      if (!line.includes('"pid"') && !line.includes('"garde-fou')) continue;
      let h;
      try { h = JSON.parse(line); } catch { continue; }
      if (isObj(h) && typeof h.event === 'string') c.list.push(h);
    }
  }
  const now = Date.now();
  c.list = c.list.filter((h) => {
    const age = now - Date.parse(h.ts);
    return Number.isFinite(age) && age <= KEEP_GUARD_MS && (h.event.startsWith('garde-fou') || age <= KEEP_PID_MS);
  });
  return c.list;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // signal 0 : simple test de vie
}
// Un pid vivant n'est pas forcément notre hook (pid réutilisé) : on regarde sa ligne de commande.
const hookCache = new Map(); // pid -> { at, ok }
function isHookProcess(pid) {
  const c = hookCache.get(pid);
  if (c && Date.now() - c.at < 10_000) return c.ok;
  let ok = false;
  try {
    const r = spawnSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    ok = r.status === 0 && /\bhook\.mjs\b/.test(r.stdout || '');
  } catch { ok = false; }
  hookCache.set(pid, { at: Date.now(), ok });
  if (hookCache.size > 200) hookCache.delete(hookCache.keys().next().value);
  return ok;
}

const SHELL = new Set(['Bash', 'Monitor', 'PowerShell']);
// sudo demande un mot de passe : « autoriser » ne suffit pas, l'utilisateur la lance lui-même dans Terminal.
export function needsPassword(h) {
  if (h?.ruleId === 'sudo') return true;
  if (!h?.ruleId && /\bsudo\b/i.test(String(h?.rule || ''))) return true;
  return SHELL.has(h?.tool) && /\bsudo\b/.test(executedText(String(h?.action || '')));
}

function item(h, extra) {
  const agentId = typeof h.agentId === 'string' && h.agentId ? h.agentId : null;
  return {
    sessionId: h.sessionId ?? null,
    conversationId: h.sessionId ?? null,
    cwd: h.cwd ?? null,
    tool: h.tool ?? null,
    rule: h.rule ?? null,
    ruleId: h.ruleId ?? null,
    command: String(h.action ?? '').slice(0, MAX_COMMAND),
    description: h.description ?? null,
    byAgent: agentId, // identifiant de l'agent (le serveur peut le remplacer par son nom) ; null = la conversation
    agentId,
    needsPassword: needsPassword(h),
    ts: h.ts,
    ...extra,
  };
}

// Attentes de garde-fou en cours, plus récentes d'abord.
// history : lignes déjà lues (le serveur les a en mémoire), sinon data/history.jsonl.
// state : réglages actuels (le délai suit guard.waitMin, comme dans le hook).
export function pendingGuards({ history, historyFile = HISTORY_FILE, state, now = Date.now(), alive = pidAlive, isHook = isHookProcess } = {}) {
  const list = Array.isArray(history) ? history : guardEvents(historyFile);
  const open = new Map();
  for (const h of list) {
    const pid = Number(h?.pid);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (h.event === 'garde-fou-attente') open.set(pid, h);
    else if (open.has(pid)) open.delete(pid); // toute ligne suivante du même hook termine l'attente
  }
  let st = state;
  if (!st) { try { st = readState(); } catch { st = null; } }
  const out = [];
  for (const [pid, h] of open) {
    const start = Date.parse(h.ts);
    if (!Number.isFinite(start)) continue;
    const wm = st?.guard?.waitMin;
    const logged = Number(h.minutes);
    const minutes = typeof wm === 'number' && Number.isFinite(wm) ? wm : Number.isFinite(logged) ? logged : 10;
    const expires = start + minutes * 60_000;
    if (!(expires > now) || !alive(pid) || !isHook(pid)) continue;
    out.push(item(h, { pendingId: String(pid), state: 'waiting', since: h.ts, expiresAt: new Date(expires).toISOString(), minutes }));
  }
  return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

// Actions refusées par un garde-fou depuis `since` (délai écoulé, garde-fou réglé sur « jamais »,
// sous-agent, ou refus de l'utilisateur depuis l'app), plus récentes d'abord : commande complète, dossier, agent.
export function recentBlocked({ since, history, historyFile = HISTORY_FILE, limit = 100 } = {}) {
  const from = since ? Date.parse(since) : 0;
  const list = Array.isArray(history) ? history : guardEvents(historyFile);
  const out = [];
  for (const h of list) {
    if (h?.event !== 'garde-fou-bloque' && h?.event !== 'garde-fou-refuse-app' && h?.event !== 'garde-fou-echec') continue;
    if (Number.isFinite(from) && Date.parse(h.ts) < from) continue;
    if (h.event === 'garde-fou-echec') { out.push(item(h, { state: 'blocked', by: 'echec', extrait: String(h.extrait ?? '').slice(0, 300) })); continue; }
    out.push(item(h, { state: 'blocked', by: h.event === 'garde-fou-refuse-app' ? 'you' : (h.raison || 'delai') }));
  }
  return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
}

// ---------- côté serveur : POST /api/v2/pending/:pendingId ----------

// Renvoie { ok: true, message, … } ou { ok: false, status, error } (status : 400 ou 404, 503 si l'écriture
// n'a pas pu se faire). Options : celles de pendingGuards, plus file.
export function decide(pendingId, decision, opts = {}) {
  const { file = DECISIONS_FILE, alive = pidAlive } = opts;
  if (!DECISIONS.has(decision)) return { ok: false, status: 400, error: 'Décision inconnue : allow ou deny.' };
  const id = String(pendingId ?? '');
  const gone = { ok: false, status: 404, error: 'Cette action n\'attend plus ta décision.' };
  if (!ID_RE.test(id)) return gone;
  const p = pendingGuards(opts).find((x) => x.pendingId === id);
  if (!p) return gone;
  const now = Date.now();
  const written = update(file, (m) => {
    for (const k of Object.keys(m)) { // ménage : hooks disparus, entrées de plus de 3 h
      const e = entry(m[k]);
      if (!ID_RE.test(k) || !e || !alive(Number(k)) || (e.ts !== null && now - e.ts > 3 * 3600_000)) delete m[k];
    }
    m[id] = { decision, ts: new Date(now).toISOString(), sessionId: p.sessionId };
  });
  if (!written) return { ok: false, status: 503, error: 'Décision non enregistrée, réessaie dans un instant.' };
  return {
    ok: true,
    pendingId: id,
    decision,
    message: decision === 'allow'
      ? 'Autorisée.' // rien d'autre à dire : seul un échec est signalé ensuite (garde-fou-echec)
      : 'Refusée : Claude passe à la suite.',
  };
}

// Outils partagés avec lib/approvals.mjs (actions Codex retenues dans Vigie) : même fichier JSON sous
// verrou, mêmes lignes de garde-fou relues dans l'historique.
export { update as lockedUpdate, guardEvents as guardHistory };
