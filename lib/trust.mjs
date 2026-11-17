// Vigie — confiance des dossiers partagée entre les comptes Claude.
//
// Depuis la version 2.1.323 de l'extension Claude Code, chaque fenêtre de VS Code demande « Trust this folder in
// Claude Code? » si Claude Code n'a pas de trace de confiance pour le dossier. Elle lit cette trace avec
// `claude workspace-trust`, un appel annexe que le lanceur laisse partir sur le compte du Mac (~/.claude.json). Mais
// l'accord donné dans la fenêtre est enregistré par le processus de la conversation, donc sur le compte choisi par le
// lanceur : la lecture se fait sur un compte, l'écriture sur un autre, et la question revient à chaque fenêtre.
//
// Le moteur recopie donc la trace (`projects[<dossier>].hasTrustDialogAccepted: true`) d'un compte vers les autres :
// - union pure : un dossier de confiance sur au moins un compte le devient sur tous ; Vigie ne fait confiance à rien
//   de lui-même ;
// - en ajout seulement : rien n'est jamais retiré, aucun fichier n'est créé, et Vigie ne garde aucune mémoire. Pour
//   retirer la confiance d'un dossier, il faut la retirer sur chaque compte : tant qu'un compte l'a encore, elle est
//   recopiée sur les autres au tour suivant ;
// - jamais le dossier perso ni `/`, ni un chemin qui contient des caractères invisibles (Claude Code les refuse aussi),
//   ni un dossier qui n'existe plus ;
// - rien du tout avec un seul compte.
// La clé est recopiée telle quelle : c'est Claude Code qui l'a calculée (racine du dépôt git, sinon le dossier), elle
// est donc la même pour tous les comptes du Mac. Pas d'héritage par les dossiers parents : Claude Code n'en fait pas.
// Écriture comme Claude Code : son verrou `<fichier>.lock`, fichier temporaire, renommage, relecture (lib/mcp.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { safeUpdateJson, PROJECT_DEFAULTS, McpError } from './mcp.mjs';

// Caractères qui rendent un chemin dangereux pour Claude Code (binaire 2.1.326, `QR`, réponse `unsafe_path`) :
// contrôle, format, séparateurs, invisibles, espaces autres que l'espace ordinaire.
export const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]|(?! )\p{Zs}|\p{Cs}/u;
// Dossiers que macOS protège (Bureau, Documents, Téléchargements, photos, iCloud Drive, Dropbox et autres, données des
// apps, disques externes) : le moteur n'y regarde pas, pour ne jamais faire surgir une demande d'accès de macOS. Un
// dossier de confiance rangé là est recopié sans vérifier qu'il existe encore (il est déjà de confiance sur un compte).
const PROTECTED_IN_HOME = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music',
  'Library/Mobile Documents', 'Library/CloudStorage', 'Library/Containers', 'Library/Group Containers'];
const PROTECTED_ROOTS = ['/Volumes'];
const RETRY_MS = 60_000; // écriture refusée (verrou tenu, fichier qui bouge) : nouvel essai au plus tard dans 1 min

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fold = (p) => String(p).normalize('NFC').toLowerCase(); // disque du Mac : casse et forme Unicode ignorées
const under = (p, root) => { const a = fold(p), r = fold(root); return a === r || a.startsWith(`${r}/`); };

// Dossiers de confiance d'un .claude.json (même test que Claude Code : `=== true`).
export function trustedKeys(json) {
  const out = new Set();
  const projects = isObj(json) && isObj(json.projects) ? json.projects : {};
  for (const [k, v] of Object.entries(projects)) if (isObj(v) && v.hasTrustDialogAccepted === true) out.add(k);
  return out;
}

// La clé peut-elle passer d'un compte à l'autre ? Chemin absolu déjà propre, ni `/` ni le dossier perso, aucun
// caractère invisible. Ne regarde pas le disque.
export function shareable(k, { home, realHome = home } = {}) {
  if (typeof k !== 'string' || !k || k.length > 4096) return false;
  if (!path.isAbsolute(k) || path.resolve(k) !== k || k === '/') return false;
  if (UNSAFE.test(k)) return false;
  return ![home, realHome].some((h) => typeof h === 'string' && h && fold(path.resolve(h)) === fold(k));
}

// Le dossier existe-t-il ? Dans un dossier protégé par macOS, on ne regarde pas (voir PROTECTED_IN_HOME) : oui.
export function folderExists(p, { home, realHome = home } = {}) {
  const homes = [home, realHome].filter((h) => typeof h === 'string' && h);
  if (PROTECTED_ROOTS.some((r) => under(p, r)) || homes.some((h) => PROTECTED_IN_HOME.some((d) => under(p, path.join(h, d))))) return true;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Ajoute la confiance des `keys` à un .claude.json lu, comme Claude Code (`LS`) : entrée existante gardée telle quelle
// avec `hasTrustDialogAccepted: true`, sinon l'entrée par défaut. Renvoie le nouveau contenu, ou undefined s'il n'y a
// rien à changer. Forme inattendue : erreur, rien n'est écrit.
export function addTrust(data, keys) {
  if (!isObj(data)) throw new McpError('Fichier du compte de forme inattendue, rien n\'a été écrit');
  if (data.projects !== undefined && !isObj(data.projects)) throw new McpError('Liste des dossiers de forme inattendue, rien n\'a été écrit');
  const projects = data.projects || {};
  const next = { ...projects };
  let changed = false;
  for (const k of keys) {
    const e = projects[k];
    if (isObj(e) && e.hasTrustDialogAccepted === true) continue;
    next[k] = { ...(isObj(e) ? e : structuredClone(PROJECT_DEFAULTS)), hasTrustDialogAccepted: true };
    changed = true;
  }
  return changed ? { ...data, projects: next } : undefined;
}

// Ce qu'il faut écrire, sans rien toucher. `accounts` : [{ id, json } | { id, trusted: Set } | { id, missing: true }
// | { id, error: true }]. Renvoie { writes: Map<id, dossiers[]> } : à chaque compte lu, les dossiers de confiance sur
// un autre compte lu qui lui manquent, s'ils existent encore.
// - fichier absent : jamais créé ;
// - fichier illisible : rien n'y est écrit, et ses dossiers ne comptent pas (on ne les connaît pas).
export function planTrust({ accounts, home, realHome = home, isDir = (p) => folderExists(p, { home, realHome }) }) {
  const writes = new Map();
  if (!Array.isArray(accounts) || accounts.length < 2) return { writes };
  const opts = { home, realHome };
  const ok = new Map(); // compte lu → ses dossiers de confiance (partageables)
  for (const a of accounts) {
    if (!a || typeof a.id !== 'string' || a.missing || a.error) continue;
    const t = a.trusted instanceof Set ? a.trusted : trustedKeys(a.json);
    ok.set(a.id, new Set([...t].filter((k) => shareable(k, opts))));
  }
  // À recopier : de confiance sur un compte, absent d'un autre, et le dossier existe.
  const sets = [...ok.values()];
  const union = new Set(sets.flatMap((s) => [...s]));
  const wanted = [...union].filter((k) => sets.some((s) => !s.has(k))).filter((k) => isDir(k));
  for (const [id, s] of ok) {
    const missing = wanted.filter((k) => !s.has(k)).sort();
    if (missing.length) writes.set(id, missing);
  }
  return { writes };
}

// Le moteur : `accounts()` → [{ id, label, file }] (le .claude.json de chaque compte). `poll()` à chaque tour (4 s) :
// un stat par fichier, et un passage dès que l'un d'eux a changé ; `sync()` pour un passage tout de suite. Un seul
// passage à la fois. Les fichiers déjà lus ne sont relus que s'ils ont changé, et un compte qui a déjà tous les
// dossiers n'est pas réécrit.
export function createTrustSync({ home, accounts, log = () => {}, isDir, now = () => Date.now(), lockWaitMs = 5000, retryMs = RETRY_MS, _beforeRename } = {}) {
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch { /* dossier perso introuvable : on garde le chemin donné */ }
  const exists = isDir || ((p) => folderExists(p, { home, realHome }));
  const cache = new Map(); // fichier → { key, state }
  let running = null;
  let lastStamp = null; // empreinte des fichiers lue au début du dernier passage ; null : aucun passage encore
  let dirty = false, retryAt = 0;

  const list = () => {
    try { return (accounts() || []).filter((a) => a && typeof a.id === 'string' && typeof a.file === 'string'); } catch { return []; }
  };
  const statKey = (f) => {
    try { const s = fs.statSync(f); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (e) { return e?.code === 'ENOENT' ? 'absent' : 'illisible'; }
  };
  const stampOf = (l) => l.map((a) => `${a.id}\u0000${a.file}\u0000${statKey(a.file)}`).join('\n');

  function readAccount(a) {
    const key = statKey(a.file);
    if (key === 'absent') { cache.delete(a.file); return { id: a.id, missing: true }; }
    const c = cache.get(a.file);
    if (c && c.key === key) return { id: a.id, ...c.state };
    let state;
    try {
      const j = JSON.parse(fs.readFileSync(a.file, 'utf8'));
      state = isObj(j) && (j.projects === undefined || isObj(j.projects)) ? { trusted: trustedKeys(j) } : { error: true };
    } catch (e) { state = e?.code === 'ENOENT' ? { missing: true } : { error: true }; }
    cache.set(a.file, { key, state });
    return { id: a.id, ...state };
  }

  async function pass() {
    const l = list();
    const stamp = stampOf(l);
    if (l.length < 2) { lastStamp = stamp; dirty = false; return { changed: [], failed: false }; }
    const { writes } = planTrust({ accounts: l.map(readAccount), home, realHome, isDir: exists });
    const label = (id) => l.find((a) => a.id === id)?.label || id;
    const done = new Map(); // dossier → comptes qui l'ont reçu
    let failed = false;
    for (const [id, keys] of writes) {
      const a = l.find((x) => x.id === id);
      let r;
      try {
        r = await safeUpdateJson(a.file, (data) => addTrust(data, keys), {
          lock: true, lockWaitMs,
          verify: (j) => keys.every((k) => j?.projects?.[k]?.hasTrustDialogAccepted === true),
          _beforeRename,
        });
      } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
      if (!r.ok) { failed = true; log(`confiance des dossiers : ${label(id)} pas mis à jour (${r.error}), nouvel essai plus tard`); continue; }
      // relu et vérifié : le compte a maintenant ces dossiers (déjà là : Claude Code les a écrits entre-temps)
      if (r.changed !== false) for (const k of keys) done.set(k, [...(done.get(k) || []), label(id)]);
    }
    for (const [k, labels] of done) log(`confiance des dossiers recopiée : ${k} → ${labels.join(', ')}`);
    // Empreinte d'avant la lecture : nos propres écritures changent les fichiers, le tour suivant refait donc un
    // passage, qui n'a plus rien à écrire ; et rien de ce qui a bougé pendant ce passage n'est oublié.
    lastStamp = stamp;
    dirty = failed;
    if (failed) retryAt = now() + retryMs;
    return { changed: [...done.keys()], failed };
  }

  function sync() {
    if (running) return running;
    running = pass()
      .catch((e) => { dirty = true; retryAt = now() + retryMs; log(`confiance des dossiers : ${String(e?.message || e)}`); return { changed: [], failed: true }; })
      .finally(() => { running = null; });
    return running;
  }

  // À chaque tour : rien avant le premier passage (au démarrage, `sync()` le lance) ; ensuite, un passage si un
  // fichier a changé, ou si une écriture a échoué et que l'heure du nouvel essai est venue.
  function poll() {
    if (running || lastStamp === null) return null;
    if (stampOf(list()) !== lastStamp || (dirty && now() >= retryAt)) return sync();
    return null;
  }

  return { sync, poll };
}
