# M15 — PDP-11 core: the CPU (design draft)

Status: **draft for owner review** (2026-11-15). Documentation only: nothing here is
built yet. Companion document: [`PDP11_IO.md`](PDP11_IO.md), which covers the device
registers, the I/O page and interrupts from devices.

This document replaces Rover-ASM (SPEC §5, [`ASSEMBLER_CORE.md`](ASSEMBLER_CORE.md)) with
a 16-bit CPU modelled on the DEC **PDP-11**, programmed in a subset of DEC's assembler
**MACRO-11**. The world, devices, renderer, console look, downlink and the
firmware / program split stay. The CPU, assembler, ROM, shipped code and the CPU parts of
the UI are rewritten from scratch.

## 0. Owner decisions (2026-11-15)

1. **Rewrite** the language, VM and control layer from scratch rather than tune Rover-ASM
   further. The game is a proof of concept; the visuals and console look stay.
2. **Target: a PDP-11-style ISA** ("simpleness, readability and elegance"). RISC-V, MIPS
   and x86 were considered and set aside (§13).
3. **Saves: reset.** No migration from Rover-ASM saves (§12).
4. **Simplified call gate** between firmware and program, not the full PDP-11
   kernel / user modes with memory management (§7).
5. **Cycles are charged per bus access**, as on the real machine (§4). *Interpretation of
   the owner's "Cycle": to confirm.*
6. **Octal** is the default radix, as in MACRO-11; a trailing `.` means decimal (§3.3).
7. **Multiply and divide are ROM subroutines** (shift-and-add, shift-and-subtract) that
   show how it is done; hardware `MUL` / `DIV` come with the **EIS** upgrade (§9).
8. **Interrupts** (not polling only): a line clock every tick and device interrupts (§8,
   [`PDP11_IO.md`](PDP11_IO.md) §5).
9. **Two documents**: this one (CPU) and [`PDP11_IO.md`](PDP11_IO.md) (I/O).
10. **64 KB addressable, not all installed at first**: the rover starts with a small core
    and memory boards add more (§6.1).
11. **The CPU and assembler are a standalone library** (`src/pdp11/`) that other
    projects could reuse; everything Rover-specific stays outside it (§14).

M14 is frozen where it is: its last item (boot ROM with safe mode) is not built in
Rover-ASM. It moves into this milestone's ROM (§10).

## 1. Principle

> A small, honest computer. Eight registers, one address space, memory reached through
> eight addressing modes, devices reached through memory. Every instruction is one to
> three 16-bit words whose fields you can read in octal.

The real PDP-11 (1970) is the machine Unix and C grew up on; C's `*p++` is its
autoincrement mode. It is small enough to learn whole and regular enough that the
instruction set fits on one card. We take its instruction set, encoding, flags, traps and
assembler syntax as they were, and change only what the game needs (§11 lists every
departure).

## 2. The machine

| | Mk-I | Notes |
| :--- | :--- | :--- |
| Word | 16 bits, bytes addressable, **little-endian** | as the PDP-11 |
| Registers | `R0`–`R5` general, `R6` = `SP`, `R7` = `PC` | always 8; the register-file upgrades go (§12) |
| Flags | `N Z V C` in the processor status word `PSW` | §5 |
| Address space | **64 KB**, one space for code, data, stacks and devices | most of it empty at first (§6.1) |
| Core installed (code + data) | **Mk-I 2 KB** proposed (was 512 B Flash + 64 B RAM) | memory boards 4 / 8 KB, room for up to 32 KB; to tune |
| Cycles per tick | **32–64**, fixed after porting the default firmware | was 8; overclock upgrades ×1.5 / ×2 |
| Stacks | in memory, through `SP` (no fixed depth) | was 16 data + 8 call entries |
| Contexts | firmware and program, each with its own `R0`–`R7` and `PSW` | §7 |

Word accesses must use **even addresses**. A word access to an odd address is a bus
error (trap to 4), as on the real machine.

## 3. Assembler: a MACRO-11 subset

### 3.1 Lines

```
label:  OPCODE  src, dst        ; comment
```

* **Source before destination**: `MOV #5, R0` puts 5 into R0. `CMP a, b` computes
  `a − b` and sets the flags (so `CMP R0, #10` / `BLT` means "R0 < 10").
* Names: letters, digits, `.` and `$`, case-insensitive. They may be longer than
  MACRO-11's six significant characters (§11); `_` is allowed so today's port names keep
  their spelling.
* **Local labels** `1$` … `99$` are valid between two ordinary labels. Loops and branches
  inside a routine use them, so routines don't fight over names like `loop`:

  ```
  MUL16:  ...
  1$:     TST  R1         ; this 1$ belongs to MUL16
  DIV16:  ...
  1$:     ...             ; a different 1$
  ```

### 3.2 Directives and symbols

| Write | Means | Was |
| :--- | :--- | :--- |
| `NAME = 5` | a constant symbol | `CONST NAME 5` |
| `DIR = %1` | a register symbol: `DIR` means `R1` | `ALIAS r1 dir` |
| `.WORD 1, 2, X+4` | 16-bit words | `DATA` (bytes) |
| `.BYTE 1, 2, 377` | bytes | `DATA` |
| `.ASCII /TEXT/`, `.ASCIZ /TEXT/` | characters (`.ASCIZ` adds a 0 byte) | – |
| `name: .BLKW 4` / `.BLKB 10` | reserve 4 words / 8 bytes (zero in the image) | `VAR name 8` |
| `.EVEN` | align to a word boundary after bytes | – |
| `. = . + 20` | move the location counter | – |

Device register names (`BAT`, `DRVCS`, …), bit names (`GO`, `DONE`, …), status codes
(`OK`, `ERR_BLOCKED`, …), directions and tile names are **predefined symbols**, like DEC's
system macro library. Reference lists them; [`PDP11_IO.md`](PDP11_IO.md) defines them.

**Expressions** are evaluated strictly **left to right**, with `< >` for grouping, as in
MACRO-11: `2+3*4` is 20, `2+<3*4>` is 14. Operators: `+ - * /`, `&` (and), `!` (or).
Players meet this once and remember it; it is part of the period charm.

Not in v1: `.MACRO`, `.PSECT`, `.GLOBL`, conditional assembly. One source file per slot.

### 3.3 Numbers: octal

* `20` is **octal** (16 decimal); `20.` is decimal 20. `^D20`, `^O20` and `^B10100` name
  the radix explicitly; `'A` is the code of a character.
* The listing, dumps, the debugger and Reference show **words as six octal digits**.
  This is the point of octal on the PDP-11: the instruction fields are three bits wide,
  so every octal digit is one field (§3.5).
* Port values that people think of in decimal (battery %, angles, tiles) are written with
  a dot in the shipped code: `CMP @#BAT, #20.`

### 3.4 The eight addressing modes

Each operand is a 6-bit field: **mode** (3 bits) and **register** (3 bits).

| Mode | Syntax | Name | Operand is | C equivalent |
| :--- | :--- | :--- | :--- | :--- |
| 0 | `R3` | register | R3 itself | `r3` |
| 1 | `(R3)` | register deferred | the word at address R3 | `*p` |
| 2 | `(R3)+` | autoincrement | the word at R3, then R3 += 2 (1 for bytes) | `*p++` |
| 3 | `@(R3)+` | autoincrement deferred | the word whose address is at R3, then R3 += 2 | `**pp++` |
| 4 | `-(R3)` | autodecrement | R3 −= 2 (1 for bytes), then the word at R3 | `*--p` |
| 5 | `@-(R3)` | autodecrement deferred | R3 −= 2, then the word whose address is at R3 | `**--pp` |
| 6 | `X(R3)` | index | the word at R3 + X (X is the next instruction word) | `p[x]` |
| 7 | `@X(R3)` | index deferred | the word whose address is at R3 + X | `*p[x]` |

The same modes on `PC` (R7) give the four forms everyone uses:

| Syntax | Really | Means |
| :--- | :--- | :--- |
| `#100` | `(PC)+` | **immediate**: the next word is the value |
| `@#BAT` | `@(PC)+` | **absolute**: the next word is the address (device registers, fixed tables) |
| `LABEL` | `X(PC)` | **relative**: the address, as a distance from here (position-independent) |
| `@LABEL` | `@X(PC)` | relative deferred: the word at `LABEL` is a pointer |

And on `SP` (R6) the stack: `MOV R2, -(SP)` pushes, `MOV (SP)+, R2` pops. There are no
`PUSH` / `POP` instructions; they are just addressing modes.

Rule of thumb for players: **`#` is a value, `@#` is an address.** `MOV #BAT, R0` loads
the *address* of the battery register; `MOV @#BAT, R0` loads the battery level.

### 3.5 Encoding, read in octal

`MOV R1, R2` is `010102`: opcode `01` (MOV), source `01` (mode 0, R1), destination `02`
(mode 0, R2). A listing (MACRO-11 style: address, words, source):

```
002000  005001                  CLR  R1
002002  012737  000003  176406  MOV  #3, @#DRVCNT     ; 01 = MOV, 27 = #, 37 = @#
002010  010137  176404          MOV  R1, @#DRVDIR
002014  012737  000001  176400  MOV  #GO, @#DRVCS
002022  105737  176400  2$:     TSTB @#DRVCS          ; 1057 = TSTB, 37 = @#
002026  100402                  BMI  3$               ; 1004 = BMI, offset +2 words
002030  000001                  WAIT
002032  000773                  BR   2$               ; 0004 = BR, offset −5 (373)
```

Formats (all real): double operand `oSSDD`, single operand `ooooDD`, branch `bbbxxx` (8-bit
signed word offset: ±127 words), `JSR R, DD`, `RTS R`, `SOB R, offset` (6-bit backwards).

## 4. Cycles: one per bus access

Every trip to memory costs **1 cycle**: the instruction word, each extra word (an
immediate, an address, an index), each operand read and each operand write. Work inside
the CPU is free.

| Operand | Extra cycles (source) | Extra cycles (destination) |
| :--- | :--- | :--- |
| `R` (mode 0) | 0 | 0 |
| `(R)`, `(R)+`, `-(R)` | 1 read | 1 read and/or 1 write |
| `@(R)+`, `@-(R)` | 2 (pointer + read) | 1 pointer + read / write |
| `X(R)`, `LABEL` | 2 (index word + read) | 1 index word + read / write |
| `@X(R)`, `@LABEL` | 3 | 2 + read / write |
| `#n` | 1 (the word) | – |
| `@#a` | 2 (address + read) | 1 address + read / write |

A destination is **read** if the instruction uses its old value (`ADD`, `INC`, `BIC`,
`CMP`, `TST`, …) and **written** if it changes it (`MOV`, `CLR`, `ADD`, …): `MOV` only
writes, `CMP` / `TST` / `BIT` only read, `ADD` / `INC` do both.

| Instruction | Cycles |
| :--- | :--- |
| `MOV R1, R2` | 1 |
| `MOV #5, R0` | 2 |
| `MOVB (R1)+, (R2)+` | 3 |
| `INC @#COUNT` | 4 |
| `CMP @#BAT, #20.` | 4 |
| branches, `SOB`, `WAIT`, `HALT`, flag instructions | 1 |
| `JSR PC, X` | 3 (fetch, displacement, push) |
| `RTS PC` | 2 (fetch, pop) |
| `RTI` | 3 (fetch, pop PC, pop PSW) |
| interrupt or trap entry | 4 (push PSW, push PC, read the two vector words) |

**Why:** it teaches the real reason registers exist. A value kept in R2 is free; the same
value in memory costs a cycle every time. **Cost:** the budget per tick is retuned once,
after the default firmware has been ported and measured (§16, open question 2).

A `WAIT` costs 1 cycle and then nothing while asleep. Cycles left in a tick are not saved.

## 5. Flags and branches

`N` (negative), `Z` (zero), `V` (overflow), `C` (carry) live in the low bits of `PSW`.
Almost every instruction sets them from its result; branches test them.

```
        CMP  @#BAT, #20.        ; computes BAT − 20, sets N Z V C, stores nothing
        BLT  HOME               ; signed "less than": N xor V
```

| Branch | Taken if | Use |
| :--- | :--- | :--- |
| `BR` | always | |
| `BEQ` / `BNE` | Z / not Z | equal / not equal |
| `BMI` / `BPL` | N / not N | negative / positive; also bit 7 of a byte, bit 15 of a word |
| `BLT` `BGE` `BGT` `BLE` | signed | positions, angles differences |
| `BLO` `BHIS` `BHI` `BLOS` | unsigned (`BLO` = `BCS`, `BHIS` = `BCC`) | addresses, counts, ticks |
| `BVS` / `BVC`, `BCS` / `BCC` | V / C | overflow, carry |

**The gotcha (a real lesson, not a bug to fix):** the flags belong to the *last*
instruction that set them.

```
        CMP  R0, #10.
        MOV  #1, R1             ; MOV sets N and Z too: the CMP's result is gone
        BLT  LESS               ; tests "1 < 0", not "R0 < 10"
```

The fix is ordering (`MOV` before `CMP`). Reference gets a *Flags* box that shows which
instructions change which flags, and the debugger shows `NZVC` live.

## 6. Memory map

One address space, octal addresses:

| Addresses | What | Access |
| :--- | :--- | :--- |
| `000000`–`000177` | **trap and interrupt vectors** (§8), filled by the boot ROM | firmware writes; program reads |
| `000200`–`PRGBAS−1` | **firmware**: code, data, its stack (grows down from `PRGBAS`) | firmware |
| `PRGBAS`–core top | **program**: code, data, its stack (grows down from the top) | program and firmware |
| core top – `077777` | **not installed** (memory boards fill it, §6.1) | bus error (trap 4) |
| `100000`–`101777` | **image memory** (256 / 512 / 1024 B by camera) | read / write |
| `102000`–`157777` | nothing | bus error |
| `160000`–`167777` | **ROM** (§10) | read and execute only |
| `170000`–`177777` | **device registers** ([`PDP11_IO.md`](PDP11_IO.md) §3) | per register |

* **Mk-I core 2 KB** (§6.1). Default split `PRGBAS` = `002000`: 896 B for the firmware,
  1 KB for the program (open question 3).

### 6.1 Installed memory grows with upgrades

The CPU can **address** 64 KB, but a rover does not start with it. Owner, 2026-11-15:
"64k addressable is fine but not necessarily available from the beginning." Real
PDP-11s were the same: the address space was fixed, and memory came on boards a
customer bought as needed.

* **Mk-I: 2 KB of core** (`000000`–`003777`). **Memory-board upgrades** take it to 4 KB
  (`007777`) and 8 KB (`017777`). The map leaves room for up to 32 KB below image memory,
  should a later chassis want it. Prices and steps get tuned in playtests.
* **Addresses with nothing installed are a bus error** (trap 4): `MOV @#10000, R0` on a
  Mk-I faults with "no memory at 010000". The ROM, image memory and the I/O page are
  always there, whatever core is installed.
* **The boot ROM finds the size itself**, the way DEC's boot and diagnostic code did. It
  reads one word per 1 KB block upward, catches the first bus error, and passes the top
  of core to the firmware in `R0`. The probe is a dozen readable lines in Reference →
  ROM: a first look at a trap handler.
* **A new board adds to the program's region.** `PRGBAS` stays where it was, and the
  program's stack starts at the new top. A firmware and program that fit before still
  fit, so nothing has to be reassembled.
* **What else is fitted, not built in:** the EIS instructions (§9.2), the camera's image
  memory (256 / 512 / 1024 B), cargo slots, tools. An upgrade fills in hardware the
  address map already has a place for.

### 6.2 Rules

* **Code and data share memory.** Tables in code are read with `MOV`; `LDF` disappears.
  A program can modify its own code: a real retro technique and a real bug source.
* **Write protection** (the only protection; there is no memory management): the program
  may write its own region, image memory and the device registers not marked
  *firmware only*. Any other write traps (protection fault, §7.3). Reads are allowed
  everywhere, so a player can read the firmware and the ROM.
* **Boot loading:** the uploaded images are kept on the rover ("on its disk"). A hard
  reboot runs the boot ROM, which **copies both images into core**, so initial values
  (`.WORD 5`) and any self-modified code are restored, like a PDP-11 booting from disk.
  A program restart (*Run again*) does **not** reload: its memory keeps what it
  changed, so the *Count with a variable* lesson still works (open question 4).
* **Image memory** keeps its M12 rules (non-volatile, cleared by the camera or erase).
  Words are little-endian; the photo format's 16-bit values are big-endian, so code
  that reads them as words needs `SWAB`. That's a small byte-order lesson, or a reason to
  change the photo format (open question 9).
* **Cargo** becomes read-only byte registers in the I/O page ([`PDP11_IO.md`](PDP11_IO.md)
  §3.6), read with `MOVB CARGO(R1), R0`.

## 7. Firmware, program and the call gate

### 7.1 Two contexts

As today, firmware and program each have their own registers: **`R0`–`R7` and `PSW` per
context**, switched by hardware. This matches the two register sets of the PDP-11/45.
`PSW` bits 15–14 show which one runs: `00` firmware, `11` program. The firmware's
interrupt handlers are the only code that runs "inside" the program's time (§8).

### 7.2 The gate

The firmware starts or resumes the program by writing **`GO` to `PRGCS`**, the program
control register ([`PDP11_IO.md`](PDP11_IO.md) §3.7). The ROM routine `RUN` wraps it:

```
; RUN: let the program run for R0 ticks (0 = no limit). Firmware only.
RUN:    MOV  R0, @#SLICE
        MOV  #GO, @#PRGCS       ; the gate: the program runs from here...
        RTS  PC                 ; ...and the firmware continues here when it comes back
```

* If the program is `PROG_READY`, the CPU switches to the program's registers in the same
  tick, with the cycles left. It continues where it was, or from its entry point after a
  (re)start. Otherwise nothing happens and `PRGCS` shows the error.
* **The program comes back** (the firmware continues after its `MOV #GO, @#PRGCS`) when:

  | Why (`PRGCS` reason field) | Program state | Notes |
  | :--- | :--- | :--- |
  | `HALT`, or `RTS PC` from its top level | `PROG_DONE` | `PRGRES` = the program's `R0` ("exit code") |
  | `SLICE` ran out | `PROG_READY` | time up |
  | a `PREEMPT` condition (M13) | `PROG_READY` | `PREEMPTED` = the bits |
  | a fault (§7.3) | `PROG_FAULT` | `PRGER` = which fault, `PRGPC` = where |
  | `BPT` | `PROG_HALTED` | breakpoint, *Continue* resumes after it |
  | `TRAP n` | `PROG_READY` | a request to the firmware (optional, open question 6) |

* **`HALT` ends the program.** On a real PDP-11, `HALT` in user mode is not allowed and
  traps to the kernel; here that trap is "the program has finished". A program's first
  return address points at a ROM stub that holds a `HALT`, so `RTS PC` from the top level
  ends the program the same way (the dump shows that address: nothing is hidden).
* As today: interrupts and gate exits happen **between instructions**; a program asleep
  in `WAIT` is suspended there; **its devices keep running**. Uploads, *Run again*,
  acknowledging and restarting keep their M10 rules, now through `PRGST`.

### 7.3 Traps and faults

Real PDP-11 trap vectors, used by both contexts:

| Vector | Cause | In the firmware | In the program |
| :--- | :--- | :--- | :--- |
| `004` | bus error: odd address, no memory there, **protection** (write outside its region, a *firmware-only* register), **stack overflow** | vectored; ROM default: reboot (boot reason: fault) | gate exit, `PROG_FAULT` |
| `010` | illegal or reserved instruction (also `MUL` / `DIV` without EIS) | as above | `PROG_FAULT` |
| `014` | `BPT` (breakpoint), and the trace bit `T` (single step) | ROM default: halt and dump (today's `BRK`) | `PROG_HALTED` |
| `020` | `IOT` | reserved | `PROG_FAULT` |
| `030` | `EMT` | reserved for ROM services (later) | `PROG_FAULT` |
| `034` | `TRAP n` | reserved | `TRAP` exit, or `PROG_FAULT` (open question 6) |

* **Stack overflow:** each context has a stack limit: the end of its own code and data.
  A push below it traps. The firmware's limit is the real PDP-11/70 register `STKLIM` at
  `177774` (firmware may move it); the program's is set by the loader.
* `HALT` in the firmware stops the whole CPU, like `BRK` today (admin *Continue*).

## 8. Interrupts (CPU side)

Device details, register bits and vectors: [`PDP11_IO.md`](PDP11_IO.md) §5.

* **Priority:** `PSW` bits 7–5 (0–7). A request is taken between instructions if its
  level is above the CPU's. Devices request at level 4, the **line clock** at level 6. The
  program always runs at priority 0; the firmware sets its own by writing `PSW`
  (`MOV #340, @#PSW` blocks everything: level 7).
* **Taking one:** push `PSW`, push `PC`, load `PC` and `PSW` from the vector (4 cycles).
  The handler ends with **`RTI`**, which pops them back.
* **During the program:** handlers are firmware code. The CPU switches to the firmware's
  registers, pushes the program's `PC` / `PSW` on the firmware's stack, runs the handler,
  and `RTI` (whose popped `PSW` says "program") switches back. This is exactly what a
  PDP-11/45 did for a user process. The program cannot install handlers in v1
  (vectors are firmware memory; open question 5).
* **When:** the world moves in ticks, so requests arrive at the **start of a tick**, before
  its first instruction (as `@SLICE` and `@PREEMPT` do today).
* **`WAIT`** sleeps until the next interrupt is taken, then continues after the `WAIT`
  once the handler's `RTI` is done. The boot ROM enables the line clock with a handler
  that just returns, so **`WAIT` wakes at least once per tick**. That makes the classic
  missed-wake-up race cost one tick instead of hanging. The pattern is always "wait, then
  check again":

  ```
  1$:     WAIT                    ; sleep until something happens (next tick at the latest)
          TSTB @#DRVCS            ; drive done (bit 7)?
          BPL  1$                 ; not yet
  ```

* **Cost:** the clock's default handler costs about 7 cycles per tick (entry 4 + `RTI` 3).
  The budget is tuned with it included.

## 9. Multiply and divide: ROM routines, then the EIS upgrade

The base CPU is the **PDP-11/40 instruction set without its EIS option** (§9.3): no
`MUL` or `DIV`. The early PDP-11/20 had no multiply or divide instructions either;
programs called routines like these.
They are in the ROM, readable in Reference → ROM:

```
; MUL16: R0 = R0 × R1 (low 16 bits; the same for signed and unsigned).
; Changes R1 (allowed by the convention: R0 and R1 are scratch). Keeps R2 on the stack.
MUL16:  MOV  R2, -(SP)          ; save R2
        CLR  R2                 ; R2 = running sum
1$:     TST  R1                 ; multiplier used up?
        BEQ  3$
        CLC                     ; shift R1 right, with a 0 coming in at the top
        ROR  R1                 ;   ...its lowest bit lands in the carry flag
        BCC  2$                 ; bit was 0: nothing to add
        ADD  R0, R2             ; bit was 1: add the shifted multiplicand
2$:     ASL  R0                 ; multiplicand × 2
        BR   1$
3$:     MOV  R2, R0             ; result in R0
        MOV  (SP)+, R2          ; restore R2
        RTS  PC
```

```
; DIV16: R0 = R0 / R1, R1 = remainder (unsigned). C = 1 if R1 was 0 (R0, R1 unchanged).
DIV16:  TST  R1
        BNE  1$
        SEC                     ; divide by zero: report it in the carry flag
        RTS  PC
1$:     MOV  R2, -(SP)
        MOV  R3, -(SP)
        MOV  R1, R2             ; R2 = divisor
        CLR  R1                 ; R1 = remainder, built up bit by bit
        MOV  #16., R3           ; 16 quotient bits
2$:     ASL  R0                 ; next dividend bit out of R0...
        ROL  R1                 ;   ...into the remainder
        BCS  4$                 ; a 17th bit: certainly >= divisor
        CMP  R1, R2             ; remainder >= divisor? (unsigned)
        BLO  3$
4$:     SUB  R2, R1             ; yes: subtract...
        INC  R0                 ;   ...and the quotient bit is 1
3$:     SOB  R3, 2$             ; 16 times
        MOV  (SP)+, R3
        MOV  (SP)+, R2
        CLC
        RTS  PC
```

### 9.1 Cost

* `MUL16` costs 7–8 cycles per bit of the multiplier: `× 100.` (7 bits) is about 65.
* `DIV16` costs about 150. Players feel that dividing is expensive, which is the real
  lesson (it is why programmers shift instead).
* Division by zero no longer touches a status port: the caller tests `BCS`. That is how
  the EIS `DIV` reports it too.

### 9.2 The EIS upgrade

The **Extended Instruction Set** (a real option board) adds `MUL`, `DIV`, `ASH` (shift by
n) and `ASHC` (shift a register pair). Their cycles are the usual bus accesses plus a
fixed internal cost (`MUL` +4, `DIV` +8, shifts +1), a departure from "inside the CPU is
free" so they are not *too* fast: still about 10× faster than the ROM. Without the board
they trap to vector `010` (a program fault). Later idea: a firmware trap handler that
emulates them with `MUL16` / `DIV16`, so the same program runs on both rovers, slower,
as real systems did.

### 9.3 The instruction subset

| Group | Instructions |
| :--- | :--- |
| Double operand | `MOV(B) CMP(B) BIT(B) BIC(B) BIS(B) ADD SUB XOR` |
| Single operand | `CLR(B) COM(B) INC(B) DEC(B) NEG(B) TST(B) ASR(B) ASL(B) ROR(B) ROL(B) ADC(B) SBC(B) SWAB SXT` |
| Branches | `BR BNE BEQ BPL BMI BVC BVS BCC BCS BGE BLT BGT BLE BHI BLOS BHIS BLO` |
| Jumps, subroutines | `JMP JSR RTS SOB` |
| Traps, control | `TRAP EMT BPT IOT RTI RTT WAIT HALT RESET NOP` |
| Flags | `CLC CLV CLZ CLN CCC SEC SEV SEZ SEN SCC` |
| EIS (upgrade) | `MUL DIV ASH ASHC` |

Left out: `MARK`, `MFPI` / `MTPI` (memory management), `SPL` (PDP-11/45: write `PSW`
instead), floating point. `RESET` is firmware-only (it resets every device: drive stops,
CSRs to their reboot state). `MOVB` into a register sign-extends; `CLRB` / `BISB` don't
touch the high byte: both are real and both are lessons.

## 10. ROM

At `160000`, about 1 KB, read and execute only, readable in Reference → ROM with the
listing format of §3.5.

| Part | Contents |
| :--- | :--- |
| Boot | reset, vectors with defaults, load the images (§6), set both stacks, line clock on, jump to the firmware at `000200`; **safe mode** (from M14 §6.3: after 3 fault or watchdog reboots in 500 ticks, run a built-in safe firmware) |
| Default handlers | clock: `RTI`; bus error / illegal: reboot; `BPT`: halt and dump |
| Program stub | `EXIT: HALT`, the return address a program starts with |
| Drivers | `STEP SCAN SLEEP ACT USE SNAP SEND ERASE RUN LOG` ([`PDP11_IO.md`](PDP11_IO.md) §6) |
| Helpers | `MUL16 DIV16 ABS DIRTO PLOT` (`PUT16` / `GET16` go: a word `MOV` does it) |

**Calling convention:** `JSR PC, NAME`. Arguments in **`R0`, `R1`** (a third in `R2`,
which is kept); the result in **`R0`**; `R0` and `R1` are scratch, every other register
is kept (same rule as M14). Drivers return the device's error code in `R0` (`OK` = 0) and
leave the flags from it, so the caller writes:

```
        MOV  R2, R0             ; direction
        MOV  #3, R1             ; tiles
        JSR  PC, STEP           ; R0 = OK or why not
        BNE  STUCK              ; Z is set only if R0 = OK
```

## 11. Departures from the real PDP-11

1. **Two register sets switched by a gate register** (`PRGCS`), with write protection by
   region. No kernel / user mode machinery and no memory management (owner decision 4).
2. **Cycles count bus accesses**, not microseconds; EIS adds a fixed internal cost.
3. **Interrupts arrive at tick starts**; device vectors and device register addresses are
   ours. Kept real: the trap vectors `004`–`034`, the line clock `177546` / vector `100`,
   `PSW` `177776`, `STKLIM` `177774`, the display register `177570`.
4. Program-mode faults and `HALT` go to the firmware through the gate, not through vectors.
5. Names longer than six characters, and `_` in names.
6. No `.MACRO`, `.PSECT`, linker or floating point in v1.
7. Booting copies the images from "disk" on every hard reboot (§6).

In the library of §14, departures 2 and 5 are options (the cycle model, long names), as
is EIS; 6 is simply its scope. Departures 1, 3, 4 and 7 are Rover's code around it, so the
library itself stays a plain PDP-11.

## 12. What happens to today's features

| Today (Rover-ASM) | PDP-11 core |
| :--- | :--- |
| 4 registers, upgrades 6 / 8 | 8 always; the register upgrades leave the catalogue (EIS and core size replace them) |
| Flash 512 B + RAM 64 B, upgrades | one core, Mk-I 2 KB, memory boards 4 / 8 KB |
| 8 cycles / tick, overclock 12 / 16 | 32–64, overclock ×1.5 / ×2 |
| data stack 16, call stack 8 | `SP` in memory, stack limit per context |
| `CONST`, `ALIAS`, `VAR`, `DATA` | `=`, `= %n`, `.BLKW` / `.BLKB`, `.WORD` / `.BYTE` |
| `LDB` / `STB` / `LDF`, bracket addresses | `MOVB` / `MOV` with the eight modes |
| ports as operands, `@STATUS` | device registers by address, one status register per device ([`PDP11_IO.md`](PDP11_IO.md)) |
| `WAIT @port` | `WAIT` + check, interrupts |
| `CALL name args` / `RET` | `JSR PC, name` / `RTS PC`, arguments in `R0`, `R1` |
| `CALL PROGRAM`, `@SLICE` | `MOV #GO, @#PRGCS`, `SLICE` |
| `END v`, top-level `RET` | `HALT` with `R0`, top-level `RTS PC` |
| `BRK` | `BPT` |
| `LOG tag [v]` (an instruction) | the log device ([`PDP11_IO.md`](PDP11_IO.md) §3.5), ROM `LOG` |
| `DIV` / `MOD` by zero → `@STATUS` | `DIV16` returns `C = 1`; EIS `DIV` sets `V` / `C` |
| decimal and hex numbers | octal; `.` for decimal |

**Saves: reset** (owner decision 3). `SAVE_VERSION` jumps; loading an older save explains
that the rover's computer was replaced and offers a new game. CLAUDE.md's "bump and
migrate" rule is suspended for this one change.

**Size check:** today's code is expected to grow about 1.3–2× in bytes (*Drive yourself*,
written out in [`PDP11_IO.md`](PDP11_IO.md) §7.1, is 52 B; every template is measured in
slice 4). The default firmware (166 B today) should land near 300 B, well inside 896 B.

## 13. Why not RISC-V, MIPS or x86 (summary of the discussion)

* **RISC-V**: modern and open, but 32-bit, load/store only, no flags; its branch
  immediates are bit-shuffled, so it can't be read by hand.
* **MIPS** (R2000/R3000, New Horizons, PS1): clean, but delay slots and `HI` / `LO`, and
  2–3× today's Flash.
* **x86**: today's Rover-ASM already looks like it, but the encoding is opaque and the
  syntax is split between Intel and AT&T.
* **PDP-11**: the smallest distance from Rover-ASM (memory operands, two-operand
  instructions), readable octal encoding, flags, real traps and interrupts, and history.

## 14. Library boundary

Owner decision 11 (2026-11-15): the CPU and its assembler are built as a **self-contained
library** that could be reused in other projects (a tutorial site, a standalone emulator
page, a command-line assembler). Rover is its first user, not its owner.

### 14.1 What goes where

| Library `src/pdp11/` | Rover (`src/core/` and the UI) |
| :--- | :--- |
| CPU: registers, `PSW`, the eight addressing modes, the instruction set (§9.3), flags, traps, interrupts, `WAIT` / `HALT` / `RESET` | the memory map (§6): core size, image memory, ROM, write protection |
| Options: EIS on / off, cycle model (per bus access as in §4, or flat), long names and `_` | the I/O page and every device ([`PDP11_IO.md`](PDP11_IO.md)) |
| Assembler: MACRO-11 subset (§3) → words, listing, symbol table, source line map, errors | predefined symbols (`BAT`, `DRVCS`, `ERR_BUSY`, directions, tiles) |
| Disassembler and the octal listing format (§3.5) | ROM source: boot, safe mode, handlers, drivers, helpers (§10) |
| Saving and restoring CPU state (plain JSON) | the gate and the two register sets (§7), when interrupts arrive (tick starts) |
| Optional, separate entry point: CodeMirror syntax mode | lessons, Reference, debugger, Comms, saves |

**The gate stays outside the CPU.** Rover keeps two saved CPU states (firmware and
program) and swaps them: `MOV #GO, @#PRGCS` is a bus write that Rover sees and answers by
loading the program's state; a gate exit loads the firmware's. An interrupt during the
program swaps to the firmware before it is taken, and a hook reports when `RTI` pops a
`PSW` whose mode bits say "program", so Rover swaps back. The library knows nothing about
slots, slices or `PRGCS`: it is a plain PDP-11 with options, testable against how the real
machine behaved.

### 14.2 Interface (sketch)

```ts
interface Bus {                       // supplied by the host (Rover: memory + I/O page)
  read(addr: number, byte: boolean): number | 'bus-error';
  write(addr: number, value: number, byte: boolean): void | 'bus-error';
}

const cpu = new Cpu(bus, { eis: false, cycles: 'per-bus-access' });
cpu.run(maxCycles);                   // stops at the budget, WAIT or HALT; reports why and the cycles used
cpu.step();                           // one instruction (debugger)
cpu.interrupt(vector, level);         // the host decides when (Rover: at tick start)
cpu.onModeChange = (mode) => { … };   // RTI / trap changed PSW bits 15–14 (Rover's gate)
cpu.save() / cpu.load(state);         // saves, and swapping register sets

assemble(source, { origin, symbols, longNames: true });
// → { words, listing, symbols, lines, errors }
disassemble(words, address);
```

The names are a sketch; slice 2 settles them.

### 14.3 Rules

* **A folder, not a package, for now:** `src/pdp11/` with its own `index.ts` (the only
  entry point) and its own tests in `tests/pdp11/`. It moves to an npm workspace or its
  own repository only when a second project needs it.
* **No imports from the game.** A test fails if any file in `src/pdp11/` imports from
  outside the folder, so the boundary can't erode quietly (like the determinism test).
* **The game's core rules apply inside:** no DOM, no `Math.random`, no wall-clock time,
  integer arithmetic only. The library is deterministic by construction, which helps any
  other user too.
* **Errors are values,** never exceptions thrown into the host: the assembler returns a
  list with line and column; the CPU reports traps and stops.
* **Name for a public release:** a neutral name with "PDP-11 compatible" in the
  description, to stay clear of DEC's old trademark (held by HP today). Emulators such as
  SIMH use the name freely, so this is caution, not a blocker.

## 15. Plan (slices, after approval)

1. **Design** (this document and [`PDP11_IO.md`](PDP11_IO.md)): owner review.
2. **CPU, assembler and disassembler** as the standalone library `src/pdp11/` (§14), with
   tests (instruction set, flags, modes, cycles, traps, listing) and the boundary test.
   Nothing in the game changes.
3. **Bus and devices** (Rover's side of §14): the I/O page over the existing device
   logic, interrupts, the gate;
   the engine runs it behind a switch. Determinism and save round-trip tests.
4. **ROM, default firmware, lessons**: every template rewritten; measure the cycle budget.
5. **UI**: editor language, listing, debugger (octal, `NZVC`, `PSW`), Comms dumps,
   Reference (Instructions, Modes, Flags, I/O page, ROM).
6. **Switch over**: delete Rover-ASM (`Compiler.ts`, `RoverVM.ts`, `isa.ts`,
   `migrateSource.ts`, the old ROM), reset saves, rewrite SPEC §5 and CLAUDE.md.

## 16. Open questions

1. **Cycles:** charge per bus access (this draft) or a flat 1 per instruction?
2. **Budget:** cycles per tick for Mk-I, measured in slice 4 (expected 32–64).
3. **Program base:** a fixed `PRGBAS` per chassis (simplest), or the firmware declares it
   (the assembler re-links the program when a new firmware moves it)?
4. **Memory on reboot:** reload the images from "disk" (this draft), or core keeps
   everything (authentic core memory: self-modified code survives reboots)?
5. **Program interrupt handlers:** firmware-only in v1 (this draft), or a program vector
   table later?
6. **`TRAP n` from the program:** a "system call" to the firmware (it may serve it and
   resume), or simply a fault in v1?
7. **Core sizes:** 2 KB to start, boards to 4 / 8 KB (this draft), their prices, and whether
   a later chassis goes further (up to 32 KB fits the map).
8. **Names:** keep `_` and long names (this draft), or DEC's six-character style?
9. **Photo byte order:** keep big-endian (a `SWAB` lesson) or switch to little-endian?
