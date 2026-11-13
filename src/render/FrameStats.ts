/**
 * Frame-time statistics for the performance HUD (renderer only, wall-clock time is fine).
 * Keeps a rolling window of frame intervals and CPU time spent inside `render()`.
 */
export class FrameStats {
  private intervals: number[] = [];
  private cpu: number[] = [];
  private i = 0;

  constructor(private window = 120) {}

  /** Record one frame: wall-clock interval since the last frame and CPU ms spent rendering it. */
  push(intervalMs: number, cpuMs: number): void {
    if (this.intervals.length < this.window) {
      this.intervals.push(intervalMs);
      this.cpu.push(cpuMs);
    } else {
      this.intervals[this.i] = intervalMs;
      this.cpu[this.i] = cpuMs;
      this.i = (this.i + 1) % this.window;
    }
  }

  /** Forget all samples (e.g. after a resolution change). */
  reset(): void {
    this.intervals = [];
    this.cpu = [];
    this.i = 0;
  }

  get samples(): number {
    return this.intervals.length;
  }

  /** Average frame interval in ms. */
  get avgMs(): number {
    return avg(this.intervals);
  }

  get fps(): number {
    const a = this.avgMs;
    return a > 0 ? 1000 / a : 0;
  }

  /** 95th-percentile frame interval (hitches). */
  get p95Ms(): number {
    return percentile(this.intervals, 0.95);
  }

  get worstMs(): number {
    return this.intervals.length ? Math.max(...this.intervals) : 0;
  }

  /** Average CPU ms inside render() (JS side: chunk builds, uniforms, draw submission). */
  get cpuMs(): number {
    return avg(this.cpu);
  }
}

function avg(a: number[]): number {
  if (!a.length) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

export function percentile(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
