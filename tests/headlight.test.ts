import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { compile } from '../src/core/vm/Compiler';
import { CHASSIS_MK1 } from '../src/core/balance';
import { DEMO_EXPLORER, TEMPLATES } from '../src/core/programs';
import { deserialize, serialize } from '../src/core/SaveManager';
import { coneOffsets, inCone } from '../src/core/sensors';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Dir, Layer } from '../src/core/types';
import { T, createDefaultRegistry } from '../src/core/WorldRegistry';
import type { Unit } from '../src/core/Unit';

const factory = { factory: true };

/** Engine at night with a rover on a cleared patch far from the (day-revealed) origin. */
function nightRover(seed = 7): { eng: SimulationEngine; u: Unit; ox: number; oy: number } {
  const eng = new SimulationEngine({ seed });
  const u = eng.spawnUnit('t');
  eng.upload(u, 'SLEEP 100000', factory);
  while (eng.sun.elevation > 0) eng.advanceTick();
  const ox = 400;
  const oy = 400;
  for (let dy = -8; dy <= 8; dy++)
    for (let dx = -8; dx <= 8; dx++) {
      eng.world.setTile(ox + dx, oy + dy, Layer.OBSTACLE, 0);
      eng.world.setTile(ox + dx, oy + dy, Layer.ITEM, 0);
      eng.world.setTile(ox + dx, oy + dy, Layer.TERRAIN, T.FLAT_SAND);
    }
  return { eng, u, ox, oy };
}

const mapped = (eng: SimulationEngine, ox: number, oy: number): string[] => {
  const out: string[] = [];
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) if (eng.world.isMapped(ox + dx, oy + dy)) out.push(`${dx},${dy}`);
  return out.sort();
};

describe('M8.1 directional headlight', () => {
  it('cone: 1..5 ahead, 3 wide for 2 tiles then 5 wide; rotates with the heading', () => {
    const north = coneOffsets(Dir.NORTH);
    expect(north.length).toBe(2 * 3 + 3 * 5);
    expect(inCone(Dir.NORTH, 0, 1)).toBe(true);
    expect(inCone(Dir.NORTH, 1, 2)).toBe(true);
    expect(inCone(Dir.NORTH, 2, 2)).toBe(false);
    expect(inCone(Dir.NORTH, 2, 3)).toBe(true);
    expect(inCone(Dir.NORTH, 0, 6)).toBe(false);
    expect(inCone(Dir.NORTH, 0, 0)).toBe(false);
    expect(inCone(Dir.NORTH, 0, -1)).toBe(false);
    // Rotating NORTH offsets by 90° clockwise gives EAST, etc.
    const rot = (o: ReadonlyArray<readonly [number, number]>) => o.map(([x, y]) => `${y},${-x}`).sort();
    const key = (o: ReadonlyArray<readonly [number, number]>) => o.map(([x, y]) => `${x},${y}`).sort();
    expect(rot(coneOffsets(Dir.NORTH))).toEqual(key(coneOffsets(Dir.EAST)));
    expect(rot(coneOffsets(Dir.EAST))).toEqual(key(coneOffsets(Dir.SOUTH)));
    expect(rot(coneOffsets(Dir.SOUTH))).toEqual(key(coneOffsets(Dir.WEST)));
  });

  it('at night without headlight only the 1-tile ring is revealed', () => {
    const { eng, u, ox, oy } = nightRover();
    expect(eng.admin.teleport(u, ox, oy)).toBe(true);
    expect(mapped(eng, ox, oy).length).toBe(9);
    expect(eng.viewShape(u)).toEqual({ radius: BALANCE.nightSensorRange, cone: -1 });
    // The rover's radar does not care about the dark.
    expect(eng.sensorRange(u)).toBe(CHASSIS_MK1.sensorRange);
  });

  it('headlight reveals the ring plus the cone in the heading direction only', () => {
    const { eng, u, ox, oy } = nightRover();
    u.headlight = 1;
    u.heading = Dir.EAST;
    eng.admin.teleport(u, ox, oy);
    const m = mapped(eng, ox, oy);
    expect(m.length).toBe(9 + 21 - 3); // the cone's first three tiles are in the ring
    expect(m).toContain('5,0');
    expect(m).toContain('5,2');
    expect(m).not.toContain('-2,0');
    expect(m).not.toContain('0,2');
    expect(eng.isVisible(u, 5, 0)).toBe(true);
    expect(eng.isVisible(u, 0, 2)).toBe(false);
    // Turning re-reveals on the next tick (heading is part of the reveal key).
    u.heading = Dir.WEST;
    eng.advanceTick();
    expect(mapped(eng, ox, oy)).toContain('-5,0');
  });

  it('SCAN is radar: full range in every direction at night, no headlight, no turning', () => {
    const { eng, u, ox, oy } = nightRover();
    eng.world.setTile(ox + 4, oy, Layer.OBSTACLE, T.CLIFF_WALL);
    eng.world.setTile(ox, oy + 4, Layer.OBSTACLE, T.CLIFF_WALL);
    eng.admin.teleport(u, ox, oy);
    u.heading = Dir.NORTH;
    eng.upload(u, 'SCAN EAST -> r0 r1\nSCAN NORTH -> r2 r3\nSLEEP 100000', factory);
    for (let i = 0; i < 6; i++) eng.advanceTick();
    expect(u.heading).toBe(Dir.NORTH);
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([T.CLIFF_WALL, 4]);
    expect([u.vm.regs[2], u.vm.regs[3]]).toEqual([T.CLIFF_WALL, 4]);
    // ...but the operator has not seen those walls: they are outside the ring.
    expect(eng.world.isMapped(ox + 4, oy)).toBe(false);
  });

  it('@HEADING turns in place for a little energy and wraps mod 4', () => {
    const { eng, u, ox, oy } = nightRover();
    eng.world.setTile(ox + 4, oy, Layer.OBSTACLE, T.CLIFF_WALL);
    eng.admin.teleport(u, ox, oy);
    u.heading = Dir.NORTH;
    eng.upload(u, 'MOV @HEADLIGHT 1\nADD @HEADING 1\nMOV r2 @HEADING\nSCAN EAST -> r0 r1\nMOV @HEADING 7\nMOV r3 @HEADING\nSLEEP 100000', factory);
    const before = u.energy;
    eng.advanceTick();
    expect(u.vm.regs[2]).toBe(Dir.EAST);
    eng.advanceTick(); // reveal follows the new heading on the next tick
    expect(eng.world.isMapped(ox + 4, oy)).toBe(true);
    for (let i = 0; i < 2; i++) eng.advanceTick();
    expect(u.vm.regs[3]).toBe(Dir.WEST);
    expect(u.heading).toBe(Dir.WEST);
    const spent = before - u.energy;
    expect(spent).toBeGreaterThanOrEqual(2 * BALANCE.turnEnergy + BALANCE.scanEnergy);
  });

  it('day: the operator sees the full disc in every direction', () => {
    const eng = new SimulationEngine({ seed: 7 });
    const u = eng.spawnUnit('t');
    expect(eng.sun.elevation).toBeGreaterThan(0);
    expect(eng.viewShape(u)).toEqual({ radius: BALANCE.dayViewRange, cone: -1 });
    expect(eng.world.isMapped(0, -BALANCE.dayViewRange)).toBe(true);
    expect(eng.sensorRange(u)).toBe(CHASSIS_MK1.sensorRange);
  });

  it('shipped firmware compiles and the Explorer keeps driving through a night', () => {
    const consts = createDefaultRegistry().constants();
    for (const [name, src] of Object.entries(TEMPLATES)) expect(compile(src, CHASSIS_MK1, consts).program, name).toBeTruthy();
    const eng = new SimulationEngine({ seed: 21 });
    const u = eng.spawnUnit('t');
    eng.upload(u, DEMO_EXPLORER, factory);
    while (eng.sun.elevation > 0) eng.advanceTick();
    let moved = 0;
    for (let i = 0; i < 600; i++) {
      const px = u.x;
      const py = u.y;
      eng.advanceTick();
      if (u.x !== px || u.y !== py) moved++;
    }
    // It only reacts to adjacent hits, which the always-sensed ring covers.
    expect(moved).toBeGreaterThan(20);
  });

  it('determinism and save round trip with turns and headlight at night', () => {
    const prog = `boot: MOV @HEADLIGHT 1
loop: SCAN @HEADING -> r0 r1
      JEQ r0 NONE go
      JGT r1 1 go
      ADD @HEADING 1
      JMP loop
go:   STEP @HEADING 1
      JEQ @STATUS OK loop
      ADD @HEADING 1
      JLT @BAT 20 rest
      JMP loop
rest: MOV @HEADLIGHT 0
      SLEEP 200`;
    const make = () => {
      const e = new SimulationEngine({ seed: 99 });
      const u = e.spawnUnit('r');
      e.upload(u, prog, factory);
      return e;
    };
    const run = (e: SimulationEngine, n: number) => {
      for (let i = 0; i < n; i++) e.advanceTick();
    };
    const total = BALANCE.dayTicks;
    const split = Math.floor(BALANCE.dayTicks * 0.6);
    const a = make();
    run(a, total);
    const b0 = make();
    run(b0, split);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, total - split);
    expect(serialize(b)).toEqual(serialize(a));
    expect(a.units[0].x !== 0 || a.units[0].y !== 0).toBe(true);
  });
});
