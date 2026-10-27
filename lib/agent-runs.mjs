// Vigie — lancements d'agents et leurs rapports. Chaque lancement est noté (data/agent-runs.json, 50 au plus, le
// dernier par agent et par dossier) ; l'agent tient à jour <dossier>/.vigie/rapport-<id>.json (forme décrite dans son
// brief, lib/agents.mjs). GET /api/v2/agents/runs les montre, lus à chaque appel, vérifiés et bornés ; POST coche une
// action du rapport (réécrit le fichier, le reste intact) ou retire un lancement de la liste (le fichier reste).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_RUNS = 50;
const REPORT_MAX_BYTES = 256 * 1024;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f\p{Zl}\p{Zp}]+/gu;
// Un texte du rapport, sur une ligne et borné ; autre chose : null.
const line = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(CONTROL, ' ').trim().slice(0, max) : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 100_000) : 0);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

export const reportName = (agent) => `rapport-${agent}.json`;

// Le rapport tel que l'app le montre : chaque champ vérifié, le reste ignoré. `folder` : pour situer le rapport
// Markdown (chemin relatif, dans le dossier du projet).
export function cleanReport(raw, folder) {
  if (!isObj(raw)) return null;
  const status = ['running', 'done', 'blocked'].includes(raw.status) ? raw.status : 'running';
  const level = ['ok', 'warn', 'block'].includes(raw.level) ? raw.level : null;
  const c = isObj(raw.counts) ? raw.counts : {};
  let report = null;
  if (typeof raw.report === 'string' && raw.report.trim() && !path.isAbsolute(raw.report)) {
    const p = path.resolve(folder, raw.report.trim());
    if (p.startsWith(folder + path.sep)) report = path.relative(folder, p);
  }
  const links = (Array.isArray(raw.links) ? raw.links : []).filter(isObj).map((l) => {
    let url = null;
    try { const u = new URL(String(l.url)); if (u.protocol === 'https:') url = u.toString(); } catch { /* pas une adresse */ }
    return url && line(l.label, 80) ? { label: line(l.label, 80), url: url.slice(0, 2000) } : null;
  }).filter(Boolean).slice(0, 10);
  const todo = (Array.isArray(raw.todo) ? raw.todo : []).slice(0, 100).map((t) => {
    if (typeof t === 'string') t = { text: t };
    if (!isObj(t) || !line(t.text, 300)) return null;
    return {
      text: line(t.text, 300), where: line(t.where, 200),
      severity: ['block', 'warn', 'info'].includes(t.severity) ? t.severity : 'warn', done: t.done === true,
    };
  });
  return {
    status, level,
    title: line(raw.title, 200), verdict: line(raw.verdict, 300),
    counts: { ok: count(c.ok), warn: count(c.warn), block: count(c.block) },
    report, links,
    done: (Array.isArray(raw.done) ? raw.done : []).map((d) => line(d, 300)).filter(Boolean).slice(0, 50),
    // l'index de chaque action dans le fichier, pour la cocher (une entrée illisible garde sa place)
    todo: todo.map((t, index) => (t ? { ...t, index } : null)).filter(Boolean),
    updatedAt: typeof raw.updatedAt === 'string' && ISO.test(raw.updatedAt) ? raw.updatedAt : null,
  };
}

export function createRuns({ dataDir, now = () => new Date() }) {
  const FILE = path.join(dataDir, 'agent-runs.json');

  function read() {
    let j;
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
    return (Array.isArray(j?.runs) ? j.runs : []).filter((r) => isObj(r) && typeof r.id === 'string' && typeof r.agent === 'string'
      && typeof r.folder === 'string' && path.isAbsolute(r.folder) && typeof r.at === 'string').slice(0, MAX_RUNS);
  }
  function write(runs) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ runs: runs.slice(0, MAX_RUNS) }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }

  // Le fichier du rapport : un vrai fichier (pas un lien), dans <dossier>/.vigie, de taille raisonnable.
  function reportFile(run) { return path.join(run.folder, '.vigie', reportName(run.agent)); }
  function readReport(run) {
    const file = reportFile(run);
    let st;
    try { st = fs.lstatSync(file); } catch { return { report: null, mtime: null }; }
    if (!st.isFile() || st.size > REPORT_MAX_BYTES) return { report: null, mtime: null };
    try { return { raw: JSON.parse(fs.readFileSync(file, 'utf8')), report: null, mtime: st.mtimeMs }; } catch { return { report: null, mtime: st.mtimeMs, unreadable: true }; }
  }

  // Un lancement : il remplace le précédent du même agent dans le même dossier ; le rapport repart « en cours ».
  function record({ agent, name, icon = null, folder, surface = null, session = null }) {
    const run = { id: crypto.randomUUID(), agent, name, icon, folder, surface, session, at: now().toISOString() };
    write([run, ...read().filter((r) => !(r.agent === agent && r.folder === folder))]);
    try {
      const file = reportFile(run);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ status: 'running', title: name, updatedAt: run.at }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* l'agent l'écrira */ }
    return run;
  }

  // GET /api/v2/agents/runs : les lancements montrés, le plus récent d'abord, avec leur rapport.
  function list() {
    return read().filter((r) => !r.hidden).map((r) => {
      const { raw, mtime, unreadable } = readReport(r);
      const report = raw ? cleanReport(raw, r.folder) : null;
      return {
        id: r.id, agent: r.agent, name: r.name || r.agent, icon: r.icon || null, folder: r.folder, surface: r.surface || null,
        session: r.session || null, at: r.at, report, reportFile: reportFile(r), unreadable: !!unreadable,
        changedAt: mtime ? new Date(mtime).toISOString() : null,
      };
    });
  }

  // POST /api/v2/agents/runs { action: "todo", id, index, done } : coche ou décoche une action du rapport.
  function setTodo({ id, index, done }) {
    const run = read().find((r) => r.id === id);
    if (!run) return { ok: false, status: 404, error: 'Lancement introuvable.' };
    const { raw } = readReport(run);
    if (!raw || !Array.isArray(raw.todo) || !Number.isInteger(index) || index < 0 || index >= raw.todo.length) {
      return { ok: false, status: 400, error: 'Action introuvable dans le rapport.' };
    }
    const t = raw.todo[index];
    raw.todo[index] = { ...(isObj(t) ? t : { text: String(t) }), done: done === true };
    const file = reportFile(run);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { return { ok: false, status: 400, error: 'Rapport impossible à écrire.' }; }
    return { ok: true };
  }

  // { action: "hide", id } : retiré de la liste de Vigie (le rapport reste dans le dossier du projet).
  function hide({ id }) {
    const runs = read();
    const run = runs.find((r) => r.id === id);
    if (!run) return { ok: false, status: 404, error: 'Lancement introuvable.' };
    run.hidden = true;
    write(runs);
    return { ok: true };
  }

  // Les dossiers .vigie des lancements montrés : le moteur les surveille pour prévenir l'app d'un rapport changé.
  const watched = () => read().filter((r) => !r.hidden).slice(0, 20).map((r) => path.join(r.folder, '.vigie'));

  return { record, list, setTodo, hide, watched, file: FILE };
}
