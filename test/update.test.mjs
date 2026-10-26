import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUpdater, compareVersions } from '../lib/update.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-update-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// Archive de version : l'app (Info.plist) et le moteur scellé dedans, comme celle de scripts/release.sh.
function archive(version, { appVersion = version } = {}) {
  const src = fs.mkdtempSync(path.join(TMP, 'archive-'));
  const app = path.join(src, 'mac', 'Vigie.app', 'Contents');
  fs.mkdirSync(path.join(app, 'Resources', 'engine', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key>\n<string>${appVersion}</string></dict></plist>`);
  fs.writeFileSync(path.join(app, 'Resources', 'engine', 'scripts', 'bootstrap.sh'), '#!/bin/bash\n');
  const tgz = path.join(TMP, `vigie-${version}-${path.basename(src)}.tar.gz`);
  execFileSync('/usr/bin/tar', ['-czf', tgz, '-C', src, 'mac']);
  return fs.readFileSync(tgz);
}
// Faux codesign / spctl : signature valide de l'équipe de Vigie, sauf réglage contraire.
function fakeBin(name, body) {
  const p = path.join(TMP, `${name}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return p;
}
const codesignOk = (team = 'CQ43U6XX4Z', verify = 0) => fakeBin('codesign',
  `if [ "$1" = "--verify" ]; then exit ${verify}; fi\necho "Authority=Developer ID Application: Equipe (${team})" >&2\necho "TeamIdentifier=${team}" >&2`);

function setup(version, releases, { fail = false, tarball = null, codesign = codesignOk(), spctl = fakeBin('spctl', 'exit 0') } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'x-'));
  const root = path.join(dir, 'vigie'), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const tmpRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tmpRoot);
  if (version) fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  let fetches = 0;
  const downloads = [];
  const spawned = [];
  let clock = Date.parse('2026-10-21T14:00:00Z');
  const latest = releases.find((r) => !r.draft && !r.prerelease)?.tag_name?.slice(1);
  const bytes = tarball ?? (latest ? archive(latest) : null);
  const u = createUpdater({
    root, dataDir: data, now: () => clock, tmpRoot, bins: { tar: '/usr/bin/tar', codesign, spctl },
    fetchImpl: async (url) => {
      if (/\/releases\/download\//.test(url)) {
        downloads.push(url);
        return { ok: true, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
      }
      fetches++; if (fail) return { ok: false, status: 403 }; assert.match(url, /api\.github\.com\/repos\/paulmailhes\/vigie\/releases/); return { ok: true, json: async () => releases };
    },
    spawnImpl: (bin, args, opts) => { spawned.push({ bin, args, env: opts.env, detached: opts.detached }); return { unref() {} }; },
  });
  return { u, root, data, tmpRoot, spawned, downloads, fetches: () => fetches, advance: (ms) => { clock += ms; }, setVersion: (v) => fs.writeFileSync(path.join(root, 'VERSION'), `${v}\n`) };
}
const rel = (v, extra = {}) => ({ tag_name: `v${v}`, name: `Vigie ${v} (bêta)`, body: `Notes ${v}`, published_at: '2026-10-21T13:00:00Z', draft: false, prerelease: false, ...extra });

test('versions : comparaison', () => {
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.2.6', '0.2.6'), 0);
  assert.equal(compareVersions('abc', '0.2.6'), 0, 'illisible : rien proposé');
});

test('mise à jour proposée : dernière version publiée, ni préversion ni brouillon ; un relevé par heure', async () => {
  const t = setup('0.2.6', [rel('0.2.9', { prerelease: true }), rel('0.2.8', { draft: true }), rel('0.2.7'), rel('0.2.6'), rel('0.2.5')]);
  const s = await t.u.check();
  assert.deepEqual([s.current, s.latest, s.available, s.installing], ['0.2.6', '0.2.7', true, false]);
  assert.deepEqual(s.releases.map((r) => r.version), ['0.2.7'], 'seulement les notes plus récentes');
  assert.equal(s.releases[0].notes, 'Notes 0.2.7');
  await t.u.check();
  assert.equal(t.fetches(), 1, 'pas de nouveau relevé avant une heure');
  t.advance(3600_000 + 1);
  await t.u.check();
  assert.equal(t.fetches(), 2);
});

test('installer : archive de la version visée vérifiée, puis bootstrap du moteur scellé dans l\'app, détaché ; fini quand la nouvelle version tourne', async () => {
  const t = setup('0.2.6', [rel('0.2.7'), rel('0.2.6')]);
  await t.u.check();
  const r = t.u.install();
  assert.deepEqual([r.ok, r.version], [true, '0.2.7']);
  assert.deepEqual(t.u.install(), { ok: true, already: true }, 'pas deux installations');
  await t.u.settled();
  assert.deepEqual(t.downloads, ['https://github.com/paulmailhes/vigie/releases/download/v0.2.7/vigie.tar.gz']);
  assert.equal(t.spawned.length, 1);
  const sp = t.spawned[0];
  assert.equal(sp.detached, true, 'survit au redémarrage du moteur');
  assert.equal(sp.env.VIGIE_SCRIPT, undefined, 'plus aucun script téléchargé à part');
  assert.match(sp.env.VIGIE_BOOTSTRAP, /mac\/Vigie\.app\/Contents\/Resources\/engine\/scripts\/bootstrap\.sh$/, 'le moteur scellé dans l\'app vérifiée');
  assert.ok(fs.existsSync(sp.env.VIGIE_BOOTSTRAP));
  assert.match(sp.env.VIGIE_NEW_APP, /mac\/Vigie\.app$/);
  assert.equal(sp.env.VIGIE_HOME, t.root);
  assert.equal(sp.env.VIGIE_UPDATE, '1');
  assert.equal(t.u.status().installing, true);
  assert.deepEqual(t.u.install(), { ok: true, already: true }, 'pas deux installations');
  // l'installeur a remplacé Vigie et relancé le moteur
  t.setVersion('0.2.7');
  const s = t.u.status();
  assert.deepEqual([s.current, s.available, s.installing, s.previous], ['0.2.7', false, false, '0.2.6']);
  assert.deepEqual(s.releases.map((x) => x.version), ['0.2.7'], 'notes de ce qui vient d\'arriver (écran « Quoi de neuf »)');
  assert.equal(t.u.install().status, 409, 'déjà à jour');
});

test('automatique : seulement si activé et si rien n\'attend ; échec retenté une heure plus tard', async () => {
  const t = setup('0.2.6', [rel('0.2.7')]);
  await t.u.tick({ auto: false, busy: false });
  await t.u.tick({ auto: true, busy: true });
  assert.equal(t.spawned.length, 0, 'désactivé, ou une décision attend : rien');
  await t.u.tick({ auto: true, busy: false });
  await t.u.settled();
  assert.equal(t.spawned.length, 1);
  // l'installation n'aboutit pas (15 min sans nouvelle version)
  t.advance(16 * 60_000);
  assert.equal(t.u.status().lastError, 'La mise à jour n\'a pas abouti.');
  await t.u.tick({ auto: true, busy: false });
  await t.u.settled();
  assert.equal(t.spawned.length, 1, 'pas de nouvel essai avant une heure');
  t.advance(61 * 60_000);
  await t.u.tick({ auto: true, busy: false });
  await t.u.settled();
  assert.equal(t.spawned.length, 2);
});

// Un dépôt GitHub piraté ne fait rien exécuter : sans la signature de l'équipe et l'accord de Gatekeeper, rien ne part.
for (const [what, opts, why] of [
  ['signée par une autre équipe', { codesign: codesignOk('AUTRE12345') }, /quelqu'un d'autre que l'équipe de Vigie/],
  ['signature invalide (fichier modifié après signature)', { codesign: codesignOk('CQ43U6XX4Z', 1) }, /signature de l'app invalide/],
  ['refusée par Gatekeeper (non notarisée)', { spctl: fakeBin('spctl', 'exit 3') }, /refusée par Gatekeeper/],
  ['app d\'une autre version que celle annoncée', { tarball: archive('0.2.7', { appVersion: '0.2.5' }) }, /version de l'app inattendue/],
  ['archive sans moteur scellé', { tarball: Buffer.from('pas une archive') }, /archive illisible|archive incomplète/],
]) {
  test(`mise à jour refusée : ${what}`, async () => {
    const t = setup('0.2.6', [rel('0.2.7')], opts);
    await t.u.check();
    assert.equal(t.u.install().ok, true);
    await t.u.settled();
    assert.equal(t.spawned.length, 0, 'rien n\'est lancé');
    const s = t.u.status();
    assert.equal(s.installing, false);
    assert.match(s.lastError, why);
    assert.match(s.lastError, /réessaiera dans une heure/);
    assert.deepEqual(fs.readdirSync(t.tmpRoot), [], 'dossier temporaire effacé');
  });
}

test('GitHub injoignable : rien proposé, erreur notée ; sans VERSION, version lue dans l\'app', async () => {
  const t = setup('0.2.6', [], { fail: true });
  const s = await t.u.check();
  assert.deepEqual([s.available, s.latest], [false, null]);
  assert.match(s.error, /GitHub 403/);
  const t2 = setup(null, [rel('0.2.7')]);
  fs.mkdirSync(path.join(t2.root, 'mac', 'Vigie.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(t2.root, 'mac', 'Vigie.app', 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.2.5</string></dict></plist>');
  assert.equal(t2.u.current(), '0.2.5');
  assert.equal((await t2.u.check()).available, true);
});

test('installation depuis les sources (clone git) : aucune mise à jour proposée ni lancée ; erreur périmée effacée', async () => {
  const t = setup('0.2.6', [rel('0.2.7')]);
  fs.mkdirSync(path.join(t.root, '.git'));
  const u = createUpdater({ root: t.root, dataDir: t.data, fetchImpl: async () => ({ ok: true, json: async () => [rel('0.2.7')] }), spawnImpl: () => { throw new Error('jamais'); } });
  const s = await u.check({ force: true });
  assert.equal(s.available, false, 'pas de mise à jour pour un clone');
  assert.equal(u.install().status, 409);
  const t2 = setup('0.2.6', [rel('0.2.7')]);
  fs.writeFileSync(path.join(t2.data, 'update.json'), JSON.stringify({ lastError: 'Mise à jour non installée : x.', releases: [{ version: '0.2.7' }] }));
  t2.setVersion('0.2.7');
  assert.equal(t2.u.status().lastError, null, 'à jour par un autre chemin : plus d\'erreur affichée');
});
