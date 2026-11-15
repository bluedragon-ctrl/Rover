import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1, PDP11 } from '../src/core/balance';
import { MsgType } from '../src/core/messages';
import {
  PDP_DEFAULT_FIRMWARE,
  PDP_FIRMWARE_TEMPLATES,
  PDP_PROGRAM_TEMPLATES,
} from '../src/core/programs-pdp11';
import { PROGRAM_TEMPLATES } from '../src/core/programs';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { deserialize, serialize } from '../src/core/SaveManager';
import { CpuState, Layer, ProgState } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { UPGRADE_BY_ID } from '../src/core/upgrades';
import { T } from '../src/core/WorldRegistry';

const factory = { factory: true };

/** Keep the dish on the orbiter before every tick (the tests don't wait for it to slew). */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

/** A PDP-11 rover with the default firmware and a template, on cleared flat sand (radius 8). */
function rover(name: string, setup?: (e: SimulationEngine, u: Unit) => void, firmware = PDP_DEFAULT_FIRMWARE): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: 5, cpu: 'pdp11' });
  const u = e.spawnUnit('t', 0, 0);
  for (let y = -8; y <= 8; y++)
    for (let x = -8; x <= 8; x++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
  setup?.(e, u);
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  if (name) expect(e.uploadProgram(u, PDP_PROGRAM_TEMPLATES[name], factory).errors).toEqual([]);
  return { e, u };
}

/** Run until the firmware has acknowledged the end (P.NONE again); returns the result. */
function result(e: SimulationEngine, u: Unit, max = 3000): number {
  run(e, 1);
  for (let i = 0; i < max && u.progState !== ProgState.PROG_NONE; i++) run(e, 1);
  expect(u.progState).toBe(ProgState.PROG_NONE);
  return u.progResult;
}

/** Values of the T.LOG messages with `tag` that mission control received (signed 16-bit). */
const logged = (e: SimulationEngine, tag: number): number[] =>
  e.messages.filter((m) => m.type === MsgType.LOG && m.status === 'ok' && m.body[0] === tag).map((m) => (((m.body[1] | (m.body[2] << 8)) ^ 0x8000) - 0x8000));

const lit = (e: SimulationEngine, u: Unit) => {
  e.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL);
  u.headlight = 1;
};

const assembled = (src: string, slot: 'firmware' | 'program') => {
  const e = new SimulationEngine({ seed: 1, cpu: 'pdp11' });
  return e.assembleFor(e.spawnUnit('t'), src, slot);
};

describe('PDP-11 shipped code assembles', () => {
  it('every firmware template fits the firmware region', () => {
    for (const [name, src] of Object.entries(PDP_FIRMWARE_TEMPLATES)) {
      const r = assembled(src, 'firmware');
      expect(r.errors, name).toEqual([]);
      expect(r.asm.bytes.length, name).toBeLessThanOrEqual(PDP11.programBase - PDP11.firmwareBase);
    }
  });

  it('every program template fits the 1 KB program region', () => {
    for (const [name, src] of Object.entries(PDP_PROGRAM_TEMPLATES)) {
      const r = assembled(src, 'program');
      expect(r.errors, name).toEqual([]);
      expect(r.asm.bytes.length, name).toBeLessThan(PDP11.coreBytes - PDP11.programBase);
    }
  });

  it('there is a PDP-11 version of every Rover-ASM program template, each a lesson', () => {
    expect(Object.keys(PDP_PROGRAM_TEMPLATES)).toEqual(Object.keys(PROGRAM_TEMPLATES));
    for (const [name, src] of Object.entries(PDP_PROGRAM_TEMPLATES)) {
      expect(src.startsWith('; '), name).toBe(true);
      if (!name.startsWith('Image')) {
        expect(src, name).toMatch(/; Learn:/);
        expect(src, name).toMatch(/; Try:/);
      }
    }
  });
});

describe('default firmware (PDP-11)', () => {
  it('runs First steps and reports how it ended', () => {
    const { e, u } = rover('First steps');
    expect(result(e, u)).toBe(1);
    expect([u.x, u.y]).toEqual([0, 0]);
    run(e, 30);
    expect(logged(e, 14)).toEqual([ProgState.PROG_DONE]); // L.END
    expect(logged(e, 13)).toEqual([1]); // L.RES
    expect(u.post).toBe(1);
    expect(u.indicators[0]).toBe(3); // blue: done
  });

  it('the clock handler aims the dish and the array in the background, even mid-program', () => {
    const { e, u } = rover('Weather station');
    run(e, 200);
    const before = u.antennaTarget;
    // the test's own dish override is off now: the firmware alone keeps it on the orbiter
    for (let i = 0; i < 200; i++) e.advanceTick();
    expect(u.antennaTarget).not.toBe(before);
    expect(Math.abs(((u.antennaTarget - e.orbitAzimuth + 540) % 360) - 180)).toBeLessThanOrEqual(10);
    expect(u.wdt).toBeGreaterThan(0); // armed and kicked
  });

  it('charges when the battery is low, then runs the program', () => {
    const { e, u } = rover('First steps', (_e, r) => (r.energy = Math.floor(r.chassis.batteryCapacity / 5)));
    run(e, 30);
    expect(u.solarOpen).toBe(1);
    expect(u.indicators[1]).toBe(4); // amber
    expect(u.progState).toBe(ProgState.PROG_READY);
  });

  it('fault protection: a low battery takes control back mid-slice and stops the wheels', () => {
    const { e, u } = rover('Explorer');
    run(e, 40);
    expect(u.slice).toBeGreaterThanOrEqual(0);
    u.energy = Math.floor((u.chassis.batteryCapacity * 29) / 100);
    run(e, 3);
    expect(u.slice).toBe(-1);
    expect(u.progState).toBe(ProgState.PROG_READY);
    run(e, 20);
    expect(logged(e, 12)).toContain(4); // L.PRE: PR.BAT
    expect(u.solarOpen).toBe(1); // charging
  });

  it('a program fault shows red and is acknowledged', () => {
    const { e, u } = rover('');
    expect(e.uploadProgram(u, 'START:  MOV #1, @#200\n        HALT', factory).errors).toEqual([]);
    run(e, 20);
    expect(u.progState).toBe(ProgState.PROG_NONE);
    expect(u.indicators[0]).toBe(1);
    expect(logged(e, 14)).toEqual([ProgState.PROG_FAULT]);
  });

  it('runs 5000 ticks with Explorer without a reboot, deterministic and save-safe', () => {
    const a = rover('Explorer').e;
    run(a, 5000);
    const u = a.units[0];
    expect(u.vm.state).toBe(CpuState.RUNNING);
    expect(a.messages.filter((m) => m.type === MsgType.TEXT)).toEqual([]); // never in safe mode
    expect(u.faultBoots).toEqual([]);
    const b0 = rover('Explorer').e;
    run(b0, 2345);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 2655);
    expect(serialize(b)).toEqual(serialize(a));
  });
});

describe('PDP-11 lessons run', () => {
  it('every program template runs 1500 ticks without a fault', () => {
    for (const name of Object.keys(PDP_PROGRAM_TEMPLATES)) {
      const { e, u } = rover(name);
      run(e, 1500);
      expect(u.vm.state, name).toBe(CpuState.RUNNING);
      expect(logged(e, 14).filter((s) => s === ProgState.PROG_FAULT), name).toEqual([]);
    }
  });

  it('every firmware template runs 1500 ticks without a reboot', () => {
    for (const [name, src] of Object.entries(PDP_FIRMWARE_TEMPLATES)) {
      const { e, u } = rover('First steps', undefined, src);
      run(e, 1500);
      expect(u.vm.state, name).toBe(CpuState.RUNNING);
      expect(u.faultBoots, name).toEqual([]);
    }
  });

  it('Drive yourself: the square, or why it stopped', () => {
    const { e, u } = rover('Drive yourself');
    expect(result(e, u)).toBe(1);
    const b = rover('Drive yourself', (e2) => e2.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL));
    expect(result(b.e, b.u)).toBe(4); // E.BLK
  });

  it('Count with a variable keeps its words across Run again', () => {
    const { e, u } = rover('Count with a variable');
    expect(result(e, u)).toBe(1);
    expect([u.x, u.y]).toEqual([0, 0]);
    expect(e.command(u, 'RUN_AGAIN')).toBeNull();
    expect(result(e, u)).toBe(2);
    run(e, 20);
    expect(logged(e, 2)).toEqual([8, 16]);
  });

  it('Route reads its table and drives back to the start', () => {
    const { e, u } = rover('Route');
    expect(result(e, u)).toBe(4);
    expect([u.x, u.y]).toEqual([0, 0]);
    const blocked = rover('Route', (e2) => e2.world.setTile(1, 0, Layer.OBSTACLE, T.CLIFF_WALL));
    expect(result(blocked.e, blocked.u)).toBeLessThan(4);
  });

  it('Drive and scan at once counts each sample once while driving', () => {
    const { e, u } = rover('Drive and scan at once', (e) => {
      e.world.setTile(3, 4, Layer.ITEM, T.SAMPLE);
      e.world.setTile(7, 2, Layer.ITEM, T.SAMPLE);
      for (let x = 9; x <= 10; x++)
        for (let y = 0; y <= 12; y++) {
          e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
          for (const l of [Layer.OBSTACLE, Layer.ITEM]) e.world.setTile(x, y, l, 0);
        }
    });
    expect(result(e, u)).toBe(2);
    expect([u.x, u.y]).toEqual([10, 0]);
    expect(logged(e, 2)).toEqual([4, 2]);
  });

  it('Explorer logs the acid vent it drives onto', () => {
    const { e, u } = rover('Explorer', (e) => e.world.setTile(0, 2, Layer.TERRAIN, T.ACID_VENT));
    run(e, 400);
    expect(logged(e, 2)).toContain(0);
    expect(logged(e, 3)).toContain(2);
    expect(u.hull).toBeLessThan(100);
  });

  it('Photographer sends four lit photos at double resolution', () => {
    const { e, u } = rover('Photographer', (e) => e.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL));
    expect(result(e, u, 4000)).toBe(4);
    run(e, 800);
    expect(e.gallery).toHaveLength(4);
    expect(e.gallery.every((g) => g.lit && g.x2)).toBe(true);
  });

  it('Prospector mines, analyzes, and leaves the cargo empty', () => {
    const { e, u } = rover('Prospector', (e) => {
      e.world.setTile(0, 3, Layer.OBSTACLE, T.IRON_ORE);
      e.world.setTile(0, 1, Layer.ITEM, T.SAMPLE);
    });
    for (let i = 0; i < 600 && e.stats.itemsAnalyzed < 2; i++) run(e, 1);
    expect(e.stats.itemsCollected).toBe(1);
    expect(e.stats.oreMined).toBe(1);
    expect(e.stats.itemsAnalyzed).toBe(2);
    expect(u.cargo).toEqual([0, 0, 0, 0]);
  });

  it('Field repair uses the right materials on worn systems', () => {
    const { e, u } = rover('Field repair', (_e, u) => {
      u.hull = 50;
      u.solarHealth = 70;
      u.cargo = [T.SILICON_ORE, 0, T.REPAIR_KIT, T.SAMPLE];
    });
    expect(result(e, u)).toBe(2);
    expect([u.hull, u.solarHealth]).toEqual([80, 90]);
    expect(u.cargo).toEqual([0, 0, 0, T.SAMPLE]);
  });

  it('Fetch: 0 without a crate; with one it drives there and installs it', () => {
    const none = rover('Fetch supply crate');
    expect(result(none.e, none.u)).toBe(0);
    const { e, u } = rover('Fetch supply crate', (e) => {
      e.drops.push({ id: 1, upgrade: 'SEISMIC', x: 3, y: 4, landTick: 0, landed: true });
      e.world.setTile(3, 4, Layer.ITEM, T.SUPPLY_CRATE);
    });
    expect(result(e, u)).toBe(1);
    expect([u.x, u.y]).toEqual([3, 3]);
  });

  it('Spiral logs its corners, halts on BPT, ends after Continue', () => {
    const { e, u } = rover('Spiral');
    for (let i = 0; i < 3000 && u.progState !== ProgState.PROG_HALTED; i++) run(e, 1);
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    run(e, 50);
    expect(logged(e, 2).slice(0, 4)).toEqual([0, 1, 1, -1]);
    expect(logged(e, 3).slice(0, 4)).toEqual([1, 1, -1, -1]);
    expect(e.command(u, 'CONTINUE', 'program')).toBeNull();
    expect(result(e, u)).toBe(7);
  });

  it('Seismic survey: 0 without the scanner; with it, drives to the nearest vein and mines it', () => {
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

  it('Weather station logs the hour and the light every 100 ticks', () => {
    const { e } = rover('Weather station');
    run(e, 450);
    const h = logged(e, 2);
    expect(h.slice(0, 3)).toEqual([0, 1, 2].map((k) => k + h[0]));
    expect(logged(e, 3).length).toBeGreaterThanOrEqual(3);
  });
});

describe('PDP-11 image lessons (64x64, PDP11_CPU.md §6.3)', () => {
  const photo = (name: string, setup?: (e: SimulationEngine, u: Unit) => void) => {
    const { e, u } = rover(name, setup);
    expect(result(e, u, 2000)).toBe(1);
    run(e, 800);
    expect(e.gallery.length).toBeGreaterThanOrEqual(1);
    return { e, u, g: e.gallery[0], bytes: (e.gallery[0].data ?? '').match(/../g)!.map((h) => parseInt(h, 16)) };
  };

  it('Line: a white row 32 on black', () => {
    const { bytes, g } = photo('Image: Line');
    expect(g.level).toBe(2); // drawn
    expect(bytes.length).toBe(1024);
    expect(bytes.filter((b) => b === 0xff).length).toBe(16);
    expect(bytes.slice(512, 528).every((b) => b === 0xff)).toBe(true);
  });

  it('Test pattern: four bars in every row', () => {
    const { bytes } = photo('Image: Test pattern');
    expect(bytes.slice(0, 16)).toEqual([0, 0, 0, 0, 85, 85, 85, 85, 170, 170, 170, 170, 255, 255, 255, 255]);
    expect(bytes.slice(1008)).toEqual(bytes.slice(0, 16));
  });

  it('Negative, Stamp, Plot: edited photos', () => {
    for (const name of ['Image: Negative', 'Image: Stamp', 'Image: Plot']) {
      const { g, bytes } = photo(name, lit);
      expect(g.level, name).toBe(1); // edited
      if (name === 'Image: Stamp') expect(bytes.slice(0, 4)).toEqual([0, 0, 0, 0]); // X = 0, Y = 0
      if (name === 'Image: Plot') expect(bytes[0] >> 6).toBe(3); // pixel (0, 0) white
    }
  });

  it('Memory map wanders and counts visits in image memory', () => {
    const { e, u } = rover('Image: Memory map');
    run(e, 600);
    expect(u.vm.state).toBe(CpuState.RUNNING);
    expect(u.imageMemory().some((b) => b > 0)).toBe(true);
  });
});

/*
 * Cycle budget (PDP11_CPU.md §16 question 1, slice 4): run the default firmware with every
 * template and see how much of the budget it needs. The numbers are written to the test
 * output; the asserts keep the current budget workable.
 */
describe('cycle budget measurement', () => {
  it('the default firmware and every template within the Mk-I budget', () => {
    const budget = CHASSIS_MK1.cyclesPerTick * PDP11.cyclesPerRoverCycle;
    const rows: string[] = [];
    for (const name of Object.keys(PDP_PROGRAM_TEMPLATES)) {
      const { e, u } = rover(name, (e2, r) => {
        if (name.startsWith('Image') || name === 'Photographer') lit(e2, r);
      });
      const m = u.machine!.meter;
      run(e, 2000);
      const bytes = assembled(PDP_PROGRAM_TEMPLATES[name], 'program').asm.bytes.length;
      rows.push(`${name.padEnd(24)} ${String(bytes).padStart(4)} B  avg ${(m.total / m.ticks).toFixed(1).padStart(5)}  peak ${String(m.peak).padStart(3)}  starved ${m.starved}`);
      expect(m.total / m.ticks, name).toBeLessThan(budget);
    }
    const idle = rover('');
    run(idle.e, 2000);
    const fw = assembled(PDP_DEFAULT_FIRMWARE, 'firmware').asm.bytes.length;
    rows.unshift(`${'(firmware idle)'.padEnd(24)} ${String(fw).padStart(4)} B  avg ${(idle.u.machine!.meter.total / idle.u.machine!.meter.ticks).toFixed(1).padStart(5)}  peak ${idle.u.machine!.meter.peak}`);
    console.log(`cycle budget ${budget}/tick\n${rows.join('\n')}`);
  });
});
