import './style.css';
import { BALANCE } from './core/balance';
import { FACTORY_IDLE, TEMPLATES } from './core/programs';
import { SimClock } from './core/SimClock';
import { SimulationEngine } from './core/SimulationEngine';
import { CpuState, Layer } from './core/types';
import type { Unit } from './core/Unit';
import { ThreeScene } from './render/ThreeScene';
import { DebuggerPanel } from './ui/DebuggerPanel';
import { EditorPanel } from './ui/EditorPanel';
import { renderReference } from './ui/ReferencePanel';
import { CompassHud } from './ui/CompassHud';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- world
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);
const engine = new SimulationEngine({ seed });
const rover: Unit = engine.spawnUnit('Rover-1', 0, 0);
engine.upload(rover, FACTORY_IDLE, { factory: true });

const clock = new SimClock();
clock.tickHz = BALANCE.defaultTickHz;

// ---------------------------------------------------------------- views
const scene = new ThreeScene($('#viewport'), engine);
scene.centerOn(rover);
const debuggerPanel = new DebuggerPanel($('#debugger'), engine);
const compass = new CompassHud($<HTMLCanvasElement>('#compass'), engine);
renderReference($('#reference'), engine.registry);

const flashEl = $('#flash');
const costEl = $('#upload-cost');
let editorFlash = 0;
const editor = new EditorPanel({
  parent: $('#editor'),
  initial: rover.sourceCode,
  compile: (src) => engine.compileFor(rover, src),
  onUpload: () => upload(),
  onChange: (src, res) => {
    editorFlash = res.flashUsed;
    flashEl.textContent = `Flash ${res.flashUsed}/${rover.chassis.flashLines}${res.errors.length ? ` · ${res.errors.length} error(s)` : ''}`;
    flashEl.classList.toggle('over', res.flashUsed > rover.chassis.flashLines || res.errors.length > 0);
    flashEl.classList.toggle('dirty', src !== rover.sourceCode);
  },
});

function upload(): void {
  const res = engine.upload(rover, editor.source);
  if (!res.program) log('error', `Upload rejected: ${res.errors.length} compile error(s). First: line ${res.errors[0].line}: ${res.errors[0].message}`);
  else if (res.rejected) log('error', `Upload failed: ${res.rejected} Align the dish with @ANTENNA_ANGLE, or charge first.`);
  flashEl.classList.toggle('dirty', editor.source !== rover.sourceCode);
}

// ---------------------------------------------------------------- log
const logEl = $('#log');
function log(level: 'info' | 'warn' | 'error', message: string): void {
  const div = document.createElement('div');
  div.className = level;
  div.textContent = `[t${engine.tick}] ${message}`;
  logEl.appendChild(div);
  while (logEl.childElementCount > 200) logEl.firstElementChild!.remove();
  logEl.scrollTop = logEl.scrollHeight;
}
engine.events.on('LOG', (e) => log(e.level, `${engine.getUnit(e.unitId)?.name}: ${e.message}`));
log('info', `World seed ${seed}. Share this URL with ?seed=${seed} to replay the same world.`);

// ---------------------------------------------------------------- controls
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('#speed button')];
function setSpeed(s: number): void {
  clock.speed = s;
  for (const b of speedButtons) b.classList.toggle('active', Number(b.dataset.speed) === s);
}
let lastSpeed = 1;
speedButtons.forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
setSpeed(1);

function stepInstruction(): void {
  setSpeed(0);
  if (!engine.stepInstruction(rover)) log('warn', `Cannot step: CPU is ${rover.vm.state}.`);
}
$('#btn-step').addEventListener('click', stepInstruction);
$('#btn-tick').addEventListener('click', () => {
  setSpeed(0);
  engine.advanceTick();
});
const hzInput = $<HTMLInputElement>('#tick-hz');
hzInput.addEventListener('change', () => {
  const v = Math.min(60, Math.max(1, Math.round(Number(hzInput.value) || 10)));
  hzInput.value = String(v);
  clock.tickHz = v;
});
$('#btn-upload').addEventListener('click', upload);
$('#btn-revert').addEventListener('click', () => editor.setSource(rover.sourceCode));
const templateSel = $<HTMLSelectElement>('#template');
for (const name of Object.keys(TEMPLATES)) templateSel.add(new Option(name, name));
templateSel.addEventListener('change', () => {
  if (templateSel.value) editor.setSource(TEMPLATES[templateSel.value]);
  templateSel.value = '';
});
$<HTMLInputElement>('#adm-free').addEventListener('change', (e) => (engine.cheats.freeUpload = (e.target as HTMLInputElement).checked));
$<HTMLInputElement>('#adm-reveal').addEventListener('change', (e) => scene.setRevealAll((e.target as HTMLInputElement).checked));
$('#btn-view').addEventListener('click', () => scene.setViewMode(scene.mode === 'angled' ? 'top' : 'angled'));
$('#btn-follow').addEventListener('click', () => scene.centerOn(rover));
$('#btn-new').addEventListener('click', () => {
  location.search = `?seed=${Math.floor(Math.random() * 1e9)}`;
});
$('#adm-charge').addEventListener('click', () => engine.admin.forceCharge(rover));
$('#adm-repair').addEventListener('click', () => engine.admin.forceRepair(rover));
$('#adm-respawn').addEventListener('click', () => {
  engine.admin.respawnAtOrigin(rover);
  scene.centerOn(rover);
});

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
  }),
);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('.cm-editor, input')) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (clock.speed > 0) {
      lastSpeed = clock.speed;
      setSpeed(0);
    } else setSpeed(lastSpeed);
  } else if (e.key === '.') stepInstruction();
  else if (e.key === 'v' || e.key === 'V') scene.setViewMode(scene.mode === 'angled' ? 'top' : 'angled');
  else if (e.key === 'f' || e.key === 'F') scene.centerOn(rover);
});

// ---------------------------------------------------------------- loop
const hud = $('#hud');
const hoverEl = $('#hover');
const clockEl = $('#clock');
const worldInfo = $('#world-info');
let last = performance.now();
let uiTimer = 0;

function frame(now: number): void {
  const dt = now - last;
  last = now;
  const n = clock.advance(dt);
  for (let i = 0; i < n; i++) engine.advanceTick();

  scene.render(clock.alpha(), now);

  uiTimer += dt;
  if (uiTimer > 66) {
    uiTimer = 0;
    debuggerPanel.update(rover);
    const running = rover.vm.state === CpuState.RUNNING || rover.vm.state === CpuState.BLOCKED;
    editor.setExecLine(running || rover.vm.state === CpuState.FAULT ? rover.vm.nextLine : 0);
    const sun = engine.sun;
    clockEl.textContent = `sol ${engine.env.dayNumber(engine.tick)} · ${sun.elevation > 0 ? '☀ day' : '☾ night'} · tick ${engine.tick}`;
    compass.update(rover);
    const cost = engine.uploadCost(rover, editorFlash);
    const sig = engine.signalOf(rover);
    costEl.textContent = engine.cheats.freeUpload
      ? 'Upload cost: free (admin)'
      : `Upload cost ≈ ${(cost / 1000).toFixed(1)}% battery · signal ${sig}`;
    costEl.classList.toggle('bad', sig < 50 || cost >= rover.energy);
    hud.textContent = `${rover.name}  (${rover.x}, ${rover.y})  BAT ${rover.batteryPercent}%  HULL ${rover.hull}`;
    if (scene.hover) {
      const { x, y } = scene.hover;
      const names = [Layer.TERRAIN, Layer.OBSTACLE, Layer.ITEM, Layer.ACTOR]
        .map((l) => engine.tileAt(x, y, l))
        .filter((id) => id)
        .map((id) => engine.registry.get(id)?.constName ?? id);
      hoverEl.textContent = `(${x}, ${y})  ${names.join(' · ')}`;
      hoverEl.style.display = '';
    } else hoverEl.style.display = 'none';
    worldInfo.textContent = `Seed ${seed} · ${engine.world.loadedCount} chunks loaded · ${scene.chunkMeshCount} chunk meshes`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
