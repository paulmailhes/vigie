// Lancements d'agents et leurs rapports (lib/agent-runs.mjs) : notés, lus vérifiés, cochés, retirés.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuns, cleanReport, reportName } from '../lib/agent-runs.mjs';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie lancements-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
function world() {
  const root = path.join(TMP, `monde-${++n}`);
  const folder = path.join(root, 'Code', 'celso');
  fs.mkdirSync(path.join(folder, '.vigie'), { recursive: true });
  const runs = createRuns({ dataDir: path.join(root, 'données'), now: () => new Date('2026-10-27T18:00:00Z') });
  const file = path.join(folder, '.vigie', reportName('controle'));
  return { root, folder, runs, file, write: (o) => fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o)) };
}

test('lancement noté : le rapport part « en cours » ; un nouveau lancement remplace le précédent du même agent et dossier', () => {
  const W = world();
  const a = W.runs.record({ agent: 'controle', name: 'Contrôler un site', icon: 'checkmark.seal', folder: W.folder, surface: 'vscode' });
  let list = W.runs.list();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].name, list[0].icon, list[0].report.status, list[0].report.title], [a.id, 'Contrôler un site', 'checkmark.seal', 'running', 'Contrôler un site']);
  assert.equal(fs.statSync(W.file).mode & 0o777, 0o600);
  W.runs.record({ agent: 'autre', name: 'Autre', folder: W.folder });
  const b = W.runs.record({ agent: 'controle', name: 'Contrôler un site', folder: W.folder, session: 's1' });
  list = W.runs.list();
  assert.deepEqual(list.map((r) => [r.agent, r.session]), [['controle', 's1'], ['autre', null]], 'le dernier d\'abord, un par agent et dossier');
  assert.equal(list[0].id, b.id);
});

test('rapport vérifié : champs bornés, adresses https seulement, chemin du rapport dans le dossier, actions avec leur place', () => {
  const W = world();
  const run = W.runs.record({ agent: 'controle', name: 'Contrôler', folder: W.folder });
  W.write({
    status: 'done', level: 'warn', title: 'Contrôle\navant publication', verdict: 'Prêt après 2 actions', counts: { ok: 41, warn: 6, block: -1 },
    report: 'docs/controle.md', links: [{ label: 'Webflow', url: 'https://webflow.com/x' }, { label: 'Piège', url: 'javascript:alert(1)' }, { url: 'https://sans-nom' }],
    done: ['12 titres SEO réécrits', 7, ''], todo: [{ text: 'Brancher le domaine', where: 'Site settings › Publishing', severity: 'block' }, 3, 'Relier les fiches CMS', { text: 'x'.repeat(500), done: true, severity: 'grave' }],
    updatedAt: '2026-10-27T18:30:00Z', secret: 'ignoré',
  });
  const r = W.runs.list()[0].report;
  assert.deepEqual([r.status, r.level, r.title, r.verdict, r.counts], ['done', 'warn', 'Contrôle avant publication', 'Prêt après 2 actions', { ok: 41, warn: 6, block: 0 }]);
  assert.equal(r.report, path.join('docs', 'controle.md'));
  assert.deepEqual(r.links, [{ label: 'Webflow', url: 'https://webflow.com/x' }]);
  assert.deepEqual(r.done, ['12 titres SEO réécrits']);
  assert.deepEqual(r.todo.map((t) => [t.index, t.text.length, t.severity, t.done]), [[0, 19, 'block', false], [2, 21, 'warn', false], [3, 300, 'warn', true]]);
  assert.ok(!('secret' in r));
  for (const report of ['../../ailleurs.md', '/etc/passwd', 'docs/../../x.md']) assert.equal(cleanReport({ report }, W.folder).report, null, report);
  // illisible, trop gros, lien : pas de rapport
  W.write('{ pas du json');
  assert.deepEqual([W.runs.list()[0].report, W.runs.list()[0].unreadable], [null, true]);
  W.write('x'.repeat(300 * 1024));
  assert.equal(W.runs.list()[0].report, null);
  fs.rmSync(W.file);
  fs.symlinkSync('/etc/hosts', W.file);
  assert.equal(W.runs.list()[0].report, null);
  assert.ok(run.id);
});

test('cocher une action : le fichier garde tout le reste ; retirer un lancement : le rapport reste dans le dossier', () => {
  const W = world();
  const run = W.runs.record({ agent: 'controle', name: 'Contrôler', folder: W.folder });
  W.write({ status: 'done', todo: [{ text: 'Brancher le domaine', severity: 'block', note: 'gardée' }, 'Relier les fiches'], perso: { a: 1 } });
  assert.deepEqual(W.runs.setTodo({ id: run.id, index: 1, done: true }), { ok: true });
  const raw = JSON.parse(fs.readFileSync(W.file, 'utf8'));
  assert.deepEqual(raw.todo, [{ text: 'Brancher le domaine', severity: 'block', note: 'gardée' }, { text: 'Relier les fiches', done: true }]);
  assert.deepEqual(raw.perso, { a: 1 });
  assert.equal(W.runs.list()[0].report.todo[1].done, true);
  for (const bad of [{ id: run.id, index: 9, done: true }, { id: run.id, index: '0', done: true }, { id: 'inconnu', index: 0, done: true }]) {
    assert.equal(W.runs.setTodo(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(W.runs.watched(), [path.join(W.folder, '.vigie')]);
  assert.deepEqual(W.runs.hide({ id: run.id }), { ok: true });
  assert.deepEqual(W.runs.list(), []);
  assert.deepEqual(W.runs.watched(), []);
  assert.ok(fs.existsSync(W.file), 'le rapport reste dans le dossier du projet');
  assert.equal(W.runs.hide({ id: 'inconnu' }).ok, false);
});
