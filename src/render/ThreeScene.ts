import * as THREE from 'three';
import type { SimulationEngine } from '../core/SimulationEngine';
import { CpuState, DIR_VEC } from '../core/types';
import type { Unit } from '../core/Unit';
import { BALANCE } from '../core/balance';
import { FrameStats } from './FrameStats';
import { ChunkPool } from './ChunkPool';
import { FxOverlay } from './FxOverlay';
import { CameraRig } from './CameraRig';
import { Dust } from './Dust';
import { AdaptiveResolution } from './AdaptiveResolution';
import { PostFx } from './PostFx';
import { RoverAnimator, type RoverPose } from './RoverRig';
import { MAX_LIGHTS, radarFront, TileLighting } from './TileLighting';
import { buildCapsuleMesh, buildRoverRig, indicatorHex, type RoverRigMesh } from './VectorFactory';

interface RoverView {
  mesh: RoverRigMesh;
  anim: RoverAnimator;
  /** Eased body yaw (radians). */
  angle: number;
  /** performance.now() of the last SCAN (radar wave). */
  radarAt: number;
  /** Reused pose arrays (no per-frame allocation). */
  indicators: number[];
}

/** How far (tiles) the camera focus may be panned away from the rover. */
export const PAN_LEASH = 24;

/** While paused and idle, render at most this often (ms): ~30 fps saves laptop battery. */
export const IDLE_FRAME_MS = 33;
/** The camera counts as idle this long (ms) after the last input. */
export const IDLE_AFTER_MS = 1000;

export interface PerfSnapshot {
  fps: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
  cpuMs: number;
  drawCalls: number;
  triangles: number;
  lines: number;
  chunkMeshes: number;
  lineVertices: number;
  fillTriangles: number;
  chunkBuilds: number;
  chunkBuildMs: number;
  /** Chunks updated in place (fog only, no rebuild) last frame. */
  chunkPatches: number;
  pixelRatio: number;
  width: number;
  height: number;
  bloom: boolean;
}

export type ViewMode = 'angled' | 'top';

const ANGLED_PITCH = 0.85;
const TOP_PITCH = 0.02;
const DAY_BG = new THREE.Color(0x07101a);
const NIGHT_BG = new THREE.Color(0x020306);
const DUSK = new THREE.Color(1.18, 0.82, 0.62);
const NOON = new THREE.Color(1, 1, 1);

/**
 * Three.js viewport (M8 v2 look): wireframe-with-fills chunks under per-tile lighting,
 * bloom, orbit camera, animated rover rig. Read-only consumer of the simulation: it never
 * mutates sim state (apart from touching chunks so visible ones stay loaded).
 */
export class ThreeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly post: PostFx;
  private lighting = new TileLighting();
  private worldRoot = new THREE.Group();
  private chunks: ChunkPool;
  private fx: FxOverlay;
  private rovers = new Map<number, RoverView>();

  /** Effective simulation ticks per real second (set by the app) for FX timing. */
  ticksPerSecond = 10;
  followUnitId: number | null = null;
  mode: ViewMode = 'angled';
  /** Called on shift+click with the world tile (admin teleport). */
  onTileShiftClick?: (x: number, y: number) => void;
  private squall: THREE.LineSegments;
  private squallMat: THREE.ShaderMaterial;
  private capsules = new Map<number, { capsule: THREE.LineSegments; ring: THREE.LineLoop }>();
  private liveDrops = new Set<number>();
  private dust = new Dust();
  private bg = new THREE.Color();
  private lastNow = performance.now();
  /** World tile under the mouse, or null. */
  hover: { x: number; y: number } | null = null;
  /** Frame-time stats (rolling window) for the performance HUD. */
  readonly stats = new FrameStats();
  /** Samples since the last resolution change (for AdaptiveResolution). */
  private adaptStats = new FrameStats(90);
  /** Lowers the pixel ratio on slow GPUs; null when pinned with `?dpr=`. */
  readonly adaptive: AdaptiveResolution | null;

  constructor(private container: HTMLElement, private engine: SimulationEngine) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }) // MSAA lives in PostFx;
    // `?dpr=1.5` pins the pixel ratio; otherwise start at the display's (max 2) and adapt.
    const pinned = Number(new URLSearchParams(location.search).get('dpr'));
    const maxDpr = Math.min(window.devicePixelRatio, 2);
    this.adaptive = pinned > 0 ? null : new AdaptiveResolution(maxDpr, Math.min(1, maxDpr));
    this.renderer.setPixelRatio(pinned > 0 ? pinned : maxDpr);
    container.appendChild(this.renderer.domElement);
    // Bloom renders several passes; count draw calls for the whole frame.
    this.renderer.info.autoReset = false;
    this.scene.fog = new THREE.Fog(0x050910, 30, 90);
    this.rig = new CameraRig(this.renderer.domElement);
    this.rig.dist = 14;
    this.rig.pitch = ANGLED_PITCH;
    this.rig.onUserPan = () => (this.followUnitId = null);
    this.post = new PostFx(this.renderer, this.scene, this.rig.camera);
    this.scene.add(this.worldRoot);
    this.chunks = new ChunkPool(engine, this.worldRoot, this.lighting);
    this.fx = new FxOverlay(this.worldRoot);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindInput();

    // Micrometeorite streaks, shown during squalls (purely cosmetic, Math.random is fine
    // here). Animated in the vertex shader: each streak has a random seed, both of its
    // vertices share it, `end` tells the head (1) from the tail (0).
    const N = 160;
    const seeds = new Float32Array(N * 6);
    const end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = Math.random(), b = Math.random(), c = Math.random();
      seeds.set([a, b, c, a, b, c], i * 6);
      end[i * 2 + 1] = 1;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(seeds, 3)); // seeds (positions come from the shader)
    sg.setAttribute('end', new THREE.BufferAttribute(end, 1));
    this.squallMat = squallMaterial();
    this.squall = new THREE.LineSegments(sg, this.squallMat);
    this.squall.frustumCulled = false;
    this.squall.visible = false;
    this.scene.add(this.squall);

    // Drifting dust, brighter by day (cosmetic).
    this.scene.add(this.dust.points);

    engine.events.on('SCAN_PULSE', (e) => {
      const color = e.hit ? (engine.registry.get(e.hit)?.color ?? 0xffffff) : 0x3affc8;
      this.fx.scan(e.x, e.y, e.dir, e.dist, color, performance.now());
      const v = this.rovers.get(e.unitId);
      if (v) v.radarAt = performance.now();
    });
    // Frames can finish every tick: at most one pulse per 400 ms unless science arrives.
    let lastPulse = -Infinity;
    engine.events.on('UPLINK_PULSE', (e) => {
      const now = performance.now();
      if (!e.science && now - lastPulse < 400) return;
      lastPulse = now;
      this.fx.uplink(e.x, e.y, true, engine.orbitAzimuth, now, e.science);
    });
    const toolColor: Record<string, number> = { DRILL: 0xff8a3a, GRABBER: 0x3affc8, SPECTROMETER: 0xd4a0ff, USE_ITEM: 0xffffff };
    engine.events.on('TOOL_USED', (e) => {
      // Real-time length of the action at the current speed, so the effect lasts as long as the tool.
      const ms = Math.min(4000, (e.ticks * 1000) / Math.max(1, this.ticksPerSecond));
      this.fx.tool(e.x, e.y, e.targetX, e.targetY, toolColor[e.tool] ?? 0xffffff, ms, performance.now());
    });
  }

  /** Camera yaw in radians (0 = looking north), for the compass. */
  get yaw(): number {
    return this.rig.yaw;
  }

  get focusX(): number {
    return this.rig.focusX;
  }

  get focusY(): number {
    return this.rig.focusY;
  }

  setViewMode(mode: ViewMode): void {
    this.mode = mode;
    this.rig.setPitch(mode === 'top' ? TOP_PITCH : ANGLED_PITCH);
  }

  /** Rotate the camera by quarter turns (Q/E). */
  rotate(quarters: number): void {
    this.rig.rotateTo(Math.round(this.rig.yaw / (Math.PI / 2) + quarters) * (Math.PI / 2));
  }

  setBloom(on: boolean): void {
    this.post.enabled = on;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.rig.resize(w, h);
    this.dust.setViewportHeight(this.renderer.domElement.height);
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    // CameraRig handles pan / orbit / zoom; shift+click is the admin teleport.
    el.addEventListener('pointerdown', (e) => {
      if (e.shiftKey && this.hover && this.onTileShiftClick) this.onTileShiftClick(this.hover.x, this.hover.y);
    });
    el.addEventListener('pointermove', (e) => (this.hover = this.rig.tileAt(e.clientX, e.clientY)));
    el.addEventListener('pointerleave', () => (this.hover = null));
    el.addEventListener('dblclick', () => {
      const u = this.engine.units[0];
      if (u) this.followUnitId = u.id;
    });
  }

  /** Visual position of a unit at fractional sim time. */
  private unitPos(u: Unit, simTime: number): [number, number] {
    const m = u.motion;
    if (m && simTime < m.endTick && u.action?.kind === 'STEP') {
      const t = THREE.MathUtils.clamp((simTime - m.startTick) / (m.endTick - m.startTick), 0, 1);
      return [m.fromX + (m.toX - m.fromX) * t + 0.5, m.fromY + (m.toY - m.fromY) * t + 0.5];
    }
    return [u.x + 0.5, u.y + 0.5];
  }

  /**
   * Draw a frame. With `paused` (simulation stopped) and an idle camera, frames are
   * throttled to IDLE_FRAME_MS; returns false when this frame was skipped.
   */
  render(alpha: number, now: number, paused = false): boolean {
    const throttled = paused && this.followSettled() && !this.rig.easing && now - this.rig.lastInputAt > IDLE_AFTER_MS;
    if (throttled && now - this.lastNow < IDLE_FRAME_MS - 2) return false;
    const cpu0 = performance.now();
    const intervalMs = now - this.lastNow;
    this.renderer.info.reset();
    const dt = Math.min(0.1, Math.max(0, intervalMs / 1000));
    this.lastNow = now;
    const t = now / 1000;
    const simTime = this.engine.tick + alpha;
    const rig = this.rig;

    if (this.followUnitId !== null) {
      const u = this.engine.getUnit(this.followUnitId);
      if (u) {
        const [x, y] = this.unitPos(u, simTime);
        // Ease toward the rover so the camera does not jitter.
        const k = Math.min(1, dt * 6);
        rig.focusX += (x - rig.focusX) * k;
        rig.focusY += (y - rig.focusY) * k;
      }
    }
    rig.lockFocus = this.followUnitId !== null;
    // Panning stays near the rover (followed one, else the first).
    const anchor = this.engine.getUnit(this.followUnitId ?? -1) ?? this.engine.units[0];
    if (anchor) {
      const [ax, ay] = this.unitPos(anchor, simTime);
      rig.leash = { x: ax, y: ay, r: PAN_LEASH };
    } else rig.leash = null;
    rig.update(dt);
    const fx = rig.focusX, fy = rig.focusY;

    const fogNear = rig.dist * 1.3;
    const fogFar = rig.dist * 3.2 + 10;
    const radius = Math.min(6, Math.ceil(Math.min(rig.viewRadius, fogFar) / 16) + 1);
    this.chunks.update(fx, fy, radius, fogFar);

    const light = this.engine.sun.light / 100;
    const day = THREE.MathUtils.smoothstep(light, 0, 0.35);
    const L = this.lighting.uniforms;
    let li = 0;

    for (const u of this.engine.units) {
      let v = this.rovers.get(u.id);
      if (!v) {
        const mesh = buildRoverRig({ post: true });
        this.worldRoot.add(mesh.group, mesh.sensorRing);
        v = { mesh, anim: new RoverAnimator(mesh), angle: -u.heading * (Math.PI / 2), radarAt: -Infinity, indicators: [] };
        this.rovers.set(u.id, v);
      }
      const [x, y] = this.unitPos(u, simTime);
      v.mesh.group.position.set(x - fx, 0, -(y - fy));
      v.mesh.sensorRing.position.copy(v.mesh.group.position);
      // Heading: forward is -Z at angle 0; EAST = -90°.
      const target = -u.heading * (Math.PI / 2);
      let d = target - v.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      v.angle += d * Math.min(1, dt * 10);

      const view = this.engine.viewShape(u);
      const dead = u.vm.state === CpuState.POWER_OFF || u.vm.state === CpuState.DESTROYED;
      const fault = u.vm.state === CpuState.FAULT;
      // Turntables use compass bearings (0 = north = -Z), relative to the body.
      const bearing = (deg: number) => (-deg * Math.PI) / 180 - v!.angle;
      const pose: RoverPose = {
        angle: v.angle,
        moving: u.action?.kind === 'STEP',
        deploy: u.solarDeploy / BALANCE.solarDeployTicks,
        solarRel: bearing(u.solarAngle),
        dishRel: bearing(u.antennaAngle),
        solarHealth: u.solarHealth,
        dishHealth: u.antennaHealth,
        cpu: dead ? 'off' : fault ? 'fault' : u.action?.kind === 'WAIT' ? 'idle' : 'run',
        indicators: fillIndicators(v.indicators, u.indicators, dead),
        // Dark while powered off. The operator's view is centred on the rover, so its
        // display is always in view.
        post: dead ? null : u.post,
        headlight: !!u.headlight && !dead,
        drilling: u.action?.kind === 'TOOL' && u.action.tool === 'DRILL',
        sensorRange: view.radius,
      };
      v.anim.update(pose, dt, t);
      v.mesh.sensorRing.scale.setScalar(view.radius + 0.5);
      // Readable when zoomed far out.
      v.mesh.model.scale.setScalar(THREE.MathUtils.clamp(rig.dist / 30, 1, 2.5));

      // Tile lighting: the operator's view (same shape as sensors.ts) and the radar wave.
      if (li < MAX_LIGHTS) {
        const tx = u.x + 0.5 - fx, tz = -(u.y + 0.5 - fy);
        L.uLights.value[li].set(tx, tz, view.radius, 0);
        const [hx, hy] = DIR_VEC[view.cone >= 0 ? view.cone : 0];
        L.uBeams.value[li].set(hx, -hy, view.cone >= 0 ? 1 : 0, 0);
        const range = this.engine.sensorRange(u);
        const front = radarFront((now - v.radarAt) / 1000, range);
        L.uPulses.value[li].set(tx, tz, front, front < 0 ? 0 : range);
        li++;
      }
    }
    L.uLightCount.value = li;
    L.uDay.value = day;
    L.uGrade.value.copy(DUSK).lerp(NOON, THREE.MathUtils.smoothstep(light, 0.05, 0.6));

    const bg = this.bg.copy(NIGHT_BG).lerp(DAY_BG, day);
    this.scene.background = bg;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(bg);
    fog.near = fogNear;
    fog.far = fogFar;
    L.fogColor.value.copy(bg);
    L.fogNear.value = fog.near;
    L.fogFar.value = fog.far;
    this.post.bloom.strength = 0.6 + (1 - day) * 0.35;

    this.dust.update(t, day, fog);
    this.updateSquall(now, fog);
    this.updateCapsules(simTime, now);
    this.fx.update(fx, fy, now);
    this.post.render(this.scene, rig.camera);
    if (intervalMs > 0) {
      const cpuMs = performance.now() - cpu0;
      this.stats.push(intervalMs, cpuMs);
      // Throttled frames are slow on purpose: they say nothing about the GPU.
      if (throttled) this.adaptStats.reset();
      else {
        this.adaptStats.push(intervalMs, cpuMs);
        this.adaptResolution(now);
      }
    }
    return true;
  }

  /** The follow camera has caught up with its rover (no easing left). */
  private followSettled(): boolean {
    if (this.followUnitId === null) return true;
    const u = this.engine.getUnit(this.followUnitId);
    if (!u) return true;
    return Math.abs(u.x + 0.5 - this.rig.focusX) < 0.01 && Math.abs(u.y + 0.5 - this.rig.focusY) < 0.01;
  }

  private adaptResolution(now: number): void {
    // Hidden tabs and long stalls (debugger, tab switch) say nothing about the GPU.
    if (!this.adaptive || document.hidden || this.adaptStats.worstMs > 500) {
      if (this.adaptStats.worstMs > 500) this.adaptStats.reset();
      return;
    }
    const s = this.adaptStats;
    const r = this.adaptive.update(now, s.avgMs, s.cpuMs, s.samples);
    if (r === null) return;
    this.renderer.setPixelRatio(r);
    this.resize();
    s.reset();
  }

  /** Numbers for the performance HUD. */
  get perf(): PerfSnapshot {
    const info = this.renderer.info;
    const s = this.stats;
    return {
      fps: s.fps,
      avgMs: s.avgMs,
      p95Ms: s.p95Ms,
      worstMs: s.worstMs,
      cpuMs: s.cpuMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      chunkMeshes: this.chunks.size,
      lineVertices: this.chunks.lineVertices,
      fillTriangles: this.chunks.fillTriangles,
      chunkBuilds: this.chunks.lastBuilds,
      chunkBuildMs: this.chunks.lastBuildMs,
      chunkPatches: this.chunks.lastPatches,
      pixelRatio: this.renderer.getPixelRatio(),
      width: this.renderer.domElement.width,
      height: this.renderer.domElement.height,
      bloom: this.post.enabled,
    };
  }

  centerOn(u: Unit): void {
    this.followUnitId = u.id;
    this.rig.focusX = u.x + 0.5;
    this.rig.focusY = u.y + 0.5;
  }

  /** Supply crates in flight: a parachute capsule descending onto a pulsing target ring. */
  private updateCapsules(simTime: number, now: number): void {
    const live = this.liveDrops;
    live.clear();
    for (const d of this.engine.drops) {
      if (d.landed) continue;
      live.add(d.id);
      let c = this.capsules.get(d.id);
      if (!c) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < 24; i++) pts.push(new THREE.Vector3(Math.cos((i / 24) * Math.PI * 2) * 0.6, 0.02, Math.sin((i / 24) * Math.PI * 2) * 0.6));
        const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd23a, transparent: true }));
        c = { capsule: buildCapsuleMesh(), ring };
        c.capsule.frustumCulled = c.ring.frustumCulled = false;
        this.worldRoot.add(c.capsule, c.ring);
        this.capsules.set(d.id, c);
      }
      const left = Math.max(0, d.landTick - simTime) / BALANCE.supplyDropTicks;
      const px = d.x + 0.5 - this.rig.focusX;
      const pz = -(d.y + 0.5 - this.rig.focusY);
      c.capsule.position.set(px + left * 4, left * 18, pz - left * 2);
      c.ring.position.set(px, 0, pz);
      c.ring.scale.setScalar(1 + 0.25 * Math.sin(now / 150));
      (c.ring.material as THREE.LineBasicMaterial).opacity = 0.5 + 0.5 * Math.sin(now / 150);
    }
    for (const [id, c] of this.capsules) {
      if (live.has(id)) continue;
      this.worldRoot.remove(c.capsule, c.ring);
      c.capsule.geometry.dispose();
      c.ring.geometry.dispose();
      this.capsules.delete(id);
    }
  }

  private updateSquall(now: number, fog: THREE.Fog): void {
    const active = this.engine.director.isActive('SQUALL', this.engine.tick);
    this.squall.visible = active;
    if (!active) return;
    const u = this.squallMat.uniforms;
    u.uPhase.value = (now / 900) % 1;
    u.uSpan.value = Math.min(80, this.rig.dist * 1.6 + 8);
    u.fogColor.value.copy(fog.color);
    u.fogNear.value = fog.near;
    u.fogFar.value = fog.far;
  }

  setRevealAll(v: boolean): void {
    this.chunks.setRevealAll(v);
  }
}

/** Indicator lamp colours into a reused array. */
function fillIndicators(out: number[], ind: number[], dead: boolean): number[] {
  out.length = ind.length;
  for (let i = 0; i < ind.length; i++) out[i] = indicatorHex(dead ? 0 : ind[i]);
  return out;
}

/** Squall streaks: a fall phase per streak from its seed (see the constructor). */
function squallMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uPhase: { value: 0 },
      uSpan: { value: 30 },
      uColor: { value: new THREE.Color(0xffb070) },
      uOpacity: { value: 0.8 },
    },
    vertexShader: /* glsl */ `
      uniform float uPhase;
      uniform float uSpan;
      attribute float end;
      #include <fog_pars_vertex>
      void main() {
        vec3 s = position; // random seeds in [0, 1)
        float t = fract(s.z + uPhase);
        vec3 p = vec3((s.x - 0.5) * uSpan, 12.0 * (1.0 - t), (s.y - 0.5) * uSpan);
        p += (1.0 - end) * vec3(-0.9, 1.6, -0.5); // tail trails up and back
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
        #include <fog_fragment>
      }`,
    transparent: true,
    fog: true,
  });
}
