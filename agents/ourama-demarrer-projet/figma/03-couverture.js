// Modèle de projet Ourama — 3 : la couverture, pleine page (1920 × 1080, l'aperçu du fichier dans Figma).
// Une couleur par projet : celle de la marque du client si on la connaît (« couleur »), sinon une couleur de la
// palette du studio choisie d'après son nom. Fond très clair teinté, deux quarts de cercle en dégradé sur la droite,
// « PROJET » et le nom du client en très grand. Remplace __PARAMS__ par l'objet JSON des paramètres, par exemple
// {"client":"Cabinet Martin","annee":"2026","prestations":"Identité de marque · Site web","couleur":"#1F3A68"}
// (« couleur » : null si on ne la connaît pas).
const P = __PARAMS__;
const F = 'Hanken Grotesk';
await Promise.all(['Medium', 'Regular'].map((style) => figma.loadFontAsync({ family: F, style })));
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s.id]));
const kit = figma.root.children.find((p) => p.name === '⚙️ Composants');
await kit.loadAsync();
const C = Object.fromEntries(kit.children.filter((n) => n.type === 'COMPONENT').map((n) => [n.name, n]));
const page = figma.root.children.find((p) => p.name === '🌅 Couverture');
await figma.setCurrentPageAsync(page);
if (page.children.length) throw new Error('La page Couverture est déjà remplie : passe à la suite.');

// Couleurs du projet
const PALETTE = ['#2F5D4A', '#1F3A68', '#A44A26', '#5B2A4E', '#8C6A12', '#1E6363', '#3D4B5C', '#8E2F2A', '#4F5E22', '#4B3F8F'];
const rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const WHITE = { r: 1, g: 1, b: 1 }, BLACK = { r: 0, g: 0, b: 0 };
let hash = 0;
for (const ch of String(P.client || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
// Même teinte, clarté ramenée entre 24 et 42 % : une couleur de marque très claire (or, crème) ou très sombre (bleu
// nuit, presque noir) donnerait une couverture sans contraste ou grise.
function hsl({ r, g, b }) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
function fromHsl({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}
// une couleur sans teinte (noir, gris, blanc) ne dit rien du client : la palette du studio prend le relais
const brand = rgb(P.couleur);
const t = brand ? hsl(brand) : null;
let base = t && t.s >= 0.12
  ? fromHsl({ h: t.h, s: Math.max(t.s, 0.25), l: Math.min(0.42, Math.max(0.24, t.l)) })
  : rgb(PALETTE[hash % PALETTE.length]);
while (lum(base) > 0.45) base = mix(base, BLACK, 0.2);
const bg = mix(base, WHITE, 0.9);
const ink = mix(base, BLACK, 0.4);
const label = mix(base, bg, 0.35);
const stop = (c, position, a = 1) => ({ position, color: { ...c, a } });

const s = figma.createFrame();
s.name = 'Couverture'; s.resize(1920, 1080); s.clipsContent = true; s.x = 0; s.y = 0;
s.fills = [{ type: 'SOLID', color: bg }];
page.backgrounds = [{ type: 'SOLID', color: bg }];

// Deux quarts de cercle empilés sur la droite, en pleine hauteur
for (const [name, y, stops] of [
  ['Quart haut', -540, [stop(mix(base, BLACK, 0.3), 0), stop(mix(base, WHITE, 0.08), 1)]],
  ['Quart bas', 0, [stop(mix(base, WHITE, 0.5), 0), stop(mix(base, WHITE, 0.78), 1)]],
]) {
  const e = figma.createEllipse(); e.name = name; e.resize(1080, 1080); s.appendChild(e);
  e.x = 840; e.y = y;
  e.arcData = { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0 };
  e.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[0.5, -0.5, 0.5], [0.5, 0.5, 0]], gradientStops: stops }];
}
try { // grain discret, si Figma le permet
  s.effects = [{ type: 'NOISE', noiseType: 'MONOTONE', noiseSize: 1.5, density: 0.5, color: { ...ink, a: 0.06 }, visible: true }];
} catch { /* sans grain */ }

// Logo Ourama, recoloré dans l'encre du projet
const logo = C['Logo Ourama'].createInstance(); s.appendChild(logo);
logo.resize(300, 300 * logo.height / logo.width); logo.x = 96; logo.y = 84;
for (const n of logo.findAll((x) => 'fills' in x && Array.isArray(x.fills))) {
  n.fills = n.fills.map((f) => (f.type === 'SOLID' ? { ...f, color: ink }
    : f.type.startsWith('GRADIENT') ? { ...f, gradientStops: f.gradientStops.map((g) => ({ ...g, color: { ...ink, a: g.color.a } })) } : f));
}

// « PROJET », le nom du client, les prestations
const block = figma.createAutoLayout('VERTICAL', { name: 'Titre du projet', itemSpacing: 20 }); block.fills = [];
s.appendChild(block);
const tag = figma.createText(); tag.name = 'Étiquette';
await tag.setTextStyleIdAsync(S['Ourama/Sous-titre']);
tag.fontName = { family: F, style: 'Regular' }; tag.letterSpacing = { unit: 'PERCENT', value: 4 };
tag.characters = 'PROJET'; tag.fills = [{ type: 'SOLID', color: label }];
block.appendChild(tag);
const name = figma.createText(); name.name = 'Client';
await name.setTextStyleIdAsync(S['Ourama/Titre XXL']);
name.characters = String(P.client || 'Nom du client'); name.fills = [{ type: 'SOLID', color: ink }];
name.resize(1180, name.height); name.textAutoResize = 'HEIGHT';
block.appendChild(name);
const sub = figma.createText(); sub.name = 'Prestations';
await sub.setTextStyleIdAsync(S['Ourama/Intertitre']);
sub.fontName = { family: F, style: 'Regular' };
sub.characters = [P.prestations, P.annee].filter(Boolean).join(' · ') || ' '; sub.fills = [{ type: 'SOLID', color: label }];
block.appendChild(sub);
// Nom long : on réduit jusqu'à ce que chaque mot tienne sur une ligne et que le bloc reste sous le logo
const probe = figma.createText();
await probe.setTextStyleIdAsync(S['Ourama/Titre XXL']);
const widest = () => Math.max(...name.characters.split(/\s+/).map((w) => { probe.characters = w; return probe.width; }));
while ((widest() > 1180 || 1080 - 96 - block.height < 260) && name.fontSize > 96) { name.fontSize -= 16; probe.fontSize = name.fontSize; }
probe.remove();
block.x = 96; block.y = 1080 - 96 - block.height;

// L'aperçu du fichier dans Figma : la couverture, en plein cadre
let thumbnail = true;
try { await figma.setFileThumbnailNodeAsync(s); } catch { thumbnail = false; }
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
return { createdNodeIds: [s.id], couleur: hex(base), fond: hex(bg), encre: hex(ink), clientFontSize: name.fontSize, thumbnail };
