# M15 — PDP-11 core: I/O page, devices and interrupts (design draft)

Status: **draft; CPU side approved** (2026-11-15). Names shrink to six characters, DEC
style (§9, question 1). Framed standard output approved (§3.5a). **Built in slice 3**
(`src/core/machine/iopage.ts`, behind the engine switch; notes in §11); the recorder
registers, safe-mode registers and ROM drivers in slice 4 (§12). Companion of
[`PDP11_CPU.md`](PDP11_CPU.md) (instruction set, memory, call gate, traps, ROM).

This document turns today's 61 ports (`src/core/ports.ts`, SPEC §5.6, M14 devices in
[`ASSEMBLER_CORE.md`](ASSEMBLER_CORE.md) §4) into **device registers** in the PDP-11's
I/O page, using DEC's device conventions. **The device logic stays**:
`SimulationEngine.device()`, `Unit.deviceLeft()`, timings, energy, interlocks, error
reasons and the world. Only the face the program sees changes.

Owner decisions (2026-11-15): **interrupts** (line clock every tick, device interrupts),
not polling only; **two documents**.

## 1. Principle

> The CPU has no I/O instructions. A device is a few words of memory at a fixed address:
> a **control/status register** (CSR) to start it and see how it is doing, and **data
> registers** for its parameters and answers. Every DEC device worked this way.

Today's Rover-ASM already calls this memory-mapped I/O, but gives ports names instead
of addresses and shares one `@STATUS` among all devices. Here every register has an
address (`MOV @#BAT, R0`), and every device reports for itself.

## 2. General rules

* **Word registers at even addresses.** Byte access (`MOVB`, `TSTB`, `BISB`) reaches the
  low byte (even address) or the high byte (odd address), as on DEC hardware.
* **Access** per register: read-only (RO), read/write (RW), write-only (WO, reads 0).
  Writes to read-only registers or bits are ignored.
* **Firmware only** (FW): a write from the program is a **protection fault** (trap 4 →
  `P.FLT`, [`PDP11_CPU.md`](PDP11_CPU.md) §7.3). The program may read them.
* **No register at an address in `170000`–`177777`** → bus error (trap 4).
* **16-bit values.** Unsigned unless marked *signed* (two's complement, −32768…32767).
  Parameter writes are clamped to their range as today; angle registers wrap modulo 360.
  §4 lists the values that had to change to fit.
* **Timing:** sensor values are sampled at the start of each tick and stay put during it
  (deterministic). Registers the CPU writes change at once (a refused start shows in
  the CSR in the same instruction).
* **Reboot state:** every CSR idle (`DONE` = 1, `ERR` = 0, `IE` = 0), parameter registers
  0 unless listed. The actuators keep their physical state as today (array, dish, lights).

## 3. The register map

### 3.1 The device CSR

Every device with work to do (drive, radar, tools, repair, camera, image) has the same
CSR layout, after DEC's:

| Bit | Name | Access | Meaning |
| :--- | :--- | :--- | :--- |
| 15 | `ERR` | RO | the last start was refused, or the last run ended with an error: the reason is in the device's `xxER` register |
| 14–8 | – | RO | 0 |
| 7 | `DONE` | RO | 1 = idle (finished, or never started); 0 = working |
| 6 | `IE` | RW (FW) | interrupt when `DONE` becomes 1 (§5). Program writes leave it unchanged |
| 5–4 | – | RO | 0 |
| 3–1 | `FN` | RW | function: which tool, which repair, which camera mode, send or erase |
| 0 | `GO` | WO | write 1: start with the current parameters |

**Why bits 7 and 15.** Bit 7 is the sign bit of the low byte and bit 15 the sign bit of
the word, so the flags test them without a mask:

```
        TSTB @#DRVCS            ; N = DONE
        BPL  BUSY               ; still working
        TST  @#DRVCS            ; N = ERR
        BMI  FAILED             ; the reason is in @#DRVER
```

**One path for every outcome:**

1. Write the parameter registers (they are latched: they keep their value).
2. Write `GO` (with the function, if the device has one).
   * **Accepted:** `DONE` and `ERR` clear; the device works.
   * **Refused** (busy, array open, wall right ahead, low power, invalid): `DONE` stays 1,
     `ERR` = 1, `xxER` = the reason, **in the same instruction**.
3. Wait for `DONE`, then look at `ERR`.

This replaces today's two `@STATUS` checks ("accepted?" after the start, "how did it
end?" after `WAIT`) with one. No device can overwrite another's result, because there is
no shared status any more.

**Error registers (`xxER`)** hold today's status codes, unchanged: `OK` 0,
`E.INV` 1, `E.FULL` 2, `E.LOWP` 3, `E.BLK` 4, `E.NOTL` 5,
`E.NOSG` 6, `E.HAZ` 7, `E.DEPL` 8, `E.PRE` 9 ("stopped by a
command"), `E.BUSY` 10. In octal source they are written by name (`E.BUSY` is `12`).

**Predefined bits and functions:** `GO` = 1, `IE` = 100, `DONE` = 200, `ERR` = 100000.
Function codes come **already shifted** into bits 3–1, so they combine with `!` (or):
`MOV #F.TOOL2!GO, @#TOLCS`. A computed function needs a shift: `ASL R0` /
`BIS #GO, R0`.

**`MOV` versus `BIS` on a CSR:** `MOV` writes every bit; in the firmware that clears `IE`.
`BIS #GO, @#DRVCS` sets `GO` and keeps the rest. The ROM drivers use `BIS` where they can.

### 3.2 Telemetry (`176000`, read-only)

Today's names without the `@`, shortened to six characters (§10); addresses in octal.

| Address | Register | Notes |
| :--- | :--- | :--- |
| `176000` | `BAT` | 0–100 % |
| `176002` | `HULL` | 0–100 |
| `176004` | `SOLHLT` | 0–100 |
| `176006` | `ANTHLT` | 0–100 |
| `176010` | `X` | signed (§4) |
| `176012` | `Y` | signed |
| `176014` | `TICKL` | ticks since world start, low word; **reading it freezes `TICKH`** (§4) |
| `176016` | `TICKH` | high word, as frozen by the last `TICKL` read |
| `176020` | `GROUND` | tile ID under the rover |
| `176022` | `GNDHAZ` | 0–2 |
| `176024` | `TEMP` | °C, **signed** (nights go below zero: `BLT`, not `BLO`) |
| `176026` | `HEATER` | 0 / 1 |
| `176030` | `CRGFRE` | empty cargo slots |
| `176032` | `SCIRDY` | products waiting for the downlink |
| `176034` | `RECFRE` | free recorder bytes |
| `176036` | `RADRNG` | radar range in tiles |
| `176040` | `ALERT` | `A.NONE` / `A.ECL` / `A.SQL` |
| `176042` | `ALRETA` | ticks until it starts |
| `176044` | `DROPS` | landed supply crates |
| `176046` | `DROPX` | signed |
| `176050` | `DROPY` | signed |
| `176052` | `SUNAZ` | 0–359 |
| `176054` | `SUNEL` | degrees, **signed** (≤ 0 is night) |
| `176056` | `SUNLIT` | 0–100 |
| `176060` | `SOLDST` | 0–100 % |
| `176062` | `ORBAZ` | 0–359 |
| `176064` | `SIGNAL` | 0–100 |

### 3.3 Actuators and lights (`176200`)

| Address | Register | Access | Notes |
| :--- | :--- | :--- | :--- |
| `176200` | `HDG` | RW | write turns in place (5 energy, wraps mod 4) |
| `176202` | `LIGHT` | RW | 0 / 1 |
| `176204` | `SOLOPN` | RW | 0 stow, 1 deploy |
| `176206` | `SOLANG` | RW | write: target; read: current |
| `176210` | `ANTANG` | RW | write: target; read: current |
| `176212` | `IND1` | RW | lamp, `OFF`…`AMBER` (0–4) |
| `176214` | `IND2` | RW | |
| `176216` | `IND3` | RW | |
| `177570` | `DISP` | RW | was `@POST`, at the PDP-11's real **console display register** address: the lights on the front panel |

### 3.4 Devices (`176400`, eight words each)

Each device starts at a multiple of `20` (octal): `+0` CSR, `+2` error register, then
parameters and answers.

| Device | Address | Registers (`+2`, `+4`, …) | `FN` (bits 3–1) | Was |
| :--- | :--- | :--- | :--- | :--- |
| **Drive** | `176400` `DRVCS` | `DRVER`, `DRVDIR` direction (RW), `DRVCNT` tiles (RW) | – | `@DRIVE`, `@DRIVE_N` |
| **Radar** | `176420` `RADCS` | `RADER`, `RADDIR` (RW), `RADHIT` (RO), `RADDST` (RO) | – | `@RADAR`, `@RADAR_HIT`, `@RADAR_DIST` |
| **Tools** | `176440` `TOLCS` | `TOLER`, `TOLARG` direction or slot (RW), `TOLLFT` ticks left (RO), `SEITYP` (RO), `SEIDST` (RO) | hardpoint `F.T0`…`F.T3` | `@TOOL`, `@TOOL_ARG`, `@SEISMIC_*` |
| **Repair** | `176460` `REPCS` | `REPER`, `REPSLT` cargo slot (RW), `REPLFT` (RO) | system `F.HULL`, `F.SOL`, `F.ANT` | `@REPAIR`, `@REPAIR_SYS` |
| **Camera** | `176500` `CAMCS` | `CAMER`, `CAMDIR` (RW), `CAMLFT` (RO) | mode `F.M1`…`F.M5` | `@CAM`, `@CAM_MODE` |
| **Image** | `176520` `IMGCS` | `IMGER`, `IMGTYP` mode of the last photo (RO), `IMGLFT` (RO), `IMGSIZ` image memory bytes (RO) | `F.ERAS` (slice 4: `F.SEND` retired, the ROM's `SNDIMG` sends photos) | `@SEND`, `@ERASE` |

* **Drive count, DEC style:** `DRVCNT` counts **down** as tiles are driven (like a disk
  controller's word count). Read: tiles left. Written while driving: changes the tiles
  left; **0 stops at the end of the current tile** and the drive ends with
  `E.PRE`. It reads 0 after a completed drive, so set it before every start
  (`GO` with `DRVCNT` = 0 is `E.INV`). Today's "latched, 1 after a reboot" goes.
* **Interlocks** unchanged: drive, tools, repair and camera share the chassis (one at a
  time, the others refuse with `E.BUSY`); `F.SEND` / `F.ERAS` are refused while the
  camera exposes; the radar runs alongside anything.
* Image send and erase become **one device with two functions** (they never ran at once).

### 3.5 Output: the `TX` device and the recorder (`176540`)

Replaces the M9 log registers (owner approval, 2026-11-15; the design and the message
format are §3.5a). The CPU writes **bytes**; the program (or a ROM routine) frames them
as messages.

| Address | Register | Access | Notes |
| :--- | :--- | :--- | :--- |
| `176540` | `TXCS` | RO / `IE` | bit 7 `READY`: the real-time FIFO has room for a byte; bit 6 `IE`: interrupt when room comes back |
| `176542` | `TXBUF` | WO | queue one byte (dropped and counted in `TXLOST` if the FIFO is full) |
| `176544` | `TXFREE` | RO | free FIFO bytes (Mk-I FIFO: 64 B) |
| `176546` | `TXLOST` | RW | bytes dropped since boot (saturates at 255; write to set) |
| `176550` | `RECCS` | RO | bit 7 `READY`: the recorder has room for a byte |
| `176552` | `RECBUF` | WO | store one byte in the recorder (store and forward, reliable) |
| `176554` | `RECFRE` | RO | free recorder bytes (also readable at `176034` in telemetry, which has no name of its own since slice 4) |

`LOG` stops being an instruction (M14 kept it as one). The ROM routine `LOG` (tag in
`R0`, value in `R1`) writes a `T.LOG` message; `PUTMSG` writes any message, all or
nothing; `SNDIMG` frames the photo in image memory into the recorder.

### 3.5a Standard output: framed messages

Owner, 2026-11-15: "even the rover will need some standard output, which will probably be
sent as a message. Maybe all outputs go out to be sent directly, with start / end codes, to
be able to distinguish between error codes, scientific data and so on."

**Decided (owner, 2026-11-15):**

1. **The program writes the framing itself** (start code, type, length, body, end code),
   byte by byte. ROM routines do it for the common cases, for example sending a whole
   photo.
2. **A message cut off by a reboot stays incomplete.** Ground shows it as incomplete;
   nothing resumes it.

**Channels, format, types and costs: approved (owner, 2026-11-15)** as proposed below.

#### How real missions do it

On spacecraft (the CCSDS standards that NASA and ESA use), **everything that goes down
is a packet**: a small header that says *who sent it and what it is* (the APID), a
sequence count (so ground notices a lost packet) and a length, then the data.
Housekeeping, error / event messages, memory dumps and science are all packets with
different APIDs; there is no separate "error wire". The packets travel on a few **virtual
channels** with priorities: real-time telemetry and events go out at once and may be lost
when the link is bad; science is **stored and forwarded** from the recorder until it gets
through. On the PDP-11 itself, output was a plain byte stream to a terminal (`XCSR` /
`XBUF`), and the program added any structure.

#### Proposed design: two channels, one message format

```
            ┌─ TX  (real time, lossy, 64 B FIFO) ── text, errors, log values, small data
CPU writes ─┤
            └─ REC (store and forward, 1024 B)  ── photos, spectra, big data
                                                  ─► transmitter ─► ground (Comms splits by type)
system (boot reasons, dumps) ── its own channel, never mixed into the CPU's bytes
```

* **One device for the CPU's real-time output, `TX`**, in the DL11 style (registers in
  §3.5): `TXCS`, `TXBUF`, `TXFREE`, `TXLOST`. It **replaces the log registers of §3.5**: today's
  `LOG tag, value` becomes a ROM routine that writes a `T.LOG` message.
* **The recorder takes messages too**, the same format through `RECBUF` / `RECFRE`, for
  data that must arrive. The camera's send function becomes the ROM routine `SNDIMG`,
  which frames the photo and writes it into the recorder: owner decision 1's "full photo".
  A photo (256–1024 B) is too big for the real-time FIFO, which is a lesson in itself.
* **System messages stay on their own channel** (boot reason, dump replies). The hardware
  never inserts bytes into the CPU's stream, so it can't break a message the program is
  writing.
* **Message format** (written by the program, decision 1):

  ```
  SOH  type  length  body (length bytes)  ETX
  001  1 B   1 B     0–255 B              003
  ```

  Ground checks two things: the length must match, and an `ETX` must follow. If either
  fails, the message is shown as **incomplete** (cut off by a reboot, decision 2) or
  **broken** (bytes lost when the FIFO was full). A message has 4 bytes of overhead, which
  makes many tiny messages expensive: a real design trade-off.
* **Types:** `T.TEXT` (characters: ground prints them), `T.ERR` (an error code and the
  address where it happened), `T.LOG` (a tag and a 16-bit value: today's log),
  `T.DATA` (raw bytes, shown in hex), `T.IMG` / `T.SPEC` (science, recorder only).
  Types `000`–`077` are reserved for these and later ones; `100`–`377` are free for the
  player's own formats. Comms shows the number for those, and the bytes in hex.
* **When the FIFO is full**, a byte written to `TXBUF` is dropped and `TXLOST` counts it,
  so the message breaks. The ROM routine `PUTMSG` (type in `R0`, buffer address in `R1`,
  length in `R2`) first checks `TXFREE` for room for the whole message and otherwise
  returns `E.FULL`, so ROM output is all or nothing. A hand-written loop that doesn't check
  can break its own messages: a lesson, not a bug.
* **No sequence count in v1** (ground sees broken messages, but not a message that was
  dropped whole). It's easy to add as a header byte later, CCSDS style.

#### Proposed costs and sizes (all in `balance.ts`, tunable)

| What | Proposed | Why |
| :--- | :--- | :--- |
| Writing a byte to `TXBUF` / `RECBUF` | the bus write only (1 cycle) | the CPU pays in cycles; no energy per byte |
| Transmitter | unchanged: 2 B / tick at full signal, 2 energy per tick that sends | the link is the bottleneck, as today |
| Message overhead | 4 bytes on air | comes with the format; no extra rule needed |
| Real-time FIFO (Mk-I) | **64 B** (today's log FIFO: 32 B) | a text message such as "STUCK AT 12,-4" needs about 18 B |
| Recorder | 1024 B, upgrades 2 / 4 KB as today | |
| Order on the link | system, then `TX`, then `REC` (as today: dump, log, recorder) | real-time first; chatty output starves science, as now |

### 3.6 Cargo (`176600`, bytes, read-only)

`CARGO` = `176600`; one tile ID per slot, a byte each (8 slots reserved, 4 on Mk-I).
Read with index mode:

```
        MOVB CARGO(R1), R0      ; item in slot R1 (MOVB sign-extends; tile IDs are < 200)
```

### 3.7 Program control and watchdog (`177000`, firmware writes)

The gate and the M10 / M13 machinery ([`PDP11_CPU.md`](PDP11_CPU.md) §7).

| Address | Register | Access | Notes |
| :--- | :--- | :--- | :--- |
| `177000` | `PRGCS` | FW | write `GO`: **the gate**, run the program. Read: bits 3–1 `WHY` the last call ended (0 none, 1 done, 2 time up, 3 preempted, 4 fault, 5 `BPT`, 6 `TRAP`); bit 15 `ERR`: the gate was refused (the program is not `P.RDY`) |
| `177002` | `PRGER` | RO | fault code (odd address, no memory, protection, stack overflow, illegal instruction) or the `TRAP` number |
| `177004` | `PRGST` | FW | program state, M10 values (`P.NONE`…`P.HLT`); write `P.NONE` to acknowledge, `P.RDY` to restart |
| `177006` | `PRGRES` | RO | the program's `R0` when it ended (was `@PROG_RESULT`) |
| `177010` | `PRGPC` | RO | the program's `PC` when it last came back |
| `177012` | `SLICE` | FW | ticks the next run may last, 0 = no limit; read in the program: ticks left |
| `177014` | `PREMPT` | FW | `PR.ALR` 1, `PR.DMG` 2, `PR.BAT` 4 |
| `177016` | `PRMPTD` | RO | the bits that ended the last run |
| `177020` | `BATALM` | FW | 0–100 % |
| `177022` | `WDT` | FW | watchdog, M13 rules (write n > 0 to arm / kick; read: ticks left) |
| `177024` | `REBOOT` | FW | write a boot reason: hard reboot after the instruction (slice 3; the ROM's fault handlers) |
| `177026` | `BOOTCS` | FW | slice 4: bits 7–0 why the rover booted (RO); bit 8 `SAFE`: safe mode, latched through reboots, cleared by a firmware upload; the boot ROM sets it |
| `177030` | `BOOTCT` | RO | slice 4: fault and watchdog reboots (boot reasons 2, 5, 7) in the last 500 ticks, this boot included |

### 3.8 CPU and clock (real PDP-11 addresses)

| Address | Register | Access | Notes |
| :--- | :--- | :--- | :--- |
| `177546` | `LKS` | FW | **line clock** (DEC KW11-L): bit 7 set at every tick (write 0 to clear), bit 6 `IE`; vector `100`. The boot ROM sets `IE` |
| `177774` | `STKLIM` | FW | the firmware's stack limit |
| `177776` | `PSW` | FW (read: anyone) | processor status: mode, priority, `T`, `N Z V C` |

## 4. Making every value fit 16 bits

| Value | Today | Now |
| :--- | :--- | :--- |
| `TICK` | grows without limit; one word wraps after 65536 ticks (about 27 sols) | two words, `TICKL` / `TICKH`. Reading `TICKL` freezes `TICKH`, so the pair always matches: the classic "read a two-word counter" lesson. Waits and timeouts use `TICKL` alone with wrap-safe arithmetic (§6) |
| `@TIMER` (one per slot, up to 1,000,000) | a device | **gone.** `SLEEP` counts ticks on `TICKL` (§6); one call sleeps up to 32767 ticks, longer sleeps loop. A banked per-context timer was the alternative (open question 2) |
| `X`, `Y`, `DROPX`, `DROPY` | 32-bit, the world is unbounded | **signed 16-bit**, −32768…32767; beyond that they wrap. At 3–6 ticks per tile that is months of driving |
| `TEMP`, `SUNEL` | negative values | signed; the lesson is `BLT` (signed) versus `BLO` (unsigned) |
| `DRVCNT`, `SLICE`, `WDT` | up to 30000 | fit as they are |
| everything else | percentages, angles, IDs, 0 / 1 | fit as they are |

## 5. Interrupts from devices

CPU side (priority, entry, `RTI`, `WAIT`, the program's time): [`PDP11_CPU.md`](PDP11_CPU.md) §8.

* **A request** is raised when a device's `DONE` becomes 1 (a run ended, or a start was
  refused) while its `IE` is 1, or when `IE` is set while `DONE` is already 1 (as DEC
  devices did). It is cleared when the CPU takes it, or by the next write of `GO`. One
  request per event: a handler doesn't loop forever on a device that stays `DONE`.
* **Levels:** devices at 4, the line clock at 6.
* **Who handles them:** the firmware, through the vectors at `000000`. `IE` is a
  firmware-only bit, so a program can't switch on interrupts it can't handle, and can't
  switch off the firmware's. The boot ROM fills every vector with a handler that just
  returns.
* **When:** at the start of a tick, as devices finish between ticks.

| Vector | Source | v1 |
| :--- | :--- | :--- |
| `004`–`034` | CPU traps ([`PDP11_CPU.md`](PDP11_CPU.md) §7.3) | yes |
| `024` | power fail: battery below `BATALM` (the real PDP-11 power-fail trap) | later (open question 6) |
| `100` | line clock, every tick | yes |
| `104` | reserved (the real KW11-P programmable clock; `SLICE` is the gate in v1) | – |
| `120` | drive | yes |
| `124` | radar | yes |
| `130` | tools | yes |
| `134` | repair | yes |
| `140` | camera | yes |
| `144` | image | yes |
| `150` | log `READY` | yes |

Each vector is two words: the handler's address and its `PSW` (usually its priority:
`200` for level 4, `300` for 6, `340` for "nothing else while I run").

## 6. ROM drivers

Arguments in `R0`, `R1`; result in `R0`; `R0` and `R1` scratch
([`PDP11_CPU.md`](PDP11_CPU.md) §10). Every driver follows the §3.1 path.

```
; STEP: drive R1 tiles in direction R0. Returns R0 = OK or why not (Z set if OK).
STEP:   MOV  R1, @#DRVCNT       ; how far
        MOV  R0, @#DRVDIR       ; which way
        BIS  #GO, @#DRVCS       ; start (BIS keeps IE); refused: DONE + ERR at once
1$:     TSTB @#DRVCS            ; DONE?
        BMI  2$                 ; yes
        WAIT                    ; no: sleep until the next interrupt (next tick at the latest)
        BR   1$
2$:     MOV  @#DRVER, R0        ; OK (0) or why not
        RTS  PC
```

```
; SLEEP: wait R0 ticks (up to 32767). Changes R1.
SLEEP:  MOV  @#TICKL, R1        ; now...
        ADD  R0, R1             ; ...+ R0 = wake-up time (may wrap past 177777: fine)
1$:     WAIT
        CMP  @#TICKL, R1        ; now − wake-up time...
        BMI  1$                 ; ...still negative: not yet
        RTS  PC
```

`SLEEP` tests `BMI` (the sign of the difference), not `BLT`: that stays right when the
counter wraps, a real-world technique worth a Reference note. `SCAN`, `ACT`, `USE`, `SNAP`
and `ERASE` follow `STEP`'s pattern (as built they share its waiting tail `DWAIT`); `LOG`,
`PUTMSG`, `SEND` and `SNDIMG` write messages (§3.5a); `RUN` is in
[`PDP11_CPU.md`](PDP11_CPU.md) §7.2. The full table as built: [`PDP11_CPU.md`](PDP11_CPU.md) §10.

**Cost of waiting:** a `WAIT` loop costs 5–6 cycles per tick plus the clock's handler
(about 7), against today's free `WAIT @port`. With 32–64 cycles per tick that leaves
room, and the difference is a lesson: sleeping is cheap, not free.

## 7. Examples

### 7.1 *Drive yourself* (the M14 lesson, ported)

```
DIR = %1                        ; R1 holds the direction

START:  CLR  DIR                ; NORTH
1$:     MOV  #3, @#DRVCNT       ; how far
        MOV  DIR, @#DRVDIR      ; which way
        MOV  #GO, @#DRVCS       ; start
2$:     TSTB @#DRVCS            ; DONE (bit 7)?
        BMI  3$
        WAIT                    ; sleep until the next tick
        BR   2$
3$:     TST  @#DRVCS            ; ERR (bit 15)?
        BMI  STUCK              ; why: @#DRVER
        INC  DIR
        CMP  DIR, #4
        BLT  1$
        MOV  #1, R0             ; result 1: square done
        RTS  PC                 ; "return from main" ends the program
STUCK:  CLR  R0                 ; result 0: stuck
        RTS  PC
```

26 words, 52 B. Reference → ROM's `STEP` shows the same steps.

### 7.2 Scan while driving

```
        MOV  #10., @#DRVCNT
        MOV  #EAST, @#DRVDIR
        MOV  #GO, @#DRVCS       ; start the drive and don't wait for it
1$:     MOV  #EAST, @#RADDIR
        MOV  #GO, @#RADCS       ; one sweep; the radar runs alongside the drive
2$:     WAIT
        TSTB @#RADCS
        BPL  2$                 ; sweep not finished
        CMP  @#RADHIT, #IRON
        BNE  3$
        INC  R2                 ; seen one
3$:     TSTB @#DRVCS            ; drive still going?
        BPL  1$                 ; yes: sweep again
```

### 7.3 A firmware interrupt handler

Light lamp 3 when a drive ends (green) or fails (red), without polling:

```
        MOV  #DRVINT, @#120     ; drive vector: the handler's address...
        MOV  #200, @#122        ; ...and its PSW: priority 4
        ...                     ; DRVCNT, DRVDIR
        MOV  #IE!GO, @#DRVCS    ; start, interrupt when DONE becomes 1. IE alone while
                                ; the drive is idle (DONE = 1) would interrupt at once
        ...
DRVINT: MOV  #GREEN, @#IND3
        TST  @#DRVCS            ; ERR?
        BPL  1$
        MOV  #RED, @#IND3
1$:     RTI
```

It also fires while the program drives: the CPU switches to the firmware for the
handler and `RTI` switches back.

### 7.4 Reading the tick counter

```
        MOV  @#TICKL, R0        ; reading the low word freezes the high word...
        MOV  @#TICKH, R1        ; ...so R1:R0 is one consistent 32-bit value
```

## 8. Audit: every port today → the I/O page

| Today | Now | Address | Access |
| :--- | :--- | :--- | :--- |
| `@BAT` `@HULL` `@SOLAR_HEALTH` `@ANTENNA_HEALTH` | renamed, §10 | `176000`–`176006` | RO |
| `@X` `@Y` | same, signed | `176010`, `176012` | RO |
| `@TICK` | `TICKL`, `TICKH` | `176014`, `176016` | RO |
| `@GROUND` `@GROUND_HAZARD` `@TEMP` `@HEATER` | renamed, §10 (some keep their name) | `176020`–`176026` | RO |
| `@CARGO_FREE` `@SCIENCE_READY` `@REC_FREE` `@SENSOR_RANGE` | renamed, §10 (some keep their name) | `176030`–`176036` | RO |
| `@ALERT` `@ALERT_ETA` `@DROPS` `@DROP_X` `@DROP_Y` | renamed, §10 (some keep their name) | `176040`–`176050` | RO |
| `@SUN_AZIMUTH` `@SUN_ELEV` `@SUN_LIGHT` `@SOLAR_DUST` | renamed, §10 (some keep their name) | `176052`–`176060` | RO |
| `@ORBIT_AZIMUTH` `@SIGNAL_STR` | renamed, §10 (some keep their name) | `176062`, `176064` | RO |
| `@HEADING` `@HEADLIGHT` `@SOLAR_OPEN` `@SOLAR_ANGLE` `@ANTENNA_ANGLE` | renamed, §10 (some keep their name) | `176200`–`176210` | RW |
| `@IND1` `@IND2` `@IND3` | renamed, §10 (some keep their name) | `176212`–`176216` | RW |
| `@POST` | `DISP` | `177570` | RW |
| `@STATUS` | **gone**: per device `xxER` + `ERR` bit; `DIV16` returns `C`; the gate reports in `PRGCS` | – | – |
| `@TIMER` | **gone**: `SLEEP` on `TICKL` | – | – |
| `@DRIVE` `@DRIVE_N` | `DRVCS` + `DRVDIR`, `DRVCNT` (+ `DRVER`) | `176400`–`176406` | RW |
| `@RADAR` `@RADAR_HIT` `@RADAR_DIST` | `RADCS` + `RADDIR`, `RADHIT`, `RADDST` (+ `RADER`) | `176420`–`176430` | RW / RO |
| `@TOOL` `@TOOL_ARG` | `TOLCS` (`FN` = hardpoint), `TOLARG`, `TOLLFT` (+ `TOLER`) | `176440`–`176446` | RW |
| `@SEISMIC_TYPE` `@SEISMIC_DIST` | `SEITYP`, `SEIDST` (in the tools block) | `176450`, `176452` | RO |
| `@REPAIR` `@REPAIR_SYS` | `REPCS` (`FN` = system), `REPSLT`, `REPLFT` (+ `REPER`) | `176460`–`176466` | RW |
| `@CAM` `@CAM_MODE` | `CAMCS` (`FN` = mode), `CAMDIR`, `CAMLFT` (+ `CAMER`) | `176500`–`176506` | RW |
| `@SEND` `@ERASE` | `IMGCS` (`FN` = send / erase), `IMGTYP`, `IMGLFT` (+ `IMGER`) | `176520`–`176526` | RW |
| `LOG` (instruction) `@LOG_FREE` `@LOG_LOST` `@TX_DATA` | the `TX` device (`TXCS`, `TXBUF`, `TXFREE`, `TXLOST`), messages into the recorder (`RECCS`, `RECBUF`, `RECFRE`); ROM `LOG`, `PUTMSG`, `SNDIMG` (§3.5, §3.5a) | `176540`–`176554` | mixed |
| cargo (`[CARGO+n]`) | `CARGO` bytes | `176600`–`176607` | RO |
| `@PROG_STATE` `@PROG_RESULT` | `PRGST`, `PRGRES` (+ `PRGCS`, `PRGER`, `PRGPC`) | `177000`–`177010` | FW / RO |
| `@SLICE` `@PREEMPT` `@PREEMPTED` `@BAT_ALARM` `@WDT` | renamed, §10 | `177012`–`177022` | FW / RO |
| – | `LKS` line clock, `STKLIM`, `PSW` | `177546`, `177774`, `177776` | FW |

`src/core/ports.ts` becomes this table (address, access, bits, description), and the
Reference *I/O page* tab is generated from it, as the Ports tab is today.

## 9. Open questions

1. **Names:** ~~DEC-style short names for device blocks and today's names for
   telemetry?~~ Decided 2026-11-15: **six characters at most everywhere**, no `_`
   ([`PDP11_CPU.md`](PDP11_CPU.md) §0, decision 17). Every long name in this document
   (`SOLHLT`, `E.BLK`, `A.ECL`, …) needs a short name before slice 3.
   **Scheme approved (owner, 2026-11-15): DEC style, a family prefix and a dot where it
   helps** (`E.BLK` for `ERR_BLOCKED`, `SOLHLT` for `SOLAR_HEALTH`); the full table is §10.
2. **`@TIMER`:** drop it and sleep on `TICKL` (this draft), or keep a per-context timer?
3. **`DISP`:** keep two hex digits (today's `@POST`), or three octal digits `000`–`377`
   to match the octal theme (a visual change: preview first)?
4. **Lamps:** three registers (this draft), or one register with three 3-bit fields (a
   `BIC` / `BIS` lesson)?
5. **Camera:** fixed image window at `100000` (this draft), or the camera writes wherever
   a bus-address register points (real DMA, like DEC's disk controllers; maybe an upgrade)?
6. **More firmware interrupts:** power fail (`024`) for `PR.BAT`, and interrupts
   for alerts and damage, to let the firmware react while it runs, not only between
   program runs.
7. **Function codes:** pre-shifted `F.` symbols (this draft) or plain numbers with the
   shift written out?
8. ~~Standard output as framed messages~~: decided and approved (§3.5a).

## 10. Six-character names (approved scheme, 2026-11-15)

Owner decisions: names have at most six characters, letters, digits, `.` and `$`
([`PDP11_CPU.md`](PDP11_CPU.md) §0, decision 17), in DEC style: a family prefix and a
dot where it helps. This document already uses the new names. Families:

| Prefix | Family | Examples |
| :--- | :--- | :--- |
| `E.` | error / status codes (`OK` stays) | `E.BLK`, `E.BUSY` |
| `F.` | device function codes (`FN` field) | `F.T0`, `F.M3`, `F.SEND` |
| `T.` | message types (§3.5a) | `T.TEXT`, `T.LOG` |
| `A.` | alert kinds | `A.ECL` |
| `P.` | program states | `P.RDY` |
| `PR.` | preempt bits | `PR.BAT` |
| none | registers (device + field, as DEC: `DRVCS`), telemetry, tiles, directions, lamp colours | `SOLHLT`, `IRON`, `NORTH`, `AMBER` |

Unchanged because they already fit: `BAT`, `HULL`, `X`, `Y`, `TICKL`, `TICKH`, `GROUND`,
`TEMP`, `HEATER`, `ALERT`, `DROPS`, `IND1`–`IND3`, `SLICE`, `WDT`, `OK`, `NORTH` `EAST`
`SOUTH` `WEST`, `OFF` `RED` `GREEN` `BLUE` `AMBER`, `SAMPLE`, `ROVER`, every device register
(`DRVCS` …), every ROM routine.

Renamed (today → PDP-11 core):

| Today | New | Notes |
| :--- | :--- | :--- |
| `SOLAR_HEALTH` | `SOLHLT` |  |
| `ANTENNA_HEALTH` | `ANTHLT` |  |
| `GROUND_HAZARD` | `GNDHAZ` |  |
| `CARGO_FREE` | `CRGFRE` |  |
| `SCIENCE_READY` | `SCIRDY` |  |
| `REC_FREE` | `RECFRE` | also `176554` |
| `SENSOR_RANGE` | `RADRNG` |  |
| `ALERT_ETA` | `ALRETA` |  |
| `DROP_X` | `DROPX` |  |
| `DROP_Y` | `DROPY` |  |
| `SUN_AZIMUTH` | `SUNAZ` |  |
| `SUN_ELEV` | `SUNEL` |  |
| `SUN_LIGHT` | `SUNLIT` |  |
| `SOLAR_DUST` | `SOLDST` |  |
| `ORBIT_AZIMUTH` | `ORBAZ` |  |
| `SIGNAL_STR` | `SIGNAL` |  |
| `HEADLIGHT` | `LIGHT` |  |
| `HEADING` | `HDG` |  |
| `SOLAR_OPEN` | `SOLOPN` |  |
| `SOLAR_ANGLE` | `SOLANG` |  |
| `ANTENNA_ANGLE` | `ANTANG` |  |
| `DISPLAY` | `DISP` | console display register |
| `PREEMPTED` | `PRMPTD` |  |
| `PREEMPT` | `PREMPT` |  |
| `BAT_ALARM` | `BATALM` |  |
| `ERR_INVALID` | `E.INV` |  |
| `ERR_FULL` | `E.FULL` |  |
| `ERR_LOW_POWER` | `E.LOWP` |  |
| `ERR_BLOCKED` | `E.BLK` |  |
| `ERR_NO_TOOL` | `E.NOTL` |  |
| `ERR_NO_SIGNAL` | `E.NOSG` |  |
| `ERR_HAZARD` | `E.HAZ` |  |
| `ERR_DEPLOYED` | `E.DEPL` |  |
| `ERR_PREEMPTED` | `E.PRE` |  |
| `ERR_BUSY` | `E.BUSY` |  |
| `ALERT_NONE` | `A.NONE` |  |
| `ALERT_ECLIPSE` | `A.ECL` |  |
| `ALERT_SQUALL` | `A.SQL` |  |
| `PROG_NONE` | `P.NONE` |  |
| `PROG_READY` | `P.RDY` |  |
| `PROG_RUNNING` | `P.RUN` |  |
| `PROG_DONE` | `P.DONE` |  |
| `PROG_FAULT` | `P.FLT` |  |
| `PROG_HALTED` | `P.HLT` |  |
| `PRE_ALERT` | `PR.ALR` |  |
| `PRE_DAMAGE` | `PR.DMG` |  |
| `PRE_LOW_BAT` | `PR.BAT` |  |
| `F.TOOL0` | `F.T0` |  |
| `F.TOOL3` | `F.T3` |  |
| `F.MODE1` | `F.M1` |  |
| `F.MODE5` | `F.M5` |  |
| `F.SOLAR` | `F.SOL` |  |
| `F.ERASE` | `F.ERAS` |  |
| `FLAT_SAND` | `SAND` |  |
| `ROUGH_GRAVEL` | `GRAVEL` |  |
| `ACID_VENT` | `VENT` |  |
| `CLIFF_WALL` | `CLIFF` |  |
| `IRON_ORE` | `IRON` |  |
| `SILICON_ORE` | `SILIC` |  |
| `REPAIR_KIT` | `KIT` |  |
| `SUPPLY_CRATE` | `CRATE` |  |
| `DIR_TO` | `DIRTO` |  |
| `LOG_FREE` | `TXFREE` | the `TX` device (§3.5) |
| `LOG_LOST` | `TXLOST` | the `TX` device (§3.5) |
| `SYS_HULL` / `SYS_SOLAR` / `SYS_ANTENNA` | `F.HULL` / `F.SOL` / `F.ANT` | repair function codes |
| `TOOL_0`…`TOOL_3` | `F.T0`…`F.T3` | tool hardpoints |

In slice 3 the tile registry gets a `shortName` (what becomes the language constant), so a
new tile can't break the rule; a test checks that every predefined symbol fits.

## 11. Slice 3 as built (owner may veto)

* **When requests are raised:** world events (a device finished, the line clock, room in the
  TX FIFO again) at the start of a tick; events the CPU causes (a refused start, `IE` set
  while `DONE` = 1) at once, before the next instruction, as on DEC hardware. A `GO` that is
  accepted withdraws the device's pending request.
* **Byte writes** to the high byte (odd address) of a register are ignored; the low byte
  writes the register (`MOVB R0, @#TXBUF`, `BISB #GO, @#DRVCS`).
* **`DRVCNT`** reads 0 once a drive was accepted and after it ended; `RESET` stops a drive
  at the end of its tile and returns every register to its reboot state.
* **`TX`:** a reboot puts an out-of-band marker into the stream (no bytes, no air time), so
  ground ends a message cut off by it as *incomplete*. A message that lost bytes in a full
  FIFO waits for the rest until the next message or reboot shows it broken or incomplete
  (no timeout in v1). Link order: dumps, system frames (boot reasons), `TX`, recorder.
* **Recorder registers** (`RECCS`, `RECBUF`) and `SNDIMG` come with slice 4, with the ROM;
  until then the image device's `F.SEND` sends photos as today.
* **Predefined names are reserved:** a label `X:` or `IRON:` is an error ("is a predefined
  symbol"), as with DEC's system symbols.

## 12. Slice 4 as built (owner may veto)

* **Recorder registers** `RECCS` / `RECBUF` / `RECFRE` (`176550`–`176554`): the CPU's bytes
  share the recorder's room with the spectra and photos the hardware records, and go out
  after the `TX` stream, before those products. A byte written while the recorder is full
  is dropped without a count (check `RECFRE` first; the ROM's `SEND` and `SNDIMG` wait). A
  reboot puts the same out-of-band marker into the recorder stream as into `TX`.
* **Photos:** `SNDIMG` frames image memory as `T.IMG` messages: body `type, chunk, chunks`
  and 128 pixel bytes. Ground reassembles them in order into a Gallery photo; a reboot or a
  lost chunk drops it. The recorder pairs the first chunk with the camera's capture of that
  type when it stores it (that is what earns the credits; then the capture is used up, as
  with today's send). Raw or edited is decided by comparing the bytes with the capture.
* **`F.SEND` retired** on this core (it is `E.INV`); `IMGTYP` became read-only, the mode of
  the last photo (what `SNDIMG` sends for type 0); new `IMGSIZ` (`176530`) tells the ROM how
  much image memory the camera has.
* **Safe mode registers** `BOOTCS` / `BOOTCT` (§3.7): the hardware counts, the boot ROM
  decides ([`PDP11_CPU.md`](PDP11_CPU.md) §10). The `SAFE` bit is the rover's only
  non-volatile flag besides image memory.
* **Not changed, waiting for the owner:** link 2 B/tick and recorder 1 KB. With them a 64×64
  photo (1080 B on air) takes about 540 ticks at full signal; the proposed 4 B/tick halves it.
