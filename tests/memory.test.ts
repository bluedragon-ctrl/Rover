import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1, MEMORY_MAP } from '../src/core/balance';
import { BootReason, encodeLog, hex as hexBytes, SYSTEM_TAG } from '../src/core/downlink';
import { migrateImageMemory } from '../src/core/migrateSource';
import { DEFAULT_FIRMWARE } from '../src/core/programs';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, ProgState } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { UPGRADE_BY_ID } from '../src/core/upgrades';
import { compile } from '../src/core/vm/Compiler';
import { decodeProgram } from '../src/core/vm/isa';
import { createDefaultRegistry, T } from '../src/core/WorldRegistry';
import { buildListing, listingText } from '../src/ui/listing';

/** M14 slice 2: the memory model (docs/ASSEMBLER_CORE.md §7). */

const consts = createDefaultRegistry().constants();
const c = (src: string, slot: 'firmware' | 'program' = 'firmware', opts: Parameters<typeof compile>[3] = {}) => compile(src, CHASSIS_MK1, consts, { slot, ...opts });
const hex = (b: number[]) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');

function rover(firmware: string, program?: string): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: 4 });
  const u = e.spawnUnit('t');
  expect(e.upload(u, firmware, { factory: true }).errors).toEqual([]);
  if (program !== undefined) expect(e.uploadProgram(u, program, { factory: true }).errors).toEqual([]);
  return { e, u };
}
const run = (e: SimulationEngine, n: number) => {
  for (let i = 0; i < n; i++) e.advanceTick();
};

describe('sizes', () => {
  it('Mk-I has 512 B of Flash and 64 B of RAM; the map puts RAM at 0, image memory at IMG, cargo at CARGO', () => {
    expect(CHASSIS_MK1.flashBytes).toBe(512);
    expect(CHASSIS_MK1.ramBytes).toBe(64);
    expect(MEMORY_MAP).toEqual({ RAM: 0, IMG: 0x100, CARGO: 0x600 });
    const r = c('MOV r0 IMG\nMOV r1 CARGO\nMOV r2 RAM');
    expect(r.errors).toEqual([]);
  });
});

describe('addresses in brackets', () => {
  it('encodes [r] in 1 B, [n] and [r+n] in 3 B; spaces inside brackets are fine', () => {
    const r = c('LDB r0 [r1]\nLDB r0 [40]\nLDB r0 [ r2 + 4 ]\nLDB r0 [4+r2]\nSTB [r3-1] 7');
    expect(r.errors).toEqual([]);
    expect(hex(r.program!.code)).toBe('1D 10 21 1D 10 1C 00 28 1D 10 2A 00 04 1D 10 2A 00 04 1E 2B FF FF 07');
    expect(decodeProgram(r.program!.code, r.program!.codeBytes).map((d) => d.args.find((a) => a.k === 'mem'))).toEqual([
      { k: 'mem', base: 1, off: 0 },
      { k: 'mem', base: -1, off: 40 },
      { k: 'mem', base: 2, off: 4, wide: true },
      { k: 'mem', base: 2, off: 4, wide: true },
      { k: 'mem', base: 3, off: -1, wide: true },
    ]);
  });

  it('only load / store take memory operands, with one register at most', () => {
    expect(c('ADD r0 [r1]').errors[0].message).toMatch(/only work in LDB, STB and LDF/);
    expect(c('LDB r0 r1').errors[0].message).toMatch(/must be a memory address in brackets/);
    expect(c('LDB r0 [r1+r2]').errors[0].message).toMatch(/one register only/);
    expect(c('LDB r0 [nowhere]').errors[0].message).toMatch(/Unknown name 'nowhere'/);
  });

  it('sizes follow the syntax, so [x+r] with x = 0 is still 3 B', () => {
    const r = c('LDF r0 [tab+r1]\ntab: DATA 9');
    expect(r.errors).toEqual([]);
  });
});

describe('VAR: named RAM', () => {
  it('program VARs count up from 0, firmware VARs down from the top; both cost no Flash', () => {
    const p = c('VAR a\nVAR buf 8\nVAR b\nSTB [a] 1\nSTB [buf+7] 2\nSTB [b] 3', 'program');
    expect(p.errors).toEqual([]);
    expect([p.ramUsed, p.ramLow, p.ramHigh]).toEqual([10, 0, 10]);
    expect(p.flashUsed).toBe(3 * (1 + 3 + 1));
    const f = c('VAR x 2\nVAR y\nSTB [y] 1');
    expect([f.ramLow, f.ramHigh]).toEqual([61, 64]);
    expect(f.program!.instrs[0].args[0]).toEqual({ k: 'mem', base: -1, off: 61 }); // y = 64 - 2 - 1
  });

  it('shared RAM: VARs of both slots must not overlap (the error names both)', () => {
    const prog = 'VAR big 40\nSTB [big] 1';
    expect(c(prog, 'program', { otherRam: { low: 32, high: 64 } }).errors[0].message).toBe('Program VARs take 40 B of RAM + firmware 32 B; Rover Mk-I has 64 B of RAM');
    expect(c(prog, 'program', { otherRam: { low: 40, high: 64 } }).errors).toEqual([]);
    expect(c('VAR huge 65', 'program').errors[0].message).toMatch(/has 64 B of RAM/);
    expect(c('VAR OK').errors[0].message).toMatch(/already used/); // names are case-insensitive: OK is a status
  });

  it('firmware and program share RAM: an absolute address is a mailbox between them', () => {
    const { e, u } = rover('CONST BOX 20\nSTB [BOX] 99\nloop: RUN 5\nLDB r1 [BOX]\nSLEEP 1000', 'LDB r0 [20]\nADD r0 1\nSTB [20] r0\nEND r0');
    run(e, 5);
    expect(u.progResult).toBe(100);
    expect(u.vm.regs[1]).toBe(100);
  });

  it('RAM is zero after a hard reboot, and grows with RAM upgrades', () => {
    const { e, u } = rover('STB [5] 42\nSLEEP 1000');
    run(e, 1);
    expect(u.ram[5]).toBe(42);
    e.upload(u, 'SLEEP 1000', { factory: true });
    expect(u.ram[5]).toBe(0);
    u.ram[3] = 7;
    UPGRADE_BY_ID.RAM_128.apply(u.chassis, u);
    expect(u.ram.length).toBe(128);
    expect(u.ram[3]).toBe(7);
  });

  it('a RAM upgrade does not move the installed firmware VARs (save, load and continue stay identical)', () => {
    const fw = 'VAR count\nloop: LDB r0 [count]\nADD r0 1\nSTB [count] r0\nSLEEP 3\nJMP loop';
    const make = () => {
      const r = rover(fw);
      run(r.e, 10);
      UPGRADE_BY_ID.RAM_128.apply(r.u.chassis, r.u);
      r.u.upgrades.push('RAM_128');
      return r;
    };
    const a = make();
    run(a.e, 30);
    const b0 = make();
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0.e))));
    expect(b.units[0].ram[63]).toBe(b0.u.ram[63]); // count stayed at 63, not 127
    run(b, 30);
    expect(serialize(b)).toEqual(serialize(a.e));
    expect(a.u.ram[63]).toBeGreaterThan(5);
    // A new upload is assembled for the bigger RAM: the VAR moves to the new top.
    a.e.upload(a.u, fw, { factory: true });
    run(a.e, 2);
    expect(a.u.ram[127]).toBe(1);
  });
});

describe('the data address space', () => {
  it('cargo is read-only memory at CARGO; unmapped addresses and writes to cargo fault', () => {
    const { e, u } = rover('LDB r0 [CARGO+1]\nLDB r1 [CARGO]\nSLEEP 1000');
    u.cargo[1] = T.IRON_ORE;
    run(e, 1);
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([T.IRON_ORE, 0]);
    for (const [src, why] of [
      ['STB [CARGO] 1', /Cargo is read-only at 0x600/],
      ['LDB r0 [64]', /No memory at 0x040/], // past the end of the 64 B RAM
      ['LDB r0 [CARGO+4]', /No memory at 0x604/], // only 4 cargo slots
    ] as const) {
      const r = rover(`${src}\nSLEEP 1000`);
      run(r.e, 1);
      expect(r.u.vm.state).toBe(CpuState.FAULT);
      expect(r.u.vm.faultReason).toMatch(why);
    }
  });

  it('a program that runs off its memory faults back to the firmware, which keeps running', () => {
    const { e, u } = rover('loop: RUN 50\nJEQ @PROG_STATE PROG_READY loop\nSLEEP 1000', 'MOV r0 0\nl: STB [r0] 1\nADD r0 1\nJMP l');
    run(e, 100);
    expect(u.progState).toBe(ProgState.PROG_FAULT);
    expect(u.prog.faultReason).toMatch(/No memory at 0x040 \(STB\)/);
    expect(u.vm.state).not.toBe(CpuState.FAULT);
  });
});

describe('DATA and LDF: constant data in Flash', () => {
  it('collects DATA after the code; labels name it; it costs Flash; LDF reads it', () => {
    const src = 'tab: DATA 10, 20 0xFF\nstart: LDF r0 [tab+1]\nLDF r1 [tab+r2]\nmore: DATA -1 EAST';
    const r = c(src);
    expect(r.errors).toEqual([]);
    const p = r.program!;
    expect(p.codeBytes).toBe(12); // two LDF: 2-byte opcode + register + [address] 3 B
    expect(p.labels.START).toBe(0); // code starts at 0: DATA moved behind it
    expect(p.labels.TAB).toBe(12);
    expect(p.labels.MORE).toBe(15);
    expect(hex(p.code.slice(12))).toBe('0A 14 FF FF 01');
    expect(r.flashUsed).toBe(17);
    expect(c('DATA 256').errors[0].message).toMatch(/does not fit in a byte/);
    expect(c('DATA').errors[0].message).toMatch(/DATA expects/);
  });

  it('the CPU wraps at the end of the code, never runs into data, and LDF past the slot faults', () => {
    const { e, u } = rover('ADD r0 1\nLDF r1 [tab]\nSLEEP 1\ntab: DATA 42');
    run(e, 6);
    expect(u.vm.regs[1]).toBe(42);
    expect(u.vm.regs[0]).toBeGreaterThan(1); // looped back to the top
    expect(u.vm.state).not.toBe(CpuState.FAULT);
    const bad = rover('LDF r0 [100]\nSLEEP 10');
    run(bad.e, 1);
    expect(bad.u.vm.faultReason).toMatch(/No Flash at 0x064/);
  });

  it('the listing shows DATA with its address in the data section', () => {
    const src = 'route: DATA 1 2 3\nLDF r0 [route]\nEND r0';
    const r = c(src, 'program');
    const text = listingText(buildListing(src, r, 'program'));
    expect(text.split('\n')[0]).toMatch(/^prog:0x008 +01 02 03 +route: DATA 1 2 3$/);
    expect(text.split('\n')[1]).toMatch(/^prog:0x000 +1F 07 10 1C 00 08 +LDF r0 \[route\]$/);
  });
});

describe('save v17', () => {
  it('saves RAM', () => {
    const { e } = rover('STB [7] 9\nSLEEP 1000');
    run(e, 2);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(b.units[0].ram[7]).toBe(9);
  });

  it('migrates v16 image code to [IMG+…] and reboots that rover ("software update")', () => {
    expect(migrateImageMemory('loop:   LDB r1 r0       ; read\n  STB r0 r1\nLDB r2 [IMG]\n; LDB in a comment')).toBe(
      'loop:   LDB r1 [IMG+r0]       ; read\n  STB [IMG+r0] r1\nLDB r2 [IMG]\n; LDB in a comment',
    );
    const { e } = rover(DEFAULT_FIRMWARE, 'SLEEP 1');
    run(e, 3);
    const v16 = JSON.parse(JSON.stringify(serialize(e)));
    v16.version = 16;
    v16.units[0].program.source = 'MOV r0 0\nl: STB r0 0xFF\nADD r0 1\nJLT r0 8 l\nEND 1';
    for (const u of v16.units) {
      delete u.ram;
      delete u.fwRamTop;
    }
    const b = deserialize(v16);
    const u = b.units[0];
    expect(u.programSource).toBe('MOV r0 0\nl: STB [IMG+r0] 0xFF\nADD r0 1\nJLT r0 8 l\nEND 1');
    expect(u.progState).toBe(ProgState.PROG_READY);
    expect(u.link.fifo.some((f) => hexBytes(f.bytes) === hexBytes(encodeLog(SYSTEM_TAG, BootReason.UPDATE)))).toBe(true);
    run(b, 200);
    expect([...u.img.slice(0, 8)].every((x) => x === 0xff)).toBe(true);
  });
});
