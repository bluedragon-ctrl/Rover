import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { BootReason, decodeFrame } from '../src/core/downlink';
import { migrateHardwareOps } from '../src/core/migrateSource';
import { ROM_ARGS, ROM_ENTRIES, ROM_SOURCE } from '../src/core/rom';
import { deserialize, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, ProgState, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { compile, romCompile, romLabels, romProgram } from '../src/core/vm/Compiler';
import { ROM_BASE } from '../src/core/vm/isa';
import { createDefaultRegistry, T } from '../src/core/WorldRegistry';
import { buildListing, listingText } from '../src/ui/listing';

const consts = createDefaultRegistry().constants();
const factory = { factory: true };
const c = (src: string, slot: 'firmware' | 'program' = 'firmware') => compile(src, CHASSIS_MK1, consts, { slot });

function rover(firmware: string, program?: string, seed = 3): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  return { e, u };
}
const run = (e: SimulationEngine, n: number) => {
  for (let i = 0; i < n; i++) e.advanceTick();
};
function until(e: SimulationEngine, cond: () => boolean, max = 500): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    e.advanceTick();
  }
  throw new Error('condition never held');
}

describe('ROM library (docs/ASSEMBLER_CORE.md §6)', () => {
  it('assembles at 0xF000 with every routine; the drivers use no registers', () => {
    const rom = romProgram();
    expect(rom.base).toBe(ROM_BASE);
    expect(rom.instrs[0].addr).toBe(ROM_BASE);
    for (const n of ROM_ENTRIES) expect(romLabels()[n]).toBeGreaterThanOrEqual(ROM_BASE);
    expect(rom.code.length).toBeLessThanOrEqual(256);
    expect(rom.instrs.some((i) => i.args.some((a) => a.k === 'reg' || (a.k === 'mem' && a.base >= 0)))).toBe(false);
  });

  it('its listing shows ROM addresses (Reference → ROM)', () => {
    const text = listingText(buildListing(ROM_SOURCE, romCompile(), 'firmware', ROM_BASE));
    expect(text).toMatch(/^rom:0xF000 .*SLEEP: +POP @TIMER/m);
    expect(text).toMatch(new RegExp(`^rom:0x${romLabels().STEP.toString(16).toUpperCase()} +[0-9A-F ]+ +STEP: `, 'm'));
  });

  it('routine names are reserved; the assembler checks the argument count', () => {
    expect(c('step: JMP step').errors[0].message).toMatch(/name of a ROM routine/);
    expect(c('CONST SCAN 3').errors[0].message).toMatch(/already used/);
    expect(c('wait: JMP wait').errors[0].message).toMatch(/clashes/); // WAIT is an instruction
    expect(c('CALL STEP EAST').errors[0].message).toBe('CALL STEP takes 2 arguments: CALL STEP dir tiles');
    expect(c('CALL SLEEP 1 2').errors[0].message).toMatch(/CALL SLEEP takes 1 argument: CALL SLEEP ticks/);
    for (const [n, args] of Object.entries(ROM_ARGS)) expect(c(`CALL ${n} ${args.map(() => 1).join(' ')}`).errors, n).toEqual([]);
    // A label of your own with another name is a normal call.
    expect(c('CALL go 1 2\ngo: POP r0\nPOP r1\nRET').errors).toEqual([]);
  });

  it('LDF reads the ROM itself', () => {
    const { e, u } = rover('LDF r0 [0xF000]\nLDF r1 [STEP]\nCALL SLEEP 100');
    run(e, 1);
    expect(u.vm.regs[0]).toBe(romProgram().code[0]);
    expect(u.vm.regs[1]).toBe(romProgram().code[romLabels().STEP - ROM_BASE]);
  });

  it('runs in the caller context: a dump inside it shows a ROM address; the call stack holds the return', () => {
    const { e, u } = rover('CALL SLEEP 50');
    run(e, 2);
    expect(u.vm.state).toBe(CpuState.BLOCKED);
    expect(u.vm.inRom).toBe(true);
    expect(u.vm.nextIp).toBeGreaterThan(ROM_BASE);
    expect(u.vm.callStack.length).toBe(1);
    expect(u.vm.nextLine).toBe(0); // not a line of the firmware's source
  });
});

describe('WAIT and devices (docs/ASSEMBLER_CORE.md §3.1, §4)', () => {
  it('WAIT sleeps for free until the port reads 0; a busy loop does the same work for many cycles', () => {
    const wait = rover('MOV @TIMER 40\nWAIT @TIMER\nMOV r0 @TICK\nCALL SLEEP 1000');
    const poll = rover('MOV @TIMER 40\nw: JNE @TIMER 0 w\nMOV r0 @TICK\nCALL SLEEP 1000');
    run(wait.e, 50);
    run(poll.e, 50);
    expect(wait.u.vm.regs[0]).toBe(poll.u.vm.regs[0]);
    expect(wait.u.vm.instructionsExecuted).toBeLessThan(10);
    expect(poll.u.vm.instructionsExecuted).toBeGreaterThan(40 * CHASSIS_MK1.cyclesPerTick - 10);
  });

  it('WAIT works on any readable port; only device ports set @STATUS', () => {
    expect(c('WAIT @DRIVE_X').errors[0].message).toMatch(/Unknown port/);
    expect(c('WAIT r0').errors[0].message).toMatch(/WAIT needs a port/);
    const { e, u } = rover('DIV r0 0\nMOV @POST 3\nWAIT @IND1\nMOV r1 @STATUS\nCALL SLEEP 100');
    run(e, 1);
    expect(u.vm.regs[1]).toBe(Status.ERR_INVALID); // @IND1 is 0: no wait, and not a device: @STATUS stays
  });

  it('a device start answers at once in @STATUS; WAIT then reports how the work ended', () => {
    const { e, u } = rover('MOV @DRIVE 9\nMOV r0 @STATUS\nMOV @DRIVE_N 2\nMOV @DRIVE EAST\nMOV r1 @STATUS\nMOV r2 @DRIVE\nWAIT @DRIVE\nMOV r3 @STATUS\nCALL SLEEP 1000');
    e.world.setTile(2, 0, Layer.OBSTACLE, T.CLIFF_WALL);
    run(e, 1);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2]]).toEqual([Status.ERR_INVALID, Status.OK, 2]);
    until(e, () => u.vm.regs[3] !== 0);
    expect(u.vm.regs[3]).toBe(Status.ERR_BLOCKED); // the second tile was blocked
    expect(u.x).toBe(1);
  });

  it('drive, tools, repair and camera share the chassis (ERR_BUSY); the radar works while driving', () => {
    const src = 'MOV @DRIVE_N 3\nMOV @DRIVE EAST\nMOV @RADAR SOUTH\nMOV r2 @STATUS\nMOV @RADAR NORTH\nMOV r3 @STATUS\nMOV @TOOL TOOL_1\nMOV r0 @STATUS\nMOV @CAM NORTH\nMOV r1 @STATUS\nCALL SLEEP 1000';
    const { e, u } = rover(src);
    run(e, 2);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([Status.ERR_BUSY, Status.ERR_BUSY, Status.OK, Status.ERR_BUSY]);
    expect(u.action?.kind).toBe('STEP');
  });

  it('SEND and ERASE are refused while the camera exposes', () => {
    const { e, u } = rover('MOV @CAM_MODE 1\nMOV @CAM NORTH\nMOV @SEND 1\nMOV r0 @STATUS\nMOV @ERASE 1\nMOV r1 @STATUS\nWAIT @CAM\nMOV @SEND 0\nMOV r2 @STATUS\nCALL SLEEP 1000');
    run(e, 1);
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([Status.ERR_BUSY, Status.ERR_BUSY]);
    until(e, () => u.link.products.length > 0);
    expect(u.vm.regs[2]).toBe(Status.OK);
  });

  it('@DRIVE_N while driving changes the tiles left; 0 stops at the end of the tile with ERR_PREEMPTED', () => {
    const longer = rover('MOV @DRIVE_N 1\nMOV @DRIVE EAST\nMOV @DRIVE_N 4\nWAIT @DRIVE\nMOV r0 @STATUS\nCALL SLEEP 1000');
    until(longer.e, () => longer.u.vm.regs[0] === 0 && !longer.u.action && longer.u.x > 0, 100);
    run(longer.e, 2);
    expect(longer.u.x).toBe(4);
    const stop = rover('MOV @DRIVE_N 5\nMOV @DRIVE EAST\nMOV @DRIVE_N 0\nWAIT @DRIVE\nMOV r0 @STATUS\nCALL SLEEP 1000');
    until(stop.e, () => stop.u.vm.regs[0] !== 0, 100);
    expect(stop.u.vm.regs[0]).toBe(Status.ERR_PREEMPTED);
    expect(stop.u.x).toBe(1);
  });

  it('drive and scan at once (§8): the radar counts samples while the wheels turn; RET returns r0 to the firmware', () => {
    const prog = `CONST T_SAMPLE 2
VAR seen 1
        MOV @DRIVE_N 6
        MOV @DRIVE EAST
look:   CALL SCAN NORTH
        JNE @RADAR_HIT SAMPLE more
        LOG T_SAMPLE @X
        LDB r0 [seen]
        ADD r0 1
        STB [seen] r0
more:   JNE @DRIVE 0 look
        WAIT @DRIVE
        LDB r0 [seen]
        RET`;
    const fw = 'MOV @SLICE 0\nCALL PROGRAM\nMOV r0 @PROG_RESULT\nCALL SLEEP 1000';
    const { e, u } = rover(fw, prog);
    for (const x of [2, 4]) e.world.setTile(x, 1, Layer.ITEM, T.SAMPLE);
    until(e, () => u.progState === ProgState.PROG_DONE, 200);
    run(e, 1);
    expect(u.x).toBe(6);
    expect(u.progResult).toBeGreaterThanOrEqual(2); // seen from each tile it passed (a tile can be counted twice)
    expect(u.vm.regs[0]).toBe(u.progResult);
    expect(u.ram[0]).toBe(u.progResult);
  });

  it('each slot has its own timer; it keeps counting while the program is suspended', () => {
    const fw = 'MOV @TIMER 7\nloop: CALL RUN 2\nJEQ @PROG_STATE PROG_READY loop\nMOV r0 @TIMER\nCALL SLEEP 1000';
    const { e, u } = rover(fw, 'MOV @TIMER 20\nWAIT @TIMER\nEND 1');
    run(e, 3);
    expect(u.prog.timer).toBeGreaterThan(0);
    expect(u.vm.timer).toBeGreaterThan(0);
    expect(u.prog.timer).not.toBe(u.vm.timer);
    until(e, () => u.progState === ProgState.PROG_DONE, 40);
  });

  it('a hard reboot resets latched arguments, results and running devices; the photo stays (non-volatile)', () => {
    const { e, u } = rover('MOV @DRIVE_N 9\nMOV @CAM_MODE 2\nMOV @REPAIR_SYS SYS_ANTENNA\nMOV @TOOL_ARG 3\nMOV @SLICE 77\nMOV @DRIVE EAST\nMOV @RADAR NORTH\nCALL SLEEP 1000');
    run(e, 1);
    expect([u.driveN, u.camMode, u.repairSys, u.toolArg, u.sliceSet, u.radarTicks]).toEqual([9, 2, 2, 3, 77, 1]);
    e.upload(u, 'CALL SLEEP 1000', factory);
    expect([u.driveN, u.camMode, u.repairSys, u.toolArg, u.sliceSet, u.radarTicks, u.action]).toEqual([1, 1, 0, 0, 0, 0, null]);
  });
});

describe('save v18 (M14 devices)', () => {
  it('round-trips a rover in the middle of a drive, a radar sweep, an image send and a timer', () => {
    const fw = 'CONST T 3\nloop: MOV @TIMER 3\nMOV @DRIVE_N 4\nMOV @DRIVE EAST\nsweep: MOV @RADAR NORTH\nWAIT @RADAR\nLOG T @RADAR_HIT\nJNE @DRIVE 0 sweep\nWAIT @TIMER\nMOV @SEND 1\nMOV @DRIVE_N 4\nMOV @DRIVE WEST\nWAIT @DRIVE\nJMP loop';
    const make = () => rover(fw, undefined, 9).e;
    const a = make();
    run(a, 300);
    for (const at of [5, 13, 41]) {
      const b0 = make();
      run(b0, at);
      const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
      run(b, 300 - at);
      expect(serialize(b), `saved at ${at}`).toEqual(serialize(a));
    }
  });

  it('migrates v17 saves: rewrites the hardware instructions, renames clashing names, reboots changed rovers', () => {
    const { e } = rover('CALL SLEEP 10');
    const v17 = serialize(e) as unknown as Record<string, any>;
    v17.version = 17;
    const u = v17.units[0];
    delete u.devices;
    delete u.vm.timer;
    delete u.program.vm.timer;
    u.action = { kind: 'WAIT', ticksLeft: 5 };
    u.sourceCode = 'step: SCAN EAST -> r0 r1 ; look\n  PEEK 2 -> r2\n  MOV @TX_DATA r0\nwait: STEP NORTH\n  JMP step\n  JMP wait\n  SLEEP 4';
    const l = deserialize(v17);
    const lu = l.units[0];
    expect(lu.sourceCode).toBe(
      'step_: CALL SCAN EAST    ; look\n       MOV r0 @RADAR_HIT\n       MOV r1 @RADAR_DIST\n  LDB r2 [CARGO+2]\n  LOG 0 r0\nwait_: CALL STEP NORTH 1\n  JMP step_\n  JMP wait_\n  CALL SLEEP 4',
    );
    expect(lu.action).toBeNull();
    expect(lu.vm.state).toBe(CpuState.RUNNING);
    const boot = lu.link.fifo.map((f) => decodeFrame(f.bytes)).filter((d) => d.kind === 0 && d.tag === 15).at(-1); // after the upload's boot frame
    expect(boot).toMatchObject({ value: BootReason.UPDATE });
    expect(SAVE_VERSION).toBe(18);
  });
});

describe('migrateHardwareOps (docs/ASSEMBLER_CORE.md §10)', () => {
  it('rewrites every retired instruction, keeping labels and the comment column', () => {
    const src = [
      'loop:   SLEEP 20              ; nap',
      '        STEP dir',
      '        STEP dir 3',
      '        ACT TOOL_0',
      '        ACT TOOL_2 slot',
      '        USE 1',
      '        USE 1 SYS_SOLAR',
      '        SNAP NORTH',
      '        SNAP NORTH 2',
      '        SEND',
      '        SEND 2',
      '        ERASE',
      '        RUN SLICE',
      '        MOV @TX_DATA 5',
      '        MOV @TX_DATA r0, r1',
    ].join('\n');
    expect(migrateHardwareOps(src).split('\n')).toEqual([
      'loop:   CALL SLEEP 20         ; nap',
      '        CALL STEP dir 1',
      '        CALL STEP dir 3',
      '        CALL ACT TOOL_0 0',
      '        CALL ACT TOOL_2 slot',
      '        CALL USE 1 SYS_HULL',
      '        CALL USE 1 SYS_SOLAR',
      '        CALL SNAP NORTH 1',
      '        CALL SNAP NORTH 2',
      '        CALL SEND 0',
      '        CALL SEND 2',
      '        CALL ERASE',
      '        CALL RUN SLICE',
      '        LOG 0 5',
      '        MOV @TX_DATA r0, r1', // not the old shorthand: left for the compiler to report
    ]);
    expect(migrateHardwareOps('; SLEEP in a comment\nCONST STEP_TICKS 5\nADD r0 STEP_TICKS')).toBe('; SLEEP in a comment\nCONST STEP_TICKS 5\nADD r0 STEP_TICKS');
  });

  it('every rewritten template still compiles (the shipped code went through it)', () => {
    const old = 'ALIAS r0 dir\nloop: SCAN dir -> r1 r2\nJEQ r1 NONE go\nADD dir 1\nMOD dir 4\nJMP loop\ngo: STEP dir\nJMP loop';
    expect(c(migrateHardwareOps(old), 'program').errors).toEqual([]);
    expect(BALANCE.uploadPerByte).toBe(6);
  });
});
