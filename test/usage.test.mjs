// Consommation en direct (rate) et alerte « s'emballe » (lib/usage.mjs) : calculs purs, sans fichier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateOf, runawayAlert, RATE_MINUTES, seriesFrom, seriesPoints, weekRatio, toWeekPct, weekFullAt } from '../lib/usage.mjs';

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
  const act = (min, agent = 'ag1', detail = 'src/a.ts') => ({ ts: iso(min), agent, tool: 'Read', title: 'Lire a.ts', detail });
  const activity = [-18, -16, -14, -12, -10, -8, -6, -4].map((m) => act(m));
  const a = runawayAlert({ now: NOW, activity, agentLabel: () => 'faire:L2.24' });
  assert.equal(a.reason, 'L\'agent « faire:L2.24 » répète la même action en boucle (8 fois en 20 min) : Lire a.ts.');
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
  // compte à 100 % qui continue en usage supplémentaire : son plafond est trop bas, il ne sert pas de référence
  assert.equal(weekRatio(t1, [{ measured: null, upper: 100 / 9000, tier: 'max_20x', pct: 100 }]), 78 / 1000);
  assert.equal(toWeekPct(50, { ratio: 78 / 1000 }), 3.9);
  assert.equal(toWeekPct(50, { den: 50, pct: 49 }), 49, 'ancien calcul sans ratio');
});

test('jusqu\'où tient le compte : pente des dernières 24 h d\'après les vrais relevés, au quart d\'heure', () => {
  const H = 3600_000;
  const reset = new Date(NOW + 72 * H).toISOString();
  const pt = (h, pct, resetsAt = reset) => ({ t: new Date(NOW + h * H).toISOString(), pct, resetsAt });
  const week = (pct) => ({ pct, resetsAt: reset });
  // 10 % il y a 24 h, 40 % maintenant : 30 points en 24 h → les 60 restants en 48 h
  const full = weekFullAt([pt(-30, 9), pt(-24, 10), pt(-10, 25), pt(-1, 40)], week(40), NOW);
  assert.ok(full > NOW + 48 * H - 60_000 && full <= NOW + 48 * H + 15 * 60_000, 'pleine vers dans 48 h');
  assert.equal(full % (15 * 60_000), 0, 'au quart d\'heure');
  // même hausse, mais une remise à zéro dans 40 h : elle tient
  const soon = new Date(NOW + 40 * H).toISOString();
  assert.equal(weekFullAt([pt(-30, 10, soon), pt(-1, 40, soon)], { pct: 40, resetsAt: soon }, NOW), null);
  // pas de relevé d'avant les 24 h : la moyenne depuis le début de la semaine (il y a 96 h, à 0 %), pas la pente de
  // quelques heures de travail
  const fromStart = weekFullAt([pt(-6, 70), pt(-1, 85)], week(85), NOW);
  assert.ok(Math.abs(fromStart - (NOW + 15 * 96 / 85 * H)) <= 15 * 60_000, '85 points en 96 h → les 15 restants en 17 h');
  // semaine commencée il y a 15 h, 1 % il y a 2 h, 6 % maintenant : 0,4 %/h en moyenne, elle tient jusqu'à la remise
  const fresh = new Date(NOW + (7 * 24 - 15) * H).toISOString();
  assert.equal(weekFullAt([pt(-2, 1, fresh)], { pct: 6, resetsAt: fresh }, NOW), null);
  // premier soir de la semaine (remise à zéro il y a 3 h) : 8 % en 3 h se mesure sur 24 h (à 0 % avant la remise),
  // pas de fausse alerte qui prendrait la seule notification de la semaine ; 30 % en 3 h, si
  const firstDay = new Date(NOW + (7 * 24 - 3) * H).toISOString();
  assert.equal(weekFullAt([pt(-2, 1, firstDay)], { pct: 8, resetsAt: firstDay }, NOW), null, '8 % en 3 h');
  const justReset = new Date(NOW + (7 * 24 - 5 / 60) * H).toISOString();
  assert.equal(weekFullAt([], { pct: 3, resetsAt: justReset }, NOW), null, '3 % dans les 5 min après la remise à zéro');
  const rush = weekFullAt([pt(-2, 1, firstDay)], { pct: 30, resetsAt: firstDay }, NOW);
  assert.ok(Math.abs(rush - (NOW + 70 / (30 / 24) * H)) <= 15 * 60_000, '30 % en 3 h → les 70 restants en 56 h');
  // trou de relevés : 30 % vendredi 18:00, Mac en veille tout le week-end, 55 % lundi 09:00 (usage fait ailleurs). La
  // hausse du trou n'est pas comptée en 24 h : 0,4 %/h, elle tient jusqu'à la remise dans 83 h
  const later = new Date(NOW + 83 * H).toISOString();
  assert.equal(weekFullAt([pt(-63, 30, later)], { pct: 55, resetsAt: later }, NOW), null, 'week-end sans relevé');
  // moins de 3 points de hausse : rien à mesurer
  assert.equal(weekFullAt([pt(-30, 38), pt(-1, 40)], week(40), NOW), null);
  // relevés d'une autre semaine ignorés
  assert.equal(weekFullAt([pt(-30, 10, new Date(NOW - 100 * H).toISOString())], week(40), NOW), null);
  // déjà pleine : le premier relevé à 100 %
  assert.equal(weekFullAt([pt(-5, 90), pt(-2, 100)], week(100), NOW), Date.parse(pt(-2, 100).t));
  // rien de lisible
  assert.equal(weekFullAt([], { pct: null, resetsAt: reset }, NOW), null);
  assert.equal(weekFullAt(null, week(40), NOW), null);
  assert.equal(weekFullAt([pt(-30, 10)], { pct: 40, resetsAt: new Date(NOW - H).toISOString() }, NOW), null, 'semaine déjà remise à zéro');
});
