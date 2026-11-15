# `src/pdp11/` — a PDP-11 compatible CPU, assembler and disassembler

A small, self-contained library: the PDP-11/40 instruction set (EIS optional), a MACRO-11
subset assembler, a disassembler, and a minimal reference machine. Rover is its first
user, not its owner. Design: [`docs/PDP11_CPU.md`](../../docs/PDP11_CPU.md) §14.

**Rules:** nothing here imports from outside this folder (`tests/pdp11/boundary.test.ts`
enforces it); deterministic and integer-only (no DOM, no randomness, no wall-clock time);
errors are values, never exceptions thrown at the host. `index.ts` is the only entry
point; `codemirror.ts` is a separate, optional one (syntax highlighting).

## CPU

```ts
import { Cpu, BUS_ERROR, type Bus } from './pdp11';

const mem = new Uint8Array(0o160000);
const bus: Bus = {
  read: (a, byte) => (a >= mem.length ? BUS_ERROR : byte ? mem[a] : mem[a] | (mem[a + 1] << 8)),
  write: (a, v, byte) => { if (a >= mem.length) return false; mem[a] = v; if (!byte) mem[a + 1] = v >> 8; return true; },
};
const cpu = new Cpu(bus, { eis: false, cycles: 'per-bus-access' });
cpu.r[7] = 0o1000;            // PC
cpu.r[6] = 0o1000;            // SP
const r = cpu.run(1000);      // { reason, cycles, instructions, trap? }
```

| | |
| :--- | :--- |
| `run(maxCycles, breakpoints?, resume = true)` | runs until the budget, `WAIT`, `HALT`, a stopped trap, a double fault or a breakpoint; may overshoot the budget by one instruction |
| `step()` | one instruction, or the pending interrupt |
| `interrupt(vector, level)` / `cancelInterrupt(vector)` | request / withdraw; taken between instructions when `level` > PSW priority |
| `onTrap = (t) => 'vector' \| 'stop'` | decide per trap; `stop` makes `run` return reason `trap` (faults leave the PC at the instruction) |
| `onModeChange = (mode, old) => …` | PSW bits 15–14 changed |
| `stackLimit` | a push through SP below it traps to 4 (`cause: 'stack-limit'`) |
| `save()` / `load(state)` / `reset()` | plain JSON state |
| `r`, `psw`, `n z v c`, `priority`, `waiting`, `halted` | state |

Options: `eis` (MUL, DIV, ASH, ASHC), `cycles` (below), `protectModes`: the PDP-11/45 rules
for the non-kernel modes (PSW bits 15–14 ≠ 0): a write to the PSW's address traps to 4,
`RTI` / `RTT` can't lower the mode bits or change the priority, `RESET` does nothing.

Cycle model `per-bus-access`: every memory read or write costs 1 (instruction words
included); `MUL` +4, `DIV` +8, `ASH`/`ASHC` +1 internal. `flat`: 1 per instruction.

Behaviour follows the real machine: odd word addresses trap to 4; `MOVB` to a register sign-extends; byte autoincrement on SP/PC steps
by 2; the PSW answers at `177776` (writes can't set T); `RTI` with T set traps at once,
`RTT` delays it one instruction; `RESET` calls `bus.reset()`. `JMP`/`JSR` to a register
traps to 10 (models differed here; 10 is the illegal-instruction vector). Not included: `MARK`,
`SPL`, `MFPI`/`MTPI`, `MFPS`/`MTPS`, floating point, memory management.

## Assembler

```ts
const a = assemble(source, { origin: 0o1000, symbols: { XCSR: 0o177564 }, names: 'dec' });
if (!a.ok) a.errors;          // [{ line, column, message }]
a.bytes; a.origin; a.start;   // the image
a.lineAt.get(pc);             // source line of an instruction
a.listing;                    // MACRO-11 style listing
```

Syntax: `label: OP src, dst ; comment`, `NAME = expr`, `NAME = %3`, `. = . + 10`,
local labels `1$` between two ordinary labels. Numbers are **octal**; `10.` is decimal;
`^D ^O ^B`; `'A`, `"AB`. Expressions run left to right; `< >` groups; `+ - * / & !`,
unary `-`, `^C`. Directives: `.WORD .BYTE .ASCII .ASCIZ .BLKW .BLKB .EVEN .ODD .END`
(`.TITLE` and friends are ignored). Names: `dec` (default) = 1–6 characters of letters,
digits, `.`, `$`; `long` = any length, `_` allowed. Not included: macros, `.PSECT`,
linking, conditional assembly.

## Disassembler

`disassemble(readWord, address, { nameOf })` → `{ address, words, text }`. Branch and
PC-relative targets are shown as absolute addresses, or names from `nameOf`.

## SimpleMachine

RAM from 0 (default 56 KB), a DL11 console (`177560`–`177566`, vectors 60/64) and a KW11-L
line clock (`177546`, vector 100) that ticks every `clockCycles` CPU cycles: deterministic.
`boot(asm)`, `run(cycles)`, `step()`, `type(ch)`, `output`. Used by the tests and the
standalone simulator page (`simulator.html`, `src/simulator/`).
