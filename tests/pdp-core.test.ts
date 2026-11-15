import { describe, expect, it } from 'vitest';
import { BALANCE, PDP11 } from '../src/core/balance';
import { BootReason, decodeFrame } from '../src/core/downlink';
import { IO_REGISTERS, ProgFault, Why } from '../src/core/machine/iopage';
import { ROM, ROM_ENTRY } from '../src/core/machine/rom';
import { isDecName, predefinedSymbols } from '../src/core/machine/symbols';
import { MsgType, parseStream, freshParser } from '../src/core/messages';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, ProgState, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { createDefaultRegistry, T } from '../src/core/WorldRegistry';

const factory = { factory: true };

/** Clear terrain around the origin: flat sand, nothing in the way. */
function flat(e: SimulationEngine, r = 12): void {
  for (let x = -r; x <= r; x++)
    for (let y = -r; y <= r; y++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
}

function rover(firmware: string, program?: string, seed = 3, setup?: (u: Unit) => void): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed, cpu: 'pdp11' });
  const u = e.spawnUnit('t');
  flat(e);
  setup?.(u);
  if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  booted(e, u);
  return { e, u };
}

/** Run ticks until the boot ROM has handed over to the firmware; returns how many. */
function booted(e: SimulationEngine, u: Unit): number {
  for (let t = 1; t <= 20; t++) {
    e.advanceTick();
    if (u.machine!.cpu.r[7] < PDP11.romBase || u.vm.state !== CpuState.RUNNING) return t;
  }
  throw new Error('never booted');
}
const run = (e: SimulationEngine, n: number, link = false) => {
  for (let i = 0; i < n; i++) {
    if (link) for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
};
const fwRegs = (u: Unit) => u.machine!.registers('firmware').r;
const peek = (u: Unit, addr: number) => u.machine!.read(addr, false);
const label = (e: SimulationEngine, u: Unit, src: string, name: string, slot: 'firmware' | 'program' = 'firmware') => e.assembleFor(u, src, slot).asm.symbols.get(name)!;

/** Firmware: run the program again and again (whatever ends it), counting runs in R5. */
/** Firmware: try the gate every tick (refused while the program is not ready). */
const POLL = 'START:\n1$:     MOV #GO, @#PRGCS\n        WAIT\n        BR 1$';

const RUN_LOOP = `
START:  CLR  R5
1$:     INC  R5
        MOV  #GO, @#PRGCS       ; the gate
        MOV  @#PRGST, R3
        CMP  R3, #P.RDY
        BEQ  1$                 ; time up or preempted: again
2$:     WAIT
        BR   2$
`;
const withSlice = (n: number) => RUN_LOOP.replace('START:  CLR  R5', `START:  MOV  #${n}., @#SLICE\n        CLR  R5`);

describe('M15 names (PDP11_IO.md §10)', () => {
  it('every predefined symbol is a DEC name of at most six characters', () => {
    const syms = predefinedSymbols(createDefaultRegistry());
    const bad = Object.keys(syms).filter((k) => !isDecName(k));
    expect(bad).toEqual([]);
    for (const r of IO_REGISTERS) expect(syms[r.name]).toBe(r.addr);
    expect(syms['E.BUSY']).toBe(Status.ERR_BUSY);
    expect(syms.IRON).toBe(T.IRON_ORE);
    expect(syms['F.M3']).toBe(0o6);
  });

  it('tiles have unique short names', () => {
    const tiles = createDefaultRegistry().all();
    expect(new Set(tiles.map((t) => t.shortName)).size).toBe(tiles.length);
  });

  it('register addresses are even, unique, in the I/O page', () => {
    const addrs = IO_REGISTERS.map((r) => r.addr);
    expect(new Set(addrs).size).toBe(addrs.length);
    for (const a of addrs) expect(a % 2 === 0 && a >= PDP11.ioBase).toBe(true);
  });
});

describe('boot ROM (PDP11_CPU.md §10)', () => {
  it('assembles at 160000 and boots the firmware at 000200 with R0 = top of core', () => {
    expect(ROM.ok).toBe(true);
    expect(ROM_ENTRY.BOOT).toBe(PDP11.romBase);
    const e0 = new SimulationEngine({ seed: 1, cpu: 'pdp11' });
    const u0 = e0.spawnUnit('t');
    e0.upload(u0, 'START:  HALT', factory);
    expect(booted(e0, u0)).toBeLessThanOrEqual(5); // a few ticks of boot time
    const { e, u } = rover('START:  MOV R0, R4\n        MOV SP, R3\n1$:     WAIT\n        BR 1$');
    run(e, 2);
    expect(fwRegs(u)[4]).toBe(PDP11.coreBytes); // the probe found 2 KB
    expect(fwRegs(u)[3]).toBe(PDP11.programBase); // the firmware stack starts below the program
    expect(peek(u, 0o4)).toBeGreaterThanOrEqual(PDP11.romBase); // vectors filled
    expect(peek(u, 0o177546) & 0o100).toBe(0o100); // line clock IE on
    expect(u.machine!.cpu.priority).toBe(0);
  });

  it('a firmware bus error makes the ROM reboot the rover (boot reason: fault)', () => {
    const e = new SimulationEngine({ seed: 3, cpu: 'pdp11' });
    const u = e.spawnUnit('t');
    const logs: string[] = [];
    e.events.on('LOG', (l) => logs.push(l.message));
    e.upload(u, 'START:  MOV @#10000, R0\n1$:     WAIT\n        BR 1$', factory);
    u.link.fifo = [];
    run(e, 6);
    expect(u.link.fifo.map((f) => decodeFrame(f.bytes).value)).toContain(BootReason.FAULT);
    expect(logs.some((m) => m.includes('no memory there 010000 at 000200'))).toBe(true);
  });

  it('BPT in the firmware halts the CPU; Continue resumes after it', () => {
    const { e, u } = rover('START:  BPT\n        MOV #GREEN, @#IND1\n1$:     WAIT\n        BR 1$');
    run(e, 2);
    expect(u.vm.state).toBe(CpuState.HALTED);
    expect(u.indicators[0]).toBe(0);
    expect(e.command(u, 'CONTINUE')).toBeNull();
    run(e, 2);
    expect(u.vm.state).toBe(CpuState.RUNNING);
    expect(u.indicators[0]).toBe(2);
  });

  it('firmware too big for its region or not starting at 000200 is refused', () => {
    const e = new SimulationEngine({ seed: 1, cpu: 'pdp11' });
    const u = e.spawnUnit('t');
    expect(e.upload(u, `. = . + 2000\n HALT`, factory).errors[0].message).toMatch(/must end below 002000/);
    expect(e.upload(u, `D1: .WORD 0\nS: HALT\n.END S`, factory).errors[0].message).toMatch(/first word/);
    expect(e.upload(u, `MOV #TOOLONG, R0`, factory).errors[0].message).toMatch(/6 characters/);
  });
});

describe('device registers (PDP11_IO.md §3)', () => {
  it('drive: DRVCNT counts down, DONE / ERR / DRVER after it', () => {
    const fw = `
START:  MOV  #3, @#DRVCNT
        MOV  #EAST, @#DRVDIR
        MOV  #GO, @#DRVCS
1$:     WAIT
        TSTB @#DRVCS            ; DONE?
        BPL  1$
        MOV  @#DRVCS, R1
        MOV  @#DRVER, R2
2$:     WAIT
        BR   2$`;
    const { e, u } = rover(fw);
    run(e, 2);
    expect(u.action?.kind).toBe('STEP');
    expect(peek(u, 0o176406)).toBe(3);
    expect(peek(u, 0o176400) & 0o200).toBe(0); // working
    run(e, 30);
    expect(u.x).toBe(3);
    expect(fwRegs(u)[1]).toBe(0o200); // DONE, no ERR
    expect(fwRegs(u)[2]).toBe(Status.OK);
    expect(peek(u, 0o176406)).toBe(0); // reads 0 after the drive
  });

  it('a refused start sets ERR and the reason in the same instruction', () => {
    const fw = `
START:  MOV  #GO, @#DRVCS       ; DRVCNT is 0: invalid
        MOV  @#DRVCS, R1
        MOV  @#DRVER, R2
        MOV  #1, @#SOLOPN       ; array open...
        MOV  #2, @#DRVCNT
        MOV  #GO, @#DRVCS
        MOV  @#DRVER, R3
1$:     WAIT
        BR   1$`;
    const { e, u } = rover(fw);
    run(e, 2);
    expect(fwRegs(u)[1]).toBe(0o100200); // ERR + DONE
    expect(fwRegs(u)[2]).toBe(Status.ERR_INVALID);
    expect(fwRegs(u)[3]).toBe(Status.ERR_DEPLOYED);
  });

  it('a firmware interrupt handler on the drive vector (PDP11_IO.md §7.3)', () => {
    const fw = (dir: string) => `
START:  MOV  #DRVINT, @#120
        MOV  #200, @#122
        MOV  #2, @#DRVCNT
        MOV  #${dir}, @#DRVDIR
        MOV  #IE!GO, @#DRVCS    ; IE with GO: IE alone while DONE would interrupt at once
1$:     WAIT
        BR   1$
DRVINT: MOV  #GREEN, @#IND3
        TST  @#DRVCS            ; ERR?
        BPL  2$
        MOV  #RED, @#IND3
2$:     RTI`;
    const ok = rover(fw('EAST'));
    run(ok.e, 1);
    expect(ok.u.indicators[2]).toBe(0); // still driving
    run(ok.e, 20);
    expect(ok.u.x).toBe(2);
    expect(ok.u.indicators[2]).toBe(2);
    const blocked = rover(fw('NORTH'));
    blocked.e.world.setTile(0, 1, Layer.OBSTACLE, T.CLIFF_WALL);
    run(blocked.e, 3);
    expect(blocked.u.indicators[2]).toBe(1); // refused at once: the handler saw ERR
  });

  it('radar, tools with a function code, cargo bytes, the tick counter', () => {
    const fw = `
START:  MOV  #EAST, @#RADDIR
        MOV  #GO, @#RADCS
1$:     WAIT
        TSTB @#RADCS
        BPL  1$
        MOV  @#RADHIT, R1
        MOV  @#RADDST, R2
        MOV  #EAST, @#TOLARG    ; drill the ore
        MOV  #F.T0!GO, @#TOLCS
2$:     WAIT
        TSTB @#TOLCS
        BPL  2$
        MOV  @#TOLER, R3
        MOVB @#CARGO, R4
3$:     WAIT
        BR   3$`;
    const { e, u } = rover(fw);
    e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE);
    run(e, 40);
    const r = fwRegs(u);
    expect([r[1], r[2], r[3], r[4]]).toEqual([T.IRON_ORE, 1, Status.OK, T.IRON_ORE]);
    expect(peek(u, 0o176014)).toBe(e.tick & 0xffff);
    expect(peek(u, 0o176016)).toBe(0);
  });
});

describe('the gate (PDP11_CPU.md §7)', () => {
  it('HALT ends the program with R0 as its result', () => {
    const { e, u } = rover(RUN_LOOP, 'START:  MOV #42., R0\n        HALT');
    run(e, 2);
    expect(u.progState).toBe(ProgState.PROG_DONE);
    expect(u.progResult).toBe(42);
    expect(peek(u, 0o177006)).toBe(42);
    expect((peek(u, 0o177000) >> 1) & 7).toBe(Why.DONE);
    expect(fwRegs(u)[5]).toBe(1);
  });

  it('RTS PC from the top level ends it the same way (the ROM EXIT stub)', () => {
    const { e, u } = rover(RUN_LOOP, 'START:  MOV #7, R0\n        RTS PC');
    run(e, 2);
    expect(u.progState).toBe(ProgState.PROG_DONE);
    expect(u.progResult).toBe(7);
  });

  it('SLICE: time up returns to the firmware, the next gate resumes where it was', () => {
    const { e, u } = rover(withSlice(2), 'START:  CLR R1\n1$:     INC R1\n        BR 1$');
    run(e, 3);
    expect((peek(u, 0o177000) >> 1) & 7).toBe(Why.TIME);
    run(e, 10);
    expect(fwRegs(u)[5]).toBeGreaterThan(3);
    const r1 = u.machine!.registers('program').r[1];
    run(e, 4);
    expect(u.machine!.registers('program').r[1]).toBeGreaterThan(r1); // kept counting, never restarted
  });

  it('the gate is refused when the program is not ready', () => {
    const { e, u } = rover('START:  MOV #GO, @#PRGCS\n        MOV @#PRGCS, R1\n1$:     WAIT\n        BR 1$');
    run(e, 2);
    expect(fwRegs(u)[1] & 0o100000).toBe(0o100000);
  });

  const faultOf = (prog: string) => {
    const { e, u } = rover(RUN_LOOP, prog);
    run(e, 3);
    return { state: u.progState, code: peek(u, 0o177002), pc: peek(u, 0o177010), u, e };
  };

  it('protection: the program can write only its own region, image memory and open registers', () => {
    expect(faultOf('START:  MOV #1, @#200\n        HALT')).toMatchObject({ state: ProgState.PROG_FAULT, code: ProgFault.PRO, pc: PDP11.programBase });
    expect(faultOf('START:  MOV #GO, @#PRGCS\n        HALT').code).toBe(ProgFault.PRO);
    expect(faultOf('START:  CLR @#PSW\n        HALT').code).toBe(ProgFault.PRO);
    expect(faultOf('START:  MOV #1, @#160000\n        HALT').code).toBe(ProgFault.PRO);
    // RTI can't take the program into firmware mode (PDP-11/45 user-mode rules)
    expect(faultOf('START:  CLR -(SP)\n        MOV #1$, -(SP)\n        RTI\n1$:     MOV #1, @#200\n        HALT').code).toBe(ProgFault.PRO);
    const ok = faultOf('START:  MOV #GREEN, @#IND2\n        MOV #123, @#100000\n        MOV @#200, R0\n        HALT');
    expect(ok.state).toBe(ProgState.PROG_DONE);
    expect(ok.u.progResult).toBe(peek(ok.u, 0o200)); // reading the firmware is allowed
    expect(ok.u.indicators[1]).toBe(2);
    expect(ok.u.imgEdited).toBe(true);
  });

  it('faults: odd address, no memory, illegal instruction, stack overflow, with PRGPC', () => {
    expect(faultOf('START:  MOV @#2001, R0\n        HALT').code).toBe(ProgFault.ODD);
    expect(faultOf('START:  NOP\n        MOV @#10000, R0\n        HALT')).toMatchObject({ code: ProgFault.NXM, pc: PDP11.programBase + 2 });
    expect(faultOf('START:  MUL R0, R1\n        HALT').code).toBe(ProgFault.ILL); // no EIS board
    const { e, u } = rover(RUN_LOOP, 'START:\n1$:     MOV R0, -(SP)\n        BR 1$');
    run(e, 80);
    expect([u.progState, peek(u, 0o177002)]).toEqual([ProgState.PROG_FAULT, ProgFault.STK]);
  });

  it('BPT halts the program; Continue lets the next gate resume after it', () => {
    const { e, u } = rover(POLL, 'START:  BPT\n        MOV #5, R0\n        HALT');
    run(e, 2);
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    expect((peek(u, 0o177000) >> 1) & 7).toBe(Why.BPT);
    expect(e.command(u, 'CONTINUE', 'program')).toBeNull();
    expect(u.progState).toBe(ProgState.PROG_READY);
    run(e, 2);
    expect(u.progState).toBe(ProgState.PROG_DONE);
    expect(u.progResult).toBe(5);
  });

  it('Run again restarts from the top; memory keeps what the program changed', () => {
    const prog = 'START:  INC CNT\n        MOV CNT, R0\n        HALT\nCNT:    .WORD 0';
    const { e, u } = rover(POLL, prog);
    run(e, 2);
    expect(u.progResult).toBe(1);
    expect(e.command(u, 'RUN_AGAIN')).toBeNull();
    run(e, 2);
    expect(u.progResult).toBe(2); // like the Count with a variable lesson
    e.upload(u, POLL, factory); // hard reboot: images reloaded
    booted(e, u);
    run(e, 2);
    expect(u.progResult).toBe(1);
  });
});

describe('interrupts and system calls during the program (PDP11_CPU.md §7.3, §8)', () => {
  it('the clock handler runs in the firmware and returns; the program wakes every tick', () => {
    const fw = `
START:  MOV  #CLK, @#100
        MOV  #300, @#102
        MOV  #GO, @#PRGCS
1$:     WAIT
        BR   1$
CLK:    INC  CNT                ; firmware memory, firmware stack
        RTI
CNT:    .WORD 0`;
    const prog = 'START:  MOV #7, R3\n        CLR R2\n1$:     WAIT\n        INC R2\n        CMP R2, #5\n        BLT 1$\n        MOV R2, R0\n        ADD R3, R0\n        HALT';
    const { e, u } = rover(fw, prog);
    run(e, 8);
    expect(u.progState).toBe(ProgState.PROG_DONE);
    expect(u.progResult).toBe(12); // R2 counted to 5, R3 kept 7: the handler used no registers
    expect(peek(u, label(e, u, fw, 'CNT'))).toBeGreaterThanOrEqual(5);
    expect(fwRegs(u)[6]).toBe(PDP11.programBase); // the firmware's stack balanced
  });

  it('TRAP n is a system call: the firmware handler sees n and the program\'s R0', () => {
    const fw = `
START:  MOV  #SYSCAL, @#34
        MOV  #340, @#36
        MOV  #GO, @#PRGCS
1$:     WAIT
        BR   1$
SYSCAL: MOV  R1, -(SP)          ; handlers run on the program's R0-R5: save what you use
        MOV  2(SP), R1          ; the return address...
        MOVB -2(R1), R1         ; ...the TRAP's low byte is n
        ADD  R1, R0             ; the answer goes back in R0
        MOV  (SP)+, R1
        RTI`;
    const { e, u } = rover(fw, 'START:  MOV #11, R1\n        MOV #100, R0\n        TRAP 5\n        ADD R1, R0\n        HALT');
    run(e, 2);
    expect(u.progState).toBe(ProgState.PROG_DONE);
    expect(u.progResult).toBe(0o100 + 5 + 0o11);
  });

  it('TRAP without a handler is a program fault', () => {
    const { e, u } = rover(RUN_LOOP, 'START:  TRAP 1\n        HALT');
    run(e, 2);
    expect([u.progState, peek(u, 0o177002)]).toEqual([ProgState.PROG_FAULT, ProgFault.TRP]);
  });

  it('preemption ends the run at a tick start (PRMPTD, W.PRE)', () => {
    const fw = withSlice(0).replace('START:', 'START:  MOV #PR.BAT, @#PREMPT\n        MOV #101., @#BATALM\n').replace('BEQ  1$', 'BR   2$');
    const { e, u } = rover(fw, 'START:\n1$:     INC R1\n        BR 1$');
    run(e, 3);
    expect(u.progState).toBe(ProgState.PROG_READY);
    expect((peek(u, 0o177000) >> 1) & 7).toBe(Why.PRE);
    expect(peek(u, 0o177016)).toBe(4);
  });
});

describe('framed standard output (PDP11_IO.md §3.5a)', () => {
  const sender = (text: string, extra = '') => `
START:  MOV  #MSG, R1
        MOV  #MSGEND-MSG, R2
1$:     MOVB (R1)+, @#TXBUF
        SOB  R2, 1$
${extra}
2$:     WAIT
        BR   2$
MSG:    .BYTE SOH, T.TEXT, ${text.length}.
        .ASCII /${text}/
        .BYTE ETX
MSGEND:`;

  it('a text message reaches mission control whole', () => {
    const { e, u } = rover(sender('STUCK AT 12,-4'), undefined, 3, (r) => (r.antennaHealth = 0)); // no signal: the bytes wait
    run(e, 4); // 5 cycles a byte
    u.antennaHealth = 100;
    expect(peek(u, 0o176544)).toBe(PDP11.txFifoBytes - 18);
    run(e, 30, true);
    const ok = e.messages.filter((m) => m.status === 'ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ unitId: u.id, type: MsgType.TEXT });
    expect(String.fromCharCode(...ok[0].body)).toBe('STUCK AT 12,-4');
  });

  it('a full FIFO drops bytes (TXLOST): the message never completes', () => {
    const long = 'X'.repeat(70);
    const { e, u } = rover(sender(long), undefined, 3, (r) => (r.antennaHealth = 0));
    run(e, 10);
    u.antennaHealth = 100;
    expect(peek(u, 0o176546)).toBe(74 - PDP11.txFifoBytes);
    expect(peek(u, 0o176540) & 0o200).toBe(0); // not READY
    run(e, 60, true);
    expect(e.messages).toEqual([]); // 10 bytes short: ground still waits for the rest
    e.upload(u, POLL, factory); // a reboot ends it
    run(e, 5, true);
    expect(e.messages.map((m) => [m.status, m.body.length])).toEqual([['incomplete', 61]]);
  });

  it('a reboot leaves a message incomplete', () => {
    const st = freshParser();
    expect(parseStream(st, [1, 1, 3, 65, 66], 1, 0)).toEqual([]);
    expect(parseStream(st, [-1, 1, 1, 0, 3], 1, 5).map((m) => m.status)).toEqual(['incomplete', 'ok']);
    expect(parseStream(st, [9, 9, 1, 4, 1, 7, 2], 1, 6).map((m) => [m.status, m.type])).toEqual([['broken', null], ['broken', 4]]);
  });
});

describe('determinism and saves', () => {
  const FW = `
START:  MOV  #CLK, @#100
        MOV  #300, @#102
        MOV  #SYSCAL, @#34
        MOV  #340, @#36
        MOV  #3., @#SLICE
1$:     MOV  #GO, @#PRGCS
        MOV  @#PRGST, R3
        CMP  R3, #P.RDY
        BEQ  1$
        MOV  #P.RDY, @#PRGST    ; done or fault: start it again
        BR   1$
CLK:    INC  TICKS
        RTI
SYSCAL: MOVB @#TICKL, R0
        RTI
TICKS:  .WORD 0`;
  const PROG = `
START:  MOV  #4, @#DRVCNT
        MOV  R4, @#DRVDIR
        MOV  #GO, @#DRVCS
1$:     WAIT
        TRAP 0                  ; system call: R0 = the tick's low byte
        MOVB #SOH, @#TXBUF      ; a one-byte T.DATA message
        MOVB #T.DATA, @#TXBUF
        MOVB #1, @#TXBUF
        MOVB R0, @#TXBUF
        MOVB #ETX, @#TXBUF
        TSTB @#DRVCS
        BPL  1$
        INC  R4
        BIC  #177774, R4
        BR   START`;
  const make = () => rover(FW, PROG, 9).e;

  it('the same seed and inputs give the same run', () => {
    const a = make();
    const b = make();
    run(a, 300, true);
    run(b, 300, true);
    expect(serialize(a)).toEqual(serialize(b));
    expect(a.units[0].x !== 0 || a.units[0].y !== 0).toBe(true);
    expect(a.messages.length).toBeGreaterThan(0);
  });

  it('save mid-run, load, continue == uninterrupted run', () => {
    const a = make();
    run(a, 400, true);
    const b0 = make();
    run(b0, 137, true);
    expect(b0.units[0].slice).toBeGreaterThanOrEqual(0); // saved inside a program run
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    expect(b.pdp11).toBe(true);
    run(b, 263, true);
    expect(serialize(b)).toEqual(serialize(a));
  });

  it('save during a firmware handler in the program\'s time', () => {
    const b0 = make();
    const u0 = b0.units[0];
    for (let t = 0; t < 300 && u0.slice < 0; t++) run(b0, 1, true);
    // one instruction at a time until the clock handler runs in the program's time
    for (let i = 0; i < 200 && u0.machine!.context !== 'handler'; i++) b0.stepInstruction(u0);
    expect(u0.machine!.context).toBe('handler');
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    b.units[0].machine!.run(); // finish this tick in both, then run on
    u0.machine!.run();
    run(b, 200, true);
    run(b0, 200, true);
    expect(serialize(b)).toEqual(serialize(b0));
  });

  it('Rover-ASM engines are unchanged by the switch', () => {
    const e = new SimulationEngine({ seed: 1 });
    expect(e.pdp11).toBe(false);
    expect(e.spawnUnit('x').machine).toBeNull();
    expect(serialize(e).cpu).toBeUndefined();
    expect(BALANCE.watchdogTicks).toBeGreaterThan(0);
  });
});
