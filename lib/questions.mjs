// Questions de Claude auxquelles Vigie a répondu à la place de l'utilisateur : le hook les enregistre
// (data/questions.jsonl), le serveur les montre dans « À regarder » et note la relecture de l'utilisateur
// (data/questions-review.json). Aucune dépendance, aucune requête au modèle.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SUFFIX_MAX = 2000;   // une option ou un plan très long ne doit pas gonfler le fichier
const PLAN_MAX = 4000;
export const PLAN_YES = 'Valider le plan';
export const PLAN_NO = 'Revoir le plan';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v, max = SUFFIX_MAX) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Même choix que la v1 : l'option marquée « recommandé », sinon la première.
export function pickRecommended(q) {
  const opts = Array.isArray(q?.options) ? q.options : [];
  return opts.find((o) => /recommand/i.test(o?.label || '')) || opts[0] || null;
}

// Enregistrement complet d'une question répondue à la place de l'utilisateur.
// `chosen` : { [texte de la question]: libellé choisi }.
export function buildRecord(input, chosen = {}) {
  const ti = input.tool_input || {};
  let items;
  if (input.tool_name === 'ExitPlanMode') {
    items = [{
      question: 'Valider le plan ?', header: 'Plan', multiSelect: false,
      options: [{ label: PLAN_YES, description: str(ti.plan, PLAN_MAX) }, { label: PLAN_NO, description: 'Ne pas lancer ce plan tel quel' }],
      chosen: PLAN_YES,
    }];
  } else {
    items = (Array.isArray(ti.questions) ? ti.questions : []).map((q) => ({
      question: str(q?.question),
      header: str(q?.header, 200),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: str(o?.label), description: str(o?.description) })),
      chosen: typeof chosen[q?.question] === 'string' ? chosen[q.question] : null,
    }));
  }
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: input.session_id,
    cwd: input.cwd,
    tool: input.tool_name,
    items,
  };
}

export function appendRecord(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    return true;
  } catch { return false; /* l'enregistrement ne doit jamais bloquer la réponse */ }
}

// Message court que l'utilisateur colle dans la conversation pour revenir sur un choix.
export function correctionText(changes) {
  const parts = changes.map((c) => `Pour la question « ${short(c.question, 200)} », je préfère finalement « ${c.to} » au lieu de « ${c.from} ».`);
  return `${parts.join(' ')} Reprends en tenant compte de ${changes.length > 1 ? 'ces choix' : 'ce choix'}.`;
}

// Élément « À regarder » du contrat (GET /api/v2/overview → toReview[], kind = question).
export function reviewEntry(record, conversationTitle = null) {
  const first = record.items[0] || {};
  const detail = record.items.length > 1
    ? `Claude a choisi pour toi (${record.items.length} questions)`
    : first.chosen ? `Claude a pris « ${first.chosen} »` : 'Claude a répondu pour toi';
  return {
    id: `q:${record.id}`,
    kind: 'question',
    conversationId: record.sessionId ?? null,
    conversationTitle,
    title: short(first.question || 'Question de Claude', 120),
    detail,
    ts: record.ts,
    question: { id: record.id, items: record.items },
  };
}

// Livraison de la correction dans la conversation : étudiée, aucune voie sûre et documentée.
// - Sockets /tmp/cc-socks/<pid>.sock (messagingSocketPath du registre) : protocole interne entre
//   sessions, non documenté, qui exige le jeton privé de la session (fichier .key, un secret) ; le
//   message y arrive comme venant d'une autre session, pas de l'utilisateur.
// - vscode://anthropic.claude-code/open?session=<id>&prompt=… : documenté par le code de
//   l'extension (2.1.301), ouvre la conversation et PRÉ-REMPLIT la saisie sans l'envoyer ; si
//   l'onglet est déjà ouvert, le texte est ignoré (« enter it manually »).
// Donc delivered = false : l'app copie le texte et ouvre la conversation, l'utilisateur colle et envoie.
function conversationLink(sessionId, correction, { sessionsDir, projectsDir }) {
  if (!UUID.test(String(sessionId || ''))) return null;
  const running = isRunning(sessionsDir, sessionId);
  if (!running && !transcriptExists(projectsDir, sessionId)) return null;
  const base = `vscode://anthropic.claude-code/open?session=${sessionId}`;
  // Onglet sans processus vivant : il est sans doute fermé, le texte sera pré-rempli.
  return running ? base : `${base}&prompt=${promptParam(correction)}`;
}

// VS Code décode une fois la requête de l'URI, puis l'extension la relit avec URLSearchParams :
// & + et % doivent donc survivre à deux décodages.
export const promptParam = (text) => encodeURIComponent(text).replace(/%(26|2B|25)/g, '%25$1');

function isRunning(sessionsDir, sessionId) {
  let files = [];
  try { files = fs.readdirSync(sessionsDir); } catch { return false; }
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (s?.sessionId !== sessionId) continue;
    const pid = Number(s.pid);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    // Signal 0 : on demande seulement si le processus existe, rien ne lui est envoyé.
    try { process.kill(pid, 0); return true; } catch (e) { if (e?.code === 'EPERM') return true; }
  }
  return false;
}

function transcriptExists(projectsDir, sessionId) {
  try {
    return fs.readdirSync(projectsDir).some((d) => fs.existsSync(path.join(projectsDir, d, `${sessionId}.jsonl`)));
  } catch { return false; }
}

function readJson(file, fallback) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback; } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const fail = (status, error) => ({ ok: false, status, error });

export function createQuestions({ dataDir, sessionsDir, projectsDir } = {}) {
  if (!dataDir) throw new Error('dataDir manquant');
  const file = path.join(dataDir, 'questions.jsonl');
  const reviewFile = path.join(dataDir, 'questions-review.json');
  const dirs = { sessionsDir, projectsDir: projectsDir || (sessionsDir ? path.join(path.dirname(sessionsDir), 'projects') : undefined) };
  let cache = { key: '', list: [] };

  // Relu seulement quand le fichier change (le serveur interroge toutes les 3 s).
  function all() {
    let st;
    try { st = fs.statSync(file); } catch { return []; }
    const key = `${st.size}:${st.mtimeMs}`;
    if (cache.key === key) return cache.list;
    const byId = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.id === 'string' && Array.isArray(r.items)) byId.set(r.id, r);
      } catch { /* ligne abîmée */ }
    }
    cache = { key, list: [...byId.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts))) };
    return cache.list;
  }

  const reviews = () => readJson(reviewFile, {});
  const get = (id) => all().find((r) => r.id === String(id || '').replace(/^q:/, '')) || null;

  function toReview() {
    const done = reviews();
    return all().filter((r) => !Object.hasOwn(done, r.id));
  }

  function review(id, body = {}) {
    const rec = get(id);
    if (!rec) return fail(404, 'Question introuvable.');
    const action = body?.action;
    if (action !== 'ok' && action !== 'change') return fail(400, 'Action inconnue.');
    const done = reviews();
    const ts = new Date().toISOString();

    if (action === 'ok') {
      done[rec.id] = { action: 'ok', ts };
      writeJson(reviewFile, done);
      return { ok: true, correction: null, delivered: false, openUrl: null };
    }

    const answers = body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || !Object.keys(answers).length) return fail(400, 'Choisis une option.');
    const changes = [];
    for (const [question, value] of Object.entries(answers)) {
      const item = rec.items.find((i) => i.question === question);
      if (!item) return fail(400, 'Question inconnue.');
      const labels = (Array.isArray(value) ? value : [value]).map((v) => (typeof v === 'string' ? v : null));
      if (!labels.length || labels.some((l) => !l || !item.options.some((o) => o.label === l))) return fail(400, 'Choisis une des options proposées.');
      if (!item.multiSelect && labels.length > 1) return fail(400, 'Une seule option pour cette question.');
      const to = labels.join(', ');
      if (to !== item.chosen) changes.push({ question, from: item.chosen ?? 'aucune réponse', to });
    }

    // Même choix que celui de Claude : rien à corriger, c'est un « Ça me va ».
    if (!changes.length) {
      done[rec.id] = { action: 'ok', ts };
      writeJson(reviewFile, done);
      return { ok: true, correction: null, delivered: false, openUrl: null };
    }
    const correction = correctionText(changes);
    const openUrl = conversationLink(rec.sessionId, correction, dirs);
    done[rec.id] = { action: 'change', ts, answers, correction };
    writeJson(reviewFile, done);
    return { ok: true, correction, delivered: false, openUrl };
  }

  return { toReview, review, get };
}
