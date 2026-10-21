import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater, compareVersions } from '../lib/update.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-update-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

function setup(version, releases, { fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'x-'));
  const root = path.join(dir, 'vigie'), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (version) fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  let fetches = 0;
  const spawned = [];
  let clock = Date.parse('2026-10-21T14:00:00Z');
  const u = createUpdater({
    root, dataDir: data, now: () => clock,
    fetchImpl: async (url) => { fetches++; if (fail) return { ok: false, status: 403 }; assert.match(url, /api\.github\.com\/repos\/paulmailhes\/vigie\/releases/); return { ok: true, json: async () => releases }; },
    spawnImpl: (bin, args, opts) => { spawned.push({ bin, args, env: opts.env, detached: opts.detached }); return { unref() {} }; },
  });
  return { u, root, data, spawned, fetches: () => fetches, advance: (ms) => { clock += ms; }, setVersion: (v) => fs.writeFileSync(path.join(root, 'VERSION'), `${v}\n`) };
}
const rel = (v, extra = {}) => ({ tag_name: `v${v}`, name: `Vigie ${v} (bêta)`, body: `Notes ${v}`, published_at: '2026-10-21T13:00:00Z', draft: false, prerelease: false, ...extra });

test('versions : comparaison', () => {
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.2.6', '0.2.6'), 0);
  assert.equal(compareVersions('abc', '0.2.6'), 0, 'illisible : rien proposé');
});

test('mise à jour proposée : dernière version publiée, ni préversion ni brouillon ; relevé espacé de 6 h', async () => {
  const t = setup('0.2.6', [rel('0.2.9', { prerelease: true }), rel('0.2.8', { draft: true }), rel('0.2.7'), rel('0.2.6'), rel('0.2.5')]);
  const s = await t.u.check();
  assert.deepEqual([s.current, s.latest, s.available, s.installing], ['0.2.6', '0.2.7', true, false]);
  assert.deepEqual(s.releases.map((r) => r.version), ['0.2.7'], 'seulement les notes plus récentes');
  assert.equal(s.releases[0].notes, 'Notes 0.2.7');
  await t.u.check();
  assert.equal(t.fetches(), 1, 'pas de nouveau relevé avant 6 h');
  t.advance(6 * 3600_000 + 1);
  await t.u.check();
  assert.equal(t.fetches(), 2);
});

test('installer : install.sh et archive de la version visée, détaché ; fini quand la nouvelle version tourne, notes gardées', async () => {
  const t = setup('0.2.6', [rel('0.2.7'), rel('0.2.6')]);
  await t.u.check();
  const r = t.u.install();
  assert.deepEqual([r.ok, r.version], [true, '0.2.7']);
  assert.equal(t.spawned.length, 1);
  const sp = t.spawned[0];
  assert.equal(sp.detached, true, 'survit au redémarrage du moteur');
  assert.equal(sp.env.VIGIE_SCRIPT, 'https://raw.githubusercontent.com/paulmailhes/vigie/v0.2.7/install.sh');
  assert.equal(sp.env.VIGIE_TARBALL, 'https://github.com/paulmailhes/vigie/releases/download/v0.2.7/vigie.tar.gz');
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
  assert.equal(t.spawned.length, 1);
  // l'installation n'aboutit pas (15 min sans nouvelle version)
  t.advance(16 * 60_000);
  assert.equal(t.u.status().lastError, 'La mise à jour n\'a pas abouti.');
  await t.u.tick({ auto: true, busy: false });
  assert.equal(t.spawned.length, 1, 'pas de nouvel essai avant une heure');
  t.advance(61 * 60_000);
  await t.u.tick({ auto: true, busy: false });
  assert.equal(t.spawned.length, 2);
});

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
