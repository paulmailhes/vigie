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
const { WAIT_CONFIRM_MS, WAIT_SEEN_MS, HOOK_MARGIN_MS, SEEN_LATE_MS, CLOSE_HOLD_MS, HOOK_WAIT_EVENTS, isWaiting, waitStart, createWaitTracker, confirmedWait,
  waitWording, opensHookWait, heldByHook } = await import('../lib/live-wait.mjs');
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
  // l'utilisateur vient de répondre : le fichier dit « busy », la photo (4 s au plus) dit encore « en attente »
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

// Le moteur retire l'attente du hook dès que l'utilisateur décide ou répond dans Vigie ; le hook ne lit decisions.json
// qu'une fois par seconde, et le registre dit « en attente » depuis l'ouverture de la fenêtre jusqu'à sa réponse. Seul ce
// moment-là est tenu : un hook arrêté sans rien écrire (fin de vie, plantage, tué) ne tient rien.
test('attente du hook : sa fenêtre est tenue le temps que le hook lise la décision donnée dans Vigie, pas au-delà', () => {
  assert.equal(HOOK_MARGIN_MS, 2000);
  assert.equal(CLOSE_HOLD_MS, 5000);
  const SID = 'conv-1';
  const at = (ms) => new Date(ms).toISOString();
  const line = (ms, event, more = {}) => ({ ts: at(ms), event, sessionId: SID, action: 'git push --force', pid: 4242, ...more });
  const since = NOW - 60_000;
  const wait = { since, waitingFor: 'permission prompt' };
  const decided = new Set(['4242']); // entrée de decisions.json pour ce pid
  const held = (history, { w = wait, firstSeen = null, d = new Set(), now = NOW } = {}) =>
    heldByHook({ wait: w, history, sessionId: SID, firstSeen, decided: d, now });
  const choices = { questions: [{ question: 'Quel menu ?', options: [{ label: 'Haut' }, { label: 'Bas' }] }] };
  // décision ou réponse donnée dans Vigie, pas encore lue par le hook : la fenêtre du hook
  assert.equal(held([line(since + 150, 'garde-fou-attente')], { d: decided }), true);
  assert.equal(held([line(since + 150, 'question-attente', { minutes: 20 })], { d: decided }), true);
  assert.equal(held([line(since + 300, 'question-pour-toi', choices)], { d: decided }), true);
  assert.equal(held([line(since + 300, 'question-pour-toi', { tool: 'ExitPlanMode', questions: [] })], { d: decided }), true, 'un plan en attente du hook');
  assert.equal(held([line(since - 1500, 'garde-fou-attente')], { d: decided }), true, 'le hook peut écrire juste avant le registre');
  assert.equal(held([line(since - HOOK_MARGIN_MS, 'garde-fou-attente')], { d: decided }), true, 'limite : 2 s');
  // le hook l'a lue et a répondu (sa ligne de fin) : le registre suit dans l'instant, tenue 5 s
  assert.equal(held([line(since + 150, 'garde-fou-attente'), line(NOW - 100, 'garde-fou-autorise-app')]), true);
  assert.equal(held([line(since + 150, 'question-pour-toi', choices), line(NOW - 100, 'question-repondue-app')]), true);
  assert.equal(held([line(since + 150, 'garde-fou-attente'), line(NOW - CLOSE_HOLD_MS, 'garde-fou-refuse-app')]), true, 'limite : 5 s');
  assert.equal(held([line(since + 150, 'garde-fou-attente'), line(NOW - CLOSE_HOLD_MS - 1, 'garde-fou-autorise-app')]), false,
    'plus de 5 s après sa réponse, la fenêtre est toujours là : elle attend vraiment');
  // la ligne d'un autre processus (le suivi détaché d'une action autorisée a son pid) ne ferme pas cette attente
  assert.equal(held([line(since + 150, 'garde-fou-attente'), line(NOW - 100, 'garde-fou-echec', { pid: 5151 })]), false);
  // hook arrêté sans rien écrire, rien de décidé : rien ne tient la fenêtre, elle attend vraiment
  assert.equal(held([line(since + 150, 'garde-fou-attente')]), false);
  assert.equal(held([line(since + 300, 'question-pour-toi', choices)]), false, 'tué (SIGKILL)');
  assert.equal(held([line(since + 300, 'question-pour-toi', choices), { ts: at(NOW - 100), event: 'erreur-hook', error: 'TypeError', sessionId: SID }]), false, 'planté');
  const old = { since: NOW - 7_260_000, waitingFor: 'input needed' };
  assert.equal(held([line(old.since + 300, 'question-pour-toi', choices)], { w: old }), false, 'question restée 2 h 01 sans réponse, hook en fin de vie');
  // pas une attente du hook : question laissée à VS Code (sans `questions`), autre conversation, attente plus ancienne
  assert.equal(held([line(since + 150, 'question-pour-toi')], { d: decided }), false);
  assert.equal(held([line(since + 150, 'garde-fou-attente', { sessionId: 'conv-2' })], { d: decided }), false);
  assert.equal(held([line(since - 2001, 'garde-fou-attente')], { d: decided }), false, 'une autre fenêtre, ouverte plus de 2 s après celle du hook');
  assert.equal(held([line(since - 30_000, 'garde-fou-attente'), line(since - 20_000, 'garde-fou-autorise-app')], { d: decided }), false);
  // le hook rend la fenêtre à l'utilisateur : elle l'attend vraiment
  for (const ev of ['garde-fou-rendu', 'question-rendue', 'demande-pour-toi', 'garde-fou-pour-toi', 'reponse-perdue']) {
    assert.equal(held([line(since + 150, 'garde-fou-attente'), line(NOW - 100, ev)], { d: decided }), false, ev);
  }
  // … puis la reprend (mode « attendre » remis pendant la question) : de nouveau la sienne
  assert.equal(held([line(since + 150, 'question-attente'), line(since + 9000, 'question-rendue'), line(since + 12_000, 'question-attente')], { d: decided }), true);
  // registre sans statusUpdatedAt : `since` est la première photo qui l'a vue, jusqu'à un tour plus tard
  assert.equal(held([line(since - 6000, 'garde-fou-attente')], { firstSeen: since, d: decided }), true);
  assert.equal(held([line(since - 6000, 'garde-fou-attente')], { firstSeen: since - 6000, d: decided }), false);
  assert.equal(held([line(since - 2000 - SEEN_LATE_MS - 1, 'garde-fou-attente')], { firstSeen: since, d: decided }), false);
  // rien à juger
  assert.equal(held([line(since, 'garde-fou-attente')], { w: null, d: decided }), false);
  assert.equal(heldByHook({ wait, history: null, sessionId: SID, decided }), false);
  assert.equal(heldByHook({ wait, history: [line(since + 150, 'garde-fou-attente')], sessionId: SID }), false, 'sans liste des décisions');
  assert.equal(held([], { d: decided }), false);
  // même règle d'ouverture que pendingWaits
  assert.deepEqual([...HOOK_WAIT_EVENTS], ['garde-fou-attente', 'question-attente']);
  assert.equal(opensHookWait({ event: 'question-pour-toi', questions: [] }), true);
  assert.equal(opensHookWait({ event: 'question-pour-toi' }), false);
  assert.equal(opensHookWait(null), false);
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
