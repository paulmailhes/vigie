// Modèle de projet Ourama — 2 : composants, sur la page Composants.
// Avant : 01-fondations.js, puis logo-ourama.svg envoyé sur la page Composants (upload_assets, image/svg+xml).
// Ce script en fait le composant « Logo Ourama », puis crée les formes, l'en-tête de slide, le bloc de note,
// la carte de référence et la zone à remplir.
const page = figma.root.children.find((p) => p.name === '⚙️ Composants');
await figma.setCurrentPageAsync(page);
if (page.children.some((n) => n.type === 'COMPONENT')) throw new Error('Les composants existent déjà : passe à 03-couverture.js.');
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
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

// Logo Ourama : le SVG envoyé juste avant (seul cadre de la page qui n'est pas un composant)
const svg = page.children.filter((n) => n.type === 'FRAME' || n.type === 'GROUP');
if (svg.length !== 1) throw new Error(`Logo introuvable : ${svg.length} cadre(s) sur la page Composants au lieu d'un. Envoie logo-ourama.svg avec upload_assets (currentPageId = page Composants) puis relance.`);
const logo = figma.createComponent();
logo.name = 'Logo Ourama';
logo.resize(svg[0].width, svg[0].height);
logo.fills = [];
for (const c of [...svg[0].children]) { const x = c.x, y = c.y; logo.appendChild(c); c.x = x; c.y = y; c.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; }
svg[0].remove();
logo.description = 'Logo Ourama (symbole et mot). À redimensionner en gardant les proportions.';
logo.x = 0; logo.y = 0;

// Formes Ourama : disque gris aux trois quarts et quart de disque acide ; elles se redimensionnent d'un bloc
const R = 540;
const shapes = figma.createComponent();
shapes.name = 'Formes Ourama';
shapes.resize(2 * R, 2 * R);
shapes.fills = [];
shapes.clipsContent = true;
const grey = figma.createEllipse();
grey.name = 'Disque';
grey.resize(2 * R, 2 * R);
grey.arcData = { startingAngle: -Math.PI / 2, endingAngle: Math.PI, innerRadius: 0 };
grey.fills = [{ type: 'GRADIENT_ANGULAR', gradientTransform: [[0, -1, 1], [1, 0, 0]], gradientStops: [
  { position: 0, color: { r: 0.96, g: 0.96, b: 0.96, a: 1 } }, { position: 0.45, color: { r: 0.62, g: 0.62, b: 0.62, a: 1 } },
  { position: 0.75, color: { r: 0.3, g: 0.3, b: 0.3, a: 1 } }, { position: 1, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }] }];
shapes.appendChild(grey);
const lime = figma.createEllipse();
lime.name = 'Quart acide';
lime.resize(2 * R, 2 * R);
shapes.appendChild(lime);
lime.x = -R; lime.y = -R;
lime.arcData = { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0 };
lime.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[0.5, -0.5, 0.5], [0.5, 0.5, 0]], gradientStops: [
  { position: 0, color: { r: 0.62, g: 0.74, b: 0, a: 1 } }, { position: 1, color: { r: 0.88, g: 1, b: 0.12, a: 1 } }] }];
for (const n of shapes.children) n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
shapes.description = 'Formes de la marque Ourama, en bord de slide. Elles se redimensionnent d\'un bloc.';
shapes.x = 1300; shapes.y = 0;

// En-tête de slide
const head = figma.createComponent();
head.name = 'En-tête de slide';
head.layoutMode = 'VERTICAL'; head.itemSpacing = 24; head.fills = [];
head.primaryAxisSizingMode = 'AUTO'; head.counterAxisSizingMode = 'AUTO';
head.appendChild(await text('Étiquette', '01 — Brief', 'Étiquette', 'acide'));
head.appendChild(await text('Titre', 'Titre de la slide', 'Titre', 'texte'));
head.appendChild(await text('Intro', 'Une phrase pour dire à quoi sert cette slide et ce qu\'on en attend au rendez-vous.', 'Texte', 'texte-doux', 1200));
head.description = 'Étiquette numérotée, titre et phrase d\'introduction d\'une slide.';
head.x = 0; head.y = 1300;

// Bloc de note
const note = figma.createComponent();
note.name = 'Bloc de note';
note.layoutMode = 'VERTICAL'; note.itemSpacing = 12; note.fills = [];
note.primaryAxisSizingMode = 'AUTO'; note.counterAxisSizingMode = 'FIXED';
note.resize(520, 100);
const nl = await text('Libellé', 'Libellé', 'Étiquette', 'acide'); note.appendChild(nl); nl.layoutSizingHorizontal = 'FILL';
const nt = await text('Texte', 'À remplir.', 'Texte', 'texte', 520); note.appendChild(nt); nt.layoutSizingHorizontal = 'FILL';
note.description = 'Un libellé et son texte. La largeur se règle sur l\'instance, la hauteur suit le texte.';
note.x = 0; note.y = 1700;

// Carte de référence : une par site cité par le client
const card = figma.createComponent();
card.name = 'Carte de référence';
card.layoutMode = 'VERTICAL'; card.itemSpacing = 24;
card.paddingTop = card.paddingBottom = card.paddingLeft = card.paddingRight = 32;
card.primaryAxisSizingMode = 'AUTO'; card.counterAxisSizingMode = 'FIXED';
card.resize(760, 100);
card.cornerRadius = 24;
card.fills = [paint('surface')];
const shot = figma.createFrame();
shot.name = 'Capture';
shot.resize(696, 435); shot.cornerRadius = 12; shot.fills = [paint('ligne')];
card.appendChild(shot); shot.layoutSizingHorizontal = 'FILL';
const cn = await text('Nom', 'Nom du site', 'Intertitre', 'texte', 696); card.appendChild(cn); cn.layoutSizingHorizontal = 'FILL';
const cl = await text('Lien', 'www.exemple.fr', 'Petit', 'texte-doux', 696); card.appendChild(cl); cl.layoutSizingHorizontal = 'FILL';
for (const label of ['Ce qu\'ils aiment', 'Ce qu\'ils n\'aiment pas', 'Ce qu\'on en retient']) {
  const inst = note.createInstance();
  card.appendChild(inst);
  inst.layoutSizingHorizontal = 'FILL';
  inst.findOne((n) => n.type === 'TEXT' && n.name === 'Libellé').characters = label;
  inst.name = label;
}
card.description = 'Un site de référence : capture du haut de page (cadre « Capture », 16:10), nom, adresse, et ce qu\'en dit le client.';
card.x = 700; card.y = 1700;

// Zone à remplir : contenu à venir
const zone = figma.createComponent();
zone.name = 'Zone à remplir';
zone.layoutMode = 'VERTICAL'; zone.primaryAxisAlignItems = 'CENTER'; zone.counterAxisAlignItems = 'CENTER';
zone.primaryAxisSizingMode = 'FIXED'; zone.counterAxisSizingMode = 'FIXED';
zone.resize(1680, 560);
zone.cornerRadius = 24; zone.fills = [];
zone.strokes = [paint('ligne')]; zone.strokeWeight = 2; zone.dashPattern = [16, 12];
zone.appendChild(await text('Consigne', 'À construire pendant le projet', 'Texte', 'texte-doux'));
zone.description = 'Emplacement d\'un contenu à venir. Remplace la consigne, ou supprime la zone quand le contenu est là.';
zone.x = 1600; zone.y = 1300;

return { createdNodeIds: [logo.id, shapes.id, head.id, note.id, card.id, zone.id], logo: { w: logo.width, h: logo.height, children: logo.children.length } };
