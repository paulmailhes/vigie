// Résumés par règles, sans modèle ni réseau : la phrase utile d'un compte rendu, la question qui le termine, ce qui
// revient à l'utilisateur, et une demande sans ses mots de remplissage. Utilisés par les notifications, la tuile
// d'État et l'Échange. Une ligne « En bref : … » écrite par Claude en tête de son compte rendu l'emporte toujours.

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return (space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·—–-]+$/, '') + '…';
};

// Une ligne de Markdown en texte simple : sans titre, puce, citation, gras, code, lien.
export function plainLine(line) {
  return String(line || '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lignes utiles : hors blocs de code, tableaux, séparateurs, lignes vides.
function usefulLines(text) {
  const out = [];
  let fence = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^\s*\|/.test(raw) || /^\s*([-*_=])\1{2,}\s*$/.test(raw)) continue;
    const isHeading = /^\s{0,3}#{1,6}\s/.test(raw);
    const line = plainLine(raw);
    if (line) out.push({ line, isHeading });
  }
  return out;
}

const BRIEF = /^\s*(?:[-*>]\s*)?(?:\*\*|__)?\s*en bref\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.+)$/i;
// Titres génériques d'un compte rendu : ils n'apprennent rien.
const GENERIC = /^(?:r[ée]sum[ée]|compte[- ]rendu|bilan|synth[èe]se|ce que j'ai fait|ce qui a [ée]t[ée] fait|fait|termin[ée]|r[ée]sultat|statut|[ée]tat|done|summary|recap)\s*[:.!]?$/i;

// Première phrase d'un texte (coupée à la fin de la phrase si elle tient).
function firstSentence(line, n) {
  const m = /^(.+?[.!?…])(?=\s+[A-ZÀ-ÖØ-Ý«"(]|$)/.exec(line);
  const s = m && m[1].length >= 12 ? m[1] : line;
  return clip(s.replace(/\s*[:：]$/, ''), n);
}

// La phrase qui dit ce qui a été fait : la ligne « En bref : », sinon la première phrase utile.
export function briefOf(text, n = 140) {
  const raw = String(text || '');
  for (const l of raw.split(/\r?\n/)) {
    const m = BRIEF.exec(l);
    if (m) return clip(plainLine(m[1]).replace(/(\*\*|__)\s*$/, ''), n);
  }
  const lines = usefulLines(raw);
  for (const { line, isHeading } of lines) {
    if (GENERIC.test(line)) continue;
    if (isHeading && line.split(' ').length < 3) continue;
    if (line.split(' ').length < 3 && !/[.!?]$/.test(line)) continue;
    return firstSentence(line, n);
  }
  return lines.length ? firstSentence(lines[0].line, n) : null;
}

// La question qui termine le texte : la dernière phrase en « ? » parmi ses trois dernières lignes utiles.
export function askOf(text, n = 200) {
  const lines = usefulLines(text).map((x) => x.line);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i].replace(/[\s»")\]*_]+$/, '');
    if (!line.endsWith('?')) continue;
    // la dernière phrase de la ligne
    const parts = line.split(/(?<=[.!…])\s+(?=[A-ZÀ-ÖØ-Ý«"(])/);
    return clip(parts[parts.length - 1], n);
  }
  return null;
}

const TO_YOU = /^\s*(?:[-*>]\s*)?(?:\*\*|__)?\s*(?:à toi|pour toi|de ton c[ôo]t[ée]|reste pour toi|ce qu'il te reste(?: à faire)?|à faire de ton c[ôo]t[ée])\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.+)$/i;

// Ce qui revient à l'utilisateur, quand Claude l'a écrit (« À toi : … »).
export function toYouOf(text, n = 100) {
  for (const l of String(text || '').split(/\r?\n/)) {
    const m = TO_YOU.exec(l);
    if (m) return clip(plainLine(m[1]).replace(/(\*\*|__)\s*$/, ''), n);
  }
  return null;
}

// Une demande sans ses mots de remplissage du début (« ok, donc là… »), souvent dictée.
// (\b ne marche pas après une lettre accentuée en JavaScript : « (?=…) » à la place.)
const LEAD = /^(?:(?:ok(?:ay)?|bon|alors|donc|du coup|bref|euh+|hum+|ah|oui|ouais|bah|ben|en fait|écoute|dis[- ]moi|et|mais|là|voilà|parfait|super|merci|ça marche)(?=[\s,.!…]|$)[\s,.!…]*)+/i;
export function promptBrief(prompt, n = 110) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim();
  const t = s.replace(LEAD, '');
  const out = t.length >= 8 ? t : s;
  return clip(out.charAt(0).toUpperCase() + out.slice(1), n);
}
