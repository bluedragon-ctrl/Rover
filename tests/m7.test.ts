import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { PDP_ALLIN_FETCH as FETCH_SUPPLY } from '../src/core/programs-pdp11';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Layer, Status } from '../src/core/types';
import { UPGRADE_BY_ID, UPGRADES } from '../src/core/upgrades';
import { T } from '../src/core/WorldRegistry';
import { fw, HANG, reg } from './helpers/rover';

const run = (e: SimulationEngine, n: number) => {
  for (let i = 0; i < n; i++) e.advanceTick();
};
function rover(src = `START:${HANG}`, seed = 5) {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  expect(e.upload(u, src, { factory: true }).errors).toEqual([]);
  return { e, u };
}
/** Order an upgrade and wait for the crate to land. */
function orderAndLand(e: SimulationEngine, id: string) {
  e.credits += UPGRADE_BY_ID[id].cost;
  expect(e.buyUpgrade(e.units[0], id)).toBeNull();
  run(e, BALANCE.supplyDropTicks);
  return e.drops.find((d) => d.upgrade === id)!;
}
/** Teleport next to the crate (south of it) and grab north. */
function grab(e: SimulationEngine, d: { x: number; y: number }) {
  const u = e.units[0];
  expect(e.admin.teleport(u, d.x, d.y - 1)).toBe(true);
  e.upload(u, fw('MOV  #NORTH, R0', 'MOV  #F.T1, R1', 'JSR  PC, ACT', 'MOV  R0, R2'), { factory: true });
  run(e, 10);
  return reg(u, 2);
}

describe('buying upgrades', () => {
  it('needs credits and prerequisites, and cannot be bought twice', () => {
    const { e, u } = rover();
    expect(e.buyUpgrade(u, 'REC_4K')).toMatch(/credits/);
    e.credits = 500;
    expect(e.buyUpgrade(u, 'REC_8K')).toMatch(/needs Recorder 4 KB/);
    expect(e.buyUpgrade(u, 'REC_4K')).toBeNull();
    expect(e.credits).toBe(500 - UPGRADE_BY_ID.REC_4K.cost);
    expect(e.buyUpgrade(u, 'REC_4K')).toBe('on its way');
  });

  it('the crate lands 3–6 tiles away after the flight time, on a clear visible tile', () => {
    const { e, u } = rover();
    e.credits = 100;
    e.buyUpgrade(u, 'CARGO_6');
    const d = e.drops[0];
    const dist = Math.abs(d.x - u.x) + Math.abs(d.y - u.y);
    expect(dist).toBeGreaterThanOrEqual(BALANCE.supplyDropMinDist);
    expect(dist).toBeLessThanOrEqual(BALANCE.supplyDropMaxDist);
    run(e, BALANCE.supplyDropTicks - 1);
    expect(e.world.getTile(d.x, d.y, Layer.ITEM)).toBe(0);
    e.advanceTick();
    expect(e.world.getTile(d.x, d.y, Layer.ITEM)).toBe(T.SUPPLY_CRATE);
    expect(e.world.isMapped(d.x, d.y)).toBe(true);
  });
});

describe('picking up installs immediately', () => {
  it('cargo and the recorder grow; works even with full cargo', () => {
    const { e, u } = rover();
    u.cargo.fill(T.SAMPLE);
    expect(grab(e, orderAndLand(e, 'CARGO_6'))).toBe(Status.OK);
    expect(u.cargo.length).toBe(6);
    expect(u.chassis.cargoSlots).toBe(6);
    expect(e.drops).toEqual([]);
    expect(e.stats.upgradesInstalled).toBe(1);
    grab(e, orderAndLand(e, 'REC_4K'));
    expect(u.recorderBytes).toBe(4096);
  });

  it('other rovers do not get the base chassis modified', () => {
    const { e, u } = rover();
    grab(e, orderAndLand(e, 'CPU_96'));
    expect(u.chassis.cyclesPerTick).toBe(96);
    expect(e.cyclesPerTick(u)).toBe(96);
    const other = e.spawnUnit('b', 20, 20);
    expect(other.chassis.cyclesPerTick).toBe(64);
  });

  it('battery, solar and armor upgrades change the physics', () => {
    const { e, u } = rover();
    grab(e, orderAndLand(e, 'BATTERY_150'));
    expect(u.chassis.batteryCapacity).toBe(150_000);
    u.energy = 75_000;
    expect(u.batteryPercent).toBe(50);
    grab(e, orderAndLand(e, 'SOLAR_PLUS'));
    expect(u.chassis.solarPercent).toBe(125);
    grab(e, orderAndLand(e, 'ARMOR'));
    u.hull = 100;
    e.director.triggerNow('SQUALL');
    run(e, 102);
    expect(u.hull).toBeGreaterThanOrEqual(95); // ~5 instead of ~10
  });

  it('seismic scanner finds ore through walls once installed', () => {
    const { e, u } = rover();
    grab(e, orderAndLand(e, 'SEISMIC'));
    e.admin.teleport(u, 0, 0);
    e.world.setTile(1, 0, Layer.OBSTACLE, T.CLIFF_WALL);
    e.world.setTile(9, 0, Layer.OBSTACLE, T.SILICON_ORE);
    e.upload(u, fw('MOV  #EAST, R0', 'MOV  #F.T3, R1', 'JSR  PC, ACT', 'MOV  @#SEITYP, R2', 'MOV  @#SEIDST, R3'), { factory: true });
    run(e, 15);
    expect([reg(u, 2), reg(u, 3)]).toEqual([T.SILICON_ORE, 9]);
  });
});

describe('fetch template & persistence', () => {
  it('the Fetch template drives to a crate and installs it', () => {
    const e = new SimulationEngine({ seed: 5 });
    const u = e.spawnUnit('t');
    // Clear a corridor so the greedy fetcher cannot get stuck.
    for (let x = -8; x <= 8; x++) for (let y = -8; y <= 8; y++) {
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
    }
    e.upload(u, FETCH_SUPPLY, { factory: true });
    e.credits = 100;
    expect(e.buyUpgrade(u, 'LIDAR_8')).toBeNull();
    run(e, 600);
    expect(u.upgrades).toEqual(['LIDAR_8']);
    expect(u.chassis.sensorRange).toBe(8);
  });

  it('upgrades and pending drops survive save/load', () => {
    const { e, u } = rover();
    grab(e, orderAndLand(e, 'REC_4K'));
    e.credits = 100;
    e.buyUpgrade(u, 'CARGO_6');
    const l = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(l.units[0].upgrades).toEqual(['REC_4K']);
    expect(l.units[0].recorderBytes).toBe(4096);
    expect(l.drops.length).toBe(1);
    expect(l.stats.upgradesInstalled).toBe(1);
    run(l, BALANCE.supplyDropTicks);
    expect(l.drops[0].landed).toBe(true);

  });

  it('every upgrade in the catalogue can be installed', () => {
    const { e, u } = rover();
    for (const up of UPGRADES) e.installUpgrade(u, up.id);
    expect(u.upgrades.length).toBe(UPGRADES.length);
    expect(u.chassis.tools[3]).toBe('SEISMIC');
  });
});
