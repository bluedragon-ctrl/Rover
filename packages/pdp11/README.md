# pdp11: a PDP-11 compatible CPU, assembler and disassembler

A small TypeScript library that emulates the **DEC PDP-11/40 instruction set** (the EIS
option included, off by default) and assembles a **subset of MACRO-11**, DEC's assembler (what is compatible and what isn't:
[MACRO-11 compatibility](#macro-11-compatibility)).
You bring the machine around it: memory, devices, timing. The library gives you the CPU,
the assembler, a disassembler, an optional CodeMirror syntax mode and a tiny reference
machine.

* **No runtime dependencies.** CodeMirror is an optional peer dependency, used only by the
  `pdp11/codemirror` entry point.
* **Deterministic and integer-only.** There is no randomness, no wall-clock time and no
  floating point: the same program and inputs give the same run, so states can be saved,
  replayed and compared.
* **Errors are values.** The assembler returns a list of errors with line and column. The
  CPU reports traps and stops. Nothing throws into your code.
* **Plain JSON state.** `cpu.save()` / `cpu.load()` let you swap contexts, save games or
  snapshot a debugger.

AI coding agents: read [`AGENTS.md`](AGENTS.md) before changing anything here. Changes are
listed in [`CHANGELOG.md`](CHANGELOG.md).

| Entry point | What |
| :--- | :--- |
| `pdp11` | `Cpu`, `assemble`, `disassemble`, `SimpleMachine`, instruction tables, types |
| `pdp11/codemirror` | `macro11` (a CodeMirror 6 language) and `macro11Highlight` |
| `pdp11/examples` | `EXAMPLES` (seven console programs, each tested) and `SIM_SYMBOLS` |

The first user of this library is the game Rover, which builds a whole rover computer on
it. The library itself knows nothing about Rover.

---

## Quick start: assemble and run

```ts
import { assemble, SimpleMachine } from 'pdp11';

const asm = assemble(`
START:  MOV  #MSG, R1
1$:     MOVB (R1)+, R0          ; next character (autoincrement)
        BEQ  2$                 ; 0 ends the string
3$:     TSTB @#XCSR             ; console ready? (bit 7)
        BPL  3$
        MOVB R0, @#XBUF         ; print it
        BR   1$
2$:     HALT
MSG:    .ASCIZ /HELLO/
`, { symbols: { XCSR: 0o177564, XBUF: 0o177566 } });

if (!asm.ok) throw new Error(asm.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
const m = new SimpleMachine();
m.boot(asm);                    // copy the image into RAM, PC = start, SP below it
m.run(10_000);                  // → { reason: 'halt', cycles, instructions }
m.output;                       // 'HELLO'
```

Numbers in MACRO-11 are **octal** unless they end in a dot: `10` is eight and `10.` is ten.
`octal(n)` from the library formats a number the same way (`octal(8) === '000010'`).

---

## Host your own machine

`SimpleMachine` is only an example. A real host implements the `Bus` interface and decides
four things: what answers at each address, how many cycles the CPU gets per step of your
program, when devices request interrupts, and which traps the host serves itself. The
complete version of the code below is [`examples/host.ts`](examples/host.ts), and
`tests/host.test.ts` runs it.

```ts
import { assemble, BUS_ERROR, Cpu, type Bus } from 'pdp11';

const LAMP = 0o170000;          // a device register: write-only lamp

class TinyHost implements Bus {
  ram = new Uint8Array(0o10000);
  lamp = 0;
  cpu = new Cpu(this, { cycles: 'per-bus-access' });

  // 1. The bus. Return BUS_ERROR (or false) where nothing answers: the CPU traps to 4.
  read(a: number, byte: boolean): number {
    if (a < this.ram.length) return byte ? this.ram[a] : this.ram[a] | (this.ram[a + 1] << 8);
    if (a === LAMP) return this.lamp;
    return BUS_ERROR;
  }
  write(a: number, v: number, byte: boolean): boolean {
    if (a < this.ram.length) { this.ram[a] = v & 0xff; if (!byte) this.ram[a + 1] = v >> 8; return true; }
    if (a === LAMP) { this.lamp = v & 0xffff; return true; }
    return false;
  }

  // 2.-4. Time, interrupts and traps the host serves itself.
  frame(cycles: number) {
    let left = cycles;
    while (left > 0 && !this.cpu.halted) {
      const r = this.cpu.run(left);
      left -= r.cycles;
      if (r.reason === 'trap' && r.trap?.cause === 'trap') {
        serveSystemCall(r.trap.detail!, this.cpu.r[0]); // TRAP n: n in detail, PC already past it
        continue;
      }
      break;                    // 'wait', 'halt', 'budget', 'breakpoint', ...
    }
    this.cpu.interrupt(0o100, 6); // a clock: taken at the start of the next frame
  }
}

const h = new TinyHost();
h.cpu.onTrap = (t) => (t.cause === 'trap' ? 'stop' : 'vector');
const asm = assemble(source, { origin: 0o1000, symbols: { LAMP } });
h.ram.set(asm.bytes, asm.origin);
h.cpu.r[7] = asm.start;         // PC
h.cpu.r[6] = 0o1000;            // SP: the stack grows down
```

Things worth knowing when you build a host:

* **Words are little-endian** and must be at even addresses. An odd word address traps to
  4 before the bus is asked.
* **Device registers are just addresses.** A DEC-style device has a control/status register
  (CSR) with `DONE` in bit 7 and `IE` (interrupt enable) in bit 6, and data registers next
  to it. `TSTB` / `BPL` test bit 7 without a mask. `SimpleMachine` (`src/machine.ts`) has
  two complete examples: the DL11 console and the KW11-L line clock.
* **You decide when interrupts happen.** Call `cpu.interrupt(vector, level)` when a
  device wants one. It is taken between instructions once `level` is above the PSW
  priority (bits 7–5). `cancelInterrupt(vector)` withdraws it. A program asleep in `WAIT`
  makes `run` return `'wait'`; the next interrupt wakes it.
* **Keep time in cycles, not wall-clock time.** Give `run` a budget per step (a frame or a
  tick). It may overshoot by the last instruction, so subtract `r.cycles`.
* **`onTrap` lets the host take over any trap** (system calls, a supervisor, faults in a
  sandboxed context). Return `'stop'` and `run` returns `{ reason: 'trap', trap }`. Faults
  leave the PC at the faulting instruction; `EMT`, `TRAP`, `BPT` and `IOT` leave it after.
  Return `'vector'` for the normal trap through memory.
* **Two programs on one CPU** (for example a supervisor and a user program): keep two
  `CpuState`s and swap them with `save()` / `load()`. `onModeChange` reports PSW mode
  changes (`RTI`, traps), and `protectModes` stops a non-kernel program from writing the
  PSW or raising its own mode.
* **A stack limit:** set `cpu.stackLimit`. A push through SP below it traps to 4
  (`cause: 'stack-limit'`) before anything is written.

---

## CPU reference

```ts
const cpu = new Cpu(bus, { eis: false, cycles: 'per-bus-access', protectModes: false });
```

| Member | |
| :--- | :--- |
| `r` | R0–R7 as 16-bit unsigned numbers (R6 = SP, R7 = PC) |
| `psw`, `n z v c`, `priority`, `mode` | processor status word and its parts |
| `waiting`, `halted` | asleep in `WAIT`; stopped by `HALT` or a double fault (`run` does nothing until you clear it) |
| `stackLimit` | 0 = none; a push below it traps to 4 |
| `run(maxCycles, breakpoints?, resume = true)` → `RunResult` | runs until the budget is used, `WAIT`, `HALT`, a stopped trap, a double fault, or a PC in `breakpoints` (`resume`: don't stop on the breakpoint you are at) |
| `step()` → `RunResult` | one instruction, or one pending interrupt |
| `interrupt(vector, level)` / `cancelInterrupt(vector)` | request / withdraw a device interrupt |
| `onTrap = (t: TrapInfo) => 'vector' \| 'stop'` | called before any trap or interrupt is taken |
| `onModeChange = (newMode, oldMode) => void` | PSW bits 15–14 changed |
| `save()` → `CpuState` / `load(state)` / `reset()` | plain JSON state (registers, PSW, waiting, halted, stack limit, pending interrupts); `reset` is power-up |

`RunResult`: `{ reason, cycles, instructions, trap? }`, where `reason` is one of:

| `StopReason` | |
| :--- | :--- |
| `budget` | `maxCycles` used |
| `wait` | `WAIT`: asleep until an interrupt |
| `halt` | `HALT` |
| `trap` | `onTrap` returned `'stop'`; see `trap` |
| `double-fault` | a trap could not push its PC / PSW: the CPU halts |
| `breakpoint` | the PC reached an address in `breakpoints` |

`TrapInfo`: `{ vector, cause, pc, detail? }`. `pc` is the instruction's address (for an
interrupt, the PC it interrupts). `detail` is the bus address for bus errors and the number
for `EMT` / `TRAP`.

| `TrapCause` | Vector | When |
| :--- | :--- | :--- |
| `odd-address` | 004 | word access at an odd address |
| `bus-error` | 004 | the bus returned `BUS_ERROR` / `false`; with `protectModes`, a PSW write from a non-kernel mode |
| `stack-limit` | 004 | a push below `stackLimit` |
| `illegal` | 010 | an unknown opcode, `JMP` / `JSR` to a register, EIS without the option |
| `reserved` | 010 | a reserved instruction |
| `bpt` | 014 | `BPT` |
| `trace` | 014 | the T bit (single step) |
| `iot` | 020 | `IOT` |
| `emt` | 030 | `EMT n` |
| `trap` | 034 | `TRAP n` |
| `interrupt` | yours | a device interrupt you requested |

Constants: `VEC` (the trap vectors above), `PSW` (bit masks `C V Z N T PRIORITY
CURRENT_MODE PREVIOUS_MODE`), `PSW_ADDRESS` (177776: the PSW also answers on the bus, as on
every PDP-11), `BUS_ERROR` (−1).

**Options**

| Option | Default | |
| :--- | :--- | :--- |
| `eis` | `false` | `MUL`, `DIV`, `ASH`, `ASHC`. Without it they trap to 10 |
| `cycles` | `'per-bus-access'` | the cycle model (below); `'flat'` = 1 per instruction |
| `protectModes` | `false` | PDP-11/45 rules for the non-kernel modes (PSW bits 15–14 ≠ 0): a write to the PSW's address traps to 4, `RTI` / `RTT` can't lower the mode bits or change the priority, `RESET` does nothing |

**Cycle model `per-bus-access`:** every trip to memory costs 1 cycle: the instruction word,
each extra word (an immediate, an address, an index), each operand read and each operand
write. Work inside the CPU is free, except that EIS adds `MUL` +4, `DIV` +8 and `ASH` /
`ASHC` +1.

| Operand | Source | Destination |
| :--- | :--- | :--- |
| `R` (mode 0) | 0 | 0 |
| `(R)`, `(R)+`, `-(R)` | 1 read | 1 read and/or 1 write |
| `@(R)+`, `@-(R)` | 2 (pointer + read) | 1 pointer + read / write |
| `X(R)`, `LABEL` | 2 (index word + read) | 1 index word + read / write |
| `@X(R)`, `@LABEL` | 3 | 2 + read / write |
| `#n` | 1 | – |
| `@#a` | 2 | 1 + read / write |

A destination is read if the instruction uses its old value (`ADD`, `INC`, `CMP`, `TST`)
and written if it changes it (`MOV` only writes). Examples: `MOV R1, R2` 1, `MOV #5, R0` 2,
`MOVB (R1)+, (R2)+` 3, `INC @#COUNT` 4, branches / `SOB` / `WAIT` / `HALT` 1, `JSR PC, X` 3,
`RTS PC` 2, `RTI` 3, interrupt or trap entry 4.

**Instruction set** (`INSTRUCTIONS`, `BY_NAME`, `decodeOp(word)` describe each one):

| Group | Instructions |
| :--- | :--- |
| Double operand | `MOV(B) CMP(B) BIT(B) BIC(B) BIS(B) ADD SUB XOR` |
| Single operand | `CLR(B) COM(B) INC(B) DEC(B) NEG(B) TST(B) ASR(B) ASL(B) ROR(B) ROL(B) ADC(B) SBC(B) SWAB SXT` |
| Branches | `BR BNE BEQ BPL BMI BVC BVS BCC BCS BGE BLT BGT BLE BHI BLOS BHIS BLO` |
| Jumps, subroutines | `JMP JSR RTS SOB` |
| Traps, control | `TRAP EMT BPT IOT RTI RTT WAIT HALT RESET NOP` |
| Flags | `CLC CLV CLZ CLN CCC SEC SEV SEZ SEN SCC` |
| EIS (option) | `MUL DIV ASH ASHC` |

**Behaviour follows the real machine:**

* `MOVB` into a register sign-extends; other byte instructions leave the high byte alone.
* Byte autoincrement and autodecrement on SP or PC step by 2.
* The PSW answers at 177776; writes can't set the T bit.
* `RTI` with T set traps at once; `RTT` delays it by one instruction.
* `RESET` calls `bus.reset()`.

**Where it departs from the real machine:**

* `JMP` / `JSR` to a register trap to 10 (the models differed here; 10 is the
  illegal-instruction vector).
* Not included: `MARK`, `SPL`, `MFPI` / `MTPI`, `MFPS` / `MTPS`, floating point, memory
  management.
* With `protectModes` the mode rules are the PDP-11/45's, without its memory management.
  Protection of memory is the host's job: refuse the write in `bus.write`.

---

## Assembler reference

```ts
const a = assemble(source, { origin: 0o1000, symbols: { XCSR: 0o177564 }, names: 'dec' });
```

| Option | Default | |
| :--- | :--- | :--- |
| `origin` | `0o1000` | where the location counter starts |
| `symbols` | none | predefined names (device registers, constants), as an object or a `Map`. A label with one of these names is an error; `NAME = expr` may reassign one |
| `names` | `'dec'` | `'dec'`: 1–6 characters of letters, digits, `.`, `$` (longer is an error, not silently cut); `'long'`: any length, `_` allowed |

| `AssembleResult` field | |
| :--- | :--- |
| `ok`, `errors` | `errors` is `[{ line, column, message }]`, 1-based lines |
| `origin`, `bytes` | the lowest address written and the image from there (gaps are zero) |
| `start` | `.END expr`, else the first instruction, else the origin |
| `symbols` | every symbol and label in upper case with its value (registers not included) |
| `labels` | which of those are labels (not `=` symbols) |
| `lines` | per source line: `{ line, address, bytes, code }` (`code`: an instruction, so a debugger can stop on it) |
| `lineAt` | instruction address → source line |
| `listing`, `listingRows` | a MACRO-11 style listing (address, octal words, source), whole and row by row with each row's source line |

**Syntax:**

* Lines: `label: OP src, dst ; comment`. Symbols: `NAME = expr`, registers `NAME = %3`, the
  location counter `. = . + 10`.
* Local labels such as `1$` are valid between two ordinary labels.
* Numbers are octal; `10.` is decimal; `^D ^O ^B` prefixes; characters `'A` and `"AB`.
* Expressions are evaluated left to right with `+ - * / & !` (`!` is or), unary `-`, `^C`
  (complement); `< >` groups.
* Directives: `.WORD .BYTE .ASCII .ASCIZ .BLKW .BLKB .EVEN .ODD .END`. `.TITLE`, `.SBTTL`,
  `.IDENT`, `.ENABL`, `.DSABL`, `.LIST`, `.NLIST` and `.PAGE` are accepted and ignored.
* The eight addressing modes: `R`, `(R)`, `(R)+`, `@(R)+`, `-(R)`, `@-(R)`, `X(R)`,
  `@X(R)`. With the PC they become `#n`, `@#a`, `LABEL` (PC-relative) and `@LABEL`.
* Not included: macros, `.PSECT`, linking, conditional assembly. The details are in
  "MACRO-11 compatibility" below.

### MACRO-11 compatibility

The assembler accepts a **subset of DEC's MACRO-11** (as on RT-11 and RSX-11) with the same
syntax and meaning, so programs inside the subset assemble on a real MACRO-11 too, and
listings read the same. `tests/macro11.test.ts` checks each point below.

**The same as MACRO-11:**

* The statement format `label: OPCODE operands ; comment`, case-insensitive, operands
  separated by commas with or without spaces.
* Octal by default, a trailing `.` for decimal, the `^D ^O ^B` radix prefixes, `^C`
  (complement), `'A` and `"AB` character constants.
* Strict left-to-right expression evaluation with no operator precedence (`1+2*3` is 9),
  `< >` for grouping, and the operators `+ - * / & !`.
* Direct assignment `NAME = expr`, register symbols `NAME = %n`, the location counter `.`
  (`. = . + 10`, `BR .+4`). `LABEL::` and `NAME == expr` (MACRO-11's global forms) are
  accepted as `:` and `=`, since there is no linker.
* Local labels `n$`, valid between two ordinary labels.
* All eight addressing modes with MACRO-11's operand syntax, including the PC forms `#n`,
  `@#a`, `LABEL` (PC-relative) and `@LABEL`.
* The directives `.WORD .BYTE .ASCII .ASCIZ .BLKW .BLKB .EVEN .ODD .END`. `.END expr` sets
  the start address and ends the source.
* The mnemonics of the PDP-11/40 and the EIS option; `TRAP` / `EMT` numbers 0–377.

**Different from MACRO-11:**

* **Names longer than six characters are an error** (with `names: 'dec'`, the default).
  MACRO-11 silently keeps the first six, so `COUNTER1` and `COUNTER2` would be the same
  symbol there. `names: 'long'` allows any length and `_`, which MACRO-11 does not.
* **Values that don't fit are errors:** `.BYTE 400`, a branch out of range, `TRAP 400`.
  MACRO-11 flags them in the listing (a `T` or `A` error) and assembles anyway.
* **Predefined symbols** (`options.symbols`) play the part of MACRO-11's system macro
  library (`.MCALL`): device registers and constants known before the first line. A label
  with a predefined name is an error; `NAME = expr` may reassign one, as MACRO-11 allows for
  any direct assignment.
* **One absolute section** starting at `origin`: no relocation, no object file, the output
  is the memory image itself.
* Errors come back as values with a line and column, not as listing flags.

**Not supported** (an error, never silently ignored): macros (`.MACRO`, `.MCALL`, `.IRP`,
`.REPT`, `.NARG`), conditional assembly (`.IF`, `.IIF`), program sections and linking
(`.PSECT`, `.CSECT`, `.ASECT`, `.GLOBL`, `.LIMIT`), `.RADIX`, `.RAD50` and `^R`, `.REM`,
`.PRINT`, floating point (`.FLT2`, `.FLT4`, the FP11 instructions) and the instructions
listed under "Where it departs from the real machine". The listing-control directives
`.TITLE .SBTTL .IDENT .ENABL .DSABL .LIST .NLIST .PAGE` are accepted and ignored.

## Disassembler

```ts
disassemble((addr) => readWord(addr), 0o1000, { nameOf: (a) => names.get(a) });
// → { address, words: [012737, 000003, 176406], text: 'MOV #3, @#176406' }
```

Branch and PC-relative targets are shown as absolute addresses, or as names from `nameOf`.
Unknown words come out as `.WORD 000007`. Every instruction round-trips through
`assemble` → `disassemble` (tested).

## SimpleMachine

A complete reference host: RAM from 0 (`memory`, default 56 KB), a **DL11 console** (RCSR /
RBUF / XCSR / XBUF at 177560–177566, vectors 60 / 64) and a **KW11-L line clock** (LKS at
177546, vector 100) that ticks every `clockCycles` CPU cycles (default 1000).

| Member | |
| :--- | :--- |
| `boot(asm)` | load an `AssembleResult`: PC = `start`, SP = the image's origin (the stack grows down below it) |
| `run(cycles, breakpoints?)` / `step()` | as on `Cpu`, with the clock and console running |
| `type(ch)`, `output`, `onOutput` | keyboard input, everything printed, a callback per character |
| `cpu`, `ram`, `cycles`, `instructions` | the parts, and totals since boot |

`DEV` has the device addresses and vectors; `CSR` has the `DONE` / `IE` bits.
`pdp11/examples` exports `SIM_SYMBOLS` (the device names for `assemble`) and `EXAMPLES`
(Hello world, Squares with multiply in software, Fibonacci with the carry flag, Line clock
with interrupts and `WAIT`, Echo with a keyboard interrupt, `TRAP` as a system call, and a
tour of the addressing modes), each with the console output its test expects.

## CodeMirror

```ts
import { macro11, macro11Highlight } from 'pdp11/codemirror';
new EditorView({ extensions: [macro11, macro11Highlight /* , ... */] });
```

It needs `@codemirror/language` and `@lezer/highlight` installed; the main entry point never
loads them.

---

## Working on the library

```bash
npm test             # in this folder: the library's own tests (vitest)
npm run typecheck
```

The tests are the specification:

| Test file | What it checks |
| :--- | :--- |
| `tests/cpu.test.ts` | flags, the addressing modes, the cycle table, traps, interrupts, `WAIT`, the T bit, the stack limit, `protectModes`, save / load |
| `tests/assembler.test.ts` | syntax, errors, the listing, and a round trip of every instruction through the disassembler |
| `tests/examples.test.ts` | every program in `pdp11/examples` runs and prints what it should |
| `tests/host.test.ts` | the host example |
| `tests/macro11.test.ts` | each point of the MACRO-11 compatibility section |
| `tests/readme.test.ts` | the quick start in this README assembles and prints `HELLO` |
| `tests/boundary.test.ts` | nothing imports from outside the package, no randomness, clock or DOM, the declared entry points, no runtime dependencies |

A public release needs a neutral name, with "PDP-11 compatible" in the description: DEC's
trademark is held by HP today. Emulators such as SIMH use the name freely, so this is
caution, not a blocker. It also needs a licence, which the owner has not chosen yet.
