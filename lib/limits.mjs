// Vigie — limites atteintes : quand elles se remettent à zéro, et comment le dire en français.
// Claude Code écrit en anglais (« You've hit your session limit · resets 3:40am ») : ce texte n'est jamais montré tel
// quel. Calculs purs, sans fichier (serveur : « À regarder » ; conversations : fil et détail).
const HOUR = 3600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;

// Remise à zéro d'une limite atteinte, lue dans le texte de Claude Code (heure locale du Mac) :
// « resets 11:40pm », « resets Oct 26, 7pm », « resets Oct 22 at 9am », « will reset at 3pm (Europe/Paris) »,
// ancienne forme « Claude AI usage limit reached|1760917200 » (secondes). Sans heure lisible : 5 h pour une limite
// de session, sinon 7 jours. Renvoie une date en ms, ou null.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_RE = /\breset(?:s)?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\b\.?)?/i;
const EPOCH_RE = /\|(\d{10})\b/;
const SESSION_WORDS = /\bsession\b|5-hour|\b5h\b|five[- ]hour/i;
const WEEK_WORDS = /\bweek(?:ly)?\b|7-day|seven[- ]day/i;

export function limitResetAt(text, ts) {
  const t0 = Date.parse(ts || '');
  if (!Number.isFinite(t0)) return null;
  const s = String(text || '');
  const epoch = EPOCH_RE.exec(s);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    if (at > t0 - DAY && at < t0 + 8 * DAY) return at;
  }
  const m = RESET_RE.exec(s);
  if (m && (m[4] || m[5])) {
    let h = Number(m[3]);
    const min = Number(m[4] || 0);
    if (m[5]) h = (h % 12) + (m[5].toLowerCase() === 'p' ? 12 : 0);
    if (h <= 23 && min <= 59) {
      const d = new Date(t0);
      if (m[1] && m[2]) {
        const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
        if (mon >= 0) {
          const r = new Date(d.getFullYear(), mon, Number(m[2]), h, min);
          if (r.getTime() < t0 - DAY) r.setFullYear(r.getFullYear() + 1);
          return r.getTime();
        }
      } else {
        const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min);
        if (r.getTime() <= t0) r.setDate(r.getDate() + 1);
        return r.getTime();
      }
    }
  }
  return t0 + (SESSION_WORDS.test(s) ? 5 * HOUR : WEEK);
}

// session (fenêtre de 5 h) ou week (la semaine). Les mots du texte d'abord ; sinon la remise à zéro : plus de 6 h
// après la limite, c'est la semaine.
export function limitScope(text, ts) {
  const s = String(text || '');
  if (WEEK_WORDS.test(s)) return 'week';
  if (SESSION_WORDS.test(s)) return 'session';
  const at = limitResetAt(s, ts);
  const t0 = Date.parse(ts || '');
  return at !== null && Number.isFinite(t0) && at - t0 > 6 * HOUR ? 'week' : 'session';
}

// Dates à la française, sans dépendre des données de langue de Node (mêmes abréviations que l'app).
const pad = (n) => String(n).padStart(2, '0');
const DAYS_FR = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const hourText = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dayText = (ms) => { const d = new Date(ms); return `${DAYS_FR[d.getDay()]} ${d.getDate()} ${MONTHS_FR[d.getMonth()]}`; };

// « Remise à zéro à 03:40 » quand elle tombe moins de 20 h après `from`, sinon « Remise à zéro lun. 26 oct. à 20:00 ».
export function resetText(at, from) {
  if (!Number.isFinite(at)) return null;
  return Number.isFinite(from) && at - from < 20 * HOUR ? `Remise à zéro à ${hourText(at)}` : `Remise à zéro ${dayText(at)} à ${hourText(at)}`;
}

// Ce que l'app montre d'une limite : titre (« Limite de session atteinte · Travail 1 »), détail (« Remise à zéro à
// 03:40 »), sorte et date de remise à zéro. account : nom du compte, ou null.
export function limitView(text, ts, account = null) {
  const scope = limitScope(text, ts);
  const at = limitResetAt(text, ts);
  const model = scope === 'week' ? /\b(Opus|Sonnet|Haiku|Fable)\b/i.exec(String(text || ''))?.[1] : null;
  const what = scope === 'week'
    ? (model ? `Limite ${model[0].toUpperCase()}${model.slice(1).toLowerCase()} de la semaine atteinte` : 'Limite de la semaine atteinte')
    : 'Limite de session atteinte';
  return {
    scope,
    resetsAt: at === null ? null : new Date(at).toISOString(),
    title: account ? `${what} · ${account}` : what,
    detail: at === null ? null : resetText(at, Date.parse(ts || '')),
  };
}
