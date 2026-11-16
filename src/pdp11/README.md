# `src/pdp11/` — PDP-11 CPU, MACRO-11 assembler, disassembler, devices

A self-contained TypeScript library: the PDP-11/40 instruction set (EIS optional), a
MACRO-11 subset assembler, a disassembler, a bus with pluggable memory-mapped devices,
and DEC's console and line clock. No dependencies. Rover is its first user, not its owner.
Design rationale: [`docs/PDP11_CPU.md`](../../docs/PDP11_CPU.md) §14.

Every code block in this file is run by `tests/pdp11/readme-examples.test.ts`, and that
test fails if a block here isn't in it. If you change an example, change both.

## Contents

1. [Which layer to use](#which-layer-to-use)
2. [Conventions](#conventions) (read this first: octal, 16 bits, bytes, cycles)
3. [Quick start](#quick-start)
4. [Assembler](#assembler)
5. [CPU](#cpu)
6. [DeviceMachine and devices](#devicemachine-and-devices)
7. [SimpleMachine](#simplemachine)
8. [Host recipes](#host-recipes): keyboard, coverage, system calls, breakpoints, snapshots, disassembly
9. [Disassembler, ISA tables, CodeMirror](#disassembler-isa-tables-codemirror)
10. [Pitfalls](#pitfalls)
11. [Working on the library](#working-on-the-library) (→ `AGENTS.md`)

## Which layer to use

| You want | Use |
| :--- | :--- |
| Run a program with a console (print, keyboard) and a clock | `SimpleMachine` |
| Your own memory-mapped hardware (sensors, motors, displays) | `DeviceMachine` + your `Device` classes (+ `DL11` / `KW11L` if wanted) |
| Your own memory map, protection, or timing model (as Rover's `src/core/machine/` does) | `Cpu` with your own `Bus` |
| Turn source into bytes, a listing, line numbers | `assemble` |
| Show machine code as text | `disassemble` |
| Syntax highlighting in CodeMirror 6 | `src/pdp11/codemirror.ts` (separate entry point) |

Import everything from `src/pdp11/index.ts` (the only entry point); `codemirror.ts` is a
second, optional one.

## Conventions

- **Octal everywhere, as on the PDP-11.** Addresses, opcodes and register values in
  docs, messages, listings and disassembly are octal. In TypeScript write `0o177564`;
  `octal(n)` formats six digits. In assembler source, numbers are octal unless they end in
  `.` (`10.` = ten).
- **Words are 16-bit unsigned numbers** (0–0xFFFF) in registers, the PSW and bus values;
  bytes are 0–0xFF. Signed meaning comes from the instruction (`n`, `v` flags).
- **Addresses are byte addresses**, little-endian words at even addresses. A word access at
  an odd address traps to 4.
- **The memory map:** RAM from 0 (56 KB by default, to `157777`); the I/O page
  `160000`–`177777` holds device registers; the CPU answers at `177776` (the PSW) itself.
  Vectors live in low memory: two words each (new PC, new PSW) at the vector address.
- **Time is CPU cycles**, never wall-clock. Same program + same inputs at the same cycle
  ⇒ the same run, bit for bit.
- **Bus errors are `BUS_ERROR` (-1)**: any negative `read` result, or `write` returning
  false, makes the CPU trap to 4.
- **Errors in the program are values; mistakes by the host throw.** `assemble` never
  throws (it returns `errors`); the CPU reports traps and stops as `RunResult`s.
  `DeviceMachine.add` (overlap, bad address) and `new KW11L(0)` throw `Error`. An exception
  thrown by your own `Bus` or `Device` code passes through `run`.
- **Determinism rules for contributors:** no DOM, no `Math.random`, no `Date`, no imports
  from outside this folder (`tests/pdp11/boundary.test.ts` enforces the last).

## Quick start

```ts
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
```

## Assembler

`assemble(source: string, options?: AssembleOptions): AssembleResult`

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `origin` | `0o1000` | where the location counter starts |
| `symbols` | none | predefined symbols, `Record<string, number>` or `Map` (device registers, constants); a label of the same name is an error, `NAME = expr` overrides it |
| `names` | `'dec'` | `'dec'`: 1–6 characters of letters, digits, `.`, `$` (longer is an error, not cut). `'long'`: any length, `_` allowed |
| `hex` | `false` | accept `^X` hexadecimal (`^XFF`). Not MACRO-11, so off by default; without it `^X` is an error |

| Result field | |
| :--- | :--- |
| `ok` | `errors.length === 0`. Don't load the image unless `ok` |
| `errors`, `warnings` | `{ line, column, message }[]`, 1-based, sorted; at most one error per line. Warnings don't affect `ok` |
| `origin`, `bytes` | lowest address written and the bytes from there (`Uint8Array`, gaps zero) |
| `start` | `.END expr`, else the first instruction, else `origin` |
| `symbols` | `Map<NAME, value>` of every symbol and label (upper case; local labels and registers excluded) |
| `labels` | `Set<NAME>`: which of `symbols` are labels |
| `lines` | `{ line, address, bytes, code }[]`, the source lines in order with what each produced (`code` = an instruction) |
| `lineAt` | `Map<address, line>` for instructions: highlight the current line in a debugger |
| `listing`, `listingRows` | MACRO-11 style listing as text, and row by row with source lines |

**Syntax.** `label: OP src, dst ; comment`. Names are case-insensitive. `NAME = expr`
(a symbol), `NAME = %3` (a register alias), `. = . + 10` (move the location counter).
Local labels (`1$`, `2$`, …) are scoped between two ordinary labels. Numbers: octal, `10.`
decimal, `^D ^O ^B` radix prefixes, `'A` one character, `"AB` two (low byte first).
Expressions are evaluated strictly left to right (no precedence; `< >` groups) with
`+ - * / & !` (`!` is OR) and unary `-`, `^C` (complement). Addressing modes: `R`, `(R)`,
`(R)+`, `-(R)`, `X(R)`, `@`-forms of each, `#n`, `@#addr`, and a bare `addr` (PC-relative).
Registers `R0`–`R7`, `SP`, `PC`.

**Directives:** `.WORD .BYTE .ASCII .ASCIZ .BLKW .BLKB .EVEN .ODD .END`. The listing
directives `.TITLE .SBTTL .IDENT .ENABL .DSABL .LIST .NLIST .PAGE` are accepted and ignored.

### MACRO-11 compatibility

A **subset of DEC's MACRO-11** (RT-11 / RSX-11) with the same syntax and meaning: programs
inside the subset assemble on a real MACRO-11 too, and listings read the same. Each claim
is tested in `tests/pdp11/macro11.test.ts` and `macro11-compat.test.ts`.

**The same as MACRO-11:**
- Statement format `label: OPCODE operands ; comment`, case-insensitive, commas with or
  without spaces.
- Octal by default, `10.` decimal, `^D ^O ^B`, `^C`, `'A`, `"AB`.
- Strict left-to-right evaluation, no precedence (`1+2*3` is 9), `< >` groups.
- `NAME = expr`, `NAME = %n`, the location counter `.` (`. = . + 10`, `BR .+4`). `LABEL::`
  and `NAME == expr` (the global forms) are accepted as `:` and `=`; there is no linker.
- Local labels `n$` between two ordinary labels; all eight addressing modes with the PC
  forms `#n`, `@#a`, `LABEL`, `@LABEL`.
- `.END expr` sets the start address and ends the source.
- An expression where the instruction goes is an implicit `.WORD`: `TABLE: CMD1, CMD2`,
  `1234`. An instruction name first on a line is always the instruction, and a name
  followed by operands (`MOVV R0, R1`) is "unknown instruction", not data.
- Instruction names are symbols whose value is their opcode: `MOV #NOP, PATCH` stores
  000240. A user symbol of the same name wins (with a warning).
- Flag operations combine with `!`: `CLC!CLV` = 000243 (the disassembler writes them so).
- `SOB` jumps backwards 1–63 words; branches reach −128…+127 words.

**Different from MACRO-11 (deliberately):**
- **Names longer than six characters are an error** with `names: 'dec'`. MACRO-11 keeps
  the first six silently, so `COUNTER1` and `COUNTER2` would be one symbol there.
  `names: 'long'` allows any length and `_`, which MACRO-11 does not.
- **Values that don't fit are errors** (`.BYTE 400`, a branch out of range, `TRAP 400`);
  MACRO-11 flags them in the listing (`T`, `A`) and assembles anyway.
- **Mixing clear and set flag operations** (`CLC!SEV`) is an error; MACRO-11 would quietly
  make it a set.
- **Predefined symbols** (`options.symbols`) stand in for the system macro library
  (`.MCALL`): a label with such a name is an error, `NAME = expr` may reassign one.
- **One absolute section** from `origin`: no relocation, no object file; the output is the
  memory image.
- Errors and warnings are values with line and column, not listing flags. `^X` hex exists
  only with the `hex` option.

**Not supported** (always an error, never silently ignored): macros (`.MACRO .MCALL .IRP
.REPT .NARG`), conditional assembly (`.IF .IIF`), sections and linking (`.PSECT .CSECT
.ASECT .GLOBL .LIMIT`), `.RADIX`, `.RAD50` and `^R`, `.REM`, `.PRINT`, floating point
(`.FLT2 .FLT4`, FP11 instructions), and the instructions missing from the CPU (below).

**Warnings** today: a value cut to 16 bits in `NAME = expr`; a symbol named like an
instruction.

## CPU

`new Cpu(bus: Bus, options?: CpuOptions)`. Usually you get one from a machine (`m.cpu`).

```ts
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
```

`Bus`: `read(addr, byte)` (a word at an even address or a byte; negative = bus error),
`write(addr, value, byte)` (false = bus error), optional `reset()` (the `RESET` instruction).

| Option | Default | |
| :--- | :--- | :--- |
| `eis` | `false` | `MUL`, `DIV`, `ASH`, `ASHC`; without it they trap to 10 |
| `cycles` | `'per-bus-access'` | every bus read or write costs 1 cycle (instruction fetches included), `MUL` +4, `DIV` +8, `ASH`/`ASHC` +1. `'flat'`: 1 per instruction |
| `protectModes` | `false` | PDP-11/45 rules when PSW bits 15–14 ≠ 0: a write to the PSW address traps to 4, `RTI`/`RTT` can't lower the mode bits or change the priority, `RESET` does nothing |

| Member | |
| :--- | :--- |
| `run(maxCycles, breakpoints?, resume = true): RunResult` | runs until a stop (below). May overshoot `maxCycles` by one instruction. `breakpoints`: stop *before* an instruction at one of these addresses; with `resume`, a breakpoint at the current PC is passed first so "continue" works |
| `step(): RunResult` | one instruction, or the pending interrupt. A normal step reports reason `'budget'` |
| `interrupt(vector, level)` | request an interrupt; taken between instructions once `level` > PSW priority (bits 7–5). One-shot: removed when taken; a new request for the same vector replaces the old one |
| `cancelInterrupt(vector)` | withdraw a pending request |
| `onTrap: (t: TrapInfo) => 'vector' \| 'stop'` | called before every trap *and interrupt*. `'stop'`: `run` returns reason `'trap'` and the host handles it. A fault leaves the PC at the faulting instruction; `EMT`/`TRAP`/`BPT`/`IOT` leave it after |
| `onInstruction: (pc, opcode) => void` | every instruction once fetched, before it runs. Not called for a fetch that faults or for interrupts |
| `onModeChange: (mode, old) => void` | PSW bits 15–14 changed (trap, `RTI`, PSW write) |
| `stackLimit` | a push through SP below this address traps to 4 before writing (cause `'stack-limit'`); 0 = off |
| `r` | `number[8]`; `r[6]` = SP, `r[7]` = PC. Writable |
| `psw`, `n` `z` `v` `c`, `priority`, `mode` | status word (writable) and read-only views of it |
| `waiting`, `halted` | asleep in `WAIT`; stopped by `HALT` / double fault (`run` does nothing until you clear it) |
| `save(): CpuState` / `load(state)` / `reset()` | registers, PSW, flags, stack limit and pending interrupts as plain JSON. Not memory, not devices |

`RunResult`: `{ reason, cycles, instructions, trap? }`, `cycles` and `instructions` for
this call only.

| `reason` | Meaning | To continue |
| :--- | :--- | :--- |
| `'budget'` | `maxCycles` used up | `run` again |
| `'wait'` | `WAIT` executed, nothing pending | request an interrupt (or let a device), then `run` |
| `'halt'` | `HALT` | set `cpu.halted = false` (and PC) if you want to go on |
| `'trap'` | `onTrap` returned `'stop'`; `trap` says which | handle it, then `run` |
| `'double-fault'` | a trap's own stack push failed; the CPU halted | reset |
| `'breakpoint'` | PC reached a breakpoint | `run` again (passes it) |

`TrapInfo`: `{ vector, cause, pc, detail? }`. `cause`: `'odd-address' 'bus-error'
'stack-limit'` (vector 4, `detail` = the address), `'illegal'` (10: unknown opcode, EIS
off, `JMP`/`JSR` to a register), `'bpt' 'trace'` (14), `'iot'` (20), `'emt' 'trap'` (30 /
34, `detail` = the number), `'interrupt'`. (`'reserved'` is in the type but not produced.)
Constants: `VEC` (trap vectors), `PSW` (bit masks), `PSW_ADDRESS` (`177776`).

**Instruction set** (`INSTRUCTIONS`, `BY_NAME`, `decodeOp(word)` describe each one):

| Group | Instructions |
| :--- | :--- |
| Double operand | `MOV(B) CMP(B) BIT(B) BIC(B) BIS(B) ADD SUB XOR` |
| Single operand | `CLR(B) COM(B) INC(B) DEC(B) NEG(B) TST(B) ASR(B) ASL(B) ROR(B) ROL(B) ADC(B) SBC(B) SWAB SXT` |
| Branches | `BR BNE BEQ BPL BMI BVC BVS BCC BCS BGE BLT BGT BLE BHI BLOS BHIS BLO` |
| Jumps, subroutines | `JMP JSR RTS SOB` |
| Traps, control | `TRAP EMT BPT IOT RTI RTT WAIT HALT RESET NOP` |
| Flags | `CLC CLV CLZ CLN CCC SEC SEV SEZ SEN SCC`, combinable (`CLC!CLV`) |
| EIS (option) | `MUL DIV ASH ASHC` |

**Cycle model `per-bus-access`:** every trip to memory costs 1 cycle: the instruction
word, each extra word (immediate, address, index), each operand read and each operand
write. Work inside the CPU is free, except EIS: `MUL` +4, `DIV` +8, `ASH`/`ASHC` +1.

| Operand | As source | As destination |
| :--- | :--- | :--- |
| `R` | 0 | 0 |
| `(R)`, `(R)+`, `-(R)` | 1 | read and/or write |
| `@(R)+`, `@-(R)` | 2 (pointer + read) | 1 + read and/or write |
| `X(R)`, `LABEL` | 2 (index word + read) | 1 + read and/or write |
| `@X(R)`, `@LABEL` | 3 | 2 + read and/or write |
| `#n` | 1 | – |
| `@#a` | 2 | 1 + read and/or write |

A destination is only written by `MOV(B)`, `CLR(B)`, `SXT`; only read by `CMP(B)`,
`BIT(B)`, `TST(B)`; read and written by the rest. Examples (tested in
`readme-examples.test.ts`): `MOV R1, R2` 1, `MOV #5, R0` 2, `CLR (R1)` 2, `MOVB (R1)+,
(R2)+` 3, `MOV @2(R1), R0` 4, `INC @#COUNT` 4; branches, `SOB`, `WAIT`, `HALT` 1;
`JSR PC, X` 3, `RTS PC` 2, `RTI` 3; interrupt entry 4, `TRAP` 5 (1 + entry).

**Behaviour matches the real machine:** `MOVB` to a register sign-extends (other byte
instructions leave the high byte alone); byte autoincrement/decrement on SP or PC steps
by 2; writes to the PSW can't set T; `RTI` with T set traps at once, `RTT` one instruction
later; `RESET` calls `bus.reset()`; `JSR PC, @(SP)+` pops the target before pushing
(11/40 order).

**Where it departs from the real machine:** `JMP`/`JSR` to a register traps to 10 (the
models differed; 10 is the illegal-instruction vector). Not implemented: `MARK`, `SPL`,
`MFPI`/`MTPI`, `MFPS`/`MTPS`, floating point, memory management. With `protectModes` the
mode rules are the PDP-11/45's, without its memory management: protect memory yourself by
refusing writes in `bus.write`.

**Hosting the CPU yourself** (your own `Bus`, as Rover does):
- Give `run` a budget per step of your program (a frame, a tick) and subtract
  `RunResult.cycles`: it may overshoot by one instruction.
- You decide when devices interrupt: call `cpu.interrupt` from your own device logic,
  e.g. at the start of a frame. A DEC-style register has `DONE` in bit 7 and `IE` in bit
  6, so programs can test DONE with `TSTB`/`BPL`; `DL11` and `KW11L` in `devices.ts` are
  complete examples.
- Serve traps yourself with `onTrap` (system calls, a supervisor, faults in a sandbox).
- Two programs on one CPU (supervisor and user): keep two `CpuState`s and swap them with
  `save()` / `load()`; `onModeChange` reports mode changes and `protectModes` stops a
  user-mode program from writing the PSW or raising its own mode.

## DeviceMachine and devices

`new DeviceMachine(options?)`: RAM from 0 (`memory`, bytes, default `0o160000`), a CPU
(the other options are `CpuOptions`), and devices. It is the CPU's `Bus`.

| Member | |
| :--- | :--- |
| `add(device): this` | plug in; throws on overlap with RAM, the PSW or another device, or an odd base/size. Calls `device.attach(cpu)` |
| `boot(asm)` | clear RAM, `cpu.reset()`, every `device.reset(true)`, copy `asm.bytes` to `asm.origin`, PC = `asm.start`, SP = `asm.origin` (or `1000` if the origin is below `400`), counters to 0 |
| `run(maxCycles, breakpoints?): RunResult` | like `Cpu.run`, keeping devices in step (see below) |
| `step(): RunResult` | one instruction, devices advanced by its cycles |
| `read(addr, byte)` / `write(addr, value, byte)` | the bus, for the host too. Reading a device register has its side effects (e.g. RBUF clears DONE) |
| `reset()` | the `RESET` instruction: every `device.reset(false)` |
| `cpu`, `ram` (`Uint8Array`), `cycles`, `instructions` | totals since `boot` (writable) |

**`Device` interface.** Offsets are relative to `base`.

| Member | Required | |
| :--- | :--- | :--- |
| `base`, `size` | yes | first bus address and size in bytes, both even, inside the I/O page in practice |
| `read(offset)` | yes | the word at an even offset, or `BUS_ERROR` for a hole. Byte reads get the same call and the bus takes the half (Unibus style), so read side effects happen for byte reads too |
| `write(offset, value, byte)` | yes | a word, or one byte (`value` 0–255; an odd offset is the high byte). Return false for "nothing here" (trap to 4). Real DEC registers ignore writes to their high byte: do the same unless you mean otherwise |
| `attach(cpu)` | no | keep the CPU to call `cpu.interrupt(vector, level)` |
| `reset(powerUp)` | no | `false`: the `RESET` instruction; `true`: power-up at `boot` |
| `advance(cycles)` | no | time passed; may be many cycles at once (a long `WAIT`) |
| `nextEvent()` | no | cycles until the device changes by itself (flag set, interrupt). `run` stops the CPU there so polling programs see it on time. Infinity = never |
| `wakeIn()`, `canWake()` | no | for `WAIT`: cycles until this device interrupts by itself, and whether it can interrupt at all (interrupts enabled; perhaps waiting for host input). A sleeping CPU skips ahead to the soonest `wakeIn`; if no device `canWake`, `run` returns `'wait'` at once |

```ts
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
```

**Included DEC devices.** `new DL11({ base?, vector?, level? })`: serial line, default
the console at `177560` (RCSR, RBUF, XCSR, XBUF), vectors 60 (receive) and 64 (transmit),
level 4. `type(ch)` queues input, `output` collects what the program sent, `onOutput(ch)`
is called per character; the transmitter is always ready. `new KW11L(cycles = 1000)`:
line clock LKS at `177546`, vector 100, level 6; sets DONE every `cycles` CPU cycles and
interrupts if IE. CSR bits: `CSR.DONE` (200), `CSR.IE` (100).

## SimpleMachine

`new SimpleMachine({ memory?, clockCycles = 1000, ...CpuOptions })`: a `DeviceMachine`
with a `DL11` console (`console`) and a `KW11L` clock (`clock`). Adds `type(ch)`,
`output`, `input`, `onOutput` (all from the console) and `clockCycles`. `DEV` has the
register addresses and vectors (`DEV.XBUF`, `DEV.VEC_CLOCK`, …). The standalone
simulator page (`simulator.html`, `src/simulator/`) is built on it. You can `add` more
devices.

## Host recipes

With `m` a `SimpleMachine` booted from a program that waits for a key, reads it into R0
and calls `EMT 7`:

```ts
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
```

## Disassembler, ISA tables, CodeMirror

- `disassemble(readWord: (addr) => number, address, { nameOf? }): { address, words, text }`
  decodes one instruction (1–3 words). Branch and PC-relative targets are absolute
  addresses or `nameOf(addr)`. Unknown words come out as `.WORD 000007`, combined flag
  operations as `CLC!CLV`. Without `nameOf`, the text assembles back to the same words
  (at the same address). Data is decoded
  as instructions too: the disassembler can't tell them apart.
- `INSTRUCTIONS: readonly OpInfo[]`, `BY_NAME: Map<NAME, OpInfo>`, `decodeOp(word):
  OpInfo | null`. `OpInfo`: `{ name, opcode, format, byte?, eis? }`; `format` is one of
  `double single branch jsr rts sob regsrc xor trap none`.
- `octal(n, digits = 6)`: `octal(0o1000)` → `'001000'`.
- CodeMirror 6 (needs `@codemirror/language` and `@lezer/highlight`):
  `import { macro11, macro11Highlight } from './pdp11/codemirror'`, then
  `extensions: [macro11, macro11Highlight]`. It highlights labels (incl. `1$`),
  mnemonics, directives, registers, numbers, strings and comments.

## Pitfalls

- **Set the vector before enabling an interrupt.** Setting IE on a device that is already
  ready (an idle DL11 transmitter, for example) requests the interrupt at once; with an
  empty vector the CPU jumps to address 0 with PSW 0. Write the handler address and PSW
  to `vector` / `vector+2` first, or raise the priority (`MOV #340, @#177776`).
- **Interrupt requests are one-shot.** A device must request again for its next event.
- **The CPU starts at priority 0** after `boot`: every requested interrupt is taken.
- **`boot` sets SP to the program's origin:** the stack grows down from there. A program
  at `1000` has 512 bytes of stack above the vectors.
- **Host reads have side effects** on device registers (RBUF). Read RAM through `m.ram`
  if you only want to look.
- **`cpu.save()` is only the CPU.** For a snapshot also copy `ram`, `cycles`, and your
  devices' state.
- **`run` may overshoot its budget by one instruction** (and a `WAIT` sleep ends at the
  budget). Compare `RunResult.cycles`, don't assume it equals `maxCycles`.
- **Octal literals:** in TypeScript `1000` is decimal; write `0o1000`.
- **Local labels need an ordinary label boundary:** `1$` defined after `LOOP:` is a
  different label from `1$` before it.

## Working on the library

Rules, file map and the change checklist for contributors (people and AI agents) are in
[`AGENTS.md`](AGENTS.md).
