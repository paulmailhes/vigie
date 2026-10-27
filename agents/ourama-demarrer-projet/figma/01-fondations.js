// Modèle de projet Ourama — 1 : pages, couleurs et espacements (variables), styles de texte.
// À lancer en premier, dans le fichier Figma neuf. Rend les identifiants des pages (Composants : pour envoyer le logo).
// Police : Hanken Grotesk (la plus proche de Switzer accessible ici ; « Remplacer les polices » dans Figma
// repasse tout en Switzer d'un coup).
if ((await figma.variables.getLocalVariableCollectionsAsync()).some((c) => c.name === 'Ourama')) {
  throw new Error('Les fondations existent déjà dans ce fichier : passe à l\'étape suivante.');
}
const names = {
  couverture: '🌅 Couverture', debut: '🔍 Début de mission', pistes: '🎨 Pistes', wireframe: '🔗 Wireframe',
  ux: '🧐 UX', brandbook: '📕 Brandbook', toolbox: '🧰 Toolbox', composants: '⚙️ Composants',
};
const pages = {};
const keys = Object.keys(names);
const first = figma.root.children[0];
first.name = names[keys[0]];
pages[keys[0]] = first.id;
for (const k of keys.slice(1)) { const p = figma.createPage(); p.name = names[k]; pages[k] = p.id; }
const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
// Fond de toile sombre : la marque est sombre, les composants restent lisibles (la couverture prend sa couleur en 03)
for (const p of figma.root.children) p.backgrounds = [{ type: 'SOLID', color: hex('#1E1E1E') }];

const col = figma.variables.createVariableCollection('Ourama');
col.renameMode(col.modes[0].modeId, 'Sombre');
const mode = col.modes[0].modeId;
for (const [name, h, scopes] of [
  ['couleur/fond', '#080808', ['FRAME_FILL', 'SHAPE_FILL']],
  ['couleur/surface', '#131313', ['FRAME_FILL', 'SHAPE_FILL']],
  ['couleur/ligne', '#2A2A2A', ['FRAME_FILL', 'SHAPE_FILL', 'STROKE_COLOR']],
  ['couleur/texte', '#DFDFDF', ['TEXT_FILL', 'SHAPE_FILL']],
  ['couleur/texte-doux', '#8C8C8C', ['TEXT_FILL']],
  ['couleur/acide', '#D4F700', ['TEXT_FILL', 'SHAPE_FILL', 'FRAME_FILL', 'STROKE_COLOR']],
  ['couleur/papier', '#F2F2F0', ['FRAME_FILL', 'SHAPE_FILL']],
  // maquettes basse fidélité (UX) : gris neutres, comme les wireframes du studio
  ['maquette/fond', '#EEEEEE', ['FRAME_FILL', 'SHAPE_FILL']],
  ['maquette/bloc', '#FFFFFF', ['FRAME_FILL', 'SHAPE_FILL']],
  ['maquette/trait', '#CFCFCF', ['FRAME_FILL', 'SHAPE_FILL', 'STROKE_COLOR']],
  ['maquette/image', '#2B2B2B', ['FRAME_FILL', 'SHAPE_FILL']],
  ['maquette/texte', '#111111', ['TEXT_FILL', 'SHAPE_FILL', 'FRAME_FILL', 'STROKE_COLOR']],
  ['maquette/doux', '#6B6B6B', ['TEXT_FILL', 'SHAPE_FILL']],
]) {
  const v = figma.variables.createVariable(name, col, 'COLOR');
  v.setValueForMode(mode, hex(h));
  v.scopes = scopes;
}
for (const [name, value] of [['espace/s', 16], ['espace/m', 32], ['espace/l', 64], ['espace/xl', 120]]) {
  const v = figma.variables.createVariable(name, col, 'FLOAT');
  v.setValueForMode(mode, value);
  v.scopes = ['GAP', 'WIDTH_HEIGHT'];
}

const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
for (const [name, style, size, lh, ls, tc] of [
  ['Ourama/Titre XXL', 'Medium', 200, 95, -3, 'ORIGINAL'],
  ['Ourama/Titre', 'Medium', 96, 100, -2, 'ORIGINAL'],
  ['Ourama/Sous-titre', 'Medium', 48, 110, -1, 'ORIGINAL'],
  ['Ourama/Intertitre', 'Medium', 32, 120, -1, 'ORIGINAL'],
  ['Ourama/Texte', 'Regular', 24, 140, 0, 'ORIGINAL'],
  ['Ourama/Petit', 'Regular', 18, 140, 0, 'ORIGINAL'],
  ['Ourama/Étiquette', 'Medium', 16, 120, 8, 'UPPER'],
  ['Maquette/Titre', 'Medium', 48, 110, -1, 'ORIGINAL'],
  ['Maquette/Intertitre', 'Medium', 28, 120, -1, 'ORIGINAL'],
  ['Maquette/Texte', 'Regular', 16, 150, 0, 'ORIGINAL'],
  ['Maquette/Petit', 'Regular', 13, 140, 0, 'ORIGINAL'],
  ['Maquette/Bouton', 'Medium', 14, 120, 0, 'ORIGINAL'],
]) {
  const s = figma.createTextStyle();
  s.name = name;
  s.fontName = { family: F, style };
  s.fontSize = size;
  s.lineHeight = { unit: 'PERCENT', value: lh };
  s.letterSpacing = { unit: 'PERCENT', value: ls };
  s.textCase = tc;
}
return { pages, composants: pages.composants };
