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
import { PerfHud } from './ui/PerfHud';
import { CompassHud } from './ui/CompassHud';
import { GoalsPanel } from './ui/GoalsPanel';
import { ConsolePanel } from './ui/ConsolePanel';
import { GalleryPanel } from './ui/GalleryPanel';
import { UpgradesPanel } from './ui/UpgradesPanel';
import { UPGRADE_BY_ID } from './core/upgrades';
import { clearAutosave, downloadSave, tryLoadAutosave, writeAutosave, writeAutosaveRaw } from './ui/persistence';
import { deserialize } from './core/SaveManager';
import { EVENT_BY_ID, EVENT_DEFS } from './core/events';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- world
// Startup: resume the autosave unless the URL asks for a different seed.
const params = new URLSearchParams(location.search);
const seedParam = params.get('seed') !== null ? Number(params.get('seed')) : null;
const startupMessages: string[] = [];
const loaded = tryLoadAutosave(seedParam);
if (loaded.error) startupMessages.push(`Autosave could not be loaded (${loaded.error}); starting a new world.`);
let engine: SimulationEngine;
let rover: Unit;
if (loaded.engine) {
  engine = loaded.engine;
  rover = engine.units[0];
  startupMessages.push(`Resumed autosave: seed ${engine.seed}, tick ${engine.tick}.`);
} else {
  engine = new SimulationEngine({ seed: seedParam || Math.floor(Math.random() * 1e9) });
  rover = engine.spawnUnit('Rover-1', 0, 0);
  engine.upload(rover, FACTORY_IDLE, { factory: true });
}
const seed = engine.seed;

const clock = new SimClock();
clock.tickHz = BALANCE.defaultTickHz;

// ---------------------------------------------------------------- views
const scene = new ThreeScene($('#viewport'), engine);
scene.centerOn(rover);
const debuggerPanel = new DebuggerPanel($('#debugger'), engine);
// Dev builds only: handles for browser-console debugging and screenshot scripts.
if (import.meta.env.DEV) Object.assign(window, { __rover: { engine, scene, rover } });
const compass = new CompassHud($<HTMLCanvasElement>('#compass'), engine);
const goalsPanel = new GoalsPanel($('#goals'), engine);
const consolePanel = new ConsolePanel($('#console'), engine, () => rover, (cmd) => {
  const err = engine.command(rover, cmd);
  if (err) log('warn', `Uplink rejected: ${err}.`);
});
const galleryPanel = new GalleryPanel($('#gallery'), engine);
galleryPanel.onFlag = (g, err) => {
  if (err) log('warn', `Cannot flag photo #${g.seq}: ${err}.`);
  else if (g.flag === 'hit') log('info', `Photo #${g.seq}: anomaly confirmed! A fossil in the rock (+${BALANCE.anomalyFlagCredits} credits).`);
  else if (g.flag === 'known') log('info', `Photo #${g.seq}: anomaly confirmed, but this one is already catalogued.`);
  else log('warn', `Photo #${g.seq}: the science team finds no anomaly (−${BALANCE.anomalyWrongFlag} credits at most).`);
};
const upgradesPanel = new UpgradesPanel($('#upgrades'), engine, () => rover, (err, id) => {
  if (err) log('warn', `Cannot buy ${UPGRADE_BY_ID[id]?.title}: ${err}.`);
});
const toasts = $('#toasts');
engine.events.on('GOAL_COMPLETED', (g) => {
  log('info', `Goal completed: ${g.title} (+${g.reward} credits)`);
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = `✔ ${g.title}  +${g.reward}`;
  toasts.appendChild(t);
  setTimeout(() => t.remove(), 5000);
});
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
    flashEl.textContent = `Flash ${res.flashUsed}/${rover.chassis.flashBytes} B${res.errors.length ? ` · ${res.errors.length} error(s)` : ''}`;
    flashEl.classList.toggle('over', res.flashUsed > rover.chassis.flashBytes || res.errors.length > 0);
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
log('info', `World seed ${seed}. Open ?seed=${seed} to start a fresh copy of this world.`);
for (const m of startupMessages) log(m.startsWith('Autosave could') ? 'error' : 'info', m);

// ---------------------------------------------------------------- persistence
const saveInfo = $('#save-info');
/** Set when navigating away on purpose (new world / load), so the page-hide autosave does not overwrite. */
let leaving = false;
function autosave(): void {
  if (leaving) return;
  if (writeAutosave(engine)) saveInfo.textContent = `Autosaved at tick ${engine.tick} (${new Date().toLocaleTimeString()}).`;
  else saveInfo.textContent = 'Autosave failed (browser storage full or disabled).';
}
setInterval(autosave, 30_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && autosave());
window.addEventListener('pagehide', autosave);
$('#save-file').addEventListener('click', () => downloadSave(engine));
const loadInput = $<HTMLInputElement>('#load-input');
$('#load-file').addEventListener('click', () => loadInput.click());
loadInput.addEventListener('change', async () => {
  const file = loadInput.files?.[0];
  if (!file) return;
  try {
    const snap = JSON.parse(await file.text());
    deserialize(snap); // validate before replacing the autosave
    writeAutosaveRaw(snap);
    leaving = true;
    location.href = location.pathname; // reload without ?seed: resumes the loaded save
  } catch (err) {
    log('error', `Load failed: ${(err as Error).message}`);
  }
  loadInput.value = '';
});

engine.events.on('SUPPLY', (s) => {
  const title = UPGRADE_BY_ID[s.upgrade]?.title ?? s.upgrade;
  if (s.phase === 'LANDED') log('info', `Supply crate (${title}) landed at (${s.x}, ${s.y}). Grab it to install.`);
  if (s.phase === 'INSTALLED') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = `⬆ ${title} installed`;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
});

// ---------------------------------------------------------------- world events
const banner = $('#event-banner');
engine.events.on('WORLD_EVENT', (w) => {
  const name = EVENT_BY_ID[w.def]?.title ?? w.type;
  if (w.phase === 'ALERT') log('warn', `${name} forecast in ${w.startTick - engine.tick} ticks (@ALERT).`);
  else if (w.phase === 'START') log('warn', `${name} has begun.`);
  else log('info', `${name} is over.`);
});
function updateBanner(): void {
  const a = engine.director.alert(engine.tick);
  if (!a.event) {
    banner.className = '';
    return;
  }
  const squall = a.event.type === 'SQUALL';
  const name = `${squall ? '☄' : '◐'} ${(EVENT_BY_ID[a.event.def]?.title ?? a.event.type).toUpperCase()}`;
  if (a.eta > 0) {
    banner.className = 'warn';
    banner.textContent = `${name} in ${a.eta} ticks${squall ? ' — stow the solar array' : ''}`;
  } else {
    banner.className = 'active';
    banner.textContent = `${name} — ${a.event.endTick - engine.tick} ticks left`;
  }
}

// ---------------------------------------------------------------- controls
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('#speed button')];
function setSpeed(s: number): void {
  clock.speed = s;
  for (const b of speedButtons) b.classList.toggle('active', Number(b.dataset.speed) === s);
}
let lastSpeed = 1;
speedButtons.forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
setSpeed(1);

// Admin: the omniscient live debugger (SPEC §3.8.4). A UI preference, not saved with the world.
const ADMIN_DEBUGGER_KEY = 'rover.adminDebugger';
let adminDebugger = false;
try {
  adminDebugger = localStorage.getItem(ADMIN_DEBUGGER_KEY) === '1';
} catch {
  /* storage disabled */
}
const admDebugger = $<HTMLInputElement>('#adm-debugger');
function setAdminDebugger(on: boolean): void {
  adminDebugger = on;
  admDebugger.checked = on;
  $('#debugger-wrap').hidden = !on;
  $('#btn-step').hidden = !on;
  if (!on) editor.setExecLine(0);
  try {
    localStorage.setItem(ADMIN_DEBUGGER_KEY, on ? '1' : '0');
  } catch {
    /* storage disabled: the toggle still works for this page */
  }
}
admDebugger.addEventListener('change', () => setAdminDebugger(admDebugger.checked));
setAdminDebugger(adminDebugger);

function stepInstruction(): void {
  if (!adminDebugger) return;
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
const eventSel = $<HTMLSelectElement>('#adm-event');
for (const d of EVENT_DEFS) eventSel.add(new Option(d.title, d.id));
$('#adm-event-go').addEventListener('click', () => engine.director.triggerNow(eventSel.value));
$('#adm-credits').addEventListener('click', () => (engine.credits += 50));
const invuln = $<HTMLInputElement>('#adm-invuln');
invuln.checked = engine.cheats.invulnerable;
invuln.addEventListener('change', () => (engine.cheats.invulnerable = invuln.checked));
$<HTMLInputElement>('#adm-free').checked = engine.cheats.freeUpload;
scene.onTileShiftClick = (x, y) => {
  if (!engine.admin.teleport(rover, x, y)) log('warn', `Cannot teleport to (${x}, ${y}): tile is blocked.`);
};
$('#btn-new').addEventListener('click', () => {
  if (!confirm('Start a new world? The current world will be discarded (save it to a file first if you want to keep it).')) return;
  leaving = true;
  clearAutosave();
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
  else if (e.key === 'b' || e.key === 'B') scene.setBloom(!scene.post.enabled);
  else if (e.key === 'q' || e.key === 'Q') scene.rotate(1);
  else if (e.key === 'e' || e.key === 'E') scene.rotate(-1);
  else if (e.key === 'p' || e.key === 'P') perfHud.toggle();
});

// ---------------------------------------------------------------- loop
const hud = $('#hud');
const hoverEl = $('#hover');
const clockEl = $('#clock');
const creditsEl = $('#credits');
const worldInfo = $('#world-info');
const perfHud = new PerfHud($('#perf'));
let last = performance.now();
let uiTimer = 0;

function frame(now: number): void {
  const dt = now - last;
  last = now;
  const n = clock.advance(dt);
  for (let i = 0; i < n; i++) engine.advanceTick();

  scene.ticksPerSecond = clock.tickHz * Math.max(1, clock.speed);
  scene.render(clock.alpha(), now, clock.speed === 0);

  uiTimer += dt;
  if (uiTimer > 66) {
    uiTimer = 0;
    if (adminDebugger) {
      debuggerPanel.update(rover);
      const st = rover.vm.state;
      const live = st === CpuState.RUNNING || st === CpuState.BLOCKED || st === CpuState.HALTED || st === CpuState.FAULT;
      editor.setExecLine(live ? rover.vm.nextLine : 0);
    }
    const sun = engine.sun;
    clockEl.textContent = `sol ${engine.env.dayNumber(engine.tick)} · ${sun.elevation > 0 ? '☀ day' : '☾ night'} · tick ${engine.tick}`;
    compass.update(rover, scene.yaw);
    updateBanner();
    goalsPanel.update();
    consolePanel.update();
    galleryPanel.update();
    upgradesPanel.update();
    creditsEl.textContent = `◆ ${engine.credits} credits`;
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
    worldInfo.textContent = `Seed ${seed} · ${engine.world.loadedCount} chunks loaded · ${scene.stats.fps.toFixed(0)} fps (P: frame-time HUD)`;
    perfHud.update(scene.perf);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
