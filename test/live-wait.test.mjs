// Attentes annoncées par Claude Code dans son registre (lib/live-wait.mjs) et relecture d'une entrée du registre
// (Indexer.liveNow) : node --test test/
// En mode VS Code, Claude Code se dit « en attente » (status waiting, waitingFor « permission prompt ») au moment même où
// il lance le hook PermissionRequest de Vigie, qui accepte en ~120 ms : seule une attente de 20 s ou plus est vraie.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-attente-'));
const CLAUDE = path.join(TMP, 'home', '.claude');
process.env.HOME = path.join(TMP, 'home');
process.env.VIGIE_DATA = path.join(TMP, 'data');
process.env.VIGIE_CLAUDE_DIR = CLAUDE;
const { WAIT_CONFIRM_MS, WAIT_SEEN_MS, isWaiting, waitStart, createWaitTracker, confirmedWait, waitWording } = await import('../lib/live-wait.mjs');
const { Indexer } = await import('../lib/indexer.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const waiting = (more = {}) => ({ status: 'waiting', waitingFor: 'permission prompt', ...more });

test('attente : 20 s sans interruption, comptées depuis statusUpdatedAt', () => {
  assert.equal(WAIT_CONFIRM_MS, 20_000);
  // la fenêtre de permission que Vigie accepte seule : quelques dixièmes de seconde, ou quelques secondes au pire
  assert.equal(confirmedWait({ snapshot: waiting({ statusUpdatedAt: NOW - 120 }), now: NOW }), null);
  assert.equal(confirmedWait({ snapshot: waiting({ statusUpdatedAt: NOW - 2000 }), now: NOW }), null);
  assert.equal(confirmedWait({ snapshot: waiting({ statusUpdatedAt: NOW - 19_999 }), now: NOW }), null);
  // une vraie attente
  assert.deepEqual(confirmedWait({ snapshot: waiting({ statusUpdatedAt: NOW - 20_000 }), now: NOW }), { since: NOW - 20_000, waitingFor: 'permission prompt' });
  assert.deepEqual(confirmedWait({ snapshot: { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - 25_000 }, now: NOW }),
    { since: NOW - 25_000, waitingFor: 'input needed' });
  // waitingFor seul suffit (même règle que statusOf) ; pas en attente : rien
  assert.ok(isWaiting({ status: 'busy', waitingFor: 'permission prompt' }));
  assert.ok(!isWaiting({ status: 'busy' }) && !isWaiting(null) && !isWaiting(undefined));
  assert.equal(confirmedWait({ snapshot: { status: 'busy', statusUpdatedAt: NOW - 60_000 }, now: NOW }), null);
  assert.equal(confirmedWait({ snapshot: undefined, now: NOW }), null);
  assert.equal(waitStart({ status: 'busy', statusUpdatedAt: NOW }), null, 'pas en attente : pas de début d\'attente');
});

test('attente : le registre relu à l\'instant passe devant la photo', () => {
  const snapshot = waiting({ statusUpdatedAt: NOW - 25_000 });
  // Paul vient de répondre : le fichier dit « busy », la photo (4 s au plus) dit encore « en attente »
  assert.equal(confirmedWait({ snapshot, fresh: { status: 'busy', statusUpdatedAt: NOW - 300 }, now: NOW }), null);
  // conversation fermée entre-temps
  assert.equal(confirmedWait({ snapshot, fresh: null, now: NOW }), null);
  // fichier illisible (en cours d'écriture) : la photo seule
  assert.deepEqual(confirmedWait({ snapshot, fresh: undefined, now: NOW }), { since: NOW - 25_000, waitingFor: 'permission prompt' });
  // une nouvelle attente vient de commencer (Vigie a accepté la précédente) : elle compte depuis son propre début
  assert.equal(confirmedWait({ snapshot, fresh: waiting({ statusUpdatedAt: NOW - 150 }), now: NOW }), null);
  // l'attente a changé de nature : le texte suit le fichier relu
  assert.deepEqual(confirmedWait({ snapshot, fresh: { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - 21_000 }, now: NOW }),
    { since: NOW - 21_000, waitingFor: 'input needed' });
});

test('attente : filet, vue en attente sur chaque photo depuis 60 s même si statusUpdatedAt dit moins', () => {
  assert.equal(WAIT_SEEN_MS, 60_000);
  const recent = waiting({ statusUpdatedAt: NOW - 1000 });
  assert.equal(confirmedWait({ snapshot: recent, firstSeen: NOW - 59_000, now: NOW }), null);
  assert.deepEqual(confirmedWait({ snapshot: recent, firstSeen: NOW - 60_000, now: NOW }), { since: NOW - 60_000, waitingFor: 'permission prompt' });
  // le fichier relu dit qu'elle ne l'attend plus : rien, même au-delà de 60 s
  assert.equal(confirmedWait({ snapshot: recent, fresh: { status: 'busy' }, firstSeen: NOW - 90_000, now: NOW }), null);
});

test('attente sans statusUpdatedAt (Claude Code plus ancien) : 20 s depuis la première photo qui l\'a vue', () => {
  const tracker = createWaitTracker();
  const live = (entry) => new Map([['s1', entry], ['s2', { status: 'busy' }]]);
  tracker.note(live(waiting()), NOW);
  assert.equal(tracker.firstSeen('s1'), NOW);
  assert.equal(tracker.firstSeen('s2'), null, 'une conversation qui travaille n\'a pas d\'attente');
  // photos suivantes, toujours la même attente : le début ne bouge pas
  tracker.note(live(waiting()), NOW + 4000);
  tracker.note(live(waiting()), NOW + 8000);
  assert.equal(tracker.firstSeen('s1'), NOW);
  const at = (t) => confirmedWait({ snapshot: waiting(), firstSeen: tracker.firstSeen('s1'), now: t });
  assert.equal(at(NOW + 8000), null);
  assert.deepEqual(at(NOW + 20_000), { since: NOW, waitingFor: 'permission prompt' });
  // jamais vue par le moteur : pas confirmée
  assert.equal(confirmedWait({ snapshot: waiting(), firstSeen: null, now: NOW }), null);
  // elle change de nature : elle repart de zéro
  tracker.note(live({ status: 'waiting', waitingFor: 'input needed' }), NOW + 12_000);
  assert.equal(tracker.firstSeen('s1'), NOW + 12_000);
  // elle reprend le travail : oubliée, la suivante repart de zéro
  tracker.note(live({ status: 'busy' }), NOW + 16_000);
  assert.equal(tracker.firstSeen('s1'), null);
  tracker.note(live(waiting()), NOW + 20_000);
  assert.equal(tracker.firstSeen('s1'), NOW + 20_000);
  // fermée : oubliée
  tracker.note(new Map(), NOW + 24_000);
  assert.equal(tracker.firstSeen('s1'), null);
});

test('attente : textes en français, jamais celui de Claude Code', () => {
  const accord = waitWording('permission prompt');
  assert.equal(accord.title('VS Code'), 'Attend ton accord dans VS Code');
  assert.equal(accord.detail, 'Une action à autoriser : Vigie ne l\'a pas validée seule.');
  const question = waitWording('input needed');
  assert.equal(question.title('VS Code'), 'Attend ta réponse dans VS Code');
  assert.equal(question.detail, 'Une question ou un choix à faire.');
  for (const other of ['dialog open', 'sandbox request', null, undefined]) {
    assert.equal(waitWording(other).title('l\'app Claude'), 'Attend ta réponse dans l\'app Claude');
    assert.equal(waitWording(other).detail, 'Elle attend ta réponse.');
  }
});

test('registre : une conversation relue à l\'instant (fichier changé, disparu, illisible, repris par une autre)', () => {
  const sessions = path.join(TMP, 'sessions');
  const projects = path.join(TMP, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const SID = '3b8c0d1e-2f4a-4b6c-8d0e-1f2a3b4c5d6e';
  const reg = path.join(sessions, `${process.pid}.json`);
  const set = (o) => fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: SID, ...o }));
  const ix = new Indexer({ projectsDir: projects, sessionsDir: sessions });
  assert.equal(ix.liveNow(SID), undefined, 'avant toute photo : rien de connu');
  set(waiting({ statusUpdatedAt: NOW - 25_000 }));
  ix.readLive();
  assert.equal(ix.live.get(SID).status, 'waiting');
  // le fichier change après la photo : liveNow le dit, la photo non
  set({ status: 'busy', statusUpdatedAt: NOW });
  assert.equal(ix.live.get(SID).status, 'waiting');
  assert.equal(ix.liveNow(SID).status, 'busy');
  // fichier en cours d'écriture : undefined (s'en tenir à la photo)
  fs.writeFileSync(reg, '{"pid":');
  assert.equal(ix.liveNow(SID), undefined);
  // repris par une autre conversation du même processus (/clear) : null
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: 'autre', status: 'waiting' }));
  assert.equal(ix.liveNow(SID), null);
  // processus mort : null
  fs.writeFileSync(reg, JSON.stringify({ pid: 999_999_999, sessionId: SID, status: 'waiting' }));
  assert.equal(ix.liveNow(SID), null);
  // fichier disparu (conversation fermée) : null
  fs.rmSync(reg);
  assert.equal(ix.liveNow(SID), null);
  assert.equal(ix.liveNow('inconnue'), undefined);
});
