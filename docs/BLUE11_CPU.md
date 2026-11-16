# M15 — Blue-11: the CPU (design, built)

Status: **built; M15 complete** (slice 6, 2026-11-16). Design approved with the decisions of
§0 (2026-11-15). Slice 2 built the library (§14); slice 3 Rover's bus, devices, gate and
interrupts (§14.4); slice 4 the ROM, default firmware and lessons, the cycle budget measured
(§14.5, Mk-I 64); slice 5 the UI (§14.6); slice 6 switched the game over, deleted Rover-ASM
and named the computer **Blue-11** (§14.7).
Companion document: [`BLUE11_IO.md`](BLUE11_IO.md), which covers the device
registers, the I/O page and interrupts from devices.

This document replaces Rover-ASM (SPEC §5, [`ASSEMBLER_CORE.md`](ASSEMBLER_CORE.md)) with
a 16-bit CPU, the **Blue-11**, modelled on DEC's classic 16-bit minicomputer and programmed in
**Blue-11 assembly**, a subset of DEC's original assembler syntax. The world, devices, renderer, console look, downlink and the
firmware / program split stay. The CPU, assembler, ROM, shipped code and the CPU parts of
the UI are rewritten from scratch.

## 0. Owner decisions (2026-11-15)

1. **Rewrite** the language, VM and control layer from scratch rather than tune Rover-ASM
   further. The game is a proof of concept; the visuals and console look stay.
2. **Target: a classic DEC-style 16-bit ISA** ("simpleness, readability and elegance"). RISC-V, MIPS
   and x86 were considered and set aside (§13).
3. **Saves: reset.** No migration from Rover-ASM saves (§12).
4. **Simplified call gate** between firmware and program, not the original's full
   kernel / user modes with memory management (§7).
5. **Cycles are charged per bus access**, as on the real machine (§4). *Interpretation of
   the owner's "Cycle": to confirm.*
6. **Octal** is the default radix, as in the original assembler; a trailing `.` means decimal (§3.3).
7. **Multiply and divide are ROM subroutines** (shift-and-add, shift-and-subtract) that
   show how it is done; hardware `MUL` / `DIV` come with the **EIS** upgrade (§9).
8. **Interrupts** (not polling only): a line clock every tick and device interrupts (§8,
   [`BLUE11_IO.md`](BLUE11_IO.md) §5).
9. **Two documents**: this one (CPU) and [`BLUE11_IO.md`](BLUE11_IO.md) (I/O).
10. **64 KB addressable, not all installed at first**: the rover starts with a small core
    and memory boards add more (§6.1).
11. **The CPU and assembler are a standalone library** (`src/blue11/`) that other
    projects could reuse; everything Rover-specific stays outside it (§14).

Owner answers to §16 (2026-11-15, second round):

12. **Cycles per bus access** confirmed (decision 5 is no longer "to confirm").
13. **Program base fixed per chassis** (`PRGBAS`), no re-linking.
14. **Memory on reboot: the images are reloaded** from "disk" (as §6.2 describes).
15. **Program interrupt handlers: firmware only in v1.**
16. **`TRAP n` is a system call:** it goes through vector `034` to a firmware handler,
    which may serve it and `RTI` back into the program (§7.3).
17. **DEC names: at most six characters**, letters, digits, `.` and `$`; no `_`. Longer
    names are an assembler error rather than silently cut to six (two names that agree in
    their first six letters would otherwise be the same symbol). Every predefined name in
    [`BLUE11_IO.md`](BLUE11_IO.md) must be renamed to fit (slice 3).
18. **Photos switch to little-endian**, the CPU's byte order.
19. **A standalone simulator page** (`simulator.html`) is built with the library in slice 2:
    editor, registers and flags, memory, console, step / run / breakpoints. It proves the
    library stands alone and lets the owner try the CPU before it is in the game.

M14 is frozen where it is: its last item (boot ROM with safe mode) is not built in
Rover-ASM. It moves into this milestone's ROM (§10).

## 1. Principle

> A small, honest computer. Eight registers, one address space, memory reached through
> eight addressing modes, devices reached through memory. Every instruction is one to
> three 16-bit words whose fields you can read in octal.

The original machine (1970) is the one Unix and C grew up on; C's `*p++` is its
autoincrement mode. It is small enough to learn whole and regular enough that the
instruction set fits on one card. We take its instruction set, encoding, flags, traps and
assembler syntax as they were, and change only what the game needs (§11 lists every
departure).

## 2. The machine

| | Mk-I | Notes |
| :--- | :--- | :--- |
| Word | 16 bits, bytes addressable, **little-endian** | as the original machine |
| Registers | `R0`–`R5` general, `R6` = `SP`, `R7` = `PC` | always 8; the register-file upgrades go (§12) |
| Flags | `N Z V C` in the processor status word `PSW` | §5 |
| Address space | **64 KB**, one space for code, data, stacks and devices | most of it empty at first (§6.1) |
| Core installed (code + data) | **Mk-I 2 KB** proposed (was 512 B Flash + 64 B RAM) | memory boards 4 / 8 KB, room for up to 32 KB; to tune |
| Cycles per tick | **64** (owner, after the slice 4 measurement, §14.5) | was 8; overclock upgrades ×1.5 / ×2 = 96 / 128 |
| Stacks | in memory, through `SP` (no fixed depth) | was 16 data + 8 call entries |
| Contexts | firmware and program, each with its own `R0`–`R7` and `PSW` | §7 |

Word accesses must use **even addresses**. A word access to an odd address is a bus
error (trap to 4), as on the real machine.

## 3. Assembler: Blue-11 assembly (a subset of the original assembler)

### 3.1 Lines

```
label:  OPCODE  src, dst        ; comment
```

* **Source before destination**: `MOV #5, R0` puts 5 into R0. `CMP a, b` computes
  `a − b` and sets the flags (so `CMP R0, #10` / `BLT` means "R0 < 10").
* Names: **one to six** letters, digits, `.` and `$` (not starting with a digit),
  case-insensitive, as in the original assembler (decision 17). A seventh character is an error,
  not silently dropped.
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
(`OK`, `E.BLK`, …), directions and tile names are **predefined symbols**, like DEC's
system macro library. Reference lists them; [`BLUE11_IO.md`](BLUE11_IO.md) defines them.

**Expressions** are evaluated strictly **left to right**, with `< >` for grouping, as in
the original assembler: `2+3*4` is 20, `2+<3*4>` is 14. Operators: `+ - * /`, `&` (and), `!` (or).
Players meet this once and remember it; it is part of the period charm.

Not in v1: `.MACRO`, `.PSECT`, `.GLOBL`, conditional assembly. One source file per slot.

### 3.3 Numbers: octal

* `20` is **octal** (16 decimal); `20.` is decimal 20. `^D20`, `^O20` and `^B10100` name
  the radix explicitly; `'A` is the code of a character.
* The listing, dumps, the debugger and Reference show **words as six octal digits**.
  This is the point of octal on the original machine: the instruction fields are three bits wide,
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
(mode 0, R2). A listing (traditional style: address, words, source):

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
| `100000`–`107777` | **image memory** (1 / 2 / 4 KB by camera: photos at double resolution, §6.3) | read / write |
| `110000`–`157777` | nothing | bus error |
| `160000`–`167777` | **ROM** (§10) | read and execute only |
| `170000`–`177777` | **device registers** ([`BLUE11_IO.md`](BLUE11_IO.md) §3) | per register |

* **Mk-I core 2 KB** (§6.1). Default split `PRGBAS` = `002000`: 896 B for the firmware,
  1 KB for the program (open question 3).

### 6.1 Installed memory grows with upgrades

The CPU can **address** 64 KB, but a rover does not start with it. Owner, 2026-11-15:
"64k addressable is fine but not necessarily available from the beginning." Real
The original machines were the same: the address space was fixed, and memory came on boards a
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
  (`.WORD 5`) and any self-modified code are restored, like the original machine booting from disk.
  A program restart (*Run again*) does **not** reload: its memory keeps what it
  changed, so the *Count with a variable* lesson still works (decision 14).
* **Image memory** keeps its M12 rules (non-volatile, cleared by the camera or erase).
  Words are little-endian, and the photo format's 16-bit values become little-endian
  too (decision 18), so `MOV` reads them directly.
* **Cargo** becomes read-only byte registers in the I/O page ([`BLUE11_IO.md`](BLUE11_IO.md)
  §3.6), read with `MOVB CARGO(R1), R0`.

### 6.3 Photos at double resolution (owner, 2026-11-15)

With the Blue-11 the camera doubles its resolution in every mode (`PHOTO_FORMATS_2X` in
`photos.ts`), so photos take four times the bytes; sizes stay powers of two, so a row is a
shift away (64 px × 2 bpp = 16 bytes):

| Mode | Today | Blue-11 | Bytes |
| :--- | :--- | :--- | :--- |
| 1 grey, 2 dithered | 32×32 · 2 bpp | 64×64 · 2 bpp | 1 KB |
| 3 palette | 32×32 · 4 bpp | 64×64 · 4 bpp | 2 KB |
| 4 hi-res | 64×64 · 2 bpp | 128×128 · 2 bpp | 4 KB |
| 5 RGB332 | 32×32 · 8 bpp | 64×64 · 8 bpp | 4 KB |

The image window grows to 4 KB. To keep sending a photo about as long as today, the
downlink and recorder scale too (**approved by the owner, 2026-11-15**; built on the Blue-11
core as a ×2 scale, folded into the chassis values in slice 6): Mk-I link 4 B/tick
(amplifier upgrade 6), recorder 2 KB (upgrades 4 / 8 KB). A base photo, 1080 B on air as
`SNDIMG` messages, then takes about 270 ticks at full signal. Review page: `preview.html?photos2x=1`. In the game since the switch-over
(slice 6), together with little-endian photos.
Software compression (run-length coding before `SNDIMG`) becomes a worthwhile later lesson.

## 7. Firmware, program and the call gate

### 7.1 Two contexts

As today, firmware and program each have their own registers: **`R0`–`R7` and `PSW` per
context**, switched by hardware. This matches the two register sets of the original /45 model.
`PSW` bits 15–14 show which one runs: `00` firmware, `11` program. The firmware's
interrupt handlers are the only code that runs "inside" the program's time (§8).

### 7.2 The gate

The firmware starts or resumes the program by writing **`GO` to `PRGCS`**, the program
control register ([`BLUE11_IO.md`](BLUE11_IO.md) §3.7). The ROM routine `RUN` wraps it:

```
; RUN: let the program run for R0 ticks (0 = no limit). Firmware only.
RUN:    MOV  R0, @#SLICE
        MOV  #GO, @#PRGCS       ; the gate: the program runs from here...
        RTS  PC                 ; ...and the firmware continues here when it comes back
```

* If the program is `P.RDY`, the CPU switches to the program's registers in the same
  tick, with the cycles left. It continues where it was, or from its entry point after a
  (re)start. Otherwise nothing happens and `PRGCS` shows the error.
* **The program comes back** (the firmware continues after its `MOV #GO, @#PRGCS`) when:

  | Why (`PRGCS` reason field) | Program state | Notes |
  | :--- | :--- | :--- |
  | `HALT`, or `RTS PC` from its top level | `P.DONE` | `PRGRES` = the program's `R0` ("exit code") |
  | `SLICE` ran out | `P.RDY` | time up |
  | a `PREMPT` condition (M13) | `P.RDY` | `PRMPTD` = the bits |
  | a fault (§7.3) | `P.FLT` | `PRGER` = which fault, `PRGPC` = where |
  | `BPT` | `P.HLT` | breakpoint, *Continue* resumes after it |
  | (`TRAP n` does not exit: it is a system call, served by the firmware's handler, §7.3) | | |

* **`HALT` ends the program.** On the original machine, `HALT` in user mode is not allowed and
  traps to the kernel; here that trap is "the program has finished". A program's first
  return address points at a ROM stub that holds a `HALT`, so `RTS PC` from the top level
  ends the program the same way (the dump shows that address: nothing is hidden).
* **Handlers in the program's time** (slice 3, owner may veto): the gate swaps the whole
  register set, but an interrupt or `TRAP` during the program swaps only the stack pointer,
  like the original /45 model's kernel and user SPs. The firmware's handler runs on the program's
  `R0`–`R5` (it saves what it uses, the normal rule for handlers) and on the firmware's
  stack; its `RTI` back into program mode restores the program's SP. That is what lets a
  `TRAP` system call read its arguments in `R0` / `R1` and answer in `R0`.
* As today: interrupts and gate exits happen **between instructions**; a program asleep
  in `WAIT` is suspended there; **its devices keep running**. Uploads, *Run again*,
  acknowledging and restarting keep their M10 rules, now through `PRGST`.

### 7.3 Traps and faults

The original machine's trap vectors, used by both contexts:

| Vector | Cause | In the firmware | In the program |
| :--- | :--- | :--- | :--- |
| `004` | bus error: odd address, no memory there, **protection** (write outside its region, a *firmware-only* register), **stack overflow** | vectored; ROM default: reboot (boot reason: fault) | gate exit, `P.FLT` |
| `010` | illegal or reserved instruction (also `MUL` / `DIV` without EIS) | as above | `P.FLT` |
| `014` | `BPT` (breakpoint), and the trace bit `T` (single step) | ROM default: halt and dump (today's `BRK`) | `P.HLT` |
| `020` | `IOT` | reserved | `P.FLT` |
| `030` | `EMT` | reserved for ROM services (later) | `P.FLT` |
| `034` | `TRAP n` | system-call handler | **system call** (decision 16): like an interrupt, the CPU switches to the firmware's registers and runs its vector-`034` handler, which finds `n` in the low byte of the `TRAP` word before the return address, serves it, and `RTI`s back into the program; the ROM default is a program fault |

* **Stack overflow:** each context has a stack limit: the end of its own code and data.
  A push below it traps. The firmware's limit is the original /70 model's register `STKLIM` at
  `177774` (firmware may move it); the program's is set by the loader.
* `HALT` in the firmware stops the whole CPU, like `BRK` today (admin *Continue*).

## 8. Interrupts (CPU side)

Device details, register bits and vectors: [`BLUE11_IO.md`](BLUE11_IO.md) §5.

* **Priority:** `PSW` bits 7–5 (0–7). A request is taken between instructions if its
  level is above the CPU's. Devices request at level 4, the **line clock** at level 6. The
  program always runs at priority 0; the firmware sets its own by writing `PSW`
  (`MOV #340, @#PSW` blocks everything: level 7).
* **Taking one:** push `PSW`, push `PC`, load `PC` and `PSW` from the vector (4 cycles).
  The handler ends with **`RTI`**, which pops them back.
* **During the program:** handlers are firmware code. The CPU switches to the firmware's
  registers, pushes the program's `PC` / `PSW` on the firmware's stack, runs the handler,
  and `RTI` (whose popped `PSW` says "program") switches back. This is exactly what a
  original /45 model did for a user process. The program cannot install handlers in v1
  (vectors are firmware memory; decision 15).
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

The base CPU is the **original /40 model instruction set without its EIS option** (§9.3): no
`MUL` or `DIV`. The early original /20 model had no multiply or divide instructions either;
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

Left out: `MARK`, `MFPI` / `MTPI` (memory management), `SPL` (original /45 model: write `PSW`
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
| Drivers | `STEP SCAN SLEEP ACT USE SNAP SEND ERASE RUN LOG PUTMSG SNDIMG` ([`BLUE11_IO.md`](BLUE11_IO.md) §6) |
| Helpers | `MUL16 DIV16 ABS DIRTO PLOT` (`PUT16` / `GET16` go: a word `MOV` does it) |

As built in slice 4 (`src/core/machine/rom.ts`, about 1.1 KB; the routines' addresses are
predefined, reserved symbols, so a program writes `JSR PC, STEP`):

| Routine | Arguments | Result in `R0` |
| :--- | :--- | :--- |
| `STEP` | `R0` direction, `R1` tiles | drive error (`OK`, `E.BLK`, …) |
| `SCAN` | `R0` direction | radar error; then `RADHIT`, `RADDST` |
| `ACT` | `R0` argument (direction or cargo slot), `R1` hardpoint `F.T0`…`F.T3` | tool error |
| `USE` | `R0` cargo slot, `R1` system `F.HULL` / `F.SOL` / `F.ANT` | repair error |
| `SNAP` | `R0` direction, `R1` mode `F.M1`…`F.M5` | camera error |
| `ERASE` | – | image error |
| `SLEEP` | `R0` ticks (≤ 32767) | `OK` |
| `RUN` | `R0` slice ticks, 0 = no limit (firmware only) | `PRGST` when the program came back |
| `LOG` | `R0` tag, `R1` value | `OK` / `E.FULL`: one `T.LOG` message (tag, value low byte first) on `TX`, all or nothing |
| `PUTMSG` | `R0` type, `R1` body address, `R2` length (kept) | `OK` / `E.FULL` / `E.INV`, all or nothing on `TX` |
| `SEND` | as `PUTMSG` | `OK` / `E.INV`: the same message into the **recorder**; waits for room |
| `SNDIMG` | `R0` photo type 1–5, 0 = the last photo's (`IMGTYP`) | `OK` / `E.INV`: the photo in image memory as `T.IMG` messages into the recorder; waits for room |
| `MUL16` | `R0` × `R1` | low 16 bits; about 70 cycles for × 100. |
| `DIV16` | `R0` / `R1` | quotient, `R1` remainder, `C` = 1 on ÷ 0; about 130 cycles |
| `ABS` | `R0` | \|`R0`\| |
| `DIRTO` | `R0` dx (east +), `R1` dy (north +) | direction along the larger, −1 (`N` set) if both are 0 |
| `PLOT` | `R0` x, `R1` y (0–63), `R2` grey 0–3 (kept) | `OK` / `E.INV`: one pixel of a 64×64 2-bpp photo |

**Safe mode** as built: the host counts fault and watchdog reboots (boot reasons 2, 5, 7) of
the last 500 ticks in `BOOTCT`; the boot ROM sets the latched `SAFE` bit of `BOOTCS` when
there are 3, and while it is set it starts `SAFEFW` in the ROM instead of the firmware: lamp 1
red, a `T.TEXT` "SAFE MODE", dish on the orbiter, array on the sun (stowed for a squall), a
battery `LOG 1` every 50 ticks, never the program. A firmware upload clears `SAFE` and the
count ([`BLUE11_IO.md`](BLUE11_IO.md) §3.7).

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

## 11. Departures from the original machine

1. **Two register sets switched by a gate register** (`PRGCS`), with write protection by
   region. No kernel / user mode machinery and no memory management (owner decision 4).
2. **Cycles count bus accesses**, not microseconds; EIS adds a fixed internal cost.
3. **Interrupts arrive at tick starts**; device vectors and device register addresses are
   ours. Kept real: the trap vectors `004`–`034`, the line clock `177546` / vector `100`,
   `PSW` `177776`, `STKLIM` `177774`, the display register `177570`.
4. Program-mode faults and `HALT` go to the firmware through the gate, not through vectors.
5. ~~Names longer than six characters~~: dropped (decision 17). The library keeps a
   `names: 'long'` option for other projects.
6. No `.MACRO`, `.PSECT`, linker or floating point in v1.
7. Booting copies the images from "disk" on every hard reboot (§6).

In the library of §14, departure 2 and long names are options (the cycle model, long names), as
is EIS; 6 is simply its scope. Departures 1, 3, 4 and 7 are Rover's code around it, so the
library itself behaves like the original machine.

## 12. What happens to today's features

| Today (Rover-ASM) | Blue-11 |
| :--- | :--- |
| 4 registers, upgrades 6 / 8 | 8 always; the register upgrades leave the catalogue (EIS and core size replace them) |
| Flash 512 B + RAM 64 B, upgrades | one core, Mk-I 2 KB, memory boards 4 / 8 KB |
| 8 cycles / tick, overclock 12 / 16 | 64, overclock 96 / 128 |
| data stack 16, call stack 8 | `SP` in memory, stack limit per context |
| `CONST`, `ALIAS`, `VAR`, `DATA` | `=`, `= %n`, `.BLKW` / `.BLKB`, `.WORD` / `.BYTE` |
| `LDB` / `STB` / `LDF`, bracket addresses | `MOVB` / `MOV` with the eight modes |
| ports as operands, `@STATUS` | device registers by address, one status register per device ([`BLUE11_IO.md`](BLUE11_IO.md)) |
| `WAIT @port` | `WAIT` + check, interrupts |
| `CALL name args` / `RET` | `JSR PC, name` / `RTS PC`, arguments in `R0`, `R1` |
| `CALL PROGRAM`, `@SLICE` | `MOV #GO, @#PRGCS`, `SLICE` |
| `END v`, top-level `RET` | `HALT` with `R0`, top-level `RTS PC` |
| `BRK` | `BPT` |
| `LOG tag [v]` (an instruction) | the log device ([`BLUE11_IO.md`](BLUE11_IO.md) §3.5), ROM `LOG` |
| `DIV` / `MOD` by zero → `@STATUS` | `DIV16` returns `C = 1`; EIS `DIV` sets `V` / `C` |
| decimal and hex numbers | octal; `.` for decimal |

**Saves: reset** (owner decision 3). `SAVE_VERSION` jumps; loading an older save explains
that the rover's computer was replaced and offers a new game. CLAUDE.md's "bump and
migrate" rule is suspended for this one change.

**Size check:** today's code is expected to grow about 1.3–2× in bytes (*Drive yourself*,
written out in [`BLUE11_IO.md`](BLUE11_IO.md) §7.1, is 52 B; every template is measured in
slice 4). The default firmware (166 B today) should land near 300 B, well inside 896 B.

## 13. Why not RISC-V, MIPS or x86 (summary of the discussion)

* **RISC-V**: modern and open, but 32-bit, load/store only, no flags; its branch
  immediates are bit-shuffled, so it can't be read by hand.
* **MIPS** (R2000/R3000, New Horizons, PS1): clean, but delay slots and `HI` / `LO`, and
  2–3× today's Flash.
* **x86**: today's Rover-ASM already looks like it, but the encoding is opaque and the
  syntax is split between Intel and AT&T.
* **DEC's 16-bit machine (the Blue-11)**: the smallest distance from Rover-ASM (memory operands, two-operand
  instructions), readable octal encoding, flags, real traps and interrupts, and history.

## 14. Library boundary

Owner decision 11 (2026-11-15): the CPU and its assembler are built as a **self-contained
library** that could be reused in other projects (a tutorial site, a standalone emulator
page, a command-line assembler). Rover is its first user, not its owner.

### 14.1 What goes where

| Library `src/blue11/` | Rover (`src/core/` and the UI) |
| :--- | :--- |
| CPU: registers, `PSW`, the eight addressing modes, the instruction set (§9.3), flags, traps, interrupts, `WAIT` / `HALT` / `RESET` | the memory map (§6): core size, image memory, ROM, write protection |
| Options: EIS on / off, cycle model (per bus access as in §4, or flat), long names and `_` | the I/O page and every device ([`BLUE11_IO.md`](BLUE11_IO.md)) |
| Assembler: Blue-11 assembly (a subset of the original assembler) (§3) → words, listing, symbol table, source line map, errors | predefined symbols (`BAT`, `DRVCS`, `E.BUSY`, directions, tiles) |
| Disassembler and the octal listing format (§3.5) | ROM source: boot, safe mode, handlers, drivers, helpers (§10) |
| Saving and restoring CPU state (plain JSON) | the gate and the two register sets (§7), when interrupts arrive (tick starts) |
| Optional, separate entry point: CodeMirror syntax mode | lessons, Reference, debugger, Comms, saves |

**The gate stays outside the CPU.** Rover keeps two saved CPU states (firmware and
program) and swaps them: `MOV #GO, @#PRGCS` is a bus write that Rover sees and answers by
loading the program's state; a gate exit loads the firmware's. An interrupt during the
program swaps to the firmware before it is taken, and a hook reports when `RTI` pops a
`PSW` whose mode bits say "program", so Rover swaps back. The library knows nothing about
slots, slices or `PRGCS`: it is a plain CPU with options, testable against how the real
machine behaved.

### 14.2 Interface (built in slice 2)

The full reference is [`src/blue11/README.md`](../src/blue11/README.md). In short:

```ts
interface Bus {                       // supplied by the host (Rover: memory + I/O page)
  read(addr: number, byte: boolean): number;            // BUS_ERROR (−1) if nothing answers
  write(addr: number, value: number, byte: boolean): boolean; // false = bus error / protection
  reset?(): void;                     // the RESET instruction
}

const cpu = new Cpu(bus, { eis: false, cycles: 'per-bus-access' });
cpu.run(maxCycles, breakpoints?);     // → { reason: budget | wait | halt | trap | double-fault | breakpoint, cycles, instructions, trap? }
cpu.step();                           // one instruction (debugger)
cpu.interrupt(vector, level);         // the host decides when (Rover: at tick start)
cpu.onTrap = (t) => 'vector' | 'stop';   // Rover: program-mode faults leave through the gate
cpu.onModeChange = (mode, old) => …;  // PSW bits 15–14 changed (RTI, trap, PSW write)
cpu.onInstruction = (pc, opcode) => …; // each instruction once fetched (profiling, coverage)
cpu.stackLimit = 0o1000;              // a push below it traps to 4
cpu.save() / cpu.load(state);         // plain JSON; swapping the two register sets

assemble(source, { origin, symbols, names: 'dec', hex: false });   // hex: opt-in ^X, not standard syntax
// → { ok, errors[{line, column, message}], warnings[same], origin, bytes, start, symbols, labels,
//     lines, lineAt (address → line), listing, listingRows }
disassemble(readWord, address, { nameOf });   // → { address, words, text }
new DeviceMachine({ memory, eis }).add(device);    // RAM + CPU + memory-mapped Device objects
new SimpleMachine({ memory, clockCycles, eis });   // a DeviceMachine with DL11 console + KW11-L clock
```

The PSW answers on the bus at `177776` inside the CPU, as on the original machines. `HALT` stops
`run` with reason `halt` and sets `cpu.halted`; the host decides what it means (for Rover's
program: "finished").

### 14.3 Rules

* **A folder, not a package, for now:** `src/blue11/` with its own `index.ts` (the only
  entry point) and its own tests in `tests/blue11/`. It moves to an npm workspace or its
  own repository only when a second project needs it.
* **No imports from the game.** A test fails if any file in `src/blue11/` imports from
  outside the folder, so the boundary can't erode quietly (like the determinism test).
* **The game's core rules apply inside:** no DOM, no `Math.random`, no wall-clock time,
  integer arithmetic only. The library is deterministic by construction, which helps any
  other user too.
* **Errors are values,** never exceptions thrown into the host: the assembler returns a
  list with line and column; the CPU reports traps and stops.
* **Name for a public release:** decided in slice 6: **Blue-11** (and Blue-11 assembly), with a description of the instruction set in the
  description, to stay clear of DEC's old trademark (held by HP today). Emulators such as
  SIMH use the name freely, so this is caution, not a blocker.

### 14.4 Rover's side, as built in slice 3

`src/core/machine/`: `iopage.ts` (the register table of [`BLUE11_IO.md`](BLUE11_IO.md) §3 over
the unchanged device logic), `symbols.ts` (predefined six-character names, a test checks
each), `rom.ts` (boot, default handlers, `EXIT`), `RoverMachine.ts` (bus, protection, gate,
interrupts at tick starts, saves). The engine ran it when created with a `cpu` option until slice 6; the
game and its UI still use Rover-ASM until slice 6. Tests: `tests/blue11-core.test.ts`
(devices, gate, faults, protection, system calls, output, determinism, save round trips
mid-run and mid-handler).

Decisions taken while building it (owner may veto):

1. **Handlers swap only the SP** (§7.2): see above.
2. **The library got `protectModes`**, the original /45 model's user-mode rules (a real behaviour,
   off by default): in program mode a write to the `PSW` address traps to 4, `RTI` / `RTT`
   can't lower the mode bits or change the priority, `RESET` does nothing. Without it a
   program could leave program mode with a crafted `RTI`.
3. **Boot:** the disk controller (the host) copies both images into core and sets `STKLIM`
   to the end of the firmware image; then the ROM runs: firmware stack at `PRGBAS`, vectors
   `000`–`150` filled with an `RTI` handler, the core probe, the real handlers, line clock
   on, `RTI` to `000200` with `R0` = top of core. **Booting takes 3 ticks** at 48
   cycles: the firmware's first instruction runs in the 4th tick after a reboot (a test keeps
   it at 5 or less). The firmware starts at its first word: `.END` with
   another label is an assembler error for the firmware slot.
4. **`REBOOT` (`177024`, firmware only):** writing a boot reason reboots after the
   instruction. The ROM's bus-error and illegal-instruction handlers use it (new boot reason
   7, *CPU fault*); the log names the fault and its address.
5. **No `TRAP` handler:** vector `034` still pointing at the ROM's `TRPDEF` makes a program
   `TRAP` a fault (`PRGER` = `PF.TRP`); the handler itself never runs.
6. **Names for the new codes:** `PF.ODD` `PF.NXM` `PF.PRO` `PF.STK` `PF.ILL` `PF.IOT`
   `PF.EMT` `PF.TRP` (`PRGER`), `W.DONE` `W.TIME` `W.PRE` `W.FLT` `W.BPT` (`PRGCS` bits 3–1,
   pre-shifted), `PRGBAS`, `IMGBAS`, `READY`, `SOH`, `ETX`.
7. **Budget:** 6 cycles per Rover-ASM cycle of the chassis, so Mk-I gets 48 and the
   overclock upgrades keep ×1.5 / ×2 (`BLUE11.cyclesPerRoverCycle` in `balance.ts`).
8. **The program's stack** starts at the top of core with the ROM's `EXIT` as its return
   address; its stack limit is the end of its image. A restart writes the return address
   again; *Run again* keeps the rest of its memory.
9. **Firmware `HALT` and `BPT`** stop the whole CPU (`HALTED`, admin *Continue*); a double
   fault is a CPU `FAULT` with today's watchdog reboot. Comms dumps of the new CPU come with
   slice 5 (the commands answer "not yet" until then).

### 14.5 Slice 4 as built: ROM, default firmware, lessons (owner may veto)

Files: `src/core/machine/rom.ts` (the ROM, §10), `names.ts` (system names; `symbols.ts` adds
the ROM's entry points and the tiles), `src/core/programs.ts` (default firmware, four
more firmware templates, the 13 program lessons and the 6 image lessons; the Rover-ASM ones
stay in `programs.ts` until slice 6). Tests: `tests/blue11-rom.test.ts` (every routine, photos,
safe mode, saves mid-photo) and `tests/blue11-programs.test.ts` (each template assembles, fits
and runs to its expected result; the measurement below).

Decisions taken while building it:

1. **Argument order:** "what or where" in `R0`, the function code in `R1` (`ACT dir, F.T0`;
   `USE slot, F.HULL`; `SNAP dir, F.M1`), so every driver with a function reads the same.
   M14's `ACT tool arg` had them the other way round.
2. **`SEND` is `PUTMSG` into the recorder** (store and forward, waits for room); `SNDIMG`
   is the photo-specific one.
3. **Photos as messages:** `SNDIMG` writes `T.IMG` messages of 128 pixel bytes (body: type,
   chunk number, chunks, bytes; 135 B each with the frame); a 64×64 grey photo is 8 of them,
   1080 B. Ground puts them back together in order; a missing chunk or a reboot drops the
   photo. The recorder pairs a photo's first chunk with the camera's capture of that type
   when it stores it, as today's send did, and ground calls it *raw* if the bytes are the
   capture's, *edited* if not, *drawn* without a capture.
4. **The photo format and the gallery:** the Blue-11 engine already takes photos at double
   resolution (`Unit.photoFormats`, products marked `x2`); the Gallery and Comms show them
   from slice 5.
5. **The default firmware includes fault protection** (`PR.ALR!PR.BAT`, stop the wheels,
   `L.PRE`): the separate *Fault protection* template merges into it. Its line-clock handler
   does the housekeeping every 8 ticks, also in the middle of a program (dish, array, squall
   stow, link lamp), so the main loop only charges and runs the program. Log tags keep their
   numbers under `L.` names: `L.BAT` 1, `L.PRE` 12, `L.RES` 13, `L.END` 14. New firmware
   lesson *Minimal (the gate only)*. 326 B (the estimate was 300).
6. **Lessons** keep their names, scenarios and results; the Blue-11 versions teach what the
   machine does differently: `INC` on memory (*Count*), autoincrement over a table (*Route*),
   index-deferred `@HEALTH(R2)` instead of a jump per system (*Field repair*), a routine that
   falls into another (*Spiral*), `COM` over words (*Negative*), a word `MOV` from register to
   memory (*Stamp*). *Weather station* reads only `TICKL` (it wraps after 27 sols; its *Try*
   says so).

**Sizes** (program region 1 KB less its return word; firmware region 896 B):

| Code | Bytes | | Code | Bytes |
| :--- | ---: | :--- | :--- | ---: |
| Default firmware | 326 | | Field repair | 70 |
| First steps | 32 | | Fetch supply crate | 70 |
| Drive yourself | 54 | | Spiral | 68 |
| Count with a variable | 62 | | Seismic survey | 96 |
| Route | 55 | | Weather station | 84 |
| Drive and scan at once | 78 | | Image: Line | 32 |
| Explorer | 86 | | Image: Test pattern | 46 |
| Photographer | 44 | | Image: Negative | 42 |
| Prospector | 116 | | Image: Stamp / Plot | 42 / 52 |
| | | | Image: Memory map | 94 |

The largest lesson uses 11 % of the program region.

**Cycle budget measured** (Mk-I 48 cycles a tick, 2000 ticks with the default firmware):

| What | Cycles |
| :--- | :--- |
| Default firmware, idle (clock handler, `SLEEP` loop, heartbeat) | 24 a tick on average, 51 at peak |
| Clock handler, most ticks / every 8th tick | 12 / about 35 |
| A `WAIT` loop in a driver | 5–6 a tick |
| Driving or scanning lessons (Explorer, Prospector) | 34 a tick on average |
| `MUL16` (× 77) / `DIV16` / `DIRTO` / `PLOT` / `LOG` / `PUTMSG` (10 B) | 71 / 128 / 31 / 71 / 41 / 92 |
| `SNDIMG`, one 64×64 photo | about 5450 (≈ 680 a chunk) |

Time the CPU-heavy image lessons take from the start of the program to its end, at three
budgets (ticks):

| Lesson | 48 | 64 | 96 |
| :--- | ---: | ---: | ---: |
| Image: Line | 172 | 113 | 70 |
| Image: Stamp | 178 | 121 | 77 |
| Image: Negative | 243 | 164 | 103 |
| Image: Plot | 315 | 212 | 131 |
| Image: Test pattern | 572 | 391 | 236 |
| Photographer (4 photos; the link sets the pace) | 1685 | 1676 | 1670 |

At 48 the firmware's own work takes half the budget, so a computing program gets about 24
cycles a tick, and a photo-sized loop (1 KB, four times today's) takes several hundred ticks.
**Decided (owner, 2026-11-15): 64 cycles a tick for Mk-I** (`BLUE11.cyclesPerRoverCycle` 8),
overclock ×1.5 / ×2 = 96 / 128. Measured again at 64: the idle firmware takes 24 cycles a
tick (38 %), driving lessons 36, so programs get about 40 cycles a tick and the image lessons
take 113–391 ticks. Driving lessons are paced by the wheels at any budget.

### 14.6 Slice 5 as built: the UI (owner may veto)

Files: `src/ui/toolchain.ts` (what the Code tab, Comms and the debugger need from either core:
language, build, templates, addresses, listing; `RoverBuilds` caches the code on the rover),
`src/ui/ReferenceBlue11.ts`, Blue-11 branches in `CodeWorkspace`, `DebuggerPanel`, `comms.ts`,
`CommsPanel`, `InspectPanel`, `GalleryPanel`; `RoverMachine.stackWords`, `peek`, `ioSnapshot`;
dump frames in `downlink.ts`. Tests: `tests/blue11-dumps.test.ts`, `tests/blue11-ui.test.ts`.

Decisions taken while building it:

1. **How to play it before slice 6:** *Admin → New … world* (or a `?cpu=` URL; both gone since slice 6) started a
   world with the Blue-11 and the default firmware; the autosave keeps its computer
   (`?cpu=` only picks which autosave to resume). The plain URL stays Rover-ASM.
2. **Register dump** (wire kinds 5 firmware / 7 program, 22 B on air): state (1 B, as in
   Rover-ASM dumps), `PSW`, `R0`–`R5`, `SP`, `PC`; **stack dump** (6 / 8): `SP`, a count and up to
   8 words from `SP` towards the stack's base (the firmware's at `PRGBAS`, the program's at the
   top of core). Words low byte first, as in memory. The old kinds 1–4 stay for Rover-ASM.
3. **Breakpoints report themselves** as `BRK` did: `BPT` in the program (`P.HLT`) and a firmware
   `HALT` / `BPT` (the ROM's handler halts) queue a register dump of that context.
4. **Comms names log tags** from the `L.` symbols each slot defines (`L.BAT = 1`), with the lines
   that use them as links. Photo chunks that arrived whole are not listed (the SCI row and the
   Gallery show the photo); broken or incomplete messages always show their bytes.
5. **The debugger never touches the bus:** `peek` reads memory directly and `ioSnapshot`
   computes every register on a copy of the device state (reading `TICKL` latches `TICKH`).
6. **Reference** is generated where a table exists (instruction set, I/O page, ROM routines
   from the comments in the ROM source, symbols, dump formats); the instruction descriptions
   and flags are a table in `ReferenceBlue11.ts` that a test checks against the instruction set.

### 14.7 Slice 6 as built: the switch-over (owner may veto)

* **One core.** `new SimulationEngine()` always runs the machine; the `cpu` option,
  its getter, the `?cpu=` URL and the Admin computer switch are gone. `Unit.cpu` (`CpuStatus`)
  carries power, halts and faults; `Unit.machine` everything else.
* **Deleted:** `src/core/vm/` (compiler, VM, ISA), `migrateSource.ts`, the M14 `rom.ts` and
  `programs.ts` (the Blue-11 one took its name), `ports.ts` (the I/O page reads the world
  itself through `IoContext`), `roverAsmLanguage.ts`, `listing.ts`, the Rover-ASM Reference
  (its shell, Tools and Image tabs stay, rewritten), the Rover-ASM half of `toolchain.ts` and
  every Rover-ASM branch in the UI, dump kinds 1–4, the tests that covered only Rover-ASM.
  The game-rule tests were ported to Blue-11 code (`tests/helpers/rover.ts`).
* **Balance folded in:** the chassis carries the Blue-11 numbers (64 cycles, 2 KB recorder,
  4 B/tick link); `cyclesPerRoverCycle`, `linkScale`, `recorderScale` are gone. Upgrades:
  `CPU_96` / `CPU_128`, `REC_4K` / `REC_8K`, `LINK_6`; the flash, RAM, register and trace
  buffer upgrades left (they had nothing to act on). Memory boards and EIS stay designed,
  not in the catalogue.
* **Saves reset** (decision 3): `SAVE_VERSION` 21 and no migrations; an older save raises
  `OldSaveError`, the game says so and starts a new world (the autosave is cleared).
* **Photos little-endian** (decision 18): the first pixel of a byte in its low bits; the
  ROM's `PLOT` shifts by `(x MOD 4) × 2`. The lessons did not depend on the order.
* **Name (owner, 2026-11-16):** the computer is the **Blue-11**, its language **Blue-11
  assembly**; the trademarked product names are not used as names. the library folder became
  `src/blue11/`, this document and the I/O one `BLUE11_*.md`. The library README and SPEC §5
  say once, factually, which instruction set it implements.
* `flagAnomaly` checks completeness against the photo's own size (`productSize`), not the
  M9 frame size.

## 15. Plan (slices)

1. **Design** (this document and [`BLUE11_IO.md`](BLUE11_IO.md)): ✅ reviewed; decisions in §0.
2. **CPU, assembler and disassembler** as the standalone library `src/blue11/` (§14), with
   tests (instruction set, flags, modes, cycles, traps, interrupts, listing) and the
   boundary test; **the standalone simulator page** `simulator.html` (decision 19).
   ✅ built; nothing in the game changes.
3. **Bus and devices** (Rover's side of §14): the I/O page over the existing device
   logic, interrupts, the gate, the `TRAP` system call; names renamed to six characters;
   the engine runs it behind a switch. Determinism and save round-trip tests. ✅ built
   (§14.4); the recorder registers (`RECBUF`) and `SNDIMG` moved to slice 4.
4. **ROM, default firmware, lessons**: every template rewritten; measure the cycle budget.
   ✅ built (§14.5); recorder registers and `SNDIMG`, safe mode; budget proposal 64 waits
   for the owner.
5. **UI**: editor language, listing, debugger (octal, `NZVC`, `PSW`), Comms dumps,
   Reference (Instructions, Modes, Flags, I/O page, ROM). The simulator's panels are the
   starting point. ✅ built (§14.6), in review.
6. **Switch over**: delete Rover-ASM (`Compiler.ts`, `RoverVM.ts`, `isa.ts`,
   `migrateSource.ts`, the old ROM), reset saves, little-endian photos, rewrite SPEC §5
   and CLAUDE.md. ✅ built (§14.7), with the rename to Blue-11.

## 16. Open questions

Answered on 2026-11-15 (§0, decisions 12–18): cycles, program base, memory on reboot,
program interrupt handlers, `TRAP n`, names, photo byte order. Then (owner, same day):

1. **Budget:** no number yet; **start with a value from the slice 4 measurement and tune
   it in playtests** (expected 32–64). It lives in `balance.ts`. *Measured in slice 4
   (§14.5); the owner set Mk-I to 64.*
2. **Core sizes:** **start with this draft** (2 KB, boards to 4 / 8 KB) and tune prices
   and steps later.
3. **Six-character names for the I/O page:** **DEC style approved**, a family prefix and
   a dot where it helps (`E.BLK`, `SOLHLT`); the rename table comes with slice 3.

No open questions block slice 5. The slice 3 and 4 decisions (§14.4, §14.5) are open to veto;
the budget (64) and the link / recorder sizes of §6.3 are decided.
