/**
 * Shared helpers for the game-rule tests: a rover with firmware written in the rover's
 * assembly language, register reads, and the usual idle loop.
 */
import { expect } from 'vitest';
import { PDP11 } from '../../src/core/balance';
import { SimulationEngine } from '../../src/core/SimulationEngine';
import { CpuState, Layer } from '../../src/core/types';
import type { Unit } from '../../src/core/Unit';
import { T } from '../../src/core/WorldRegistry';

export const factory = { factory: true };

/** Sleep forever: WAIT for the line clock, again and again. */
export const HANG = '\n9$:     WAIT\n        BR   9$';

/** Firmware from lines of code, each indented; `START:` first, then HANG. */
export const fw = (...lines: string[]): string => `START:  ${lines.map((l) => l.trim()).join('\n        ')}${HANG}`;

/** `JSR PC, SLEEP` for n ticks (at most 32767). */
export const sleep = (n: number): string => `MOV  #${n}., R0\n        JSR  PC, SLEEP`;

/** A firmware register, unsigned 16 bits. */
export const reg = (u: Unit, i: number): number => u.machine.registers('firmware').r[i];
/** A firmware register as a signed number. */
export const sreg = (u: Unit, i: number): number => ((reg(u, i) & 0xffff) ^ 0x8000) - 0x8000;

/** Clear terrain around the origin: flat sand, nothing in the way. */
export function flat(e: SimulationEngine, r = 12, ox = 0, oy = 0): void {
  for (let x = -r; x <= r; x++)
    for (let y = -r; y <= r; y++) {
      e.world.setTile(ox + x, oy + y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(ox + x, oy + y, Layer.OBSTACLE, 0);
      e.world.setTile(ox + x, oy + y, Layer.ITEM, 0);
    }
}

/** A rover with this firmware (factory install), optionally on cleared ground. */
export function rover(firmware: string, opts: { seed?: number; flat?: boolean; setup?: (e: SimulationEngine, u: Unit) => void } = {}): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: opts.seed ?? 7 });
  const u = e.spawnUnit('t');
  if (opts.flat) flat(e);
  opts.setup?.(e, u);
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  return { e, u };
}

/** Run ticks until the boot ROM has handed over to the firmware (3 ticks after a reboot). */
export function boot(e: SimulationEngine, u: Unit): void {
  for (let t = 0; t < 20; t++) {
    if (u.machine.cpu.r[7] < PDP11.romBase || u.cpu.state !== CpuState.RUNNING) return;
    e.advanceTick();
  }
  throw new Error('never booted');
}

export function run(e: SimulationEngine, n: number, link = false): void {
  for (let i = 0; i < n; i++) {
    if (link) for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

export function until(e: SimulationEngine, cond: () => boolean, max = 5000): void {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    e.advanceTick();
  }
  throw new Error('condition never held');
}
