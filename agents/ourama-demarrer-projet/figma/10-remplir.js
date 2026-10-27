// Modèle de projet Ourama — 10 : remplit la page Début de mission avec ce qu'on sait du client, retire les slides sans
// contenu (identité actuelle, site actuel, points à trancher) et renumérote. Remplace __DONNEES__ par un objet JSON
// de cette forme (blocs de grille : 220 caractères au plus ; colonnes : 600 au plus, une idée par ligne) :
// {
//   "sousTitre": "Cabinet Martin · 12 novembre 2026",
//   "cabinet": { "Identité": "…", "Offre": "…", "Différence": "…", "Valeurs": "…", "Clients": "…", "Objectifs": "…" },
//   "marque": { "Personnalité": "…", "Ressenti": "…", "Univers": "…", "Couleurs": "…", "Typographie et logo": "…", "À éviter": "…" },
//   "identite": { "visuel": "sources/logo.png", "Ce qu'ils en pensent": "…", "Ce qu'on garde": "…", "Ce qu'on fait évoluer": "…" },  ← ou null
//   "site": { "adresse": "https://…", "capture": "assets/site-actuel/accueil-haut.png", "garde": "…", "change": "…", "verifier": "…" },  ← ou null
//   "references": [ { "nom": "…", "adresse": "https://…", "capture": "assets/references/….png", "aime": "…", "aimePas": "…", "retient": "…" } ],
//   "souhaite": { "Pages": "…", "Sections et fonctions": "…", "Objectif et conversion": "…" },
//   "projet": { "Supports": "…", "Planning": "…", "Contraintes": "…" },
//   "divergences": [ { "sujet": "Couleurs", "texte": "Amélie : … · Johannes : …" } ],  ← [] si les réponses concordent (6 au plus)
//   "rdv": { "ordre": "1. …\n2. …", "questions": "1. …\n2. …" }
// }
// Rend la liste des cadres où poser les images (dans l'ordre) pour upload_assets, et ce qui déborde.
const D = __DONNEES__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '🔍 Début de mission');
await figma.setCurrentPageAsync(page);
const wrap = page.children.find((n) => n.name === 'Début de mission');
if (!wrap) throw new Error('Page Début de mission vide : lance d\'abord 04-debut-de-mission.js.');
const say = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '—');
const setText = (node, name, chars) => { const t = node.findOne((x) => x.type === 'TEXT' && x.name === name); t.characters = say(chars); return t; };
const noteText = (node, label, chars) => setText(node.findOne((x) => x.type === 'INSTANCE' && x.name === label), 'Texte', chars);
const named = (base) => wrap.children.find((n) => n.name.replace(/^\d+ · /, '') === base);
const short = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
const captures = [];
const warnings = [];
const tooLow = (node, what) => { if (node.y + node.height > 1080 - 60) warnings.push(`${what} : trop long pour la slide, raccourcis.`); };
// Une slide de blocs ou de colonnes : chaque note reçoit le texte de même nom
function fill(base, values, holder) {
  const s = named(base);
  const box = s.findOne((n) => n.name === holder);
  for (const inst of box.children) noteText(box, inst.name, (values || {})[inst.name]);
  tooLow(box, base);
}

if (D.sousTitre) setText(named('Présentation'), 'Client', D.sousTitre);
fill('Le cabinet', D.cabinet, 'Grille');
fill('La marque recherchée', D.marque, 'Grille');

// Identité actuelle : seulement si un logo, une charte ou un brandbook a été fourni
const sId = named('Identité actuelle');
if (D.identite) {
  const col = sId.findOne((n) => n.name === 'Notes');
  for (const l of ['Ce qu\'ils en pensent', 'Ce qu\'on garde', 'Ce qu\'on fait évoluer']) noteText(col, l, D.identite[l]);
  tooLow(col, 'Identité actuelle');
  if (D.identite.visuel) captures.push({ nodeId: sId.findOne((n) => n.name === 'Visuel de l\'identité actuelle').id, fichier: D.identite.visuel });
} else sId.remove();

// Site actuel : retiré s'il n'y en a pas
const s3 = named('Site actuel');
if (D.site && D.site.adresse) {
  s3.findOne((n) => n.type === 'INSTANCE' && n.name === 'En-tête de slide').findOne((n) => n.name === 'Intro').characters = `${short(D.site.adresse)} — ce qu'on garde, ce qu'on change.`;
  const col = s3.findOne((n) => n.name === 'Notes');
  noteText(col, 'Ce qu\'on garde', D.site.garde);
  noteText(col, 'Ce qu\'on change', D.site.change);
  noteText(col, 'À vérifier', D.site.verifier);
  tooLow(col, 'Site actuel');
  if (D.site.capture) captures.push({ nodeId: s3.findOne((n) => n.name === 'Capture du site actuel').id, fichier: D.site.capture });
} else s3.remove();

// Références : une carte par site (détachée, pour pouvoir y poser la capture)
const row = named('Références').findOne((n) => n.name === 'Cartes');
const refs = Array.isArray(D.references) ? D.references : [];
if (refs.length) {
  for (const c of [...row.children]) c.remove();
  for (const r of refs) {
    const inst = C['Carte de référence'].createInstance();
    row.appendChild(inst);
    setText(inst, 'Nom', r.nom);
    setText(inst, 'Lien', short(r.adresse));
    noteText(inst, 'Ce qu\'ils aiment', r.aime);
    noteText(inst, 'Ce qu\'ils n\'aiment pas', r.aimePas);
    noteText(inst, 'Ce qu\'on en retient', r.retient);
    const card = inst.detachInstance();
    card.name = say(r.nom);
    if (r.capture) captures.push({ nodeId: card.findOne((n) => n.name === 'Capture').id, fichier: r.capture });
  }
}

fill('Site souhaité', D.souhaite, 'Colonnes');
fill('Livrables et planning', D.projet, 'Colonnes');

// Points à trancher : un bloc par sujet ; la slide part si les réponses concordent
const sT = named('À trancher');
const div = (Array.isArray(D.divergences) ? D.divergences : []).slice(0, 6);
if (div.length) {
  const g = sT.findOne((n) => n.name === 'Grille');
  for (const c of [...g.children]) c.remove();
  for (const d of div) {
    const inst = C['Bloc de note'].createInstance();
    inst.resize(520, inst.height);
    g.appendChild(inst);
    setText(inst, 'Libellé', d.sujet);
    setText(inst, 'Texte', d.texte);
    inst.name = say(d.sujet);
  }
  tooLow(g, 'À trancher');
} else sT.remove();

const cols = named('Premier rendez-vous').findOne((n) => n.name === 'Colonnes');
if (D.rdv && D.rdv.ordre) noteText(cols, 'Ordre du jour', D.rdv.ordre);
noteText(cols, 'Questions à poser', D.rdv && D.rdv.questions);
tooLow(cols, 'Premier rendez-vous');

// Numéros des slides et des étiquettes, une fois les slides vides retirées
wrap.children.forEach((s, i) => {
  s.name = `${String(i + 1).padStart(2, '0')} · ${s.name.replace(/^\d+ · /, '')}`;
  const head = i > 0 && s.findOne((n) => n.type === 'INSTANCE' && n.name === 'En-tête de slide');
  if (head) { const e = head.findOne((n) => n.name === 'Étiquette'); e.characters = e.characters.replace(/^\d+/, String(i).padStart(2, '0')); }
});

return { mutatedNodeIds: wrap.children.map((s) => s.id), captures, warnings, slides: wrap.children.map((s) => s.name) };
