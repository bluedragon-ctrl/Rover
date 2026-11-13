/**
 * Adaptive render resolution (pixel ratio). Steps down when frames are slow and the time is
 * not spent in our JavaScript (so the GPU is the bottleneck: fewer pixels help); steps back
 * up after a sustained period at full frame rate. A level that proved too slow is not
 * retried for a while, so it does not oscillate.
 *
 * Pure logic (no DOM), fed from FrameStats-style averages; the caller applies the ratio.
 */
export class AdaptiveResolution {
  /** Pixel ratio step. */
  static readonly STEP = 0.25;
  /** Average frame interval (ms) above which we step down (~45 fps). */
  slowMs = 22;
  /** Average frame interval (ms) below which the level counts as comfortable (~55+ fps). */
  okMs = 18;
  /** Only step down if render CPU time is below this fraction of the frame (GPU-bound). */
  cpuShare = 0.6;
  /** ms to measure after a change before deciding again. */
  settleMs = 2500;
  /** ms of comfortable frames before trying a higher level. */
  upAfterMs = 8000;
  /** ms before a level that was too slow may be tried again. */
  forgetMs = 60000;

  ratio: number;
  private changedAt = 0;
  private okSince: number | null = null;
  /** Lowest ratio found too slow, and when. */
  private tooSlow: { ratio: number; at: number } | null = null;

  constructor(
    readonly max: number,
    readonly min = 1,
  ) {
    this.ratio = max;
  }

  /**
   * Feed averages over the frames since the last change. Returns the new ratio when it
   * changed (the caller resizes and resets its statistics), otherwise null.
   */
  update(now: number, avgMs: number, cpuMs: number, samples: number): number | null {
    if (this.tooSlow && now - this.tooSlow.at > this.forgetMs) this.tooSlow = null;
    if (now - this.changedAt < this.settleMs || samples < 30) return null;
    const S = AdaptiveResolution.STEP;
    if (avgMs > this.slowMs && cpuMs < avgMs * this.cpuShare && this.ratio > this.min) {
      this.tooSlow = { ratio: this.ratio, at: now };
      return this.set(Math.max(this.min, this.ratio - S), now);
    }
    if (avgMs < this.okMs) {
      this.okSince ??= now;
      const next = Math.min(this.max, this.ratio + S);
      const blocked = this.tooSlow !== null && next >= this.tooSlow.ratio;
      if (next > this.ratio && !blocked && now - this.okSince >= this.upAfterMs) return this.set(next, now);
    } else this.okSince = null;
    return null;
  }

  private set(r: number, now: number): number {
    this.ratio = r;
    this.changedAt = now;
    this.okSince = null;
    return r;
  }
}
