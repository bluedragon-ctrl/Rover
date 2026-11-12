import * as THREE from 'three';
import type { SimulationEngine } from '../core/SimulationEngine';
import { CpuState } from '../core/types';
import type { Unit } from '../core/Unit';
import { ChunkPool } from './ChunkPool';
import { FxOverlay } from './FxOverlay';
import { BALANCE } from '../core/balance';
import { buildRoverMesh, LIGHT_HEX, type RoverMesh } from './VectorFactory';

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

  /** Camera focus in world tile coordinates (float). */
  focusX = 0.5;
  focusY = 0.5;
  followUnitId: number | null = null;
  mode: ViewMode = 'angled';
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

    engine.events.on('SCAN_PULSE', (e) => {
      const color = e.hit ? (engine.registry.get(e.hit)?.color ?? 0xffffff) : 0x3affc8;
      this.fx.scan(e.x, e.y, e.dir, e.dist, color, performance.now());
    });
    engine.events.on('UPLINK_PULSE', (e) => this.fx.uplink(e.x, e.y, e.ok, engine.orbitAzimuth, performance.now()));
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
      const range = this.engine.sensorRange(u) + 0.5;
      v.sensorRing.position.set(x - this.focusX, 0, -(y - this.focusY));
      v.sensorRing.scale.setScalar(range);

      const dead = u.vm.state === CpuState.POWER_OFF || u.vm.state === CpuState.DESTROYED;
      const blinkOff = u.lightBlink && Math.floor(now / 300) % 2 === 1;
      const fault = u.vm.state === CpuState.FAULT;
      v.beacon.color.setHex(dead || blinkOff ? 0x222222 : fault ? (Math.floor(now / 120) % 2 ? 0xff00ff : 0x220022) : LIGHT_HEX[u.lightColor] ?? 0xffffff);
      v.headlight.visible = !!u.headlight && !dead;
    }

    // Day/night: dim the terrain with sunlight; never fully black.
    const light = this.engine.sun.light / 100;
    this.chunks.setBrightness(0.3 + 0.7 * Math.sqrt(light));

    this.fx.update(this.focusX, this.focusY, now);
    this.renderer.render(this.scene, this.camera);
  }

  centerOn(u: Unit): void {
    this.followUnitId = u.id;
    this.focusX = u.x + 0.5;
    this.focusY = u.y + 0.5;
  }

  setRevealAll(v: boolean): void {
    this.chunks.setRevealAll(v);
  }

  get chunkMeshCount(): number {
    return this.chunks.size;
  }
}

