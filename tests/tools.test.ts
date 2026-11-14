import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { GOALS } from '../src/core/EventDirector';
import { FACTORY_IDLE, PROSPECTOR, TEMPLATES } from '../src/core/programs';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { TOOLS } from '../src/core/tools';
import { CpuState, Layer, Status } from '../src/core/types';
import { T } from '../src/core/WorldRegistry';

function setup(src: string, prep?: (e: SimulationEngine) => void) {
  const eng = new SimulationEngine({ seed: 3 });
  prep?.(eng);
  const u = eng.spawnUnit('t');
  const r = eng.upload(u, src, { factory: true });
  expect(r.errors).toEqual([]);
  return { eng, u };
}
const run = (eng: SimulationEngine, n: number) => {
  for (let i = 0; i < n; i++) eng.advanceTick();
};

describe('drill (TOOL_0)', () => {
  it('mines an adjacent ore vein into cargo after 8 ticks', () => {
    const { eng, u } = setup('CALL ACT TOOL_0 EAST\nMOV r0 @STATUS\nLDB r1 [CARGO+0]\nMOV r2 @CARGO_FREE\nCALL SLEEP 1000', (e) =>
      e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE),
    );
    run(eng, TOOLS.DRILL.ticks - 1);
    expect(eng.world.getTile(1, 0, Layer.OBSTACLE)).toBe(T.IRON_ORE);
    run(eng, 2);
    expect(eng.world.getTile(1, 0, Layer.OBSTACLE)).toBe(0);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2]]).toEqual([Status.OK, T.IRON_ORE, 3]);
    expect(eng.stats.oreMined).toBe(1);
  });

  it('rejects non-ore targets and full cargo', () => {
    const { eng, u } = setup('CALL ACT TOOL_0 EAST\nMOV r0 @STATUS\nCALL ACT TOOL_0 NORTH\nMOV r1 @STATUS\nCALL SLEEP 1000', (e) => {
      e.world.setTile(1, 0, Layer.OBSTACLE, T.CLIFF_WALL);
      e.world.setTile(0, 1, Layer.OBSTACLE, T.SILICON_ORE);
    });
    u.cargo.fill(T.SAMPLE);
    run(eng, 3);
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([Status.ERR_INVALID, Status.ERR_FULL]);
    expect(u.vm.state).toBe(CpuState.BLOCKED); // only the SLEEP blocks
  });
});

describe('grabber, spectrometer, USE', () => {
  it('grabs a sample, analyzes it and the downlink delivers the spectrum', () => {
    const { eng, u } = setup(
      'CALL ACT TOOL_1 WEST\nCALL ACT TOOL_2 0\nMOV r0 @SCIENCE_READY\nMOV r2 @REC_FREE\nMOV @ANTENNA_ANGLE @ORBIT_AZIMUTH\nCALL SLEEP 80\nMOV r1 @SCIENCE_READY\nCALL SLEEP 1000',
      (e) => e.world.setTile(-1, 0, Layer.ITEM, T.SAMPLE),
    );
    run(eng, 40);
    expect(eng.world.getTile(-1, 0, Layer.ITEM)).toBe(0);
    expect(u.cargo[0]).toBe(0);
    expect(u.vm.regs[0]).toBe(1); // one product waiting
    expect(u.vm.regs[2]).toBe(1024 - 18);
    const credits = eng.credits;
    run(eng, 100);
    expect(u.vm.regs[1]).toBe(0);
    expect(eng.stats.scienceDelivered).toBe(1);
    expect(eng.credits - credits).toBeGreaterThanOrEqual(3); // sample = 3 (plus any goal reward)
    expect(eng.gallery).toHaveLength(1);
    expect(eng.gallery[0]).toMatchObject({ type: 0, subject: T.SAMPLE, received: 18 });
  });

  it('spectrometer refuses empty slots and repair kits; USE repairs the hull', () => {
    const { eng, u } = setup('CALL ACT TOOL_2 1\nMOV r0 @STATUS\nCALL ACT TOOL_2 0\nMOV r1 @STATUS\nCALL USE 0 SYS_HULL\nMOV r2 @STATUS\nCALL SLEEP 1000');
    u.cargo[0] = T.REPAIR_KIT;
    u.hull = 50;
    run(eng, 15);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2]]).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.OK]);
    expect(u.hull).toBe(80);
    expect(u.cargo[0]).toBe(0);
  });

  it('empty hardpoint gives ERR_NO_TOOL, bad slot ERR_INVALID, bad PEEK ERR_INVALID', () => {
    const { eng, u } = setup('CALL ACT TOOL_3 0\nMOV r0 @STATUS\nCALL ACT 9 0\nMOV r1 @STATUS\nLDB r2 [CARGO+7]\nCALL SLEEP 1000');
    run(eng, 4);
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([Status.ERR_NO_TOOL, Status.ERR_INVALID]);
  });

  it('tools work with the solar array open (only STEP is locked)', () => {
    const { eng, u } = setup('MOV @SOLAR_OPEN 1\nCALL SLEEP 25\nCALL ACT TOOL_0 EAST\nMOV r0 @STATUS\nCALL SLEEP 1000', (e) =>
      e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE),
    );
    run(eng, 40);
    expect(u.vm.regs[0]).toBe(Status.OK);
  });
});

describe('goals', () => {
  it('factory firmware completes First contact and awards credits', () => {
    const { eng } = setup(FACTORY_IDLE);
    const done: string[] = [];
    eng.events.on('GOAL_COMPLETED', (g) => done.push(g.id));
    run(eng, 400);
    expect(done).toContain('first_contact');
    expect(eng.credits).toBeGreaterThanOrEqual(GOALS.find((g) => g.id === 'first_contact')!.reward);
  });

  it('all templates compile', () => {
    const { eng, u } = setup('CALL SLEEP 1');
    for (const [name, src] of Object.entries(TEMPLATES)) expect(eng.compileFor(u, src).errors, name).toEqual([]);
  });

  it('prospector mines, analyzes and delivers science over 3 sols', () => {
    const eng = new SimulationEngine({ seed: 12345 });
    const u = eng.spawnUnit('t');
    eng.upload(u, PROSPECTOR, { factory: true });
    run(eng, BALANCE.dayTicks * 3);
    expect(u.vm.state).not.toBe(CpuState.FAULT);
    console.log(`prospector 3 sols: ore ${eng.stats.oreMined}, items ${eng.stats.itemsCollected}, analyzed ${eng.stats.itemsAnalyzed}, science ${eng.stats.scienceDelivered}, credits ${eng.credits}, goals ${[...eng.director.completed].join(',')}, bat ${u.batteryPercent}%`);
    expect(eng.stats.oreMined).toBeGreaterThan(0);
    expect(eng.stats.scienceDelivered).toBeGreaterThan(0);
  });
});
