import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { PROSPECTOR, FACTORY_IDLE } from '../src/core/programs';
import { deserialize, SAVE_VERSION, SaveError, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Alert, CpuState, Layer, Status } from '../src/core/types';
import { T } from '../src/core/WorldRegistry';
import { EVENT_BY_ID } from '../src/core/events';

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

describe('subsystems & material repairs', () => {
  it('a damaged array charges proportionally less', () => {
    const { e, u } = rover('MOV @SOLAR_OPEN 1\nMOV @SOLAR_ANGLE @SUN_AZIMUTH\nSLEEP 100000');
    run(e, 80);
    const full = u.lastSolarGain;
    u.solarHealth = 50;
    e.advanceTick();
    expect(u.lastSolarGain).toBeLessThanOrEqual(Math.ceil(full / 2) + 1);
    expect(u.lastSolarGain).toBeGreaterThan(0);
  });

  it('a damaged dish weakens the signal', () => {
    const { e, u } = rover();
    u.antennaAngle = e.orbitAzimuth;
    expect(e.signalOf(u)).toBe(100);
    u.antennaHealth = 40;
    expect(e.signalOf(u)).toBe(40);
  });

  it('repairs consume the right material from cargo', () => {
    const { e, u } = rover(
      'USE 0 SYS_SOLAR\nMOV r0 @STATUS\nUSE 1 SYS_SOLAR\nMOV r1 @STATUS\nUSE 1 SYS_HULL\nMOV r2 @STATUS\nUSE 2 SYS_ANTENNA\nMOV r3 @STATUS\nSLEEP 100000',
    );
    u.cargo = [T.IRON_ORE, T.SILICON_ORE, T.REPAIR_KIT, 0];
    u.solarHealth = 50;
    u.antennaHealth = 50;
    u.hull = 50;
    run(e, 40);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([Status.ERR_INVALID, Status.OK, Status.ERR_INVALID, Status.OK]);
    expect(u.solarHealth).toBe(70); // silicon +20
    expect(u.antennaHealth).toBe(90); // kit +40
    expect(u.hull).toBe(50); // slot 1 was already used up
    expect(u.cargo).toEqual([T.IRON_ORE, 0, 0, 0]); // iron untouched: it cannot fix solar cells
    expect(e.stats.repairs).toBe(2);
  });
});

describe('storyteller events', () => {
  const starts = (seed: number, src: string, sols: number) => {
    const { e } = rover(src, seed);
    const ev: { phase: string; def: string; at: number; start: number }[] = [];
    e.events.on('WORLD_EVENT', (w) => ev.push({ phase: w.phase, def: w.def, at: e.tick, start: w.startTick }));
    run(e, BALANCE.dayTicks * sols);
    return { e, ev };
  };

  it('nothing happens until the prerequisites (First contact) are met', () => {
    const { ev } = starts(42, 'SLEEP 100000', 6);
    expect(ev).toEqual([]);
  });

  it('teaching events come first; full events only after their teaching version', () => {
    for (const seed of [1, 2, 3, 42, 99]) {
      const { ev } = starts(seed, FACTORY_IDLE, 12);
      const order = ev.filter((x) => x.phase === 'START').map((x) => x.def);
      expect(order.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(EVENT_BY_ID[order[0]].teaching, `seed ${seed}: ${order}`).toBe(true);
      const firstFull = (id: string, teach: string) => {
        const i = order.indexOf(id);
        if (i >= 0) expect(order.indexOf(teach), `seed ${seed}: ${order}`).toBeGreaterThanOrEqual(0);
        if (i >= 0) expect(order.indexOf(teach)).toBeLessThan(i);
      };
      firstFull('SQUALL', 'DUST_SQUALL');
      firstFull('ECLIPSE', 'PARTIAL_ECLIPSE');
    }
  });

  it('schedules deterministically per seed, each event announced warnTicks ahead', () => {
    const a = starts(42, FACTORY_IDLE, 10).ev;
    expect(a).toEqual(starts(42, FACTORY_IDLE, 10).ev);
    expect(a).not.toEqual(starts(43, FACTORY_IDLE, 10).ev);
    for (const s of a.filter((x) => x.phase === 'START')) {
      expect(a).toContainEqual({ phase: 'ALERT', def: s.def, at: s.start - EVENT_BY_ID[s.def].warnTicks, start: s.start });
    }
  });

  it('eclipses darken the sky to their minimum and show on @ALERT', () => {
    const { e, u } = rover('MOV r0 @ALERT\nMOV r1 @SUN_LIGHT\nSLEEP 1');
    run(e, 300);
    const day = e.sun.light;
    e.director.triggerNow('PARTIAL_ECLIPSE');
    run(e, BALANCE.eclipseRampTicks + 10);
    expect(e.sun.light).toBeGreaterThan(day * 0.3);
    expect(e.sun.light).toBeLessThan(day * 0.5);
    run(e, 200);
    e.director.triggerNow('ECLIPSE');
    run(e, BALANCE.eclipseRampTicks + 10);
    expect(e.sun.light).toBe(0);
    expect(u.vm.regs[0]).toBe(Alert.ALERT_ECLIPSE);
    expect(e.stats.eclipsesSurvived).toBe(0); // admin-triggered events don't count
    expect(e.director.history).toEqual({});
  });

  it('a squall wears hull and dish and wrecks an open array; the training squall is gentle', () => {
    const open = rover('MOV @SOLAR_OPEN 1\nSLEEP 100000');
    const shut = rover('SLEEP 100000');
    const dust = rover('MOV @SOLAR_OPEN 1\nSLEEP 100000');
    for (const [r, id] of [[open, 'SQUALL'], [shut, 'SQUALL'], [dust, 'DUST_SQUALL']] as const) {
      run(r.e, 30);
      r.e.director.triggerNow(id);
      run(r.e, EVENT_BY_ID[id].ticks + 2);
    }
    expect(open.u.solarHealth).toBeLessThan(40);
    expect(shut.u.solarHealth).toBe(100);
    expect(shut.u.hull).toBeLessThan(100);
    expect(shut.u.hull).toBeGreaterThan(80);
    expect(shut.u.antennaHealth).toBeLessThan(100);
    expect(dust.u.solarHealth).toBeGreaterThan(70);
    expect(dust.u.antennaHealth).toBe(100);
  });

  it('factory firmware stows the array when a squall is forecast and survives it', () => {
    const { e, u } = rover(FACTORY_IDLE);
    run(e, 300);
    expect(u.solarDeployed).toBe(true);
    const t = e.tick;
    const d = EVENT_BY_ID.SQUALL;
    e.director.events.push({ def: 'SQUALL', type: 'SQUALL', warnTick: t + 1, startTick: t + d.warnTicks, endTick: t + d.warnTicks + d.ticks });
    run(e, d.warnTicks);
    expect(u.solarStowed).toBe(true);
    run(e, d.ticks + 100);
    expect(u.solarHealth).toBe(100);
    expect(u.solarDeployed).toBe(true);
    expect(e.stats.squallsWeathered).toBe(1);
  });

  it('admin invulnerability blocks squall damage', () => {
    const { e, u } = rover();
    e.cheats.invulnerable = true;
    e.director.triggerNow('SQUALL');
    run(e, 120);
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
    expect(a.stats.oreMined + a.stats.framesReceived).toBeGreaterThan(0);
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
