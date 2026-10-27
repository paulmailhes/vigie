// Modèle de projet Ourama — 2b : le kit des maquettes basse fidélité (page UX) et du plan du site (page Wireframe),
// en composants sur la page Composants, sous ceux de 02. Gris neutres, comme les wireframes du studio.
const page = figma.root.children.find((p) => p.name === '⚙️ Composants');
await figma.setCurrentPageAsync(page);
if (page.children.some((n) => n.type === 'COMPONENT' && n.name.startsWith('Maquette · '))) throw new Error('Le kit des maquettes existe déjà : passe à la suite.');
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const paint = (n) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V[n]);
const solid = (h) => ({ type: 'SOLID', color: { r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 } });
async function txt(name, chars, style, color, { width = null, size = null, medium = false, align = null } = {}) {
  const t = figma.createText(); t.name = name;
  await t.setTextStyleIdAsync(S[style]);
  if (size) t.fontSize = size;
  if (medium) t.fontName = { family: F, style: 'Medium' };
  t.characters = chars;
  t.fills = [color.startsWith('#') ? solid(color) : paint(color)];
  if (align) t.textAlignHorizontal = align;
  if (width) { t.resize(width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
}
function comp(name, dir, { gap = 0, pad = [0, 0, 0, 0], fill = null, radius = 0, width = null, align = null, justify = null } = {}) {
  const c = figma.createComponent(); c.name = name;
  c.layoutMode = dir; c.itemSpacing = gap;
  [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft] = pad;
  c.fills = fill ? [fill.startsWith('#') ? solid(fill) : paint(fill)] : [];
  c.cornerRadius = radius;
  c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO';
  if (width) { c.resize(width, c.height); if (dir === 'VERTICAL') c.counterAxisSizingMode = 'FIXED'; else c.primaryAxisSizingMode = 'FIXED'; }
  if (align) c.counterAxisAlignItems = align;
  if (justify) c.primaryAxisAlignItems = justify;
  return c;
}
function frame(name, dir, { gap = 0, pad = [0, 0, 0, 0], fill = null, radius = 0, align = null } = {}) {
  const f = figma.createAutoLayout(dir, { name, itemSpacing: gap });
  [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = pad;
  f.fills = fill ? [fill.startsWith('#') ? solid(fill) : paint(fill)] : [];
  f.cornerRadius = radius;
  if (align) f.counterAxisAlignItems = align;
  return f;
}
const LOREM = 'Un texte court à remplacer par le vrai contenu, sur deux ou trois lignes, pour donner le rythme de la page.';
let x = 0, y = 3200;
const place = (c, w) => { c.x = x; c.y = y; x += (w || c.width) + 80; if (x > 4400) { x = 0; y += 900; } return c; };
const made = [];

// Image : fond sombre, un soleil et deux collines
const img = figma.createComponent(); img.name = 'Maquette · Image';
img.resize(400, 260); img.fills = [paint('maquette/image')]; img.cornerRadius = 8; img.clipsContent = true;
for (const [n, w, h, ex, ey, c] of [['Soleil', 44, 44, 300, 44, '#5A5A5A'], ['Colline 1', 520, 260, -90, 160, '#454545'], ['Colline 2', 520, 260, 110, 186, '#383838']]) {
  const e = figma.createEllipse(); e.name = n; e.resize(w, h); e.x = ex; e.y = ey; e.fills = [solid(c)]; img.appendChild(e);
  // le soleil garde sa forme, dans son coin ; les collines suivent l'image
  e.constraints = n === 'Soleil' ? { horizontal: 'MAX', vertical: 'MIN' } : { horizontal: 'SCALE', vertical: 'SCALE' };
}
img.description = 'Emplacement d\'image (photo, illustration) dans une maquette.';
made.push(place(img));

const btn = comp('Maquette · Bouton', 'HORIZONTAL', { pad: [12, 22, 12, 22], fill: 'maquette/texte', radius: 6, align: 'CENTER' });
btn.appendChild(await txt('Libellé', 'En savoir plus', 'Maquette/Bouton', 'maquette/bloc'));
made.push(place(btn));
const button = (label) => { const b = btn.createInstance(); b.findOne((n) => n.name === 'Libellé').characters = label; return b; };
const image = (w, h) => { const i = img.createInstance(); i.resize(w, h); return i; };

// Navigation
const nav = comp('Maquette · Navigation', 'HORIZONTAL', { pad: [22, 120, 22, 120], fill: 'maquette/bloc', width: 1440, align: 'CENTER', justify: 'SPACE_BETWEEN' });
const logo = frame('Logo', 'HORIZONTAL', { pad: [8, 18, 8, 18], fill: 'maquette/trait', radius: 4, align: 'CENTER' });
logo.appendChild(await txt('Nom', 'Logo', 'Maquette/Bouton', 'maquette/texte'));
nav.appendChild(logo);
const links = frame('Liens', 'HORIZONTAL', { gap: 32 });
for (const [i, l] of ['Le cabinet', 'Expertises', 'Équipe', 'Actualités', 'Ressources'].entries()) links.appendChild(await txt(`Lien ${i + 1}`, l, 'Maquette/Bouton', 'maquette/texte'));
nav.appendChild(links);
nav.appendChild(button('Contact'));
made.push(place(nav));

// En-tête de page (hero) : titre, texte, bouton, image
const hero = comp('Maquette · En-tête', 'HORIZONTAL', { gap: 80, pad: [88, 120, 88, 120], fill: 'maquette/fond', width: 1440, align: 'CENTER' });
const hl = frame('Texte', 'VERTICAL', { gap: 24 });
hero.appendChild(hl);
hl.appendChild(await txt('Titre', 'Titre accrocheur de la page, sur deux lignes', 'Maquette/Titre', 'maquette/texte', { width: 560 }));
hl.appendChild(await txt('Texte', LOREM, 'Maquette/Texte', 'maquette/doux', { width: 520 }));
hl.appendChild(button('Prendre contact'));
hero.appendChild(image(600, 400));
made.push(place(hero));

// Titre de section, centré
const title = comp('Maquette · Titre de section', 'VERTICAL', { gap: 12, pad: [72, 120, 24, 120], fill: 'maquette/fond', width: 1440, align: 'CENTER' });
title.appendChild(await txt('Titre', 'Titre de la section', 'Maquette/Intertitre', 'maquette/texte', { align: 'CENTER' }));
title.appendChild(await txt('Texte', 'Une phrase pour introduire la section.', 'Maquette/Texte', 'maquette/doux', { width: 720, align: 'CENTER' }));
made.push(place(title));

// Cartes : expertise (ou valeur, ressource), membre de l'équipe, article
async function card(name, h, extra) {
  const c = comp(name, 'VERTICAL', { gap: 12, pad: [16, 16, 20, 16], fill: 'maquette/bloc', radius: 8, width: 360 });
  const i = image(328, h); c.appendChild(i); i.layoutSizingHorizontal = 'FILL';
  for (const t of await extra()) { c.appendChild(t); if (t.type === 'TEXT') { t.layoutSizingHorizontal = 'FILL'; } }
  return c;
}
const carte = await card('Maquette · Carte', 190, async () => [
  await txt('Titre', 'Nom du domaine', 'Maquette/Texte', 'maquette/texte', { width: 328, size: 18, medium: true }),
  await txt('Texte', LOREM, 'Maquette/Petit', 'maquette/doux', { width: 328 }),
  await txt('Lien', 'En savoir plus →', 'Maquette/Bouton', 'maquette/texte')]);
made.push(place(carte));
const membre = await card('Maquette · Membre', 300, async () => [
  await txt('Nom', 'Prénom Nom', 'Maquette/Texte', 'maquette/texte', { width: 328, size: 18, medium: true }),
  await txt('Rôle', 'Associé · domaine', 'Maquette/Petit', 'maquette/doux', { width: 328 }),
  button('Voir le profil')]);
made.push(place(membre));
const article = await card('Maquette · Article', 190, async () => [
  await txt('Date', '12 novembre 2026 · Catégorie', 'Maquette/Petit', 'maquette/doux', { width: 328 }),
  await txt('Titre', 'Titre de l\'article, sur une ou deux lignes', 'Maquette/Texte', 'maquette/texte', { width: 328, size: 18, medium: true }),
  await txt('Texte', LOREM, 'Maquette/Petit', 'maquette/doux', { width: 328 })]);
made.push(place(article));

// Texte long (page de contenu, article, FAQ)
const texte = comp('Maquette · Texte', 'VERTICAL', { gap: 16, pad: [48, 360, 48, 360], fill: 'maquette/fond', width: 1440 });
texte.appendChild(await txt('Titre', 'Intertitre du contenu', 'Maquette/Intertitre', 'maquette/texte', { width: 720 }));
for (const n of [1, 2]) texte.appendChild(await txt(`Paragraphe ${n}`, `${LOREM} ${LOREM}`, 'Maquette/Texte', 'maquette/doux', { width: 720 }));
made.push(place(texte));

// Chiffres clés
const chiffres = comp('Maquette · Chiffres', 'HORIZONTAL', { gap: 40, pad: [48, 120, 48, 120], fill: 'maquette/fond', width: 1440, justify: 'SPACE_BETWEEN' });
for (const [i, [n, l]] of [['15', 'ans d\'expérience'], ['3', 'associés'], ['200', 'dossiers par an'], ['2', 'langues']].entries()) {
  const g = frame(`Chiffre ${i + 1}`, 'VERTICAL', { gap: 4 });
  g.appendChild(await txt('Nombre', n, 'Maquette/Titre', 'maquette/texte'));
  g.appendChild(await txt('Libellé', l, 'Maquette/Texte', 'maquette/doux'));
  chiffres.appendChild(g);
}
made.push(place(chiffres));

// Bandeau de logos (références clients, partenaires)
const logos = comp('Maquette · Logos', 'HORIZONTAL', { gap: 24, pad: [32, 120, 48, 120], fill: 'maquette/fond', width: 1440, justify: 'CENTER', align: 'CENTER' });
for (let i = 1; i <= 6; i++) {
  const l = frame(`Logo ${i}`, 'HORIZONTAL', { pad: [20, 44, 20, 44], fill: 'maquette/trait', radius: 6 });
  l.appendChild(await txt('Nom', 'Logo', 'Maquette/Bouton', 'maquette/doux'));
  logos.appendChild(l);
}
made.push(place(logos));

// Appel à l'action
const cta = comp('Maquette · Appel à l\'action', 'VERTICAL', { gap: 18, pad: [72, 120, 72, 120], fill: 'maquette/bloc', width: 1440, align: 'CENTER' });
cta.appendChild(await txt('Titre', 'Contactez-nous', 'Maquette/Intertitre', 'maquette/texte', { align: 'CENTER' }));
cta.appendChild(await txt('Texte', 'Une phrase qui invite à prendre contact ou rendez-vous.', 'Maquette/Texte', 'maquette/doux', { width: 640, align: 'CENTER' }));
cta.appendChild(button('Prendre rendez-vous'));
made.push(place(cta));

// Formulaire de contact et coordonnées
const form = comp('Maquette · Formulaire', 'HORIZONTAL', { gap: 80, pad: [64, 120, 64, 120], fill: 'maquette/fond', width: 1440 });
const fl = frame('Champs', 'VERTICAL', { gap: 14 });
form.appendChild(fl);
for (const [n, h] of [['Nom', 48], ['E-mail', 48], ['Téléphone', 48], ['Message', 140]]) {
  const f = frame(n, 'HORIZONTAL', { pad: [14, 16, 14, 16], fill: 'maquette/bloc', radius: 6 });
  f.strokes = [paint('maquette/trait')]; f.strokeWeight = 1;
  f.appendChild(await txt('Indication', n, 'Maquette/Texte', 'maquette/doux'));
  fl.appendChild(f); f.resize(640, h); f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'FIXED';
}
fl.appendChild(button('Envoyer'));
const fr = frame('Coordonnées', 'VERTICAL', { gap: 12 });
form.appendChild(fr);
fr.appendChild(await txt('Titre', 'Nous trouver', 'Maquette/Intertitre', 'maquette/texte'));
for (const l of ['Adresse du cabinet', 'Téléphone', 'E-mail']) fr.appendChild(await txt(l, l, 'Maquette/Texte', 'maquette/doux'));
fr.appendChild(image(480, 300));
made.push(place(form));

// Pied de page
const foot = comp('Maquette · Pied de page', 'HORIZONTAL', { gap: 80, pad: [48, 120, 56, 120], fill: 'maquette/bloc', width: 1440 });
const fLogo = logo.clone(); foot.appendChild(fLogo);
for (const [i, col] of [['Le cabinet', 'Équipe', 'Contact'], ['Expertises', 'Domaine 1', 'Domaine 2'], ['Actualités', 'Ressources', 'Newsletter'], ['Mentions légales', 'Confidentialité', 'LinkedIn']].entries()) {
  const c = frame(`Colonne ${i + 1}`, 'VERTICAL', { gap: 10 });
  for (const l of col) c.appendChild(await txt(l, l, 'Maquette/Petit', 'maquette/doux'));
  foot.appendChild(c);
}
made.push(place(foot));

// Plan du site : une section de page (titre et une ligne), et l'onglet d'une page
const sec = comp('Plan · Section', 'VERTICAL', { gap: 4, pad: [10, 14, 12, 14], fill: '#FFFFFF', radius: 6, width: 300 });
sec.strokes = [solid('#111111')]; sec.strokeWeight = 1;
const st = await txt('Titre', 'Section', 'Maquette/Texte', '#111111', { width: 272, size: 15, medium: true }); sec.appendChild(st); st.layoutSizingHorizontal = 'FILL';
const sd = await txt('Texte', 'Ce qu\'elle contient, en une ligne.', 'Maquette/Petit', '#555555', { width: 272, size: 12 }); sec.appendChild(sd); sd.layoutSizingHorizontal = 'FILL';
made.push(place(sec));
const tab = comp('Plan · Onglet', 'HORIZONTAL', { gap: 10, pad: [12, 16, 12, 16], fill: '#E3E3E3', radius: 10, width: 328, align: 'CENTER' });
// icône de page : un petit rectangle (plein pour l'accueil, réglé par 06)
const ic = figma.createRectangle(); ic.name = 'Icône'; ic.resize(13, 17); ic.cornerRadius = 2; ic.fills = [];
ic.strokes = [solid('#111111')]; ic.strokeWeight = 1.5;
tab.appendChild(ic);
const tp = await txt('Page', 'Nom de la page', 'Maquette/Texte', '#111111', { size: 18, medium: true }); tab.appendChild(tp);
made.push(place(tab));

for (const c of made) c.description = c.description || 'Kit des maquettes du modèle Ourama.';
return { createdNodeIds: made.map((c) => c.id), names: made.map((c) => c.name) };
