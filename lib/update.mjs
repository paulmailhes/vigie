// Vigie — mises à jour : la dernière version publiée sur GitHub (pas les préversions ni les brouillons : une version
// « pre-release » ne part chez personne), ses notes, et l'installation sans Terminal.
// L'installation lance install.sh de la version visée (il remplace tout sauf data/ et node/, relance le moteur et
// l'app) dans un processus détaché : le moteur est redémarré en cours de route, l'installation continue.
// data/update.json garde le dernier relevé, l'installation en cours et la version d'avant (écran « Quoi de neuf »).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const REPO = 'paulmailhes/vigie';
const CHECK_EVERY = 6 * 3600_000;
const RETRY_AFTER = 3600_000;          // une installation ratée n'est retentée qu'une heure plus tard
const INSTALL_TIMEOUT = 15 * 60_000;   // au-delà, l'installation est considérée comme ratée

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// > 0 si a est plus récente que b ; versions illisibles : égales (on ne propose rien).
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
const clean = (v) => parseVersion(v)?.join('.') ?? null;

export function createUpdater({ root, dataDir, repo = REPO, fetchImpl = globalThis.fetch, now = () => Date.now(), spawnImpl = spawn, bash = '/bin/bash' } = {}) {
  const FILE = path.join(dataDir, 'update.json');
  const LOG = path.join(dataDir, 'update.log');
  const read = () => { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const write = (j) => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n'); } catch { /* relevé suivant */ } };
  let checking = null;

  function current() {
    try { return clean(fs.readFileSync(path.join(root, 'VERSION'), 'utf8')); } catch { /* ancienne archive */ }
    try {
      const plist = fs.readFileSync(path.join(root, 'mac', 'Vigie.app', 'Contents', 'Info.plist'), 'utf8');
      return clean(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]);
    } catch { return null; }
  }

  // Versions publiées (sans préversions ni brouillons), de la plus récente à la plus ancienne.
  async function check({ force = false } = {}) {
    const j = read();
    if (!force && j.checkedAt && now() - Date.parse(j.checkedAt) < CHECK_EVERY) return status();
    if (checking) return checking;
    checking = (async () => {
      try {
        const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Vigie' }, signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`GitHub ${r.status}`);
        const list = await r.json();
        const releases = (Array.isArray(list) ? list : [])
          .filter((x) => x && !x.draft && !x.prerelease && clean(x.tag_name))
          .map((x) => ({ version: clean(x.tag_name), name: String(x.name || x.tag_name).slice(0, 120), notes: String(x.body || '').slice(0, 8000), publishedAt: x.published_at || null }))
          .sort((a, b) => compareVersions(b.version, a.version));
        write({ ...read(), checkedAt: new Date(now()).toISOString(), releases, error: null });
      } catch (e) {
        write({ ...read(), checkedAt: new Date(now()).toISOString(), error: String(e?.message || e).slice(0, 200) });
      } finally { checking = null; }
      return status();
    })();
    return checking;
  }

  function status() {
    const j = read();
    const cur = current();
    const releases = Array.isArray(j.releases) ? j.releases : [];
    const latest = releases[0]?.version ?? null;
    const available = !!(cur && latest && compareVersions(latest, cur) > 0);
    let installing = j.installing && now() - Date.parse(j.installing.startedAt) < INSTALL_TIMEOUT ? j.installing : null;
    // Installation finie : la version voulue tourne (le moteur vient d'être relancé par l'installeur).
    if (j.installing && cur && compareVersions(cur, j.installing.from) > 0) {
      write({ ...j, installing: null, previous: j.installing.from, installedAt: new Date(now()).toISOString(), lastError: null });
      installing = null;
    } else if (j.installing && !installing) {
      write({ ...j, installing: null, lastError: 'La mise à jour n\'a pas abouti.', failedAt: new Date(now()).toISOString() });
    }
    const k = read();
    return {
      current: cur, latest, available, installing: !!installing, checkedAt: k.checkedAt ?? null, error: k.error ?? null,
      lastError: k.lastError ?? null, previous: k.previous ?? null,
      // notes des versions plus récentes que celle d'avant la mise à jour (ou que la version installée)
      releases: releases.filter((x) => compareVersions(x.version, k.previous || cur || '0.0.0') > 0).slice(0, 10),
    };
  }

  // Lance l'installation de la dernière version (détachée : elle survit au redémarrage du moteur).
  function install() {
    const s = status();
    if (s.installing) return { ok: true, already: true };
    if (!s.available) return { ok: false, status: 409, error: 'Vigie est déjà à jour.' };
    const tag = `v${s.latest}`;
    const script = `https://raw.githubusercontent.com/${repo}/${tag}/install.sh`;
    const tarball = `https://github.com/${repo}/releases/download/${tag}/vigie.tar.gz`;
    let out;
    try { fs.mkdirSync(dataDir, { recursive: true }); out = fs.openSync(LOG, 'w'); } catch { out = 'ignore'; }
    try {
      const child = spawnImpl(bash, ['-c', 'set -o pipefail; t="$(mktemp)" && curl -fsSL "$VIGIE_SCRIPT" -o "$t" && bash "$t"; s=$?; rm -f "$t"; exit $s'], {
        detached: true, stdio: ['ignore', out, out],
        env: { ...process.env, VIGIE_SCRIPT: script, VIGIE_TARBALL: tarball, VIGIE_HOME: root, VIGIE_UPDATE: '1' },
      });
      child.unref?.();
    } catch (e) {
      return { ok: false, status: 500, error: `Mise à jour impossible : ${String(e?.message || e).slice(0, 200)}` };
    } finally { if (typeof out === 'number') try { fs.closeSync(out); } catch { /* rien */ } }
    write({ ...read(), installing: { version: s.latest, from: s.current, startedAt: new Date(now()).toISOString() }, lastError: null });
    return { ok: true, version: s.latest };
  }

  // Mise à jour automatique : seulement si rien n'attend l'utilisateur, et pas plus d'un essai par heure.
  async function tick({ auto, busy }) {
    const s = await check();
    if (!auto || busy || !s.available || s.installing) return s;
    const j = read();
    if (j.failedAt && now() - Date.parse(j.failedAt) < RETRY_AFTER) return s;
    install();
    return status();
  }

  return { current, check, status, install, tick, file: FILE };
}
