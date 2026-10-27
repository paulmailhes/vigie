// Modèle de projet Ourama — 4 : page Début de mission, vide, calquée sur le questionnaire Ourama (et son résumé
// « brief créatif ») : présentation, le cabinet, la marque recherchée, identité actuelle, site actuel, références,
// site souhaité, livrables et planning, points à trancher, premier rendez-vous. 10-remplir.js la remplit (et retire
// les slides sans contenu). Remplace __PARAMS__ comme pour 03-couverture.js.
const P = __PARAMS__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '🔍 Début de mission');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page Début de mission est déjà construite : passe à la suite.');
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
const setText = (node, name, chars) => { const t = node.findOne((x) => x.type === 'TEXT' && x.name === name); t.characters = chars; return t; };
function slide(name) { const f = figma.createFrame(); f.name = name; f.resize(1920, 1080); f.fills = [paint('fond')]; f.clipsContent = true; return f; }
function header(parent, etiq, titre, intro) {
  const h = C['En-tête de slide'].createInstance(); parent.appendChild(h);
  if (parent.layoutMode === 'NONE') { h.x = 120; h.y = 120; }
  setText(h, 'Étiquette', etiq); setText(h, 'Titre', titre); setText(h, 'Intro', intro);
  return h;
}
function note(label, body, width) {
  const n = C['Bloc de note'].createInstance();
  if (width) n.resize(width, n.height);
  setText(n, 'Libellé', label); setText(n, 'Texte', body); n.name = label;
  return n;
}
// Six blocs sur deux lignes, qui passent à la ligne d'eux-mêmes
function grid(s, labels) {
  const g = figma.createAutoLayout('HORIZONTAL', { name: 'Grille', itemSpacing: 60 }); g.fills = []; s.appendChild(g);
  g.layoutWrap = 'WRAP'; g.counterAxisSpacing = 64;
  g.resize(1680, g.height); g.primaryAxisSizingMode = 'FIXED'; g.counterAxisSizingMode = 'AUTO';
  for (const l of labels) g.appendChild(note(l, 'À remplir.', 520));
  g.x = 120; g.y = 460;
  return g;
}
// Colonnes de notes côte à côte
function columns(s, labels, width) {
  const r = figma.createAutoLayout('HORIZONTAL', { name: 'Colonnes', itemSpacing: 60 }); r.fills = []; s.appendChild(r);
  for (const l of labels) r.appendChild(note(l, 'À remplir.', width));
  r.x = 120; r.y = 460;
  return r;
}
// Une image (capture, logo, charte) à gauche, des notes à droite
async function imageAndNotes(s, imageName, labels) {
  const cap = figma.createFrame(); cap.name = imageName; cap.resize(1040, 650); cap.cornerRadius = 16; cap.fills = [paint('ligne')];
  s.appendChild(cap); cap.x = 120; cap.y = 380;
  const col = figma.createAutoLayout('VERTICAL', { name: 'Notes', itemSpacing: 48 }); col.fills = []; s.appendChild(col);
  for (const l of labels) col.appendChild(note(l, 'À remplir.', 560));
  col.x = 1240; col.y = 380;
}

const wrap = figma.createAutoLayout('HORIZONTAL', { name: 'Début de mission', itemSpacing: 160 }); wrap.fills = []; wrap.x = 0; wrap.y = 0;
let n = 0;
const num = () => String(++n).padStart(2, '0');

// Présentation : la slide d'ouverture du rendez-vous
const s1 = slide('01 · Présentation'); wrap.appendChild(s1);
const sh = C['Formes Ourama'].createInstance(); s1.appendChild(sh); sh.resize(820, 820); sh.x = 1100; sh.y = 130;
const lg = C['Logo Ourama'].createInstance(); s1.appendChild(lg); lg.resize(340, 340 * lg.height / lg.width); lg.x = 120; lg.y = 110;
const b1 = figma.createAutoLayout('VERTICAL', { name: 'Titre', itemSpacing: 24 }); b1.fills = []; s1.appendChild(b1);
b1.appendChild(await text('Étiquette', 'Premier rendez-vous', 'Étiquette', 'acide'));
const t1 = await text('Titre', 'Présentation client', 'Titre XXL', 'texte', 940); t1.fontSize = 160; b1.appendChild(t1);
b1.appendChild(await text('Client', `${P.client} · date du rendez-vous`, 'Intertitre', 'texte-doux'));
b1.x = 120; b1.y = 1080 - 120 - b1.height;

const add = (name) => { const s = slide(`${String(wrap.children.length + 1).padStart(2, '0')} · ${name}`); wrap.appendChild(s); return s; };

let s = add('Le cabinet');
header(s, `${num()} — Le cabinet`, 'Qui ils sont', 'Ce qu\'on a compris du questionnaire, à valider ensemble au rendez-vous.');
grid(s, ['Identité', 'Offre', 'Différence', 'Valeurs', 'Clients', 'Objectifs']);

s = add('La marque recherchée');
header(s, `${num()} — La marque`, 'La marque recherchée', 'Sa personnalité, ce que les visiteurs doivent ressentir, et la direction visuelle souhaitée.');
grid(s, ['Personnalité', 'Ressenti', 'Univers', 'Couleurs', 'Typographie et logo', 'À éviter']);

s = add('Identité actuelle');
header(s, `${num()} — Identité actuelle`, 'Ce qui existe déjà', 'Le logo, les couleurs et la charte d\'aujourd\'hui : ce qu\'on garde, ce qu\'on fait évoluer.');
await imageAndNotes(s, 'Visuel de l\'identité actuelle', ['Ce qu\'ils en pensent', 'Ce qu\'on garde', 'Ce qu\'on fait évoluer']);

s = add('Site actuel');
header(s, `${num()} — Site actuel`, 'Ce qu\'on a aujourd\'hui', 'Le site actuel : ce qu\'on garde, ce qu\'on change.');
await imageAndNotes(s, 'Capture du site actuel', ['Ce qu\'on garde', 'Ce qu\'on change', 'À vérifier']);

// Références : la slide s'élargit avec les cartes
const s4 = figma.createAutoLayout('VERTICAL', { name: `${String(wrap.children.length + 1).padStart(2, '0')} · Références`, itemSpacing: 80 });
s4.paddingTop = s4.paddingBottom = s4.paddingLeft = s4.paddingRight = 120; s4.fills = [paint('fond')]; s4.minWidth = 1920; s4.minHeight = 1080;
wrap.appendChild(s4);
header(s4, `${num()} — Références`, 'Ce qui les inspire', 'Les sites cités par le client : ce qu\'ils aiment, ce qu\'ils n\'aiment pas, ce qu\'on en retient. Une carte par site.');
const row = figma.createAutoLayout('HORIZONTAL', { name: 'Cartes', itemSpacing: 48 }); row.fills = []; s4.appendChild(row);
for (let i = 0; i < 2; i++) row.appendChild(C['Carte de référence'].createInstance());

s = add('Site souhaité');
header(s, `${num()} — Site souhaité`, 'Le site qu\'ils imaginent', 'Les pages, les fonctions, et ce que le visiteur doit faire en priorité.');
columns(s, ['Pages', 'Sections et fonctions', 'Objectif et conversion'], 520);

s = add('Livrables et planning');
header(s, `${num()} — Livrables et planning`, 'Ce qu\'on livre, et quand', 'Les supports demandés, l\'échéance et les contraintes à respecter.');
columns(s, ['Supports', 'Planning', 'Contraintes'], 520);

s = add('À trancher');
header(s, `${num()} — À trancher`, 'À trancher ensemble', 'Les points où les réponses des associés diffèrent, ou que personne n\'a tranchés.');
grid(s, ['Sujet', 'Sujet', 'Sujet']);

s = add('Premier rendez-vous');
header(s, `${num()} — Premier rendez-vous`, 'Ce qu\'on va se dire', 'L\'ordre du jour et les questions à poser, tirées de ce que le questionnaire laisse ouvert.');
const r5 = columns(s, ['Ordre du jour', 'Questions à poser'], 800);
setText(r5.children[0], 'Texte', '1. Présentations\n2. Le projet vu par le client\n3. Les références\n4. Points à trancher\n5. Questions\n6. Prochaines étapes');

return { createdNodeIds: [wrap.id, ...wrap.children.map((x) => x.id)], slides: wrap.children.map((x) => x.name) };
