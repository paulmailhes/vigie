// Vigie — ouvrir VS Code ou l'app Claude pour l'utilisateur : le lancement d'un agent et « ouvrir une conversation ».
// Seul `open` (/usr/bin/open, VIGIE_OPEN_BIN) est lancé, avec des arguments, jamais par un shell ; les liens sont
// construits ici, chaque valeur encodée (encodeURIComponent).
//
// VS Code envoie un lien vscode:// à sa DERNIÈRE fenêtre active, sans moyen de viser une fenêtre. Ouvrir le dossier
// puis le lien après une attente fixe envoyait le message dans un autre projet quand la fenêtre tardait. Chaque
// fenêtre où l'extension Claude Code démarre écrit ~/.claude/ide/<port>.lock ({ pid, workspaceFolders, … }) : le lien
// ne part qu'une fois la fenêtre du dossier prête (fichier présent, pid vivant), sinon il ne part pas du tout.
// L'attente passe par des minuteries : la boucle de Node reste libre (vérifié le 2026-10-26, docs/agents.md).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { placeKey } from './agents.mjs';
import { promptParam } from './questions.mjs';

export const VSCODE_APP = 'Visual Studio Code';
// Fenêtre déjà là : le temps qu'elle passe devant. Sinon : sondage, attente maximale, puis le temps que l'extension
// écoute les liens.
export const TIMING = { present: 800, poll: 300, max: 25_000, settle: 1500 };
// Message prérempli de l'app Claude (paramètre q) : 2 592 caractères au plus.
export const APP_PROMPT_MAX = 2592;
const LOCK_MAX_BYTES = 64 * 1024, LOCKS_MAX = 200;
const NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^local_[A-Za-z0-9_-]{1,200}$/;

// Lance un programme du Mac sans shell ; résultat { ok, code }. La sortie n'est jamais journalisée.
export function runBin(bin, args, { input = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: [input === null ? 'ignore' : 'pipe', 'ignore', 'ignore'] }); } catch { return resolve({ ok: false, code: null }); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* déjà fini */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(t); resolve({ ok: false, code: null }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code }); });
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// ---------- liens ----------
// Extension Claude Code : prompt = message prérempli (pas envoyé), session = conversation à rouvrir. VS Code décode
// une fois la requête, puis l'extension la relit : promptParam garde & + % à travers les deux décodages.
export function vscodeLink({ prompt = null, session = null } = {}) {
  const q = [];
  if (prompt) q.push(`prompt=${promptParam(prompt)}`);
  if (session) q.push(`session=${encodeURIComponent(session)}`);
  return `vscode://anthropic.claude-code/open${q.length ? `?${q.join('&')}` : ''}`;
}
// App Claude, nouvelle conversation Claude Code dans ce dossier, message prérempli s'il tient dans q (sinon sans).
export function claudeNewLink(folder, prompt) {
  const withPrompt = typeof prompt === 'string' && prompt.length > 0 && prompt.length <= APP_PROMPT_MAX;
  return { url: `claude://code/new?folder=${encodeURIComponent(folder)}${withPrompt ? `&q=${encodeURIComponent(prompt)}` : ''}&source=vigie`, withPrompt };
}
// App Claude, reprise : une conversation née dans l'app se rouvre par son id local ; une autre (VS Code, Terminal)
// est importée par son uuid. Aucun des deux ne prend de message.
export function claudeResumeLink({ session, localId = null }) {
  if (typeof localId === 'string' && LOCAL_ID.test(localId)) return `claude://code/continue?session=${encodeURIComponent(localId)}`;
  return `claude://resume?session=${encodeURIComponent(session)}`;
}

// Phrase de la réponse du lancement, selon ce qui s'est ouvert. « copié » : l'app copie le message dès que ce n'est
// pas « full ».
export function launchMessage(opened, surface) {
  if (opened === 'full') {
    return surface === 'claude-app'
      ? 'L\'app Claude s\'ouvre sur le projet, avec le message prêt : envoie-le.'
      : 'VS Code s\'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le.';
  }
  if (opened === 'folder') return 'VS Code est ouvert sur le projet, mais Claude Code n\'a pas répondu à temps : le message est copié, colle-le dans Claude Code et envoie-le.';
  if (opened === 'no-prompt') return 'La conversation s\'ouvre dans l\'app Claude : le message est copié, colle-le (⌘V) et envoie-le.';
  return 'Le dossier est prêt, mais rien ne s\'est ouvert : le message est copié, colle-le dans Claude Code.';
}

// Surface proposée : la dernière utilisée si elle est là, sinon la première disponible, sinon null.
export const chooseSurface = (available, last) => (available.includes(last) ? last : available[0] ?? null);

// ---------- ouvreur ----------
// home : le dossier perso (fenêtres de VS Code : home/.claude/ide, sans CLAUDE_CONFIG_DIR quand VS Code part du Dock).
// Injectables pour les essais : openBin, run, sleep, now, alive, timing.
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // EPERM : il existe, à un autre
}

export function createOpener({ home, openBin = '/usr/bin/open', run = runBin, sleep = wait, now = Date.now, alive = isAlive, timing = {} } = {}) {
  if (!home) throw new Error('home manquant');
  const ideDir = path.join(path.resolve(home), '.claude', 'ide');
  const t = { ...TIMING, ...timing };

  // Une fenêtre VS Code prête pour ce dossier ? Un ~/.claude/ide/*.lock (fichier ordinaire, 64 Ko au plus, lu sans
  // suivre de lien) dont workspaceFolders contient le dossier (chemin réel, casse pliée) et dont le pid est vivant.
  // 200 fichiers au plus ; chaque dossier de fenêtre résolu une fois.
  function windowReady(folder) {
    const want = placeKey(folder);
    let names;
    try { names = fs.readdirSync(ideDir); } catch { return false; }
    let n = 0;
    for (const f of names) {
      if (!f.endsWith('.lock')) continue;
      if (++n > LOCKS_MAX) break;
      let j = null;
      try {
        const fd = fs.openSync(path.join(ideDir, f), NO_FOLLOW);
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && st.size <= LOCK_MAX_BYTES) j = JSON.parse(fs.readFileSync(fd, 'utf8'));
        } finally { fs.closeSync(fd); }
      } catch { continue; } // lien, disparu, en cours d'écriture
      const pid = j?.pid;
      if (!Number.isInteger(pid) || pid <= 1 || !Array.isArray(j.workspaceFolders)) continue;
      if (!j.workspaceFolders.some((w) => typeof w === 'string' && path.isAbsolute(w) && placeKey(w) === want)) continue;
      if (alive(pid)) return true;
    }
    return false;
  }

  // VS Code sur le dossier, puis le lien quand sa fenêtre est prête : 'full' (lien parti), 'folder' (VS Code ouvert,
  // lien pas envoyé : la fenêtre n'a pas répondu à temps, ou le lien a échoué), 'none' (VS Code ne s'est pas ouvert).
  async function vscode(folder, link) {
    const was = windowReady(folder);
    if (!(await run(openBin, ['-a', VSCODE_APP, folder])).ok) return 'none';
    if (was) await sleep(t.present);
    else {
      const start = now();
      let ready = windowReady(folder);
      while (!ready && now() - start < t.max) {
        await sleep(t.poll);
        ready = windowReady(folder);
      }
      if (!ready) return 'folder'; // il partirait dans une autre fenêtre
      await sleep(t.settle);
    }
    return (await run(openBin, [link])).ok ? 'full' : 'folder';
  }

  // Un lien (claude://…) : true s'il s'est ouvert.
  async function url(link) { return (await run(openBin, [link])).ok; }

  // Lancement d'un agent : { surface, folder, prompt, session?, localId? } → opened.
  // vscode : nouvelle conversation ou reprise, message prérempli. claude-app : nouvelle → message prérempli s'il tient
  // (full), sinon sans (no-prompt) ; reprise → l'app copie le message (no-prompt).
  async function launch({ surface, folder, prompt, session = null, localId = null }) {
    if (session !== null && !UUID.test(String(session))) throw new Error('session invalide');
    if (surface === 'vscode') return vscode(folder, vscodeLink({ prompt, session }));
    if (session) return (await url(claudeResumeLink({ session, localId }))) ? 'no-prompt' : 'none';
    const l = claudeNewLink(folder, prompt);
    if (!(await url(l.url))) return 'none';
    return l.withPrompt ? 'full' : 'no-prompt';
  }

  return { ideDir, windowReady, vscode, url, launch };
}
