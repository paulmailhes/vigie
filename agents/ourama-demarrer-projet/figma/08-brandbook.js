// Modèle de projet Ourama — 8 : page Brandbook (couverture, logo, couleurs, typographies, images, applications).
// Remplace __PARAMS__ comme pour 03-couverture.js (seuls « client » et « annee » servent ici).
const P = __PARAMS__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '📕 Brandbook');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page Brandbook est déjà construite : passe à la suite.');
const paint = (c) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V['couleur/' + c]);
async function text(name, chars, style, c, width) {
  const t = figma.createText();
  t.name = name;
  await t.setTextStyleIdAsync(S['Ourama/' + style]);
  t.characters = chars;
  t.fills = [paint(c)];
  if (width) { t.resize(width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
}
const setText = (node, name, chars) => { const t = node.findOne((x) => x.type === 'TEXT' && x.name === name); t.characters = chars; };
function slide(name) { const f = figma.createFrame(); f.name = name; f.resize(1920, 1080); f.fills = [paint('fond')]; f.clipsContent = true; return f; }
function header(s, e, t, i) { const h = C['En-tête de slide'].createInstance(); s.appendChild(h); h.x = 120; h.y = 120; setText(h, 'Étiquette', e); setText(h, 'Titre', t); setText(h, 'Intro', i); }
function zone(s, consigne) { const z = C['Zone à remplir'].createInstance(); s.appendChild(z); z.x = 120; z.y = 420; setText(z, 'Consigne', consigne); }

const wrap = figma.createAutoLayout('HORIZONTAL', { name: 'Brandbook', itemSpacing: 160 }); wrap.fills = []; wrap.x = 0; wrap.y = 0;
const s0 = slide('00 · Couverture'); wrap.appendChild(s0);
const sh = C['Formes Ourama'].createInstance(); s0.appendChild(sh); sh.resize(820, 820); sh.x = 1100; sh.y = 130;
const b = figma.createAutoLayout('VERTICAL', { name: 'Titre', itemSpacing: 24 }); b.fills = []; s0.appendChild(b);
b.appendChild(await text('Étiquette', 'Identité de marque', 'Étiquette', 'acide'));
const bt = await text('Titre', 'Brandbook', 'Titre XXL', 'texte', 940); bt.fontSize = 160; b.appendChild(bt); // 200 px : le mot ne tient pas sur la ligne
b.appendChild(await text('Client', P.client, 'Intertitre', 'texte-doux'));
b.x = 120; b.y = 1080 - 120 - b.height;
const s1 = slide('01 · Logo'); wrap.appendChild(s1);
header(s1, '01 — Logo', 'Le logo', 'Versions, zone de protection, tailles minimales et usages à éviter.');
zone(s1, 'Logo et ses versions');
const s2 = slide('02 · Couleurs'); wrap.appendChild(s2);
header(s2, '02 — Couleurs', 'Les couleurs', 'Couleurs principales et secondaires, avec leurs valeurs (HEX, RVB, CMJN).');
const row = figma.createAutoLayout('HORIZONTAL', { name: 'Nuancier', itemSpacing: 40 }); row.fills = []; s2.appendChild(row);
for (let i = 1; i <= 5; i++) {
  const col = figma.createAutoLayout('VERTICAL', { name: `Couleur ${i}`, itemSpacing: 16 }); col.fills = []; row.appendChild(col);
  const sw = figma.createRectangle(); sw.name = 'Pastille'; sw.resize(296, 296); sw.cornerRadius = 24; sw.fills = [paint('ligne')]; col.appendChild(sw);
  col.appendChild(await text('Nom', `Couleur ${i}`, 'Intertitre', 'texte'));
  col.appendChild(await text('Valeurs', 'HEX · RVB · CMJN', 'Petit', 'texte-doux'));
}
row.x = 120; row.y = 460;
const s3 = slide('03 · Typographies'); wrap.appendChild(s3);
header(s3, '03 — Typographies', 'Les typographies', 'Police des titres, police du texte, et leur hiérarchie.');
const aa = await text('Exemple', 'Aa', 'Titre XXL', 'texte'); aa.fontSize = 420; s3.appendChild(aa); aa.x = 120; aa.y = 420;
const typo = figma.createAutoLayout('VERTICAL', { name: 'Polices', itemSpacing: 24 }); typo.fills = []; s3.appendChild(typo);
typo.appendChild(await text('Titres', 'Titres — police à choisir', 'Intertitre', 'texte'));
typo.appendChild(await text('Texte', 'Texte — police à choisir', 'Intertitre', 'texte-doux'));
typo.x = 900; typo.y = 560;
const s4 = slide('04 · Images et icônes'); wrap.appendChild(s4);
header(s4, '04 — Images et icônes', 'Images et icônes', 'Le style des photos, des illustrations et des icônes.');
zone(s4, 'Planche d\'images et d\'icônes');
const s5 = slide('05 · Applications'); wrap.appendChild(s5);
header(s5, '05 — Applications', 'La marque en situation', 'Cartes de visite, signature de mail, réseaux sociaux, papeterie : à ajouter au fil du projet.');
zone(s5, 'Applications à créer au fur et à mesure');
return { createdNodeIds: [wrap.id, s0.id, s1.id, s2.id, s3.id, s4.id, s5.id] };
