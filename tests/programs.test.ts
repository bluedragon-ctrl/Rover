import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../src/core/downlink';
import { DEFAULT_FIRMWARE, PROGRAM_TEMPLATES } from '../src/core/programs';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, ProgState } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { UPGRADE_BY_ID } from '../src/core/upgrades';
import { CHASSIS_MK1 } from '../src/core/balance';
import { compile } from '../src/core/vm/Compiler';
import { SIGNATURES, type Op } from '../src/core/vm/isa';
import { createDefaultRegistry, T } from '../src/core/WorldRegistry';

/** The lesson programs (Code tab → Program templates) run as their headers promise. */

/** Keep the dish on the orbiter before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

/** A rover with the default firmware and a template, on cleared flat sand (radius 8). */
function rover(name: string, setup?: (e: SimulationEngine, u: Unit) => void): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: 5 });
  const u = e.spawnUnit('t', 0, 0);
  for (let y = -8; y <= 8; y++)
    for (let x = -8; x <= 8; x++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
  setup?.(e, u);
  expect(e.upload(u, DEFAULT_FIRMWARE, { factory: true }).errors).toEqual([]);
  expect(e.uploadProgram(u, PROGRAM_TEMPLATES[name], { factory: true }).errors).toEqual([]);
  return { e, u };
}

/** Run until the firmware has acknowledged END (PROG_NONE again); returns the result. */
function result(e: SimulationEngine, u: Unit, max = 3000): number {
  run(e, 1);
  for (let i = 0; i < max && u.progState !== ProgState.PROG_NONE; i++) run(e, 1);
  expect(u.progState).toBe(ProgState.PROG_NONE);
  return u.progResult;
}

/** Values of the LOG frames with `tag` that mission control received. */
const logged = (e: SimulationEngine, tag: number): number[] =>
  e.received.map((f) => decodeFrame(f.bytes)).flatMap((d) => (d.kind === 0 && d.tag === tag ? [d.value ?? 0] : []));

describe('program templates (lessons)', () => {
  it('together use every instruction', () => {
    const consts = createDefaultRegistry().constants();
    const used = new Set<Op>();
    for (const src of Object.values(PROGRAM_TEMPLATES))
      for (const i of compile(src, CHASSIS_MK1, consts, { slot: 'program' }).program!.instrs) used.add(i.op);
    const missing = (Object.keys(SIGNATURES) as Op[]).filter((op) => !used.has(op));
    expect(missing).toEqual([]);
  });

  it('every template has a lesson header: what it does, Learn and Try', () => {
    for (const [name, src] of Object.entries(PROGRAM_TEMPLATES)) {
      if (name.startsWith('Image: ')) continue; // the guide's examples: explained in docs/IMAGE_MEMORY.md
      expect(src, name).toMatch(/^; [A-Z ]+: /);
      expect(src, name).toMatch(/^; Learn: /m);
      expect(src, name).toMatch(/^; Try: /m);
    }
  });

  it('every template runs 1500 ticks without a fault', () => {
    for (const name of Object.keys(PROGRAM_TEMPLATES)) {
      const { e, u } = rover(name);
      run(e, 1500);
      expect(u.vm.state, name).not.toBe(CpuState.FAULT);
      expect(u.progState, name).not.toBe(ProgState.PROG_FAULT);
    }
  });

  it('Explorer logs the acid vent it drives onto', () => {
    const { e, u } = rover('Explorer', (e) => e.world.setTile(0, 2, Layer.TERRAIN, T.ACID_VENT));
    run(e, 400);
    expect(logged(e, 2)).toContain(0); // T_VENT_X
    expect(logged(e, 3)).toContain(2); // T_VENT_Y
    expect(u.hull).toBeLessThan(100);
  });

  it('Photographer sends four lit photos and ENDs with 4', () => {
    const { e, u } = rover('Photographer', (e) => e.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL));
    expect(result(e, u)).toBe(4);
    run(e, 800);
    expect(e.gallery).toHaveLength(4);
    expect(e.gallery.every((g) => g.lit)).toBe(true);
  });

  it('Prospector mines, analyzes, and leaves the cargo empty', () => {
    const { e, u } = rover('Prospector', (e) => {
      e.world.setTile(0, 3, Layer.OBSTACLE, T.IRON_ORE);
      e.world.setTile(0, 1, Layer.ITEM, T.SAMPLE);
    });
    for (let i = 0; i < 600 && e.stats.itemsAnalyzed < 2; i++) run(e, 1);
    expect(e.stats.itemsCollected).toBe(1); // the sample (grabbed)
    expect(e.stats.oreMined).toBe(1); // the vein (drilled)
    expect(e.stats.itemsAnalyzed).toBe(2); // both, by the lab subroutine
    expect(u.cargo).toEqual([0, 0, 0, 0]);
  });

  it('Field repair uses the right materials on worn systems', () => {
    const { e, u } = rover('Field repair', (_e, u) => {
      u.hull = 50;
      u.solarHealth = 70;
      u.cargo = [T.SILICON_ORE, 0, T.REPAIR_KIT, T.SAMPLE];
    });
    expect(result(e, u)).toBe(2);
    expect(u.hull).toBe(80); // kit: +30
    expect(u.solarHealth).toBe(90); // silicon: +20
    expect(u.cargo).toEqual([0, 0, 0, T.SAMPLE]); // the sample repairs nothing
  });

  it('Fetch ENDs 0 without a crate', () => {
    const { e, u } = rover('Fetch supply crate');
    expect(result(e, u)).toBe(0);
  });

  it('Spiral logs its corners, halts on BRK, ENDs after Continue', () => {
    const { e, u } = rover('Spiral');
    for (let i = 0; i < 3000 && u.progState !== ProgState.PROG_HALTED; i++) run(e, 1);
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    run(e, 50);
    expect(logged(e, 2).slice(0, 4)).toEqual([0, 1, 1, -1]); // T_X: corners (0,1) (1,1) (1,-1) (-1,-1)...
    expect(logged(e, 3).slice(0, 4)).toEqual([1, 1, -1, -1]);
    expect(e.command(u, 'CONTINUE', 'program')).toBeNull();
    expect(result(e, u)).toBe(7);
  });

  it('Seismic survey: END 0 without the scanner; with it, drives to the nearest vein and mines it', () => {
    const none = rover('Seismic survey');
    expect(result(none.e, none.u)).toBe(0);
    const { e, u } = rover('Seismic survey', (e, u) => {
      UPGRADE_BY_ID.SEISMIC.apply(u.chassis, u);
      e.world.setTile(5, 0, Layer.OBSTACLE, T.IRON_ORE);
      e.world.setTile(0, -7, Layer.OBSTACLE, T.SILICON_ORE);
    });
    expect(result(e, u)).toBe(1);
    expect([u.x, u.y]).toEqual([4, 0]);
    expect(u.cargo).toContain(T.IRON_ORE);
  });

  it('Route reads its legs from Flash (DATA / LDF), counts them in RAM (VAR) and drives back to the start', () => {
    const { e, u } = rover('Route');
    expect(result(e, u)).toBe(4);
    expect([u.x, u.y]).toEqual([0, 0]);
    expect(logged(e, 2)).toEqual([4]);
    expect(u.ram[0]).toBe(4); // the program's VAR good sits at the bottom of RAM
    const blocked = rover('Route', (e2) => e2.world.setTile(1, 0, Layer.OBSTACLE, T.CLIFF_WALL));
    expect(result(blocked.e, blocked.u)).toBeLessThan(4);
  });

  it('Count with a variable counts runs and tiles in RAM, across Run again', () => {
    const { e, u } = rover('Count with a variable');
    expect(result(e, u)).toBe(1);
    expect([u.x, u.y]).toEqual([0, 0]); // the 2×2 square, back at the start
    expect(logged(e, 2)).toEqual([8]); // T_TILES
    expect(Array.from(u.ram.slice(0, 3))).toEqual([1, 0, 8]); // VAR runs, then VAR tiles 2 (high byte first)
    expect(e.command(u, 'RUN_AGAIN')).toBeNull();
    expect(result(e, u)).toBe(2); // RAM survives Run again; the registers do not
    expect(logged(e, 2)).toEqual([8, 16]);
  });

  it('Drive and scan at once sweeps the radar while driving and counts each sample once', () => {
    const { e, u } = rover('Drive and scan at once', (e) => {
      e.world.setTile(3, 4, Layer.ITEM, T.SAMPLE);
      e.world.setTile(7, 2, Layer.ITEM, T.SAMPLE);
      for (let x = 9; x <= 10; x++) // the drive ends past the cleared square
        for (let y = 0; y <= 12; y++) {
          e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
          for (const l of [Layer.OBSTACLE, Layer.ITEM]) e.world.setTile(x, y, l, 0);
        }
    });
    let sweepsWhileDriving = 0;
    for (let i = 0; i < 400 && u.progState !== ProgState.PROG_DONE; i++) {
      run(e, 1);
      if (u.deviceLeft('drive') > 0 && u.deviceLeft('radar') > 0) sweepsWhileDriving++;
    }
    expect(u.progState).toBe(ProgState.PROG_DONE);
    expect(u.progResult).toBe(2); // RET returns r0
    expect([u.x, u.y]).toEqual([10, 0]); // the whole drive
    expect(sweepsWhileDriving).toBeGreaterThan(10); // both devices busy in the same tick
    expect(logged(e, 2)).toEqual([4, 2]); // T_SAMPLE: how far north each one lay
  });

  it('Weather station logs the hour and the light every 100 ticks', () => {
    const { e } = rover('Weather station');
    run(e, 450);
    expect(logged(e, 2).slice(0, 3)).toEqual([0, 1, 2].map((h) => h + logged(e, 2)[0]));
    expect(logged(e, 3).length).toBeGreaterThanOrEqual(3);
  });
});
