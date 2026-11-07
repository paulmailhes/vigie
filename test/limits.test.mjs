// Limites atteintes (lib/limits.mjs) : remise à zéro lue dans le texte de Claude Code, et texte en français.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitResetAt, limitScope, limitView, resetText, hourText, dayText } from '../lib/limits.mjs';

// Une heure locale fixe (le Mac affiche l'heure locale) : lundi 26 octobre 2026, 01:10.
const T0 = new Date(2026, 9, 26, 1, 10).getTime();
const ts = new Date(T0).toISOString();
const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();

test('remise à zéro : heure seule, date, ancienne forme en secondes, sinon 5 h ou 7 jours', () => {
  assert.equal(limitResetAt('You\'ve hit your session limit · resets 3:40am', ts), at(2026, 9, 26, 3, 40));
  assert.equal(limitResetAt('5-hour limit reached ∙ resets 1am', ts), at(2026, 9, 27, 1, 0), 'heure déjà passée aujourd\'hui : demain');
  assert.equal(limitResetAt('You\'ve hit your weekly limit · resets Oct 31, 8pm', ts), at(2026, 9, 31, 20, 0));
  assert.equal(limitResetAt('Claude usage limit reached. Your limit will reset at 3pm (Europe/Paris).', ts), at(2026, 9, 26, 15, 0));
  const epoch = Math.floor((T0 + 2 * 3600_000) / 1000);
  assert.equal(limitResetAt(`Claude AI usage limit reached|${epoch}`, ts), epoch * 1000);
  assert.equal(limitResetAt('You\'ve hit your session limit', ts), T0 + 5 * 3600_000);
  assert.equal(limitResetAt('Usage limit reached', ts), T0 + 7 * 24 * 3600_000);
  assert.equal(limitResetAt('resets 3am', 'pas une date'), null);
});

test('sorte de limite : les mots du texte, sinon l\'écart avec la remise à zéro', () => {
  assert.equal(limitScope('You\'ve hit your session limit · resets 3:40am', ts), 'session');
  assert.equal(limitScope('Opus weekly limit reached ∙ resets Oct 31 at 9am', ts), 'week');
  assert.equal(limitScope('Claude usage limit reached. Your limit will reset at 3am', ts), 'session', 'dans moins de 6 h');
  assert.equal(limitScope('Usage limit reached · resets Oct 31, 8pm', ts), 'week', 'dans plusieurs jours');
});

test('texte en français : titre avec le compte, « Remise à zéro à 03:40 » ou la date pour la semaine', () => {
  const s = limitView('You\'ve hit your session limit · resets 3:40am', ts, 'Travail 1');
  assert.deepEqual(s, { scope: 'session', resetsAt: new Date(at(2026, 9, 26, 3, 40)).toISOString(),
    title: 'Limite de session atteinte · Travail 1', detail: 'Remise à zéro à 03:40' });
  const w = limitView('You\'ve hit your weekly limit · resets Oct 31, 8pm', ts, 'Perso');
  assert.equal(w.title, 'Limite de la semaine atteinte · Perso');
  assert.equal(w.detail, 'Remise à zéro sam. 31 oct. à 20:00');
  assert.equal(limitView('Opus weekly limit reached ∙ resets Oct 31 at 9am', ts).title, 'Limite Opus de la semaine atteinte', 'sans compte : le titre seul');
  for (const v of [s, w]) assert.ok(!/reset|limit\b|hit/i.test(`${v.title} ${v.detail}`), 'aucun mot anglais');
  assert.equal(hourText(at(2026, 0, 5, 9, 5)), '09:05');
  assert.equal(dayText(at(2026, 1, 1, 9, 5)), 'dim. 1 févr.');
  assert.equal(resetText(T0 + 3600_000, T0), `Remise à zéro à ${hourText(T0 + 3600_000)}`);
  assert.equal(resetText(NaN, T0), null);
});
