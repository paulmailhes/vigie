// Vigie — consommation en direct (rate), alerte « s'emballe » et graphique (contrat : « Ajouts du tour 3 »).
// Calculs purs à partir des seaux minute par minute de l'indexeur (Indexer.usageBuckets) : le serveur fournit
// les seaux, la semaine du compte ({ den, pct } : poids du compte sur sa fenêtre hebdo et son % hebdo, comme
// weekPct), les tests et l'activité de la conversation.

export const RATE_MINUTES = 130;    // 2 h de référence + la fenêtre de 10 min en cours
const WINDOW = 10;                  // débit mesuré sur les 10 dernières minutes
const SPARK = 30;
const MIN = 60_000;

const sum = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i] || 0; return s; };
const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Poids -> % de la semaine du compte.
// Points de % de la semaine par unité de poids d'un compte. self/peers : { measured, upper, tier } — measured : hausse
// réelle mesurée (null sans assez de recul) ; upper : pct / poids vu ici, un plafond (exact seulement si tout l'usage
// de la semaine du compte est passé ici). Sans mesure : le plus petit plafond ou mesure des comptes du même abonnement,
// sauf ceux à 100 % (pct) : bloqués là, ils continuent de consommer en usage supplémentaire, leur plafond ne vaut rien.
export function weekRatio(self, peers = []) {
  if (self.measured !== null && self.measured !== undefined) return self.measured;
  let ratio = self.upper;
  if (self.tier) for (const p of peers) if (p && p.tier === self.tier && !(p.pct >= 100)) ratio = Math.min(ratio, p.measured ?? p.upper);
  return ratio;
}
// ratio : points de % de la semaine par unité de poids (server.mjs, weekInfo) ; sinon la part du poids vu ici.
export const toWeekPct = (weight, week) => (!week ? null : week.ratio > 0 ? weight * week.ratio : week.den > 0 ? (weight / week.den) * week.pct : null);

// Débit d'une conversation. buckets : usageBuckets(id, début, 1, RATE_MINUTES, org du compte) — le dernier
// seau est la minute en cours. week : { den, pct } ou null.
export function rateOf(buckets, week) {
  const n = RATE_MINUTES;
  const last = sum(buckets.w, n - WINDOW, n);
  const lastAll = sum(buckets.all, n - WINDOW, n);
  const prevAll = sum(buckets.all, n - 2 * WINDOW, n - WINDOW);
  const pctH = toWeekPct(last, week);
  let trend = 'flat';
  if (lastAll > 0 || prevAll > 0) {
    if (lastAll > prevAll * 1.25) trend = 'up';
    else if (lastAll < prevAll * 0.75) trend = 'down';
  }
  return {
    weekPctPerHour: pctH === null ? null : round(pctH * (60 / WINDOW), 2),
    tokensPerMin: Math.round(sum(buckets.tok, n - WINDOW, n) / WINDOW),
    spark: buckets.all.slice(n - SPARK).map((v) => Math.round(v)),
    trend,
  };
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shortText = (s, n) => { s = norm(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// « S'emballe » : la règle la plus parlante d'abord (tests en boucle, agent en boucle, puis débit).
//  - même commande de test en échec ≥ 6 fois en 20 min (hors étape rouge voulue, hors tests pas finis) ;
//  - un agent qui répète la même action (même outil, mêmes paramètres affichés) ≥ 8 fois en 20 min ;
//  - débit des 10 dernières minutes > 3 × la médiane des tranches de 10 min actives des 2 h précédentes
//    (au moins 3 tranches actives : une conversation qui démarre n'a pas de référence) ET > 0,5 %/h.
// Renvoie { kind: 'emballe', since, reason } ou null. now en ms ; tests / activity : ceux de l'indexeur.
export function runawayAlert({ now, buckets, week, tests = [], activity = [], agentLabel = (id) => id, mask = (s) => s }) {
  const from = new Date(now - 20 * MIN).toISOString();
  // tests en boucle
  const fails = new Map();
  for (const t of tests) {
    if (!t || t.ok !== false || t.pending || t.red || !(String(t.ts || '') >= from)) continue;
    const k = norm(t.command);
    if (!k) continue;
    const g = fails.get(k) || { n: 0, first: t.ts };
    g.n++;
    if (t.ts < g.first) g.first = t.ts;
    fails.set(k, g);
  }
  let worst = null;
  for (const g of fails.values()) if (g.n >= 6 && (!worst || g.n > worst.n)) worst = g;
  if (worst) {
    const min = Math.max(1, Math.round((now - Date.parse(worst.first)) / MIN));
    return { kind: 'emballe', since: worst.first, reason: `Les mêmes tests échouent en boucle depuis ${min} min (${worst.n} lancements).` };
  }
  // agent en boucle
  const reps = new Map();
  for (const a of activity) {
    if (!a?.agent || !(String(a.ts || '') >= from)) continue;
    const k = `${a.agent}\u0000${a.tool}\u0000${a.sig || norm(a.detail || a.title)}`; // mêmes paramètres exacts
    const g = reps.get(k) || { n: 0, first: a.ts, a };
    g.n++;
    if (a.ts < g.first) g.first = a.ts;
    reps.set(k, g);
  }
  let loop = null;
  for (const g of reps.values()) if (g.n >= 8 && (!loop || g.n > loop.n)) loop = g;
  if (loop) {
    const name = shortText(agentLabel(loop.a.agent) || 'un agent', 60);
    const what = shortText(mask(loop.a.title || loop.a.tool || 'action'), 80);
    return { kind: 'emballe', since: loop.first, reason: `L'agent « ${name} » répète la même action en boucle (${loop.n} fois en 20 min) : ${what}.` };
  }
  // débit anormal
  if (week && buckets) {
    const n = RATE_MINUTES;
    const last = sum(buckets.w, n - WINDOW, n);
    const pctH = toWeekPct(last, week) * (60 / WINDOW);
    const blocks = [];
    for (let b = 0; b < (n - WINDOW) / WINDOW; b++) {
      const v = sum(buckets.w, b * WINDOW, (b + 1) * WINDOW);
      if (v > 0) blocks.push(v);
    }
    if (blocks.length >= 3 && pctH > 0.5) {
      const med = median(blocks);
      if (med > 0 && last > 3 * med) {
        const nowMin = Math.floor(now / MIN);
        return { kind: 'emballe', since: new Date((nowMin - WINDOW + 1) * MIN).toISOString(),
          reason: `Consomme ${String(round(pctH, 1)).replace('.', ',')} % de la semaine par heure, ${Math.round(last / med)} × son rythme des 2 dernières heures.` };
      }
    }
  }
  return null;
}

// Fenêtres du graphique : 1 h par minute, 10 h par 10 min, 20 h par 20 min (60 points chacune).
export const SERIES_WINDOWS = { 60: 1, 600: 10, 1200: 20 };
export const SERIES_POINTS = 60;
// Début du premier seau : les seaux sont alignés sur le pas, le dernier contient la minute en cours.
export function seriesFrom(now, stepMin) {
  const endMin = (Math.floor(Math.floor(now / MIN) / stepMin) + 1) * stepMin;
  return (endMin - SERIES_POINTS * stepMin) * MIN;
}
// Points { t, weekPct, tokens } d'une série (weekPct null sans semaine connue).
export function seriesPoints(fromMs, stepMin, w, tok, week) {
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const pct = toWeekPct(w[i], week);
    out.push({ t: new Date(fromMs + i * stepMin * MIN).toISOString(), weekPct: pct === null ? null : round(pct, 4), tokens: Math.round(tok[i] || 0) });
  }
  return out;
}
