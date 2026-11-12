import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { PROSPECTOR, FACTORY_IDLE } from '../src/core/programs';
import { deserialize, SAVE_VERSION, SaveError, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Alert, CpuState, Layer, Status } from '../src/core/types';
import { T } from '../src/core/WorldRegistry';

const factory = { factory: true };
const run = (e: SimulationEngine, n: number) => {
  for (let i = 0; i < n; i++) e.advanceTick();
};
function rover(src = 'SLEEP 100000', seed = 3) {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  expect(e.upload(u, src, factory).errors).toEqual([]);
  return { e, u };
}

describe('subsystems', () => {
  it('a damaged array charges proportionally less; repair kits fix a chosen system', () => {
    const { e, u } = rover('MOV @SOLAR_OPEN 1\nMOV @SOLAR_ANGLE @SUN_AZIMUTH\nSLEEP 100000');
    run(e, 80);
    const full = u.lastSolarGain;
    u.solarHealth = 50;
    e.advanceTick();
    expect(u.lastSolarGain).toBeLessThanOrEqual(Math.ceil(full / 2) + 1);
    expect(u.lastSolarGain).toBeGreaterThan(0);

    e.upload(u, 'USE 0 SYS_SOLAR\nMOV r0 @STATUS\nUSE 1 SYS_ANTENNA\nMOV r1 @SOLAR_HEALTH\nMOV r2 @ANTENNA_HEALTH\nSLEEP 100000', factory);
    u.cargo[0] = T.REPAIR_KIT;
    u.cargo[1] = T.REPAIR_KIT;
    u.antennaHealth = 10;
    run(e, 15);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2]]).toEqual([Status.OK, 90, 50]);
  });

  it('a damaged dish weakens the signal', () => {
    const { e, u } = rover();
    u.antennaAngle = e.orbitAzimuth;
    expect(e.signalOf(u)).toBe(100);
    u.antennaHealth = 40;
    expect(e.signalOf(u)).toBe(40);
  });
});

describe('storyteller events', () => {
  it('schedules deterministically per seed, with warnings ahead of time', () => {
    const log = (seed: number) => {
      const { e } = rover('SLEEP 100000', seed);
      const ev: string[] = [];
      e.events.on('WORLD_EVENT', (w) => ev.push(`${w.phase}:${w.type}@${e.tick}`));
      run(e, BALANCE.dayTicks * 8);
      return ev;
    };
    const a = log(42);
    expect(a).toEqual(log(42));
    expect(a).not.toEqual(log(43));
    expect(a.some((s) => s.startsWith('START'))).toBe(true);
    // every START is preceded by its ALERT eventWarnTicks earlier
    for (const s of a.filter((x) => x.startsWith('START'))) {
      const [, type, at] = /START:(\w+)@(\d+)/.exec(s)!;
      expect(a).toContain(`ALERT:${type}@${+at - BALANCE.eventWarnTicks}`);
    }
  });

  it('an eclipse darkens the sky and is visible on @ALERT', () => {
    const { e, u } = rover('MOV r0 @ALERT\nMOV r1 @SUN_LIGHT\nSLEEP 1');
    run(e, 300); // mid-morning
    expect(e.sun.light).toBeGreaterThan(30);
    e.director.triggerNow('ECLIPSE');
    run(e, BALANCE.eclipseRampTicks + 10);
    expect(e.sun.light).toBe(0);
    expect(u.vm.regs[0]).toBe(Alert.ALERT_ECLIPSE);
    run(e, BALANCE.eclipseTicks);
    expect(e.sun.light).toBeGreaterThan(30);
    expect(e.stats.eclipsesSurvived).toBe(0); // admin-triggered events don't count for goals
  });

  it('a squall wears the hull and dish, and wrecks an open solar array', () => {
    const open = rover('MOV @SOLAR_OPEN 1\nSLEEP 100000');
    const shut = rover('SLEEP 100000');
    for (const r of [open, shut]) {
      run(r.e, 30);
      r.e.director.triggerNow('SQUALL');
      run(r.e, BALANCE.squallTicks + 2);
    }
    expect(open.u.solarHealth).toBeLessThan(40);
    expect(shut.u.solarHealth).toBe(100);
    expect(shut.u.hull).toBeLessThan(100);
    expect(shut.u.hull).toBeGreaterThan(80);
    expect(shut.u.antennaHealth).toBeLessThan(100);

  });

  it('factory firmware stows the array when a squall is forecast and survives it', () => {
    const { e, u } = rover(FACTORY_IDLE);
    run(e, 300);
    expect(u.solarDeployed).toBe(true);
    const t = e.tick;
    e.director.events.push({ type: 'SQUALL', warnTick: t + 1, startTick: t + BALANCE.eventWarnTicks, endTick: t + BALANCE.eventWarnTicks + BALANCE.squallTicks });
    run(e, BALANCE.eventWarnTicks);
    expect(u.solarStowed).toBe(true);
    run(e, BALANCE.squallTicks + 100);
    expect(u.solarHealth).toBe(100);
    expect(u.solarDeployed).toBe(true); // redeployed afterwards
    expect(e.stats.squallsWeathered).toBe(1);
  });

  it('admin invulnerability blocks squall damage', () => {
    const { e, u } = rover();
    e.cheats.invulnerable = true;
    e.director.triggerNow('SQUALL');
    run(e, BALANCE.squallTicks + 2);
    expect(u.hull).toBe(100);
  });
});

describe('save / load', () => {
  it('round-trips exactly: save, load, continue == uninterrupted run', () => {
    const make = () => {
      const e = new SimulationEngine({ seed: 12345 });
      const u = e.spawnUnit('Rover-1');
      e.upload(u, PROSPECTOR, factory);
      return e;
    };
    const total = BALANCE.dayTicks * 3;
    const split = 1733;

    const a = make();
    run(a, total);

    const b0 = make();
    run(b0, split);
    const json = JSON.stringify(serialize(b0));
    const b = deserialize(JSON.parse(json));
    run(b, total - split);

    expect(serialize(b)).toEqual(serialize(a));
    expect(a.stats.oreMined + a.stats.packetsSent).toBeGreaterThan(0);
    console.log(`save size at tick ${split}: ${(json.length / 1024).toFixed(1)} KB, ${JSON.parse(json).chunks.length} chunks`);
  });

  it('stores only modified/explored chunks and restores mined tiles and fog', () => {
    const { e } = rover(FACTORY_IDLE);
    e.world.setTile(100, 100, Layer.OBSTACLE, 0);
    e.world.setTile(101, 100, Layer.ITEM, T.SAMPLE);
    run(e, 20);
    const snap = serialize(e);
    expect(snap.chunks.length).toBeLessThan(10);
    const l = deserialize(JSON.parse(JSON.stringify(snap)));
    expect(l.world.getTile(101, 100, Layer.ITEM)).toBe(T.SAMPLE);
    expect(l.world.isMapped(0, 0)).toBe(true);
    expect(l.world.isMapped(50, 50)).toBe(false);
    expect(l.units[0].vm.state).not.toBe(CpuState.FAULT);
  });

  it('rejects foreign or future files', () => {
    expect(() => deserialize({ hello: 1 })).toThrow(SaveError);
    const { e } = rover();
    expect(() => deserialize({ ...serialize(e), version: SAVE_VERSION + 1 })).toThrow(/version/);
  });
});
