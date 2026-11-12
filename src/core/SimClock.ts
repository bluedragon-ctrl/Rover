/**
 * Fixed-timestep accumulator. Feed it real elapsed milliseconds; it tells you how
 * many ticks to run. Pure logic, no DOM.
 */
export class SimClock {
  tickHz = 10;
  speed = 1;
  private acc = 0;
  /** Cap per frame so a background tab doesn't trigger a huge catch-up. */
  maxTicksPerFrame = 400;

  /** Returns number of ticks to run for this frame. */
  advance(dtMs: number): number {
    if (this.speed <= 0) {
      this.acc = 0;
      return 0;
    }
    const tickMs = 1000 / (this.tickHz * this.speed);
    this.acc += Math.min(dtMs, 250);
    let n = Math.floor(this.acc / tickMs);
    this.acc -= n * tickMs;
    if (n > this.maxTicksPerFrame) {
      n = this.maxTicksPerFrame;
      this.acc = 0;
    }
    return n;
  }

  /** 0..1 progress toward the next tick, for render interpolation. */
  alpha(): number {
    if (this.speed <= 0) return 0;
    const tickMs = 1000 / (this.tickHz * this.speed);
    return Math.min(1, this.acc / tickMs);
  }
}
