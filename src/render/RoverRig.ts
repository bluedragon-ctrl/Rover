import * as THREE from 'three';
import { LAMP, POST_DARK, POST_LIT, SEVEN_SEG, type RoverRigMesh } from './VectorFactory';

/** Everything the rover model shows, in renderer terms (no sim types, so the preview can drive it). */
export interface RoverPose {
  /** Body yaw in radians (0 = facing -Z / north). */
  angle: number;
  /** Driving: wheels spin, slight suspension bounce. */
  moving: boolean;
  /** Solar deployment 0..1. */
  deploy: number;
  /** Panel bearing relative to the body, radians (Three.js Y rotation). */
  solarRel: number;
  /** Dish bearing relative to the body, radians. */
  dishRel: number;
  solarHealth: number;
  dishHealth: number;
  /** CPU: 'run' | 'idle' | 'fault' | 'off'. */
  cpu: 'run' | 'idle' | 'fault' | 'off';
  beaconHex: number;
  /** Indicator lamp colours (hex), left to right. */
  indicators: number[];
  /** @POST value 0–255 shown as two hex digits; null = dark (powered off, or not visible). */
  post?: number | null;
  headlight: boolean;
  drilling: boolean;
  /** Sensor range in tiles (for the ring). */
  sensorRange: number;
}

const RED = new THREE.Color(0xff3030);
const tint = (m: THREE.LineBasicMaterial, ok: number, health: number) => m.color.setHex(ok).lerp(RED, 1 - health / 100);

/** Per-rover animation state that is purely visual (eased values, spark particles). */
export class RoverAnimator {
  private deploy = 0;
  private drill = 0;
  private wheelSpin = 0;
  private sparkLife = new Float32Array(24);
  private sparkPos = new Float32Array(24 * 3);
  private sparkVel = new Float32Array(24 * 3);

  constructor(readonly mesh: RoverRigMesh) {}

  /** `dt` in seconds, `t` in seconds (animation clock). */
  update(p: RoverPose, dt: number, t: number): void {
    const m = this.mesh;
    m.group.rotation.y = p.angle;

    // Eased solar deployment. Accordion fold: the first segment hangs down from the rail,
    // each next one folds back ~175° so the stack lies against the flank, fanning slightly
    // outward. All joints open together, like a real z-fold.
    this.deploy += (p.deploy - this.deploy) * Math.min(1, dt * 3);
    const u = 1 - this.deploy;
    for (const joints of m.solarJoints) {
      joints[0].rotation.z = -Math.PI / 2 * u;
      for (let i = 1; i < joints.length; i++) joints[i].rotation.z = (i % 2 ? 1 : -1) * Math.PI * 0.97 * u;
    }
    // Turntable swings to the bearing and the array tilts once the wings are mostly out.
    const out = Math.max(0, (this.deploy - 0.6) / 0.4);
    m.solarMount.rotation.y = p.solarRel * out;
    for (const s of m.solarSides) s.rotation.x = 0.25 * out;
    for (const mat of m.solarMats) tint(mat, 0x5a7dff, p.solarHealth);

    m.dish.rotation.y = p.dishRel;
    for (const mat of m.dishMats) tint(mat, 0x3affc8, p.dishHealth);

    // CPU core.
    const cpuCol = p.cpu === 'run' ? 0x38bdf8 : p.cpu === 'idle' ? 0x2a6a8a : p.cpu === 'fault' ? (Math.floor(t * 8) % 2 ? 0xff00ff : 0x330033) : 0x1a2230;
    m.cpuMat.color.setHex(cpuCol);
    if (p.cpu === 'run') m.cpuCore.rotation.y += dt * 1.6;

    // Wheels + bounce.
    if (p.moving) this.wheelSpin -= dt * 7;
    for (const w of m.wheels) w.rotation.x = this.wheelSpin;
    m.model.position.y = p.moving ? Math.abs(Math.sin(t * 13)) * 0.012 : 0;

    m.lamps.set(LAMP.BEACON, p.beaconHex);
    for (let i = 0; i < 3; i++) if (i < p.indicators.length) m.lamps.set(LAMP.IND + i, p.indicators[i]);
    if (m.hasPost) {
      const v = p.post ?? null;
      const pats = v === null ? [0, 0] : [SEVEN_SEG[(v >> 4) & 15], SEVEN_SEG[v & 15]];
      for (let i = 0; i < 14; i++) m.lamps.set(LAMP.POST + i, (pats[Math.floor(i / 7)] >> i % 7) & 1 ? POST_LIT : POST_DARK);
    }
    m.lamps.set(LAMP.HEAD, p.headlight ? 0xf0f8ff : 0x1e293b);
    m.beam.visible = p.headlight;

    // Drill extends, spins, ring pulses, sparks fly.
    this.drill += ((p.drilling ? 1 : 0) - this.drill) * Math.min(1, dt * 6);
    m.drillBit.position.y = 0.3 - this.drill * 0.2;
    if (p.drilling) m.drillBit.rotation.y += dt * 22;
    m.drillGlow.opacity = p.drilling ? 0.6 + Math.sin(t * 20) * 0.3 : 0;
    m.drillRing.visible = p.drilling; // invisible (opacity 0) otherwise: skip the draw call
    m.drillRing.scale.setScalar(0.85 + Math.sin(t * 18) * 0.2);
    this.updateSparks(p.drilling, dt);
  }

  private updateSparks(on: boolean, dt: number): void {
    const s = this.mesh.sparks;
    s.visible = on || this.sparkLife.some((l) => l > 0);
    if (!s.visible) return;
    const pos = s.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < 24; i++) {
      let life = this.sparkLife[i] - dt * 2.5;
      const P = this.sparkPos, V = this.sparkVel, k = i * 3;
      if (life <= 0 && on) {
        // Cosmetic only: Math.random is fine in the renderer.
        life = 0.3 + Math.random() * 0.5;
        const a = Math.random() * Math.PI * 2;
        const v = 0.6 + Math.random() * 1.0;
        P[k] = Math.cos(a) * 0.08;
        P[k + 1] = 0.03;
        P[k + 2] = Math.sin(a) * 0.08 - 0.055;
        V[k] = Math.cos(a) * v;
        V[k + 1] = 0.6 + Math.random() * 0.9;
        V[k + 2] = Math.sin(a) * v;
      }
      this.sparkLife[i] = life;
      if (life > 0) {
        P[k] += V[k] * dt;
        P[k + 1] = Math.max(0, P[k + 1] + V[k + 1] * dt);
        P[k + 2] += V[k + 2] * dt;
        V[k + 1] -= 3.2 * dt;
        pos.setXYZ(i * 2, P[k], P[k + 1], P[k + 2]);
        pos.setXYZ(i * 2 + 1, P[k] - V[k] * 0.03, P[k + 1] - V[k + 1] * 0.03, P[k + 2] - V[k + 2] * 0.03);
      } else {
        pos.setXYZ(i * 2, 0, -10, 0);
        pos.setXYZ(i * 2 + 1, 0, -10, 0);
      }
    }
    pos.needsUpdate = true;
  }
}
