// Consommation en direct (rate) et alerte « s'emballe » (lib/usage.mjs) : calculs purs, sans fichier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateOf, runawayAlert, RATE_MINUTES, seriesFrom, seriesPoints, weekRatio, toWeekPct } from '../lib/usage.mjs';

const NOW = Date.parse('2026-10-20T12:00:30.000Z');
const iso = (min) => new Date(NOW + min * 60_000).toISOString();
// seaux minute par minute : fn(i) = poids de la minute i (la dernière est la minute en cours)
const buckets = (fn) => {
  const w = Array.from({ length: RATE_MINUTES }, (_, i) => fn(i));
  return { w, all: [...w], tok: w.map((x) => x * 10) };
};
const WEEK = { den: 1_000_000, pct: 50 }; // 1 000 000 de poids = 50 % de la semaine

test('rate : % de la semaine par heure sur 10 min, tokens par minute, 30 valeurs, tendance', () => {
  const r = rateOf(buckets((i) => (i >= RATE_MINUTES - 10 ? 1000 : i >= RATE_MINUTES - 20 ? 200 : 0)), WEEK);
  assert.equal(r.weekPctPerHour, 3, '10 000 en 10 min = 0,5 % → 3 %/h');
  assert.equal(r.tokensPerMin, 10_000);
  assert.equal(r.spark.length, 30);
  assert.equal(r.trend, 'up');
  assert.equal(rateOf(buckets(() => 0), WEEK).trend, 'flat');
  assert.equal(rateOf(buckets((i) => (i < RATE_MINUTES - 10 ? 500 : 0)), WEEK).trend, 'down');
  assert.equal(rateOf(buckets(() => 100), null).weekPctPerHour, null, 'sans semaine connue');
});

test('alerte : débit > 3 × la médiane des 2 h ET > 0,5 %/h', () => {
  // référence : 1000 par tranche de 10 min (100/min) ; maintenant 1000/min
  const hot = buckets((i) => (i >= RATE_MINUTES - 10 ? 1000 : 100));
  const a = runawayAlert({ now: NOW, buckets: hot, week: WEEK });
  assert.equal(a.kind, 'emballe');
  assert.match(a.reason, /^Consomme 3 % de la semaine par heure, 10 × son rythme/);
  assert.equal(runawayAlert({ now: NOW, buckets: hot, week: { den: 1e9, pct: 50 } }), null, 'sous 0,5 %/h : rien');
  assert.equal(runawayAlert({ now: NOW, buckets: buckets((i) => (i >= RATE_MINUTES - 10 ? 1000 : 0)), week: WEEK }), null, 'pas de référence : rien');
  assert.equal(runawayAlert({ now: NOW, buckets: buckets((i) => (i >= RATE_MINUTES - 10 ? 250 : 100)), week: WEEK }), null, '2,5 × : rien');
});

test('alerte : mêmes tests en échec ≥ 6 fois en 20 min ; étape rouge voulue et vieux échecs ignorés', () => {
  const fail = (min, extra = {}) => ({ ts: iso(min), ok: false, pending: false, command: 'npx vitest run', ...extra });
  const tests = [-19, -15, -12, -8, -4, -1].map((m) => fail(m));
  const a = runawayAlert({ now: NOW, buckets: null, week: null, tests });
  assert.equal(a.reason, 'Les mêmes tests échouent en boucle depuis 19 min (6 lancements).');
  assert.equal(a.since, iso(-19));
  assert.equal(runawayAlert({ now: NOW, tests: tests.slice(1) }), null, '5 fois : rien');
  assert.equal(runawayAlert({ now: NOW, tests: [...tests.slice(1), fail(-25)] }), null, 'hors des 20 min');
  assert.equal(runawayAlert({ now: NOW, tests: [...tests.slice(1), fail(-2, { red: true })] }), null, 'étape rouge voulue');
  assert.equal(runawayAlert({ now: NOW, tests: [...tests.slice(1), fail(-2, { command: 'npx tsc -b' })] }), null, 'autre commande');
});

test('alerte : un agent qui répète la même action ≥ 8 fois', () => {
  const act = (min, agent = 'ag1', detail = 'src/a.ts') => ({ ts: iso(min), agent, tool: 'Read', title: 'Lit a.ts', detail });
  const activity = [-18, -16, -14, -12, -10, -8, -6, -4].map((m) => act(m));
  const a = runawayAlert({ now: NOW, activity, agentLabel: () => 'faire:L2.24' });
  assert.equal(a.reason, 'L\'agent « faire:L2.24 » répète la même action en boucle (8 fois en 20 min) : Lit a.ts.');
  assert.equal(runawayAlert({ now: NOW, activity: activity.slice(1) }), null, '7 fois : rien');
  assert.equal(runawayAlert({ now: NOW, activity: activity.map((x) => ({ ...x, agent: null })) }), null, 'la conversation elle-même : pas cette règle');
  assert.equal(runawayAlert({ now: NOW, activity: [...activity.slice(1), act(-2, 'ag1', 'src/b.ts')] }), null, 'action différente');
});

test('graphique : 60 seaux alignés sur le pas, le dernier contient la minute en cours', () => {
  for (const step of [1, 10, 20]) {
    const from = seriesFrom(NOW, step);
    assert.equal(from % (step * 60_000), 0);
    assert.ok(NOW >= from + 59 * step * 60_000 && NOW < from + 60 * step * 60_000, `pas ${step}`);
  }
  const pts = seriesPoints(seriesFrom(NOW, 1), 1, [500_000, 0], [12, 0], WEEK);
  assert.deepEqual(pts.map((p) => [p.weekPct, p.tokens]), [[25, 12], [0, 0]]);
  assert.equal(seriesPoints(0, 1, [1], [1], null)[0].weekPct, null);
});

test('part de la semaine : un compte entamé ailleurs ne compte pas tout son pourcentage sur l’usage vu ici', () => {
  // Travail 1 : toute sa semaine passée ici (78 % pour 1 000 de poids) ; Travail 2, même abonnement : 49 % dont
  // presque tout ailleurs, seulement 50 de poids ici. Avant : 49/50 ≈ 1 point par unité, « 202 %/h ».
  const t1 = { measured: null, upper: 78 / 1000, tier: 'max_20x' };
  const t2 = { measured: null, upper: 49 / 50, tier: 'max_20x' };
  assert.equal(weekRatio(t2, [t1]), 78 / 1000, 'ramené au rythme du même abonnement');
  assert.equal(weekRatio(t1, [t2]), 78 / 1000, 'le plafond le plus bas reste le sien');
  assert.equal(weekRatio(t2, [{ ...t1, tier: 'pro' }]), 49 / 50, 'autre abonnement : rien à comparer');
  assert.equal(weekRatio({ ...t2, measured: 0.07 }, [t1]), 0.07, 'hausse mesurée : elle passe devant');
  assert.equal(weekRatio({ ...t2, tier: null }, [t1]), 49 / 50, 'abonnement inconnu : son propre plafond');
  assert.equal(toWeekPct(50, { ratio: 78 / 1000 }), 3.9);
  assert.equal(toWeekPct(50, { den: 50, pct: 49 }), 49, 'ancien calcul sans ratio');
});
