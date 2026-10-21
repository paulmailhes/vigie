// Vraies captures d'écran de l'app Vigie en construction.
// Lance l'app en mode --snapshot (données d'exemple), filme sa fenêtre en continu avec screencapture,
// et pour chaque capture interne écrite par l'app garde la vraie image prise juste avant.
// Usage : node realsnap.mjs <dossier de sortie>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.join(HERE, '..', 'Vigie.app', 'Contents', 'MacOS', 'Vigie');
const FIX = path.join(HERE, '..', 'VigieApp', 'Preview');
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-real-'));
const internal = path.join(work, 'internal');
const frames = path.join(work, 'frames');
fs.mkdirSync(frames);

const app = spawn(APP, ['--snapshot', internal], { env: { ...process.env, VIGIE_FIXTURES: FIX, VIGIE_API: 'http://127.0.0.1:1' }, stdio: 'ignore' });
let exited = false;
app.on('exit', () => { exited = true; });

const shots = [];
const started = Date.now();
let n = 0;
while (!exited && Date.now() - started < 180_000) {
  const b = spawnSync(path.join(HERE, 'winbounds'), [String(app.pid)], { encoding: 'utf8' }).stdout.trim();
  if (!b) { await new Promise((r) => setTimeout(r, 100)); continue; }
  const [, x, y, w, h] = b.split(' ').map(Number);
  if (w < 600) { await new Promise((r) => setTimeout(r, 100)); continue; }
  const f = path.join(frames, `f${String(n++).padStart(4, '0')}.png`);
  const t0 = Date.now();
  // Région de la fenêtre (feuilles attachées comprises) ; l'app est au premier plan pendant la capture.
  spawnSync('/usr/sbin/screencapture', ['-x', '-R', `${x},${y},${w},${h}`, f]);
  shots.push({ f, t0, t1: Date.now() });
  await new Promise((r) => setImmediate(r));
}
if (!exited) app.kill();

let kept = 0;
for (const name of fs.existsSync(internal) ? fs.readdirSync(internal).filter((x) => x.endsWith('.png')) : []) {
  if (name.includes('barre-des-menus')) continue; // panneau de la barre des menus : hors de la fenêtre
  const T = fs.statSync(path.join(internal, name)).mtimeMs;
  // dernière image entièrement prise avant que l'app n'écrive sa propre capture de cet écran
  const cands = shots.filter((s) => s.t1 < T - 30);
  const pick = cands[cands.length - 1];
  if (pick) { fs.copyFileSync(pick.f, path.join(OUT, name)); kept++; }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`${kept} vraies captures dans ${OUT} (${shots.length} images filmées)`);
