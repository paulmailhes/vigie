// Tests des comptes (lib/accounts.mjs) : node --test test/
// Tout vit dans un dossier temporaire (HOME, data, dossiers de comptes, réglages VS Code), avec des espaces
// dans les chemins. Le trousseau, Terminal, ps et pgrep sont simulés : aucune vraie commande système n'est
// lancée, sauf de faux « claude » (liens vers /bin/sleep ou /bin/bash) que les tests démarrent puis arrêtent
// eux-mêmes, et un faux binaire pour les relevés d'usage (jamais de vraie requête au modèle).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie comptes-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'maison alex');
const DATA = path.join(TMP, 'data vigie');
const ACC = path.join(TMP, 'comptes alex');
const VSC = path.join(TMP, 'vscode', 'settings.json');
const RUNCAT = path.join(TMP, 'runcat', 'state.json');
const WRAP = path.join(TMP, 'install', 'bin', 'claude-account-wrapper');
// ceinture : si un défaut était utilisé par erreur, il tomberait ici
Object.assign(process.env, { VIGIE_DATA: DATA, VIGIE_HOME: HOME, VIGIE_ACCOUNTS_ROOT: ACC, VIGIE_VSCODE_SETTINGS: VSC, VIGIE_RUNCAT_STATE: RUNCAT, VIGIE_WRAPPER: WRAP });
delete process.env.VIGIE_CLAUDE_BIN; // les relevés n'utilisent que le faux binaire passé explicitement

const { createAccounts, keychainItem, parseJsonc, setJsoncKey, rereadEstimate, SHARED, WRAPPER_KEY } = await import('../lib/accounts.mjs');

const w = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); };
const wj = (p, o) => w(p, JSON.stringify(o, null, 2));
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const SECRET = 'valeur-de-test-secrete';

// --- décor : un ~/.claude comme celui de l'utilisateur (todos, agents, commands et CLAUDE.md absents) ---
for (const d of ['projects', 'sessions', 'file-history', 'plans', 'shell-snapshots', 'skills', 'plugins', 'session-env', 'ide']) {
  fs.mkdirSync(path.join(HOME, '.claude', d), { recursive: true });
}
wj(path.join(HOME, '.claude', 'settings.json'), { permissions: { defaultMode: 'auto' }, hooks: { PermissionRequest: [] } });
const NOW = Date.now();
// Heures de remise à zéro relatives à maintenant (une fenêtre passée n'est plus montrée) : « AAAA-MM-JJTHH:MM:SS ».
const at = (h) => new Date(Math.floor(NOW / 1000) * 1000 + h * 3_600_000).toISOString().slice(0, 19);
const MAIN_JSON = {
  oauthAccount: { emailAddress: 'help@exemple.test', accountUuid: 'uuid-t1', organizationUuid: 'org-1' },
  userID: 'id-machine', numStartups: 42,
  mcpServers: {
    'figma-perso': { type: 'http', url: 'https://mcp.figma.com/mcp' },
    anarlog: { type: 'stdio', command: '/bin/anarlog', args: ['--x'], env: { TOKEN: SECRET } },
  },
  projects: {
    '/Users/alex/Code/atelier': {
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, enabledMcpjsonServers: ['supabase'],
      mcpServers: { 'figma-desktop': { type: 'http', url: 'http://127.0.0.1:3845/mcp' } }, disabledMcpServers: ['paddle-live'],
      lastCost: 12.5, lastSessionId: 'abc', exampleFiles: ['a.ts'], allowedTools: [],
    },
    '/Users/alex/Code/boutique': { lastCost: 1 },
  },
  cachedUsageUtilization: {
    fetchedAtMs: NOW - 60_000, accountUuid: 'uuid-t1',
    utilization: {
      five_hour: { utilization: 68, resets_at: `${at(2)}.304094+00:00` },
      seven_day: { utilization: 15, resets_at: `${at(150)}.304112+00:00` },
      limits: [
        { kind: 'session', group: 'session', percent: 68, severity: 'normal', resets_at: `${at(2)}.304094+00:00`, scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 15, severity: 'normal', resets_at: `${at(150)}.304112+00:00`, scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 55, severity: 'normal', resets_at: `${at(150)}+00:00`, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      ],
    },
  },
};
wj(path.join(HOME, '.claude.json'), MAIN_JSON);
w(WRAP, '#!/bin/bash\nexec "$@"\n', 0o755);
w(VSC, '{\n    "editor.fontSize": 13,\n    "workbench.colorTheme": "Default Dark+"\n}');

// --- système simulé : trousseau, ps, Terminal ---
function fakeRunner() {
  const fn = (cmd, args, opts = {}) => {
    fn.calls.push({ cmd, args: [...args], opts });
    if (cmd === '/usr/bin/security') return { status: fn.keychain.has(args[2]) ? 0 : 44, stdout: '', stderr: '' };
    if (cmd === '/bin/ps') {
      const p = fn.procs.get(Number(args[args.indexOf('-p') + 1]));
      if (!p) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: `${args[1] === 'comm=' ? p.comm : (opts.env?.TZ === 'UTC' ? p.lstartUtc : 'heure locale')}\n`, stderr: '' };
    }
    if (cmd === '/usr/bin/osascript') return { status: fn.osascript, stdout: '', stderr: '' };
    if (cmd === '/usr/bin/pgrep') {
      if (fn.pgrepFails) return { status: 3, stdout: '', stderr: '' };
      const kids = fn.children.get(Number(args[args.indexOf('-P') + 1])) || [];
      return kids.length ? { status: 0, stdout: `${kids.join('\n')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (cmd === '/usr/bin/open') return { status: 0, stdout: '', stderr: '' };
    if (/(^|\/)claude$/.test(cmd) && args[0] === 'auth') return { status: fn.login ?? 127, stdout: '', stderr: '' };
    return { status: 127, stdout: '', stderr: '' };
  };
  return Object.assign(fn, { calls: [], keychain: new Set(['Claude Code-credentials']), procs: new Map(), children: new Map(), pgrepFails: false, osascript: 0 });
}
const runner = fakeRunner();
const kills = [];
// stopGraceMs : le SIGTERM de secours (si SIGINT n'a pas suffi) ne part jamais pendant les tests à faux processus
const opts = { dataDir: DATA, home: HOME, accountsRoot: ACC, vscodeSettingsPath: VSC, wrapperPath: WRAP, runcatPath: RUNCAT, runner, kill: (pid, sig) => kills.push([pid, sig]), cacheMs: 0, stopGraceMs: 3_600_000 };
const A = createAccounts(opts);

test('nom de l\'entrée de trousseau : sha256 du chemin brut, 8 caractères', () => {
  assert.equal(keychainItem(null), 'Claude Code-credentials');
  // même calcul que Claude Code (vérifié sur le binaire 2.1.301) : le chemin brut, barre finale comprise
  assert.equal(keychainItem('/Users/alex/.claude-pro1'), 'Claude Code-credentials-42f6e338');
  assert.equal(keychainItem('/Users/alex/.claude-pro1/'), 'Claude Code-credentials-040acb0b');
  const d = path.join(ACC, 'x');
  assert.equal(keychainItem(d), `Claude Code-credentials-${crypto.createHash('sha256').update(d).digest('hex').slice(0, 8)}`);
});

test('estimation de relecture', () => {
  assert.equal(rereadEstimate(152_340), '≈ 152 k tokens relus sur le nouveau compte.');
  assert.equal(rereadEstimate(300), '≈ 1 k tokens relus sur le nouveau compte.');
  assert.equal(rereadEstimate(1_234_567), '≈ 1,2 M tokens relus sur le nouveau compte.');
  assert.equal(rereadEstimate(undefined), null);
  assert.equal(rereadEstimate(0), null);
});

test('au départ : Travail 1 = configuration actuelle, connecté, jauges lues ; rien n\'est écrit', () => {
  const v = A.view();
  assert.equal(fs.existsSync(path.join(DATA, 'accounts.json')), false);
  assert.equal(v.defaultForNew, 'travail1');
  assert.deepEqual(v.wrapper, { path: WRAP, active: false });
  assert.equal(v.accounts.length, 1);
  const t1 = v.accounts[0];
  assert.deepEqual({ id: t1.id, label: t1.label, email: t1.email, connected: t1.connected, isDefault: t1.isDefault, configDir: t1.configDir, keychainItem: t1.keychainItem, dirReady: t1.dirReady },
    { id: 'travail1', label: 'Pro · help', email: 'help@exemple.test', connected: true, isDefault: true, configDir: null, keychainItem: 'Claude Code-credentials', dirReady: true });
  assert.deepEqual(t1.usage, {
    session: { pct: 68, resetsAt: `${at(2)}.304Z` },
    week: { pct: 15, resetsAt: `${at(150)}.304Z` },
    weekModel: { label: 'Fable', pct: 55, resetsAt: `${at(150)}.000Z` },
    observedAt: new Date(NOW - 60_000).toISOString(),
    source: 'session',
  });
  // trousseau : seulement un test d'existence, jamais -w ni -g
  const sec = runner.calls.filter((c) => c.cmd === '/usr/bin/security');
  assert.ok(sec.length >= 1);
  for (const c of sec) {
    assert.deepEqual(c.args.slice(0, 2), ['find-generic-password', '-s']);
    assert.ok(!c.args.includes('-w') && !c.args.includes('-g'));
    assert.notEqual(c.opts.capture, true);
  }
  assert.ok(!JSON.stringify(v).includes(SECRET));
  // relevé d'un autre compte (après changement de connexion) : ignoré
  wj(path.join(HOME, '.claude.json'), { ...MAIN_JSON, cachedUsageUtilization: { ...MAIN_JSON.cachedUsageUtilization, accountUuid: 'autre' } });
  assert.equal(A.summaries()[0].usage.session, null);
  wj(path.join(HOME, '.claude.json'), MAIN_JSON);
});

test('créer un compte : dossier, liens vers ~/.claude, .claude.json sans connexion ni caches', () => {
  const r = A.create('Travail 2');
  assert.equal(r.ok, true);
  const dir = path.join(ACC, 'travail2');
  assert.deepEqual(r.account, { id: 'travail2', label: 'Travail 2', configDir: dir, keychainItem: keychainItem(dir), dirReady: true });
  assert.equal(r.mcpCopied, true);
  const state = Object.fromEntries(r.links.map((l) => [l.name, l.state]));
  for (const e of SHARED) {
    const p = path.join(dir, e.name);
    if (['todos', 'agents', 'commands'].includes(e.name)) {
      assert.equal(state[e.name], 'absent', e.name);
      assert.equal(fs.existsSync(p), false, `${e.name} : pas de lien de dossier dans le vide`);
    } else {
      assert.equal(state[e.name], 'created', e.name);
      assert.ok(fs.lstatSync(p).isSymbolicLink(), e.name);
      assert.equal(fs.readlinkSync(p), path.join(HOME, '.claude', e.name));
    }
  }
  // Claude Code efface un dossier partagé de ~/.claude (ménage) : le lien est réparé en le recréant vide, sans alerte
  fs.rmSync(path.join(HOME, '.claude', 'shell-snapshots'), { recursive: true });
  const h = A.health();
  assert.deepEqual(h.notices, []);
  assert.equal(h.accounts.find((a) => a.id === 'travail2').links.find((l) => l.name === 'shell-snapshots').state, 'created');
  assert.ok(fs.statSync(path.join(dir, 'shell-snapshots')).isDirectory(), 'le lien mène de nouveau à un dossier');
  // CLAUDE.md absent de ~/.claude : lien de fichier quand même (écrire à travers le crée dans ~/.claude)
  assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
  const cjPath = path.join(dir, '.claude.json');
  assert.equal(fs.statSync(cjPath).mode & 0o777, 0o600);
  const cj = rj(cjPath);
  assert.deepEqual(Object.keys(cj).sort(), ['mcpServers', 'projects']);
  assert.deepEqual(cj.mcpServers, MAIN_JSON.mcpServers);
  assert.deepEqual(cj.projects, {
    '/Users/alex/Code/atelier': {
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, enabledMcpjsonServers: ['supabase'],
      mcpServers: { 'figma-desktop': { type: 'http', url: 'http://127.0.0.1:3845/mcp' } }, disabledMcpServers: ['paddle-live'],
    },
  });
  const model = rj(path.join(DATA, 'accounts.json'));
  assert.deepEqual(model.accounts.map((a) => [a.id, a.configDir]), [['travail1', null], ['travail2', dir]]);
  // nom de l'entrée de trousseau recopié pour le lanceur (qui vérifie qu'elle existe), jamais pour Travail 1
  assert.deepEqual(model.accounts.map((a) => a.keychainItem), [undefined, keychainItem(dir)]);
  assert.equal(model.defaultForNew, 'travail1');
  // noms : unicité, accents, vide
  assert.equal(A.create('Travail 2').account.id, 'travail2-2');
  assert.equal(A.create('Été perso').account.id, 'eteperso');
  assert.equal(A.create('Travail 1').account.id, 'travail1-2');
  assert.deepEqual(A.create('   '), { ok: false, error: 'Donne un nom au compte.' });
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('créer sur un dossier déjà connecté : on l\'adopte sans rien écraser', () => {
  const dir = path.join(ACC, 'perso');
  wj(path.join(dir, '.claude.json'), { oauthAccount: { emailAddress: 'perso@exemple.test', accountUuid: 'uuid-p' } });
  const r = A.create('Perso');
  assert.equal(r.account.configDir, dir);
  assert.equal(r.mcpCopied, false);
  assert.equal(rj(path.join(dir, '.claude.json')).oauthAccount.emailAddress, 'perso@exemple.test');
});

test('connexion et jauges d\'un compte : oauthAccount + entrée de trousseau ; RunCat en secours', () => {
  let t2 = A.summaries().find((a) => a.id === 'travail2');
  assert.deepEqual([t2.connected, t2.email], [false, null]);
  assert.deepEqual(t2.usage, { session: null, week: null, weekModel: null, observedAt: null, source: null });
  const dir = path.join(ACC, 'travail2');
  const cj = rj(path.join(dir, '.claude.json'));
  wj(path.join(dir, '.claude.json'), { ...cj, oauthAccount: { emailAddress: 'travail2@exemple.test', accountUuid: 'uuid-t2' } });
  assert.equal(A.summaries().find((a) => a.id === 'travail2').connected, false, 'pas encore d\'entrée de trousseau');
  runner.keychain.add(keychainItem(dir));
  wj(RUNCAT, { accounts: {
    'uuid-t2': { email: 'travail2@exemple.test', fetchedAt: NOW / 1000 - 30, limits: [
      { key: 'session', label: 'session', percent: 100, resets_at: `${at(2)}.762026+00:00`, severity: 'critical' },
      // déjà remise à zéro (relevé ancien) : plus montrée, son 39 % ne dit plus rien
      { key: 'weekly_all', label: 'hebdo', percent: 39, resets_at: '2026-09-07T18:00:00.762073+00:00', severity: 'normal' },
      { key: 'weekly:Fable', label: 'hebdo Fable', percent: 55, resets_at: null, severity: 'normal' },
    ] },
    'uuid-t1': { fetchedAt: (NOW - 3_600_000) / 1000, limits: [{ key: 'session', percent: 1, resets_at: null }] },
  } });
  t2 = A.summaries().find((a) => a.id === 'travail2');
  assert.deepEqual([t2.connected, t2.email], [true, 'travail2@exemple.test']);
  assert.deepEqual(t2.usage, {
    session: { pct: 100, resetsAt: `${at(2)}.762Z` },
    week: null,
    weekModel: { label: 'Fable', pct: 55, resetsAt: null },
    observedAt: new Date(NOW - 30_000).toISOString(),
    source: 'session',
  });
  // Travail 1 garde son relevé plus récent que celui de RunCat
  assert.equal(A.summaries()[0].usage.session.pct, 68);
});

// --- relevés d'usage : jamais périmés ; requête minimale (faux binaire) ---
test('jamais de relevé périmé : plus de 6 h ou remise à zéro passée = « — »', () => {
  const t1 = path.join(HOME, '.claude.json');
  const cj = rj(t1);
  // relevé de la session vieux de 7 h : écarté ; RunCat (1 h, session 1 %) prend le relais
  wj(t1, { ...cj, cachedUsageUtilization: { ...cj.cachedUsageUtilization, fetchedAtMs: Date.now() - 7 * 3_600_000 } });
  assert.deepEqual(A.summaries()[0].usage, { session: { pct: 1, resetsAt: null }, week: null, weekModel: null, observedAt: new Date(NOW - 3_600_000).toISOString(), source: 'session' });
  // plus rien de valable
  const rc = rj(RUNCAT);
  wj(RUNCAT, { accounts: { 'uuid-t2': rc.accounts['uuid-t2'] } });
  assert.deepEqual(A.summaries()[0].usage, { session: null, week: null, weekModel: null, observedAt: null, source: null });
  // relevé récent mais toutes ses fenêtres déjà remises à zéro : rien non plus
  const past = '2026-01-01T00:00:00+00:00';
  wj(t1, { ...cj, cachedUsageUtilization: { fetchedAtMs: Date.now() - 60_000, accountUuid: 'uuid-t1', utilization: { limits: [{ kind: 'session', percent: 99, resets_at: past }, { kind: 'weekly_all', percent: 80, resets_at: past }] } } });
  assert.equal(A.summaries()[0].usage.source, null);
  wj(t1, cj);
  wj(RUNCAT, rc);
});

test('relevé par requête minimale : faux binaire, compte et options vérifiés, Fable gardé, au plus une fois par minute', async () => {
  const fake = path.join(TMP, 'faux claude', 'claude');
  const log = path.join(TMP, 'faux claude', 'appels.jsonl');
  const mode = path.join(TMP, 'faux claude', 'mode');
  w(fake, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR || null, cwd: process.cwd() }) + '\\n');
if (fs.existsSync(${JSON.stringify(mode)}) && fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() === 'panne') process.exit(1);
const t = Math.floor(Date.now() / 1000);
console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: t + 7200 }, seven_day: { utilization: 0.1, resetsAt: t + 3 * 86400 } } } }));
console.log(JSON.stringify({ type: 'result', result: '.' }));
`, 0o755);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  // Perso devient connecté : aucun relevé encore
  const perso = path.join(ACC, 'perso');
  runner.keychain.add(keychainItem(perso));
  const P = createAccounts({ ...opts, claudeBin: fake });
  assert.equal(P.summaries().find((a) => a.id === 'perso').usage.source, null);
  // relevé automatique : seulement les comptes connectés sans relevé récent (Travail 1 et 2 en ont un)
  assert.deepEqual(P.autoRefresh(), ['perso']);
  await P.refreshSettled();
  const [c1] = calls();
  assert.equal(c1.dir, perso);
  assert.equal(fs.realpathSync(c1.cwd), fs.realpathSync(os.tmpdir()));
  for (const a of ['-p', '--model', 'haiku', '--max-turns', '--strict-mcp-config', '--setting-sources', '--tools', '--no-session-persistence']) assert.ok(c1.args.includes(a), a);
  assert.equal(c1.args[c1.args.indexOf('--setting-sources') + 1], '', 'ni réglages ni hooks');
  assert.equal(c1.args[c1.args.indexOf('--tools') + 1], '', 'aucun outil');
  const u = P.summaries().find((a) => a.id === 'perso').usage;
  assert.deepEqual([u.source, u.session.pct, u.week.pct, u.weekModel], ['ping', 42, 10, null]);
  assert.ok(Date.parse(u.session.resetsAt) > Date.now());
  assert.deepEqual(P.autoRefresh(), [], 'relevé frais : rien à faire');
  // « Actualiser » : Travail 1 relevé tout de suite, sa semaine Fable (vraie session) gardée
  const r = P.apply({ action: 'refresh', id: 'travail1' });
  assert.deepEqual([r.ok, r.started], [true, ['travail1']]);
  await P.refreshSettled();
  assert.equal(calls().at(-1).dir, null, 'Travail 1 : sans CLAUDE_CONFIG_DIR');
  const u1 = P.summaries()[0].usage;
  assert.deepEqual([u1.source, u1.session.pct, u1.weekModel?.label, u1.weekModel?.pct], ['ping', 42, 'Fable', 55]);
  // un clic répété dans la minute ne relance rien
  assert.deepEqual(P.apply({ action: 'refresh', id: 'travail1' }).started, []);
  assert.match(P.apply({ action: 'refresh', id: 'travail1' }).message, /moins d'une minute/);
  // refus clairs
  assert.deepEqual(P.apply({ action: 'refresh', id: 'inconnu' }), { ok: false, error: 'Compte inconnu.' });
  assert.deepEqual(P.apply({ action: 'refresh', id: 'eteperso' }), { ok: false, error: 'Ce compte n\'est pas connecté.' });
  // panne du binaire : aucun relevé écrit, rien ne casse
  fs.writeFileSync(mode, 'panne');
  const Q = createAccounts({ ...opts, claudeBin: fake });
  fs.rmSync(path.join(DATA, 'usage', 'perso.json'));
  assert.deepEqual(Q.apply({ action: 'refresh', id: 'perso' }).started, ['perso']);
  await Q.refreshSettled();
  assert.equal(Q.summaries().find((a) => a.id === 'perso').usage.source, null);
  // sans binaire connu (dossier perso de test, pas de VIGIE_CLAUDE_BIN) : jamais de requête
  const n = calls().length;
  assert.deepEqual(A.autoRefresh(), []);
  assert.deepEqual(A.apply({ action: 'refresh' }), { ok: false, error: 'Claude Code introuvable : relevé impossible.' });
  assert.equal(calls().length, n);
  // aucun secret dans ce qui est montré
  assert.ok(!JSON.stringify(P.view()).includes(SECRET));
  fs.rmSync(path.join(DATA, 'usage'), { recursive: true, force: true });
  runner.keychain.delete(keychainItem(perso));
});

test('santé : lien remplacé par un fichier, mauvais lien, dossiers propres au compte', () => {
  const dir = path.join(ACC, 'travail2');
  const cl = path.join(HOME, '.claude');
  // Claude Code a réécrit settings.json par renommage : un vrai fichier à la place du lien
  fs.unlinkSync(path.join(dir, 'settings.json'));
  wj(path.join(dir, 'settings.json'), { permissions: { allow: ['Bash(ls)'] } });
  // un lien qui pointe ailleurs
  fs.unlinkSync(path.join(dir, 'plans'));
  fs.mkdirSync(path.join(TMP, 'ailleurs'));
  fs.symlinkSync(path.join(TMP, 'ailleurs'), path.join(dir, 'plans'));
  // un dossier rempli par le compte alors que ~/.claude n'en a pas
  w(path.join(dir, 'agents', 'mon-agent.md'), '# agent');
  // un dossier vide créé par le compte alors que ~/.claude en a un
  fs.mkdirSync(path.join(cl, 'todos'));
  fs.mkdirSync(path.join(dir, 'todos'));
  // un dossier d'historique rempli par le compte : on n'y touche pas
  fs.unlinkSync(path.join(dir, 'file-history'));
  w(path.join(dir, 'file-history', 'x', 'v1'), 'contenu');
  // ~/.claude gagne un dossier commands : le lien suit
  fs.mkdirSync(path.join(cl, 'commands'));

  const dry = A.health({ repair: false });
  assert.equal(dry.ok, false);
  assert.equal(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), false, 'sans réparation, rien ne bouge');

  const h = A.health();
  const t2 = h.accounts.find((a) => a.id === 'travail2');
  const st = Object.fromEntries(t2.links.map((l) => [l.name, l]));
  assert.equal(st['settings.json'].state, 'relinked');
  assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink());
  assert.deepEqual(rj(st['settings.json'].backup), { permissions: { allow: ['Bash(ls)'] } }, 'copie gardée, rien de fusionné');
  assert.deepEqual(rj(path.join(cl, 'settings.json')).permissions, { defaultMode: 'auto' });
  assert.equal(st.plans.state, 'relinked');
  assert.equal(fs.readlinkSync(path.join(dir, 'plans')), path.join(cl, 'plans'));
  assert.equal(st.agents.state, 'separate');
  assert.ok(fs.existsSync(path.join(dir, 'agents', 'mon-agent.md')));
  assert.equal(st.todos.state, 'relinked');
  assert.equal(st['file-history'].state, 'separate');
  assert.equal(fs.readFileSync(path.join(dir, 'file-history', 'x', 'v1'), 'utf8'), 'contenu');
  assert.equal(st.commands.state, 'created');
  assert.equal(t2.ready, true);
  assert.equal(h.ok, false);
  assert.ok(h.notices.some((n) => n.includes('settings.json') && n.includes('copie gardée')));
  assert.ok(h.notices.some((n) => n.includes('agents')));
  // remise en ordre pour la suite
  fs.rmSync(path.join(dir, 'file-history'), { recursive: true });
  fs.rmSync(path.join(dir, 'agents'), { recursive: true });
  A.health();
});

test('compte par défaut et renommage', () => {
  assert.deepEqual(A.setDefault('inconnu'), { ok: false, error: 'Compte inconnu.' });
  const p = A.setDefault('eteperso');
  assert.equal(p.ok, true);
  assert.match(p.message, /Pas encore connecté/);
  assert.deepEqual(A.setDefault('travail2'), { ok: true, message: null });
  assert.equal(A.view().defaultForNew, 'travail2');
  assert.equal(A.view().accounts.find((a) => a.id === 'travail2').isDefault, true);
  const before = A.view().accounts.find((a) => a.id === 'travail2');
  assert.deepEqual(A.rename('travail2', 'Boulot 2'), { ok: true });
  const after = A.view().accounts.find((a) => a.id === 'travail2');
  assert.equal(after.label, 'Boulot 2');
  assert.equal(after.configDir, before.configDir, 'le dossier ne change jamais');
  assert.deepEqual(A.rename('travail2', ''), { ok: false, error: 'Donne un nom au compte.' });
  A.rename('travail2', 'Travail 2');
  A.setDefault('travail1');
});

test('JSONC : lecture et écriture qui gardent commentaires et mise en forme', () => {
  assert.deepEqual(parseJsonc('// x\n{ "a": 1, /* b */ "b": [1, 2,], "c": "//pas un commentaire", }'), { a: 1, b: [1, 2], c: '//pas un commentaire' });
  assert.deepEqual(parseJsonc(''), {});
  assert.throws(() => parseJsonc('{ "a": }'));
  const strict = '{\n    "a": 1,\n    "b": true\n}';
  const on = setJsoncKey(strict, 'k', '/x y');
  assert.equal(on, '{\n    "a": 1,\n    "b": true,\n    "k": "/x y"\n}');
  assert.equal(setJsoncKey(on, 'k', undefined), strict);
  assert.equal(setJsoncKey(on, 'k', '/z'), '{\n    "a": 1,\n    "b": true,\n    "k": "/z"\n}');
  assert.equal(setJsoncKey('{}', 'k', 1), '{\n    "k": 1\n}');
  assert.deepEqual(parseJsonc(setJsoncKey('{ // rien\n}', 'k', 1)), { k: 1 });
  assert.ok(setJsoncKey('{ // rien\n}', 'k', 1).includes('// rien'));
  assert.deepEqual(parseJsonc(setJsoncKey('{"a":1}', 'k', 2)), { a: 1, k: 2 });
  assert.equal(setJsoncKey(setJsoncKey('{"a":1}', 'k', 2), 'k', undefined), '{"a":1}');
  assert.equal(setJsoncKey('{\n  "a": 1 // note\n}', 'k', 2), '{\n  "a": 1, // note\n  "k": 2\n}');
  assert.equal(setJsoncKey('{\n  "k": 1,\n  "k": 2\n}', 'k', undefined), '{\n}');
  assert.equal(setJsoncKey('{"k": 1, "a": 2}', 'k', undefined), '{"a": 2}');
  assert.equal(setJsoncKey('{"a": 2, "k": 1}', 'k', undefined), '{"a": 2}');
  assert.equal(setJsoncKey('{\n  "a": 1, // garde\n  // à propos de k\n  "k": 2\n}', 'k', undefined), '{\n  "a": 1 // garde\n  // à propos de k\n}');
});

test('activer le lanceur dans VS Code : sauvegarde, commentaires gardés, aller-retour exact', () => {
  const original = '// Réglages de l\'utilisateur\n{\n    "editor.fontSize": 13, // taille\n    /* bloc */\n    "files.exclude": { "**/.git": true, },\n    "workbench.colorTheme": "Default Dark+",\n}\n';
  w(VSC, original);
  const r = A.wrapper(true);
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original);
  const text = fs.readFileSync(VSC, 'utf8');
  for (const c of ['// Réglages de l\'utilisateur', '// taille', '/* bloc */']) assert.ok(text.includes(c), c);
  const parsed = parseJsonc(text);
  assert.equal(parsed[WRAPPER_KEY], WRAP);
  assert.deepEqual({ ...parsed, [WRAPPER_KEY]: undefined }, { ...parseJsonc(original), [WRAPPER_KEY]: undefined });
  assert.equal(A.wrapperActive(), true);
  assert.equal(A.view().wrapper.active, true);
  const again = A.wrapper(true);
  assert.deepEqual([again.ok, again.active, again.message], [true, true, 'Déjà activé.']);
  const off = A.wrapper(false);
  assert.deepEqual([off.ok, off.active], [true, false]);
  assert.equal(fs.readFileSync(VSC, 'utf8'), original);
  assert.equal(A.wrapperActive(), false);
  // fichier strict de l'utilisateur, sans retour à la ligne final
  const userSettings = '{\n    "editor.fontSize": 13,\n    "workbench.colorTheme": "Default Dark+"\n}';
  w(VSC, userSettings);
  A.wrapper(true);
  assert.equal(JSON.parse(fs.readFileSync(VSC, 'utf8'))[WRAPPER_KEY], WRAP, 'reste du JSON strict');
  A.wrapper(false);
  assert.equal(fs.readFileSync(VSC, 'utf8'), userSettings);
});

test('lanceur : cas où l\'on ne touche à rien', () => {
  // un autre lanceur déjà réglé
  const other = '{\n    "claudeCode.claudeProcessWrapper": "/ailleurs/lanceur"\n}';
  w(VSC, other);
  assert.equal(A.wrapper(true).ok, false);
  assert.match(A.wrapper(false).message, /pas le lanceur de Vigie/);
  assert.equal(fs.readFileSync(VSC, 'utf8'), other);
  // réglages illisibles
  w(VSC, '{ "a": ');
  assert.deepEqual(A.wrapper(true), { ok: false, error: 'Réglages VS Code illisibles : rien n\'a été changé.' });
  assert.equal(fs.readFileSync(VSC, 'utf8'), '{ "a": ');
  // lanceur absent ou non exécutable
  w(VSC, '{}');
  const B = createAccounts({ ...opts, wrapperPath: path.join(TMP, 'lanceur-absent') });
  assert.deepEqual(B.wrapper(true), { ok: false, error: 'Lanceur introuvable.' });
  // réglages absents : créés ; lien symbolique : on écrit la cible
  fs.rmSync(VSC);
  assert.equal(A.wrapper(true).ok, true);
  assert.equal(parseJsonc(fs.readFileSync(VSC, 'utf8'))[WRAPPER_KEY], WRAP);
  A.wrapper(false);
  const real = path.join(TMP, 'vscode', 'vrai-settings.json');
  w(real, '{\n    "a": 1\n}');
  fs.rmSync(VSC);
  fs.symlinkSync(real, VSC);
  A.wrapper(true);
  assert.ok(fs.lstatSync(VSC).isSymbolicLink());
  assert.equal(parseJsonc(fs.readFileSync(real, 'utf8'))[WRAPPER_KEY], WRAP);
  A.wrapper(false);
  fs.rmSync(VSC);
  w(VSC, '{\n    "editor.fontSize": 13\n}');
});

test('connecter : Terminal sur le bon dossier, rien d\'automatique', () => {
  runner.calls.length = 0;
  const r = A.connect('travail2');
  assert.deepEqual(r, { ok: true, message: 'Terminal est ouvert : tape /login.' });
  const call = runner.calls.find((c) => c.cmd === '/usr/bin/osascript');
  const lines = call.args.filter((_, i) => i % 2 === 1);
  assert.deepEqual(call.args.filter((_, i) => i % 2 === 0), ['-e', '-e', '-e', '-e']);
  assert.equal(lines[0], 'tell application "Terminal"');
  const lit = lines.find((l) => l.startsWith('do script ')).slice('do script '.length);
  const cmd = lit.slice(1, -1).replace(/\\(["\\])/g, '$1'); // chaîne AppleScript -> commande shell
  assert.ok(cmd.endsWith(`CLAUDE_CONFIG_DIR='${path.join(ACC, 'travail2')}' claude`), cmd);
  assert.match(cmd, /\/login/);
  assert.equal(spawnSync('/bin/bash', ['-n', '-c', cmd]).status, 0, 'commande shell valide');
  // Travail 1 : sans CLAUDE_CONFIG_DIR ; un nom avec apostrophe reste bien échappé
  A.rename('travail1', "L'atelier \"1\"");
  runner.calls.length = 0;
  A.connect('travail1');
  const c1 = runner.calls.find((c) => c.cmd === '/usr/bin/osascript').args.find((a) => a.startsWith('do script '));
  const cmd1 = c1.slice('do script '.length).slice(1, -1).replace(/\\(["\\])/g, '$1');
  assert.ok(!cmd1.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(cmd1.endsWith('; claude'));
  assert.equal(spawnSync('/bin/bash', ['-n', '-c', cmd1]).status, 0);
  A.rename('travail1', 'Travail 1');
  // osascript refusé : fichier .command ouvert dans Terminal
  runner.osascript = 1;
  runner.calls.length = 0;
  assert.equal(A.connect('travail2').ok, true);
  const open = runner.calls.find((c) => c.cmd === '/usr/bin/open');
  assert.deepEqual(open.args.slice(0, 2), ['-a', 'Terminal']);
  assert.match(fs.readFileSync(open.args[2], 'utf8'), /CLAUDE_CONFIG_DIR=/);
  runner.osascript = 0;
  assert.deepEqual(A.connect('inconnu'), { ok: false, error: 'Compte inconnu.' });
});

test('connecter sans Claude Code utilisable : Terminal tout de suite ; copie de l\'extension nommée en entier', () => {
  runner.calls.length = 0;
  const none = createAccounts({ ...opts, claudeBin: null });
  assert.deepEqual(none.connect('travail2'), { ok: true, message: 'Terminal est ouvert : tape /login.' });
  assert.equal(runner.calls.some((c) => /claude$/.test(c.cmd)), false, 'rien de lancé en silence');
  const ext = '/Users/x/.vscode/extensions/anthropic.claude-code-2.1.304-darwin-arm64/resources/native-binary/claude';
  runner.login = 1; // la page ne s'ouvre pas : repli Terminal
  runner.calls.length = 0;
  createAccounts({ ...opts, claudeBin: ext }).connect('travail2');
  const lit = runner.calls.find((c) => c.cmd === '/usr/bin/osascript').args.find((a) => a.startsWith('do script '));
  assert.ok(lit.includes(`'${ext}'`), 'la commande de l\'extension, pas « claude » (absent du PATH)');
  runner.login = undefined;
});

// --- bascule ---
const SID = 'b1b9b451-c53c-439e-b804-3689257268e3';
const SID2 = '46536060-8c84-46cc-872f-0a0df63ba2a6';
const PID = 424242;
const PROC_START = 'Mon Oct 19 22:07:54 2026';
const REG = path.join(HOME, '.claude', 'sessions');
function liveEntry(extra = {}) {
  const e = { pid: PID, sessionId: SID, cwd: '/Users/alex/Code/atelier', status: 'idle', procStart: PROC_START, startedAt: NOW - 3_600_000, statusUpdatedAt: Date.now() - 10_000, kind: 'interactive', entrypoint: 'claude-vscode', ...extra };
  wj(path.join(REG, `${e.pid}.json`), e);
  return e;
}
function proc(comm = '/Users/alex/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude', lstartUtc = `${PROC_START}    `) {
  runner.procs.set(PID, { comm, lstartUtc });
}
const vigieModel = () => rj(path.join(DATA, 'accounts.json'));

test('bascule : refus clairs', () => {
  assert.deepEqual(A.switchConversation('pas-un-id', 'travail2'), { ok: false, error: 'Conversation inconnue.' });
  assert.deepEqual(A.switchConversation(SID, 'inconnu'), { ok: false, error: 'Compte inconnu.' });
  assert.deepEqual(A.switchConversation(SID, 'eteperso'), { ok: false, error: 'Été perso n\'est pas connecté.' });
  assert.equal(A.accountOf(SID), 'travail1');
});

test('bascule d\'une conversation fermée : noté pour la prochaine reprise', () => {
  const r = A.switchConversation(SID, 'travail2', { liveSessions: [], contextTokens: 152_340 });
  assert.deepEqual(r, { ok: true, switch: { state: 'done', message: 'C\'est noté : elle reprendra sur Travail 2. ≈ 152 k tokens relus sur le nouveau compte.', estimate: '≈ 152 k tokens relus sur le nouveau compte.' } });
  assert.equal(A.accountOf(SID), 'travail2');
  assert.equal(vigieModel().sessions[SID], 'travail2');
  assert.deepEqual(kills, []);
});

test('bascule sans lanceur actif : choix noté, aucun processus arrêté', () => {
  const live = liveEntry();
  proc();
  const r = A.switchConversation(SID, 'travail1', { liveSessions: new Map([[SID, live]]) });
  assert.equal(r.switch.state, 'done');
  assert.match(r.switch.message, /Active le choix du compte/);
  assert.deepEqual(kills, []);
});

test('bascule au repos : processus vérifié puis arrêté, message pour relancer', () => {
  A.wrapper(true);
  const live = liveEntry();
  proc();
  const r = A.switchConversation(SID, 'travail2', { liveSessions: new Map([[SID, live]]), contextTokens: 152_340 });
  assert.equal(r.switch.state, 'done');
  assert.equal(r.switch.message, 'Envoie un message dans la conversation pour la relancer sur Travail 2. ≈ 152 k tokens relus sur le nouveau compte.');
  assert.deepEqual(kills, [[PID, 'SIGINT']]);
  // ps interrogé en UTC pour comparer avec procStart
  const ls = runner.calls.filter((c) => c.cmd === '/bin/ps' && c.args[1] === 'lstart=');
  assert.ok(ls.length && ls.every((c) => c.opts.env?.TZ === 'UTC'));
  kills.length = 0;
});

test('bascule : jamais d\'arrêt si le processus n\'est pas le bon', () => {
  const cases = [
    ['registre d\'une autre conversation', () => { liveEntry(); wj(path.join(REG, `${PID}.json`), { pid: PID, sessionId: SID2, status: 'idle', procStart: PROC_START, entrypoint: 'claude-vscode' }); proc(); }],
    ['registre : pas une conversation VS Code', () => { liveEntry({ entrypoint: 'cli' }); proc(); }],
    ['registre : plus au repos', () => { liveEntry({ status: 'busy' }); proc(); }],
    ['pas un processus claude', () => { liveEntry(); proc('/usr/bin/vim'); }],
    ['pid recyclé (démarrage différent)', () => { liveEntry(); proc(undefined, 'Tue Oct 20 09:00:00 2026'); }],
    ['processus disparu', () => { liveEntry(); runner.procs.delete(PID); }],
    ['registre absent', () => { fs.rmSync(path.join(REG, `${PID}.json`), { force: true }); proc(); }],
  ];
  for (const [name, setup] of cases) {
    A.switchConversation(SID, 'travail1', { liveSessions: [] });
    setup();
    // sans ligne du lanceur, le processus est réputé tourner sur Travail 1 : on vise Travail 2
    const live = { pid: PID, sessionId: SID, status: 'idle', procStart: PROC_START, statusUpdatedAt: Date.now() - 10_000, entrypoint: 'claude-vscode' };
    const r = A.switchConversation(SID, 'travail2', { liveSessions: [live] });
    assert.equal(r.switch.state, 'pending', name);
    assert.deepEqual(kills, [], name);
  }
  liveEntry();
  proc();
});

test('bascule pendant le travail : en attente, appliquée dès le repos', () => {
  A.switchConversation(SID, 'travail1', { liveSessions: [] }); // point de départ connu
  // sans ligne du lanceur, le processus tourne sur Travail 1
  let live = liveEntry({ status: 'busy' });
  const r = A.switchConversation(SID, 'travail2', { liveSessions: [live], contextTokens: 80_000 });
  assert.deepEqual(r.switch, { state: 'pending', message: 'Elle passera sur Travail 2 dès qu\'elle aura fini. ≈ 80 k tokens relus sur le nouveau compte.', estimate: '≈ 80 k tokens relus sur le nouveau compte.' });
  assert.deepEqual(A.sessionAccount(SID), { accountId: 'travail2', pendingTo: 'travail2' });
  assert.deepEqual(A.processPending([live]).applied, []);
  // au repos depuis moins de 2 s : on attend encore
  live = liveEntry({ status: 'idle', statusUpdatedAt: Date.now() });
  assert.deepEqual(A.processPending([live]).applied, []);
  // agents encore en cours : on attend
  live = liveEntry({ status: 'idle' });
  assert.deepEqual(A.processPending([{ ...live, agentsRunning: 2 }]).applied, []);
  assert.deepEqual(kills, []);
  const done = A.processPending([live]);
  assert.deepEqual(done.applied, [{ sessionId: SID, to: 'travail2', state: 'done', message: 'Envoie un message dans la conversation pour la relancer sur Travail 2.' }]);
  assert.deepEqual(kills, [[PID, 'SIGINT']]);
  assert.deepEqual(vigieModel().pendingSwitches, {});
  assert.equal(A.accountOf(SID), 'travail2');
  kills.length = 0;
  // conversation fermée avant le repos : la prochaine reprise suffit
  A.switchConversation(SID, 'travail2', { liveSessions: [liveEntry({ status: 'busy' })] });
  const closed = A.processPending([]);
  assert.equal(closed.applied[0].state, 'closed');
  assert.deepEqual(vigieModel().pendingSwitches, {});
  // lanceur coupé entre-temps : l'attente tombe
  A.switchConversation(SID, 'travail2', { liveSessions: [liveEntry({ status: 'busy' })] });
  assert.equal(Object.keys(vigieModel().pendingSwitches).length, 1);
  A.wrapper(false);
  assert.deepEqual(A.processPending([liveEntry({ status: 'idle' })]).applied, []);
  assert.deepEqual(vigieModel().pendingSwitches, {});
  assert.deepEqual(kills, []);
  A.wrapper(true);
});

test('bascule : jamais pendant des commandes de fond (Bash en fond, Monitor, serveur de dev)', () => {
  A.switchConversation(SID, 'travail1', { liveSessions: [] }); // point de départ connu
  proc();
  let live = liveEntry({ status: 'idle' });
  runner.children.set(PID, [5001, 5002]); // deux shells de commandes de fond sous le processus
  runner.procs.set(5001, { comm: '/bin/zsh', lstartUtc: '' });
  runner.procs.set(5002, { comm: '/bin/zsh', lstartUtc: '' });
  runner.calls.length = 0;
  const r = A.switchConversation(SID, 'travail2', { liveSessions: [live] });
  assert.equal(r.switch.state, 'pending');
  assert.match(r.switch.message, /^Elle passera sur Travail 2 quand ses commandes de fond \(serveur, tests…\) seront finies\./);
  assert.deepEqual(runner.calls.find((c) => c.cmd === '/usr/bin/pgrep').args, ['-P', String(PID)]);
  assert.deepEqual(A.processPending([live]).applied, []);
  // une seule finie : on attend encore
  runner.children.set(PID, [5002]);
  assert.deepEqual(A.processPending([live]).applied, []);
  // impossible de savoir (pgrep en échec) : on ne coupe pas
  runner.pgrepFails = true;
  assert.deepEqual(A.processPending([live]).applied, []);
  runner.pgrepFails = false;
  assert.deepEqual(kills, []);
  // toutes finies : la bascule se fait
  runner.children.set(PID, []);
  live = liveEntry({ status: 'idle' });
  assert.equal(A.processPending([live]).applied[0]?.state, 'done');
  assert.deepEqual(kills, [[PID, 'SIGINT']]);
  kills.length = 0;
});

test('bascule : un MCP sous la conversation et un transcript resté « en cours » ne bloquent plus', () => {
  A.switchConversation(SID, 'travail1', { liveSessions: [] }); // point de départ connu
  proc();
  const live = liveEntry({ status: 'idle', statusUpdatedAt: Date.now() - 10_000 });
  runner.children.set(PID, [5003]);
  runner.procs.set(5003, { comm: '/opt/homebrew/bin/python3', lstartUtc: '' }); // serveur MCP stdio
  kills.length = 0;
  const r = A.switchConversation(SID, 'travail2', { liveSessions: [{ ...live, bgRunning: 1 }] });
  assert.equal(r.switch?.state, 'done', JSON.stringify(r));
  assert.deepEqual(kills, [[PID, 'SIGINT']]);
  // « tout de suite » : même en plein travail
  kills.length = 0;
  A.switchConversation(SID, 'travail1', { liveSessions: [] });
  const busy = liveEntry({ status: 'busy' });
  runner.children.set(PID, [5001]);
  runner.procs.set(5001, { comm: '/bin/zsh', lstartUtc: '' });
  assert.equal(A.switchConversation(SID, 'travail2', { liveSessions: [busy] }).switch.state, 'pending');
  assert.deepEqual(kills, []);
  assert.match(A.switchConversation(SID, 'travail2', { liveSessions: [busy], now: true }).switch.message, /^Interrompue/);
  assert.deepEqual(kills, [[PID, 'SIGINT']]);
  runner.children.delete(PID);
  kills.length = 0;
});

test('bascule : arrêt propre (SIGINT), la conversation reste « à relancer » jusqu\'à sa reprise', () => {
  A.switchConversation(SID, 'travail1', { liveSessions: [] });
  proc();
  kills.length = 0;
  const live = liveEntry({ status: 'idle', statusUpdatedAt: Date.now() - 10_000, startedAt: Date.now() - 3_600_000 });
  const r = A.switchConversation(SID, 'travail2', { liveSessions: [live] });
  assert.equal(r.switch?.state, 'done', JSON.stringify(r));
  assert.deepEqual(kills, [[PID, 'SIGINT']], 'SIGINT : Claude Code sort avec le code 0, sans bandeau d\'erreur');
  assert.equal(A.stoppedFor(SID)?.to, 'travail2');
  // toujours arrêtée : elle reste à relancer
  A.processPending([]);
  assert.equal(A.stoppedFor(SID)?.to, 'travail2');
  // relancée (nouveau processus) : plus rien à signaler
  A.processPending([liveEntry({ status: 'busy', startedAt: Date.now() })]);
  assert.equal(A.stoppedFor(SID), null);
  kills.length = 0;
});

test('conversation ouverte dans le terminal : choix noté, jamais arrêtée', () => {
  A.switchConversation(SID, 'travail1', { liveSessions: [] });
  proc();
  const r = A.switchConversation(SID, 'travail2', { liveSessions: [liveEntry({ entrypoint: 'cli' })] });
  assert.deepEqual([r.switch.state, r.switch.message], ['done', 'C\'est noté : elle reprendra sur Travail 2.']);
  assert.deepEqual(vigieModel().pendingSwitches, {});
  assert.deepEqual(kills, []);
});

test('fichiers du lanceur : conversations neuves épinglées, « déjà sur ce compte », ménage', () => {
  const NEW = '9ff7a127-4444-4555-8666-c77788889999';
  const OLD = 'aa08b238-5555-4666-8777-d8889999aaaa';
  const t = Math.floor(NOW / 1000);
  const L = path.join(DATA, 'launches'); // pids > 99999 : n'existent pas sur macOS
  w(path.join(L, String(PID + 1)), `${t - 7200}\t${PID + 1}\ttravail2\t-\tnouvelle\n`); // pid recyclé depuis
  w(path.join(L, String(PID + 2)), `${t}\t${PID + 2}\ttravail2\t-\tnouvelle\n`);
  w(path.join(L, String(PID + 3)), `${t}\t${PID + 3}\tdisparu\t-\tnouvelle\n`);
  w(path.join(L, String(PID + 4)), 'ligne abîmée\n');
  w(path.join(L, String(PID)), `${t}\t${PID}\ttravail2\t${SID}\tchoisi\n`);
  // le fichier du lanceur dit que le processus tourne déjà sur Travail 2 : rien à arrêter
  A.switchConversation(SID, 'travail1', { liveSessions: [] });
  proc();
  const sw = A.switchConversation(SID, 'travail2', { liveSessions: [liveEntry({ startedAt: NOW })] });
  assert.equal(sw.switch.message, 'Elle est déjà sur Travail 2.');
  assert.deepEqual(kills, []);
  const live = [
    { pid: PID + 1, sessionId: OLD, status: 'busy', startedAt: NOW },
    { pid: PID + 2, sessionId: NEW, status: 'busy', startedAt: NOW + 400 },
    { pid: PID + 3, sessionId: 'bb19c349-6666-4777-8888-e9990000bbbb', status: 'busy', startedAt: NOW },
    { pid: PID + 4, sessionId: 'cc2ad45a-7777-4888-8999-faaa1111cccc', status: 'busy', startedAt: NOW },
  ];
  const r = A.processPending(live);
  assert.deepEqual(r.pinned, [{ sessionId: NEW, accountId: 'travail2' }]);
  assert.equal(A.accountOf(NEW), 'travail2');
  assert.equal(A.accountOf(OLD), 'travail1');
  // processus disparus : leurs fichiers sont retirés
  assert.deepEqual(fs.readdirSync(L), []);
});

test('vrai processus : un faux « claude » au repos est bien arrêté (et lui seul)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie faux claude-'));
  const bin = path.join(dir, 'claude');
  fs.symlinkSync('/bin/sleep', bin);
  const child = spawn(bin, ['30'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r(sig)));
  try {
    await new Promise((r) => setTimeout(r, 150));
    const lstart = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout.trim();
    const reg = { pid: child.pid, sessionId: SID2, status: 'idle', procStart: lstart, startedAt: Date.now() - 10_000, statusUpdatedAt: Date.now() - 10_000, entrypoint: 'claude-vscode' };
    wj(path.join(REG, `${child.pid}.json`), reg);
    // vrai ps, faux trousseau ; arrêt par le vrai process.kill
    const real = (cmd, args, o = {}) => (cmd === '/bin/ps'
      ? (() => { const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...(o.env || {}) } }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; })()
      : runner(cmd, args, o));
    const R = createAccounts({ ...opts, runner: real, kill: undefined, stopGraceMs: 300 });
    // mauvaise conversation : rien
    const wrong = R.switchConversation(SID, 'travail2', { liveSessions: [{ ...reg, sessionId: SID }] });
    assert.equal(wrong.switch.state, 'pending');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    const r = R.switchConversation(SID2, 'travail2', { liveSessions: [reg] });
    assert.equal(r.switch.state, 'done');
    assert.equal(await exited, 'SIGINT', 'arrêt propre d\'abord');
    R.switchConversation(SID, 'travail1', { liveSessions: [] }); // nettoie l'attente
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(REG, `${child.pid}.json`), { force: true });
  }
});

test('vrai processus : une commande de fond en cours (vrai pgrep) retient la bascule, sa fin la libère', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie faux claude-'));
  const bin = path.join(dir, 'claude');
  fs.symlinkSync('/bin/bash', bin);
  // comme Claude Code : un shell enfant « … shell-snapshots/snapshot-… » par commande de fond
  const child = spawn(bin, ['-c', '/bin/sh -c "sleep 1.5; : shell-snapshots/snapshot-zsh-test" & wait; sleep 30'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r(sig)));
  try {
    await new Promise((r) => setTimeout(r, 300));
    const lstart = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout.trim();
    const reg = { pid: child.pid, sessionId: SID2, status: 'idle', procStart: lstart, startedAt: Date.now() - 10_000, statusUpdatedAt: Date.now() - 10_000, entrypoint: 'claude-vscode' };
    wj(path.join(REG, `${child.pid}.json`), reg);
    const real = (cmd, args, o = {}) => (cmd === '/bin/ps' || cmd === '/usr/bin/pgrep'
      ? (() => { const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...(o.env || {}) } }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; })()
      : runner(cmd, args, o));
    const R = createAccounts({ ...opts, runner: real, kill: undefined, stopGraceMs: 300 });
    R.switchConversation(SID2, 'travail1', { liveSessions: [] });
    const r = R.switchConversation(SID2, 'travail2', { liveSessions: [reg] });
    assert.equal(r.switch.state, 'pending');
    assert.match(r.switch.message, /commandes de fond/);
    assert.equal(child.exitCode, null);
    let applied = [];
    for (let i = 0; i < 60 && !applied.length; i++) { await new Promise((res) => setTimeout(res, 100)); applied = R.processPending([reg]).applied; }
    assert.equal(applied[0]?.state, 'done');
    // bash attend son « sleep 30 » et laisse SIGINT de côté : le SIGTERM de secours l'arrête
    assert.equal(await exited, 'SIGTERM', 'SIGTERM de secours');
    R.switchConversation(SID2, 'travail1', { liveSessions: [] });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(REG, `${child.pid}.json`), { force: true });
  }
});

test('accounts.json abîmé : Travail 1 par défaut, copie gardée avant réécriture', () => {
  const f = path.join(DATA, 'accounts.json');
  fs.writeFileSync(f, '{abîmé');
  const B = createAccounts(opts);
  assert.deepEqual(B.view().accounts.map((a) => a.id), ['travail1']);
  assert.equal(B.accountOf(SID), 'travail1');
  B.setDefault('travail1');
  assert.ok(fs.readdirSync(DATA).some((n) => n.startsWith('accounts.json.corrupt-')));
  assert.deepEqual(rj(f).accounts.map((a) => a.id), ['travail1']);
});

test('apply : point d\'entrée unique pour POST /api/v2/accounts', () => {
  assert.deepEqual(A.apply({ action: 'nimporte' }), { ok: false, error: 'Action inconnue.' });
  const c = A.apply({ action: 'create', label: 'Perso 2' });
  assert.equal(c.ok, true);
  assert.deepEqual(A.apply({ action: 'rename', id: c.account.id, label: 'Perso deux' }), { ok: true });
  assert.equal(A.apply({ action: 'setDefault', id: c.account.id }).ok, true);
  assert.equal(A.apply({ action: 'wrapper', enable: false }).active, false);
  assert.equal(A.apply({ action: 'health' }).accounts.length >= 2, true);
});

test('noms des comptes : aucun nom fixé d\'avance, une adresse publique donne « Perso », une autre « Pro · nom »', async () => {
  const { friendlyLabel, KNOWN_ACCOUNTS } = await import('../lib/accounts.mjs');
  assert.deepEqual(KNOWN_ACCOUNTS, {});
  assert.equal(friendlyLabel('quelquun@gmail.com'), 'Perso');
  assert.equal(friendlyLabel('help@exemple.test'), 'Pro · help');
  assert.equal(friendlyLabel(null), null);
});

test('connecter sans Terminal : la page de connexion s\'ouvre dans le navigateur, sur le bon dossier', () => {
  runner.login = 0;
  runner.calls.length = 0;
  const A = createAccounts({ ...opts, claudeBin: '/faux/bin/claude' }); // jamais le vrai claude dans les tests
  const made = A.create('Essai connexion', 'essai@exemple.test');
  assert.equal(made.ok, true, JSON.stringify(made));
  runner.calls.length = 0;
  const r = A.connect(made.account.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.message, /navigateur : connecte-toi avec essai@exemple\.test/);
  const call = runner.calls.find((c) => /claude$/.test(c.cmd));
  assert.deepEqual(call.args, ['auth', 'login', '--claudeai', '--email', 'essai@exemple.test']);
  assert.equal(call.opts.detach, true);
  assert.equal(call.opts.env.CLAUDE_CONFIG_DIR, made.account.configDir);
  assert.equal(runner.calls.some((c) => c.cmd === '/usr/bin/osascript'), false, 'pas de Terminal');
  runner.calls.length = 0;
  A.connect('travail1');
  const c1 = runner.calls.find((c) => /claude$/.test(c.cmd));
  assert.equal(c1.opts.env.CLAUDE_CONFIG_DIR, undefined, 'compte principal : sans CLAUDE_CONFIG_DIR');
  runner.login = undefined;
});

