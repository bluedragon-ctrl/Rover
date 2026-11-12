/**
 * M8 asset preview (preview.html): every v2 shape, the tile lighting, bloom, camera and
 * rover animation on a small hand-made patch, with switches for the rover subsystems.
 * Not part of the game; it exists so visuals can be reviewed before they ship.
 */
import * as THREE from 'three';
import { createDefaultRegistry, T } from '../core/WorldRegistry';
import { hash3 } from '../core/rng';
import { BALANCE } from '../core/balance';
import { CameraRig } from '../render/CameraRig';
import { PostFx } from '../render/PostFx';
import { RoverAnimator, type RoverPose } from '../render/RoverRig';
import { TileLighting } from '../render/TileLighting';
import { FxOverlay } from '../render/FxOverlay';
import { buildRoverRig, drawFogTile, drawTileVec, FillBatch, indicatorHex, LineBatch, LIGHT_HEX } from '../render/VectorFactory';

const view = document.getElementById('view')!;
const labelsEl = document.getElementById('labels')!;
const statsEl = document.getElementById('stats')!;
const controlsEl = document.getElementById('controls')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
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
for (const [x, y] of [[3, 4], [4, 4], [5, 4], [5, 5], [6, 5], [4, 5], [6, 6], [7, 6], [2, 4], [-6, 7], [-5, 7], [-5, 8], [8, -3], [8, -4], [9, -4]]) put(x, y, 'obstacle', T.CLIFF_WALL);
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
  ['SAMPLE', -2, -2], ['SUPPLY_CRATE', 0, -4], ['ROUGH_GRAVEL', -1, 0], ['unexplored', 11, 0],
];
put(0, 0, 'terrain', T.FLAT_SAND);
put(-1, 0, 'terrain', T.ROUGH_GRAVEL);

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
        drawTileVec(b, f, d.shape, d.color, x, y, variant);
      }
    }
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
const DUST = 500;
const dustPos = new Float32Array(DUST * 3).map((_, i) => (i % 3 === 1 ? Math.random() * 3 : (Math.random() - 0.5) * 40));
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({ color: 0xd8b48a, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false });
const dust = new THREE.Points(dustGeo, dustMat);
dust.frustumCulled = false;
scene.add(dust);

// ------------------------------------------------------------------ rover
const rover = buildRoverRig();
worldRoot.add(rover.group, rover.sensorRing);
const anim = new RoverAnimator(rover);

const state = {
  sun: 100, cycle: false, headlight: false, solar: false, drill: false, drive: false, dishSweep: true,
  facing: 0, led: 2, ind: [1, 2, 0], cpu: 0, damaged: false, bloom: true, crt: true, labels: true, follow: true,
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
button('@LIGHT', 'Status LED', () => ['OFF', 'RED', 'GREEN', 'BLUE', 'AMBER'][state.led], () => (state.led = (state.led % 4) + 1));
for (let i = 0; i < 3; i++)
  button(`@IND${i + 1}`, `Indicator ${i + 1}`, () => ['OFF', 'RED', 'GREEN', 'BLUE', 'AMBER'][state.ind[i]], () => (state.ind[i] = (state.ind[i] + 1) % 5));
button('CPU', 'vMCU state', () => CPU[state.cpu].toUpperCase(), () => (state.cpu = (state.cpu + 1) % 4));
button('HEALTH', 'Damaged dish/solar', () => state.damaged, () => (state.damaged = !state.damaged));
button('SCAN', 'Scan pulse', () => false, () => {
  const [dx, dy] = DIRV[state.facing];
  fx.scan(Math.round(state.x), Math.round(state.y), [0, 1, 2, 3][state.facing], 4, dx === 1 && dy === 0 ? 0xff5a4a : 0x3affc8, performance.now());
});
button('@TX_DATA', 'Uplink', () => false, () => fx.uplink(Math.round(state.x), Math.round(state.y), true, 40, performance.now(), true));
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

// ------------------------------------------------------------------ frame
function resize(): void {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  post.setSize(w, h);
  rig.resize(w, h);
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
  const blinkOff = state.cpu === 3 || (state.led === 1 && Math.floor(now / 300) % 2 === 1);
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
      beaconHex: blinkOff ? 0x222222 : LIGHT_HEX[state.led],
      indicators: state.ind.map((v) => indicatorHex(state.cpu === 3 ? 0 : v)),
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
  const dp = dustGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < DUST; i++) {
    let x = dp.getX(i) + dt * 0.6, z = dp.getZ(i) + dt * 0.15;
    if (x > 20) x -= 40;
    if (z > 20) z -= 40;
    dp.setXYZ(i, x, dp.getY(i) + Math.sin(t + i) * dt * 0.05, z);
  }
  dp.needsUpdate = true;
  dustMat.opacity = 0.12 + 0.35 * day;

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
    statsEl.textContent = `${fps.toFixed(0)} fps · ${(1000 / Math.max(1, fps)).toFixed(1)} ms\nzoom ${rig.dist.toFixed(1)} tiles · pitch ${((rig.pitch * 180) / Math.PI).toFixed(0)}°\nsun ${Math.min(100, state.sun)} · sensor ${sensor} tiles`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
