// Modèle de projet Ourama — 11 : l'identité ACTUELLE du client dans la page Brandbook (logos, couleurs, polices),
// quand le client en a une (dossier brand/, charte, logos joints). Après 08-brandbook.js. Remplace __DONNEES__ par :
// {
//   "logos": [ { "nom": "Logo principal", "fichier": "brand/LOGOS/PNG/Noir.png", "fond": "clair" } ],   ← 3 au plus ;
//                                                   fond « clair » pour un logo foncé, « sombre » pour un logo blanc
//   "couleurs": [ { "nom": "Bleu nuit", "hex": "#1D2B44" } ],                                    ← 5 au plus
//   "typos": { "titres": "Jost", "texte": "DM Sans" }                                                   ← ou null
// }
// Logos en SVG (le mieux : vectoriels) : AVANT ce script, envoie-les sur la page Brandbook (upload_assets sans nodeIds,
// currentPageId = page Brandbook, envoi en multipart pour garder le nom du fichier) ; le script les range dans leur
// planche. Logos en PNG ou JPG : le script rend les cadres où les poser ensuite (upload_assets, scaleMode « FIT »).
const D = __DONNEES__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map((v) => [v.name, v]));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const page = figma.root.children.find((p) => p.name === '📕 Brandbook');
await figma.setCurrentPageAsync(page);
const wrap = page.children.find((n) => n.name === 'Brandbook');
if (!wrap) throw new Error('Page Brandbook vide : lance d\'abord 08-brandbook.js.');
const paint = (c) => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', V['couleur/' + c]);
const named = (base) => wrap.children.find((n) => n.name.replace(/^\d+ · /, '') === base);
async function text(name, chars, style, c) {
  const t = figma.createText(); t.name = name;
  await t.setTextStyleIdAsync(S['Ourama/' + style]); t.characters = chars; t.fills = [paint(c)];
  return t;
}
const hexRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};
const captures = [];
const mutated = [];
const warnings = [];

// Logos : jusqu'à trois planches, sur fond clair ou sombre selon le logo
const logos = (Array.isArray(D.logos) ? D.logos : []).slice(0, 3);
if (logos.length) {
  const s = named('Logo');
  const zone = s.findOne((n) => n.type === 'INSTANCE' && n.name === 'Zone à remplir');
  if (zone) zone.remove();
  const row = figma.createAutoLayout('HORIZONTAL', { name: 'Logos actuels', itemSpacing: 60 }); row.fills = []; s.appendChild(row);
  const w = Math.floor((1680 - 60 * (logos.length - 1)) / logos.length);
  for (const l of logos) {
    const col = figma.createAutoLayout('VERTICAL', { name: l.nom || 'Logo', itemSpacing: 16 }); col.fills = []; row.appendChild(col);
    const board = figma.createFrame(); board.name = 'Planche'; board.resize(w, 420); board.cornerRadius = 24;
    board.fills = [paint(l.fond === 'sombre' ? 'surface' : 'papier')];
    col.appendChild(board);
    const boxW = Math.round(w * 0.7), boxH = 220;
    const file = String(l.fichier || '');
    const base = file.split('/').pop();
    const svg = /\.svg$/i.test(file) && page.children.find((n) => n !== wrap && (n.name === base || n.name === base.replace(/\.svg$/i, '')));
    if (svg) {
      // le SVG importé : réduit pour tenir dans la planche, centré
      board.appendChild(svg);
      svg.rescale(Math.min(boxW / svg.width, boxH / svg.height));
      svg.x = Math.round((w - svg.width) / 2); svg.y = Math.round((420 - svg.height) / 2);
      svg.name = 'Logo';
    } else {
      if (/\.svg$/i.test(file)) warnings.push(`Logo « ${base} » introuvable sur la page : envoie le SVG sur la page Brandbook avant ce script.`);
      const img = figma.createFrame(); img.name = 'Logo'; img.resize(boxW, boxH); img.fills = [];
      board.appendChild(img); img.x = Math.round((w - boxW) / 2); img.y = 100;
      if (file && !/\.svg$/i.test(file)) captures.push({ nodeId: img.id, fichier: file });
    }
    col.appendChild(await text('Nom', l.nom || 'Logo', 'Texte', 'texte'));
  }
  row.x = 120; row.y = 420;
  mutated.push(s.id);
}

// Couleurs : les pastilles prennent les vraies couleurs, les pastilles en trop partent
const colors = (Array.isArray(D.couleurs) ? D.couleurs : []).slice(0, 5);
if (colors.length) {
  const s = named('Couleurs');
  const row = s.findOne((n) => n.name === 'Nuancier');
  [...row.children].forEach((col, i) => {
    const c = colors[i];
    if (!c) { col.remove(); return; }
    const rgb = hexRgb(c.hex);
    if (!rgb) { warnings.push(`Couleur illisible : ${c.hex} (attendu #RRVVBB).`); return; }
    col.findOne((n) => n.name === 'Pastille').fills = [{ type: 'SOLID', color: rgb }];
    col.findOne((n) => n.name === 'Nom').characters = String(c.nom || 'Couleur');
    const to = (x) => Math.round(x * 255);
    col.findOne((n) => n.name === 'Valeurs').characters = `${c.hex.toUpperCase()} · RVB ${to(rgb.r)}, ${to(rgb.g)}, ${to(rgb.b)}`;
    col.name = String(c.nom || `Couleur ${i + 1}`);
  });
  mutated.push(s.id);
}

// Polices : leurs noms, et l'exemple « Aa » dans la police des titres si Figma la connaît
if (D.typos && (D.typos.titres || D.typos.texte)) {
  const s = named('Typographies');
  const typo = s.findOne((n) => n.name === 'Polices');
  if (D.typos.titres) typo.findOne((n) => n.name === 'Titres').characters = `Titres — ${D.typos.titres}`;
  if (D.typos.texte) typo.findOne((n) => n.name === 'Texte').characters = `Texte — ${D.typos.texte}`;
  if (D.typos.titres) {
    const aa = s.findOne((n) => n.name === 'Exemple');
    try {
      await figma.loadFontAsync({ family: D.typos.titres, style: 'Regular' });
      aa.fontName = { family: D.typos.titres, style: 'Regular' };
    } catch { warnings.push(`Police « ${D.typos.titres} » absente de Figma : l'exemple reste en Hanken Grotesk.`); }
  }
  mutated.push(s.id);
}

return { mutatedNodeIds: mutated, captures, warnings };
