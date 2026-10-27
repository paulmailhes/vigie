// Modèle de projet Ourama — 5 : les pistes graphiques (page Pistes), une slide par piste : l'idée, les mots-clés,
// la palette, les polices et une planche d'ambiance. Remplace __DONNEES__ par null (trois pistes à remplir) ou :
// { "pistes": [ { "nom": "Classique et lumineux", "idee": "Une phrase : ce que la piste raconte.",
//     "motsCles": ["Sobre", "Lumineux", "Précis"],
//     "couleurs": [ { "nom": "Bleu nuit", "hex": "#152029" } ],            ← 5 au plus
//     "titres": "Cormorant Garamond", "texte": "Inter",                   ← polices Google si possible
//     "phrase": "Une phrase du client, pour voir les polices en situation" } ] }   ← 3 pistes au plus
// Rend les cadres de la planche d'ambiance (dans l'ordre) où poser des images avec upload_assets (scaleMode « FILL »).
const D = __DONNEES__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '🎨 Pistes');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page Pistes est déjà construite : passe à la suite.');
const paint = (c) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V['couleur/' + c]);
const rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };
async function text(name, chars, style, c, width) {
  const t = figma.createText(); t.name = name;
  await t.setTextStyleIdAsync(S['Ourama/' + style]); t.characters = chars; t.fills = [paint(c)];
  if (width) { t.resize(width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
}
const setText = (node, name, chars) => { node.findOne((x) => x.type === 'TEXT' && x.name === name).characters = chars; };
// Une police de Google Fonts si Figma la connaît (style Regular), sinon Hanken Grotesk
async function font(family) {
  if (!family) return null;
  try { await figma.loadFontAsync({ family, style: 'Regular' }); return { family, style: 'Regular' }; } catch { return null; }
}
const warnings = [];
const pistes = (D && Array.isArray(D.pistes) && D.pistes.length ? D.pistes : [{}, {}, {}]).slice(0, 3);
const wrap = figma.createAutoLayout('HORIZONTAL', { name: 'Pistes', itemSpacing: 160 }); wrap.fills = []; wrap.x = 0; wrap.y = 0;
const images = [];
for (const [i, p] of pistes.entries()) {
  const letter = 'ABC'[i];
  const s = figma.createFrame(); s.name = `Piste ${letter}`; s.resize(1920, 1080); s.fills = [paint('fond')]; s.clipsContent = true;
  wrap.appendChild(s);
  const h = C['En-tête de slide'].createInstance(); s.appendChild(h); h.x = 120; h.y = 110;
  setText(h, 'Étiquette', `Piste ${letter}`);
  setText(h, 'Titre', p.nom || 'Nom de la piste');
  setText(h, 'Intro', p.idee || 'Une phrase : ce que cette piste raconte du client, et pourquoi elle lui ressemble.');
  // mots-clés
  const tags = figma.createAutoLayout('HORIZONTAL', { name: 'Mots-clés', itemSpacing: 12 }); tags.fills = []; s.appendChild(tags);
  for (const w of (Array.isArray(p.motsCles) && p.motsCles.length ? p.motsCles : ['Mot-clé', 'Mot-clé', 'Mot-clé']).slice(0, 4)) {
    const t = figma.createAutoLayout('HORIZONTAL', { name: 'Mot-clé' }); t.paddingTop = t.paddingBottom = 10; t.paddingLeft = t.paddingRight = 18;
    t.cornerRadius = 100; t.fills = []; t.strokes = [paint('acide')]; t.strokeWeight = 1.5;
    t.appendChild(await text('Mot', String(w), 'Étiquette', 'acide'));
    tags.appendChild(t);
  }
  const top = h.y + h.height + 28; // sous l'en-tête, quelle que soit la longueur de l'idée
  tags.x = 120; tags.y = top;
  // palette
  const pal = figma.createAutoLayout('HORIZONTAL', { name: 'Palette', itemSpacing: 24 }); pal.fills = []; s.appendChild(pal);
  const colors = Array.isArray(p.couleurs) && p.couleurs.length ? p.couleurs.slice(0, 5) : [null, null, null, null, null];
  for (const c of colors) {
    const col = figma.createAutoLayout('VERTICAL', { name: c?.nom || 'Couleur', itemSpacing: 10 }); col.fills = []; pal.appendChild(col);
    const sw = figma.createRectangle(); sw.name = 'Pastille'; sw.resize(150, 150); sw.cornerRadius = 16;
    const v = c && rgb(c.hex);
    if (c && !v) warnings.push(`Couleur illisible : ${c.hex} (attendu #RRVVBB).`);
    sw.fills = v ? [{ type: 'SOLID', color: v }] : [paint('ligne')];
    if (v) { sw.strokes = [paint('ligne')]; sw.strokeWeight = 1; }
    col.appendChild(sw);
    col.appendChild(await text('Nom', c?.nom || 'Couleur', 'Petit', 'texte'));
    col.appendChild(await text('Valeur', c?.hex ? String(c.hex).toUpperCase() : 'HEX', 'Petit', 'texte-doux'));
  }
  pal.x = 120; pal.y = top + 84;
  // polices
  const typo = figma.createAutoLayout('VERTICAL', { name: 'Polices', itemSpacing: 12 }); typo.fills = []; s.appendChild(typo);
  const ft = await font(p.titres), fx = await font(p.texte);
  if (p.titres && !ft) warnings.push(`Police « ${p.titres} » absente de Figma : l'exemple est en Hanken Grotesk.`);
  const aa = await text('Exemple', 'Aa Bb', 'Titre', 'texte'); if (ft) aa.fontName = ft; typo.appendChild(aa);
  const names = await text('Noms', `Titres — ${p.titres || 'à choisir'} · Texte — ${p.texte || 'à choisir'}`, 'Petit', 'texte-doux'); typo.appendChild(names);
  const sample = await text('Phrase', String(p.phrase || (D && D.phrase) || 'Le cabinet accompagne ses clients à chaque étape de leurs projets.'), 'Texte', 'texte', 820);
  if (fx) sample.fontName = fx;
  typo.appendChild(sample);
  typo.x = 120; typo.y = pal.y + pal.height + 48;
  // planche d'ambiance
  const board = figma.createAutoLayout('HORIZONTAL', { name: 'Ambiance', itemSpacing: 20 }); board.fills = []; s.appendChild(board);
  board.layoutWrap = 'WRAP'; board.counterAxisSpacing = 20;
  board.resize(760, board.height); board.primaryAxisSizingMode = 'FIXED';
  for (let k = 0; k < 4; k++) {
    const im = figma.createFrame(); im.name = 'Image'; im.resize(370, 270); im.cornerRadius = 12; im.fills = [paint('ligne')];
    board.appendChild(im); images.push({ piste: letter, nodeId: im.id });
  }
  board.x = 1040; board.y = top + 84;
}
return { createdNodeIds: [wrap.id, ...wrap.children.map((x) => x.id)], images, warnings };
