// Tests de l'ouvreur (lib/opener.mjs) : VS Code attendu par sa fenêtre (~/.claude/ide/*.lock), liens de l'app Claude.
// node --test test/
// Tout est faux : dossier perso temporaire, faux ~/.claude/ide, faux « open » (un petit programme qui note ses
// arguments et peut échouer à la demande), horloge et attente simulées. Rien ne s'ouvre sur l'écran.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOpener, runBin, vscodeLink, claudeNewLink, claudeResumeLink, launchMessage, chooseSurface, TIMING, APP_PROMPT_MAX } from '../lib/opener.mjs';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie ouvreur-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const deadPid = spawnSync('/usr/bin/true').pid;
const SESSION = 'b1b9b451-c53c-439e-b804-3689257268e3';

let n = 0;
// Un monde : dossier perso, projet (espaces et accents dans le chemin), faux open.
function world() {
  const root = path.join(TMP, `monde-${++n}`);
  const home = path.join(root, 'maison');
  const project = path.join(home, 'Code', 'Cabinet Martin (2026)');
  fs.mkdirSync(project, { recursive: true });
  const ide = path.join(home, '.claude', 'ide');
  const log = path.join(root, 'open.log');
  const fail = path.join(root, 'echec'); // contenu : « tout » (tout échoue) ou « lien » (seuls les liens échouent)
  const bin = path.join(root, 'faux-open');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
let f = '';
try { f = fs.readFileSync(${JSON.stringify(fail)}, 'utf8'); } catch {}
if (f === 'tout' || (f === 'lien' && args[0] !== '-a')) process.exit(1);
`, { mode: 0o755 });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // fenêtre VS Code où l'extension Claude Code a démarré : son .lock
  let port = 50000;
  const lock = (folders, pid = process.pid, more = {}) => {
    fs.mkdirSync(ide, { recursive: true });
    const f = path.join(ide, `${++port}.lock`);
    fs.writeFileSync(f, JSON.stringify({ pid, workspaceFolders: folders, ideName: 'Visual Studio Code', transport: 'ws', ...more }));
    return f;
  };
  return { root, home, project, ide, bin, calls, lock, failWith: (k) => fs.writeFileSync(fail, k), ok: () => fs.rmSync(fail, { force: true }) };
}
// Horloge simulée : sleep avance le temps tout de suite ; onSleep(k) est appelé après la k-ième attente.
function clock(onSleep = () => {}) {
  let t = 0;
  const sleeps = [];
  return { sleeps, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; onSleep(sleeps.length); } };
}
const opener = (W, c, more = {}) => createOpener({ home: W.home, openBin: W.bin, sleep: c.sleep, now: c.now, ...more });

test('liens : message prérempli encodé (deux décodages pour VS Code), dossier et q de l\'app Claude, reprises', () => {
  const prompt = 'Lance l\'agent « R&D 100% + essai » : lis le fichier /Users/alex/Code/a b/#1?x=y.md\net suis ses consignes.';
  const v = vscodeLink({ prompt, session: SESSION });
  assert.ok(v.startsWith('vscode://anthropic.claude-code/open?prompt='));
  const q = v.slice(v.indexOf('?') + 1);
  // VS Code décode une fois la requête, l'extension la relit
  const once = new URLSearchParams(decodeURIComponent(q));
  assert.deepEqual([once.get('prompt'), once.get('session')], [prompt, SESSION]);
  assert.equal(vscodeLink({ session: SESSION }), `vscode://anthropic.claude-code/open?session=${SESSION}`);
  assert.equal(vscodeLink(), 'vscode://anthropic.claude-code/open');
  const folder = '/Users/alex/Code/Cabinet Martin & fils (2026)';
  const a = claudeNewLink(folder, prompt);
  assert.equal(a.withPrompt, true);
  const u = new URL(a.url);
  assert.deepEqual([u.protocol, u.host, u.pathname], ['claude:', 'code', '/new']);
  assert.deepEqual([...u.searchParams.keys()], ['folder', 'q', 'source']);
  assert.deepEqual([u.searchParams.get('folder'), u.searchParams.get('q'), u.searchParams.get('source')], [folder, prompt, 'vigie']);
  assert.ok(!/[ «»\n#&?]/.test(a.url.slice('claude://code/new?'.length).replace(/&(q|source)=/g, '')), 'chaque valeur encodée');
  // message trop long pour q : pas de q (l'app copie le message)
  const long = 'x'.repeat(APP_PROMPT_MAX + 1);
  assert.deepEqual(claudeNewLink(folder, long), { url: `claude://code/new?folder=${encodeURIComponent(folder)}&source=vigie`, withPrompt: false });
  assert.equal(claudeNewLink(folder, 'x'.repeat(APP_PROMPT_MAX)).withPrompt, true, '2 592 caractères : permis');
  assert.equal(claudeResumeLink({ session: SESSION, localId: 'local_4f2a-9b' }), 'claude://code/continue?session=local_4f2a-9b');
  assert.equal(claudeResumeLink({ session: SESSION }), `claude://resume?session=${SESSION}`);
  assert.equal(claudeResumeLink({ session: SESSION, localId: 'local_../../x' }), `claude://resume?session=${SESSION}`, 'id local douteux : par l\'uuid');
});

test('phrases du lancement et surface proposée', () => {
  assert.equal(launchMessage('full', 'vscode'), 'VS Code s\'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le.');
  assert.equal(launchMessage('full', 'claude-app'), 'L\'app Claude s\'ouvre sur le projet, avec le message prêt : envoie-le.');
  assert.equal(launchMessage('folder', 'vscode'), 'VS Code est ouvert sur le projet, mais Claude Code n\'a pas répondu à temps : le message est copié, colle-le dans Claude Code et envoie-le.');
  assert.equal(launchMessage('no-prompt', 'claude-app'), 'La conversation s\'ouvre dans l\'app Claude : le message est copié, colle-le (⌘V) et envoie-le.');
  assert.equal(launchMessage('none', 'vscode'), 'Le dossier est prêt, mais rien ne s\'est ouvert : le message est copié, colle-le dans Claude Code.');
  assert.equal(chooseSurface(['vscode', 'claude-app'], 'claude-app'), 'claude-app', 'la dernière utilisée');
  assert.equal(chooseSurface(['vscode'], 'claude-app'), 'vscode', 'plus là : la première disponible');
  assert.equal(chooseSurface(['vscode', 'claude-app'], undefined), 'vscode');
  assert.equal(chooseSurface([], 'vscode'), null);
});

test('fenêtre VS Code prête : .lock du dossier (chemin réel, casse pliée), pid vivant ; le reste ne compte pas', () => {
  const W = world();
  const asked = [];
  const o = createOpener({ home: W.home, openBin: W.bin, alive: (pid) => { asked.push(pid); return pid === process.pid; } });
  assert.equal(o.ideDir, path.join(W.home, '.claude', 'ide'));
  assert.equal(o.windowReady(W.project), false, 'pas de dossier ide');
  W.lock([path.join(W.home, 'Code')]);                        // le dossier parent : une autre fenêtre
  W.lock([path.join(W.project, 'docs')]);                     // un sous-dossier : une autre fenêtre
  W.lock([W.project], deadPid);                               // fenêtre fermée (pid mort)
  W.lock([W.project], 0); W.lock([W.project], -1); W.lock([W.project], 1); W.lock([W.project], '123'); // jamais process.kill(0 / -1)
  W.lock(W.project);                                          // pas une liste
  fs.writeFileSync(path.join(W.ide, '9.lock'), '{ abîmé');
  fs.writeFileSync(path.join(W.ide, '10.lock'), JSON.stringify({ pid: process.pid, workspaceFolders: [W.project], pad: 'x'.repeat(70 * 1024) })); // trop gros
  const elsewhere = path.join(W.root, 'ailleurs.lock');
  fs.writeFileSync(elsewhere, JSON.stringify({ pid: process.pid, workspaceFolders: [W.project] }));
  fs.symlinkSync(elsewhere, path.join(W.ide, '11.lock'));      // un lien : pas lu
  fs.writeFileSync(path.join(W.ide, '12.json'), JSON.stringify({ pid: process.pid, workspaceFolders: [W.project] })); // pas un .lock
  assert.equal(o.windowReady(W.project), false);
  assert.ok(!asked.some((p) => !Number.isInteger(p) || p <= 1), `pids demandés : ${asked}`);
  // écrit autrement : par un lien, en majuscules, avec une barre finale, dans un espace à plusieurs dossiers
  fs.symlinkSync(W.project, path.join(W.home, 'Code', 'raccourci'));
  for (const f of [[path.join(W.home, 'Code', 'raccourci')], [W.project.toUpperCase().replace(W.root.toUpperCase(), W.root)], [`${W.project}/`],
    [path.join(W.home, 'Code', 'autre'), W.project]]) {
    const l = W.lock(f);
    assert.equal(o.windowReady(W.project), true, JSON.stringify(f));
    fs.rmSync(l);
  }
  assert.equal(o.windowReady(W.project), false);
});

test('VS Code : fenêtre déjà là → 800 ms puis le lien ; elle apparaît → sondage, 1,5 s, le lien ; jamais → pas de lien', async () => {
  const link = vscodeLink({ prompt: 'Lance l\'agent', session: SESSION });
  // déjà là
  let W = world();
  W.lock([W.project]);
  let c = clock();
  assert.equal(await opener(W, c).vscode(W.project, link), 'full');
  assert.deepEqual(W.calls(), [['-a', 'Visual Studio Code', W.project], [link]], 'open, avec des arguments : jamais un shell');
  assert.deepEqual(c.sleeps, [TIMING.present]);
  assert.equal(TIMING.present, 800);
  // apparaît pendant la 3e attente
  W = world();
  c = clock((k) => { if (k === 3) W.lock([W.project]); });
  assert.equal(await opener(W, c).vscode(W.project, link), 'full');
  assert.deepEqual(W.calls(), [['-a', 'Visual Studio Code', W.project], [link]]);
  assert.deepEqual(c.sleeps, [300, 300, 300, 1500], 'sondage toutes les 300 ms, puis le temps que l\'extension écoute');
  // jamais (ou seulement une fenêtre fermée, ou celle d'un autre projet) : 25 s, puis rien
  W = world();
  W.lock([W.project], deadPid);
  W.lock([path.join(W.home, 'Code')]);
  c = clock();
  assert.equal(await opener(W, c).vscode(W.project, link), 'folder');
  assert.deepEqual(W.calls(), [['-a', 'Visual Studio Code', W.project]], 'le lien ne part pas : il irait dans une autre fenêtre');
  assert.equal(c.sleeps.length, Math.ceil(TIMING.max / TIMING.poll));
  assert.ok(c.sleeps.every((s) => s === 300));
  assert.ok(c.now() >= 25_000 && c.now() < 25_300, `${c.now()} ms`);
  // VS Code ne s'ouvre pas : rien d'autre
  W = world();
  W.lock([W.project]);
  W.failWith('tout');
  c = clock();
  assert.equal(await opener(W, c).vscode(W.project, link), 'none');
  assert.deepEqual(W.calls().length, 1);
  assert.deepEqual(c.sleeps, []);
  // le lien échoue : VS Code est ouvert, le message à coller
  W.failWith('lien');
  assert.equal(await opener(W, clock()).vscode(W.project, link), 'folder');
  // attente maximale réglable (le moteur : VIGIE_IDE_WAIT_MS)
  W = world();
  c = clock();
  assert.equal(await opener(W, c, { timing: { max: 900 } }).vscode(W.project, link), 'folder');
  assert.deepEqual(c.sleeps, [300, 300, 300]);
});

test('VS Code : l\'attente passe par des minuteries, la boucle de Node reste libre', async () => {
  const W = world();
  const o = createOpener({ home: W.home, openBin: W.bin, timing: { poll: 10, max: 200, settle: 20, present: 20 } });
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 5);
  const t0 = Date.now();
  let r;
  try { r = await o.vscode(W.project, vscodeLink({ prompt: 'x' })); } finally { clearInterval(iv); }
  assert.equal(r, 'folder');
  assert.ok(Date.now() - t0 >= 200, 'l\'attente a bien duré');
  assert.ok(ticks >= 10, `la boucle a tourné pendant l'attente (${ticks} tours)`);
});

test('lancement : VS Code (nouvelle ou reprise), app Claude (new avec q, continue local_, resume uuid), échec d\'open', async () => {
  const prompt = 'Lance l\'agent « Démarrer un projet » : lis le fichier /Users/alex/Code/cabinet-martin/.vigie/agent-demarrer-projet.md et suis ses consignes, dans le dossier /Users/alex/Code/cabinet-martin.';
  let W = world();
  W.lock([W.project]);
  assert.equal(await opener(W, clock()).launch({ surface: 'vscode', folder: W.project, prompt, session: SESSION }), 'full');
  assert.deepEqual(W.calls(), [['-a', 'Visual Studio Code', W.project], [vscodeLink({ prompt, session: SESSION })]]);
  W = world();
  W.lock([W.project]);
  assert.equal(await opener(W, clock()).launch({ surface: 'vscode', folder: W.project, prompt }), 'full');
  assert.deepEqual(W.calls()[1], [vscodeLink({ prompt })], 'nouvelle conversation : sans session');
  // app Claude, nouvelle conversation : le message prérempli dans q
  W = world();
  assert.equal(await opener(W, clock()).launch({ surface: 'claude-app', folder: W.project, prompt }), 'full');
  let calls = W.calls();
  assert.equal(calls.length, 1);
  const u = new URL(calls[0][0]);
  assert.deepEqual([calls[0].length, u.protocol, u.host, u.pathname, u.searchParams.get('folder'), u.searchParams.get('q'), u.searchParams.get('source')],
    [1, 'claude:', 'code', '/new', W.project, prompt, 'vigie']);
  // message trop long : sans q, l'app copie le message
  W = world();
  assert.equal(await opener(W, clock()).launch({ surface: 'claude-app', folder: W.project, prompt: 'x'.repeat(APP_PROMPT_MAX + 1) }), 'no-prompt');
  assert.ok(!W.calls()[0][0].includes('&q='));
  // reprise : née dans l'app (id local), ou ailleurs (uuid)
  W = world();
  const o = opener(W, clock());
  assert.equal(await o.launch({ surface: 'claude-app', folder: W.project, prompt, session: SESSION, localId: 'local_4f2a' }), 'no-prompt');
  assert.equal(await o.launch({ surface: 'claude-app', folder: W.project, prompt, session: SESSION }), 'no-prompt');
  assert.deepEqual(W.calls(), [['claude://code/continue?session=local_4f2a'], [`claude://resume?session=${SESSION}`]], 'aucun lien de reprise ne prend de message');
  // open en échec : rien ne s'est ouvert
  W.failWith('tout');
  assert.equal(await o.launch({ surface: 'claude-app', folder: W.project, prompt }), 'none');
  assert.equal(await o.launch({ surface: 'claude-app', folder: W.project, prompt, session: SESSION }), 'none');
  await assert.rejects(o.launch({ surface: 'vscode', folder: W.project, prompt, session: '../../x' }), /session invalide/);
  calls = W.calls();
  assert.ok(calls.every((a) => a.every((x) => typeof x === 'string')));
});

test('runBin : arguments transmis tels quels, sans shell ; programme absent ou en échec', async () => {
  const W = world();
  const tricky = ['-a', 'Visual Studio Code', '/Users/alex/Code/$(touch pwned); `id` & | > x', 'vscode://x?prompt=a%26b'];
  assert.deepEqual(await runBin(W.bin, tricky), { ok: true, code: 0 });
  assert.deepEqual(W.calls(), [tricky]);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);
  assert.equal((await runBin(path.join(W.root, 'absent'), [])).ok, false);
  W.failWith('tout');
  assert.deepEqual(await runBin(W.bin, ['x']), { ok: false, code: 1 });
});
