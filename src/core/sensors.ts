import { BALANCE } from './balance';
import { DIR_VEC } from './types';

/**
 * The operator's view shape (docs/SPEC.md §3.1.1): what the player sees around a rover.
 * Used by the simulation for fog-of-war reveal and by the renderer's TileLighting, so what
 * is lit is exactly what gets mapped. (The rover's SCAN is radar and ignores light.)
 *
 * Day: a disc of `dayViewRange`. Night: the 1-tile ring, plus (headlight on)
 * a forward cone: `1 <= forward <= length`, `|lateral| <= nearSpread` for the first
 * `nearLength` tiles and `<= farSpread` beyond.
 */
export interface ConeShape {
  length: number;
  nearLength: number;
  nearSpread: number;
  farSpread: number;
}

export const HEADLIGHT_CONE: ConeShape = {
  length: BALANCE.headlightSensorRange,
  nearLength: BALANCE.headlightNearLength,
  nearSpread: BALANCE.headlightNearSpread,
  farSpread: BALANCE.headlightFarSpread,
};

/** What the operator sees around a rover right now. `cone` is the heading (0–3) or -1 for none. */
export interface SensorShape {
  radius: number;
  cone: number;
}

/** Same disc as ChunkedWorld.revealCircle (r*r + r: slightly rounder). */
export function inDisc(dx: number, dy: number, r: number): boolean {
  return dx * dx + dy * dy <= r * r + r;
}

export function inCone(dir: number, dx: number, dy: number, cone: ConeShape = HEADLIGHT_CONE): boolean {
  const [fx, fy] = DIR_VEC[dir];
  const fwd = dx * fx + dy * fy;
  const lat = Math.abs(dx * fy - dy * fx);
  if (fwd < 1 || fwd > cone.length) return false;
  return lat <= (fwd <= cone.nearLength ? cone.nearSpread : cone.farSpread);
}

export function shapeContains(s: SensorShape, dx: number, dy: number): boolean {
  return inDisc(dx, dy, s.radius) || (s.cone >= 0 && inCone(s.cone, dx, dy));
}

const coneCache: Array<Array<readonly [number, number]>> = [];

/** Offsets covered by the headlight cone for `dir` (cached, deterministic order). */
export function coneOffsets(dir: number): ReadonlyArray<readonly [number, number]> {
  let c = coneCache[dir];
  if (!c) {
    c = [];
    const L = HEADLIGHT_CONE.length;
    for (let dy = -L; dy <= L; dy++) for (let dx = -L; dx <= L; dx++) if (inCone(dir, dx, dy)) c.push([dx, dy]);
    coneCache[dir] = c;
  }
  return c;
}
