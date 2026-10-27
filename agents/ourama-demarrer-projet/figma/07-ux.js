// Modèle de projet Ourama — 7 : l'UX, page UX : les maquettes basse fidélité (gris) des pages clés d'un site de
// cabinet, montées avec le kit (02b) : l'accueil en haut, puis le cabinet, une page expertise, les actualités, un
// article, les ressources, le contact. Remplace __DONNEES__ par null (textes types) ou par ce qu'on sait déjà :
// { "accroche": "L'expertise d'un grand cabinet, l'agilité d'une petite structure",
//   "liens": ["Le cabinet", "Expertises", "Équipe", "Actualités", "Ressources"],
//   "expertises": ["Sociétés et M&A", "Contentieux des affaires", "Droit bancaire"],
//   "equipe": [ { "nom": "Prénom Nom", "role": "Associée · Contentieux" } ],
//   "chiffres": [ ["2020", "création du cabinet"], ["3", "associés"] ] }
const D = __DONNEES__ || {};
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
if (!C['Maquette · Navigation']) throw new Error('Kit des maquettes absent : lance d\'abord 02b-kit-maquettes.js.');
const page = figma.root.children.find((p) => p.name === '🧐 UX');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page UX est déjà construite : passe à la suite.');
const paint = (c) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V[c]);
const set = (node, name, chars) => { const t = node.findOne((n) => n.type === 'TEXT' && n.name === name); if (t && chars) t.characters = String(chars); return t; };
const list = (a) => (Array.isArray(a) ? a.filter(Boolean) : []);
const expertises = list(D.expertises).length ? list(D.expertises) : ['Domaine d\'expertise 1', 'Domaine d\'expertise 2', 'Domaine d\'expertise 3', 'Domaine d\'expertise 4', 'Domaine d\'expertise 5', 'Domaine d\'expertise 6'];
const equipe = list(D.equipe).length ? list(D.equipe) : [{ nom: 'Prénom Nom', role: 'Associé · domaine' }, { nom: 'Prénom Nom', role: 'Associée · domaine' }, { nom: 'Prénom Nom', role: 'Collaborateur · domaine' }];
const liens = list(D.liens).slice(0, 5);
const chiffres = list(D.chiffres).slice(0, 4);

// Les blocs : une instance du kit, ses textes remplacés
const I = (name) => C[`Maquette · ${name}`].createInstance();
const blocks = {
  nav: () => { const n = I('Navigation'); liens.forEach((l, i) => set(n, `Lien ${i + 1}`, l)); return n; },
  hero: (titre, texte) => { const h = I('En-tête'); set(h, 'Titre', titre); set(h, 'Texte', texte); return h; },
  titre: (titre, texte) => { const t = I('Titre de section'); set(t, 'Titre', titre); set(t, 'Texte', texte); return t; },
  texte: (titre) => { const t = I('Texte'); set(t, 'Titre', titre); return t; },
  chiffres: () => { const c = I('Chiffres'); chiffres.forEach(([n, l], i) => { const g = c.findOne((x) => x.name === `Chiffre ${i + 1}`); if (g) { set(g, 'Nombre', n); set(g, 'Libellé', l); } }); return c; },
  logos: () => I('Logos'),
  cta: (titre, texte, bouton) => { const c = I('Appel à l\'action'); set(c, 'Titre', titre); set(c, 'Texte', texte); if (bouton) set(c, 'Libellé', bouton); return c; },
  form: () => I('Formulaire'),
  foot: () => I('Pied de page'),
  // grille de cartes : 3 par ligne
  grille: (kind, items) => {
    const g = figma.createAutoLayout('HORIZONTAL', { name: `Grille · ${kind}`, itemSpacing: 32 });
    g.layoutWrap = 'WRAP'; g.counterAxisSpacing = 32; g.fills = [paint('maquette/fond')];
    g.paddingTop = 16; g.paddingBottom = 64; g.paddingLeft = g.paddingRight = 120;
    g.resize(1440, g.height); g.primaryAxisSizingMode = 'FIXED'; g.counterAxisSizingMode = 'AUTO';
    for (const it of items) {
      const c = I(kind);
      if (kind === 'Carte') set(c, 'Titre', it);
      if (kind === 'Membre') { set(c, 'Nom', it.nom); set(c, 'Rôle', it.role); }
      if (kind === 'Article' && it) set(c, 'Titre', it);
      g.appendChild(c);
    }
    return g;
  },
};
const nav = () => blocks.nav();
const PAGES = [
  ['Accueil', () => [nav(), blocks.hero(D.accroche || 'Accroche du cabinet, sur deux lignes', null),
    blocks.titre('Nos domaines d\'expertise', 'Un accès direct à chaque domaine.'), blocks.grille('Carte', expertises.slice(0, 6)),
    blocks.titre('Le cabinet', null), blocks.texte('Qui sommes-nous ?'), blocks.chiffres(),
    blocks.titre('L\'équipe', null), blocks.grille('Membre', equipe.slice(0, 3)), blocks.logos(),
    blocks.titre('Nos derniers articles', null), blocks.grille('Article', [null, null, null]), blocks.cta(), blocks.foot()]],
  ['Le cabinet', () => [nav(), blocks.hero('Le cabinet en une phrase', null), blocks.texte('Notre histoire'), blocks.chiffres(),
    blocks.titre('Notre approche', null), blocks.grille('Carte', ['Valeur 1', 'Valeur 2', 'Valeur 3']),
    blocks.titre('L\'équipe', null), blocks.grille('Membre', equipe.slice(0, 3)), blocks.cta(), blocks.foot()]],
  ['Page expertise', () => [nav(), blocks.hero(expertises[0], null), blocks.texte('Notre accompagnement'),
    blocks.titre('Exemples de dossiers', null), blocks.grille('Carte', ['Dossier type 1', 'Dossier type 2', 'Dossier type 3']),
    blocks.titre('Avocats référents', null), blocks.grille('Membre', equipe.slice(0, 2)),
    blocks.titre('Articles liés', null), blocks.grille('Article', [null, null, null]), blocks.cta(), blocks.foot()]],
  ['Actualités', () => [nav(), blocks.hero('Actualités', 'Les analyses et les nouvelles du cabinet.'),
    blocks.grille('Article', [null, null, null, null, null, null]), blocks.cta('Recevoir la newsletter', 'Les nouveaux articles, une fois par mois.', 'S\'inscrire'), blocks.foot()]],
  ['Article', () => [nav(), blocks.hero('Titre de l\'article, sur deux lignes', '12 novembre 2026 · Auteur · Catégorie'), blocks.texte('Intertitre'), blocks.texte('Intertitre'),
    blocks.titre('À lire aussi', null), blocks.grille('Article', [null, null, null]), blocks.cta(), blocks.foot()]],
  ['Ressources', () => [nav(), blocks.hero('Ressources', 'Guides, fiches pratiques et modèles à télécharger.'),
    blocks.titre('Guides et fiches pratiques', null), blocks.grille('Carte', ['Guide 1', 'Guide 2', 'Guide 3']),
    blocks.texte('Questions fréquentes'), blocks.cta('Recevoir la newsletter', null, 'S\'inscrire'), blocks.foot()]],
  ['Contact', () => [nav(), blocks.hero('Contact', 'Une question, un dossier : écrivez-nous ou prenez rendez-vous.'), blocks.form(), blocks.foot()]],
];

// Chaque page : son nom au-dessus, puis la maquette (1440 de large)
const mockups = [];
for (const [name, make] of PAGES) {
  const g = figma.createAutoLayout('VERTICAL', { name: `UX · ${name}`, itemSpacing: 24 }); g.fills = [];
  const label = figma.createText(); await label.setTextStyleIdAsync(S['Ourama/Sous-titre']); label.characters = name; label.fills = [paint('couleur/texte')];
  g.appendChild(label);
  const m = figma.createAutoLayout('VERTICAL', { name: 'Maquette', itemSpacing: 0 }); m.fills = [paint('maquette/fond')];
  m.cornerRadius = 12; m.clipsContent = true;
  g.appendChild(m);
  for (const b of make()) { m.appendChild(b); b.layoutSizingHorizontal = 'FIXED'; }
  mockups.push(g);
}
// L'accueil en haut, les autres pages en ligne dessous, reliées
const GX = 160, GY = 240;
const [home, ...rest] = mockups;
const rowW = rest.length * 1440 + (rest.length - 1) * GX;
home.x = (rowW - 1440) / 2; home.y = 0;
const top = home.height + GY;
rest.forEach((g, i) => { g.x = i * (1440 + GX); g.y = top; });
const line = (x, y, w, h) => { const r = figma.createRectangle(); r.name = 'Lien'; r.resize(Math.max(w, 2), Math.max(h, 2)); r.fills = [paint('couleur/texte-doux')]; r.x = x; r.y = y; return r; };
const mid = top - GY / 2;
const links = [line(home.x + 720 - 1, home.height, 2, mid - home.height), line(720, mid, rowW - 1440, 2), ...rest.map((g) => line(g.x + 720 - 1, mid, 2, top - mid))];
return { createdNodeIds: [...mockups.map((g) => g.id), ...links.map((l) => l.id)], pages: mockups.map((g) => g.name) };
