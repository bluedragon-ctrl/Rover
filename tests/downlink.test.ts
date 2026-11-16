import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { BootReason, decodeFrame, Downlink, encodeLog, hex, productFrameBytes, ProductType, SYSTEM_TAG } from '../src/core/downlink';
import { productFrame, spectrum } from '../src/core/imaging';
import { MsgType } from '../src/core/messages';
import { Status } from '../src/core/types';
import { T } from '../src/core/WorldRegistry';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import type { Unit } from '../src/core/Unit';
import { toolchain } from '../src/ui/toolchain';
import { factory, fw, HANG, reg, sleep } from './helpers/rover';

const IDLE = `START:${HANG}`;
/** ROM LOG: tag `tag`, value from `src`. */
const log = (tag: string, src: string) => `MOV  #${tag}, R0\n        MOV  ${src}, R1\n        JSR  PC, LOG`;

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

  it('sends 4 B/tick at full signal (Mk-I), proportionally less, nothing below 20', () => {
    const rate = (signal: number, ticks: number) => {
      const d = new Downlink();
      for (let i = 0; i < 40; i++) d.enqueue([1, 2], 128);
      let sent = 0;
      for (let t = 0; t < ticks; t++) sent += d.pump(signal, BALANCE.linkMinSignal, BALANCE.linkBytesPerTick).sent;
      return sent;
    };
    expect(rate(100, 10)).toBe(40);
    expect(rate(50, 10)).toBe(20);
    expect(rate(25, 10)).toBe(10);
    expect(rate(19, 100)).toBe(0);
  });

  it('the boot frame and the messages arrive when their last byte is sent; mission control decodes them', () => {
    const { e } = rover(fw(log('4', '@#TICKL')));
    const got: number[] = [];
    e.events.on('DOWNLINK_FRAME', (f) => got.push(f.tick));
    run(e, 10);
    expect(e.received.map((f) => decodeFrame(f.bytes))).toEqual([{ kind: 0, tag: SYSTEM_TAG, value: BootReason.UPLOAD }]); // boot frame: code upload
    expect(got.length).toBe(1);
    const m = e.messages.filter((x) => x.type === MsgType.LOG);
    expect(m).toHaveLength(1);
    expect(m[0].body[0]).toBe(4);
    expect(m[0].body[1]).toBeGreaterThan(0); // the tick it was logged
  });

  it('costs energy only in ticks that send bytes', () => {
    const { e, u } = rover(IDLE);
    run(e, 1); // first tick sends the boot frame (2 B)
    const before = u.energy;
    run(e, 20); // idle link: only idle drain, no solar (array stowed)
    expect(before - u.energy).toBe(20 * BALANCE.idleDrainPerTick);
    u.link.enqueue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 32); // 3 ticks at 4 B/tick
    const b2 = u.energy;
    run(e, 3);
    expect(b2 - u.energy).toBe(3 * (BALANCE.idleDrainPerTick + BALANCE.linkEnergyPerTick));
  });

  it('keeps transmitting while the CPU is faulted, not while powered off', () => {
    const { e, u } = rover(IDLE);
    u.link.fifo = [];
    u.cpu.fault('test', BALANCE.watchdogTicks); // a double fault
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
    const { e, u } = rover(IDLE);
    u.link.lost = 9;
    e.upload(u, IDLE, factory);
    expect(u.link.lost).toBe(0);
    expect(decodeFrame(u.link.fifo.at(-1)!.bytes)).toEqual({ kind: 0, tag: 15, value: 1 });
    run(e, 5);
    u.cpu.fault('test', BALANCE.watchdogTicks);
    run(e, BALANCE.watchdogTicks + 2);
    expect(e.received.some((f) => hex(f.bytes) === '7A 02')).toBe(true); // watchdog
    e.admin.respawnAtOrigin(u);
    expect(hex(u.link.fifo.at(-1)!.bytes)).toBe('7A 04');
  });

});

describe('downlink determinism and saves', () => {
  const SRC = `START:\n1$:     ${log('3', '@#BAT')}\n        ${log('1', '@#TICKL')}\n        ${log('2', '@#TXLOST')}\n        ${sleep(2)}\n        BR   1$`;

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
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 163);
    expect(serialize(b)).toEqual(serialize(a));
    expect(a.messages.filter((m) => m.status === 'ok').length).toBeGreaterThan(50);
    expect(a.units[0].link.tx.length).toBeGreaterThan(0); // the loop outruns the link: the FIFO stays busy
  });

});

describe('console decoding', async () => {
  const { describeFrame, describeMessage, emptyDictionary, slotDictionary } = await import('../src/ui/comms');
  const dict = (src: string, slot: 'firmware' | 'program' = 'firmware') => {
    const e = new SimulationEngine({ seed: 1 });
    return slotDictionary(toolchain(e).build(e.spawnUnit('t'), src, slot));
  };
  const msg = (tag: number, v: number) => ({ unitId: 1, tick: 1, type: MsgType.LOG, body: [tag, v & 255, (v >> 8) & 255], status: 'ok' as const });

  it('names log tags from the L. symbols and their lines, decodes boot frames', () => {
    const d = { firmware: dict(`L.BAT = 5\nSTART:  ${log('L.BAT', '@#BAT')}${HANG}`), program: emptyDictionary() };
    expect(describeMessage(msg(5, 812), d)).toBe('L.BAT = 812');
    expect(describeMessage(msg(3, -1), d)).toBe('tag 3 = -1');
    expect(describeFrame({ unitId: 1, tick: 1, bytes: encodeLog(15, 2), gap: 0 }, d)).toBe('BOOT: watchdog');
  });

  it('merges both slots: a tag named differently in each shows both names (SPEC §3.9.3)', () => {
    const d = {
      firmware: dict(`L.BAT = 1\nL.END = 14.\nSTART:  ${log('L.BAT', '@#BAT')}\n        ${log('L.END', '#0')}${HANG}`),
      program: dict(`L.X = 1\nL.END = 14.\nSTART:  ${log('L.X', '@#X')}\n        ${log('L.END', '#3')}\n        HALT`, 'program'),
    };
    expect(describeMessage(msg(1, 5), d)).toBe('L.BAT|L.X = 5');
    expect(describeMessage(msg(14, 3), d)).toBe('L.END = 3');
    expect(d.program.tags[1].lines).toEqual([3]);
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

  it('spectrometer records a spectrum; E.FULL keeps the item', () => {
    const act = (slot: number, dst: string) => `MOV  #${slot}, R0\n        MOV  #F.T2, R1\n        JSR  PC, ACT\n        MOV  R0, ${dst}`;
    const { e, u } = rover(fw(act(0, 'R2'), 'MOV  @#RECFRE, R3', act(1, 'R4'), 'MOV  @#SCIRDY, R5'));
    u.cargo[0] = T.IRON_ORE;
    u.cargo[1] = T.SILICON_ORE;
    u.antennaHealth = 0; // nothing leaves the recorder
    let n = 0;
    while (e.recordProduct(u, spec())) n++;
    const left = u.link.recFree(u.recorderBytes);
    expect(left).toBeLessThan(18);
    for (let i = 0; i < 80; i++) e.advanceTick();
    expect([reg(u, 2), reg(u, 3), reg(u, 4), reg(u, 5)]).toEqual([Status.ERR_FULL, left, Status.ERR_FULL, n]);
    expect(u.cargo.slice(0, 2)).toEqual([T.IRON_ORE, T.SILICON_ORE]);
  });

  it('delivers in order, pays credits once, shows partial products in the gallery', () => {
    const { e, u } = rover(IDLE);
    u.link.fifo = [];
    e.recordProduct(u, { ...spec(T.IRON_ORE), credits: 1 });
    e.recordProduct(u, spec());
    const c0 = e.credits;
    run(e, 3);
    expect(e.gallery).toHaveLength(1);
    expect(e.gallery[0].received).toBe(12);
    run(e, 7);
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
    const { e } = rover(IDLE);
    run(e, 30);
    expect(e.received.length).toBe(1);
    expect(e.stats.framesReceived).toBe(0);
    expect(e.director.completed.has('first_contact')).toBe(false);
  });

  it('save mid-product, load, continue == uninterrupted run', () => {
    const make = () => {
      const { e, u } = rover(`START:\n1$:     ${log('2', '@#TICKL')}\n        ${sleep(7)}\n        BR   1$`, 21);
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

});

describe('gallery rendering', async () => {
  const { spectrumSvg } = await import('../src/ui/GalleryPanel');
  it('draws received bands as bars and hatches the rest', () => {
    const svg = spectrumSvg(new Array(16).fill(100), 3);
    expect(svg.match(/<title>/g)).toHaveLength(3);
    expect(svg.match(/url\(#hatch\)/g)).toHaveLength(13);
  });
});
