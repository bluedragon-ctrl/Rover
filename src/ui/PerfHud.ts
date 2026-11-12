import type { PerfSnapshot } from '../render/ThreeScene';

const KEY = 'rover.perfHud';

/**
 * Frame-time HUD (P toggles, `?perf=1` forces it on). Shows frame time, render CPU time,
 * draw calls and geometry counts, so performance work starts from a measured baseline.
 */
export class PerfHud {
  private visible: boolean;

  constructor(private el: HTMLElement) {
    const q = new URLSearchParams(location.search).get('perf');
    this.visible = q !== null ? q !== '0' : localStorage.getItem(KEY) === '1';
    this.apply();
  }

  toggle(): void {
    this.visible = !this.visible;
    localStorage.setItem(KEY, this.visible ? '1' : '0');
    this.apply();
  }

  get shown(): boolean {
    return this.visible;
  }

  update(p: PerfSnapshot): void {
    if (!this.visible) return;
    this.el.textContent = formatPerf(p);
  }

  private apply(): void {
    this.el.style.display = this.visible ? '' : 'none';
  }
}

export function formatPerf(p: PerfSnapshot): string {
  const k = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : `${Math.round(n)}`);
  return [
    `${p.fps.toFixed(0)} fps  ${p.avgMs.toFixed(1)} ms  p95 ${p.p95Ms.toFixed(1)}  max ${p.worstMs.toFixed(0)}`,
    `cpu ${p.cpuMs.toFixed(2)} ms  builds ${p.chunkBuilds} (${p.chunkBuildMs.toFixed(1)} ms)`,
    `draws ${p.drawCalls}  tris ${k(p.triangles)}  lines ${k(p.lines)}`,
    `chunks ${p.chunkMeshes}  line verts ${k(p.lineVertices)}  fill tris ${k(p.fillTriangles)}`,
    `${p.width}×${p.height} @${p.pixelRatio}x  bloom ${p.bloom ? 'on' : 'off'}`,
  ].join('\n');
}
