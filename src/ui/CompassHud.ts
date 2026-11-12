import { BALANCE } from '../core/balance';
import type { SimulationEngine } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';

/**
 * Sky compass (north up): sun, relay orbiter, and where the rover's solar array and
 * dish are pointing. Lets players see alignment at a glance.
 */
export class CompassHud {
  private ctx: CanvasRenderingContext2D;
  private size = 132;

  constructor(canvas: HTMLCanvasElement, private engine: SimulationEngine) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    canvas.style.width = `${this.size}px`;
    canvas.style.height = `${this.size}px`;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  update(u: Unit): void {
    const g = this.ctx;
    const s = this.size;
    const c = s / 2;
    const R = c - 16;
    const sun = this.engine.sun;
    const pt = (bearing: number, r: number): [number, number] => {
      const a = (bearing * Math.PI) / 180;
      return [c + Math.sin(a) * r, c - Math.cos(a) * r];
    };
    g.clearRect(0, 0, s, s);
    g.fillStyle = '#05070cd0';
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#1c2533';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.stroke();
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#7d8ca3';
    for (const [label, b] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
      const [x, y] = pt(b, R + 9);
      g.fillText(label, x, y);
    }

    const ray = (bearing: number, color: string, r: number, dash: number[] = []) => {
      const [x, y] = pt(bearing, r);
      g.strokeStyle = color;
      g.setLineDash(dash);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(x, y);
      g.stroke();
      g.setLineDash([]);
    };
    if (u.solarDeploy > 0) ray(u.solarAngle, '#5a7dff', R * (u.solarDeploy / BALANCE.solarDeployTicks));
    ray(u.antennaAngle, '#3affc8', R * 0.8, [3, 3]);

    // Sun: radius from centre shrinks with elevation (zenith at centre).
    const day = sun.elevation > 0;
    const [sx, sy] = pt(sun.azimuth, day ? R * (1 - sun.elevation / 100) : R);
    g.fillStyle = day ? '#ffd23a' : 'transparent';
    g.strokeStyle = day ? '#ffd23a' : '#6b5a20';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(sx, sy, 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    // Orbiter
    const [ox, oy] = pt(this.engine.orbitAzimuth, R);
    g.fillStyle = '#5ad0ff';
    g.beginPath();
    g.moveTo(ox, oy - 5);
    g.lineTo(ox + 4.5, oy + 3.5);
    g.lineTo(ox - 4.5, oy + 3.5);
    g.closePath();
    g.fill();
  }
}
