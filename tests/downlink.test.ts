import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { decodeFrame, Downlink, encodeCpuDump, encodeLog, hex, productFrameBytes, ProductType, SYSTEM_TAG } from '../src/core/downlink';
import { productFrame, spectrum } from '../src/core/imaging';
import { Status } from '../src/core/types';
import { T } from '../src/core/WorldRegistry';
import { deserialize, migrate, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import type { Unit } from '../src/core/Unit';
import { compile } from '../src/core/vm/Compiler';

const factory = { factory: true };

/** Keep the dish on the orbiter (signal = antennaHealth) before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

function rover(src: string, seed = 3): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  e.upload(u, src, factory);
  return { e, u };
}

describe('frame encoding (SPEC §3.8.2)', () => {
  it('matches the SPEC examples', () => {
    expect(hex(encodeLog(5, null))).toBe('28');
    expect(hex(encodeLog(5, 42))).toBe('2A 2A');
    expect(hex(encodeLog(5, -300))).toBe('2C FE D4');
    expect(encodeLog(1, 100000)).toHaveLength(5);
    expect(encodeLog(1, -128)).toHaveLength(2);
    expect(encodeLog(1, 128)).toHaveLength(3);
  });

  it('decodes what it encodes, signed', () => {
    for (const v of [0, 1, -1, 127, -128, 128, -129, 32767, -32768, 40000, -2147483648, 2147483647]) {
      expect(decodeFrame(encodeLog(9, v))).toEqual({ kind: 0, tag: 9, value: v });
    }
    expect(decodeFrame(encodeLog(3, null))).toEqual({ kind: 0, tag: 3, value: null });
  });
});

describe('LOG instruction', () => {
  it('compiles tags from numbers and CONSTs, sizes like immediates, builds a dictionary', () => {
    const r = compile('CONST T_BAT 5\nLOG T_BAT @BAT\nLOG 2\nLOG T_BAT r0', CHASSIS_MK1);
    expect(r.errors).toEqual([]);
    expect(r.lineBytes[2]).toBe(3); // opcode + tag + port
    expect(r.lineBytes[3]).toBe(2);
    expect(r.logTags[5]).toEqual({ names: ['T_BAT'], lines: [2, 4] });
    expect(r.logTags[2]).toEqual({ names: [], lines: [3] });
  });

  it('rejects tag 15, out-of-range and non-constant tags', () => {
    expect(compile('LOG 15', CHASSIS_MK1).errors[0].message).toMatch(/reserved/);
    expect(compile('LOG 16', CHASSIS_MK1).errors[0].message).toMatch(/0–14/);
    expect(compile('LOG r0', CHASSIS_MK1).errors[0].message).toMatch(/compile-time constant/);
    expect(compile('LOG @BAT', CHASSIS_MK1).errors.length).toBe(1);
  });

  it('is a 1-cycle compute instruction that does not touch @STATUS', () => {
    const { e, u } = rover('MOV r0 7\nLOG 1 r0\nLOG 2\nLOG 3\nWAIT @TICK');
    u.vm.status = 3;
    u.link.fifo = []; // drop the boot frame
    e.advanceTick();
    // MOV + 3 LOGs in one tick, then WAIT on a port that is never 0 (not a device: no @STATUS).
    expect(u.link.fifo.map((f) => hex(f.bytes))).toEqual(['0A 07', '10', '18']);
    expect(u.vm.status).toBe(3);
  });
});

describe('log FIFO and transmitter', () => {
  it('drops whole frames when full and counts them in @LOG_LOST', () => {
    const d = new Downlink();
    for (let i = 0; i < 10; i++) d.enqueue(encodeLog(1, 1000), 32); // 3 B each
    expect(d.fifo).toHaveLength(10);
    expect(d.used).toBe(30);
    expect(d.enqueue(encodeLog(1, 1000), 32)).toBe(false);
    expect(d.enqueue(encodeLog(1, 1), 32)).toBe(true); // 2 B still fits
    expect(d.lost).toBe(1);
    expect(d.fifo[10].gap).toBe(1);
    for (let i = 0; i < 300; i++) d.enqueue([0], 32);
    expect(d.lost).toBe(255); // saturates
  });

  it('sends 2 B/tick at full signal, proportionally less, nothing below 20', () => {
    const rate = (signal: number, ticks: number) => {
      const d = new Downlink();
      for (let i = 0; i < 16; i++) d.enqueue([1, 2], 64);
      let sent = 0;
      for (let t = 0; t < ticks; t++) sent += d.pump(signal, BALANCE.linkMinSignal, BALANCE.linkBytesPerTick).sent;
      return sent;
    };
    expect(rate(100, 10)).toBe(20);
    expect(rate(50, 10)).toBe(10);
    expect(rate(25, 10)).toBe(5);
    expect(rate(19, 100)).toBe(0);
  });

  it('a frame arrives when its last byte is sent; mission control decodes it', () => {
    const { e } = rover('CONST T 4\nloop: LOG T @TICK\nCALL SLEEP 1000');
    const got: number[] = [];
    e.events.on('DOWNLINK_FRAME', (f) => got.push(f.tick));
    run(e, 6);
    const frames = e.received.map((f) => decodeFrame(f.bytes));
    expect(frames[0]).toEqual({ kind: 0, tag: SYSTEM_TAG, value: 1 }); // boot frame: code upload
    expect(frames[1].tag).toBe(4);
    expect(frames[1].value).toBe(1); // logged on tick 1
    expect(got.length).toBe(2);
  });

  it('costs energy only in ticks that send bytes', () => {
    const { e, u } = rover('CALL SLEEP 100000');
    run(e, 1); // first tick sends the boot frame (2 B)
    const before = u.energy;
    run(e, 20); // idle link: only idle drain, no solar (array stowed)
    expect(before - u.energy).toBe(20 * BALANCE.idleDrainPerTick);
    u.link.enqueue([1, 2, 3, 4, 5, 6], 32);
    const b2 = u.energy;
    run(e, 3);
    expect(b2 - u.energy).toBe(3 * (BALANCE.idleDrainPerTick + BALANCE.linkEnergyPerTick));
  });

  it('keeps transmitting while the CPU is faulted, not while powered off', () => {
    const { e, u } = rover('POP r0');
    u.link.fifo = [];
    run(e, 1); // faults
    u.link.enqueue([1, 2], 32);
    run(e, 1);
    expect(u.link.fifo).toHaveLength(0);
    u.link.enqueue([1, 2], 32);
    u.energy = 0;
    run(e, 3);
    expect(u.powered).toBe(false);
    expect(u.link.fifo).toHaveLength(1);
  });

  it('queues a boot frame with the reason and resets @LOG_LOST on every hard reboot', () => {
    const { e, u } = rover('CALL SLEEP 1');
    u.link.lost = 9;
    e.upload(u, 'POP r0', factory);
    expect(u.link.lost).toBe(0);
    expect(decodeFrame(u.link.fifo.at(-1)!.bytes)).toEqual({ kind: 0, tag: 15, value: 1 });
    run(e, BALANCE.watchdogTicks + 2);
    expect(e.received.some((f) => hex(f.bytes) === '7A 02')).toBe(true); // watchdog
    e.admin.respawnAtOrigin(u);
    expect(hex(u.link.fifo.at(-1)!.bytes)).toBe('7A 04');
  });

  it('@LOG_FREE and @LOG_LOST ports', () => {
    const { e, u } = rover('LOG 1 100000\nLOG 1 100000\nLOG 1 100000\nLOG 1 100000\nMOV r0 @LOG_FREE\nMOV r1 @LOG_LOST\nMOV @LOG_LOST 0\nMOV r2 @LOG_LOST\nCALL SLEEP 1000');
    u.link.fifo = [];
    u.antennaHealth = 0; // no signal: nothing leaves the FIFO
    for (let i = 0; i < 3; i++) e.advanceTick();
    // Tick 1 runs the four LOGs (5 B each); tick 2 reads the ports.
    expect(u.vm.regs[0]).toBe(32 - 20);
    expect(u.vm.regs[1]).toBe(0);
    expect(u.vm.regs[2]).toBe(0);
  });
});

describe('downlink determinism and saves', () => {
  const SRC = 'CONST T_BAT 3\nloop: LOG T_BAT @BAT\nLOG 1 @TICK\nLOG 2 @LOG_LOST\nCALL SLEEP 2\nJMP loop';

  it('save mid-frame, load, continue == uninterrupted run', () => {
    const make = () => {
      const { e, u } = rover(SRC, 11);
      u.antennaHealth = 75; // 1.5 B/tick: frames straddle ticks
      return e;
    };
    const a = make();
    run(a, 300);
    const b0 = make();
    run(b0, 137);
    expect(b0.units[0].link.headSent + b0.units[0].link.acc).toBeGreaterThan(0); // mid-frame
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 163);
    expect(serialize(b)).toEqual(serialize(a));
    expect(a.received.length).toBeGreaterThan(50);
    expect(a.units[0].link.lost).toBeGreaterThan(0); // the loop outruns the link
  });

  it('migrates v3 saves to an empty link', () => {
    const { e } = rover('CALL SLEEP 10');
    const v3 = serialize(e) as unknown as Record<string, unknown>;
    v3.version = 3;
    delete v3.received;
    for (const u of v3.units as Record<string, unknown>[]) delete u.link;
    const m = migrate(v3);
    expect(m.received).toEqual([]);
    expect(deserialize(v3).units[0].link.fifo).toEqual([]);
  });
});

describe('console decoding', async () => {
  const { describeFrame, emptyDictionary, slotDictionary } = await import('../src/ui/comms');
  it('names tags from CONSTs and lines, decodes boot frames', () => {
    const d = { firmware: slotDictionary(compile('CONST T_BAT 5\nLOG T_BAT @BAT', CHASSIS_MK1)), program: emptyDictionary() };
    const f = (bytes: number[]) => describeFrame({ unitId: 1, tick: 1, bytes, gap: 0 }, d);
    expect(f(encodeLog(5, 812))).toBe('T_BAT = 812 (fw L2)');
    expect(f(encodeLog(3, -1))).toBe('tag 3 = -1');
    expect(f(encodeLog(3, null))).toBe('tag 3');
    expect(f(encodeLog(15, 2))).toBe('BOOT: watchdog');
  });

  it('merges both slots: a tag named differently in each shows both names (SPEC §3.9.3)', () => {
    const d = {
      firmware: slotDictionary(compile('CONST T_BAT 1\nCONST T_END 14\nLOG T_BAT @BAT\nLOG T_END', CHASSIS_MK1)),
      program: slotDictionary(compile('CONST T_X 1\nCONST T_END 14\nCALL SLEEP 1\nLOG T_X @X\nLOG T_END 3\nLOG 6', CHASSIS_MK1, {}, { slot: 'program' })),
    };
    const f = (bytes: number[]) => describeFrame({ unitId: 1, tick: 1, bytes, gap: 0 }, d);
    expect(f(encodeLog(1, 5))).toBe('T_BAT|T_X = 5 (fw L3, prog L4)');
    expect(f(encodeLog(14, null))).toBe('T_END (fw L4, prog L5)');
    expect(f(encodeLog(6, 2))).toBe('tag 6 = 2 (prog L6)');
  });

  it('decodes program dumps with prog: addresses and program source lines', () => {
    const res = compile('MOV r0 42\nPUSH 6\nBRK\nCALL SLEEP 1000', CHASSIS_MK1, {}, { slot: 'program' });
    const d = { firmware: emptyDictionary(), program: slotDictionary(res) };
    const bytes = encodeCpuDump({ ip: 7, status: 0, state: 5, regs: [42, 0, 0, 0], dsDepth: 1, csDepth: 0 }, 3);
    expect(describeFrame({ unitId: 1, tick: 9, bytes, gap: 0, taken: 8 }, d)).toBe(
      'PROGRAM DUMP (snapshot t8): next prog:0x007 (L4) · PROG_HALTED · @STATUS OK · r0=42 r1=0 r2=0 r3=0 · stacks 1/0',
    );
  });
});

describe('science recorder (SPEC §3.8.5)', () => {
  const spec = (subject: number = T.SAMPLE) => ({ type: ProductType.SPECTRUM, subject, x: 3, y: -2, credits: 3 });

  it('records descriptors, frees space only when the last byte is sent, wraps the sequence', () => {
    const d = new Downlink();
    for (let i = 0; i < 56; i++) expect(d.record({ ...spec(), tick: i }, 1024)).not.toBeNull();
    expect(d.recFree(1024)).toBe(1024 - 56 * 18);
    expect(d.record({ ...spec(), tick: 99 }, 1024)).toBeNull(); // 16 B left
    let delivered = 0;
    for (let t = 0; t < 9; t++) delivered += d.pump(100, 20, 2).delivered.length;
    expect(delivered).toBe(1); // 18 B at 2 B/tick
    expect(d.recFree(1024)).toBe(16 + 18);
    const s = new Downlink();
    s.seq = 255;
    expect(s.record({ ...spec(), tick: 0 }, 1024)!.seq).toBe(255);
    expect(s.record({ ...spec(), tick: 0 }, 1024)!.seq).toBe(0);
  });

  it('the log preempts a product between bytes; the product resumes', () => {
    const d = new Downlink();
    d.record({ ...spec(), tick: 0 }, 1024);
    d.pump(100, 20, 2); // 2 B of the spectrum
    d.enqueue(encodeLog(1, 1000), 32); // 3 B log frame
    const a = d.pump(100, 20, 2);
    expect([a.done.length, d.recSent]).toEqual([0, 2]);
    const b = d.pump(100, 20, 2); // last log byte + 1 product byte
    expect([b.done.length, d.recSent, b.partial?.seq]).toEqual([1, 3, 0]);
  });

  it('spectrometer records a spectrum; ERR_FULL keeps the item', () => {
    const { e, u } = rover('CALL ACT TOOL_2 0\nMOV r0 @STATUS\nMOV r1 @REC_FREE\nCALL ACT TOOL_2 1\nMOV r2 @STATUS\nMOV r3 @SCIENCE_READY\nCALL SLEEP 1000');
    u.cargo[0] = T.IRON_ORE;
    u.cargo[1] = T.SILICON_ORE;
    u.antennaHealth = 0; // nothing leaves the recorder
    for (let i = 0; i < 56; i++) e.recordProduct(u, spec());
    e.recordProduct(u, spec()); // cannot fit: 16 B left
    for (let i = 0; i < 80; i++) e.advanceTick();
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([Status.ERR_FULL, 16, Status.ERR_FULL, 56]);
    expect(u.cargo.slice(0, 2)).toEqual([T.IRON_ORE, T.SILICON_ORE]);
  });

  it('delivers in order, pays credits once, shows partial products in the gallery', () => {
    const { e, u } = rover('CALL SLEEP 100000');
    u.link.fifo = [];
    e.recordProduct(u, { ...spec(T.IRON_ORE), credits: 1 });
    e.recordProduct(u, spec());
    const c0 = e.credits;
    run(e, 5);
    expect(e.gallery).toHaveLength(1);
    expect(e.gallery[0].received).toBe(10);
    run(e, 13);
    expect(e.gallery.map((g) => [g.seq, g.received])).toEqual([
      [0, 18],
      [1, 18],
    ]);
    expect(e.credits - c0).toBeGreaterThanOrEqual(4);
    expect(e.stats.scienceDelivered).toBe(2);
    expect(u.link.products).toEqual([]);
  });

  it('spectra are integer, deterministic and shaped by the material', () => {
    const at = (subject: number, x = 5, y = 7) => spectrum(1, { subject, x, y, tick: 100, seq: 0 });
    for (const s of [at(T.IRON_ORE), at(T.SILICON_ORE), at(T.SAMPLE)]) {
      expect(s).toHaveLength(16);
      for (const b of s) expect(Number.isInteger(b) && b >= 0 && b <= 255).toBe(true);
    }
    expect(at(T.IRON_ORE)).toEqual(at(T.IRON_ORE));
    expect(at(T.IRON_ORE, 6, 7)).not.toEqual(at(T.IRON_ORE));
    const iron = at(T.IRON_ORE);
    expect(iron[12]).toBeLessThan(iron[9] - 30); // 880 nm absorption vs 760 nm
    const si = at(T.SILICON_ORE);
    expect(Math.max(...si) - Math.min(...si)).toBeLessThan(40); // flat
    expect(Math.min(...si)).toBeGreaterThan(150); // bright
    const smp = at(T.SAMPLE);
    expect(smp.indexOf(Math.max(...smp))).toBeGreaterThanOrEqual(2);
    expect(smp.indexOf(Math.max(...smp))).toBeLessThanOrEqual(5); // green peak, 480–600 nm
    const f = productFrame(1, { type: 0, seq: 7, subject: T.SAMPLE, x: 5, y: 7, tick: 100, credits: 3 });
    expect(f.slice(0, 2)).toEqual([0x80, 7]);
    expect(f).toHaveLength(productFrameBytes(0));
  });

  it('boot frames alone do not complete First contact', () => {
    const { e } = rover('CALL SLEEP 100000');
    run(e, 30);
    expect(e.received.length).toBe(1);
    expect(e.stats.framesReceived).toBe(0);
    expect(e.director.completed.has('first_contact')).toBe(false);
  });

  it('save mid-product, load, continue == uninterrupted run', () => {
    const make = () => {
      const { e, u } = rover('CONST T 2\nloop: LOG T @TICK\nCALL SLEEP 7\nJMP loop', 21);
      u.antennaHealth = 75;
      for (let i = 0; i < 6; i++) e.recordProduct(u, spec(i % 2 ? T.IRON_ORE : T.SAMPLE));
      return e;
    };
    const a = make();
    run(a, 120);
    const b0 = make();
    run(b0, 53);
    expect(b0.units[0].link.recSent).toBeGreaterThan(0);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 67);
    expect(serialize(b)).toEqual(serialize(a));
    expect(a.stats.scienceDelivered).toBe(6);
  });

  it('migrates v4 saves: waiting science packets are credited', () => {
    const { e } = rover('CALL SLEEP 10');
    const v4 = serialize(e) as unknown as Record<string, any>;
    v4.version = 4;
    delete v4.gallery;
    v4.stats.packetsSent = 3;
    delete v4.stats.framesReceived;
    for (const u of v4.units) {
      u.scienceReady = 4;
      u.packetsSent = 3;
      u.lastTx = null;
      u.link = { fifo: [], headSent: 0, acc: 0, lost: 0, gap: 0 };
    }
    const credits = v4.credits;
    const m = migrate(v4);
    expect(m.credits).toBe(credits + 4);
    expect(m.stats.framesReceived).toBe(3 + m.received.length);
    expect(m.gallery).toEqual([]);
    const l = deserialize(v4);
    expect(l.units[0].link.products).toEqual([]);
    expect('scienceReady' in m.units[0]).toBe(false);
  });
});

describe('gallery rendering', async () => {
  const { spectrumSvg } = await import('../src/ui/GalleryPanel');
  it('draws received bands as bars and hatches the rest', () => {
    const svg = spectrumSvg(new Array(16).fill(100), 3);
    expect(svg.match(/<title>/g)).toHaveLength(3);
    expect(svg.match(/url\(#hatch\)/g)).toHaveLength(13);
  });
});
