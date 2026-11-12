import * as THREE from 'three';
import type { SimulationEngine } from '../core/SimulationEngine';
import { CpuState } from '../core/types';
import type { Unit } from '../core/Unit';
import { ChunkPool } from './ChunkPool';
import { FxOverlay } from './FxOverlay';
import { BALANCE } from '../core/balance';
import { buildCapsuleMesh, buildRoverMesh, indicatorHex, LIGHT_HEX, type RoverMesh } from './VectorFactory';

interface RoverView extends RoverMesh {
  angle: number;
}

export type ViewMode = 'angled' | 'top';

/**
 * Three.js viewport. Read-only consumer of the simulation: it never mutates sim state
 * (apart from touching chunks so visible ones stay loaded).
 */
export class ThreeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private worldRoot = new THREE.Group();
  private chunks: ChunkPool;
  private fx: FxOverlay;
  private rovers = new Map<number, RoverView>();
  private viewSize = 28; // tiles visible vertically at zoom 1
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /** Effective simulation ticks per real second (set by the app) for FX timing. */
  ticksPerSecond = 10;
  /** Camera focus in world tile coordinates (float). */
  focusX = 0.5;
  focusY = 0.5;
  followUnitId: number | null = null;
  mode: ViewMode = 'angled';
  /** Called on shift+click with the world tile (admin teleport). */
  onTileShiftClick?: (x: number, y: number) => void;
  private squall: THREE.LineSegments;
  private capsules = new Map<number, { capsule: THREE.LineSegments; ring: THREE.LineLoop }>();
  private squallSeeds: Float32Array;
  /** World tile under the mouse, or null. */
  hover: { x: number; y: number } | null = null;

  constructor(private container: HTMLElement, private engine: SimulationEngine) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070c);
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
    this.scene.add(this.worldRoot);
    this.chunks = new ChunkPool(engine, this.worldRoot);
    this.fx = new FxOverlay(this.worldRoot);
    this.applyViewMode();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindInput();

    // Micrometeorite streaks, shown during squalls (purely cosmetic, Math.random is fine here).
    const N = 160;
    this.squallSeeds = new Float32Array(N * 3).map(() => Math.random());
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 6), 3));
    this.squall = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xffb070, transparent: true, opacity: 0.8 }));
    this.squall.frustumCulled = false;
    this.squall.visible = false;
    this.scene.add(this.squall);

    engine.events.on('SCAN_PULSE', (e) => {
      const color = e.hit ? (engine.registry.get(e.hit)?.color ?? 0xffffff) : 0x3affc8;
      this.fx.scan(e.x, e.y, e.dir, e.dist, color, performance.now());
    });
    engine.events.on('UPLINK_PULSE', (e) => this.fx.uplink(e.x, e.y, e.ok, engine.orbitAzimuth, performance.now(), e.science));
    const toolColor: Record<string, number> = { DRILL: 0xff8a3a, GRABBER: 0x3affc8, SPECTROMETER: 0xd4a0ff, USE_ITEM: 0xffffff };
    engine.events.on('TOOL_USED', (e) => {
      // Real-time length of the action at the current speed, so the effect lasts as long as the tool.
      const ms = Math.min(4000, (e.ticks * 1000) / Math.max(1, this.ticksPerSecond));
      this.fx.tool(e.x, e.y, e.targetX, e.targetY, toolColor[e.tool] ?? 0xffffff, ms, performance.now());
    });
  }

  setViewMode(mode: ViewMode): void {
    this.mode = mode;
    this.applyViewMode();
  }

  private applyViewMode(): void {
    if (this.mode === 'top') {
      this.camera.position.set(0, 100, 0);
      this.camera.up.set(0, 0, -1);
    } else {
      this.camera.position.set(0, 50, 72);
      this.camera.up.set(0, 1, 0);
    }
    this.camera.lookAt(0, 0, 0);
    this.resize();
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const vs = this.viewSize;
    this.camera.left = (-vs * aspect) / 2;
    this.camera.right = (vs * aspect) / 2;
    this.camera.top = vs / 2;
    this.camera.bottom = -vs / 2;
    this.camera.updateProjectionMatrix();
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    let drag: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.shiftKey && this.hover && this.onTileShiftClick) {
        this.onTileShiftClick(this.hover.x, this.hover.y);
        return;
      }
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointerup', () => (drag = null));
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      if (drag) {
        const scale = this.viewSize / this.camera.zoom / rect.height;
        const dx = (e.clientX - drag.x) * scale;
        const dy = (e.clientY - drag.y) * scale * (this.mode === 'angled' ? 1.75 : 1);
        if (Math.abs(dx) + Math.abs(dy) > 0) this.followUnitId = null;
        this.focusX -= dx;
        this.focusY += dy;
        drag = { x: e.clientX, y: e.clientY };
      }
      this.updateHover(e.clientX - rect.left, e.clientY - rect.top, rect);
    });
    el.addEventListener('pointerleave', () => (this.hover = null));
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * Math.exp(-e.deltaY * 0.0012), 0.35, 4);
        this.camera.updateProjectionMatrix();
      },
      { passive: false },
    );
  }

  private updateHover(px: number, py: number, rect: DOMRect): void {
    const ndc = new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      this.hover = null;
      return;
    }
    this.hover = { x: Math.floor(hit.x + this.focusX), y: Math.floor(-hit.z + this.focusY) };
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

  render(alpha: number, now: number): void {
    const simTime = this.engine.tick + alpha;

    if (this.followUnitId !== null) {
      const u = this.engine.getUnit(this.followUnitId);
      if (u) {
        const [x, y] = this.unitPos(u, simTime);
        // Ease toward the rover so the camera does not jitter.
        this.focusX += (x - this.focusX) * 0.2;
        this.focusY += (y - this.focusY) * 0.2;
      }
    }

    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const halfTiles = (this.viewSize / this.camera.zoom) * Math.max(aspect, 1) * (this.mode === 'angled' ? 0.9 : 0.6);
    const radius = Math.min(6, Math.ceil(halfTiles / 16) + 1);
    this.chunks.update(this.focusX, this.focusY, radius);

    for (const u of this.engine.units) {
      let v = this.rovers.get(u.id);
      if (!v) {
        const m = buildRoverMesh();
        v = { ...m, angle: 0 };
        this.worldRoot.add(m.group);
        this.worldRoot.add(m.sensorRing);
        this.rovers.set(u.id, v);
      }
      const [x, y] = this.unitPos(u, simTime);
      v.group.position.set(x - this.focusX, 0, -(y - this.focusY));
      // Heading: forward is -Z at angle 0; EAST = -90°.
      const target = -u.heading * (Math.PI / 2);
      let d = target - v.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      v.angle += d * 0.25;
      v.group.rotation.y = v.angle;

      // Turntables use compass bearings (0 = north = -Z), relative to the body.
      const bearing = (deg: number) => (-deg * Math.PI) / 180 - v!.angle;
      const deploy = u.solarDeploy / BALANCE.solarDeployTicks;
      v.solar.visible = deploy > 0;
      v.solar.scale.set(Math.max(0.05, deploy), 1, Math.max(0.05, deploy));
      v.solar.rotation.y = bearing(u.solarAngle);
      v.dish.rotation.y = bearing(u.antennaAngle);
      const tint = (m: THREE.LineBasicMaterial, ok: number, health: number) =>
        m.color.setHex(ok).lerp(new THREE.Color(0xff3030), 1 - health / 100);
      tint(v.solarMat, 0x5a7dff, u.solarHealth);
      tint(v.dishMat, 0x3affc8, u.antennaHealth);
      // The ring shows the operator's view disc; the headlight wedge shows the night cone.
      const range = this.engine.viewShape(u).radius + 0.5;
      v.sensorRing.position.set(x - this.focusX, 0, -(y - this.focusY));
      v.sensorRing.scale.setScalar(range);

      const dead = u.vm.state === CpuState.POWER_OFF || u.vm.state === CpuState.DESTROYED;
      const blinkOff = u.lightBlink && Math.floor(now / 300) % 2 === 1;
      const fault = u.vm.state === CpuState.FAULT;
      v.beacon.color.setHex(dead || blinkOff ? 0x222222 : fault ? (Math.floor(now / 120) % 2 ? 0xff00ff : 0x220022) : LIGHT_HEX[u.lightColor] ?? 0xffffff);
      v.headlight.visible = !!u.headlight && !dead;
      v.indicators.forEach((m, i) => m.color.setHex(indicatorHex(dead ? 0 : u.indicators[i])));
    }

    // Day/night: dim the terrain with sunlight; never fully black.
    const light = this.engine.sun.light / 100;
    this.chunks.setBrightness(0.3 + 0.7 * Math.sqrt(light));

    this.updateSquall(now);
    this.updateCapsules(simTime, now);
    this.fx.update(this.focusX, this.focusY, now);
    this.renderer.render(this.scene, this.camera);
  }

  centerOn(u: Unit): void {
    this.followUnitId = u.id;
    this.focusX = u.x + 0.5;
    this.focusY = u.y + 0.5;
  }

  /** Supply crates in flight: a parachute capsule descending onto a pulsing target ring. */
  private updateCapsules(simTime: number, now: number): void {
    const live = new Set<number>();
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
      const px = d.x + 0.5 - this.focusX;
      const pz = -(d.y + 0.5 - this.focusY);
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

  private updateSquall(now: number): void {
    const active = this.engine.director.isActive('SQUALL', this.engine.tick);
    this.squall.visible = active;
    if (!active) return;
    const pos = this.squall.geometry.getAttribute('position') as THREE.BufferAttribute;
    const span = (this.viewSize / this.camera.zoom) * 1.6;
    const s = this.squallSeeds;
    for (let i = 0; i < s.length / 3; i++) {
      const t = (s[i * 3 + 2] + now / 900) % 1; // fall phase
      const x = (s[i * 3] - 0.5) * span;
      const z = (s[i * 3 + 1] - 0.5) * span;
      const y = 12 * (1 - t);
      pos.setXYZ(i * 2, x - 0.9, y + 1.6, z - 0.5);
      pos.setXYZ(i * 2 + 1, x, y, z);
    }
    pos.needsUpdate = true;
  }

  setRevealAll(v: boolean): void {
    this.chunks.setRevealAll(v);
  }

  get chunkMeshCount(): number {
    return this.chunks.size;
  }
}

