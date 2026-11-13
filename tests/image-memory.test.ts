import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { headerLevel, Level, productFrameBytes } from '../src/core/downlink';
import { productFrame, productPayload } from '../src/core/imaging';
import { DEFAULT_FIRMWARE, PROGRAM_TEMPLATES } from '../src/core/programs';
import { deserialize, migrate, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { compile, snapsWithoutSend } from '../src/core/vm/Compiler';
import { decodeProgram } from '../src/core/vm/isa';
import { createDefaultRegistry, T } from '../src/core/WorldRegistry';
import md from '../docs/IMAGE_MEMORY.md?raw';
import { hexDump } from '../src/ui/GalleryPanel';

const consts = createDefaultRegistry().constants();
const hex = (b: number[]) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Keep the dish on the orbiter before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

function until(e: SimulationEngine, cond: () => boolean, max = 5000): void {
  for (let i = 0; i < max && !cond(); i++) run(e, 1);
  expect(cond()).toBe(true);
}

/** Rover on cleared flat sand, a cliff two tiles north. `link: false` keeps products in the recorder. */
function rover(firmware: string, opts: { program?: string; link?: boolean; seed?: number; at?: [number, number] } = {}): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: opts.seed ?? 5 });
  const [ox, oy] = opts.at ?? [0, 0];
  const u = e.spawnUnit('t', ox, oy);
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      e.world.setTile(ox + x, oy + y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(ox + x, oy + y, Layer.OBSTACLE, 0);
      e.world.setTile(ox + x, oy + y, Layer.ITEM, 0);
    }
  e.world.setTile(ox, oy + 2, Layer.OBSTACLE, T.CLIFF_WALL);
  if (!opts.link) u.antennaHealth = 0;
  expect(e.upload(u, firmware, { factory: true }).errors).toEqual([]);
  if (opts.program !== undefined) expect(e.uploadProgram(u, opts.program, { factory: true }).errors).toEqual([]);
  return { e, u };
}

/** Pixel (x, y) of a 32×32 2-bpp picture. */
const px = (b: ArrayLike<number>, x: number, y: number): number => (b[y * 8 + (x >> 2)] >> (6 - 2 * (x & 3))) & 3;

describe('image memory instructions (SPEC §3.8.7)', () => {
  it('encode as LDB 1D, STB 1E, SEND 1F 05, ERASE 1F 06 and decode back', () => {
    const r = compile('LDB r0 r1\nSTB 5 r0\nSEND\nSEND 2\nERASE', CHASSIS_MK1, consts);
    expect(r.errors).toEqual([]);
    expect(hex(r.program!.code)).toBe('1D 10 11 1E 05 10 1F 05 3F 05 02 1F 06');
    expect(decodeProgram(r.program!.code).map((i) => i.op)).toEqual(['LDB', 'STB', 'SEND', 'SEND', 'ERASE']);
    expect(compile('ERASE 1', CHASSIS_MK1, consts).errors).toHaveLength(1);
    expect(compile('LDB 5 r0', CHASSIS_MK1, consts).errors).toHaveLength(1); // destination must be writable
  });

  it('Mk-I has 256 zeroed bytes; LDB / STB wrap the address, keep 8 bits and are compute (no @STATUS)', () => {
    const { e, u } = rover('DIV r0 0\nSTB 256 300\nSTB -1 -1\nLDB r1 0\nLDB r2 255\nLDB r3 7\nMOV r0 @STATUS\nSLEEP 1000');
    expect(u.img).toHaveLength(256);
    expect([...u.img].every((b) => b === 0)).toBe(true);
    run(e, 2);
    expect(u.img[0]).toBe(300 & 255);
    expect(u.img[255]).toBe(255);
    expect([u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([44, 255, 0]);
    expect(u.vm.regs[0]).toBe(Status.ERR_INVALID); // from the DIV: LDB / STB left it alone
    expect(u.imgEdited).toBe(true);
  });

  it('SEND of a drawing: DRAWN level in the header, its own bytes, no credits, cannot be flagged', () => {
    const { e, u } = rover('MOV r0 128\nl: STB r0 0xFF\nADD r0 1\nJLT r0 136 l\nSEND 1\nMOV r1 @STATUS\nSLEEP 100000', { link: true });
    const c0 = e.credits;
    until(e, () => u.link.products.length === 1);
    const p = u.link.products[0];
    expect(p).toMatchObject({ type: 1, level: Level.DRAWN, lit: false, subject: 0 });
    const frame = productFrame(e.seed, p);
    expect(frame[0]).toBe(0x80 | (1 << 3) | (Level.DRAWN << 1));
    expect(headerLevel(frame[0])).toBe(Level.DRAWN);
    for (let x = 0; x < 32; x++) expect([px(frame.slice(2), x, 15), px(frame.slice(2), x, 16)]).toEqual([0, 3]);
    until(e, () => e.gallery.length === 1 && e.gallery[0].received === productFrameBytes(1));
    expect(e.gallery[0].credits).toBe(0);
    expect(e.credits).toBe(c0);
    expect(e.stats.photosDelivered).toBe(0);
    expect(e.flagAnomaly(e.gallery[0])).toMatch(/drawn/);
    expect(u.vm.regs[1]).toBe(Status.OK);
  });

  it('the first SEND after a SNAP carries the capture (RAW); a second SEND is DRAWN; credits once', () => {
    const { e, u } = rover('SNAP NORTH\nSEND\nSEND\nSLEEP 100000', { link: true });
    until(e, () => u.link.products.length === 2);
    const [a, b] = u.link.products;
    expect(a.level).toBeUndefined();
    expect(a).toMatchObject({ subject: T.CLIFF_WALL, lit: true });
    expect(b).toMatchObject({ level: Level.DRAWN, lit: false });
    expect(productPayload(e.seed, b)).toEqual(productPayload(e.seed, a)); // same bytes, no second credit
    until(e, () => e.gallery.length === 2 && e.gallery[1].received === productFrameBytes(1), 3000);
    expect(e.gallery.map((g) => g.credits)).toEqual([BALANCE.photoCredits + BALANCE.photoFirstBonus, 0]);
    expect(e.stats.photosDelivered).toBe(1);
  });

  it('SEND of another type than the SNAP is DRAWN and keeps the capture for a matching SEND', () => {
    const { e, u } = rover('SNAP NORTH\nSEND 2\nSEND 1\nSLEEP 100000');
    until(e, () => u.link.products.length === 2);
    expect(u.link.products.map((p) => [p.type, p.level])).toEqual([[2, Level.DRAWN], [1, undefined]]);
    expect(u.capture).toBeNull();
  });

  it('an STB after the SNAP makes it EDITED: its own bytes, still lit and credited, original reproducible', () => {
    const { e, u } = rover('SNAP NORTH\nLDB r0 0\nMUL r0 -1\nADD r0 255\nSTB 0 r0\nSEND\nSLEEP 100000');
    until(e, () => u.link.products.length === 1);
    const p = u.link.products[0];
    expect(p).toMatchObject({ level: Level.EDITED, lit: true, subject: T.CLIFF_WALL });
    const sent = productPayload(e.seed, p);
    const original = productPayload(e.seed, { ...p, level: undefined, data: undefined });
    expect(sent[0]).toBe(255 - original[0]);
    expect(sent.slice(1)).toEqual(original.slice(1));
    expect(headerLevel(productFrame(e.seed, p)[0])).toBe(Level.EDITED);
  });

  it('SEND errors: ERR_INVALID for a bad type or one bigger than image memory, ERR_FULL, ERR_LOW_POWER; 1 tick, sendEnergy', () => {
    const { e, u } = rover('SEND 0\nMOV r0 @STATUS\nSEND 3\nMOV r1 @STATUS\nSEND 9\nMOV r2 @STATUS\nSEND 1\nMOV r3 @STATUS\nSLEEP 100000');
    while (u.link.recFree(u.chassis.recorderBytes) >= 258) e.recordProduct(u, { type: 1, subject: 0, x: 0, y: 0, credits: 0 });
    run(e, 12);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.ERR_INVALID, Status.ERR_FULL]);

    const ok = rover('SEND 1\nSLEEP 100000');
    const idle = rover('SLEEP 100000');
    ok.e.advanceTick();
    idle.e.advanceTick();
    expect(ok.u.action).toMatchObject({ kind: 'WAIT', ticksLeft: BALANCE.sendTicks });
    expect(ok.u.link.products).toHaveLength(1);
    expect(idle.u.energy - ok.u.energy).toBe(BALANCE.sendEnergy);
    expect(BALANCE.sendEnergy).toBeGreaterThan(0);

    const low = rover('SEND 1\nMOV r0 @STATUS\nSLEEP 100000');
    low.u.energy = BALANCE.sendEnergy - 1 + BALANCE.idleDrainPerTick; // one short after this tick's drain
    low.e.advanceTick(); // SEND fails, ends the tick (hardware)
    low.e.advanceTick(); // MOV r0 @STATUS
    expect(low.u.vm.regs[0]).toBe(Status.ERR_LOW_POWER);
    expect(low.u.link.products).toHaveLength(0);
  });

  it('ERASE zeroes image memory and drops the capture on request: 2 ticks, eraseEnergy; SEND keeps the memory', () => {
    const { e, u } = rover('SNAP NORTH\nSEND\nLDB r1 7\nERASE\nMOV r0 @STATUS\nSEND\nSLEEP 100000');
    const idle = rover('SLEEP 100000');
    let snapped: number[] = [];
    until(e, () => {
      if (u.link.products.length === 1 && !snapped.length) snapped = [...u.img];
      return u.link.products.length === 2;
    });
    expect(snapped.some((b) => b !== 0)).toBe(true); // SEND left the photo in image memory
    expect(u.vm.regs[1]).toBe(snapped[7]);
    expect([...u.img].every((b) => b === 0)).toBe(true);
    expect(u.vm.regs[0]).toBe(Status.OK);
    expect(u.link.products[1]).toMatchObject({ level: Level.DRAWN }); // the capture went with the ERASE
    expect(productPayload(e.seed, u.link.products[1]).every((b) => b === 0)).toBe(true);

    const er = rover('ERASE\nSLEEP 100000');
    er.u.img[5] = 9;
    er.u.capture = { type: 1, subject: 0, x: 0, y: 0, noise: { tick: 0, seq: 0 } };
    er.e.advanceTick();
    idle.e.advanceTick();
    expect(er.u.action).toMatchObject({ kind: 'WAIT', ticksLeft: BALANCE.eraseTicks });
    expect(idle.u.energy - er.u.energy).toBe(BALANCE.eraseEnergy);
    expect(er.u.img[5]).toBe(0);
    expect(er.u.capture).toBeNull();
  });

  it('is non-volatile: survives a reboot and power-off; grows with camera upgrades', () => {
    const { e, u } = rover('STB 3 77\nSLEEP 100000');
    run(e, 2);
    e.upload(u, 'SLEEP 100000', { factory: true });
    run(e, 2);
    expect(u.img[3]).toBe(77);
    u.capture = { type: 1, subject: 0, x: 0, y: 0, noise: { tick: 0, seq: 0 } };
    u.energy = 1;
    run(e, 3);
    expect(u.vm.state).toBe(CpuState.POWER_OFF);
    expect(u.img[3]).toBe(77);
    expect(u.capture).not.toBeNull();

    const g = rover('STB 3 77\nSLEEP 100000');
    run(g.e, 2);
    for (const id of ['REC_2K', 'CAM_HIRES']) g.e.installUpgrade(g.u, id);
    expect(g.u.imageMemory()).toHaveLength(1024);
    expect(g.u.img[3]).toBe(77);
  });

  it('save mid-processing, load, continue == uninterrupted run', () => {
    const src = 'loop: SNAP NORTH\nMOV r0 0\ninv: LDB r1 r0\nMUL r1 -1\nADD r1 255\nSTB r0 r1\nADD r0 1\nJLT r0 256 inv\nSEND\nSNAP EAST 2\nSEND\nSEND 1\nSLEEP 30\nJMP loop';
    const make = () => rover(src, { link: true, seed: 11 }).e;
    const a = make();
    run(a, 900);
    for (const at of [7, 40, 133, 401]) {
      const b0 = make();
      run(b0, at);
      const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
      expect([...b.units[0].img]).toEqual([...b0.units[0].img]);
      run(b, 900 - at);
      expect(serialize(b)).toEqual(serialize(a));
    }
    expect(a.gallery.some((g) => g.level === Level.EDITED)).toBe(true);
    expect(a.gallery.some((g) => g.level === Level.DRAWN)).toBe(true);
  });

  it('migrates v13 saves: empty image memory, no capture', () => {
    const { e } = rover('SLEEP 1000');
    const v13 = serialize(e) as unknown as { version: number; units: Record<string, unknown>[] };
    v13.version = 13;
    for (const u of v13.units) delete u.image;
    expect(SAVE_VERSION).toBe(14);
    expect(migrate(v13).units[0].image).toEqual({ mem: '', capture: null, mode: 1, edited: false });
    const back = deserialize(v13).units[0];
    expect(back.img).toHaveLength(256);
    expect(back.capture).toBeNull();
  });
});

describe('the image templates = the guide examples (docs/IMAGE_MEMORY.md), and they run as documented', () => {
  const blocks = [...md.matchAll(/```\n(; [A-Z ]+:[\s\S]*?)```/g)].map((m) => m[1]);
  const sizes = [...md.matchAll(/^\| (\d) \| [^|]+\|[^|]+\| (\d+) B \|/gm)].map((m) => Number(m[2]));
  const templates = Object.entries(PROGRAM_TEMPLATES).filter(([n]) => n.startsWith('Image: '));
  /** The shipped template whose first line names `name` (LINE, TEST PATTERN, ...). */
  const ex = (name: string) => templates.find(([, src]) => src.startsWith(`; ${name}:`))![1];
  /** Run a template as the program under the default firmware until it sent `n` products. */
  const runExample = (name: string, n = 1, at?: [number, number]) => {
    const r = rover(DEFAULT_FIRMWARE, { program: ex(name), at });
    until(r.e, () => r.u.link.products.length >= n);
    return r;
  };

  it('the Code tab offers the six guide examples word for word', () => {
    expect(blocks).toHaveLength(6);
    expect(templates.map(([, src]) => src)).toEqual(blocks);
    expect(templates.map(([n]) => n)).toEqual(['Image: Line', 'Image: Test pattern', 'Image: Negative', 'Image: Stamp', 'Image: Plot', 'Image: Memory map']);
  });

  it('has six examples whose Flash sizes match the table', () => {
    expect(blocks).toHaveLength(6);
    expect(sizes).toHaveLength(6);
    blocks.forEach((b, i) => {
      const r = compile(b, CHASSIS_MK1, consts, { slot: 'program' });
      expect(r.errors).toEqual([]);
      expect(r.flashUsed).toBe(sizes[i]);
    });
  });

  it('1 Line: a white line across row 16 on black', () => {
    const { e, u } = runExample('LINE');
    const b = productPayload(e.seed, u.link.products[0]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) expect(px(b, x, y)).toBe(y === 16 ? 3 : 0);
    expect(u.link.products[0].level).toBe(Level.DRAWN);
  });

  it('2 Test pattern: four grey bars', () => {
    const { e, u } = runExample('TEST PATTERN');
    const b = productPayload(e.seed, u.link.products[0]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) expect(px(b, x, y)).toBe(x >> 3);
  });

  it('3 Negative: every pixel of the photo inverted, still credited', () => {
    const { e, u } = runExample('NEGATIVE');
    const p = u.link.products[0];
    expect(p).toMatchObject({ level: Level.EDITED, lit: true, subject: T.CLIFF_WALL });
    const orig = productPayload(e.seed, { ...p, level: undefined, data: undefined });
    expect(productPayload(e.seed, p)).toEqual(orig.map((v) => 255 - v));
  });

  it('4 Stamp: @X and @Y as 16-bit big-endian bytes', () => {
    const { e, u } = runExample('STAMP', 1, [5, -300]);
    const p = u.link.products[0];
    const b = productPayload(e.seed, p);
    expect(hex(b.slice(0, 4))).toBe('00 05 FE D4');
    expect(b.slice(4)).toEqual(productPayload(e.seed, { ...p, level: undefined, data: undefined }).slice(4));
  });

  it('5 Plot: a white diagonal over the photo, the rest untouched', () => {
    const { e, u } = runExample('PLOT');
    const p = u.link.products[0];
    const b = productPayload(e.seed, p);
    const orig = productPayload(e.seed, { ...p, level: undefined, data: undefined });
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) expect(px(b, x, y)).toBe(x === y ? 3 : px(orig, x, y));
  });

  it('6 Memory map: counts visits in image memory and never sends', () => {
    const r = rover(DEFAULT_FIRMWARE, { program: ex('MEMORY MAP') });
    r.u.img.fill(200); // old contents: the program clears them first
    run(r.e, 1500);
    const u = r.u;
    expect(u.link.products).toHaveLength(0);
    const cell = (((u.y % 16) + 16) % 16) * 16 + (((u.x % 16) + 16) % 16);
    expect(u.img[cell]).toBeGreaterThan(0);
    expect([...u.img].filter((v) => v === 200)).toHaveLength(0);
    expect([...u.img].filter((v) => v > 0).length).toBeGreaterThan(10);
  });
});

describe('M12 slice 2 helpers', () => {
  const c = (src: string, slot: 'firmware' | 'program' = 'program') => compile(src, CHASSIS_MK1, consts, { slot });

  it('warns about SNAP without SEND, unless one of the two slots sends', () => {
    expect(snapsWithoutSend(c('SNAP NORTH\nEND'), null)).toBe(true);
    expect(snapsWithoutSend(c('SNAP NORTH\nSEND\nEND'), null)).toBe(false);
    expect(snapsWithoutSend(c('SNAP NORTH\nEND'), c('SEND\nSLEEP 5', 'firmware'))).toBe(false);
    expect(snapsWithoutSend(c('SEND 1\nEND'), null)).toBe(false);
    expect(snapsWithoutSend(c('SNAP NORTH\nbad'), null)).toBe(false); // does not compile: the errors speak
    for (const [name, src] of Object.entries(PROGRAM_TEMPLATES)) expect(snapsWithoutSend(c(src), null), name).toBe(false);
  });

  it('hex view: header decoded with its level, payload rows by image memory address', () => {
    const { e, u } = rover('STB 17 0xAB\nSEND 1\nSLEEP 100000');
    until(e, () => u.link.products.length === 1);
    const frame = productFrame(e.seed, u.link.products[0]);
    const lines = hexDump(frame, frame.length).split('\n');
    expect(lines[0]).toBe('header  8C  photo · drawn');
    expect(lines[1]).toBe('seq     00  product #0');
    expect(lines[2]).toBe('000     00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00');
    expect(lines[3]).toBe('010     00 AB 00 00 00 00 00 00  00 00 00 00 00 00 00 00');
    expect(lines).toHaveLength(2 + 16);
    expect(hexDump(frame.slice(0, 20), frame.length).split('\n').at(-1)).toBe(`        … ${frame.length - 20} B not received yet`);
  });
});
