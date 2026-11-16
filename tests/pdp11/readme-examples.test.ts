/**
 * Every ```ts block in src/pdp11/README.md is copied here verbatim (import lines aside) and
 * run, so the documentation an AI or a person copies from is known to work. The last test
 * fails if a README block is missing from this file: edit both together.
 */
import { describe, expect, it } from 'vitest';
import readme from '../../src/pdp11/README.md?raw';
import here from './readme-examples.test.ts?raw';
import {
  assemble, BUS_ERROR, Cpu, DeviceMachine, disassemble, octal, SimpleMachine,
  type AssembleResult, type Bus, type Device,
} from '../../src/pdp11';

const must = (asm: AssembleResult): AssembleResult => {
  if (!asm.ok) throw new Error(asm.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return asm;
};

describe('README examples', () => {
  it('quick start', () => {
    const asm = assemble(`
        MOV #MSG, R1
1$:     MOVB (R1)+, R0      ; next character
        BEQ 2$              ; 0: done
3$:     TSTB @#177564       ; XCSR bit 7: transmitter ready?
        BPL 3$
        MOVB R0, @#177566   ; XBUF: print it
        BR 1$
2$:     HALT
MSG:    .ASCIZ /HELLO/
`);
    if (!asm.ok) throw new Error(asm.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
    const m = new SimpleMachine();
    m.boot(asm);                 // clear RAM, load, PC = start, SP = origin
    const r = m.run(10_000);     // { reason: 'halt', cycles, instructions }
    console.assert(m.output === 'HELLO' && r.reason === 'halt');

    expect(m.output).toBe('HELLO');
    expect(r.reason).toBe('halt');
  });

  it('bare CPU on your own bus', () => {
    const mem = new Uint8Array(0o160000);              // 56 KB of RAM, nothing else
    const bus: Bus = {
      read: (a, byte) => (a >= mem.length ? BUS_ERROR : byte ? mem[a] : mem[a] | (mem[a + 1] << 8)),
      write: (a, v, byte) => {
        if (a >= mem.length) return false;               // bus error (trap to 4)
        mem[a] = v & 0xff;
        if (!byte) mem[a + 1] = v >> 8;
        return true;
      },
    };
    const cpu = new Cpu(bus, { eis: true });
    mem.set(must(assemble(' MOV #3, R0\n MUL #5, R0\n HALT')).bytes, 0o1000);
    cpu.r[7] = 0o1000;                                 // PC
    cpu.r[6] = 0o1000;                                 // SP (the stack grows down)
    const r = cpu.run(1000);                           // { reason: 'halt', … }; R1 = 15.

    expect(r.reason).toBe('halt');
    expect(cpu.r[1]).toBe(15);
  });

  it('a device with an interrupt', () => {
    /** A range finder at 170000: CSR (bit 0 GO, bit 6 IE, bit 7 DONE) and a result word. */
    class RangeFinder implements Device {
      readonly base = 0o170000;
      readonly size = 4;                       // 170000 CSR, 170002 distance
      distance = 0o42;
      private cpu!: Cpu;
      private csr = 0;
      private left = Infinity;                 // cycles until the measurement is done

      attach(cpu: Cpu) { this.cpu = cpu; }
      read(offset: number) { return offset === 0 ? this.csr : this.distance; }
      write(offset: number, value: number, byte: boolean) {
        if (offset !== 0 || byte) return true;  // the result is read-only; byte writes ignored
        this.csr = value & 0o100;               // keep IE, clear DONE
        if (value & 1) this.left = 200;         // GO: done in 200 cycles
        return true;
      }
      reset() { this.csr = 0; this.left = Infinity; }
      advance(cycles: number) {
        if ((this.left -= cycles) > 0) return;
        this.left = Infinity;
        this.csr |= 0o200;                                     // DONE
        if (this.csr & 0o100) this.cpu.interrupt(0o300, 4);    // one request; taken once
      }
      nextEvent() { return this.left; }                        // when DONE will change
      wakeIn() { return this.csr & 0o100 ? this.left : Infinity; }
      canWake() { return (this.csr & 0o100) !== 0 && this.left !== Infinity; }
    }

    const m = new DeviceMachine().add(new RangeFinder());
    const asm = assemble(`
RFCSR = 170000
RFDST = 170002
        MOV #DONE, @#300    ; vector 300: new PC …
        MOV #340, @#302     ; … and new PSW (priority 7 while in the handler)
        MOV #101, @#RFCSR   ; IE + GO
        WAIT                ; sleep until the interrupt
        HALT
DONE:   MOV @#RFDST, R0
        RTI
`);
    m.boot(asm);
    const r = m.run(10_000);    // reason 'halt', R0 = 42 (octal), m.cycles ≈ 200 + a few

    expect(asm.ok).toBe(true);
    expect(r.reason).toBe('halt');
    expect(m.cpu.r[0]).toBe(0o42);
    expect(m.cycles).toBeGreaterThanOrEqual(200);
    expect(m.cycles).toBeLessThan(250);
  });

  it('host recipes', () => {
    const m = new SimpleMachine();
    const asm = must(assemble(`
        MOV #340, R5
WAITK:  TSTB @#177560       ; RCSR bit 7: a key?
        BPL WAITK
        MOVB @#177562, R0   ; RBUF
        EMT 7               ; ask the host
        HALT
`));
    m.boot(asm);

    // Keyboard: queue characters; the program reads them from RBUF one by one.
    m.type('A');

    // Coverage / profiling: one counter per word address.
    const hits = new Uint32Array(0x8000);
    m.cpu.onInstruction = (pc) => { hits[pc >> 1]++; };

    // Host-side system calls: stop on EMT, do the work, continue.
    m.cpu.onTrap = (t) => (t.cause === 'emt' ? 'stop' : 'vector');
    let r = m.run(10_000);
    if (r.reason === 'trap' && r.trap?.cause === 'emt') {
      const number = r.trap.detail;            // 7; the PC is already past the EMT
      m.cpu.r[0] = number! + 1;                // the "result"
      r = m.run(10_000);                       // continues with the HALT
    }

    // Breakpoints: stop before the instruction at an address; run again to continue.
    m.boot(asm);
    m.type('B');
    const bp = new Set([asm.symbols.get('WAITK')!]);
    r = m.run(10_000, bp);                     // reason 'breakpoint', PC = WAITK

    // Snapshot and restore (CPU + RAM; device state is the devices' own business).
    const snap = { cpu: m.cpu.save(), ram: m.ram.slice(), cycles: m.cycles };
    m.run(10_000);
    m.cpu.load(snap.cpu); m.ram.set(snap.ram); m.cycles = snap.cycles;

    // Disassembly with label names. Reads through m.read: device registers have side effects.
    const names = new Map([...asm.labels].map((l) => [asm.symbols.get(l)!, l]));
    const lines: string[] = [];
    for (let a = asm.origin; a < asm.origin + asm.bytes.length;) {
      const d = disassemble((x) => m.read(x, false), a, { nameOf: (x) => names.get(x) });
      lines.push(`${octal(d.address)}  ${d.text}`);
      a += d.words.length * 2;
    }

    expect(hits[0o1000 >> 1]).toBeGreaterThan(0);
    expect(r.reason).toBe('breakpoint');
    expect(m.cpu.r[7]).toBe(asm.symbols.get('WAITK'));
    expect(lines[1]).toBe('001004  TSTB @#177560');
    expect(lines[2]).toBe('001010  BPL WAITK');
  });

  it('EMT result reached R0', () => {
    const m = new SimpleMachine();
    m.boot(must(assemble(' MOVB #1, R0\n EMT 7\n HALT')));
    m.cpu.onTrap = (t) => (t.cause === 'emt' ? 'stop' : 'vector');
    const r = m.run(100);
    expect(r).toMatchObject({ reason: 'trap', trap: { cause: 'emt', detail: 7 } });
    expect(m.cpu.r[7]).toBe(0o1006); // past the EMT
  });

  it('every README code block is in this file', () => {
    const norm = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('import ')).join('\n');
    const body = norm(here);
    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((b) => norm(b[1]));
    expect(blocks.length).toBeGreaterThan(3);
    for (const b of blocks) expect(body.includes(b), `README block not tested:\n${b}`).toBe(true);
  });
});
