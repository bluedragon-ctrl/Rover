import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { headerLevel, Level, productFrameBytes } from '../src/core/downlink';
import { productFrame, productPayload } from '../src/core/imaging';
import { DEFAULT_FIRMWARE, PROGRAM_TEMPLATES } from '../src/core/programs';
import { deserialize, migrate, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { compile, romLabels, snapsWithoutSend } from '../src/core/vm/Compiler';
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

describe('Darkroom: first-edit bonus per camera mode (M12 slice 3)', () => {
  // Edit one byte (STB 0 255), or none, after each SNAP: mode 1, 1 again, raw 1, then (once the
  // recorder has drained) mode 2.
  const src = 'CALL SNAP NORTH 1\nSTB [IMG] 255\nCALL SEND 0\nCALL SNAP NORTH 1\nSTB [IMG] 255\nCALL SEND 0\nCALL SNAP NORTH 1\nCALL SEND 0\nCALL SLEEP 600\nCALL SNAP NORTH 2\nSTB [IMG] 255\nCALL SEND 0\nCALL SLEEP 100000';

  it('pays +editFirstBonus once per photo type for lit edited photos and completes Darkroom', () => {
    const { e } = rover(src, { link: true });
    const c0 = e.credits;
    until(e, () => e.gallery.length === 4 && e.gallery[3].received === productFrameBytes(2), 4000);
    run(e, 20); // goals are checked every 10 ticks
    const P = BALANCE.photoCredits, S = BALANCE.photoFirstBonus, X = BALANCE.editFirstBonus;
    expect(e.gallery.map((g) => [g.type, g.level])).toEqual([[1, Level.EDITED], [1, Level.EDITED], [1, undefined], [2, Level.EDITED]]);
    expect(e.gallery.map((g) => g.credits)).toEqual([P + S + X, P, P, P + X]);
    expect(e.editedTypes).toEqual([1, 2]);
    expect(e.stats.photosEdited).toBe(3);
    expect(e.director.completed.has('darkroom')).toBe(true);
    const darkroom = 15;
    expect(e.credits - c0).toBeGreaterThanOrEqual(P * 4 + S + X * 2 + darkroom);
  });

  it('dark and drawn pictures earn no edit bonus', () => {
    const { e } = rover('CALL ERASE\nSTB [IMG] 255\nCALL SEND 1\nCALL SLEEP 100000', { link: true });
    until(e, () => e.gallery.length === 1 && e.gallery[0].received === productFrameBytes(1), 3000);
    expect(e.gallery[0]).toMatchObject({ level: Level.DRAWN, credits: 0 });
    expect(e.editedTypes).toEqual([]);
    expect(e.stats.photosEdited).toBe(0);
  });

  it('saves the credited modes and migrates v14 saves', () => {
    const { e } = rover(src, { link: true });
    until(e, () => e.editedTypes.length === 1, 4000);
    const back = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(back.editedTypes).toEqual([1]);
    expect(back.stats.photosEdited).toBe(1);
    const v14 = serialize(e) as unknown as Record<string, any>;
    v14.version = 14;
    delete v14.editedTypes;
    delete v14.stats.photosEdited;
    expect(SAVE_VERSION).toBeGreaterThanOrEqual(15);
    const m = migrate(v14);
    expect(m.editedTypes).toEqual([]);
    expect(m.stats.photosEdited).toBe(0);
  });
});

describe('image memory instructions (SPEC §3.8.7)', () => {
  it('encode as LDB 1D, STB 1E; SEND and ERASE are ROM routines (M14) and decode back', () => {
    const r = compile('LDB r0 [IMG+r1]\nSTB [IMG+5] r0\nCALL SEND 0\nCALL SEND 2\nCALL ERASE', CHASSIS_MK1, consts);
    expect(r.errors).toEqual([]);
    // [IMG+r1] = 29 (indexed r1) + 16-bit offset 0x0100; [IMG+5] = 1C (absolute) + 0x0105
    const rom = romLabels();
    const at = (n: number) => hex([n >> 8, n & 255]);
    expect(hex(r.program!.code)).toBe(`1D 10 29 01 00 1E 1C 01 05 10 30 ${at(rom.SEND)} 00 30 ${at(rom.SEND)} 02 10 ${at(rom.ERASE)}`);
    expect(decodeProgram(r.program!.code).map((i) => i.op)).toEqual(['LDB', 'STB', 'CALL', 'CALL', 'CALL']);
    expect(compile('CALL ERASE 1', CHASSIS_MK1, consts).errors[0].message).toMatch(/CALL ERASE takes no arguments/);
    expect(compile('LDB 5 [IMG+r0]', CHASSIS_MK1, consts).errors).toHaveLength(1); // destination must be writable
  });

  it('Mk-I has 256 zeroed bytes at IMG; LDB / STB keep 8 bits and are compute (no @STATUS)', () => {
    const { e, u } = rover('DIV r0 0\nSTB [IMG] 300\nSTB [IMG+255] -1\nLDB r1 [IMG]\nLDB r2 [IMG+255]\nLDB r3 [IMG+7]\nMOV r0 @STATUS\nCALL SLEEP 1000');
    expect(u.img).toHaveLength(256);
    expect([...u.img].every((b) => b === 0)).toBe(true);
    run(e, 2);
    expect(u.img[0]).toBe(300 & 255);
    expect(u.img[255]).toBe(255);
    expect([u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([44, 255, 0]);
    expect(u.vm.regs[0]).toBe(Status.ERR_INVALID); // from the DIV: LDB / STB left it alone
    expect(u.imgEdited).toBe(true);
  });

  it('an address past the end of image memory faults (no more wrap-around, M14)', () => {
    for (const bad of ['STB [IMG+256] 1', 'LDB r0 [IMG-1]']) {
      const { e, u } = rover(`${bad}\nCALL SLEEP 1000`);
      run(e, 1);
      expect(u.vm.state).toBe(CpuState.FAULT);
      expect(u.vm.faultReason).toMatch(/memory at 0x(200|0FF)/i);
    }
  });

  it('SEND of a drawing: DRAWN level in the header, its own bytes, no credits, cannot be flagged', () => {
    const { e, u } = rover('MOV r0 128\nl: STB [IMG+r0] 0xFF\nADD r0 1\nJLT r0 136 l\nCALL SEND 1\nMOV r1 @STATUS\nCALL SLEEP 100000', { link: true });
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
    const { e, u } = rover('CALL SNAP NORTH 1\nCALL SEND 0\nCALL SEND 0\nCALL SLEEP 100000', { link: true });
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
    const { e, u } = rover('CALL SNAP NORTH 1\nCALL SEND 2\nCALL SEND 1\nCALL SLEEP 100000');
    until(e, () => u.link.products.length === 2);
    expect(u.link.products.map((p) => [p.type, p.level])).toEqual([[2, Level.DRAWN], [1, undefined]]);
    expect(u.capture).toBeNull();
  });

  it('an STB after the SNAP makes it EDITED: its own bytes, still lit and credited, original reproducible', () => {
    const { e, u } = rover('CALL SNAP NORTH 1\nLDB r0 [IMG]\nMUL r0 -1\nADD r0 255\nSTB [IMG] r0\nCALL SEND 0\nCALL SLEEP 100000');
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
    const { e, u } = rover('CALL SEND 0\nMOV r0 @STATUS\nCALL SEND 3\nMOV r1 @STATUS\nCALL SEND 9\nMOV r2 @STATUS\nCALL SEND 1\nMOV r3 @STATUS\nCALL SLEEP 100000');
    while (u.link.recFree(u.chassis.recorderBytes) >= 258) e.recordProduct(u, { type: 1, subject: 0, x: 0, y: 0, credits: 0 });
    run(e, 12);
    // Type 0 = the mode of the last photo (1 after a reboot): a valid type, so the full recorder answers.
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2], u.vm.regs[3]]).toEqual([Status.ERR_FULL, Status.ERR_INVALID, Status.ERR_INVALID, Status.ERR_FULL]);

    const ok = rover('CALL SEND 1\nCALL SLEEP 100000');
    const idle = rover('CALL SLEEP 100000');
    ok.e.advanceTick();
    idle.e.advanceTick();
    expect(ok.u.imgOp).toMatchObject({ kind: 'send', ticksLeft: BALANCE.sendTicks });
    expect(ok.u.link.products).toHaveLength(1);
    expect(idle.u.energy - ok.u.energy).toBe(BALANCE.sendEnergy);
    expect(BALANCE.sendEnergy).toBeGreaterThan(0);

    const low = rover('CALL SEND 1\nMOV r0 @STATUS\nCALL SLEEP 100000');
    low.u.energy = BALANCE.sendEnergy - 1 + BALANCE.idleDrainPerTick; // one short after this tick's drain
    low.e.advanceTick(); // the send is refused; MOV r0 @STATUS
    expect(low.u.vm.regs[0]).toBe(Status.ERR_LOW_POWER);
    expect(low.u.link.products).toHaveLength(0);
  });

  it('ERASE zeroes image memory and drops the capture on request: 2 ticks, eraseEnergy; SEND keeps the memory', () => {
    const { e, u } = rover('CALL SNAP NORTH 1\nCALL SEND 0\nLDB r1 [IMG+7]\nCALL ERASE\nMOV r0 @STATUS\nCALL SEND 0\nCALL SLEEP 100000');
    const idle = rover('CALL SLEEP 100000');
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

    const er = rover('CALL ERASE\nCALL SLEEP 100000');
    er.u.img[5] = 9;
    er.u.capture = { type: 1, subject: 0, x: 0, y: 0, noise: { tick: 0, seq: 0 } };
    er.e.advanceTick();
    idle.e.advanceTick();
    expect(er.u.imgOp).toMatchObject({ kind: 'erase', ticksLeft: BALANCE.eraseTicks });
    expect(idle.u.energy - er.u.energy).toBe(BALANCE.eraseEnergy);
    expect(er.u.img[5]).toBe(0);
    expect(er.u.capture).toBeNull();
  });

  it('is non-volatile: survives a reboot and power-off; grows with camera upgrades', () => {
    const { e, u } = rover('STB [IMG+3] 77\nCALL SLEEP 100000');
    run(e, 2);
    e.upload(u, 'CALL SLEEP 100000', { factory: true });
    run(e, 2);
    expect(u.img[3]).toBe(77);
    u.capture = { type: 1, subject: 0, x: 0, y: 0, noise: { tick: 0, seq: 0 } };
    u.energy = 1;
    run(e, 3);
    expect(u.vm.state).toBe(CpuState.POWER_OFF);
    expect(u.img[3]).toBe(77);
    expect(u.capture).not.toBeNull();

    const g = rover('STB [IMG+3] 77\nCALL SLEEP 100000');
    run(g.e, 2);
    for (const id of ['REC_2K', 'CAM_HIRES']) g.e.installUpgrade(g.u, id);
    expect(g.u.imageMemory()).toHaveLength(1024);
    expect(g.u.img[3]).toBe(77);
  });

  it('save mid-processing, load, continue == uninterrupted run', () => {
    const src = 'loop: CALL SNAP NORTH 1\nMOV r0 0\ninv: LDB r1 [IMG+r0]\nMUL r1 -1\nADD r1 255\nSTB [IMG+r0] r1\nADD r0 1\nJLT r0 256 inv\nCALL SEND 0\nCALL SNAP EAST 2\nCALL SEND 0\nCALL SEND 1\nCALL SLEEP 30\nJMP loop';
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
    const { e } = rover('CALL SLEEP 1000');
    const v13 = serialize(e) as unknown as { version: number; units: Record<string, unknown>[] };
    v13.version = 13;
    for (const u of v13.units) delete u.image;
    expect(SAVE_VERSION).toBeGreaterThanOrEqual(14);
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
    expect(snapsWithoutSend(c('CALL SNAP NORTH 1\nEND'), null)).toBe(true);
    expect(snapsWithoutSend(c('CALL SNAP NORTH 1\nCALL SEND 0\nEND'), null)).toBe(false);
    expect(snapsWithoutSend(c('CALL SNAP NORTH 1\nEND'), c('CALL SEND 0\nCALL SLEEP 5', 'firmware'))).toBe(false);
    expect(snapsWithoutSend(c('CALL SEND 1\nEND'), null)).toBe(false);
    expect(snapsWithoutSend(c('CALL SNAP NORTH 1\nbad'), null)).toBe(false); // does not compile: the errors speak
    for (const [name, src] of Object.entries(PROGRAM_TEMPLATES)) expect(snapsWithoutSend(c(src), null), name).toBe(false);
  });

  it('hex view: header decoded with its level, payload rows by image memory address', () => {
    const { e, u } = rover('STB [IMG+17] 0xAB\nCALL SEND 1\nCALL SLEEP 100000');
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
