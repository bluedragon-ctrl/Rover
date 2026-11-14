/**
 * M8 asset preview (preview.html): every v2 shape, the tile lighting, bloom, camera and
 * rover animation on a small hand-made patch, with switches for the rover subsystems.
 * Not part of the game; it exists so visuals can be reviewed before they ship.
 */
import * as THREE from 'three';
import { createDefaultRegistry, T } from '../core/WorldRegistry';
import { hash3 } from '../core/rng';
import { BALANCE, CHASSIS_MK1 } from '../core/balance';
import { CameraRig } from '../render/CameraRig';
import { PostFx } from '../render/PostFx';
import { RoverAnimator, type RoverPose } from '../render/RoverRig';
import { radarFront, TileLighting } from '../render/TileLighting';
import { FxOverlay } from '../render/FxOverlay';
import { Dust } from '../render/Dust';
import { buildRoverRig, drawFogTile, drawTileVec, FillBatch, indicatorHex, LineBatch, RIDGE } from '../render/VectorFactory';
import { mountPhotoLab } from './photos';
import { mountAnomalyLab } from './anomalies';

const view = document.getElementById('view')!;
const labelsEl = document.getElementById('labels')!;
const statsEl = document.getElementById('stats')!;
const controlsEl = document.getElementById('controls')!;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x050910, 30, 90);
const rig = new CameraRig(renderer.domElement);
rig.dist = 9;
rig.pitch = 0.95;
rig.yaw = -0.5;
const post = new PostFx(renderer, scene, rig.camera);
const lighting = new TileLighting();
const worldRoot = new THREE.Group();
scene.add(worldRoot);
const fx = new FxOverlay(worldRoot);

// ------------------------------------------------------------------ the test patch
const reg = createDefaultRegistry();
const R = 12; // patch spans [-R, R] in both axes
const EXPLORED = 10;
type Cell = { terrain: number; obstacle: number; item: number };
const cells = new Map<string, Cell>();
const key = (x: number, y: number) => `${x},${y}`;
for (let y = -R; y <= R; y++)
  for (let x = -R; x <= R; x++) cells.set(key(x, y), { terrain: (hash3(3, x, y) & 7) < 2 ? T.ROUGH_GRAVEL : T.FLAT_SAND, obstacle: 0, item: 0 });
const put = (x: number, y: number, k: keyof Cell, id: number) => (cells.get(key(x, y))![k] = id);
// Cliff ridge to the north-east, ore at its foot, a vent field to the west, pickups south.
for (const [x, y] of [[3, 4], [4, 4], [5, 4], [5, 5], [6, 5], [4, 5], [6, 6], [7, 6], [2, 4], [-6, 7], [-5, 7], [-5, 8], [8, -3], [8, -4], [9, -4],
  // A small massif (3×3 core) to judge how merged ranges read.
  [-7, -5], [-6, -5], [-5, -5], [-7, -6], [-6, -6], [-5, -6], [-7, -7], [-6, -7], [-5, -7], [-4, -6], [-8, -6], [-6, -8]]) put(x, y, 'obstacle', T.CLIFF_WALL);
put(3, 2, 'obstacle', T.IRON_ORE);
put(5, 3, 'obstacle', T.IRON_ORE);
put(-2, 3, 'obstacle', T.SILICON_ORE);
put(1, 5, 'obstacle', T.SILICON_ORE);
for (const [x, y] of [[-4, 0], [-5, 1], [-4, -1], [-6, 0]]) put(x, y, 'terrain', T.ACID_VENT);
put(2, -2, 'item', T.REPAIR_KIT);
put(-2, -2, 'item', T.SAMPLE);
put(0, -4, 'item', T.SUPPLY_CRATE);
put(0, 3, 'item', T.SAMPLE);

const specimens: [string, number, number][] = [
  ['CLIFF_WALL', 5, 5], ['IRON_ORE', 3, 2], ['SILICON_ORE', -2, 3], ['ACID_VENT', -4, 0], ['REPAIR_KIT', 2, -2],
  ['SAMPLE', -2, -2], ['SUPPLY_CRATE', 0, -4], ['ROUGH_GRAVEL', -1, 0], ['massif', -6, -6], ['unexplored', 11, 0],
];
put(0, 0, 'terrain', T.FLAT_SAND);
put(-1, 0, 'terrain', T.ROUGH_GRAVEL);

let geoStats = '';
/** RIDGE bits of the neighbours sharing the obstacle at (x, y). */
function ridgeMask(x: number, y: number, id: number): number {
  const same = (dx: number, dy: number) => cells.get(key(x + dx, y + dy))?.obstacle === id;
  return (same(0, 1) ? RIDGE.N : 0) | (same(1, 0) ? RIDGE.E : 0) | (same(0, -1) ? RIDGE.S : 0) | (same(-1, 0) ? RIDGE.W : 0);
}

function buildPatch(): THREE.Group {
  const b = new LineBatch();
  const f = new FillBatch();
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      if (x * x + y * y > EXPLORED * EXPLORED + EXPLORED) {
        drawFogTile(b, x, y);
        continue;
      }
      const c = cells.get(key(x, y))!;
      const variant = hash3(7, x, y) & 0xff;
      for (const id of [c.terrain, c.obstacle, c.item]) {
        if (!id) continue;
        const d = reg.get(id)!;
        drawTileVec(b, f, d.shape, d.color, x, y, variant, d.shape === 'wall' ? ridgeMask(x, y, id) : 0);
      }
    }
  geoStats = `${b.count / 2} segs · ${f.count / 3} tris`;
  const g = new THREE.Group();
  const lines = new THREE.LineSegments(b.build(), lighting.lineMaterial);
  const fills = new THREE.Mesh(f.build(), lighting.fillMaterial);
  lines.frustumCulled = fills.frustumCulled = false;
  g.add(fills, lines);
  return g;
}
const patch = buildPatch();
worldRoot.add(patch);

// ------------------------------------------------------------------ dust
const dust = new Dust();
scene.add(dust.points);

// ------------------------------------------------------------------ rover
const rover = buildRoverRig({ post: true });
worldRoot.add(rover.group, rover.sensorRing);
const anim = new RoverAnimator(rover);

const state = {
  sun: 100, cycle: false, headlight: false, solar: false, drill: false, drive: false, dishSweep: true,
  facing: 0, ind: [1, 2, 0], post: (Number(new URLSearchParams(location.search).get('post') ?? 0x3a) || 0) & 255, postCount: false, cpu: 0, damaged: false, bloom: true, crt: true, labels: true, follow: true,
  x: 0, y: 0, moveT: 0, angle: 0,
};
const CPU: RoverPose['cpu'][] = ['run', 'idle', 'fault', 'off'];
const FACING = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
const DIRV: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // world dx, dy

// ------------------------------------------------------------------ controls
function button(tag: string, label: string, get: () => string | boolean, act: () => void): void {
  const el = document.createElement('button');
  const draw = () => {
    const v = get();
    el.innerHTML = `<span class="tag">${tag}</span><br>${label}${typeof v === 'string' ? `: <b>${v}</b>` : ''}`;
    el.classList.toggle('on', v === true || (typeof v === 'string' && v !== 'OFF'));
  };
  el.addEventListener('click', () => {
    act();
    draw();
  });
  draw();
  controlsEl.appendChild(el);
}
function slider(tag: string, min: number, max: number, get: () => number, set: (v: number) => void): HTMLInputElement {
  const l = document.createElement('label');
  l.innerHTML = `<span class="tag">${tag}</span>`;
  const i = document.createElement('input');
  i.type = 'range';
  i.min = String(min);
  i.max = String(max);
  i.value = String(get());
  i.addEventListener('input', () => set(+i.value));
  l.appendChild(i);
  controlsEl.appendChild(l);
  return i;
}
const sunSlider = slider('@SUN light (day ↔ night)', 0, 100, () => state.sun, (v) => (state.sun = v));
button('auto', 'Day/night cycle', () => state.cycle, () => (state.cycle = !state.cycle));
button('@HEADLIGHT', 'Headlight', () => state.headlight, () => (state.headlight = !state.headlight));
button('@SOLAR', 'Solar wings', () => state.solar, () => (state.solar = !state.solar));
button('TOOL DRILL', 'Ventral drill', () => state.drill, () => (state.drill = !state.drill));
button('STEP', 'Drive', () => state.drive, () => (state.drive = !state.drive));
button('@FACING', 'Turn 90° CW', () => FACING[state.facing], () => (state.facing = (state.facing + 1) % 4));
button('@ANTENNA', 'Dish sweep', () => state.dishSweep, () => (state.dishSweep = !state.dishSweep));
for (let i = 0; i < 3; i++)
  button(`@IND${i + 1}`, `Status lamp ${i + 1}`, () => ['OFF', 'RED', 'GREEN', 'BLUE', 'AMBER'][state.ind[i]], () => (state.ind[i] = (state.ind[i] + 1) % 5));
button('@POST', 'Hex display (+1)', () => state.post.toString(16).toUpperCase().padStart(2, '0'), () => (state.post = (state.post + 1) & 255));
button('@POST', 'Count up 0..FF', () => state.postCount, () => (state.postCount = !state.postCount));
button('CPU', 'vMCU state', () => CPU[state.cpu].toUpperCase(), () => (state.cpu = (state.cpu + 1) % 4));
button('HEALTH', 'Damaged dish/solar', () => state.damaged, () => (state.damaged = !state.damaged));
button('SCAN', 'Scan pulse + radar wave', () => false, () => {
  const [dx, dy] = DIRV[state.facing];
  radarAt = performance.now();
  fx.scan(Math.round(state.x), Math.round(state.y), [0, 1, 2, 3][state.facing], 4, dx === 1 && dy === 0 ? 0xff5a4a : 0x3affc8, performance.now());
});
button('LOG', 'Uplink', () => false, () => fx.uplink(Math.round(state.x), Math.round(state.y), true, 40, performance.now(), true));
button('POST', 'Bloom', () => state.bloom, () => (post.enabled = state.bloom = !state.bloom));
button('POST', 'CRT scanlines', () => state.crt, () => view.classList.toggle('crt', (state.crt = !state.crt)));
button('UI', 'Labels', () => state.labels, () => (state.labels = !state.labels));
button('CAM', 'Close-up', () => false, () => { rig.dist = 3.2; rig.rotateTo(rig.yaw, 1.05); });
button('CAM', 'Tactical', () => false, () => { rig.dist = 14; rig.rotateTo(rig.yaw, 0.85); });
button('CAM', 'Top-down', () => false, () => { rig.dist = 22; rig.setPitch(0.02); });
button('CAM', 'Far / strategic', () => false, () => { rig.dist = 60; rig.setPitch(0.5); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') rig.rotateTo(rig.yaw + Math.PI / 2);
  if (e.key === 'e' || e.key === 'E') rig.rotateTo(rig.yaw - Math.PI / 2);
  if (e.key === 't' || e.key === 'T') rig.setPitch(rig.pitch > 0.1 ? 0.02 : 0.85);
});
rig.onUserPan = () => (state.follow = false);
renderer.domElement.addEventListener('dblclick', () => (state.follow = true));

// Radar wave of the last SCAN (?radar=0.4 freezes it at 0.4 s for screenshots).
let radarAt = -Infinity;
// Query-string presets for screenshots: ?sun=0&headlight=1&solar=1&dist=4&pitch=1&yaw=-0.5&drill=1
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? +q.get(k)! : d);
state.sun = num('sun', state.sun);
sunSlider.value = String(state.sun);
state.headlight = q.get('headlight') === '1';
state.solar = q.get('solar') === '1';
state.drill = q.get('drill') === '1';
state.facing = num('facing', 0);
state.labels = q.get('labels') !== '0';
rig.dist = num('dist', rig.dist);
rig.pitch = num('pitch', rig.pitch);
rig.yaw = num('yaw', rig.yaw);
if (q.has('fx')) {
  state.follow = false;
  rig.focusX = num('fx', 0);
  rig.focusY = num('fy', 0);
}
if (q.get('crt') === '0') view.classList.remove('crt'), (state.crt = false);

// ------------------------------------------------------------------ Code tab, listing, Comms
// ?editor=1: the Code tab with the machine-code listing and dumps, and the Comms tab (uiLab.ts).
if (q.get('editor') === '1') void import('./uiLab').then((m) => m.mountUiLab(document.getElementById('photolab')!, q));

// ------------------------------------------------------------------ science products (POC)
// ?photos=1 shows what a 16-byte camera / spectrometer product could look like.
if (q.get('photos') === '1') mountPhotoLab(document.getElementById('photolab')!, q);
// ?anomaly=1: M9 slice 6 fossil anomalies through every camera mode (game generator).
if (q.get('anomaly') === '1') mountAnomalyLab(document.getElementById('photolab')!);

// ------------------------------------------------------------------ frame
function resize(): void {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  post.setSize(w, h);
  rig.resize(w, h);
  dust.setViewportHeight(renderer.domElement.height);
}
new ResizeObserver(resize).observe(view);
resize();

const DAY_BG = new THREE.Color(0x07101a);
const NIGHT_BG = new THREE.Color(0x020306);
const DUSK = new THREE.Color(1.18, 0.82, 0.62);
const NOON = new THREE.Color(1, 1, 1);
const labelDivs = specimens.map(([name]) => {
  const d = document.createElement('div');
  d.textContent = name;
  labelsEl.appendChild(d);
  return d;
});

let last = performance.now();
let frames = 0, fpsT = 0, fps = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = now / 1000;

  if (state.cycle) {
    state.sun = Math.max(0, Math.round(Math.sin(t * 0.25) * 130));
    sunSlider.value = String(Math.min(100, state.sun));
  }
  const light = Math.min(100, state.sun) / 100;

  // Drive: one tile per 0.7 s along the facing; turn around at the patch edge.
  if (state.drive) {
    state.moveT += dt / 0.7;
    if (state.moveT >= 1) {
      state.moveT = 0;
      const [dx, dy] = DIRV[state.facing];
      state.x = Math.round(state.x) + dx;
      state.y = Math.round(state.y) + dy;
      const nx = state.x + dx, ny = state.y + dy;
      if (Math.abs(nx) > 7 || Math.abs(ny) > 7 || cells.get(key(nx, ny))?.obstacle) state.facing = (state.facing + 1) % 4;
    }
  }
  const [mdx, mdy] = DIRV[state.facing];
  const px = state.x + (state.drive ? mdx * state.moveT : 0);
  const py = state.y + (state.drive ? mdy * state.moveT : 0);
  if (state.follow) {
    rig.focusX += (px + 0.5 - rig.focusX) * Math.min(1, dt * 6);
    rig.focusY += (py + 0.5 - rig.focusY) * Math.min(1, dt * 6);
  }
  rig.lockFocus = state.follow;
  rig.update(dt);
  const fxp = rig.focusX, fyp = rig.focusY;

  // Floating origin.
  patch.position.set(-fxp, 0, fyp);
  rover.group.position.set(px + 0.5 - fxp, 0, -(py + 0.5 - fyp));
  rover.sensorRing.position.copy(rover.group.position);
  const target = -state.facing * (Math.PI / 2);
  let d = target - state.angle;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  state.angle += d * Math.min(1, dt * 10);

  // Same shape as the simulation (src/core/sensors.ts): day disc, night ring + cone.
  const sensor = light > 0 ? BALANCE.dayViewRange : BALANCE.nightSensorRange;
  rover.sensorRing.scale.setScalar(sensor + 0.5);
  const sunBearing = (t * 20) % 360;
  anim.update(
    {
      angle: state.angle,
      moving: state.drive,
      deploy: q.has('deploy') ? num('deploy', 0) : state.solar ? 1 : 0,
      solarRel: (-sunBearing * Math.PI) / 180 - state.angle,
      dishRel: state.dishSweep ? Math.sin(t * 0.8) * 0.9 - 0.5 : 0,
      solarHealth: state.damaged ? 35 : 100,
      dishHealth: state.damaged ? 45 : 100,
      cpu: CPU[state.cpu],
      indicators: state.ind.map((v) => indicatorHex(state.cpu === 3 ? 0 : v)),
      post: state.cpu === 3 ? null : state.postCount ? Math.floor(t * 4) & 255 : state.post,
      headlight: state.headlight && state.cpu !== 3,
      drilling: state.drill,
      sensorRange: sensor,
    },
    dt,
    t,
  );

  // Lighting uniforms: sunlight and the rover's tile light.
  const u = lighting.uniforms;
  const day = THREE.MathUtils.smoothstep(light, 0, 0.35);
  u.uDay.value = day;
  u.uGrade.value.copy(DUSK).lerp(NOON, THREE.MathUtils.smoothstep(light, 0.05, 0.6));
  u.uLightCount.value = 1;
  u.uLights.value[0].set(Math.round(px) + 0.5 - fxp, -(Math.round(py) + 0.5 - fyp), sensor, 0);
  const hl = state.headlight && state.cpu !== 3;
  u.uBeams.value[0].set(DIRV[state.facing][0], -DIRV[state.facing][1], hl && light <= 0 ? 1 : 0, 0);
  const radarAge = q.has('radar') ? num('radar', 0) : (now - radarAt) / 1000;
  const front = radarFront(radarAge, CHASSIS_MK1.sensorRange);
  u.uPulses.value[0].set(Math.round(px) + 0.5 - fxp, -(Math.round(py) + 0.5 - fyp), front, front < 0 ? 0 : CHASSIS_MK1.sensorRange);
  const bg = NIGHT_BG.clone().lerp(DAY_BG, day);
  scene.background = bg;
  const fog = scene.fog as THREE.Fog;
  fog.color.copy(bg);
  fog.near = rig.dist * 1.3;
  fog.far = rig.dist * 3.2 + 10;
  u.fogColor.value.copy(bg);
  u.fogNear.value = fog.near;
  u.fogFar.value = fog.far;
  post.bloom.strength = 0.6 + (1 - day) * 0.35;
  // Model scale: readable when zoomed far out.
  rover.model.scale.setScalar(THREE.MathUtils.clamp(rig.dist / 30, 1, 2.5));

  // Dust drifts with the wind; brighter by day, caught by the headlight at night.
  dust.update(t, day, fog);

  fx.update(fxp, fyp, now);
  post.render(scene, rig.camera);

  // Labels.
  const w = view.clientWidth, h = view.clientHeight;
  specimens.forEach(([, x, y], i) => {
    const v = new THREE.Vector3(x + 0.5 - fxp, 0.9, -(y + 0.5 - fyp)).project(rig.camera);
    const el = labelDivs[i];
    const show = state.labels && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && rig.dist < 40;
    el.style.display = show ? '' : 'none';
    if (show) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
  });

  frames++;
  fpsT += dt;
  if (fpsT > 0.5) {
    fps = frames / fpsT;
    frames = 0;
    fpsT = 0;
    statsEl.textContent = `${fps.toFixed(0)} fps · ${(1000 / Math.max(1, fps)).toFixed(1)} ms\nzoom ${rig.dist.toFixed(1)} tiles · pitch ${((rig.pitch * 180) / Math.PI).toFixed(0)}°\nsun ${Math.min(100, state.sun)} · sensor ${sensor} tiles\n${geoStats}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
