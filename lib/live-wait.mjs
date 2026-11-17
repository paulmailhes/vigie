// Attentes que Claude Code annonce dans son registre (~/.claude/sessions/<pid>.json : status « waiting », waitingFor
// « permission prompt » ou « input needed » en mode VS Code).
//
// Pourquoi un délai : en mode VS Code, Claude Code passe en « waiting » au moment même où il lance le hook
// PermissionRequest de Vigie, sans attendre sa réponse. Quand Vigie accepte seule (environ 120 ms plus tard), la
// conversation n'a attendu personne, mais une photo du registre tombée à ce moment-là la disait « en attente » : une
// notification « t'attend » pour rien, des centaines par jour. Une attente n'est donc vraie (notifiée, comptée « t'attend »)
// qu'après WAIT_CONFIRM_MS sans interruption, comptés depuis statusUpdatedAt (le début de l'état en cours : Claude Code
// ne le réécrit pas tant que l'état ne change pas), sinon depuis la première fois que le moteur l'a vue (registre plus
// ancien, sans statusUpdatedAt).

export const WAIT_CONFIRM_MS = 20_000;
// Filet : une conversation vue « en attente » (même attente) sur chaque photo du registre depuis 60 s est notifiée
// même si statusUpdatedAt dit moins (s'il venait à être réécrit en cours d'attente). Les passages de 120 ms ne tombent
// jamais sur 15 photos de suite.
export const WAIT_SEEN_MS = 60_000;

// L'entrée du registre dit-elle « en attente de l'utilisateur » ? (même règle que statusOf, lib/conversations.mjs)
export const isWaiting = (entry) => !!entry && (entry.status === 'waiting' || !!entry.waitingFor);

// Début de l'attente d'après le registre seul (ms), ou null (pas en attente, ou registre sans statusUpdatedAt).
export function waitStart(entry) {
  if (!isWaiting(entry)) return null;
  const t = Number(entry.statusUpdatedAt);
  return Number.isFinite(t) && t > 0 ? t : null;
}

// Première heure où le moteur a vu chaque attente (pour un registre sans statusUpdatedAt). note() suit chaque photo du
// registre : une attente qui change de nature (« permission prompt » → « input needed ») repart de zéro, une
// conversation qui n'attend plus ou qui est fermée est oubliée.
export function createWaitTracker() {
  const seen = new Map(); // sessionId -> { at, key }
  return {
    note(live, now = Date.now()) {
      for (const sid of [...seen.keys()]) if (!live.has(sid)) seen.delete(sid);
      for (const [sid, entry] of live) {
        if (!isWaiting(entry)) { seen.delete(sid); continue; }
        const key = `${entry.status ?? ''}\u0000${entry.waitingFor ?? ''}`;
        if (seen.get(sid)?.key !== key) seen.set(sid, { at: now, key });
      }
    },
    firstSeen: (sid) => seen.get(sid)?.at ?? null,
  };
}

// Attente confirmée : { since (ms), waitingFor } si elle dure depuis au moins WAIT_CONFIRM_MS, sinon null.
// - snapshot : l'entrée de la dernière photo du registre (4 s au plus) ;
// - fresh : la même, relue à l'instant (indexer.liveNow) : elle passe devant la photo, qui peut encore dire « en attente »
//   juste après une réponse ; null = conversation fermée ; undefined = pas relue (ou illisible) : la photo seule ;
// - firstSeen : première photo qui a vu l'attente (createWaitTracker), seule mesure quand le registre n'a pas de
//   statusUpdatedAt, et filet au-delà de WAIT_SEEN_MS.
export function confirmedWait({ snapshot, fresh, firstSeen = null, now = Date.now(), minMs = WAIT_CONFIRM_MS }) {
  if (fresh === null) return null;
  const entry = fresh === undefined ? snapshot : fresh;
  if (!isWaiting(entry)) return null;
  const waitingFor = typeof entry.waitingFor === 'string' ? entry.waitingFor : null;
  const seen = Number.isFinite(firstSeen) && firstSeen > 0 ? firstSeen : null;
  const since = waitStart(entry) ?? seen;
  if (since !== null && now - since >= minMs) return { since, waitingFor };
  if (seen !== null && now - seen >= WAIT_SEEN_MS) return { since: seen, waitingFor };
  return null;
}

// ---------- attentes tenues par le hook de Vigie ----------
// Une attente du hook (garde-fou en attente, question en attente, « toujours me demander » avec ses choix) tient une
// fenêtre que le registre dit « en attente » depuis son ouverture. Quand l'utilisateur décide ou répond dans Vigie, le
// moteur retire aussitôt l'attente du hook (decisions.json), mais le hook ne relit ce fichier qu'une fois par seconde :
// le registre dit encore « en attente » depuis l'ouverture de la fenêtre, plus de 20 s plus tôt, et l'app, qui relit la
// vue tout de suite, notifierait « attend ton accord » pour la fenêtre qu'on vient de fermer.

// Lignes de l'historique qui ouvrent une attente du hook (même règle que pendingWaits, server.mjs). Sans `questions`,
// « question-pour-toi » n'est pas une attente du hook (terminal, sous-agent, mode « tout de suite ») ; le hook qui
// attend vraiment l'écrit toujours, vide pour un plan.
export const HOOK_WAIT_EVENTS = new Set(['garde-fou-attente', 'question-attente']);
export const opensHookWait = (h) => HOOK_WAIT_EVENTS.has(h?.event) || (h?.event === 'question-pour-toi' && Array.isArray(h.questions));
// Le hook rend la fenêtre à l'utilisateur (auto-accept coupé, réglage changé, réponse perdue, question laissée à
// VS Code) : l'attente qui suit est vraie.
const handsBack = (h) => /-pour-toi$|-rendue?$/.test(String(h?.event || '')) || h?.event === 'reponse-perdue';
// Le registre passe « en attente » au lancement du hook, qui note son attente quelques dixièmes de seconde plus tard.
export const HOOK_MARGIN_MS = 2_000;
// Registre sans statusUpdatedAt : le début de l'attente est la première photo qui l'a vue, jusqu'à un tour (4 s) plus
// tard, davantage sur un Mac chargé.
export const SEEN_LATE_MS = 8_000;

// L'attente confirmée `wait` (confirmedWait) est-elle la fenêtre d'une attente du hook ? Oui si elle commence au plus
// HOOK_MARGIN_MS après la dernière attente du hook de la conversation et que le hook n'a pas rendu la fenêtre depuis.
// history : lignes de data/history.jsonl dans l'ordre d'écriture, lues depuis la fin jusqu'au début possible de
// l'attente ; firstSeen : celui de confirmedWait (s'il donne `since`, le début réel peut être plus tôt).
export function heldByHook({ wait, history, sessionId, firstSeen = null }) {
  if (!wait || !sessionId || !Array.isArray(history) || !Number.isFinite(wait.since)) return false;
  const floor = new Date(wait.since - HOOK_MARGIN_MS - (wait.since === firstSeen ? SEEN_LATE_MS : 0)).toISOString();
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (String(h?.ts || '') < floor) return false;
    if (h.sessionId !== sessionId) continue;
    if (opensHookWait(h)) return true;
    if (handsBack(h)) return false;
  }
  return false;
}

// Ce que l'attente demande, en français (le texte anglais de Claude Code n'est jamais montré) :
// - title(where) : titre de l'élément « À regarder » (« Attend ton accord dans VS Code ») ;
// - detail : une phrase, reprise dans l'aide de la pastille « T'attend » et dans la notification.
export function waitWording(waitingFor) {
  if (waitingFor === 'permission prompt') {
    return { title: (where) => `Attend ton accord dans ${where}`, detail: 'Une action à autoriser : Vigie ne l\'a pas validée seule.' };
  }
  if (waitingFor === 'input needed') {
    return { title: (where) => `Attend ta réponse dans ${where}`, detail: 'Une question ou un choix à faire.' };
  }
  return { title: (where) => `Attend ta réponse dans ${where}`, detail: 'Elle attend ta réponse.' };
}
