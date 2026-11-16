import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { GOALS } from '../src/core/EventDirector';
import { PDP_ALLIN_PROSPECTOR, PDP_DEFAULT_FIRMWARE } from '../src/core/programs-pdp11';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { TOOLS } from '../src/core/tools';
import { CpuState, Layer, Status } from '../src/core/types';
import { T } from '../src/core/WorldRegistry';
import { fw, reg, rover, run, sleep, until } from './helpers/rover';

/** `JSR PC, ACT` with R0 = arg, R1 = hardpoint; the result goes to `dst`. */
const act = (arg: string, tool: string, dst: string) => `MOV  #${arg}, R0\n        MOV  #${tool}, R1\n        JSR  PC, ACT\n        MOV  R0, ${dst}`;

describe('drill (F.T0)', () => {
  it('mines an adjacent ore vein into cargo after 8 ticks', () => {
    const { e, u } = rover(fw(act('EAST', 'F.T0', 'R2'), 'MOVB @#CARGO, R3', 'MOV  @#CRGFRE, R4'), { seed: 3, setup: (e) => e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE) });
    until(e, () => u.action?.kind === 'TOOL'); // started in the tick that just ran
    run(e, TOOLS.DRILL.ticks - 1);
    expect(e.world.getTile(1, 0, Layer.OBSTACLE)).toBe(T.IRON_ORE);
    run(e, 2);
    expect(e.world.getTile(1, 0, Layer.OBSTACLE)).toBe(0);
    expect([reg(u, 2), reg(u, 3), reg(u, 4)]).toEqual([Status.OK, T.IRON_ORE, 3]);
    expect(e.stats.oreMined).toBe(1);
  });

  it('rejects non-ore targets and full cargo', () => {
    const { e, u } = rover(fw(act('EAST', 'F.T0', 'R2'), act('NORTH', 'F.T0', 'R3')), {
      seed: 3,
      setup: (e) => {
        e.world.setTile(1, 0, Layer.OBSTACLE, T.CLIFF_WALL);
        e.world.setTile(0, 1, Layer.OBSTACLE, T.SILICON_ORE);
      },
    });
    u.cargo.fill(T.SAMPLE);
    run(e, 6);
    expect([reg(u, 2), reg(u, 3)]).toEqual([Status.ERR_INVALID, Status.ERR_FULL]);
    expect(u.cpu.state).toBe(CpuState.RUNNING);
  });
});

describe('grabber, spectrometer, USE', () => {
  it('grabs a sample, analyzes it and the downlink delivers the spectrum', () => {
    const { e, u } = rover(
      fw(act('WEST', 'F.T1', 'R5'), act('0', 'F.T2', 'R5'), 'MOV  @#SCIRDY, R2', 'MOV  @#RECFRE, R4', 'MOV  @#ORBAZ, @#ANTANG', sleep(80), 'MOV  @#SCIRDY, R3'),
      { seed: 3, setup: (e) => e.world.setTile(-1, 0, Layer.ITEM, T.SAMPLE) },
    );
    run(e, 40);
    expect(e.world.getTile(-1, 0, Layer.ITEM)).toBe(0);
    expect(u.cargo[0]).toBe(0);
    expect(reg(u, 2)).toBe(1); // one product waiting
    expect(reg(u, 4)).toBe(u.recorderBytes - 18);
    const credits = e.credits;
    run(e, 100);
    expect(reg(u, 3)).toBe(0);
    expect(e.stats.scienceDelivered).toBe(1);
    expect(e.credits - credits).toBeGreaterThanOrEqual(3); // sample = 3 (plus any goal reward)
    expect(e.gallery).toHaveLength(1);
    expect(e.gallery[0]).toMatchObject({ type: 0, subject: T.SAMPLE, received: 18 });
  });

  it('spectrometer refuses empty slots and repair kits; USE repairs the hull', () => {
    const { e, u } = rover(fw(act('1', 'F.T2', 'R2'), act('0', 'F.T2', 'R3'), 'CLR  R0', 'MOV  #F.HULL, R1', 'JSR  PC, USE', 'MOV  R0, R4'), { seed: 3 });
    u.cargo[0] = T.REPAIR_KIT;
    u.hull = 50;
    run(e, 20);
    expect([reg(u, 2), reg(u, 3), reg(u, 4)]).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.OK]);
    expect(u.hull).toBe(80);
    expect(u.cargo[0]).toBe(0);
  });

  it('an empty hardpoint gives E.NOTL, a hardpoint the chassis lacks E.INV', () => {
    const { e, u } = rover(fw(act('0', 'F.T3', 'R2'), act('0', '10', 'R3')), { seed: 3 });
    run(e, 6);
    expect([reg(u, 2), reg(u, 3)]).toEqual([Status.ERR_NO_TOOL, Status.ERR_INVALID]);
  });

  it('tools work with the solar array open (only the drive is locked)', () => {
    const { e, u } = rover(fw('MOV  #1, @#SOLOPN', sleep(25), act('EAST', 'F.T0', 'R2')), { seed: 3, setup: (e) => e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE) });
    run(e, 45);
    expect(reg(u, 2)).toBe(Status.OK);
    expect(u.cargo[0]).toBe(T.IRON_ORE);
  });
});

describe('goals', () => {
  it('the default firmware completes First contact and awards credits', () => {
    const { e } = rover(PDP_DEFAULT_FIRMWARE, { seed: 3 });
    const done: string[] = [];
    e.events.on('GOAL_COMPLETED', (g) => done.push(g.id));
    run(e, 400);
    expect(done).toContain('first_contact');
    expect(e.credits).toBeGreaterThanOrEqual(GOALS.find((g) => g.id === 'first_contact')!.reward);
  });

  it('the all-in-one Prospector mines, analyzes and delivers science over 3 sols', () => {
    const e = new SimulationEngine({ seed: 12345 });
    const u = e.spawnUnit('t');
    e.upload(u, PDP_ALLIN_PROSPECTOR, { factory: true });
    run(e, BALANCE.dayTicks * 3);
    expect(u.cpu.state).not.toBe(CpuState.FAULT);
    console.log(`prospector 3 sols: ore ${e.stats.oreMined}, items ${e.stats.itemsCollected}, analyzed ${e.stats.itemsAnalyzed}, science ${e.stats.scienceDelivered}, credits ${e.credits}, goals ${[...e.director.completed].join(',')}, bat ${u.batteryPercent}%`);
    expect(e.stats.oreMined).toBeGreaterThan(0);
    expect(e.stats.scienceDelivered).toBeGreaterThan(0);
  });
});
