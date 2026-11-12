import { BALANCE } from './balance';
import { DIR_VEC } from './types';

/**
 * The one sensor shape (docs/SPEC.md §3.2). Used by the simulation for fog reveal and
 * SCAN, and by the renderer's TileLighting, so what is lit is exactly what is sensed.
 *
 * Day: a disc of the chassis sensor range. Night: the 1-tile ring, plus (headlight on)
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

/** What a rover senses right now. `cone` is the heading (0–3) or -1 for none. */
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

/** How far a straight SCAN ray in `dir` stays inside the shape. */
export function rayRange(s: SensorShape, dir: number): number {
  const [dx, dy] = DIR_VEC[dir];
  let d = 0;
  while (shapeContains(s, dx * (d + 1), dy * (d + 1))) d++;
  return d;
}
