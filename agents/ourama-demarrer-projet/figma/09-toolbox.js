// Modèle de projet Ourama — 9 : la Toolbox, page Toolbox : la boîte à outils de la marque du client (ses composants
// d'interface, logo, symbole, couleurs, typographies, éléments graphiques, ce qu'on retient pour la home), en sections
// à remplir au fil du projet, comme sur les projets du studio.
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '🧰 Toolbox');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page Toolbox est déjà construite : passe à la suite.');
const paint = (c) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V['couleur/' + c]);

const SECTIONS = [
  ['00 · Composants', 'Boutons, liens, cartes, navigation, formulaires : les pièces du site, dans la marque'],
  ['01 · Logo', 'Le logo et ses versions (couleur, blanc, réduit), sa zone de protection'],
  ['02 · Symbole', 'Le monogramme ou le symbole, ses déclinaisons'],
  ['03 · Couleurs', 'La palette avec ses valeurs, et ses associations autorisées'],
  ['04 · Typographies', 'Les polices, la hiérarchie des titres et du texte'],
  ['05 · Éléments graphiques', 'Formes, motifs, traitements d\'image propres à la marque'],
  ['06 · À retenir pour la home', 'Les choix validés à appliquer en premier sur la page d\'accueil'],
];
const W = 1640, H = 1000, GAP = 160;
const ids = [];
SECTIONS.forEach(([name, consigne], i) => {
  const s = figma.createSection(); s.name = name;
  s.resizeWithoutConstraints(W, H);
  s.x = (i % 2) * (W + GAP); s.y = Math.floor(i / 2) * (H + GAP);
  s.fills = [paint('fond')];
  const z = C['Zone à remplir'].createInstance(); s.appendChild(z);
  z.resize(W - 240, H - 300); z.x = 120; z.y = 200;
  z.findOne((n) => n.type === 'TEXT' && n.name === 'Consigne').characters = consigne;
  ids.push(s.id);
});
// un titre par section (au-dessus de la zone)
for (const [i, id] of ids.entries()) {
  const s = await figma.getNodeByIdAsync(id);
  const t = figma.createText(); await t.setTextStyleIdAsync(S['Ourama/Sous-titre']);
  t.characters = SECTIONS[i][0].replace(/^\d+ · /, ''); t.fills = [paint('texte')];
  s.appendChild(t); t.x = 120; t.y = 96;
}
return { createdNodeIds: ids };
