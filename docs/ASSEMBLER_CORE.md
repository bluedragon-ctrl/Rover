# M14 — Assembler core (design draft)

Status: **design approved by the owner** (2026-11-14, §12). **Slice 2 (memory, §7) is
built** (SPEC §5.8): RAM, `VAR`, brackets, `DATA` / `LDF`, the data address space, Mk-I
512 B Flash / 64 B RAM, upload 6 energy per byte, save v17. **Slice 3 is built** (SPEC
§5.9, §3.9.2): devices and `WAIT` (§3–§4), `CALL PROGRAM` / `@SLICE` (§5), the ROM drivers
(§6.2), 8 cycles per tick, the 16-deep data stack, save v18 with the §10 rewrite. Not built
yet: the extended port operand (§9: not needed yet; the retired numbers 30, 33, 34 are
reused first, owner 2026-11-14), the boot ROM / safe mode, and the lessons of slice 4. The
helper routines are built with two scratch registers (§6.1, owner 2026-11-14). Built parts move into [`SPEC.md`](SPEC.md); the plan is in
[`ROADMAP.md`](ROADMAP.md) M14; this file then becomes the player guide, like
[`IMAGE_MEMORY.md`](IMAGE_MEMORY.md).

Decided with the owner so far: hardware is driven through **ports**, not instructions; the
old hardware instructions become **subroutines** in a small **ROM library**; programs may
need rewriting; **memory grows** (sizes in §2); **memory proposal agreed** (RAM, `VAR`,
brackets, `DATA` / `LDF`); `RUN` should feel like a **call** (counterproposal in §5); on
preemption **the firmware decides** what happens to running hardware.

---

## 1. Principle

> The CPU only computes and moves data. Everything physical is a **device** you talk to
> through ports. The ROM holds ready-made subroutines for the common jobs, and you can read
> every one of them.

This is how real machines work: a CPU has no "drive" instruction; it writes numbers into a
device controller's registers and the device does the work. The ROM is the C64 KERNAL or
the PC BIOS of the rover: `CALL STEP EAST 3` is to the rover what `JSR $FFD2` was to a C64.

What stays as it is: the arithmetic and bit instructions, `MOV`, `PUSH` / `POP`, the
compare-and-branch jumps (`JEQ a b label` is how RISC-V and MIPS branch: no flags register),
`CALL` / `RET` with arguments, `LOG`, `BRK`, `END`, `ALIAS`, `CONST`, labels, wrap-around
at the end of a slot, case-insensitive names, 1 cycle per instruction.

## 2. Sizes (Mk-I)

| | Before M14 | M14 Mk-I | Upgrades |
| :--- | :--- | :--- | :--- |
| Flash (firmware + program, shared) | 256 B | **512 B** | 768 / 1024 B |
| RAM (new) | – | **64 B**, zero after a hard reboot | 128 / 256 B |
| Image memory | 256 B | unchanged, now at data address `0x100` | by camera |
| ROM | – | the library (§6), costs no Flash | option ROMs (§6.3) |
| Registers | 4 | 4 | 6 / 8 |
| Cycles per tick | 4 | **8** | 12 / 16 |
| Data stack / call stack | 8 / 8 | 16 / 8 | – |

Device code is longer than one instruction (`CALL STEP d n` is 5 B where `STEP d n` was 3),
so Flash doubles; 8 cycles pay for the calls. Upload cost per byte (`uploadPerByte` 12)
should drop to about 6 so a twice-as-large program costs about the same to send.

## 3. Instructions after M14

| Group | Instructions | Notes |
| :--- | :--- | :--- |
| Data | `MOV`, `PUSH`, `POP` | unchanged; `POP @PORT` is allowed (the ROM drivers use it) |
| Arithmetic, bits | `ADD SUB MUL DIV MOD AND OR SHL SHR` | unchanged |
| Flow | `JMP`, `JEQ JNE JLT JGT JLE JGE`, `CALL`, `RET` | `CALL` also reaches ROM routines and the program (§5) |
| Memory | **`LDB dst [addr]`**, **`STB [addr] src`**, **`LDF dst [addr]`** | load / store only: no other instruction touches memory (a *load/store architecture*, like RISC-V) |
| Devices | **`WAIT @port`** | sleep until the port reads 0; for a device port, then copy the device's result into `@STATUS` |
| Debug, slots | `LOG`, `BRK`, `END` | unchanged (`LOG` = a write to the trace port, like ARM's ITM; `END` = "exit") |

**Removed:** `SLEEP`, `SCAN`, `STEP`, `ACT`, `PEEK`, `USE`, `SNAP`, `SEND`, `ERASE`, `RUN`.
Their names become ROM routines (§6), so `CALL STEP EAST 3` reads almost like before.

### 3.1 `WAIT @port`

* If the port reads non-zero, the CPU sleeps (state `BLOCKED`, the tick ends) and checks
  again at the start of every following tick. It costs no energy while asleep: this is the
  real *wait for interrupt* (`WFI` / `HLT`).
* When the port reads 0: if it is a device's progress port (§4), the device's **result**
  (`OK`, `ERR_BLOCKED`, …) is copied into `@STATUS`; the program continues.
* Any readable port works: `WAIT @ALERT_ETA` sleeps until an announced event starts.
* A busy loop (`w: JNE @DRIVE 0 w`) also works, but burns all 8 cycles of every tick for
  nothing: the classic polling-versus-waiting lesson.

### 3.2 Device writes and `@STATUS`

Writing a device's **start port** is a compute instruction (1 cycle) that also sets
`@STATUS`: `OK` (accepted, the device is now busy) or why it was refused (`ERR_BUSY`,
`ERR_INVALID`, `ERR_LOW_POWER`, `ERR_DEPLOYED`, `ERR_BLOCKED` if the first tile is already
blocked…). This replaces the old rule "hardware instructions write `@STATUS`": now *device
start writes* and *`WAIT`* do. New status code **`ERR_BUSY` = 10**: the device (or one it
is interlocked with) is still working. `ERR_PREEMPTED` = 9 (M13) changes meaning to
**"stopped by a command before it finished"** (§4, drive).

## 4. Devices

Each device has a **start port** (write = start), a **progress port** (read: work left, 0 =
idle; for most devices it is the same port), latched **argument ports** (keep their value
until written again; 1 or 0 after a reboot as listed) and **result ports**. As in real
hardware, a port can mean one thing when written and another when read.

| Device | Arguments (latched) | Start (write) | Progress (read) | Results | Was |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Timer (one **per slot**) | – | `@TIMER` ticks | ticks left | – | `SLEEP` |
| Drive | `@DRIVE_N` tiles (reboot: 1) | `@DRIVE` direction | tiles left | `@X`, `@Y`, `@HEADING` | `STEP` |
| Radar | – | `@RADAR` direction | 1 while sweeping (1 tick) | `@RADAR_HIT`, `@RADAR_DIST` | `SCAN` |
| Tools | `@TOOL_ARG` direction / slot | `@TOOL` hardpoint 0–3 | ticks left | `@SEISMIC_TYPE`, `@SEISMIC_DIST`, cargo | `ACT` |
| Repair | `@REPAIR_SYS` (reboot: `SYS_HULL`) | `@REPAIR` cargo slot | ticks left | `@HULL` … | `USE` |
| Camera | `@CAM_MODE` (reboot: 1) | `@CAM` direction | ticks left | image memory | `SNAP` |
| Image send | – | `@SEND` type (0 = mode of the last `SNAP`) | ticks left | recorder | `SEND` |
| Image erase | – | `@ERASE` any value | ticks left | image memory | `ERASE` |
| Program slice (firmware) | – | `@SLICE` ticks (§5) | ticks left | `@PROG_STATE` | `RUN` |

* **Timings, energy and errors are unchanged** from the instructions they replace (drive
  3–6 ticks and 40–120 energy per tile, radar 1 tick / 10 energy, …).
* **Stopping the drive:** writing `@DRIVE_N` while driving changes the tiles left; `0`
  stops at the end of the current tile, and the drive's result becomes `ERR_PREEMPTED`
  ("stopped"). This is how the firmware "decides" after a preemption (§5.3).
* **Interlocks** (physical): drive, tools, repair and camera share the chassis and the
  arm: one at a time, the others answer `ERR_BUSY`. `@SEND` / `@ERASE` are refused while
  the camera exposes. Radar and timers run alongside anything. So a rover can **scan while
  it drives**, and do arithmetic, logging and memory work while any device runs.
* **Cargo** is memory, not a device: read-only bytes at data address `CARGO` (§7), one
  per slot (`LDB item [CARGO+slot]`, was `PEEK`).
* Ports that stay: everything in SPEC §5.6 except `@TX_DATA` (retired: use `LOG 0`).

## 5. The program as a subroutine (counterproposal for `RUN`)

The owner sees `RUN` as a jump or a call. Proposal: the firmware **calls** the program like
a subroutine, and a **timer interrupt** brings control back. That is how every real
operating system runs a task: call it, and let a timer (ARM's *SysTick*) take the CPU
back when its time is up.

```
        MOV @SLICE 50         ; the program may run for 50 ticks...
        CALL PROGRAM          ; ...call it (or: CALL RUN 50, the ROM does both)
        JEQ @PROG_STATE PROG_READY fw   ; back here: time up, or it returned
```

### 5.1 Rules

* **`CALL PROGRAM`** (firmware only; `PROGRAM` is a reserved call target, like a ROM
  routine). If `@PROG_STATE` is `PROG_READY`: `@STATUS = OK`, the return address goes on
  the firmware's call stack as with any `CALL`, and the **program's context** (its own
  registers, stacks, `@STATUS`, timer) continues where it was, or from `0x000` after a
  restart, **in the same tick** with the cycles left. Otherwise: `@STATUS = ERR_INVALID`
  and nothing happens (as `RUN` today).
* **The program comes back to the firmware** (which continues after its `CALL PROGRAM`)
  when:

  | Why | `@PROG_STATE` | Notes |
  | :--- | :--- | :--- |
  | `END v` anywhere | `PROG_DONE` | `@PROG_RESULT = v` ("exit") |
  | `RET` with its own call stack empty | `PROG_DONE` | `@PROG_RESULT = r0`: "return from main", the calling convention of §6.1 |
  | `@SLICE` reaches 0 (timer interrupt) | `PROG_READY` | `@PREEMPTED = 0`: time up |
  | a `@PREEMPT` condition (M13) | `PROG_READY` | `@PREEMPTED` = the condition bits |
  | fault | `PROG_FAULT` | no watchdog, as today |
  | `BRK` | `PROG_HALTED` | as today |

* **Interrupts happen only at the start of a tick, between instructions.** A program
  sleeping in `WAIT` is simply suspended there; its devices **keep running**. When it is
  called again, the `WAIT` checks again: nothing is lost and nothing is aborted. (M13's
  aborting of actions and `ERR_PREEMPTED` for that are no longer needed.)
* `@SLICE` (RW, writes firmware-only, 0–30000): ticks the program may run; counts down at
  the start of each tick of the call. `0` when calling = no time limit (the program runs
  until it ends or a `@PREEMPT` condition fires: the firmware's watchdog keeps counting).
* `@PROG_STATE` writes (acknowledge, restart) and `@PROG_RESULT` are unchanged.

### 5.2 What gets better

* **Slices are exact.** A program's `SLEEP 2000` (now `CALL SLEEP 2000`) is suspended when
  its slice is up; the firmware gets the CPU back on time, so the M13 watchdog trap ("a
  program that blocks too long starves the firmware") disappears.
* The program is "just a subroutine": the first lesson of how an OS starts programs.
* Firmware dumps taken during a slice show it inside `CALL PROGRAM` (call stack depth 1).

### 5.3 Fault protection after M14

`@PREEMPT`, `@BAT_ALARM` and `@PREEMPTED` stay (M13); a condition now simply interrupts the
program (§5.1). The firmware decides what to do with what was running, e.g.:

```
        JEQ @PREEMPTED 0 more         ; just time up
        MOV @DRIVE_N 0                ; alert or low battery: stop the wheels at the next tile
more:   ...
```

## 6. ROM

A fixed **ROM** (code addresses `0xF000`–`0xFFFF`, about 256 B) that both slots can
`CALL`. It costs no Flash; it runs in the caller's context (its registers, stacks,
`@STATUS`) and costs normal cycles. **Reference → ROM** shows its listing (address, bytes,
source) like any slot, so a player can read exactly what `STEP` does, copy it into their
own code and change it. Routine names are reserved (a label `step` is a compile error).

### 6.1 Calling convention

* Arguments are pushed by `CALL name args…` (unchanged); every routine pops all of them.
* **Drivers use no registers at all**: they pop straight into ports.
* **Helpers** return their result in **`r0`**; they may change **`r0` and `r1`** and keep
  every other register (they save what else they use on the data stack). *Owner decision
  2026-11-14*: "keep everything but `r0`" is impossible for a routine with two or more
  arguments (with `r0` alone it cannot reach the second one), so `r1` is scratch too, like
  ARM's `r0`–`r3`. The same `r0` rule makes a program's top-level `RET` return `r0` to the
  firmware (§5.1).

### 6.2 Contents (v1)

Drivers: the removed instructions, with the same arguments:

```
SLEEP:  POP @TIMER            ; CALL SLEEP ticks
        WAIT @TIMER
        RET

STEP:   POP @DRIVE_N          ; CALL STEP dir tiles (tiles was pushed last: popped first)
        POP @DRIVE            ; dir: starts the drive; @STATUS = accepted, or why not
        JNE @STATUS OK out    ; refused: busy, array open, wall right ahead...
        WAIT @DRIVE           ; until the drive is idle; @STATUS = how it ended
out:    RET

SCAN:   POP @RADAR            ; CALL SCAN dir: the answer stays in @RADAR_HIT, @RADAR_DIST
        JNE @STATUS OK out2
        WAIT @RADAR
out2:   RET
```

`ACT tool arg`, `USE slot system`, `SNAP dir mode`, `SEND type` and `ERASE` follow the
same pattern (pop the arguments into the latched ports, start, check, wait). `RUN ticks`
is `POP @SLICE`, `CALL PROGRAM`, `RET` (firmware only).

Helpers (taken from what the templates and the image guide write by hand today):

| Routine | Does | Replaces |
| :--- | :--- | :--- |
| `DIR_TO dx dy` | `r0` = the direction that reduces the larger of `|dx|`, `|dy|` | Fetch's direction-from-sign code |
| `ABS v` | `r0` = \|v\| | |
| `PUT16 addr v` / `GET16 addr` | store / load a 16-bit big-endian value at a data address | Stamp's `put16` |
| `PLOT x y grey` | set one pixel of a 32×32 2-bpp photo in image memory | Plot's subroutine |

### 6.3 Other uses of the ROM (to decide)

1. **Boot ROM and safe mode.** The ROM receives uploads, checks them and starts the
   firmware. Explains in the fiction why an upload always works, even with broken firmware.
   With it, **safe mode**: after 3 watchdog or fault reboots within 500 ticks, the ROM
   starts a built-in **safe-mode firmware** (dish on the orbiter, charge, heartbeat
   `LOG`) instead of the flash firmware, until mission control uploads a new firmware.
   Real spacecraft do exactly this; it ends boot loops.
2. **Option ROMs.** An upgrade brings the driver for its hardware (Seismic scanner →
   `CALL SEISMIC dir`), like a PC expansion card's option ROM.
3. **Tables.** `LDF` can read ROM: a sine table (`SIN` at a fixed address) lets players
   compute dish or panel angles themselves; a CRC-8 table for checksumming log data.
4. **A deterministic `RAND`**: a 16-bit LFSR whose state lives in the caller's RAM
   (`CALL RAND seedAddr`), so it stays reproducible and saved with RAM.

## 7. Memory

### 7.1 Data address space

| Addresses | What | Access |
| :--- | :--- | :--- |
| `0x000`–`0x03F` | RAM (Mk-I 64 B; upgrades up to `0x0FF`) | read / write |
| `0x100`–`0x4FF` | image memory (256 / 512 / 1024 B by camera) | read / write |
| `0x600`–`0x607` | cargo, one item ID per slot (`CARGO` = `0x600`) | read only |
| anything else | nothing | **fault**: "no memory at 0x…" |

Built-in constants `RAM`, `IMG`, `CARGO` hold the base addresses. Image code moves from
`LDB v addr` to `LDB v [IMG+addr]`; image addresses no longer wrap (a wrong address
faults, which is how real memory bugs show up).

* **RAM is shared** by the firmware and the program, like the one RAM chip of a real
  microcontroller. Both can use absolute addresses to share data (a *mailbox*) or, by
  mistake, to overwrite each other.
* **`VAR name size`** (0 B of Flash) reserves RAM and makes `name` a constant address. The
  assembler places the **program's** `VAR`s from the bottom up and the **firmware's** from
  the top down; if they would overlap it is a compile error naming both sizes (the same
  model as the shared Flash). A RAM bar sits next to the Flash bar.
* RAM is zero after a hard reboot; a program upload does not clear it. `VAR` has no
  initial value: initialise it in code.

### 7.2 Addressing modes (only in `LDB`, `STB`, `LDF`)

| Syntax | Mode | Example |
| :--- | :--- | :--- |
| `[n]` | absolute (a number, `CONST` or `VAR` name) | `LDB r0 [count]` |
| `[r]` | register indirect (a pointer) | `LDB r1 [r2]` |
| `[r+n]`, `[n+r]` | indexed | `STB [IMG+r0] r1`, `LDF r0 [route+r1]` |

### 7.3 Constant data in Flash

```
route:  DATA EAST, EAST, NORTH, NORTH, WEST     ; 5 B of Flash
        LDF r0 [route+r1]                       ; r1 = step number
```

* `DATA v, v, …` emits bytes (−128..255, constants allowed). The assembler collects every
  `DATA` block into the slot's **data section after the code** (like `.rodata`), so code
  still wraps around at its end and never runs into data.
* `LDF dst [addr]` reads one byte of the slot's own Flash (or of ROM at `0xF000`+). The
  listing shows the data section after the code.

## 8. Examples

**First steps**, with the ROM (the template stays this short):

```
ALIAS r0 dir

side:   CALL STEP dir 3           ; ROM: drive 3 tiles in direction dir
        JNE @STATUS OK stuck      ; blocked, hazard, low power...
        ADD dir 1
        JLT dir 4 side
        END 1
stuck:  END 0
```

**What `STEP` really is** (a new lesson right after it): the same square, talking to the
drive yourself:

```
ALIAS r0 dir
        MOV @DRIVE_N 3            ; how far: the drive controller remembers it
side:   MOV @DRIVE dir            ; which way: writing it starts the drive
        JNE @STATUS OK stuck      ; refused? (busy, array open, wall right ahead)
        WAIT @DRIVE               ; sleep until the drive is idle...
        JNE @STATUS OK stuck      ; ...then @STATUS says how it ended
        ADD dir 1
        JLT dir 4 side
        END 1
stuck:  END 0
```

**Explorer**, the scan step:

```
loop:   CALL SCAN dir             ; ROM: one radar sweep
        MOV seen @RADAR_HIT       ; the answer waits in two ports
        MOV dist @RADAR_DIST
        JEQ seen NONE go
        ...
go:     CALL STEP dir 1
```

**Drive and scan at once** (a later lesson): only possible without the shortcut:

```
CONST T_SAMPLE 2
VAR seen 1                        ; samples seen on the way (RAM)

        MOV @DRIVE_N 10
        MOV @DRIVE EAST           ; start a 10-tile drive, do not wait
look:   CALL SCAN NORTH           ; the radar works while the wheels turn
        JNE @RADAR_HIT SAMPLE more
        LOG T_SAMPLE @X
        LDB r0 [seen]
        ADD r0 1
        STB [seen] r0
more:   JNE @DRIVE 0 look         ; tiles left?
        WAIT @DRIVE               ; collect how the drive ended
        LDB r0 [seen]
        RET                       ; return r0 to the firmware: @PROG_RESULT = samples seen
```

*Built in slice 4* as the template *Drive and scan at once*: it keeps the count in `r0` and
counts a sample only when it comes into sight (the sweep before saw something else), since
a sample stays in sight for several sweeps and this sketch would count it once per sweep.

**Default firmware**, the slice: `RUN SLICE` becomes `CALL RUN SLICE` (or
`MOV @SLICE SLICE` + `CALL PROGRAM`); `SLEEP 20` becomes `CALL SLEEP 20`. Estimated size
about 170 B of 512: the shipped programs keep plenty of room.

## 9. Machine code

* New operand forms (the free codes of SPEC §5.7.1): `00011011 pppppppp` **extended port**
  (port numbers 64–319: the devices need more than 64 ports); `00100rrr` `[r]`;
  `00101rrr` + 2 bytes `[r+n]`; `00011100` + 2 bytes `[n]`.
* Code addresses stay 16-bit: `0x000`… own slot, `0xE000` the `PROGRAM` gate, `0xF000`–
  `0xFFFF` ROM. Listing and dumps write `rom:STEP+3`.
* **Opcode numbers:** proposal: reuse the freed one-byte numbers (`0x12` `WAIT`, `0x13`
  `LDF`; `0x14`–`0x18`, `0x1B`, `1F 05`, `1F 06` stay free for later). This breaks the
  "old numbers never change" rule once; it is safe because every save is recompiled and
  rebooted by the migration (§10).

## 10. Migration (save v17)

Old code is rewritten mechanically on load (and in the editor's drafts), then compiled;
both contexts are hard-rebooted (saved IPs do not survive the new encoding):

| Old | New |
| :--- | :--- |
| `SLEEP t` | `CALL SLEEP t` |
| `STEP d` / `STEP d n` | `CALL STEP d 1` / `CALL STEP d n` |
| `SCAN d -> a b` | `CALL SCAN d` + `MOV a @RADAR_HIT` + `MOV b @RADAR_DIST` |
| `ACT t` / `ACT t a` | `CALL ACT t 0` / `CALL ACT t a` |
| `USE s` / `USE s y` | `CALL USE s SYS_HULL` / `CALL USE s y` |
| `SNAP d` / `SNAP d m` | `CALL SNAP d 1` / `CALL SNAP d m` |
| `SEND` / `SEND t`, `ERASE` | `CALL SEND 0` / `CALL SEND t`, `CALL ERASE` |
| `PEEK s -> d` | `LDB d [CARGO+s]` |
| `LDB d a` / `STB a v` | `LDB d [IMG+a]` / `STB [IMG+a] v` |
| `RUN t` | `CALL RUN t` |
| `MOV @TX_DATA v` | `LOG 0 v` |

A label on a rewritten line stays on its first line. Programs that relied on image
addresses wrapping, or on aborted actions (M13), may behave differently: the load message
says so.

## 11. Plan (slices)

1. **This draft** → owner review → SPEC / ROADMAP.
2. **Memory:** RAM, `VAR`, brackets, `DATA` / `LDF`, the data address space, image memory
   and cargo in it; RAM bar; save v17 part 1.
3. **Devices and ROM:** device ports and per-device actions in the engine (replaces the one
   action per rover), interlocks, `WAIT`, `ERR_BUSY`, `CALL PROGRAM` / `@SLICE`, the ROM
   and its listing, removal of the old instructions, extended port operands, migration.
4. **Teaching:** templates rewritten as lessons (*First steps*, *What STEP really is*,
   *Count with a variable*, *A route in DATA*, *Drive and scan at once*, …), the image guide
   on `[IMG+…]`, Reference sections *CPU*, *Devices*, *ROM*, *Memory map*; tests.
5. Optional, after review: safe mode (§6.3.1), option ROMs, ROM tables.

## 12. Decisions (owner, 2026-11-14)

1. **Opcode numbers:** reuse the freed one-byte numbers once (§9).
2. **RAM:** shared by both slots, `VAR`s from both ends (§7.1). Overwriting the other slot's
   memory, or running past the end, is allowed: a real-life bug to learn from.
3. **`CALL PROGRAM`** starts the program in the same tick, like a real call (§5.1).
4. **`@SLICE 0`** = no time limit: allowed.
5. A top-level **`RET` returns `r0`** as the result, besides `END v` (§5.1).
6. **`LOG` stays an instruction** (the trace port).
7. **Image memory bounds** (owner: "suggest"): an address outside mapped memory **faults**,
   as everywhere in the data address space (§7.1). Consistent with 2.
8. **ROM extras** (owner: "suggest"): M14 builds the **boot ROM with safe mode**
   (§6.3.1): it ends boot loops, which matter more now that the watchdog exists. Option
   ROMs, tables and `RAND` stay ideas for later (the generic `ACT` driver already covers
   the seismic scanner).
9. **Upload cost per byte** 12 → 6.
