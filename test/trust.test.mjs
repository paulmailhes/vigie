// Tests de la confiance des dossiers recopiée d'un compte à l'autre (lib/trust.mjs) : node --test test/
// Tout vit dans un dossier temporaire avec des espaces (faux ~, faux ~/Code, faux dossiers de comptes, données de
// Vigie) : aucun vrai .claude.json n'est lu ni écrit, aucun Claude n'est lancé.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie confiance-')));
process.env.VIGIE_DATA = path.join(TMP, 'data vigie');
const { planTrust, createTrustSync, addTrust, trustedKeys, shareable, folderExists, UNSAFE } = await import('../lib/trust.mjs');
const { PROJECT_DEFAULTS } = await import('../lib/mcp.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HOME = path.join(TMP, 'maison alex');
const CODE = path.join(HOME, 'Code');
const dir = (name) => { const p = path.join(CODE, name); fs.mkdirSync(p, { recursive: true }); return p; };
const write = (f, data, mode) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(f, mode);
};
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const trusted = (f, k) => readJ(f).projects?.[k]?.hasTrustDialogAccepted === true;
const setTrust = (f, k, v = true) => { const j = readJ(f); j.projects ||= {}; j.projects[k] = { ...(j.projects[k] || {}), hasTrustDialogAccepted: v }; write(f, j); };
const unset = (f, k) => { const j = readJ(f); delete j.projects[k]; write(f, j); };

const VIGIE = dir('vigie');
const ATELIER = dir('atelier');
const NOTES = dir('notes');
dir('notes/docs');

// Un décor par essai : un compte du Mac (~/.claude.json) et deux comptes de Vigie, chacun avec son .claude.json. Rien
// d'autre n'est écrit dans le décor (Vigie ne garde aucune mémoire de la confiance).
let n = 0;
function decor(ids = ['travail1', 'perso', 'pro']) {
  const root = path.join(TMP, `décor ${++n}`);
  const accounts = ids.map((id) => ({ id, label: `Compte ${id}`, file: path.join(root, 'comptes', id, '.claude.json') }));
  for (const a of accounts) write(a.file, { numStartups: 3, oauthAccount: { emailAddress: `${a.id}@exemple.test` }, projects: {} }, 0o600);
  const logs = [];
  const list = { current: accounts };
  const make = (opts = {}) => createTrustSync({ home: HOME, accounts: () => list.current, log: (m) => logs.push(m), ...opts });
  const file = (id) => accounts.find((a) => a.id === id).file;
  const onlyAccounts = () => assert.deepEqual(fs.readdirSync(root), ['comptes'], 'rien d\'écrit hors des fichiers des comptes');
  return { root, accounts, list, logs, make, file, onlyAccounts };
}

describe('règles', () => {
  test('un dossier de confiance sur un compte est ajouté aux autres, et seulement lui', () => {
    const plan = planTrust({
      home: HOME,
      accounts: [
        { id: 'a', json: { projects: { [VIGIE]: { hasTrustDialogAccepted: true }, [NOTES]: { hasTrustDialogAccepted: true } } } },
        { id: 'b', json: { projects: { [VIGIE]: { allowedTools: ['Bash(ls)'], hasTrustDialogAccepted: false }, [NOTES]: { hasTrustDialogAccepted: true } } } },
        { id: 'c', json: { oauthAccount: {} } },
      ],
    });
    assert.deepEqual([...plan.writes], [['b', [VIGIE]], ['c', [NOTES, VIGIE].sort()]]);
    // pas d'héritage : un sous-dossier (pas un dépôt git) d'un dossier de confiance n'est jamais ajouté
    assert.ok(![...plan.writes.values()].flat().includes(path.join(NOTES, 'docs')));
  });

  test('écriture comme Claude Code : entrée existante gardée, entrée neuve = valeurs par défaut', () => {
    const data = { numStartups: 3, projects: { [VIGIE]: { allowedTools: ['Bash(ls)'], mcpServers: { x: { type: 'http', url: 'https://x.test' } }, hasTrustDialogAccepted: false, lastSessionId: 'abc' } }, theme: 'dark' };
    const next = addTrust(data, [VIGIE, ATELIER]);
    assert.deepEqual(next.projects[VIGIE], { allowedTools: ['Bash(ls)'], mcpServers: { x: { type: 'http', url: 'https://x.test' } }, hasTrustDialogAccepted: true, lastSessionId: 'abc' });
    assert.deepEqual(next.projects[ATELIER], { ...PROJECT_DEFAULTS, hasTrustDialogAccepted: true });
    assert.deepEqual(Object.keys(next), ['numStartups', 'projects', 'theme'], 'ordre des clés gardé');
    assert.equal(data.projects[VIGIE].hasTrustDialogAccepted, false, 'l\'original n\'est pas modifié');
    assert.equal(PROJECT_DEFAULTS.hasTrustDialogAccepted, false, 'les valeurs par défaut ne sont pas modifiées');
    assert.equal(addTrust({ projects: { [VIGIE]: { hasTrustDialogAccepted: true } } }, [VIGIE]), undefined, 'déjà là : rien à écrire');
    assert.deepEqual(addTrust({}, [VIGIE]).projects, { [VIGIE]: { ...PROJECT_DEFAULTS, hasTrustDialogAccepted: true } });
    assert.throws(() => addTrust([], [VIGIE]));
    assert.throws(() => addTrust({ projects: [] }, [VIGIE]));
  });

  test('un dossier de confiance sur aucun compte n\'est jamais ajouté', () => {
    const plan = planTrust({
      home: HOME,
      accounts: [
        { id: 'a', json: { projects: { [VIGIE]: { hasTrustDialogAccepted: false }, [ATELIER]: { hasTrustDialogAccepted: 'true' }, [NOTES]: { hasTrustDialogAccepted: 1 } } } },
        { id: 'b', json: { projects: { [VIGIE]: {} } } },
      ],
    });
    assert.equal(plan.writes.size, 0);
  });

  test('dossier perso, /, chemin relatif ou pas propre, caractère invisible, dossier absent : ignorés', () => {
    const gone = path.join(CODE, 'disparu');
    const keys = [HOME, HOME.toUpperCase(), '/', 'Code/vigie', `${VIGIE}/`, `${VIGIE}/../vigie`, `${CODE}/a​b`, `${CODE}/a b`,
      `${CODE}/a\nb`, `${CODE}/a‮b`, gone, '__proto__'];
    for (const k of keys.slice(0, 11)) assert.equal(shareable(k, { home: HOME }) && folderExists(k, { home: HOME }), false, k);
    const json = { projects: Object.fromEntries(keys.map((k) => [k, { hasTrustDialogAccepted: true }])) };
    const plan = planTrust({ home: HOME, accounts: [{ id: 'a', json }, { id: 'b', json: { projects: {} } }] });
    assert.equal(plan.writes.size, 0);
    // le même test que Claude Code pour les caractères invisibles ; une espace ordinaire et les accents passent
    assert.equal(UNSAFE.test(`${CODE}/mon projet été`), false);
    assert.ok(shareable(path.join(CODE, 'mon projet été'), { home: HOME }));
  });

  test('dossiers protégés par macOS (Documents, iCloud Drive, disques externes) : jamais regardés, comptés comme présents', () => {
    for (const p of [path.join(HOME, 'Documents', 'cabinet'), path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x'),
      path.join(HOME, 'desktop', 'y'), '/Volumes/Disque/z']) assert.equal(folderExists(p, { home: HOME }), true, p);
    assert.equal(folderExists(path.join(CODE, 'absent'), { home: HOME }), false);
    assert.equal(folderExists(path.join(HOME, 'Documentsx', 'a'), { home: HOME }), false, 'seulement le dossier lui-même et ce qu\'il contient');
    assert.equal(folderExists(VIGIE, { home: HOME }), true);
    fs.writeFileSync(path.join(CODE, 'fichier'), '');
    assert.equal(folderExists(path.join(CODE, 'fichier'), { home: HOME }), false, 'un fichier n\'est pas un dossier');
  });

  test('un seul compte : rien', () => {
    const plan = planTrust({ home: HOME, accounts: [{ id: 'a', json: { projects: { [VIGIE]: { hasTrustDialogAccepted: true } } } }] });
    assert.deepEqual(plan, { writes: new Map() });
  });

  test('fichier absent : jamais créé ; fichier illisible : rien n\'y est écrit', () => {
    const plan = planTrust({
      home: HOME,
      accounts: [{ id: 'a', trusted: new Set([VIGIE]) }, { id: 'b', missing: true }, { id: 'c', error: true }, { id: 'd', json: {} }],
    });
    assert.deepEqual([...plan.writes], [['d', [VIGIE]]]);
  });

  test('union pure : un dossier de confiance sur un seul compte suffit, rien ne l\'en empêche', () => {
    // un compte qui ne l'a pas (jamais accepté, ou retiré sur ce compte seulement) le reçoit quand même
    const plan = planTrust({
      home: HOME,
      accounts: [{ id: 'a', trusted: new Set([VIGIE, NOTES]) }, { id: 'b', trusted: new Set([NOTES]) }, { id: 'c', trusted: new Set([ATELIER]) }],
    });
    assert.deepEqual([...plan.writes], [['a', [ATELIER]], ['b', [ATELIER, VIGIE].sort()], ['c', [NOTES, VIGIE].sort()]]);
    // de confiance sur tous les comptes : rien à écrire
    const all = new Set([VIGIE, NOTES]);
    assert.equal(planTrust({ home: HOME, accounts: [{ id: 'a', trusted: all }, { id: 'b', trusted: all }] }).writes.size, 0);
  });

  test('lecture des dossiers de confiance : seulement `true`', () => {
    assert.deepEqual([...trustedKeys({ projects: { '/a': { hasTrustDialogAccepted: true }, '/b': { hasTrustDialogAccepted: false }, '/c': null, '/d': 'x' } })], ['/a']);
    assert.deepEqual([...trustedKeys(null)], []);
    assert.deepEqual([...trustedKeys({ projects: [] })], []);
  });
});

describe('moteur', () => {
  test('recopie dans les fichiers : mêmes droits, autres champs gardés, aucune mémoire, journal', async () => {
    const d = decor();
    setTrust(d.file('perso'), VIGIE);
    write(d.file('pro'), { ...readJ(d.file('pro')), projects: { [VIGIE]: { allowedTools: ['Bash(npm test)'], hasTrustDialogAccepted: false } } }, 0o600);
    const r = await d.make().sync();
    assert.deepEqual(r, { changed: [VIGIE], failed: false });
    assert.ok(trusted(d.file('travail1'), VIGIE) && trusted(d.file('pro'), VIGIE));
    assert.deepEqual(readJ(d.file('pro')).projects[VIGIE], { allowedTools: ['Bash(npm test)'], hasTrustDialogAccepted: true });
    assert.equal(readJ(d.file('travail1')).numStartups, 3);
    assert.deepEqual(readJ(d.file('travail1')).projects[VIGIE], { ...PROJECT_DEFAULTS, hasTrustDialogAccepted: true });
    for (const a of d.accounts) assert.equal(fs.statSync(a.file).mode & 0o777, 0o600, `${a.id} garde ses droits`);
    assert.ok(fs.readFileSync(d.file('travail1'), 'utf8').endsWith('}\n'));
    assert.deepEqual(d.logs, [`confiance des dossiers recopiée : ${VIGIE} → Compte travail1, Compte pro`]);
    assert.equal(fs.readdirSync(path.dirname(d.file('pro'))).length, 1, 'aucun fichier temporaire laissé');
    d.onlyAccounts();
    // le passage suivant n'a plus rien à écrire : aucun fichier réécrit
    const before = d.accounts.map((a) => fs.statSync(a.file).mtimeMs);
    assert.deepEqual(await d.make().sync(), { changed: [], failed: false });
    assert.deepEqual(d.accounts.map((a) => fs.statSync(a.file).mtimeMs), before);
  });

  test('un seul compte : aucun fichier lu ni écrit, aucune mémoire', async () => {
    const d = decor(['travail1']);
    setTrust(d.file('travail1'), VIGIE);
    const before = fs.readFileSync(d.file('travail1'), 'utf8');
    const r = await d.make().sync();
    assert.deepEqual(r, { changed: [], failed: false });
    assert.equal(fs.readFileSync(d.file('travail1'), 'utf8'), before);
    d.onlyAccounts();
    assert.deepEqual(d.logs, []);
  });

  test('compte sans fichier : non créé ; JSON invalide : laissé tel quel ; les autres reçoivent quand même', async () => {
    const d = decor(['travail1', 'perso', 'neuf', 'casse']);
    fs.rmSync(d.file('neuf'));
    write(d.file('casse'), '{ "projects": { pas du json');
    setTrust(d.file('perso'), ATELIER);
    const r = await d.make().sync();
    assert.equal(r.failed, false);
    assert.equal(fs.existsSync(d.file('neuf')), false);
    assert.equal(fs.readFileSync(d.file('casse'), 'utf8'), '{ "projects": { pas du json');
    assert.ok(trusted(d.file('travail1'), ATELIER));
  });

  test('sans mémoire de retrait : retirée sur un compte, la confiance revient tant qu\'un autre l\'a ; retirée partout, plus rien', async () => {
    const d = decor();
    const sync = d.make();
    setTrust(d.file('perso'), VIGIE);
    await sync.sync();
    assert.ok(d.accounts.every((a) => trusted(a.file, VIGIE)));
    // la trace disparaît du compte du Mac : recopiée de nouveau depuis les autres. Sinon la question reviendrait à
    // chaque fenêtre, et un nouveau « Trust folder » n'y changerait rien : il s'enregistre sur le compte de la
    // conversation, qui l'a déjà.
    unset(d.file('travail1'), VIGIE);
    assert.deepEqual(await sync.sync(), { changed: [VIGIE], failed: false });
    assert.ok(trusted(d.file('travail1'), VIGIE));
    assert.equal(d.logs.at(-1), `confiance des dossiers recopiée : ${VIGIE} → Compte travail1`);
    // un nouveau compte la reçoit aussi
    const neuf = { id: 'neuf', label: 'Compte neuf', file: path.join(d.root, 'comptes', 'neuf', '.claude.json') };
    write(neuf.file, { projects: {} }, 0o600);
    d.list.current = [...d.accounts, neuf];
    await sync.sync();
    assert.ok(trusted(neuf.file, VIGIE));
    // retirée sur tous les comptes : de confiance nulle part, et Vigie n'écrit rien
    for (const a of d.list.current) unset(a.file, VIGIE);
    const before = d.list.current.map((a) => fs.readFileSync(a.file, 'utf8'));
    assert.deepEqual(await sync.sync(), { changed: [], failed: false });
    assert.deepEqual(d.list.current.map((a) => fs.readFileSync(a.file, 'utf8')), before);
    assert.ok(!d.list.current.some((a) => trusted(a.file, VIGIE)));
    d.onlyAccounts();
  });

  test('fichier qui disparaît puis revient (nouvelle connexion) : il reçoit les dossiers de confiance', async () => {
    const d = decor();
    const sync = d.make();
    setTrust(d.file('perso'), VIGIE);
    await sync.sync();
    fs.rmSync(d.file('pro'));
    await sync.sync();
    assert.equal(fs.existsSync(d.file('pro')), false, 'pas recréé');
    write(d.file('pro'), { oauthAccount: {} }, 0o600);
    await sync.sync();
    assert.ok(trusted(d.file('pro'), VIGIE));
  });

  test('verrou tenu par Claude Code : rien d\'écrit tant qu\'il est tenu, nouvel essai ensuite', async () => {
    const d = decor();
    let clock = 1_000_000;
    const sync = d.make({ lockWaitMs: 150, retryMs: 60_000, now: () => clock });
    setTrust(d.file('perso'), VIGIE);
    const lock = `${d.file('pro')}.lock`;
    fs.mkdirSync(lock);
    const before = fs.readFileSync(d.file('pro'), 'utf8');
    const r = await sync.sync();
    assert.equal(r.failed, true);
    assert.equal(fs.readFileSync(d.file('pro'), 'utf8'), before, 'pas d\'écriture sous le verrou d\'un autre');
    assert.ok(trusted(d.file('travail1'), VIGIE), 'les autres comptes ne l\'attendent pas');
    assert.ok(d.logs.some((l) => /^confiance des dossiers : Compte pro pas mis à jour .*nouvel essai plus tard$/.test(l)));
    // le tour suivant relit (nos écritures ont changé un fichier) mais le verrou est toujours là
    assert.equal((await sync.poll()).failed, true);
    assert.equal(sync.poll(), null, 'rien n\'a bougé : pas de nouvel essai avant l\'heure');
    fs.rmdirSync(lock);
    clock += 60_000;
    const again = sync.poll();
    assert.ok(again, 'l\'heure du nouvel essai est venue');
    assert.equal((await again).failed, false);
    assert.ok(trusted(d.file('pro'), VIGIE));
  });

  test('fichier changé entre la lecture et l\'écriture : relu, les deux changements gardés', async () => {
    const d = decor();
    let calls = 0;
    const sync = d.make({
      // Claude Code écrit dans « pro » juste avant chacun de nos premiers renommages
      _beforeRename: (attempt) => {
        calls++;
        if (attempt === 1) { const j = readJ(d.file('pro')); j.numStartups += 1; write(d.file('pro'), j); }
      },
    });
    setTrust(d.file('perso'), VIGIE);
    const r = await sync.sync();
    assert.equal(r.failed, false);
    assert.equal(calls, 3, 'travail1 une fois, puis pro deux fois (relu après le changement)');
    assert.equal(readJ(d.file('pro')).numStartups, 5, 'les écritures de Claude Code sont gardées');
    assert.ok(trusted(d.file('pro'), VIGIE));
  });

  test('à chaque tour : rien avant le premier passage, puis un passage seulement quand un fichier change', async () => {
    const d = decor();
    const sync = d.make();
    setTrust(d.file('perso'), VIGIE);
    assert.equal(sync.poll(), null, 'le premier passage vient du démarrage');
    assert.equal(trusted(d.file('pro'), VIGIE), false);
    await sync.sync();
    await sync.poll(); // nos écritures ont changé des fichiers : un passage de plus, qui n'a rien à faire
    const nbLogs = d.logs.length;
    assert.equal(sync.poll(), null, 'rien n\'a changé');
    setTrust(d.file('travail1'), ATELIER); // la conversation enregistre un accord sur le compte du Mac
    const p = sync.poll();
    assert.ok(p);
    assert.deepEqual((await p).changed, [ATELIER]);
    assert.ok(trusted(d.file('perso'), ATELIER) && trusted(d.file('pro'), ATELIER));
    assert.equal(d.logs.length, nbLogs + 1);
    // un passage à la fois
    setTrust(d.file('pro'), NOTES);
    const a = sync.sync(), b = sync.sync();
    assert.equal(a, b);
    await a;
  });
});
