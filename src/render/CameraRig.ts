import * as THREE from 'three';

/**
 * Perspective orbit camera around a floating origin: the scene is drawn relative to
 * (focusX, focusY) in world tile coordinates, so the camera always orbits (0, 0, 0).
 *
 * Left-drag pans (the grabbed ground point stays under the cursor), right-drag or
 * Ctrl+drag orbits, the wheel zooms toward the cursor.
 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 3000);
  focusX = 0.5;
  focusY = 0.5;
  /** Radians, 0 = looking north. */
  yaw = 0;
  /** Radians from vertical. */
  pitch = 0.85;
  /** Distance from the focus, in tiles. */
  dist = 30;
  minDist = 1.4;
  maxDist = 140;
  minPitch = 0.02;
  maxPitch = 1.3;
  /** Eased targets for programmatic changes (view toggles, rotate keys). */
  private targetYaw: number | null = null;
  private targetPitch: number | null = null;
  /** Called when the user pans (e.g. to stop following a rover). */
  onUserPan?: () => void;

  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(private el: HTMLElement) {
    this.bind();
    this.apply();
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Ground point (scene coords) under client pixel, or null above the horizon. */
  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.plane, hit) ? hit : null;
  }

  /** World tile under a client pixel. */
  tileAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const h = this.groundAt(clientX, clientY);
    return h ? { x: Math.floor(h.x + this.focusX), y: Math.floor(-h.z + this.focusY) } : null;
  }

  rotateTo(yaw: number, pitch?: number): void {
    this.targetYaw = yaw;
    if (pitch !== undefined) this.targetPitch = pitch;
  }

  setPitch(pitch: number): void {
    this.targetPitch = pitch;
  }

  /** Call once per frame. */
  update(dt: number): void {
    const k = Math.min(1, dt * 8);
    if (this.targetYaw !== null) {
      let d = this.targetYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * k;
      if (Math.abs(d) < 1e-3) this.targetYaw = null;
    }
    if (this.targetPitch !== null) {
      const d = this.targetPitch - this.pitch;
      this.pitch += d * k;
      if (Math.abs(d) < 1e-3) this.targetPitch = null;
    }
    this.apply();
  }

  /** Visible half-extent in tiles (rough), for chunk radius / LOD decisions. */
  get viewRadius(): number {
    return this.dist * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(1, this.camera.aspect) * (1 + Math.sin(this.pitch) * 1.5);
  }

  private apply(): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch, this.minPitch, this.maxPitch);
    this.dist = THREE.MathUtils.clamp(this.dist, this.minDist, this.maxDist);
    const s = Math.sin(this.pitch);
    this.camera.position.set(-Math.sin(this.yaw) * s * this.dist, Math.cos(this.pitch) * this.dist, Math.cos(this.yaw) * s * this.dist);
    // "Up" on screen points north-ish so top-down view keeps the yaw.
    this.camera.up.set(Math.sin(this.yaw), 0, -Math.cos(this.yaw)).lerp(new THREE.Vector3(0, 1, 0), Math.min(1, s * 4)).normalize();
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(0.02, this.dist * 0.01);
    this.camera.far = this.dist * 12;
    this.camera.updateProjectionMatrix();
  }

  private bind(): void {
    const el = this.el;
    let drag: { x: number; y: number; orbit: boolean } | null = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.shiftKey) return; // reserved (admin teleport)
      drag = { x: e.clientX, y: e.clientY, orbit: e.button === 2 || e.button === 1 || e.ctrlKey };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointerup', () => (drag = null));
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.orbit) {
        this.targetYaw = this.targetPitch = null;
        this.yaw -= (e.clientX - drag.x) * 0.008;
        this.pitch -= (e.clientY - drag.y) * 0.006;
      } else {
        const a = this.groundAt(drag.x, drag.y);
        const b = this.groundAt(e.clientX, e.clientY);
        if (a && b && (a.x !== b.x || a.z !== b.z)) {
          this.focusX += a.x - b.x;
          this.focusY -= a.z - b.z;
          this.onUserPan?.();
        }
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.apply();
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.groundAt(e.clientX, e.clientY);
        this.dist *= Math.exp(e.deltaY * 0.0014);
        this.apply();
        const after = this.groundAt(e.clientX, e.clientY);
        // Zoom toward the cursor (unless following: then zoom on the rover).
        if (before && after && !this.lockFocus) {
          this.focusX += before.x - after.x;
          this.focusY -= before.z - after.z;
        }
      },
      { passive: false },
    );
  }

  /** When true, wheel zoom keeps the focus (camera follow mode). */
  lockFocus = false;
}
