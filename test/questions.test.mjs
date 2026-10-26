// Tests des questions répondues à la place de l'utilisateur et de leur relecture : node --test test/
// Dossiers temporaires uniquement (données, registre des sessions, transcripts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuestions, buildRecord, appendRecord, correctionText, reviewEntry, promptParam, pickRecommended } from '../lib/questions.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-questions-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const RUNNING = '11111111-1111-4111-8111-111111111111';
const CLOSED = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '33333333-3333-4333-8333-333333333333';

function world() {
  const dir = fs.mkdtempSync(path.join(TMP, 'w-'));
  const dataDir = path.join(dir, 'data');
  const sessionsDir = path.join(dir, 'claude', 'sessions');
  const projectsDir = path.join(dir, 'claude', 'projects');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, '-Users-x-Code-atelier'), { recursive: true });
  // Conversation ouverte : processus vivant (le nôtre). Conversation fermée : seulement son transcript.
  fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: RUNNING, entrypoint: 'claude-vscode' }));
  fs.writeFileSync(path.join(sessionsDir, '7.json'), '{abîmé');
  fs.writeFileSync(path.join(projectsDir, '-Users-x-Code-atelier', `${CLOSED}.jsonl`), '{}\n');
  const file = path.join(dataDir, 'questions.jsonl');
  const add = (sessionId, tool_input, chosen, tool_name = 'AskUserQuestion') => {
    const r = buildRecord({ session_id: sessionId, cwd: '/Users/x/Code/atelier', tool_name, tool_input }, chosen);
    appendRecord(file, r);
    return r;
  };
  return { dataDir, sessionsDir, projectsDir, file, add, q: createQuestions({ dataDir, sessionsDir, projectsDir }) };
}

const FOND = { questions: [{ question: 'Quel fond pour la charte ?', header: 'Fond', multiSelect: false,
  options: [{ label: 'Fond B (recommandé)', description: 'sobre' }, { label: 'Fond A', description: 'vif' }] }] };
const TAGS = { questions: [{ question: 'Quelles pages ?', header: 'Pages', multiSelect: true,
  options: [{ label: 'Accueil' }, { label: 'Contact' }, { label: 'Blog' }] }] };

test('option recommandée : celle marquée, sinon la première', () => {
  assert.equal(pickRecommended(FOND.questions[0]).label, 'Fond B (recommandé)');
  assert.equal(pickRecommended(TAGS.questions[0]).label, 'Accueil');
  assert.equal(pickRecommended({}), null);
});

test('à relire : non relues, plus récentes d\'abord, forme du contrat', async () => {
  const w = world();
  assert.deepEqual(w.q.toReview(), []);
  const a = w.add(RUNNING, FOND, { 'Quel fond pour la charte ?': 'Fond B (recommandé)' });
  await new Promise((r) => setTimeout(r, 5));
  const b = w.add(CLOSED, TAGS, { 'Quelles pages ?': 'Accueil' });
  fs.appendFileSync(w.file, 'ligne abîmée\n');
  const list = w.q.toReview();
  assert.deepEqual(list.map((r) => r.id), [b.id, a.id]);
  assert.deepEqual(Object.keys(list[1]).sort(), ['cwd', 'id', 'items', 'sessionId', 'tool', 'ts']);
  assert.deepEqual(list[1].items[0], { question: 'Quel fond pour la charte ?', header: 'Fond', multiSelect: false,
    options: [{ label: 'Fond B (recommandé)', description: 'sobre' }, { label: 'Fond A', description: 'vif' }], chosen: 'Fond B (recommandé)' });
  const e = reviewEntry(list[1], 'Atelier');
  assert.deepEqual(e, { id: `q:${a.id}`, kind: 'question', conversationId: RUNNING, conversationTitle: 'Atelier',
    title: 'Quel fond pour la charte ?', detail: 'Vigie a pris « Fond B (recommandé) »', ts: a.ts, question: { id: a.id, items: a.items } });
});

test('« Ça me va » : sort de la liste, relecture enregistrée', () => {
  const w = world();
  const a = w.add(RUNNING, FOND, { 'Quel fond pour la charte ?': 'Fond B (recommandé)' });
  const r = w.q.review(`q:${a.id}`, { action: 'ok' });
  assert.deepEqual(r, { ok: true, correction: null, delivered: false, openUrl: null });
  assert.deepEqual(w.q.toReview(), []);
  const saved = JSON.parse(fs.readFileSync(path.join(w.dataDir, 'questions-review.json'), 'utf8'));
  assert.equal(saved[a.id].action, 'ok');
});

test('« Changer » : texte de correction, conversation ouverte => lien simple', () => {
  const w = world();
  const a = w.add(RUNNING, FOND, { 'Quel fond pour la charte ?': 'Fond B (recommandé)' });
  const r = w.q.review(a.id, { action: 'change', answers: { 'Quel fond pour la charte ?': 'Fond A' } });
  assert.equal(r.ok, true);
  assert.equal(r.correction, 'Pour la question « Quel fond pour la charte ? », je préfère finalement « Fond A » au lieu de « Fond B (recommandé) ». Reprends en tenant compte de ce choix.');
  assert.equal(r.delivered, false);
  assert.equal(r.openUrl, `vscode://anthropic.claude-code/open?session=${RUNNING}`);
  assert.deepEqual(w.q.toReview(), []);
  const saved = JSON.parse(fs.readFileSync(path.join(w.dataDir, 'questions-review.json'), 'utf8'))[a.id];
  assert.equal(saved.action, 'change');
  assert.equal(saved.correction, r.correction);
});

test('« Changer » : conversation fermée => le texte est pré-rempli ; inconnue => pas de lien', () => {
  const w = world();
  const closed = w.add(CLOSED, TAGS, { 'Quelles pages ?': 'Accueil' });
  const r = w.q.review(closed.id, { action: 'change', answers: { 'Quelles pages ?': ['Contact', 'Blog'] } });
  assert.equal(r.correction, 'Pour la question « Quelles pages ? », je préfère finalement « Contact, Blog » au lieu de « Accueil ». Reprends en tenant compte de ce choix.');
  const url = new URL(r.openUrl);
  assert.equal(url.protocol, 'vscode:');
  // Ce que fait VS Code puis l'extension : un décodage de la requête, puis URLSearchParams.
  const params = new URLSearchParams(decodeURIComponent(r.openUrl.split('?')[1]));
  assert.equal(params.get('session'), CLOSED);
  assert.equal(params.get('prompt'), r.correction);
  const unknown = w.add(UNKNOWN, FOND, {});
  assert.equal(w.q.review(unknown.id, { action: 'change', answers: { 'Quel fond pour la charte ?': 'Fond A' } }).openUrl, null);
  const bad = w.add('pas-un-uuid', FOND, {});
  assert.equal(w.q.review(bad.id, { action: 'change', answers: { 'Quel fond pour la charte ?': 'Fond A' } }).openUrl, null);
});

test('le texte pré-rempli survit aux deux décodages, même avec & + %', () => {
  const text = 'Pour « A & B + 100 % =x » ? Reprends.';
  assert.equal(new URLSearchParams(decodeURIComponent(`prompt=${promptParam(text)}`)).get('prompt'), text);
});

test('plusieurs questions : une phrase par changement', () => {
  const t = correctionText([{ question: 'Q1', from: 'a', to: 'b' }, { question: 'Q2', from: 'c', to: 'd' }]);
  assert.equal(t, 'Pour la question « Q1 », je préfère finalement « b » au lieu de « a ». Pour la question « Q2 », je préfère finalement « d » au lieu de « c ». Reprends en tenant compte de ces choix.');
});

test('relecture : erreurs claires, rien d\'enregistré', () => {
  const w = world();
  const a = w.add(RUNNING, FOND, { 'Quel fond pour la charte ?': 'Fond B (recommandé)' });
  assert.deepEqual(w.q.review('inconnue', { action: 'ok' }), { ok: false, status: 404, error: 'Question introuvable.' });
  assert.equal(w.q.review(a.id, { action: 'peut-être' }).status, 400);
  assert.equal(w.q.review(a.id, { action: 'change' }).status, 400);
  assert.equal(w.q.review(a.id, { action: 'change', answers: { 'Autre ?': 'Fond A' } }).error, 'Question inconnue.');
  assert.equal(w.q.review(a.id, { action: 'change', answers: { 'Quel fond pour la charte ?': 'Fond Z' } }).error, 'Choisis une des options proposées.');
  assert.equal(w.q.review(a.id, { action: 'change', answers: { 'Quel fond pour la charte ?': ['Fond A', 'Fond B (recommandé)'] } }).status, 400);
  assert.equal(fs.existsSync(path.join(w.dataDir, 'questions-review.json')), false);
  assert.equal(w.q.toReview().length, 1);
  // Même choix que Claude : c'est un « Ça me va ».
  assert.deepEqual(w.q.review(a.id, { action: 'change', answers: { 'Quel fond pour la charte ?': 'Fond B (recommandé)' } }),
    { ok: true, correction: null, delivered: false, openUrl: null });
});

test('plan validé à la place de l\'utilisateur : relisible et corrigeable', () => {
  const w = world();
  const p = w.add(RUNNING, { plan: '# Plan\n1. Refaire la charte' }, {}, 'ExitPlanMode');
  assert.equal(p.items[0].chosen, 'Valider le plan');
  assert.match(p.items[0].options[0].description, /Refaire la charte/);
  const r = w.q.review(p.id, { action: 'change', answers: { 'Valider le plan ?': 'Revoir le plan' } });
  assert.match(r.correction, /je préfère finalement « Revoir le plan » au lieu de « Valider le plan »/);
});

test('de bout en bout : le hook enregistre, la relecture le retrouve', () => {
  const w = world();
  const home = path.join(TMP, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(w.dataDir, { recursive: true });
  fs.writeFileSync(path.join(w.dataDir, 'state.json'), JSON.stringify({ questions: 'auto' }));
  const env = { ...process.env, VIGIE_DATA: w.dataDir, HOME: home };
  const hook = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'hook.mjs');
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLOSED, cwd: '/Users/x/Code/atelier', tool_name: 'AskUserQuestion', tool_input: FOND }), encoding: 'utf8', env });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'allow');
  const [rec] = w.q.toReview();
  assert.equal(rec.sessionId, CLOSED);
  assert.equal(rec.items[0].chosen, 'Fond B (recommandé)');
  const res = w.q.review(rec.id, { action: 'change', answers: { 'Quel fond pour la charte ?': 'Fond A' } });
  assert.match(res.openUrl, new RegExp(`^vscode://anthropic\\.claude-code/open\\?session=${CLOSED}&prompt=`));
  assert.deepEqual(w.q.toReview(), []);
});
