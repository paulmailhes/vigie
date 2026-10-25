// Tests du coffre des connexions (lib/vault.mjs) : node --test test/
// Le trousseau est un faux programme « security » (même ligne de commande que /usr/bin/security, mode -i compris)
// qui range ses entrées dans un fichier JSON du dossier temporaire et note chaque appel : aucun vrai trousseau n'est
// lu ni écrit. Les chemins contiennent des espaces.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createVault, createKeychain, keychainUser, VAULT_SERVICE, STDIN_MAX } = await import('../lib/vault.mjs');
const { keychainItem } = await import('../lib/accounts.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie coffre-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'maison alex');
const DATA = path.join(TMP, 'data vigie');
const ACC = path.join(TMP, 'comptes alex');
const CODEX = path.join(HOME, '.codex');
const FAKE_DIR = path.join(TMP, 'faux trousseau');
const SEC = path.join(FAKE_DIR, 'security');
const KC = path.join(FAKE_DIR, 'kc.json');
const CTL = path.join(FAKE_DIR, 'ctl.json');
const CALLS = path.join(FAKE_DIR, 'calls.log');

const w = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); };
const wj = (p, o) => w(p, JSON.stringify(o, null, 2));
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// --- faux /usr/bin/security ---
w(SEC, `#!${process.execPath}
const fs = require('fs');
const KC = ${JSON.stringify(KC)}, CTL = ${JSON.stringify(CTL)}, CALLS = ${JSON.stringify(CALLS)}, STAMPS = ${JSON.stringify(KC)} + '.dates';
const ctl = (() => { try { return JSON.parse(fs.readFileSync(CTL, 'utf8')); } catch { return {}; } })();
const load = () => { try { return JSON.parse(fs.readFileSync(KC, 'utf8')); } catch { return {}; } };
const save = (db) => fs.writeFileSync(KC, JSON.stringify(db, null, 2));
// dates de création et de modification, à la seconde (comme le vrai), une heure dans le passé
const stamps = () => { try { return JSON.parse(fs.readFileSync(STAMPS, 'utf8')); } catch { return { n: 0 }; } };
const stampOf = (k) => stamps()[k] || { c: 0, m: 0 };
const iso = (n) => new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + n * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
fs.appendFileSync(CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
function bump(k, created) { const t = stamps(); t.n++; t[k] = { c: created || !t[k] ? t.n : t[k].c, m: t.n }; fs.writeFileSync(STAMPS, JSON.stringify(t)); }
function opt(args, f) { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; }
function run(args) {
  const cmd = args[0];
  const s = opt(args, '-s'), a = opt(args, '-a');
  const db = load();
  const key = Object.keys(db).find((k) => { const [ka, ks] = JSON.parse(k); return ks === s && (a === undefined || ka === a); });
  if (cmd === 'find-generic-password') {
    if (ctl.failRead) return 1;
    if (!key) return 44;
    if (args.includes('-w')) {
      if (ctl.blockSecretMs) wait(ctl.blockSecretMs); // fenêtre de mot de passe restée ouverte
      const v = db[key];
      process.stdout.write((ctl.hexOut ? Buffer.from(v, 'utf8').toString('hex') : v) + '\\n');
    } else {
      const st = stampOf(key);
      process.stdout.write('keychain: "login.keychain-db"\\nattributes:\\n    "cdat"<timedate>=0x00  "' + iso(st.c) + '\\\\000"\\n    "mdat"<timedate>=0x00  "' + iso(st.m) + '\\\\000"\\n');
    }
    return 0;
  }
  if (cmd === 'add-generic-password') {
    if (ctl.failWrite) return 1;
    if (key && !args.includes('-U')) return 45;
    const hex = opt(args, '-X'), pw = opt(args, '-w');
    const v = hex !== undefined ? Buffer.from(hex, 'hex').toString('utf8') : pw;
    if (key) delete db[key];
    db[JSON.stringify([a, s])] = v;
    save(db);
    bump(JSON.stringify([a, s]), !key);
    return 0;
  }
  if (cmd === 'delete-generic-password') { if (!key) return 44; delete db[key]; save(db); return 0; }
  return 2;
}
function words(line) {
  const out = []; let cur = null, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\\\') { cur += line[++i]; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') { q = true; cur = cur ?? ''; continue; }
    if (/\\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const wait = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* attente */ } };
if (ctl.slowMs) wait(ctl.slowMs);
const argv = process.argv.slice(2);
if (argv[0] === '-i') {
  const lines = fs.readFileSync(0, 'utf8').split('\\n').filter(Boolean);
  let code = 0;
  for (const l of lines) { if (l.length > (ctl.lineMax ?? 4096)) { code = 1; break; } code = run(words(l)); }
  process.exit(code);
}
process.exit(run(argv));
`, 0o755);
const setCtl = (o = {}) => wj(CTL, o);
const kc = () => { try { return rj(KC); } catch { return {}; } };
const kcGet = (service, account = 'alex') => kc()[JSON.stringify([account, service])];
// une écriture faite par une app : change la date de modification, comme le vrai trousseau
const kcStamp = (k, created) => { let t; try { t = rj(`${KC}.dates`); } catch { t = { n: 0 }; } t.n++; t[k] = { c: created || !t[k] ? t.n : t[k].c, m: t.n }; wj(`${KC}.dates`, t); };
const kcSet = (service, value, account = 'alex') => { const db = kc(); const k = JSON.stringify([account, service]); const created = !(k in db); db[k] = typeof value === 'string' ? value : JSON.stringify(value); wj(KC, db); kcStamp(k, created); };
const kcDel = (service, account = 'alex') => { const db = kc(); delete db[JSON.stringify([account, service])]; wj(KC, db); };
const calls = () => { try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
setCtl();

// --- décor : Travail 1 (~/.claude) et un compte Pro dans son dossier ; Nextcloud installé (leurre nécessaire) ---
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'Applications', 'Nextcloud.app'), { recursive: true });
const PRO = path.join(ACC, 'pro');
fs.mkdirSync(PRO, { recursive: true });
const ITEM_T1 = keychainItem(null);
const ITEM_PRO = keychainItem(PRO);
const login = (n) => ({ accessToken: `acces-${n}`, refreshToken: `renouvellement-${n}`, expiresAt: 1_900_000_000_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' });
const mcpPart = { mcpOAuth: { 'figma|abc': { accessToken: 'jeton-figma', serverName: 'figma' } } };
const oauth = (email, uuid) => ({ oauthAccount: { emailAddress: email, accountUuid: uuid, organizationUuid: 'org' }, numStartups: 3 });
wj(path.join(HOME, '.claude.json'), oauth('perso@exemple.test', 'uuid-perso'));
wj(path.join(PRO, '.claude.json'), oauth('pro@exemple.test', 'uuid-pro'));
kcSet(ITEM_T1, { claudeAiOauth: login('t1-a'), ...mcpPart });
kcSet(ITEM_PRO, { claudeAiOauth: login('pro-a') });
fs.mkdirSync(CODEX, { recursive: true });
const CODEX_AUTH = { auth_mode: 'chatgpt', tokens: { id_token: 'x'.repeat(3000), access_token: 'codex-acces', refresh_token: 'codex-renouvellement', account_id: 'acc' }, last_refresh: '2026-10-23T08:00:00Z' };
wj(path.join(CODEX, 'auth.json'), CODEX_AUTH);

const ACCOUNTS = [
  { id: 'travail1', label: 'Perso', configDir: null },
  { id: 'pro', label: 'Pro', configDir: PRO, expectedEmail: 'pro@exemple.test' },
];
let clock = Date.parse('2026-10-23T08:00:00Z');
const logs = [];
const keychain = createKeychain({ bin: SEC, user: 'alex', timeoutMs: 3000 });
const vault = createVault({
  dataDir: DATA, home: HOME, accounts: () => ACCOUNTS, codexHome: CODEX, keychain,
  now: () => clock, log: (m) => logs.push(m), confirmMs: 15_000, lockWaitMs: 400, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
});
const STATUS = path.join(DATA, 'connexions.json');
const COFFRE = path.join(DATA, 'coffre');
const tick = async (ms = 20_000) => { clock += ms; return vault.sync(); };
// Tout ce qui sort du coffre (fichiers, état, journal, arguments des commandes) : jamais un jeton en clair.
function assertNoSecret(where) {
  const all = [
    ...fs.readdirSync(COFFRE).map((f) => fs.readFileSync(path.join(COFFRE, f), 'utf8')),
    fs.readFileSync(STATUS, 'utf8'), logs.join('\n'),
    ...calls().filter((c) => c[0] !== 'add-generic-password' || !String(c).includes('credentials')).map((c) => c.join(' ')),
  ].join('\n');
  for (const s of ['acces-', 'renouvellement-', 'codex-acces', 'codex-renouvellement']) assert.ok(!all.includes(s), `${where} : « ${s} » en clair`);
}

test('trousseau : utilisateur comme Claude Code, écriture par l\'entrée standard, absent et échec distingués', async () => {
  assert.equal(keychainUser({ USER: 'alex' }), 'alex');
  assert.equal(keychainUser({ USER: 'nom avec espace' }), 'claude-code-user');
  assert.ok(await keychain.write('Vigie essai', '{"a":1}'));
  assert.deepEqual(await keychain.read('Vigie essai'), { state: 'ok', text: '{"a":1}' });
  const last = calls().at(-2);
  assert.deepEqual(last, ['-i'], 'secret passé par l\'entrée standard, pas en argument');
  assert.deepEqual(await keychain.read('Vigie absent'), { state: 'absent' });
  setCtl({ failRead: true });
  assert.deepEqual(await keychain.read('Vigie essai'), { state: 'error' });
  setCtl({ hexOut: true });
  assert.deepEqual(await keychain.read('Vigie essai'), { state: 'ok', text: '{"a":1}' }, 'sortie hexadécimale de security décodée');
  setCtl();
  // trop long pour l'entrée standard : refusé, sauf si on l'autorise (comme Claude Code pour sa propre entrée)
  const big = JSON.stringify({ x: 'y'.repeat(STDIN_MAX) });
  assert.equal(await keychain.write('Vigie essai', big), false);
  assert.ok(await keychain.write('Vigie essai', big, { argv: true }));
  assert.equal(kcGet('Vigie essai'), big);
  assert.equal(await keychain.write('nom "piégé"', 'x'), false, 'nom d\'entrée non sûr refusé');
  kcDel('Vigie essai');
});

test('première synchronisation : clé créée, copies chiffrées, état écrit, rien en clair', async () => {
  const st = await vault.sync();
  assert.equal(st.accounts.travail1.connected, true);
  assert.equal(st.accounts.travail1.state, 'ok');
  assert.equal(st.accounts.pro.state, 'ok');
  assert.equal(st.codex.state, 'ok');
  const key = kcGet(VAULT_SERVICE, 'cle');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!calls().some((c) => c.includes(key)), 'la clé ne passe jamais en argument');
  assert.deepEqual(fs.readdirSync(COFFRE).sort(), ['claude-pro.json', 'claude-travail1.json', 'codex.json']);
  assert.equal(fs.statSync(COFFRE).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(COFFRE, 'claude-pro.json')).mode & 0o777, 0o600);
  const status = rj(STATUS);
  assert.equal(status.accounts.pro.connected, true);
  assert.ok(Math.abs(status.checkedAtEpoch - clock / 1000) < 1);
  assertNoSecret('après la première copie');
  // rien ne bouge : aucune écriture de plus
  const before = calls().length;
  await tick();
  const writes = calls().slice(before).filter((c) => c[0] === '-i' || c[0] === 'add-generic-password');
  assert.equal(writes.length, 0, 'pas de réécriture tant que la connexion ne change pas');
});

test('connexion effacée par une app (entrée sans claudeAiOauth) : remise après confirmation, MCP gardés', async () => {
  // ce que fait Claude Code quand il relit mal son entrée puis y range un jeton de MCP
  kcSet(ITEM_T1, mcpPart);
  let st = await tick(5_000);
  assert.equal(st.accounts.travail1.state, 'restoring', 'copie prête, remise au prochain passage');
  assert.equal(st.accounts.travail1.connected, null, 'remise imminente : le compte reste utilisable (pas de repli coûteux)');
  assert.deepEqual(JSON.parse(kcGet(ITEM_T1)), mcpPart, 'pas de remise au premier constat');
  st = await tick(20_000);
  assert.equal(st.accounts.travail1.state, 'restored');
  assert.equal(st.accounts.travail1.connected, true);
  const back = JSON.parse(kcGet(ITEM_T1));
  assert.deepEqual(back.claudeAiOauth, login('t1-a'));
  assert.deepEqual(back.mcpOAuth, mcpPart.mcpOAuth);
  assert.ok(logs.some((l) => /Perso.*remise/.test(l)), logs.join('\n'));
  assert.ok(!fs.existsSync(path.join(HOME, '.claude', '.storage-write.lock')), 'verrou rendu');
  assertNoSecret('après la remise');
});

test('copie tenue à jour à chaque renouvellement : la remise rend la dernière connexion', async () => {
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-b') });
  await tick();
  kcDel(ITEM_PRO); // entrée effacée (Trousseau d'accès, ou une app), l'adresse est toujours là
  await tick();
  const st = await tick();
  assert.equal(st.accounts.pro.state, 'restored');
  assert.deepEqual(JSON.parse(kcGet(ITEM_PRO)).claudeAiOauth, login('pro-b'));
});

test('vraie déconnexion (adresse retirée de .claude.json) : respectée, rien n\'est remis', async () => {
  kcDel(ITEM_PRO);
  wj(path.join(PRO, '.claude.json'), { numStartups: 3 });
  await tick();
  const st = await tick();
  assert.equal(st.accounts.pro.state, 'logged-out');
  assert.equal(st.accounts.pro.connected, false);
  assert.equal(kcGet(ITEM_PRO), undefined);
  // reconnexion : nouvelle connexion copiée
  wj(path.join(PRO, '.claude.json'), oauth('pro@exemple.test', 'uuid-pro'));
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-c') });
  assert.equal((await tick()).accounts.pro.state, 'ok');
});

test('connexion refusée par Anthropic (jetons vidés par Claude Code) : à reconnecter, jamais remise', async () => {
  kcSet(ITEM_PRO, { claudeAiOauth: { ...login('pro-c'), accessToken: '', refreshToken: '', expiresAt: 0 } });
  await tick();
  const st = await tick();
  assert.equal(st.accounts.pro.state, 'dead');
  assert.equal(st.accounts.pro.connected, false);
  assert.equal(JSON.parse(kcGet(ITEM_PRO)).claudeAiOauth.refreshToken, '');
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-d') });
  assert.equal((await tick()).accounts.pro.state, 'ok');
});

test('mauvaise adresse dans le dossier du compte : jamais copiée', async () => {
  wj(path.join(PRO, '.claude.json'), oauth('autre@exemple.test', 'uuid-autre'));
  kcSet(ITEM_PRO, { claudeAiOauth: login('autre') });
  await tick();
  kcSet(ITEM_PRO, {});
  await tick();
  const st = await tick();
  assert.equal(st.accounts.pro.state, 'lost', 'pas de copie de ce compte-là');
  assert.deepEqual(JSON.parse(kcGet(ITEM_PRO)), {});
  wj(path.join(PRO, '.claude.json'), oauth('pro@exemple.test', 'uuid-pro'));
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-e') });
  await tick();
});

test('lecture du trousseau en échec : état inconnu, dernier état gardé, rien n\'est écrit', async () => {
  kcSet(ITEM_T1, mcpPart);
  await tick();
  setCtl({ failRead: true });
  const before = calls().length;
  for (let i = 0; i < 3; i++) {
    const st = await tick();
    assert.equal(st.accounts.travail1.state, 'unknown');
  }
  assert.ok(!calls().slice(before).some((c) => c[0] === '-i' || c[0] === 'add-generic-password'), 'aucune écriture après une lecture ratée');
  setCtl();
  const st = await tick();
  assert.equal(st.accounts.travail1.state, 'restored');
});

test('verrou d\'écriture de Claude Code : attendu s\'il est frais, repris s\'il est périmé', async () => {
  const lock = path.join(HOME, '.claude', '.storage-write.lock');
  kcSet(ITEM_T1, mcpPart);
  await tick();
  fs.mkdirSync(lock);
  let st = await tick();
  assert.equal(st.accounts.travail1.state, 'restoring', 'Claude Code écrit : on ne touche à rien');
  assert.deepEqual(JSON.parse(kcGet(ITEM_T1)), mcpPart);
  assert.ok(fs.existsSync(lock), 'le verrou de Claude Code n\'est pas retiré');
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  st = await tick();
  assert.equal(st.accounts.travail1.state, 'restored');
  assert.ok(!fs.existsSync(lock));
});

test('au plus 3 remises par heure pour un compte', async () => {
  let restored = 0;
  for (let i = 0; i < 5; i++) {
    kcSet(ITEM_T1, mcpPart);
    await tick(16_000);
    const st = await tick(16_000);
    if (st.accounts.travail1.state === 'restored') restored++;
  }
  assert.ok(restored <= 3, `${restored} remises`);
  assert.ok(logs.some((l) => /trop souvent/.test(l)), logs.join('\n'));
  clock += 3_600_000;
  const st = await tick();
  assert.equal(st.accounts.travail1.state, 'restored', 'une heure plus tard : de nouveau possible');
});

test('connexion en clair de Claude Code (.credentials.json, trousseau en échec d\'écriture) : connecté', async () => {
  kcDel(ITEM_PRO);
  wj(path.join(PRO, '.credentials.json'), { claudeAiOauth: login('pro-clair') });
  const st = await tick();
  assert.equal(st.accounts.pro.state, 'ok');
  assert.equal(st.accounts.pro.connected, true);
  fs.rmSync(path.join(PRO, '.credentials.json'));
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-f') });
  await tick();
});

test('déconnexion ou connexion lancée depuis VS Code (journal du lanceur) : pas de remise pendant 10 min', async () => {
  const LOG = path.join(DATA, 'launches.log');
  w(LOG, `${Math.floor(clock / 1000)}\t123\ttravail1\t-\tdeconnexion\n`);
  kcSet(ITEM_T1, mcpPart);
  await tick();
  let st = await tick();
  assert.equal(st.accounts.travail1.state, 'logged-out');
  clock += 11 * 60_000;
  await tick();
  st = await tick();
  assert.equal(st.accounts.travail1.state, 'restored');
  fs.rmSync(LOG);
});

test('Codex : fichier abîmé remis depuis la copie, fichier retiré (déconnexion) respecté', async () => {
  const f = path.join(CODEX, 'auth.json');
  w(f, '{"auth_mode": "chatgpt", "tok');
  let st = await tick();
  assert.equal(st.codex.state, 'restoring');
  st = await tick();
  assert.equal(st.codex.state, 'restored');
  assert.deepEqual(rj(f), CODEX_AUTH);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.rmSync(f);
  await tick();
  st = await tick();
  assert.equal(st.codex.state, 'logged-out');
  assert.ok(!fs.existsSync(f));
  wj(f, CODEX_AUTH);
  assert.equal((await tick()).codex.state, 'ok');
  assertNoSecret('Codex');
});

test('clé du coffre illisible : aucune copie ni remise, l\'état reste juste', async () => {
  const v2 = createVault({ dataDir: path.join(TMP, 'data 2'), home: HOME, accounts: () => ACCOUNTS, codexHome: null,
    keychain: createKeychain({ bin: path.join(TMP, 'nulle part', 'security'), user: 'alex' }), now: () => clock, log: () => {} });
  const st = await v2.sync();
  assert.equal(st.accounts.travail1.state, 'unknown');
  assert.equal(fs.existsSync(path.join(TMP, 'data 2', 'coffre')), false);
});

test('clé recréée (ancienne effacée du trousseau) : les anciennes copies, illisibles, sont retirées', async () => {
  kcDel(VAULT_SERVICE, 'cle');
  const v3 = createVault({ dataDir: DATA, home: HOME, accounts: () => ACCOUNTS, codexHome: CODEX, keychain, now: () => clock, log: () => {} });
  await v3.sync();
  const key = kcGet(VAULT_SERVICE, 'cle');
  assert.match(key, /^[0-9a-f]{64}$/);
  kcSet(ITEM_T1, mcpPart);
  await v3.sync();
  clock += 20_000;
  const st = await v3.sync();
  assert.equal(st.accounts.travail1.state, 'restored', 'copie refaite avec la nouvelle clé');
});

// --- retours de relecture (2026-10-23) ---
// Coffre neuf (le test précédent a recréé la clé ; le premier coffre garde l'ancienne en mémoire), heure oubliée.
const freshVault = () => createVault({ dataDir: DATA, home: HOME, accounts: () => ACCOUNTS, codexHome: CODEX, keychain,
  now: () => clock, log: (m) => logs.push(m), confirmMs: 15_000, lockWaitMs: 400, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
let V = null;
const tick2 = async (ms = 20_000) => { clock += ms; return V.sync(); };
async function resetVault() {
  clock += 2 * 3_600_000;
  V = freshVault();
  kcSet(ITEM_T1, { claudeAiOauth: login('t1-a'), ...mcpPart });
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-z') });
  wj(path.join(PRO, '.claude.json'), oauth('pro@exemple.test', 'uuid-pro'));
  await V.sync();
}
test('remise qui traîne plus de 2 min : le compte devient « pas connecté »', async () => {
  await resetVault();
  const lock = path.join(HOME, '.claude', '.storage-write.lock');
  kcSet(ITEM_T1, mcpPart);
  let st = await tick2();
  fs.mkdirSync(lock); // Claude Code écrit (verrou frais pendant 15 s réelles)
  for (let i = 0; i < 7; i++) st = await tick2();
  assert.equal(st.accounts.travail1.state, 'restoring');
  assert.equal(st.accounts.travail1.connected, false);
  fs.rmdirSync(lock);
  st = await tick2();
  assert.equal(st.accounts.travail1.state, 'restored');
});

test('verrou impossible à retirer ou lien cassé : le passage se termine quand même (jamais de boucle)', async () => {
  await resetVault();
  const lock = path.join(HOME, '.claude', '.storage-write.lock');
  for (const make of [
    () => { fs.mkdirSync(path.join(lock, 'dedans'), { recursive: true }); const old = (Date.now() - 60_000) / 1000; fs.utimesSync(lock, old, old); }, // périmé, pas vide
    () => fs.symlinkSync(path.join(TMP, 'nulle part'), lock), // lien cassé
  ]) {
    kcSet(ITEM_T1, mcpPart);
    await tick2();
    make();
    const t0 = Date.now();
    const st = await tick2();
    assert.ok(Date.now() - t0 < 5_000, `${Date.now() - t0} ms`);
    assert.equal(st.accounts.travail1.state, 'restoring');
    assert.deepEqual(JSON.parse(kcGet(ITEM_T1)), mcpPart, 'rien écrit sans verrou');
    fs.rmSync(lock, { recursive: true, force: true });
    assert.equal((await tick2()).accounts.travail1.state, 'restored');
  }
});

test('connexion refusée par Anthropic : sa copie est jetée, une perte ensuite n\'est jamais réparée avec elle', async () => {
  await resetVault();
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-g') });
  await tick2();
  kcSet(ITEM_PRO, { claudeAiOauth: { ...login('pro-g'), accessToken: '', refreshToken: '', expiresAt: 0 } });
  assert.equal((await tick2()).accounts.pro.state, 'dead');
  assert.ok(!fs.existsSync(path.join(COFFRE, 'claude-pro.json')), 'copie refusée jetée');
  kcSet(ITEM_PRO, {}); // puis l'entrée perd sa connexion (même panne de Claude Code)
  await tick2();
  const st = await tick2();
  assert.equal(st.accounts.pro.state, 'lost');
  assert.deepEqual(JSON.parse(kcGet(ITEM_PRO)), {});
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-h') });
  assert.equal((await tick2()).accounts.pro.state, 'ok');
  assert.ok(fs.existsSync(path.join(COFFRE, 'claude-pro.json')), 'nouvelle connexion copiée');
});

test('claudeAiOauth à null : jamais remise, jamais de verrou pris en boucle', async () => {
  await resetVault();
  kcSet(ITEM_T1, { claudeAiOauth: null, ...mcpPart });
  for (let i = 0; i < 3; i++) assert.equal((await tick2()).accounts.travail1.state, 'lost');
  assert.equal(JSON.parse(kcGet(ITEM_T1)).claudeAiOauth, null);
  kcSet(ITEM_T1, { claudeAiOauth: login('t1-a'), ...mcpPart });
  await tick2();
});

test('plafond des remises gardé d\'un démarrage du moteur à l\'autre', async () => {
  clock += 2 * 3_600_000;
  const mk = () => createVault({ dataDir: DATA, home: HOME, accounts: () => ACCOUNTS, codexHome: null, keychain, now: () => clock,
    log: () => {}, maxRestoresPerHour: 1, lockWaitMs: 400 });
  let v = mk();
  await v.sync();
  kcSet(ITEM_T1, mcpPart);
  await v.sync(); clock += 20_000;
  assert.equal((await v.sync()).accounts.travail1.state, 'restored');
  v = mk(); // moteur redémarré
  kcSet(ITEM_T1, mcpPart);
  await v.sync(); clock += 20_000;
  const st = await v.sync();
  assert.equal(st.accounts.travail1.state, 'lost', 'déjà remise dans l\'heure, avant le redémarrage');
  assert.equal(rj(STATUS).accounts.travail1.restores.length, 1);
  clock += 3_600_000;
  assert.equal((await v.sync()).accounts.travail1.state, 'restored', 'une heure plus tard : perte toujours constatée, remise');
});

// --- moins de lectures du secret (2026-10-25 : chaque lecture peut ouvrir une fenêtre de mot de passe) ---
const secretReads = (from) => calls().slice(from).filter((c) => c[0] === 'find-generic-password' && c.includes('-w') && String(c[c.indexOf('-s') + 1]).startsWith('Claude Code-credentials')).length;

test('rien ne bouge dans le trousseau : le secret n\'est pas relu à chaque passage (seulement la date de l\'entrée)', async () => {
  await resetVault();
  await tick2();
  let from = calls().length;
  for (let i = 0; i < 5; i++) assert.equal((await tick2()).accounts.travail1.state, 'ok');
  assert.equal(secretReads(from), 0, 'aucune lecture du secret quand l\'entrée n\'a pas changé');
  assert.ok(calls().slice(from).some((c) => c[0] === 'find-generic-password' && !c.includes('-w')), 'la date de l\'entrée est bien regardée');
  // Claude Code renouvelle la connexion : l'entrée change, elle est relue une fois et copiée
  from = calls().length;
  kcSet(ITEM_PRO, { claudeAiOauth: login('pro-renouvele') });
  assert.equal((await tick2()).accounts.pro.state, 'ok');
  assert.equal(secretReads(from), 1);
  // la remise rend bien cette connexion-là
  kcSet(ITEM_PRO, {});
  await tick2();
  await tick2();
  assert.deepEqual(JSON.parse(kcGet(ITEM_PRO)).claudeAiOauth, login('pro-renouvele'));
  // par prudence, relue au moins toutes les 10 min même sans changement
  from = calls().length;
  clock += 11 * 60_000;
  await tick2();
  assert.ok(secretReads(from) >= 1);
});

test('lecture du secret bloquée (fenêtre de mot de passe ouverte) : une tentative, puis plus rien pendant 15 min', async () => {
  await resetVault();
  const slowKc = createKeychain({ bin: SEC, user: 'alex', timeoutMs: 800 });
  const B = createVault({ dataDir: DATA, home: HOME, accounts: () => ACCOUNTS, codexHome: null, keychain: slowKc, now: () => clock, log: (m) => logs.push(m), confirmMs: 15_000, lockWaitMs: 400 });
  await B.sync();
  kcSet(ITEM_T1, { claudeAiOauth: login('t1-z'), ...mcpPart }); // changée : il faudra la relire
  setCtl({ blockSecretMs: 2000 });
  let st = await B.sync();
  assert.equal(st.accounts.travail1.state, 'unknown');
  assert.ok(logs.some((l) => /mot de passe/.test(l)), logs.slice(-3).join('\n'));
  const from = calls().length;
  for (let i = 0; i < 5; i++) { clock += 20_000; st = await B.sync(); }
  const t1Reads = calls().slice(from).filter((c) => c.includes('-w') && c[c.indexOf('-s') + 1] === ITEM_T1).length;
  assert.equal(t1Reads, 0, 'plus aucune lecture de cette entrée : pas une fenêtre de plus');
  assert.equal(st.accounts.pro.state, 'ok', 'les autres comptes continuent');
  setCtl();
  clock += 16 * 60_000;
  st = await B.sync();
  assert.equal(st.accounts.travail1.state, 'ok', 'un quart d\'heure plus tard : relue normalement');
});

// --- leurre (2026-10-25) : une app qui cherche « l'entrée du compte <utilisateur> » sans préciser le service
// (Nextcloud, dont l'utilisateur porte le même nom que la session) prend la première par ordre alphabétique du
// service : celle de Claude Code. Le leurre passe devant.
test('leurre devant les entrées de Claude Code : posé, recréé s\'il disparaît, jamais lu', async () => {
  const { SHIELD_SERVICE } = await import('../lib/vault.mjs');
  assert.ok(SHIELD_SERVICE < ITEM_T1 && SHIELD_SERVICE < ITEM_PRO, 'il passe avant dans l\'ordre alphabétique');
  await resetVault();
  assert.ok(kcGet(SHIELD_SERVICE) !== undefined, 'posé au compte de la session');
  assert.ok(!kcGet(SHIELD_SERVICE).includes('acces-'), 'rien d\'utile dedans');
  kcDel(SHIELD_SERVICE);
  const from = calls().length;
  await tick2();
  assert.ok(kcGet(SHIELD_SERVICE) !== undefined, 'recréé');
  await tick2();
  assert.ok(!calls().slice(from).some((c) => c.includes('-w') && c[c.indexOf('-s') + 1] === SHIELD_SERVICE), 'son contenu n\'est jamais lu');
  const writes = calls().slice(from).filter((c) => c[0] === '-i').length;
  assert.equal(writes, 1, 'une seule écriture : il n\'est recréé que s\'il manque');
});

test('leurre : rien sans Nextcloud, pas même un regard au trousseau', async () => {
  const { SHIELD_SERVICE } = await import('../lib/vault.mjs');
  kcDel(SHIELD_SERVICE);
  const bare = createVault({ dataDir: path.join(TMP, 'data sans nextcloud'), home: path.join(TMP, 'maison vide'), accounts: () => [],
    codexHome: null, keychain, now: () => clock, log: () => {}, appDirs: [path.join(TMP, 'maison vide', 'Applications')] });
  const from = calls().length;
  await bare.sync();
  await bare.sync();
  assert.equal(kcGet(SHIELD_SERVICE), undefined, 'pas de leurre');
  assert.ok(!calls().slice(from).some((c) => c.includes(SHIELD_SERVICE) || (c[0] === '-i')), 'aucun appel pour le leurre');
  await resetVault();
});
