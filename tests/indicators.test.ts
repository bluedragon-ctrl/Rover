import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { deserialize, migrate, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { LightColor } from '../src/core/types';

function setup(src: string) {
  const eng = new SimulationEngine({ seed: 1 });
  const u = eng.spawnUnit('t');
  const r = eng.upload(u, src, { factory: true });
  expect(r.errors).toEqual([]);
  return { eng, u };
}

describe('indicator lamps @IND1..@IND3', () => {
  it('are set by code with colour constants, clamped, readable, and cost nothing', () => {
    const { eng, u } = setup('MOV @IND1 RED\nMOV @IND2 99\nMOV @IND3 -5\nMOV r0 @IND1\nCALL SLEEP 100');
    const before = u.energy;
    eng.advanceTick();
    expect(u.indicators).toEqual([LightColor.RED, LightColor.AMBER, LightColor.OFF]);
    expect(u.vm.regs[0]).toBe(LightColor.RED);
    // Only passive drain/charge happened: same as an idle rover's tick.
    const idle = setup('CALL SLEEP 100');
    idle.eng.advanceTick();
    expect(before - u.energy).toBe(before - idle.u.energy);
  });

  it('survive a reboot (physical state) and a save/load', () => {
    const { eng, u } = setup('MOV @IND2 BLUE\nCALL SLEEP 100');
    eng.advanceTick();
    eng.upload(u, 'CALL SLEEP 100', { factory: true });
    expect(u.indicators[1]).toBe(LightColor.BLUE);
    const l = deserialize(JSON.parse(JSON.stringify(serialize(eng))));
    expect(l.units[0].indicators).toEqual([0, LightColor.BLUE, 0]);
  });

  it('v2 saves migrate with dark indicators', () => {
    const { eng } = setup('CALL SLEEP 100');
    const v2 = serialize(eng) as unknown as Record<string, unknown>;
    v2.version = 2;
    for (const us of v2.units as Record<string, unknown>[]) delete us.indicators;
    expect(migrate(v2).version).toBe(SAVE_VERSION);
    expect(deserialize(v2).units[0].indicators).toEqual([0, 0, 0]);
  });
});

describe('the status beacon is retired (save v12)', () => {
  it('@LIGHT_COLOR / @LIGHT_BLINK are no longer ports, and their machine-code numbers stay unused', async () => {
    const { decodeProgram, DecodeError } = await import('../src/core/vm/isa');
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    expect(eng.compileFor(u, 'MOV @LIGHT_COLOR RED').errors.length).toBe(1);
    expect(eng.compileFor(u, 'MOV @LIGHT_BLINK 1').errors.length).toBe(1);
    expect(() => decodeProgram([0x01, 0x40 | 33, 0x01])).toThrow(DecodeError);
    expect(decodeProgram([0x01, 0x40 | 35, 0x01])[0].args[0]).toEqual({ k: 'port', name: 'IND1' });
  });

  it('v11 saves move beacon code and state onto the status lamps', () => {
    const src = 'MOV @LIGHT_COLOR BLUE\nMOV @light_blink 1\nloop: JMP loop';
    const { eng } = setup('MOV @IND1 BLUE\nMOV @IND3 1\nloop: JMP loop');
    eng.advanceTick();
    eng.advanceTick();
    const v11 = serialize(eng) as unknown as Record<string, any>;
    v11.version = 11;
    for (const us of v11.units) {
      us.lights = [LightColor.BLUE, 1, 1];
      delete us.headlight;
      us.indicators = [0, LightColor.AMBER, 0];
      us.sourceCode = src;
      us.vm.legacyIndex = false;
    }
    const l = deserialize(v11).units[0];
    expect(l.sourceCode).toBe('MOV @IND1 BLUE\nMOV @IND3 1\nloop: JMP loop');
    expect(l.indicators).toEqual([LightColor.BLUE, LightColor.AMBER, 1]);
    expect(l.headlight).toBe(1);
    expect(l.vm.ip).toBe(eng.units[0].vm.ip); // same byte sizes: the saved IP still fits
  });
});

describe('@POST display (SPEC §3.8.3)', () => {
  it('is a free 0–255 port that leaves @STATUS alone and survives reboots', async () => {
    const { SimulationEngine } = await import('../src/core/SimulationEngine');
    const { Status } = await import('../src/core/types');
    const e = new SimulationEngine({ seed: 2 });
    const u = e.spawnUnit('t');
    e.upload(u, 'MOV @POST 0x1F\nMOV r0 @POST\nMOV @POST 999\nMOV r1 @POST\nMOV @POST -5\nMOV r2 @POST\nMOV @POST 0xA5\nidle: JMP idle', { factory: true });
    u.vm.status = Status.ERR_FULL;
    for (let i = 0; i < 5; i++) e.advanceTick();
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2]]).toEqual([0x1f, 255, 0]);
    expect(u.post).toBe(0xa5);
    expect(u.vm.status).toBe(Status.ERR_FULL); // @POST writes do not touch @STATUS
    e.upload(u, 'CALL SLEEP 100', { factory: true });
    expect(u.post).toBe(0xa5); // physical: survives the reboot
  });

  it('is saved, and v6 saves migrate to 00', async () => {
    const { SimulationEngine } = await import('../src/core/SimulationEngine');
    const { serialize, deserialize } = await import('../src/core/SaveManager');
    const e = new SimulationEngine({ seed: 2 });
    const u = e.spawnUnit('t');
    u.post = 0x42;
    expect(deserialize(JSON.parse(JSON.stringify(serialize(e)))).units[0].post).toBe(0x42);
    const v6 = serialize(e) as unknown as Record<string, any>;
    v6.version = 6;
    for (const s of v6.units) delete s.post;
    expect(deserialize(v6).units[0].post).toBe(0);
  });
});
