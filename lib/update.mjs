// Vigie — mises à jour : la dernière version publiée sur GitHub (pas les préversions ni les brouillons : une version
// « pre-release » ne part chez personne), ses notes, et l'installation sans Terminal.
// L'installation ne fait confiance qu'à la signature d'Apple, jamais à GitHub seul : le moteur télécharge l'archive de
// la version visée, vérifie que son app est signée par l'équipe de Vigie (Developer ID, TEAM_ID), acceptée par
// Gatekeeper (notarisée) et bien de cette version, puis lance le bootstrap.sh du moteur scellé dans cette app
// (Contents/Resources/engine, couvert par la signature). Un dépôt ou un compte GitHub piraté ne peut donc rien faire
// exécuter sans le certificat de l'équipe. Le bootstrap tourne détaché : il relance le moteur en cours de route.
// data/update.json garde le dernier relevé, l'installation en cours et la version d'avant (écran « Quoi de neuf »).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export const REPO = 'paulmailhes/vigie';
// Équipe Apple qui signe l'app (une copie du projet publiée par quelqu'un d'autre change cette valeur).
export const TEAM_ID = 'CQ43U6XX4Z';
const CHECK_EVERY = 3600_000; // une fois par heure : une correction arrive vite, GitHub accepte 60 relevés par heure
const RETRY_AFTER = 3600_000;          // une installation ratée n'est retentée qu'une heure plus tard
const INSTALL_TIMEOUT = 15 * 60_000;   // au-delà, l'installation est considérée comme ratée
const MAX_ARCHIVE = 200 * 1024 * 1024; // l'archive fait ~6 Mo : au-delà, ce n'est pas la nôtre
const BINS = { tar: '/usr/bin/tar', codesign: '/usr/bin/codesign', spctl: '/usr/sbin/spctl' };

function run(bin, args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` }));
  });
}
const plistVersion = (file) => {
  try { return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null; } catch { return null; }
};

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

export function createUpdater({
  root, dataDir, repo = REPO, fetchImpl = globalThis.fetch, now = () => Date.now(), spawnImpl = spawn, bash = '/bin/bash',
  teamId = TEAM_ID, bins = BINS, tmpRoot = os.tmpdir(),
} = {}) {
  const FILE = path.join(dataDir, 'update.json');
  const LOG = path.join(dataDir, 'update.log');
  // Installation depuis les sources (clone git) : jamais de mise à jour par ici, elle effacerait .git et le travail en
  // cours ; on met à jour avec git pull.
  const fromSources = fs.existsSync(path.join(root, '.git'));
  const read = () => { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const write = (j) => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 }); } catch { /* relevé suivant */ } };
  let checking = null;

  function current() {
    try { return clean(fs.readFileSync(path.join(root, 'VERSION'), 'utf8')); } catch { /* ancienne archive */ }
    return clean(plistVersion(path.join(root, 'mac', 'Vigie.app', 'Contents', 'Info.plist')));
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
    const available = !fromSources && !!(cur && latest && compareVersions(latest, cur) > 0);
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
      // une erreur ne vaut que tant qu'une version attend (mise à jour faite autrement : plus rien à signaler)
      lastError: available ? (k.lastError ?? null) : null, previous: k.previous ?? null,
      // notes des versions plus récentes que celle d'avant la mise à jour (ou que la version installée)
      releases: releases.filter((x) => compareVersions(x.version, k.previous || cur || '0.0.0') > 0).slice(0, 10),
    };
  }

  // Télécharge et vérifie la version visée ; rend l'app vérifiée et son moteur scellé, ou lève une erreur lisible.
  async function prepare(version) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'vigie-maj-'));
    try {
      const url = `https://github.com/${repo}/releases/download/v${version}/vigie.tar.gz`;
      const r = await fetchImpl(url, { headers: { 'User-Agent': 'Vigie' }, redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
      if (!r.ok) throw new Error(`téléchargement refusé par GitHub (${r.status})`);
      if (Number(r.headers?.get?.('content-length') || 0) > MAX_ARCHIVE) throw new Error('archive trop grosse');
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > MAX_ARCHIVE) throw new Error('archive trop grosse');
      const tgz = path.join(dir, 'vigie.tar.gz');
      fs.writeFileSync(tgz, bytes, { mode: 0o600 });
      const x = path.join(dir, 'x');
      fs.mkdirSync(x);
      // -p : les droits de l'archive (le moteur tourne en umask 077, l'app doit rester ouvrable par tous les comptes)
      if (!(await run(bins.tar, ['-xpzf', tgz, '-C', x])).ok) throw new Error('archive illisible');
      const app = path.join(x, 'mac', 'Vigie.app');
      const engine = path.join(app, 'Contents', 'Resources', 'engine');
      if (!fs.existsSync(path.join(engine, 'scripts', 'bootstrap.sh'))) throw new Error('archive incomplète');
      if (!(await run(bins.codesign, ['--verify', '--deep', '--strict', app])).ok) throw new Error('signature de l\'app invalide');
      const sig = (await run(bins.codesign, ['-dv', '--verbose=2', app])).out;
      if (!sig.split('\n').includes(`TeamIdentifier=${teamId}`) || !/^Authority=Developer ID Application: /m.test(sig)) {
        throw new Error('app signée par quelqu\'un d\'autre que l\'équipe de Vigie');
      }
      if (!(await run(bins.spctl, ['--assess', '--type', 'execute', app])).ok) throw new Error('app refusée par Gatekeeper');
      if (clean(plistVersion(path.join(app, 'Contents', 'Info.plist'))) !== version) throw new Error('version de l\'app inattendue');
      return { dir, app, engine };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  // Lance le bootstrap du moteur vérifié, détaché : il survit au redémarrage du moteur.
  function launch({ dir, app, engine }) {
    let out;
    try { fs.mkdirSync(dataDir, { recursive: true }); out = fs.openSync(LOG, 'w', 0o600); } catch { out = 'ignore'; }
    try {
      // umask 022 : l'installation (copie de l'app dans Applications, moteur) ne prend pas l'umask privé du moteur
      const child = spawnImpl(bash, ['-c', 'umask 022; bash "$VIGIE_BOOTSTRAP"; s=$?; rm -rf "$VIGIE_TMP"; exit $s'], {
        detached: true, stdio: ['ignore', out, out],
        env: { ...process.env, VIGIE_BOOTSTRAP: path.join(engine, 'scripts', 'bootstrap.sh'), VIGIE_NEW_APP: app, VIGIE_TMP: dir, VIGIE_HOME: root, VIGIE_UPDATE: '1' },
      });
      child.unref?.();
    } finally { if (typeof out === 'number') try { fs.closeSync(out); } catch { /* rien */ } }
  }

  // Lance l'installation de la dernière version : téléchargement et vérification ici, puis bootstrap détaché.
  let preparing = null;
  function install() {
    const s = status();
    if (s.installing || preparing) return { ok: true, already: true };
    if (fromSources) return { ok: false, status: 409, error: 'Installation depuis les sources : mets-la à jour avec git pull.' };
    if (!s.available) return { ok: false, status: 409, error: 'Vigie est déjà à jour.' };
    write({ ...read(), installing: { version: s.latest, from: s.current, startedAt: new Date(now()).toISOString() }, lastError: null });
    preparing = prepare(s.latest)
      .then(launch)
      .catch((e) => {
        write({ ...read(), installing: null, lastError: `Mise à jour non installée : ${String(e?.message || e).slice(0, 200)}. Vigie réessaiera dans une heure.`, failedAt: new Date(now()).toISOString() });
      })
      .finally(() => { preparing = null; });
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

  return { current, check, status, install, tick, file: FILE, settled: () => preparing || Promise.resolve() };
}
