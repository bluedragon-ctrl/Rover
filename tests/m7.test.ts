import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { FETCH_SUPPLY } from '../src/core/programs';
import { deserialize, migrate, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Layer, Status } from '../src/core/types';
import { UPGRADE_BY_ID, UPGRADES } from '../src/core/upgrades';
import { T } from '../src/core/WorldRegistry';

const run = (e: SimulationEngine, n: number) => {
  for (let i = 0; i < n; i++) e.advanceTick();
};
function rover(src = 'SLEEP 100000', seed = 5) {
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
  e.upload(u, 'ACT TOOL_1 NORTH\nMOV r0 @STATUS\nSLEEP 100000', { factory: true });
  run(e, 5);
  return u.vm.regs[0];
}

describe('buying upgrades', () => {
  it('needs credits and prerequisites, and cannot be bought twice', () => {
    const { e, u } = rover();
    expect(e.buyUpgrade(u, 'FLASH_48')).toMatch(/credits/);
    e.credits = 500;
    expect(e.buyUpgrade(u, 'FLASH_64')).toMatch(/needs Flash 192 B/);
    expect(e.buyUpgrade(u, 'FLASH_48')).toBeNull();
    expect(e.credits).toBe(500 - UPGRADE_BY_ID.FLASH_48.cost);
    expect(e.buyUpgrade(u, 'FLASH_48')).toBe('on its way');
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
  it('cargo, registers and flash grow; works even with full cargo', () => {
    const { e, u } = rover();
    u.cargo.fill(T.SAMPLE);
    expect(grab(e, orderAndLand(e, 'CARGO_6'))).toBe(Status.OK);
    expect(u.cargo.length).toBe(6);
    expect(u.chassis.cargoSlots).toBe(6);
    expect(e.drops).toEqual([]);
    expect(e.stats.upgradesInstalled).toBe(1);

    expect(e.compileFor(u, 'MOV r5 1').errors.length).toBe(1);
    grab(e, orderAndLand(e, 'REGS_6'));
    expect(u.vm.regs.length).toBe(6);
    expect(e.compileFor(u, 'MOV r5 1').errors).toEqual([]);

    const long = Array.from({ length: 40 }, () => 'ADD r0 100').join('\n'); // 160 B
    expect(e.compileFor(u, long).errors.length).toBe(1);
    grab(e, orderAndLand(e, 'FLASH_48'));
    expect(e.compileFor(u, long).errors).toEqual([]);
  });

  it('other rovers do not get the base chassis modified', () => {
    const { e, u } = rover();
    grab(e, orderAndLand(e, 'CPU_6'));
    expect(u.chassis.cyclesPerTick).toBe(6);
    const other = e.spawnUnit('b', 20, 20);
    expect(other.chassis.cyclesPerTick).toBe(4);
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
    e.upload(u, 'ACT TOOL_3 EAST\nMOV r0 @SEISMIC_TYPE\nMOV r1 @SEISMIC_DIST\nSLEEP 100000', { factory: true });
    run(e, 8);
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([T.SILICON_ORE, 9]);
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

  it('upgrades and pending drops survive save/load; v1 saves migrate', () => {
    const { e, u } = rover();
    grab(e, orderAndLand(e, 'REGS_6'));
    u.vm.regs[5] = 42;
    e.credits = 100;
    e.buyUpgrade(u, 'CARGO_6');
    const l = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(l.units[0].upgrades).toEqual(['REGS_6']);
    expect(l.units[0].vm.regs[5]).toBe(42);
    expect(l.drops.length).toBe(1);
    expect(l.stats.upgradesInstalled).toBe(1);
    run(l, BALANCE.supplyDropTicks);
    expect(l.drops[0].landed).toBe(true);

    const v1 = serialize(rover().e) as unknown as Record<string, unknown>;
    v1.version = 1;
    delete v1.drops;
    delete v1.nextDropId;
    for (const us of v1.units as Record<string, unknown>[]) {
      delete us.upgrades;
      delete us.seismic;
    }
    const m = migrate(v1);
    expect(m.version).toBe(SAVE_VERSION);
    expect(deserialize(v1).units[0].upgrades).toEqual([]);
  });

  it('every upgrade in the catalogue can be installed', () => {
    const { e, u } = rover();
    for (const up of UPGRADES) e.installUpgrade(u, up.id);
    expect(u.upgrades.length).toBe(UPGRADES.length);
    expect(u.chassis.tools[3]).toBe('SEISMIC');
  });
});
