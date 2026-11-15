import { describe, expect, it } from 'vitest';
import { PDP11 } from '../src/core/balance';
import { ROM, ROM_ENTRY, ROM_EXPORTS, ROM_ROUTINES } from '../src/core/machine/rom';
import { isDecName, predefinedSymbols } from '../src/core/machine/symbols';
import { IMG_CHUNK, MsgType } from '../src/core/messages';
import { PHOTO_FORMATS_2X, photoBytes } from '../src/core/photos';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, Status } from '../src/core/types';
import { BootReason, Level } from '../src/core/downlink';
import type { Unit } from '../src/core/Unit';
import { createDefaultRegistry, T } from '../src/core/WorldRegistry';

const factory = { factory: true };

function flat(e: SimulationEngine, r = 12): void {
  for (let x = -r; x <= r; x++)
    for (let y = -r; y <= r; y++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
}

function rover(firmware: string, program?: string, setup?: (u: Unit, e: SimulationEngine) => void, seed = 5): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed, cpu: 'pdp11' });
  const u = e.spawnUnit('t');
  flat(e);
  setup?.(u, e);
  if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  return { e, u };
}
const run = (e: SimulationEngine, n: number, link = false) => {
  for (let i = 0; i < n; i++) {
    if (link) for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
};
const regs = (u: Unit) => u.machine!.registers('firmware').r;
const HANG = '\n9$:     WAIT\n        BR   9$';
/** Firmware: call a routine with R0/R1/R2, keep R0 in R3, R1 in R4, the PSW's NZVC in R5. */
const call = (name: string, r0: string, r1 = '0', r2 = '0') => `
START:  MOV  #${r0}, R0
        MOV  #${r1}, R1
        MOV  #${r2}, R2
        JSR  PC, ${name}
        MOV  @#PSW, R5
        MOV  R0, R3
        MOV  R1, R4
        BIC  #177760, R5${HANG}`;
const result = (name: string, r0: string, r1 = '0', r2 = '0', ticks = 8) => {
  const { e, u } = rover(call(name, r0, r1, r2));
  run(e, 3 + ticks);
  const r = regs(u);
  return { r0: r[3], r1: r[4], r2: r[2], nzvc: r[5], e, u };
};

describe('ROM (PDP11_CPU.md §10)', () => {
  it('assembles into the ROM window and exports every routine as a DEC name', () => {
    expect(ROM.ok).toBe(true);
    expect(ROM.bytes.length).toBeLessThanOrEqual(0o10000); // 160000-167777
    for (const n of ROM_ROUTINES) {
      expect(isDecName(n)).toBe(true);
      expect(ROM_EXPORTS[n]).toBeGreaterThanOrEqual(PDP11.romBase);
    }
    const syms = predefinedSymbols(createDefaultRegistry());
    expect(syms.STEP).toBe(ROM_EXPORTS.STEP);
    expect(Object.keys(syms).filter((k) => !isDecName(k))).toEqual([]);
  });

  it('routine names are reserved: a label STEP is an error', () => {
    const e = new SimulationEngine({ seed: 1, cpu: 'pdp11' });
    const u = e.spawnUnit('t');
    expect(e.assembleFor(u, 'STEP:   HALT', 'program').errors.length).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('MUL16: low 16 bits, R2 kept', () => {
    expect(result('MUL16', '300.', '7.', '1234')).toMatchObject({ r0: 2100, r2: 0o1234 });
    expect(result('MUL16', '-3', '5').r0).toBe(0x10000 - 15);
    expect(result('MUL16', '0', '5').nzvc & 4).toBe(4); // Z from the result
  });

  it('DIV16: quotient, remainder, C on divide by zero', () => {
    expect(result('DIV16', '1000.', '7.')).toMatchObject({ r0: 142, r1: 6 });
    expect(result('DIV16', '177777', '2').r0).toBe(0x7fff); // unsigned
    const z = result('DIV16', '12.', '0');
    expect(z.nzvc & 1).toBe(1);
    expect(z.r0).toBe(12);
  });

  it('ABS and DIRTO', () => {
    expect(result('ABS', '-42.').r0).toBe(42);
    expect(result('ABS', '42.').r0).toBe(42);
    expect(result('DIRTO', '5', '-2').r0).toBe(1); // EAST
    expect(result('DIRTO', '-5', '2').r0).toBe(3); // WEST
    expect(result('DIRTO', '1', '-4').r0).toBe(2); // SOUTH
    expect(result('DIRTO', '0', '3').r0).toBe(0); // NORTH
    const there = result('DIRTO', '0', '0');
    expect(there.r0).toBe(0xffff);
    expect(there.nzvc & 8).toBe(8);
  });

  it('PLOT: one pixel of a 64x64 2-bpp picture, little rows of 16 bytes', () => {
    const p = result('PLOT', '5', '2', '3');
    expect(p.r0).toBe(Status.OK);
    expect(p.r2).toBe(3); // kept
    const img = p.u.imageMemory();
    expect(img.length).toBe(1024); // Mk-I: modes 1 and 2, 64x64 at 2 bpp
    expect(img[2 * 16 + 1]).toBe(0b00110000); // x = 5: byte 1, second pixel from the left
    expect(result('PLOT', '64.', '0', '3').r0).toBe(Status.ERR_INVALID);
    expect(result('PLOT', '-1', '0', '3').r0).toBe(Status.ERR_INVALID);
  });
});

describe('drivers', () => {
  it('STEP drives and returns OK; blocked returns E.BLK with Z clear', () => {
    const ok = result('STEP', 'EAST', '3', '0', 30);
    expect([ok.r0, ok.u.x]).toEqual([Status.OK, 3]);
    expect(ok.nzvc & 4).toBe(4);
    const { e, u } = rover(call('STEP', 'NORTH', '2'), undefined, (_u, e) => e.world.setTile(0, 1, Layer.OBSTACLE, T.CLIFF_WALL));
    run(e, 6);
    expect(regs(u)[3]).toBe(Status.ERR_BLOCKED);
    expect(regs(u)[5] & 4).toBe(0);
  });

  it('SCAN leaves RADHIT / RADDST; ACT drills with F.T0; USE repairs with F.HULL', () => {
    const fw = `
START:  MOV  #EAST, R0
        JSR  PC, SCAN
        MOV  @#RADHIT, R3
        MOV  #EAST, R0          ; drill the ore: R0 = direction, R1 = hardpoint
        MOV  #F.T0, R1
        JSR  PC, ACT
        MOV  R0, R4
        CLR  R0                 ; repair the hull from slot 0
        MOV  #F.HULL, R1
        JSR  PC, USE
        MOV  R0, R5${HANG}`;
    const { e, u } = rover(fw, undefined, (r, e) => {
      e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE);
      r.hull = 50;
    });
    run(e, 40);
    expect(regs(u).slice(3, 6)).toEqual([T.IRON_ORE, Status.OK, Status.OK]);
    expect(u.hull).toBeGreaterThan(50);
  });

  it('SLEEP waits R0 ticks', () => {
    const fw = `START:  MOV @#TICKL, R3\n        MOV #20., R0\n        JSR PC, SLEEP\n        MOV @#TICKL, R4${HANG}`;
    const { e, u } = rover(fw);
    run(e, 30);
    expect(regs(u)[4] - regs(u)[3]).toBe(20);
  });

  it('RUN runs the program and returns its state', () => {
    const fw = `START:  MOV #0, R0\n        JSR PC, RUN\n        MOV R0, R3\n        MOV @#PRGRES, R4${HANG}`;
    const { e, u } = rover(fw, 'START:  MOV #5, R0\n        JSR PC, MUL16\n        HALT'.replace('MOV #5, R0', 'MOV #6, R0\n        MOV #7, R1'));
    run(e, 6);
    expect(regs(u).slice(3, 5)).toEqual([3, 42]); // P.DONE, 6 x 7: programs call the ROM too
  });

  it('LOG and PUTMSG: whole messages on the TX stream, E.FULL when there is no room', () => {
    const fw = `
START:  MOV  #2, R0
        MOV  #-5, R1
        JSR  PC, LOG
        MOV  #T.TEXT, R0
        MOV  #TXT, R1
        MOV  #TXTEND-TXT, R2
        JSR  PC, PUTMSG
        MOV  #77., R2           ; 81 bytes: more than the 64-byte FIFO
        JSR  PC, PUTMSG
        MOV  R0, R3${HANG}
TXT:    .ASCII /HELLO/
TXTEND:`;
    const { e, u } = rover(fw);
    run(e, 60, true);
    expect(regs(u)[3]).toBe(Status.ERR_FULL);
    const ok = e.messages.filter((m) => m.status === 'ok');
    expect(ok.map((m) => m.type)).toEqual([MsgType.LOG, MsgType.TEXT]);
    expect(ok[0].body).toEqual([2, 0xfb, 0xff]); // tag, value low byte first
    expect(String.fromCharCode(...ok[1].body)).toBe('HELLO');
  });

  it('SEND stores a message in the recorder; it reaches ground on the recorder channel', () => {
    const fw = `START:  MOV #T.DATA, R0\n        MOV #D, R1\n        MOV #3, R2\n        JSR PC, SEND\n        MOV @#RECFRE, R3${HANG}\nD:      .BYTE 1, 2, 3`;
    const { e, u } = rover(fw);
    run(e, 8);
    expect(regs(u)[3]).toBe(u.recorderBytes - 7);
    expect(u.recorderBytes).toBe(2048); // Mk-I 1 KB x PDP11.recorderScale
    run(e, 20, true);
    expect(e.messages).toMatchObject([{ channel: 'rec', type: MsgType.DATA, body: [1, 2, 3], status: 'ok' }]);
  });
});

describe('photos: SNAP, SNDIMG, ERASE (PDP11_CPU.md §6.3, PDP11_IO.md §3.5a)', () => {
  const snapSend = (edit = '') => `
START:  MOV  #NORTH, R0
        MOV  #F.M1, R1
        JSR  PC, SNAP
        MOV  R0, R3
${edit}
        CLR  R0                 ; the last photo's mode
        JSR  PC, SNDIMG
        MOV  R0, R4${HANG}`;
  const lit = (u: Unit, e: SimulationEngine) => {
    e.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL);
    u.headlight = 1;
    u.heading = 0;
  };

  it('a 64x64 photo goes home in 128-byte chunks and becomes a raw gallery photo with credits', () => {
    const { e, u } = rover(snapSend(), undefined, lit);
    run(e, 60);
    expect(u.results.cam).toBe(Status.OK);
    expect(u.imgCaps).toHaveLength(1); // the recorder paired the header with the capture
    expect(u.capture).toBeNull();
    const credits = e.credits;
    run(e, 900, true);
    expect(regs(u).slice(3, 5)).toEqual([Status.OK, Status.OK]);
    const chunks = e.messages.filter((m) => m.channel === 'rec' && m.type === MsgType.IMG);
    expect(chunks).toHaveLength(photoBytes(1, PHOTO_FORMATS_2X) / IMG_CHUNK);
    expect(chunks.every((m) => m.status === 'ok' && m.body.length === IMG_CHUNK + 3)).toBe(true);
    expect(e.gallery).toHaveLength(1);
    expect(e.gallery[0]).toMatchObject({ type: 1, subject: T.CLIFF_WALL, x2: true, lit: true });
    expect(e.gallery[0].level).toBeUndefined(); // raw
    expect(e.credits).toBeGreaterThan(credits);
  });

  it('an edited photo arrives EDITED with its bytes; ERASE then SNDIMG is DRAWN', () => {
    const { e } = rover(snapSend('        MOV  #-1, @#IMGBAS      ; a white mark in the corner'), undefined, lit);
    run(e, 900, true);
    expect(e.gallery[0]).toMatchObject({ level: Level.EDITED });
    expect(e.gallery[0].data!.slice(0, 4)).toBe('ffff');
    const d = rover(`START:  JSR PC, ERASE\n        MOV #1, R0\n        JSR PC, SNDIMG${HANG}`);
    run(d.e, 900, true);
    expect(d.e.gallery[0]).toMatchObject({ level: Level.DRAWN, credits: 0 });
  });

  it('SNDIMG refuses a type the camera has no memory for', () => {
    expect(result('SNDIMG', '4').r0).toBe(Status.ERR_INVALID); // 128x128 needs 4 KB
    expect(result('SNDIMG', '6').r0).toBe(Status.ERR_INVALID);
  });

  it('a reboot in the middle of a photo: ground drops it (no gallery entry)', () => {
    const small = (r: Unit, e: SimulationEngine) => {
      lit(r, e);
      r.chassis.recorderBytes = 512; // x 2 = 1 KB: the recorder fills after 7 of the 8 chunks
    };
    const { e, u } = rover(snapSend(), undefined, small);
    run(e, 200); // no link
    expect(u.link.recFree(u.recorderBytes)).toBeLessThan(IMG_CHUNK + 7);
    e.upload(u, `START:${HANG}`, factory);
    run(e, 900, true);
    expect(e.messages.filter((m) => m.channel === 'rec' && m.status === 'ok')).toHaveLength(7);
    expect(e.gallery).toHaveLength(0);
    expect(e.photoAsm.size).toBe(0);
  });

  it('a reboot while a chunk is being written leaves that message incomplete', () => {
    const { e, u } = rover(snapSend(), undefined, lit);
    run(e, 22); // the first chunk is being written
    expect(u.link.rec.length).toBeGreaterThan(0);
    e.upload(u, `START:${HANG}`, factory);
    run(e, 200, true);
    expect(e.messages.map((m) => [m.channel, m.status])).toEqual([['rec', 'incomplete']]);
    expect(u.imgCaps).toEqual([]); // its header never completed: the capture was not taken
  });

  it('save in the middle of a photo, load, continue == uninterrupted', () => {
    const a = rover(snapSend(), undefined, lit).e;
    run(a, 700, true);
    const b0 = rover(snapSend(), undefined, lit).e;
    run(b0, 133, true);
    expect(b0.units[0].link.rec.length).toBeGreaterThan(0);
    expect(b0.photoAsm.size).toBe(1); // ground has part of it
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 567, true);
    expect(serialize(b)).toEqual(serialize(a));
    expect(b.gallery).toHaveLength(1);
  });
});

describe('safe mode (PDP11_CPU.md §10, from M14 §6.3)', () => {
  const CRASH = 'START:  MOV @#10000, R0'; // a bus error: the ROM reboots (reason: fault)

  it('three fault reboots within 500 ticks run the ROM\'s safe firmware until a new upload', () => {
    const { e, u } = rover(CRASH);
    run(e, 40, true);
    expect(u.safeMode).toBe(true);
    expect(u.machine!.cpu.r[7]).toBeGreaterThanOrEqual(ROM_ENTRY.SAFEFW);
    expect(u.vm.state).toBe(CpuState.RUNNING);
    run(e, 200, true);
    expect(u.faultBoots.length).toBe(PDP11.safeModeBoots); // no more crashes
    expect(u.indicators[0]).toBe(1); // red
    expect(u.solarOpen).toBe(1);
    const texts = e.messages.filter((m) => m.type === MsgType.TEXT).map((m) => String.fromCharCode(...m.body));
    expect(texts).toContain('SAFE MODE');
    expect(e.messages.some((m) => m.type === MsgType.LOG && m.body[0] === 1)).toBe(true); // heartbeat
    // a reboot long after the crashes keeps it (latched); a firmware upload ends it
    run(e, 600, true);
    (e as unknown as { hardReboot(u: Unit, r: number): void }).hardReboot(u, BootReason.ADMIN);
    expect(u.faultBoots).toEqual([]);
    run(e, 10, true);
    expect(u.safeMode).toBe(true);
    e.upload(u, `START:  MOV #GREEN, @#IND1${HANG}`, factory);
    run(e, 10);
    expect([u.safeMode, u.indicators[0]]).toEqual([false, 2]);
  });

  it('fault reboots spread over more than 500 ticks do not', () => {
    const { e, u } = rover(`START:  MOV #300., R0\n        JSR PC, SLEEP\n        MOV @#10000, R0`);
    run(e, 900);
    expect(u.faultBoots.length).toBeLessThan(PDP11.safeModeBoots);
    expect(u.safeMode).toBe(false);
    expect(u.bootReason).toBe(BootReason.FAULT);
  });
});
