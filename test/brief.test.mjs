import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefOf, askOf, toYouOf, promptBrief, plainLine } from '../lib/brief.mjs';

test('« En bref : » l\'emporte, sans ses marques', () => {
  const t = '## Résumé\n\nJ\'ai beaucoup travaillé.\n\n**En bref :** les 29 étapes sont faites ; la publication attend ta relecture.\n\nDétails…';
  assert.equal(briefOf(t), 'les 29 étapes sont faites ; la publication attend ta relecture.');
});

test('sinon la première phrase utile, sans titre générique ni code', () => {
  const t = '## Compte rendu\n\n```bash\nnpm test\n```\n\nLes tests passent tous (245). Ensuite j\'ai refait le header.\n- point';
  assert.equal(briefOf(t), 'Les tests passent tous (245).');
  assert.equal(briefOf('Fait.'), 'Fait.');
  assert.equal(briefOf(''), null);
});

test('une phrase trop longue est coupée sur un mot', () => {
  const long = 'J\'ai repris toute la page d\'accueil ' + 'avec les nouvelles couleurs de la charte '.repeat(8);
  const b = briefOf(long, 80);
  assert.ok(b.length <= 80 && b.endsWith('…'), b);
  assert.ok(!/\s…$/.test(b));
});

test('la question qui termine le compte rendu, même après la coupe à 600 caractères', () => {
  const t = 'x'.repeat(900) + '\n\nLa charte est posée sur les 6 écrans. Quel fond pour l\'accueil : A (sombre) ou B (clair) ?';
  assert.equal(askOf(t), 'Quel fond pour l\'accueil : A (sombre) ou B (clair) ?');
  assert.equal(askOf('Tout est fait.\n\nLes tests passent.'), null);
  assert.equal(askOf('Je m\'en occupe ?\n\n- A\n- B'), 'Je m\'en occupe ?', 'une question suivie de ses choix');
  assert.equal(askOf('Pourquoi ? Parce que.\n\nUn\nDeux\nTrois\nQuatre'), null, 'pas une question en fin de texte');
});

test('« À toi : » et la demande sans remplissage', () => {
  assert.equal(toYouOf('Fini.\n\n**À toi :** relire la planche avant publication.'), 'relire la planche avant publication.');
  assert.equal(toYouOf('Rien pour toi.'), null);
  assert.equal(promptBrief('Ok, donc là on est sur une version à peu près propre, il faut maintenant…'), 'On est sur une version à peu près propre, il faut maintenant…');
  assert.equal(promptBrief('ok'), 'Ok');
  assert.equal(plainLine('- [x] **Fait** : voir [la doc](https://x.y) et `npm test`'), 'Fait : voir la doc et npm test');
});
