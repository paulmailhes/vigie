// Modèle de projet Ourama — 6 : le wireframe (plan du site), page Wireframe : une carte par page avec ses sections,
// reliées en arbre depuis l'accueil, plus le gabarit de page et les pages légales. Structure par défaut : un site de
// cabinet (avocats, notaires, experts) avec actualités et ressources. Remplace __DONNEES__ par null (structure par
// défaut) ou par l'arborescence du projet :
// { "pages": { "nom": "Accueil", "sections": ["Barre de navigation", "En-tête — Accroche et appel à prendre contact", …],
//              "enfants": [ { "nom": "Le cabinet", "sections": […], "enfants": [] } ] } }
// Une section : « Titre — ce qu'elle contient » (ou { "titre", "texte" }). 8 pages par niveau au plus.
const D = __DONNEES__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '🔗 Wireframe');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page Wireframe est déjà construite : passe à la suite.');
const paint = (c) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V[c]);

const NAV = 'Barre de navigation — Logo, menu, bouton de contact';
const FOOT = 'Pied de page — Navigation, coordonnées, mentions';
const CTA = 'Appel à l\'action — Prendre rendez-vous';
const DEFAULT = {
  nom: 'Accueil', accueil: true,
  sections: [NAV, 'En-tête — Accroche du cabinet et appel à prendre contact', 'Expertises — Les domaines d\'intervention, un accès par domaine',
    'Le cabinet — Présentation courte : histoire, approche, valeurs', 'Chiffres clés — Années, associés, dossiers, langues',
    'Équipe — Les associés, accès à leur fiche', 'Références — Logos clients, témoignages', 'Actualités — Les trois derniers articles', CTA, FOOT],
  enfants: [
    { nom: 'Le cabinet', sections: [NAV, 'En-tête — Le cabinet en une phrase', 'Histoire — Fondation, parcours des associés', 'Approche et valeurs', 'Chiffres clés', 'Équipe — Aperçu, lien vers la page Équipe', CTA, FOOT] },
    { nom: 'Expertises', sections: [NAV, 'En-tête — Les domaines en une phrase', 'Domaines — Une carte par domaine', CTA, FOOT],
      enfants: [{ nom: 'Page expertise', sections: [NAV, 'En-tête — Le domaine en une phrase', 'Accompagnement — Ce que fait le cabinet, pour qui', 'Exemples de dossiers', 'Avocats référents', 'Articles liés', CTA, FOOT] }] },
    { nom: 'Équipe', sections: [NAV, 'En-tête', 'Associés — Photo, nom, expertise', 'Collaborateurs', 'Recrutement — Rejoindre le cabinet', FOOT],
      enfants: [{ nom: 'Fiche avocat', sections: [NAV, 'En-tête — Photo, nom, titre, langues', 'Parcours', 'Expertises', 'Publications et interventions', 'Contact direct', FOOT] }] },
    { nom: 'Actualités', sections: [NAV, 'En-tête', 'Filtres — Catégories, expertises', 'Articles — Liste, par date', 'Newsletter — Inscription', FOOT],
      enfants: [{ nom: 'Article', sections: [NAV, 'En-tête — Titre, date, auteur', 'Corps — Texte, images, citations', 'Auteur — Fiche courte de l\'avocat', 'Articles liés', 'Newsletter', FOOT] }] },
    { nom: 'Ressources', sections: [NAV, 'En-tête', 'Guides et fiches pratiques — À télécharger', 'Modèles et documents', 'Questions fréquentes', 'Newsletter', FOOT] },
    { nom: 'Contact', sections: [NAV, 'En-tête', 'Coordonnées et accès — Adresse, plan, horaires', 'Formulaire — Demande de rendez-vous', FOOT] },
  ],
};
const tree = D && D.pages ? D.pages : DEFAULT;
const CARD = 328, GX = 64, GY = 140;

// Une carte : l'onglet (icône, nom de la page) puis la liste des sections
function card(p, root = false) {
  const c = figma.createAutoLayout('VERTICAL', { name: `Page · ${p.nom || 'Page'}`, itemSpacing: 8 }); c.fills = [];
  const tab = C['Plan · Onglet'].createInstance(); c.appendChild(tab);
  if (root || p.accueil) tab.findOne((n) => n.name === 'Icône').fills = [{ type: 'SOLID', color: { r: 0.067, g: 0.067, b: 0.067 } }]; // l'accueil : icône pleine
  tab.findOne((n) => n.name === 'Page').characters = String(p.nom || 'Page');
  const body = figma.createAutoLayout('VERTICAL', { name: 'Sections', itemSpacing: 10 });
  body.paddingTop = body.paddingBottom = body.paddingLeft = body.paddingRight = 14;
  body.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; body.cornerRadius = 10;
  c.appendChild(body); body.resize(CARD, body.height); body.counterAxisSizingMode = 'FIXED';
  for (const raw of (Array.isArray(p.sections) ? p.sections : []).slice(0, 14)) {
    const [titre, texte] = typeof raw === 'string' ? raw.split(/\s+—\s+/) : [raw?.titre, raw?.texte];
    const sec = C['Plan · Section'].createInstance(); body.appendChild(sec); sec.layoutSizingHorizontal = 'FILL';
    sec.findOne((n) => n.name === 'Titre').characters = String(titre || 'Section');
    const t = sec.findOne((n) => n.name === 'Texte');
    if (texte) t.characters = String(texte); else t.visible = false;
  }
  return c;
}

const board = figma.createFrame(); board.name = 'Plan du site'; board.fills = [paint('couleur/fond')];
board.cornerRadius = 24; board.strokes = [paint('couleur/ligne')]; board.strokeWeight = 2; board.clipsContent = false;
board.x = 0; board.y = 0;
// Gabarit et pages légales, en haut à gauche
const side = figma.createAutoLayout('VERTICAL', { name: 'Gabarits', itemSpacing: 48 }); side.fills = []; board.appendChild(side);
side.appendChild(card({ nom: 'Gabarit de page', sections: [NAV, 'Section — Titre, texte, image', 'Section', 'Section', FOOT] }));
side.appendChild(card({ nom: 'Pages légales', sections: ['Mentions légales', 'Politique de confidentialité', 'Cookies', 'Document d\'entrée en relation — Si la profession l\'exige'] }));
side.x = 120; side.y = 120;

// Arbre : chaque carte au-dessus de ses enfants, niveaux alignés, liens en équerre
const nodes = [];
function build(p, depth) {
  const n = { p, depth, card: card(p, depth === 0), kids: [] };
  board.appendChild(n.card);
  nodes.push(n);
  n.kids = (Array.isArray(p.enfants) ? p.enfants : []).slice(0, 8).map((k) => build(k, depth + 1));
  return n;
}
const root = build(tree, 0);
function width(n) {
  if (n.w === undefined) n.w = Math.max(CARD, n.kids.reduce((s, k) => s + width(k), 0) + GX * Math.max(0, n.kids.length - 1));
  return n.w;
}
const rows = [];
for (const n of nodes) rows[n.depth] = Math.max(rows[n.depth] || 0, n.card.height);
const rowY = []; let yy = 120;
for (let d = 0; d < rows.length; d++) { rowY[d] = yy; yy += rows[d] + GY; }
const left0 = 120 + CARD + 160;
function place(n, left) {
  n.card.x = left + (width(n) - CARD) / 2; n.card.y = rowY[n.depth];
  let l = left;
  for (const k of n.kids) { place(k, l); l += width(k) + GX; }
}
place(root, left0);
const line = (x, y, w, h) => { const r = figma.createRectangle(); r.name = 'Lien'; r.resize(Math.max(w, 2), Math.max(h, 2)); r.fills = [paint('couleur/texte-doux')]; board.appendChild(r); r.x = x; r.y = y; };
for (const n of nodes) {
  if (!n.kids.length) continue;
  const cx = n.card.x + CARD / 2, bottom = n.card.y + n.card.height, mid = rowY[n.depth + 1] - GY / 2;
  line(cx - 1, bottom, 2, mid - bottom);
  const xs = n.kids.map((k) => k.card.x + CARD / 2);
  line(Math.min(...xs, cx), mid, Math.max(...xs, cx) - Math.min(...xs, cx), 2);
  for (const k of n.kids) line(k.card.x + CARD / 2 - 1, mid, 2, k.card.y - mid);
}
board.resize(left0 + width(root) + 120, Math.max(yy - GY + 120, side.y + side.height + 120));
return { createdNodeIds: [board.id], pages: nodes.length, size: [Math.round(board.width), Math.round(board.height)] };
