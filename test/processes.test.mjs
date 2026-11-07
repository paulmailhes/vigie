import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcesses, parseElapsed, parseCpu, commandName, parseFootprint } from '../lib/processes.mjs';

const UID = 501;
const SID_CLOSED = 'aaaaaaaa-0000-4000-8000-000000000001';
const SID_OPEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const SID_WORK = 'cccccccc-0000-4000-8000-000000000003';
const START = 'Wed Nov  5 10:00:00 2026';
const CHROME = '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1/chrome-mac/headless_shell';

// Une machine de test : chaque processus = { pid, ppid, pgid, uid, lstart, etime, rssKb, time, comm, args, sid?, cpid? }
function machine(list) {
  const state = { list: list.map((p) => ({ uid: UID, lstart: START, etime: '03:00:00', rssKb: 10240, time: '0:01.00', ...p })) };
  const line = (p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.uid} ${p.lstart} ${p.etime} ${p.rssKb} ${p.time} S ${p.comm}`;
  const env = (p) => `${p.pid} ${p.args} HOME=/Users/u SECRET_TOKEN=sk-ant-ne-doit-jamais-sortir${p.sid ? ` CLAUDE_CODE_SESSION_ID=${p.sid}` : ''}${p.cpid ? ` CLAUDE_PID=${p.cpid}` : ''} PATH=/bin`;
  const only = (args) => { const i = args.indexOf('-p'); return i < 0 ? null : new Set(args[i + 1].split(',').map(Number)); };
  state.run = async (cmd, args) => {
    if (state.failPs && cmd === '/bin/ps' && args[0] === '-axo') return { ok: false, stdout: '' }; // Mac saturé
    const pick = only(args);
    const procs = state.list.filter((p) => !pick || pick.has(p.pid));
    if (cmd === '/bin/ps' && args.includes('-E')) return { ok: true, stdout: procs.map(env).join('\n') };
    if (cmd === '/bin/ps' && args[0] === '-axww') return { ok: true, stdout: procs.map((p) => `${p.pid} ${p.args}`).join('\n') };
    if (cmd === '/bin/ps') return { ok: true, stdout: procs.map(line).join('\n') };
    if (cmd === '/usr/sbin/lsof' && args.includes('-iTCP')) {
      return { ok: true, stdout: state.list.filter((p) => p.port).map((p) => `p${p.pid}\nn127.0.0.1:${p.port}`).join('\n') };
    }
    if (cmd === '/usr/sbin/lsof') return { ok: true, stdout: procs.map((p) => `p${p.pid}\nn/Users/u/Code/${p.dir || 'site'}`).join('\n') };
    return { ok: true, stdout: '' };
  };
  return state;
}

function setup(list, { autoStop = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-proc-'));
  const m = machine(list);
  const killed = [];
  let clock = Date.parse('2026-11-05T13:00:00Z');
  const live = new Map([[SID_OPEN, { pid: 4000, status: 'idle' }], [SID_WORK, { pid: 5000, status: 'busy' }]]);
  const conv = { [SID_CLOSED]: { title: 'Captures', project: 'pola', lastTs: '2026-11-05T05:00:00Z' }, [SID_OPEN]: { title: 'Accueil', project: 'atelier' } };
  const p = createProcesses({ dataDir: dir, live: () => live, conversation: (sid) => conv[sid] || null, autoStop: () => autoStop,
    run: m.run, kill: (pid, sig) => killed.push([pid, sig]), now: () => clock, uid: UID, selfPid: 999 });
  return { p, m, killed, dir, tick: (ms) => { clock += ms; } };
}

const chromeTree = [
  { pid: 100, ppid: 1, pgid: 100, comm: CHROME, args: `${CHROME} --headless --remote-debugging-pipe`, sid: SID_CLOSED, cpid: 3000, rssKb: 204800, etime: '10:00:00' },
  { pid: 101, ppid: 100, pgid: 100, comm: CHROME, args: `${CHROME} --type=renderer`, sid: SID_CLOSED, cpid: 3000, rssKb: 102400 },
  { pid: 102, ppid: 100, pgid: 100, comm: CHROME, args: `${CHROME} --type=gpu-process`, sid: SID_CLOSED, cpid: 3000, rssKb: 102400 },
];
const others = [
  // les shells de Claude Code (programmes d'Apple : environnement illisible, jamais marqués)
  { pid: 4100, ppid: 4000, pgid: 4100, comm: '/bin/zsh', args: '/bin/zsh -c source snapshot.sh && eval npm run dev' },
  { pid: 5100, ppid: 5000, pgid: 5100, comm: '/bin/zsh', args: '/bin/zsh -c source snapshot.sh && eval node build.mjs' },
  // serveur de dev d'une conversation ouverte au repos
  { pid: 200, ppid: 4100, pgid: 4100, comm: '/opt/homebrew/bin/node', args: 'node /Users/u/Code/atelier/node_modules/.bin/vite', sid: SID_OPEN, cpid: 4000, port: 5173, dir: 'atelier' },
  // un MCP de la conversation (pas de CLAUDE_PID) : jamais listé
  { pid: 201, ppid: 4000, pgid: 4000, comm: '/opt/homebrew/bin/uv', args: 'uv run workspace-mcp', sid: SID_OPEN },
  // Claude Code lui-même : jamais listé
  { pid: 4000, ppid: 1, pgid: 4000, comm: '/Users/u/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude', args: 'claude', sid: SID_OPEN, cpid: 4000 },
  // la commande du moment d'une conversation qui travaille : pas « en fond »
  { pid: 300, ppid: 5100, pgid: 5100, comm: '/bin/sleep', args: 'node build.mjs', sid: SID_WORK, cpid: 5000, etime: '00:12' },
  // un programme lancé à la main, sans marquage : jamais listé
  { pid: 400, ppid: 1, pgid: 400, comm: '/opt/homebrew/bin/node', args: 'node server.js', port: 3000 },
  // à un autre utilisateur : jamais listé
  { pid: 500, ppid: 1, pgid: 500, uid: 0, comm: '/usr/bin/python3', args: 'python3 x.py', sid: SID_CLOSED, cpid: 3000 },
  // une app ouverte par un agent
  { pid: 600, ppid: 1, pgid: 600, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', args: 'com.docker.backend services', sid: SID_CLOSED, cpid: 3000 },
  { pid: 601, ppid: 600, pgid: 600, comm: '/Applications/Docker.app/Contents/MacOS/Docker Desktop.app/Contents/MacOS/Docker Desktop', args: 'Docker Desktop', sid: SID_CLOSED, cpid: 3000 },
];

test('durées, temps processeur, noms de commandes', () => {
  assert.equal(parseElapsed('1-02:03:04'), ((26 * 60 + 3) * 60 + 4) * 1000);
  assert.equal(parseElapsed('03:04'), 184_000);
  assert.equal(parseCpu('1:02.50'), 62.5);
  assert.equal(parseCpu('1-00:00:01'), 86401);
  assert.equal(commandName('/usr/bin/python3 -m http.server 8766'), 'python3 -m http.server');
  assert.equal(commandName('node /x/render.mjs --out a'), 'node render.mjs');
  assert.equal(commandName('npm run dev -- --port 3'), 'npm run dev');
  const fp = parseFootprint('vm [24]: 64-bit    Footprint: 8242 MB (16384 bytes per page)\nShared with backend [38]:\nbackend [38]: 64-bit    Footprint: 512 KB\n');
  assert.equal(fp.mb.get(24), 8242);
  assert.equal(fp.mb.get(38), 0.5);
  assert.ok(fp.shared.get(24).has(38));
});

test('relevé : seuls les processus lancés par une commande de Claude Code, regroupés et nommés', async () => {
  const { p } = setup([...chromeTree, ...others]);
  const v = p.view(await p.snapshot());
  const byKind = Object.fromEntries(v.groups.map((g) => [g.kind, g]));
  assert.deepEqual(v.groups.map((g) => g.kind).sort(), ['app', 'chrome', 'server']);
  const chrome = byKind.chrome;
  assert.equal(chrome.label, 'Chrome sans fenêtre');
  assert.equal(chrome.processes, 3, 'un Chrome et ses enfants : une seule ligne');
  assert.equal(chrome.memoryMb, 400);
  assert.equal(chrome.state, 'forgotten', 'sa conversation est fermée');
  assert.equal(chrome.project, 'pola');
  assert.equal(chrome.forgottenSince, '2026-11-05T05:00:00.000Z', 'oublié depuis la dernière activité de sa conversation');
  assert.match(chrome.detail, /Playwright/);
  const server = byKind.server;
  assert.equal(server.label, 'Serveur de dev · port 5173');
  assert.equal(server.state, 'idle');
  assert.equal(server.conversationTitle, 'Accueil');
  assert.equal(byKind.app.label, 'Docker');
  assert.equal(byKind.app.processes, 2);
  assert.equal(v.forgotten.groups, 1, 'une app n\'est pas un oubli');
  const json = JSON.stringify(v);
  assert.ok(!json.includes('sk-ant'), 'jamais l\'environnement');
  assert.ok(!json.includes('"members"'), 'pas les numéros de processus dans la vue');
});

test('arrêt : relu juste avant, groupe entier seulement s\'il ne contient rien d\'autre, puis arrêt forcé', async () => {
  const { p, m, killed, dir } = setup([...chromeTree, ...others]);
  const v = p.view(await p.snapshot());
  const chrome = v.groups.find((g) => g.kind === 'chrome');
  const r = await p.stop([chrome.id]);
  assert.equal(r.ok, true);
  assert.deepEqual(killed, [[-100, 'SIGTERM']], 'le groupe 100 ne contient que ce Chrome');
  const log = fs.readFileSync(path.join(dir, 'processes-log.jsonl'), 'utf8');
  assert.match(log, /"action":"stop".*"label":"Chrome sans fenêtre"/);
  assert.ok(!/sk-ant|headless_shell/.test(log), 'ni environnement ni commande dans le journal');
  // une app : refusée (elle se quitte depuis l'app de Vigie) ; le serveur d'une conversation au repos : arrêté seul
  const app = v.groups.find((g) => g.kind === 'app');
  const r2 = await p.stop([app.id]);
  assert.equal(r2.ok, false);
  const server = v.groups.find((g) => g.kind === 'server');
  killed.length = 0;
  await p.stop([server.id]);
  assert.deepEqual(killed, [[200, 'SIGTERM']], 'son groupe 4100 contient aussi le shell : processus par processus');
  // numéro réutilisé entre le relevé et l'arrêt : rien n'est envoyé
  killed.length = 0;
  m.list.find((x) => x.pid === 200).lstart = 'Wed Nov  5 12:59:00 2026';
  await p.stop([server.id]);
  assert.deepEqual(killed, []);
});

test('une conversation qui travaille demande une confirmation', async () => {
  const work = [{ pid: 5100, ppid: 5000, pgid: 5100, comm: '/bin/zsh', args: '/bin/zsh -c eval npx remotion render' },
    { pid: 700, ppid: 5100, pgid: 5100, comm: '/opt/homebrew/bin/node', args: 'node /x/node_modules/.bin/remotion render', sid: SID_WORK, cpid: 5000 }];
  const { p, killed } = setup(work);
  const g = p.view(await p.snapshot()).groups[0];
  assert.equal(g.kind, 'render');
  assert.equal(g.state, 'working');
  const r = await p.stop([g.id]);
  assert.equal(r.results[0].needsConfirm, true);
  assert.deepEqual(killed, []);
  await p.stop([g.id], { confirm: true });
  assert.deepEqual(killed, [[700, 'SIGTERM']]);
});

test('ménage automatique : Chrome oublié depuis 6 h et qui ne consomme plus rien, seulement si le réglage est actif', async () => {
  const off = setup(chromeTree, { autoStop: false });
  await off.p.tick(); off.tick(11 * 60_000); await off.p.tick();
  assert.deepEqual(off.killed, [], 'réglage coupé : rien');

  const on = setup(chromeTree, { autoStop: true });
  await on.p.tick();
  assert.deepEqual(on.killed, [], 'pas encore 10 min de calme mesurées');
  on.tick(11 * 60_000);
  await on.p.tick();
  assert.deepEqual(on.killed, [[-100, 'SIGTERM']], 'oublié depuis 5 h, il est 13 h 11, et calme depuis 11 min');
  assert.equal(on.p.view().autoStopped.length, 1);
  assert.match(fs.readFileSync(path.join(on.dir, 'processes-log.jsonl'), 'utf8'), /"action":"auto"/);

  // un Chrome qui travaille encore (processeur) n'est jamais arrêté seul
  const busy = setup(chromeTree, { autoStop: true });
  await busy.p.tick();
  busy.m.list[0].time = '5:00.00';
  busy.tick(11 * 60_000);
  await busy.p.tick();
  assert.deepEqual(busy.killed, []);
});

test('une app dont macOS ne voit plus la fenêtre (Docker sans interface) s\'arrête par ses processus, sur demande', async () => {
  const docker = [
    { pid: 600, ppid: 1, pgid: 600, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', args: 'com.docker.backend services', sid: SID_CLOSED, cpid: 3000 },
    { pid: 601, ppid: 600, pgid: 600, comm: '/Applications/Docker.app/Contents/MacOS/com.docker.build', args: 'com.docker.build', sid: SID_CLOSED, cpid: 3000 },
  ];
  const { p, killed } = setup(docker);
  const g = p.view(await p.snapshot()).groups[0];
  assert.equal(g.kind, 'app');
  assert.equal((await p.stop([g.id])).ok, false, 'sans app:true, une app se quitte depuis l\'app Mac');
  assert.deepEqual(killed, []);
  assert.equal((await p.stop([g.id], { app: true })).ok, true);
  assert.deepEqual(killed, [[-600, 'SIGTERM']], 'le groupe 600 ne contient que Docker');
});

test('Mac saturé : un relevé qui échoue garde le précédent', async () => {
  const { p, m } = setup(chromeTree);
  const first = await p.snapshot();
  assert.equal(first.groups.length, 1);
  m.failPs = true;
  const again = await p.snapshot({ fresh: true, withFootprint: true });
  assert.equal(again.stale, true);
  assert.equal(again.groups.length, 1);
});

test('Google Chrome piloté par un script de la conversation : rattaché au script, jamais pris pour ton Chrome ni pour une app', async () => {
  const GC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const HELPER = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)';
  const list = [
    { pid: 5100, ppid: 5000, pgid: 5100, comm: '/bin/zsh', args: '/bin/zsh -c eval node frames.mjs' },
    { pid: 800, ppid: 5100, pgid: 5100, comm: '/opt/homebrew/bin/node', args: 'node anim/frames.mjs /blog', sid: SID_WORK, cpid: 5000, etime: '05:00' },
    // Google Chrome : environnement illisible (runtime durci), donc sans marquage
    { pid: 801, ppid: 800, pgid: 801, comm: GC, args: `${GC} --headless --enable-automation --user-data-dir=/var/folders/x/T/playwright_chromiumdev_profile-AB`, etime: '05:00', rssKb: 204800 },
    { pid: 802, ppid: 801, pgid: 801, comm: HELPER, args: `${HELPER} --type=renderer --enable-automation --remote-debugging-pipe`, etime: '05:00', rssKb: 102400 },
    // ton Chrome à toi : jamais listé
    { pid: 900, ppid: 1, pgid: 900, comm: GC, args: GC },
    { pid: 901, ppid: 900, pgid: 900, comm: HELPER, args: `${HELPER} --type=renderer` },
    // un Chrome ouvert par un agent avec « open -a » (c'est ton Chrome, même marqué) : jamais listé
    { pid: 950, ppid: 1, pgid: 950, comm: GC, args: `${GC} https://exemple.fr`, sid: SID_CLOSED, cpid: 3000 },
    // Chrome piloté orphelin (son script est mort), sans marquage : oublié, conversation inconnue
    { pid: 1000, ppid: 1, pgid: 1000, comm: GC, args: `${GC} --headless --enable-automation --user-data-dir=/var/folders/x/T/playwright_chromiumdev_profile-CD` },
    { pid: 1001, ppid: 1000, pgid: 1000, comm: HELPER, args: `${HELPER} --type=gpu-process --headless` },
    // le crochet de Vigie (une décision en attente) : jamais listé
    { pid: 1100, ppid: 5000, pgid: 1100, comm: '/opt/homebrew/bin/node', args: 'node /Users/u/.vigie/hook.mjs', sid: SID_WORK, cpid: 5000 },
  ];
  const { p, killed } = setup(list);
  const v = p.view(await p.snapshot());
  const ids = v.groups.map((g) => g.processes + ':' + g.state + ':' + (g.conversationId ? 'conv' : 'inconnue'));
  assert.equal(v.groups.length, 2, `seulement le script et le Chrome orphelin : ${ids.join(', ')}`);
  const script = v.groups.find((g) => g.conversationId === SID_WORK);
  assert.equal(script.processes, 3, 'le script, son Chrome et son annexe de rendu : une seule ligne');
  assert.equal(script.kind, 'chrome');
  assert.equal(script.memoryMb, 310);
  assert.ok(v.groups.every((g) => g.kind !== 'app'), 'jamais une app « Google Chrome » à quitter');
  const orphan = v.groups.find((g) => !g.conversationId);
  assert.equal(orphan.state, 'forgotten');
  assert.equal(orphan.kind, 'chrome');
  assert.equal(orphan.processes, 2);
  assert.ok(!JSON.stringify(v).includes('hook.mjs'));
  // les sans-marquage s'arrêtent aussi (relus par numéro et heure de démarrage)
  await p.stop([orphan.id]);
  assert.deepEqual(killed, [[-1000, 'SIGTERM']]);
});
