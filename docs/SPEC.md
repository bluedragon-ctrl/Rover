# Rover — Game & Language Specification (`v2.0`)

v2.0 (M15 slice 6): the rover's computer is the **Blue-11** and its language Blue-11
assembly (§5); Rover-ASM, the language of v1.x, is gone. This document pins down the
numbers the code relies on.
All tunable numbers live in `src/core/balance.ts`; this document lists defaults.

Status markers: **[M1–M3]** … **[M7]** implemented in that milestone, **[later]** designed
but not yet implemented, **[M9, planned]** designed for a milestone that has not started
(or for a later slice of it; **[M9]** marks the parts already built).

---

## 1. Game direction

* **Sandbox first.** The first playable is an open world with a programmable rover and
  no fail-state beyond running out of power.
* **Storyteller later.** An `EventDirector` ("storyteller") will generate missions and
  events (eclipses, micrometeorite squalls, distress beacons, survey contracts) that the
  player handles by writing better programs. It is fed by the same deterministic seeded
  RNG as the world, so a save replays identically. **[later]**
* **Recoverable failure.** A dead battery is a *power-off*, not a game over (§3.4).
  An admin/cheat console exists for when the player gets truly stuck.

## 2. Simulation time

| Concept | Default | Notes |
| :--- | :--- | :--- |
| Tick rate | 10 ticks/s at `1x` | Tunable in the UI (1–60 Hz). Speed multipliers: `0x` (pause), `1x`, `5x`, `20x`. |
| CPU cycles per tick | 64 (Mk-I) | Chassis stat; the overclock upgrades give 96 / 128 (§2.1). **[M15]** |
| Day length | 2400 ticks | 4 min real time at 10 Hz, `1x`. The game starts shortly after sunrise. **[M4]** |

The simulation is a fixed-timestep loop independent of rendering. Every random choice
uses a seeded PRNG; the core uses no `Math.random`, no wall-clock time and no
transcendental math (`sin`, `cos`) whose results might differ across browsers. Angles use
integer lookup tables.

### 2.1 Cycle budget: "think fast, move slow"

Each tick, every powered rover's CPU (the Blue-11, §5) receives `cyclesPerTick` cycles.

* **One cycle per bus access** **[M15]**: every instruction word, every extra word (`#n`,
  an address, an index) and every operand read and write costs one cycle. `MOV R1, R2` = 1,
  `MOV #5, R0` = 2, `INC @#COUNT` = 4, `JSR PC, X` = 3. Mk-I gets 64 a tick; the idle
  default firmware uses about 24 of them (measured, [`BLUE11_CPU.md`](BLUE11_CPU.md) §14.5).
* **There are no hardware instructions.** The CPU computes and moves data; the hardware is a
  set of **devices** in the I/O page (§5.6). Writing `GO` to a device's control register
  starts it; `WAIT` sleeps until the next interrupt (the line clock interrupts every tick).
  The ROM's routines (`JSR PC, STEP`, `SCAN`, `SLEEP`…) do both for you (§5.9).
* Writing an actuator or lamp register (`MOV #RED, @#IND1`) is a bus write: instant.

This keeps logic snappy, makes physical actions cost real time, and naturally caps
runaway loops (an endless `BR` loop just burns cycles; it cannot freeze the game).

Tick order: (1) world/event update, (2) passive energy drain and actuators, the link, (3)
every device advances (radar, image erase, the drive or tool at work) and may finish, (4)
fault protection and the slice timer may end the program's run, (5) the line clock and
device interrupts are taken, (6) each CPU spends its cycles.

## 3. The Rover (Mk-I chassis)

Each rover owns a copy of its chassis stats; upgrades (§3.7) modify that copy. The I/O
register names (`BAT`, `DRVCS`…) are listed in §5.6.

| Stat | Mk-I | Notes |
| :--- | :--- | :--- |
| Computer | Blue-11, 2 KB core | §5. Firmware region `000200`–`001777` (896 B), program region `002000` up to its stack at the top of core (1022 B). |
| Cycles per tick | 64 | §2.1; overclock upgrades 96 / 128. |
| Battery | 100 000 energy units | `BAT` = 0–100 (%). |
| Hull | 100 | `HULL`. |
| Subsystems | solar array 100, dish 100 | `SOLHLT`, `ANTHLT`. **[M6]** |
| Cargo | 4 slots | Item IDs (= tile IDs), read-only bytes at `CARGO`. **[M5]** |
| Hardpoints | `F.T0` drill, `F.T1` grabber, `F.T2` spectrometer, `F.T3` empty | the tools block, ROM `ACT` **[M5]** |
| Sensor range | 6 tiles | Radar (`RADCS`, ROM `SCAN`), every direction, day and night. The operator's *view* needs light: 6 by day, 1-tile ring at night plus the headlight cone (§3.1.1). **[M4, M8.1]** |
| Downlink | 4 B/tick at full signal; TX FIFO 64 B, science recorder 2 KB | **[M9, M15]** §3.8 |
| Camera | mast camera, 64×64 2 bpp (modes 1–2) | ROM `SNAP`; modes 3–5 by upgrade. **[M9, M15]** §3.8.5 |
| Image memory | 1 KB (the largest installed camera mode) at `IMGBAS` = `100000` | A photo fills it, `MOV` / `MOVB` read and write it, ROM `SNDIMG` sends it. **[M12]** §3.8.7 |
| ROM | `160000`–`167777` | Boot, handlers, drivers and helpers; read and execute only (§5.9). |
| Thermal | survival heaters hold −40 °C | `TEMP`, `HEATER`; dust on the array `SOLDST`. **[M13]** §3.3.4 |
| Watchdog, fault protection | `WDT`; `PREMPT`, `BATALM` | Firmware-armed reset timer and preemption. **[M13]** §3.9.5, §3.9.2 |

### 3.1 Energy costs (defaults)

| Action | Ticks | Energy |
| :--- | :--- | :--- |
| Idle (CPU powered) | per tick | 1 |
| Drive (`DRVCS`, ROM `STEP`) onto `SAND` | 3 / tile | 40 / tile |
| Drive onto `GRAVEL` | 6 / tile | 120 / tile |
| Drive onto `VENT` | 4 / tile | 60 / tile + 10 hull damage |
| Radar sweep (`RADCS`, ROM `SCAN`) | 1 | 10 |
| Turn in place (`HDG` write) | instant | 5 |
| Headlight on | per tick | 8 |
| Actuator moving (array deploy, panel or dish slew) | per tick, each | 1 |
| Survival heaters **[M13]** | per tick while `HEATER` = 1 (cold: night, low sun) | 6 (§3.3.4) |
| Downlink transmitter | per tick in which bytes are sent | 2 (§3.8.1) |
| Solar charge | per tick | `floor(60 × SUN_LIGHT/100 × cos(panel − sun azimuth))` × `SOLHLT`% × (100 − `SOLDST`)%, only when fully deployed |

### 3.1.1 Radar, operator view and the headlight **[M8.1]**

The rover and the player "see" differently:

* **The radar** (`RADCS`, the ROM's `SCAN`) reaches the chassis sensor range (6 tiles; 8 with the
  Long-range radar upgrade) in every direction, by day and by night. It needs no light
  and does not turn the rover. Firmware can always navigate.
* **The operator view needs light.** What the player sees (and what gets permanently
  mapped in the fog of war, and lit by the renderer) is one shape, `src/core/sensors.ts`:

| Condition | Operator sees |
| :--- | :--- |
| Day (`SUNEL > 0`) | Disc of radius 6 (`dx² + dy² ≤ r² + r`) around the rover. |
| Night | The 1-tile ring around the rover (radius-1 disc, diagonals included). |
| Night, `LIGHT 1` (powered) | Ring **plus a forward cone** along `HDG`: `1 ≤ forward ≤ 5`, `|lateral| ≤ 1` for `forward ≤ 2`, `≤ 2` beyond (21 tiles). |

* So at night a player cannot look at unexplored ground and send the rover five tiles north: they
  need the headlight pointed that way, already-mapped terrain, or code that uses the radar.
* Each radar sweep also sends a brief red **radar wave** around the rover out to the radar
  range: tiles flash as the front passes, then fade, and unmapped terrain in range is
  briefly outlined in red. It is a glimpse for the player only; it maps nothing. (The sweep still answers with just the first hit along `dir`.)
* The rover faces `HDG`. The drive and directional tools (ROM `ACT`) turn it;
  writing `HDG` turns it in place (5 energy, value wraps mod 4, so `INC @#HDG`
  turns right). Use it to aim the headlight.

### 3.2 CPU states

| State | Meaning |
| :--- | :--- |
| `RUNNING` | Executing instructions (a `WAIT` for the next interrupt included). |
| `HALTED` | **[M9]** Stopped by `BPT`, or by `HALT` in the firmware; resumes on *Continue* or an upload (§3.8.4). No watchdog. |
| `FAULT` | A double fault (a trap the ROM cannot handle). The **fault reset** (boot reason "watchdog") hard-reboots the CPU after 50 ticks. A firmware bus error or illegal instruction is caught by the ROM, which reboots at once (boot reason 7, *CPU fault*). A hang without a fault is caught only by the firmware's `WDT` (§3.9.5). |
| `POWER_OFF` | Battery empty (§3.4). |
| `DESTROYED` | Hull at 0. Only the admin console can recover. |

Program faults never stop the CPU: the program returns to the firmware (§3.9.2).

### 3.3 Hard reboot (on firmware upload, watchdog, cold boot)

The disk controller copies both uploaded images back into core (initial values and any
self-modified code are restored), the CPU starts in the boot ROM, and every device stops
with its latched parameters and results reset; `WDT`, `PREMPT`, `BATALM` go to 0. The ROM
fills the vectors, probes the core, switches the line clock on and starts the firmware at
`000200` with `R0` = the top of core: **booting takes 3 ticks**, the firmware's first
instruction runs in the 4th. The program becomes `P.RDY` if there is one. Physical state
(position, battery, hull, cargo, actuators, lamps, the display, image memory) is kept.

**Safe mode** (from M14's design): three fault or watchdog reboots within 500 ticks make
the boot ROM run its built-in safe firmware instead (`BOOTCS` bit 8 `SAFE`, latched through
reboots); a firmware upload ends it.

Upload cost **[M4]**: `ceil((500 + 6 × bytes) × 100 / max(10, SIGNAL))` energy for the
firmware image's bytes (≈ 2.5 % for the 326-byte default firmware at full signal, 10× that
with the dish misaligned). If the battery cannot pay, or the rover is powered off, the
upload is rejected and the old code keeps running. New rovers ship with the default
firmware installed for free.

### 3.3.1 Sky, solar array and antenna **[M4]**

* **Sun:** azimuth and elevation are pure functions of the tick (integer trig tables).
  Sunrise is in the east (90°), noon in the south (180°) at 70°, sunset in the west.
  `SUNLIT = sin(elevation) × 100`, 0 at night (and during eclipses, M6).
* **Relay orbiter:** circles the sky once per 1800 ticks; `ORBAZ`.
* **Signal:** `SIGNAL = 100 × cos⁴(dish − orbiter)`; ≈ 50 at 33° off, 0 beyond 90°.
* **Motors:** writing `SOLANG` / `ANTANG` sets a target; the turntable slews
  3°/tick and reading the port returns the *current* angle. Writing `SOLOPN` starts a
  20-tick deploy/stow. Actuator state is physical: it survives reboots.
* **Movement lock:** the drive refuses with `E.DEPL` while the array is commanded open
  or not fully stowed.
* **Status lamps [M8]:** the rover's status lights: three lamps on the cabin roof,
  `IND1`, `IND2`, `IND3` (left to right), each takes a light colour (`OFF`, `RED`, `GREEN`,
  `BLUE`, `AMBER`, 0–4; larger values clamp to 4, and the registers are unsigned, so
  writing −5 (177773) gives `AMBER`: confirmed by the owner, 2026-11-16). A purely visual channel for the player:
  free, no gameplay effect. They are physical and survive reboots; they go dark while the
  rover is powered off. The default firmware uses lamp 1 = the program (green running, blue
  done, red fault), lamp 2 = power (amber charging), lamp 3 = uplink (blue while the dish is
  on the orbiter).

### 3.3.2 Tools, cargo and science **[M5]**

Tools are declared in `src/core/tools.ts`; hardpoint assignment comes from the chassis.
`GO` in a device block validates at once (a refusal costs no time: `ERR` in the CSR, the
reason in `xxER`), then pays energy, works for the tool's duration and applies the effect
when it finishes (re-checking that the target is still there). Tools work with the solar
array deployed. The ROM routines wrap the blocks: `ACT` (R0 = the argument, R1 = the
hardpoint), `USE` (R0 = the cargo slot, R1 = the system); both wait and return the result
in R0.

| Routine | Tool | Ticks | Energy | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `ACT` dir, `F.T0` | Mining drill | 8 | 600 | Removes the adjacent ore vein (`IRON`, `SILIC`) and stores it in the first free slot. |
| `ACT` dir, `F.T1` | Grabber | 2 | 100 | Picks up the adjacent surface item (`SAMPLE`, `KIT`). Adjacent tiles only. |
| `ACT` slot, `F.T2` | Spectrometer | 30 | 300 | Analyzes the item in `slot`, frees it and records a spectrum (§3.8.5) worth `SAMPLE` 3 credits, ore 1. `E.FULL` (item kept) if the recorder lacks 18 bytes. |
| `ACT` dir, `F.T3` | (empty) | – | – | `E.NOTL`. |
| `USE` slot, system | Field repair | 10 | 200 | Repairs `F.HULL`, `F.SOL` or `F.ANT` by **consuming the material** in cargo `slot` (see table below). |

Errors: `E.INV` (bad direction/slot, nothing usable there, a hardpoint the chassis does not
have), `E.FULL` (no free cargo slot), `E.LOWP`, `E.NOTL`, `E.BUSY` (the chassis is
working).

**Science [M9]:** the spectrometer records a 16-byte spectrum in the science recorder;
`SCIRDY` counts the products waiting there. The downlink sends them by itself (§3.8.5),
and a product pays its credits when its last byte arrives. Delivered science adds
**science credits**, as do completed goals. Credits are the currency for upgrades.

**Goals [M5]:** the `EventDirector` tracks a fixed set of sandbox goals (First contact,
Night owl, Surveyor, Trailblazer, Prospector, Collector, Scientist, Photographer, Darkroom,
Anomaly hunter, Field engineer, Upgraded, Into the dark, Storm chaser), each with a credit
reward. Checked every 10 ticks; deterministic. *First contact* = mission control receives a
first message the code sent (the automatic boot frame does not count).

### 3.3.3 Subsystem damage **[M6]**

Besides the hull, the solar array and the dish have their own integrity (0–100).
A damaged array charges proportionally less (`gain × SOLHLT / 100`); a damaged
dish gives proportionally weaker signal (`SIGNAL × ANTHLT / 100`), which
also makes uploads more expensive. Repair with ROM `USE` with `F.SOL` / `F.ANT`.
Hull 0 destroys the rover; a 0 subsystem just stops working.

Repairs consume materials from cargo (ROM `USE`); the item is used up. Which
material fixes what (`repairs` in the tile registry):

| Material | `F.HULL` | `F.SOL` | `F.ANT` |
| :--- | :--- | :--- | :--- |
| `KIT` | +30 | +40 | +40 |
| `IRON` | +10 | – | +15 |
| `SILIC` | – | +20 | – |

A material that cannot fix the chosen system gives `E.INV` and is not consumed.
Ore is therefore a choice: analyze it for science, or keep it as spare parts.

### 3.3.4 Thermal and dust **[M13]**

Real rovers lose most of their night-time energy to keeping warm, and their solar output
to dust. Both are automatic hardware here: firmware cannot switch them off, only plan
around them. Numbers in `BALANCE`.

* **Ambient:** `ambientTemp(SUNLIT)` = −80 °C at light 0 (night, total eclipse) up to
  +20 °C at light 100, linear (−40 °C at light 40, so the evening and early morning are
  cold too).
* **`TEMP`** (R, °C): the rover's internal temperature. Thermal inertia: it moves 1 °C toward
  the ambient every 4 ticks (on ticks divisible by 4). A new rover starts at the ambient.
* **Survival heaters** (thermostat): while the rover is powered and `TEMP` ≤ −40 °C with
  the ambient below −40 °C, the heaters run (`HEATER` = 1, 6 energy per tick) and hold
  the temperature, or warm a colder rover by 1 °C per 4 ticks. They run about 1450 ticks
  per sol (≈ 9 % of the battery). A powered-off rover has no heaters and cools to the
  ambient; there is no cold damage yet.
* **`SOLDST`** (R, 0–100 %): +1 % every 800 ticks the array is not fully stowed
  (≈ 3 % per sol open all day). Charging is scaled by `(100 − dust) / 100`. A completed
  stow (the accordion folding shut) shakes off half the dust, rounded up: a game liberty
  that gives firmware a choice (fold now and then, at 40 ticks and 40 energy) instead of
  random cleaning events. The *Dust squall* adds 1 % every 2 ticks to an open array.
  Admin *forceRepair* cleans it.

### 3.4 Power-off and solar recovery

When energy reaches 0 the CPU powers off and any action is aborted. If the solar array
is deployed and charging, the rover **cold-boots** (hard reboot) once the battery
reaches 5 % **[M4]**. If the array was stowed, the rover is stuck: the admin console
(`forceCharge`, `forceRepair`, `respawnAtOrigin`) is the escape hatch.

## 3.5 Storyteller events **[M6]**

Events are declared in `src/core/events.ts` (`EVENT_DEFS`). Each has a kind
(`ECLIPSE` / `SQUALL`), chance per sol, length, warning time, effect profile and
**prerequisites**: goals that must be completed, events that must already have happened
(non-admin), and an earliest sol. The `EventDirector` rolls once per sol (seeded RNG,
state saved) after a 1500-tick grace period:

1. Only **unlocked** events are considered; at most one event of each kind per sol.
2. **Teaching** events marked `guaranteedFirst` are scheduled for certain at the first
   roll after they unlock (at most one guaranteed event per sol, catalogue order).
3. Everything else rolls its chance.

Every event is announced ahead of time: `ALERT` reports the most urgent announced or
active event (`A.NONE 0`, `A.ECL 1`, `A.SQL 2`) and `ALRETA` the
ticks until it starts (0 while active).

| Event | Teaching | Unlocks after | Chance / sol | Warning | Length | Effect |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Dust squall | ✔ (guaranteed first) | goal *First contact* | 15 % | 400 | 60 | Hull −1 / 20 ticks; open array −1 / 3 ticks and +1 % dust / 2 ticks (M13). |
| Partial eclipse | ✔ (guaranteed first) | goal *First contact* | 15 % | 300 | 120 | Light dips to 40 %. |
| Micrometeorite squall | | Dust squall seen, sol ≥ 3 | 35 % | 200 | 100 | Hull −1 / 10 ticks (/5 while driving); dish −1 / 20; open array −2 / 3 ticks (≈ −66). |
| Total solar eclipse | | Partial eclipse seen, goal *Night owl*, sol ≥ 3 | 30 % | 200 | 150 | Light → 0. Daytime only. |

Event goals: *Into the dark* (a rover powered through a whole eclipse), *Storm chaser*
(out of a squall with hull ≥ 50 and solar ≥ 50). Admin-started events ignore
prerequisites and count neither toward goals nor toward "seen" prerequisites.

## 3.6 Persistence **[M6]**

`SaveManager.serialize/deserialize` (headless). A save (`version: 21`) holds the seed,
tick, credits, stats, cheats, storyteller state (RNG, schedule, completed goals), supply
drops, installed upgrades, mission control's last 200 received frames, 100 messages, 100
gallery products and 100 sent commands and uploads, the message parsers and photos being
put together, and per rover: the physical state, the downlink (TX FIFO, recorder stream and
products, dump replies, boot frames), image memory and capture, the device state and the
**machine** (core, both CPU contexts, the I/O page's latches, both source images, which are
reassembled on load), and **only chunks that are dirty or explored**: fog as run lengths
plus a sparse `[layer, index, id]` diff against the regenerated chunk. A saved-then-loaded
world continues **bit-identically** to an uninterrupted one (tested). Typical size: a few KB.

**[M15] Saves reset:** saves from before the Blue-11 (versions 1–20, Rover-ASM) are not
migrated. Loading one raises `OldSaveError`; the game says so plainly ("This save … is from
before the rover's computer was replaced by the Blue-11 … start a new world"), clears the
autosave and starts a new world.

The browser keeps one autosave in `localStorage` (every 30 s and on page hide) and resumes
it on startup unless the URL asks for a different `?seed`. Saves can be exported to and
imported from JSON files.

## 3.7 Upgrades & supply drops **[M7]**

Science credits buy upgrades (`src/core/upgrades.ts`) in the Upgrades tab. A purchase
is **not instant**: a supply crate (`CRATE`, layer 2) is dropped by parachute on a
clear tile 3–6 tiles (Manhattan) from the rover and lands after 80 ticks. The rover must
pick it up with the grabber (`ACT` with `F.T1`); the upgrade is **installed immediately**
on pickup and needs no cargo slot. Registers: `DROPS` (landed crates waiting), `DROPX`,
`DROPY` (nearest landed crate; the rover's own position if none). Template:
*Fetch supply crate*.

| Upgrade (id) | Cost | Effect | Requires |
| :--- | :--- | :--- | :--- |
| CPU overclock I / II (`CPU_96` / `CPU_128`) | 50 / 100 | 96 / 128 cycles per tick | – / I |
| Cargo racks (`CARGO_6`) | 35 | 6 cargo slots | – |
| Battery pack (`BATTERY_150`) | 60 | Capacity 150 000 (`BAT` stays a percentage) | – |
| High-efficiency cells (`SOLAR_PLUS`) | 50 | Solar output +25 % | – |
| Long-range radar (`LIDAR_8`) | 40 | Radar range 8, day and night | – |
| Hull plating (`ARMOR`) | 60 | Squall hull wear halved | – |
| Seismic scanner (`SEISMIC`) | 80 | Fits hardpoint 3: `ACT` dir, `F.T3` finds the nearest ore vein ≤ 12 tiles away *through walls* (4 ticks, 150 energy) → `SEITYP`, `SEIDST` | – |
| Recorder 4 KB / 8 KB (`REC_4K` / `REC_8K`) | 40 / 80 | Science recorder 4 / 8 KB | – / 4 KB |
| High-gain amplifier (`LINK_6`) | 60 | Link 6 B/tick at full signal | – |
| Colour filter wheel (`CAM_COLOUR`) | 60 | Camera mode 3 | – |
| Hi-res sensor (`CAM_HIRES`) | 80 | Camera mode 4 | Recorder 4 KB |
| Colour sensor (`CAM_RGB`) | 100 | Camera mode 5 | Colour filter wheel, Recorder 4 KB |

**[M15]** The flash, RAM, register-file and trace-buffer upgrades left the catalogue with
Rover-ASM. Memory boards (core 4 / 8 KB) and the EIS option (hardware `MUL` / `DIV`) are
designed ([`BLUE11_CPU.md`](BLUE11_CPU.md) §6.1, §9.2) but not in the catalogue yet. Goal
*Upgraded*: install a first upgrade.

## 3.8 Downlink, debugging and science products **[M9]**

Design principle: **mission control knows only what the rover sent**, plus the code it
uploaded itself. There is no live view of registers, stacks or the I/O page for the player
(the admin debugger is an "omniscient" view, labelled as such). Everything the player
learns about the rover crosses the radio link as bytes, so the encoding is the game.

### 3.8.1 The link

The rover has **one downlink transmitter** shared by several on-board buffers:

```
system (dump replies, boot frames)       ─┐
CPU ── TXBUF ─► TX FIFO (64 B, lossy)    ─┼─► transmitter ─► orbiter ─► mission control
CPU ── RECBUF ─► recorder (2 KB, reliable)┤
spectrometer ─► recorder products        ─┘
```

* **Rate:** `linkBytesPerTick` = 4 bytes per tick at `SIGNAL` 100 (Mk-I; 2 before M15, when
  photos were a quarter of the size), proportional to signal (an integer accumulator).
  Nothing is sent below `linkMinSignal` = 20.
* **Order:** dump replies first, then boot frames, then the TX FIFO, then the recorder
  (its message stream, then spectra). Chatty real-time output therefore starves science: a
  deliberate trade-off. The channels are separate (like CCSDS virtual channels): a
  higher one may take the link between two bytes of a lower one, which then resumes.
* **Energy:** `linkEnergyPerTick` = 2 for every tick in which at least one byte is sent.
  A badly aimed dish sends the same bytes more slowly and so costs more energy.
* The transmitter runs by itself; code never waits for it. It keeps running while the CPU
  is halted or faulted, and stops when the rover is powered off.

### 3.8.2 Messages and frames (on-air format)

**Messages [M15]** are what the code sends, on the TX FIFO or through the recorder. The code
writes the framing itself (the ROM's `LOG`, `PUTMSG`, `SEND` and `SNDIMG` do it for the
common cases), byte by byte:

```
SOH  type  length  body (length bytes)  ETX
001  1 B   1 B     0–255 B              003
```

Types `000`–`077` are the system's: `T.TEXT` (characters), `T.ERR` (an error code and
an address), `T.LOG` (a tag byte and a 16-bit value, low byte first), `T.DATA`, `T.IMG`,
`T.SPEC`; `100`–`377` are free for the player's own formats. Ground checks the length and the
`ETX`: a message that lost bytes (the FIFO was full: `TXLOST` counts them) is shown as
**broken**, one cut off by a reboot as **incomplete**. Comms names log tags from the `L.`
symbols the uploaded code defines (`L.BAT = 1`).

**System frames** start with a header byte (`1 1111 00 0` = `F8` for dumps, `0 1111 ss 0`
for boot frames): the **boot frame** after every hard reboot carries the reason (1 code
upload, 2 watchdog (the fault reset), 3 cold boot, 4 admin, 5 watchdog timeout, 7 CPU
fault) as a signed value in the smallest of 1/2/4 bytes, big-endian. **Science frames**
(spectra) start with `1 type level 0`, a sequence byte, then the payload.

### 3.8.3 Output registers and the display

* **`TXCS`** (bit 7 `READY`: room for a byte; bit 6 `IE`), **`TXBUF`** (write a byte),
  **`TXFREE`** (free FIFO bytes), **`TXLOST`** (bytes dropped since boot, saturates at 255).
  `PUTMSG` checks `TXFREE` first, so ROM output is all or nothing (`E.FULL` otherwise).
* **`RECCS`**, **`RECBUF`**, **`RECFRE`**: the same for the recorder (store and forward).
* **`DISP` (RW, 0–255) [M9]:** a two-digit hexadecimal display on the back of the cabin,
  at the original machine's console display register address (`177570`). Free, no link
  needed; writes keep the low byte; physical (survives reboots), dark while powered off.
  Mission control does not receive it: the operator reads it in the 3D view.
* **Comms tab** (mission control): every received message and frame with its tick of
  arrival, decoded (`L.BAT = 87 fw L74`); *Decode bytes* explains every byte. Mission
  control keeps the last 100 messages and 200 frames (saved).

### 3.8.4 Memory dumps and breakpoints

* **Uplinked commands** (Code tab dump box: *Dump registers*, *Dump stack*, *Resume after
  BPT* = `CONTINUE`, *Restart* = `RUN_AGAIN`): paid like a small upload,
  `ceil(150 × 100 / max(10, SIGNAL))` energy; free with the admin *Free uploads* cheat.
  Rejected (nothing paid) while the rover is powered off, when the battery cannot pay, or
  when 4 dump replies are still waiting.
* **Dump replies** are taken the moment the command arrives and go down first. On air:
  `F8`, the kind, the payload length, the payload; words low byte first.
  * *Registers* (kind 5 firmware, 7 program; 22 B on air): state 1 B (firmware: `RUNNING` 0,
    `HALTED` 2, `FAULT` 3; program: `PRGST`), `PSW`, `R0`–`R5`, `SP`, `PC`.
  * *Stack* (kind 6 / 8): `SP`, a count, up to 8 words from `SP` towards the stack's base
    (the firmware's at `PRGBAS`, the program's at the top of core).
  * Mission control shows a dump as a **snapshot with the tick it was taken**, with the PC
    turned into a source line of the uploaded code:
    `PROGRAM DUMP (snapshot t8): PC 002002 (L17) · PROG_HALTED · PSW 170004 nZvc · R0=000001 …`.
    Kinds 1–4 were Rover-ASM's dumps (retired).
* **`BPT`** in the program stops it (`P.HLT`, `W.BPT`); the firmware runs on. `BPT` or
  `HALT` in the firmware halts the whole CPU (`HALTED`): actuators keep moving, the
  transmitter keeps sending, the watchdog does not fire. *Continue* resumes after it. A
  breakpoint **reports itself**: the rover queues a register dump of that slot unasked;
  Comms marks it *sent by BPT*.
* **Admin view:** the live debugger (registers in octal, `PSW`, the next instruction
  disassembled, the stack, the I/O page, cycles this tick, single-step) is hidden unless
  *Live debugger* is ticked on the Admin tab. It reads the machine without side effects.

### 3.8.5 Science products and the recorder

Science lives in the **science recorder** (Mk-I 2 KB) until it has been sent completely;
it is never lost. The space is freed when the last byte is sent.

| Type | Product | Payload | Source |
| :--- | :--- | :--- | :--- |
| 0 | Spectrum: 16 bands 400–1000 nm, 1 B each | 16 B (18 B on air) | spectrometer, `ACT` slot, `F.T2` |
| 1 | Photo 64×64, 2 bpp grey | 1 KB | camera, Mk-I |
| 2 | Photo 64×64, 2 bpp grey, ordered dither | 1 KB | camera, Mk-I |
| 3 | Photo 64×64, 4 bpp, 16-colour planet palette | 2 KB | upgrade *Colour filter wheel* |
| 4 | Photo 128×128, 2 bpp grey, dithered | 4 KB | upgrade *Hi-res sensor* |
| 5 | Photo 64×64, 8 bpp RGB332 | 4 KB | upgrade *Colour sensor* |

**[M15]** Photos have double the M9 resolution (owner, 2026-11-15) and are packed
**little-endian**, row by row: the first pixel of a byte sits in its **low** bits (2 bpp:
pixel 0 in bits 1–0 … pixel 3 in bits 7–6; 4 bpp: pixel 0 in the low nibble), so a word read
with `MOV` holds the pixels in order from bit 0 up. The camera auto-exposes before
quantizing. Reference renders: `preview.html?photos=1`, `?photos2x=1`.

* **Spectrometer**: needs 18 free recorder bytes (else `E.FULL`, the item is kept), then
  frees the cargo slot and records one spectrum. Each material has its own curve, scaled by
  a per-position brightness, with per-position band variation and a little sensor noise.
* **Camera** (mast, not a hardpoint; ROM `SNAP`, R0 = dir, R1 = mode): 10 ticks, 200
  energy; `E.INV` (bad direction or mode not installed), `E.LOWP`, `E.BUSY`. The photo goes
  into image memory (§3.8.7). Subject: the first rover, obstacle or item within 2 tiles in
  `dir`; with nothing that close, a **landscape** sampled from the world ahead (skyline,
  ground, sun). **Light:** `SUNLIT ≥ 20`, or the headlight on and `HDG = dir`; otherwise the
  photo is dark and worth nothing. The camera does **not** turn the rover.
* **Sending a photo:** ROM `SNDIMG` (R0 = the photo type, 0 = `IMGTYP`, the last photo's
  mode) frames image memory as `T.IMG` messages of 128 pixel bytes (body: type, chunk
  number, chunks, bytes; 135 B each on air) and writes them into the recorder, waiting for
  room. A 64×64 grey photo is 8 chunks, 1080 B: about 270 ticks at full signal. Ground puts
  the chunks back together in order; a missing chunk or a reboot drops the photo. `E.INV`
  for a type bigger than image memory.
* `RECFRE` (R): free recorder bytes. `SCIRDY` (R): spectra waiting in the recorder.
* **Content is deterministic:** a raw product is stored as a descriptor; its bytes come
  from a pure, integer-only function of the world seed and the descriptor
  (`src/core/imaging.ts`), so saves stay small and runs reproducible.

**Credits on delivery** (`BALANCE`): spectrum = the item's `science` value (sample 3, ore
1); lit photo = 1, +5 the first time a subject type is delivered; dark photo = 0. Goal
*Photographer*: deliver 3 lit photos.

**Anomalies:** 1 in `anomalyOneIn` = 40 cliff walls and samples (seeded per tile) hold a
**fossil** that only a photo of the tile as its subject shows. **Flag anomaly** on a
complete, lit photo in the gallery, one flag per photo: right, +20 the first time that tile
is flagged; wrong, −5 (never below 0). Goal *Anomaly hunter*: one correct flag.

**Gallery** (mission-control tab): received photos (crisp pixels, scaled up) and spectra
(bar charts), each with tick, position, size and a hex view; the last 100 products (saved).

### 3.8.6 Upgrades for the downlink and the camera

In the catalogue of §3.7: Recorder 4 / 8 KB, High-gain amplifier (6 B/tick), Colour filter
wheel (mode 3), Hi-res sensor (mode 4), Colour sensor (mode 5).

### 3.8.7 Image memory **[M12]**

Take a picture → change it → send it, with every byte readable and writable. Reference →
Image and the six *Image: …* lessons teach it.

* **Image memory** at `IMGBAS` (`100000`), as big as the largest photo the installed camera
  modes take (`IMGSIZ`; Mk-I 1 KB, 2 KB with *Colour filter wheel*, 4 KB with *Hi-res
  sensor* or *Colour sensor*). Read and write it with `MOV` / `MOVB` and every addressing
  mode; past its end is a bus error. **Non-volatile**, like a camera's flash: it keeps its
  contents through reboots and power-off; only a new `SNAP` (overwrites it) and `ERASE`
  clear it, never `SNDIMG`. Saved.
* **`SNAP`** writes the photo's bytes into image memory and remembers the **capture** (the
  descriptor and the noise seed).
* **`ERASE`** (ROM; the image block's `F.ERAS`, 2 ticks, 10 energy): zeroes image memory and
  drops the capture.
* **Provenance:** ground calls a photo *raw* if its bytes are the capture's, *edited* if
  they differ, *drawn* if there is no capture behind it (`SNDIMG` after `ERASE`, or a type
  other than the capture's). The Gallery labels every photo.
* **Credits** come from the capture, never from the bytes: the first photo of the
  capture's type sent after a `SNAP` carries it (lit photo 1, +5 first of a subject type;
  anomaly flags checked against the real tile). Drawn pictures earn nothing. The first lit
  *edited* photo in each camera mode earns `editFirstBonus` = +5 more (goal *Darkroom*).
* **Code tab warning:** code that `SNAP`s while neither slot ever sends (`SNDIMG` or
  `RECBUF`) is flagged; it still assembles and uploads.

## 3.9 Firmware and programs **[M10]**

The rover runs two pieces of code on its one CPU, like a spacecraft's flight software
running uplinked command sequences, or a small OS starting user programs:

* **Firmware** keeps the rover alive (sun, dish, squalls, low battery, lights) and decides
  when the program runs. The default firmware ships with every rover. Advanced players
  edit and upload it (full upload cost, hard reboot).
* **Program**: the player's task (Explorer, Prospector, Fetch, ...). Beginners only write
  programs. *Upload program* pays only for the program's bytes and does **not** reboot.

### 3.9.1 Slots, core and contexts

* **Two separate sources**, assembled separately: each has its own labels and symbols. Each
  has its own **region of core** (§5.7): the firmware `000200`–`001777` (896 B), the program
  from `002000` up to its stack at the top of core (Mk-I 1022 B). Code that does not fit its
  region is an assembler error that names the limit.
* **Separate contexts**: each slot has its own registers, `PC`, `PSW` and stack. Everything
  physical is shared: the I/O page, actuators, cargo, lights, the downlink.
* **Protection** (the only memory protection): the program runs in user mode. It may write
  its own region, image memory and the I/O registers not marked *firmware only*; any other
  write is a protection fault. Reads are allowed everywhere (a player can read the firmware
  and the ROM). `HALT` and `RESET` do not work in user mode as on the original machine, but
  `HALT` ends the program (below).
* A firmware without the gate (`PRGCS`, or the ROM's `RUN`) never runs the program; the
  all-in-one firmware templates are like that.

### 3.9.2 The gate, the program's end and the program state

The firmware **calls** the program through a gate, and the slice timer or an interrupt
condition brings control back, as an operating system runs a task.

* **`MOV #GO, @#PRGCS`** (firmware only): if `PRGST` is `P.RDY`, the CPU swaps its whole
  register set, `PC` and `PSW` to the program's (where it was; from its start after a
  restart) **in the same tick** with the cycles left. Otherwise nothing happens and
  `PRGCS` bit 15 (`ERR`) says the gate was refused.
* **`SLICE`** (firmware only): the ticks the next run may last, 0–30000; **0 = no limit**
  (the reboot value). Read inside the program: ticks left. **`JSR PC, RUN`** (ROM: R0 =
  ticks) writes `SLICE`, goes through the gate and returns `PRGST` in R0.
* **The program returns to the firmware**, which continues after its gate write, on `HALT`
  (its `R0` → `PRGRES`, `P.DONE`, `W.DONE`) or `RTS PC` from its top level (the ROM's `EXIT`
  stub is its return address), when **its slice runs out** (`P.RDY`, `W.TIME`), on a
  `PREMPT` condition (`P.RDY`, `W.PRE`, `PRMPTD` = the bits), a fault (`P.FLT`, `W.FLT`,
  `PRGER` = the fault code, `PRGPC` = where) or `BPT` (`P.HLT`, `W.BPT`). `PRGCS` bits 3–1
  say why (`W.…`).
* **Interrupts happen only at the start of a tick, between instructions.** An interrupt or
  `TRAP` during the program swaps only the stack pointer, like the original /45 model's kernel
  and user SPs: the firmware's handler runs on the program's R0–R5 (saving what it uses) and
  the firmware's stack, and its `RTI` returns into the program. The program's devices keep
  running across a return to the firmware; nothing is aborted.
* **`TRAP n`** in the program is a system call: vector `034`, served by a firmware handler
  that may `RTI` back. With no handler installed, `TRAP` is a program fault (`PF.TRP`).
* **`PRGST`** (firmware writes): `P.NONE` 0 (nothing to run), `P.RDY` 1, `P.RUN` 2 (only the
  program and dumps see this), `P.DONE` 3, `P.FLT` 4, `P.HLT` 5. The firmware writes
  `P.NONE` to **acknowledge** a finished or faulted program (it stays in core but is not
  run), or `P.RDY` to **restart** it from its start. *Run again* keeps the memory the
  program changed; a reboot reloads its image.
* **Program faults** (odd address, no memory there, protection, stack overflow, illegal
  instruction; `PF.…` in `PRGER`) set `P.FLT` and return to the firmware. No reboot.
* **Fault protection (`PREMPT`) [M13]:** the firmware arms conditions that end a run at
  once: `PR.ALR` 1 (a world event is announced this tick), `PR.DMG` 2 (hull, array or dish
  lost integrity this tick), `PR.BAT` 4 (`BAT` below `BATALM`, 0–100). Checked at the start
  of every tick of a run: the program is interrupted between instructions and stays
  `P.RDY`, so the next gate resumes it. Its devices keep running: the firmware decides
  (`CLR @#DRVCNT` stops the drive at the end of its tile; the drive ends with `E.PRE`).
  `PRMPTD` holds the bits that fired until the next gate. `PREMPT`, `BATALM`, `PRMPTD` are 0
  after every hard reboot. The default firmware arms `PR.ALR!PR.BAT`, stops the wheels and
  logs `L.PRE`.
* **`BPT` in a program** sets `P.HLT`; *Continue* (Program slot) makes it `P.RDY`, so the
  next gate resumes after the `BPT`. `BPT` or `HALT` in the firmware halts the whole CPU.
* **Hard reboots** reset both contexts; `PRGST` becomes `P.RDY` if a program is in core.

### 3.9.3 Uploads and mission-control commands

* **Upload program**: `ceil((200 + 6 × program bytes) × 100 / max(10, SIGNAL))` energy. No
  reboot: the image is written into core at once and the program restarts as `P.RDY` (a
  run in progress ends first, when the firmware's handler returns). An empty source erases
  the program (`P.NONE`).
* **Upload firmware**: as §3.3 (base 500 + 6 × image bytes, hard reboot). A firmware
  upload also ends safe mode.
* **Code tab**: a **Program** (default) / **Firmware** (advanced) switch, each slot with its
  own editor (Blue-11 assembly highlighting, assembler errors and warnings) and templates,
  *Upload program* or *Upload firmware & reboot*, a core bar `firmware 326 / 896 · program
  32 / 1022 B · core 2 KB` (the edited slot counts its draft), the octal listing pane, and
  warnings when the firmware has no gate or code takes photos it never sends. New rovers
  ship the default firmware and no program (the Program slot shows *First steps* as an
  unsent draft).
* **Commands per slot**: *Dump registers*, *Dump stack* and *Resume after BPT* address one
  slot (the Code tab's); *Restart* (`RUN_AGAIN`, paid like a dump) restarts the program,
  like the firmware writing `P.RDY`; rejected without a program.
* **Dump box and Comms [M11]:** the Code tab's *Dump program / firmware state* box shows the
  newest dump of each kind as a card (registers in octal, hover for decimal; the PC as a link
  to its line; marked ◆ in the listing) and waiting requests with an estimate. The **Comms**
  tab is one timeline of both directions (▲ uploads and requests, ▼ messages, dumps, system
  frames, science) with a *Radio link* box (signal, TX FIFO, recorder, `TXLOST`); dumps and,
  with *Decode bytes*, every message are explained byte by byte. **Reference → Radio**
  documents every format with decoded examples. **Mission events** (under the side panel)
  shows the world and the game.

### 3.9.4 Default firmware and the lessons

The **default firmware** (326 B, `src/core/programs.ts`): a line-clock handler does the
housekeeping every 8 ticks, also in the middle of a program (dish on the orbiter, array on
the sun while charging, stow on a squall warning, the link lamp); the main loop arms and
kicks the watchdog, charges below `LOWBAT` 30 % until `FULBAT` 90 % (the array open, no
program), runs the program in 50-tick slices with `RUN` and logs the outcome (`L.END` the state,
`L.RES` the result; `L.BAT` heartbeats while idle). Fault protection is built in
(`PR.ALR!PR.BAT`: stop the wheels, log `L.PRE`). Lamps: 1 the program, 2 charging, 3 the
uplink. Other firmware templates: *Minimal (the gate only)* and three all-in-one firmwares
(Explorer, Prospector, Fetch) that run no program.

**Program templates are lessons**: each starts with what it does, `; Learn:` and `; Try:`.
Every template assembles and runs to its expected result in the tests.

| Template | Teaches | B |
| :--- | :--- | ---: |
| First steps | `JSR PC, STEP`, registers, a loop, `HALT` with a result | 32 |
| Drive yourself | the drive block: `DRVDIR`, `DRVCNT`, `GO`, `DONE`, `ERR`: what `STEP` really is | 54 |
| Count with a variable | `.WORD`, `INC` on memory; memory survives *Run again* | 62 |
| Route | a table in the program, autoincrement `(R1)+` | 55 |
| Drive and scan at once | two devices at once (the radar is outside the chassis interlock) | 78 |
| Explorer | the radar (`SCAN`, `RADHIT`), tile symbols, telling errors apart, `LOG` | 86 |
| Photographer | `SNAP`, `SNDIMG`, `HDG` for the headlight | 44 |
| Prospector | tools (`ACT`), cargo (`MOVB CARGO(R1)`), subroutines | 116 |
| Field repair | `USE`, index deferred `@HEALTH(R2)` | 70 |
| Fetch supply crate | positions, `SUB`, direction from a sign (`DIRTO`) | 70 |
| Spiral | a routine that falls into another, `LOG`, `BPT` | 68 |
| Seismic survey | an upgrade tool (`F.T3`), searching for a minimum | 96 |
| Weather station | `SLEEP`, `TICKL`, `DIV16`, the alert registers | 84 |
| Image: … (6) | image memory, words and bytes, `COM`, `PLOT`, a map in image memory | 32–94 |

### 3.9.5 Watchdog timer `WDT` **[M13]**

The fault reset (§3.2) only catches crashes. Real flight computers have a **watchdog
timer**: hardware that resets the CPU unless the software "kicks" it in time.

* **`WDT`** (firmware writes, up to 30000). Writing n > 0 **arms** the watchdog (the first
  time) and **kicks** it: it now expires n ticks from this one. Writing 0 does nothing:
  once armed it cannot be switched off until the next hard reboot. Read: ticks left, 0 =
  not armed.
* It counts down once per tick while the CPU runs, including while the program runs (the
  firmware cannot kick then). A halt freezes it, as a debugger does; a `FAULT` leaves it to
  the fault reset; a powered-off rover does not count.
* When it reaches 0: hard reboot (§3.3) with boot reason 5, *watchdog timeout*. A hard
  reboot disarms it, so a firmware arms it again with its first kick.
* **Runs count:** choose the timeout longer than a slice. A run **without a time limit**
  (`SLICE` 0) trusts the program: one that runs longer than the timeout trips the watchdog,
  and the reboot restarts it. The default firmware uses 1000 ticks and 50-tick slices.

## 4. World

* Infinite, signed integer coordinates. **`NORTH` = +Y, `EAST` = +X.**
* 16×16 chunks in a sparse `Map<"cx,cy", WorldChunk>`;
  `cx = floor(x / 16)`, `lx = ((x % 16) + 16) % 16`.
* Each chunk: four `Uint16Array(256)` layers, a `Uint8Array(256)` fog mask, a `dirty`
  flag (any tile modified vs. generation), an `explored` flag, and `lastTouched`.
* **Fog of war [M4]:** tiles within the current sensor range of a rover become *mapped*
  (permanent). "Currently visible" is derived from rover positions, not stored. Unmapped
  tiles render as faint survey marks.
* Layers: 0 terrain · 1 obstacles & veins · 2 surface items · 3 actors.
* **Units are authoritative** for their own position; layer 3 is not stored and is
  computed from the `UnitRegistry` when queried.
* Generation is a pure function of `(seed, x, y)` built from integer hashing plus value
  noise, so chunk borders are seamless regardless of generation order. A 5×5 clear
  `SAND` landing zone surrounds `(0, 0)`.
* Chunks within a 3×3 radius of any rover stay loaded. Chunks that are neither dirty
  nor explored and that nothing has touched for a while are evicted and regenerated on
  demand. Dirty and explored chunks stay (they are part of the save).
* Tile ID `0` is `NONE` in every layer. Tiles are declared in `WorldRegistry`; each
  declaration's `shortName` automatically becomes a predefined symbol (§5.5).

## 5. The Blue-11 and its assembly language **[M15]**

The rover's computer is the **Blue-11**. It implements the PDP-11 instruction set (a subset
of its assembler syntax): a 16-bit CPU with eight registers, one byte-addressed memory,
eight addressing modes, condition flags, traps and interrupts, programmed in **Blue-11
assembly**. The CPU, assembler and disassembler are the standalone library `src/blue11/`
(API and every departure from the original: [`src/blue11/README.md`](../src/blue11/README.md));
the design and its decisions: [`BLUE11_CPU.md`](BLUE11_CPU.md) (CPU, memory, gate, ROM) and
[`BLUE11_IO.md`](BLUE11_IO.md) (I/O page, devices, interrupts, names). Rover-ASM (M1–M14)
was removed in M15 slice 6. The in-game **Reference** tab documents the language from the
same tables.

### 5.1 Lines, names and numbers

* One statement per line: `[LABEL:] OPCODE src, dst ; comment`. Source operand first.
  Case-insensitive.
* **Numbers are octal** by default: `20` is sixteen, `20.` is twenty (decimal),
  `^B10100` binary, `'A` a character code. Expressions go strictly left to right (`2+3*4` is
  20); `< >` groups; operators `+ - * /`, `&` (and), `!` (or).
* **Names have at most six characters** (letters, digits, `.`, `$`); a longer name is an
  error, not silently cut (decision 17). `NAME = expr` defines a symbol, `NAME = %n` a
  register name. Local labels `1$:` are valid up to the next ordinary label.
* Directives: `.WORD`, `.BYTE`, `.ASCII`, `.ASCIZ`, `.BLKW`, `.BLKB`, `.EVEN`, `. = . + n`,
  `.END [start]`. An expression where the instruction goes is an implicit `.WORD`.
* Macros, conditional assembly, sections and linking are not supported (always an error).
* Errors and warnings are shown in the editor with their line; an image with errors is not
  uploaded.

### 5.2 Registers

`R0`–`R5` general; `SP` (`R6`) the stack pointer (the stack grows down, `JSR` pushes the
return address); `PC` (`R7`). The **`PSW`** (at `177776`) holds the priority (bits 7–5),
the trace bit `T` (4) and the condition codes `N Z V C` (3–0); in program mode bits 15–14
say user mode. Words are 16 bits, stored **low byte first** at even addresses; a word
access to an odd address is a bus error.

### 5.3 Addressing modes

| Mode | Syntax | Operand | Example |
| :--- | :--- | :--- | :--- |
| 0 | `R` | the register | `MOV R1, R2` |
| 1 | `(R)` | the word R points at | `CLR (R1)` |
| 2 | `(R)+` | the word R points at, then R += 2 (1 for a byte) | `MOV (R1)+, R0` |
| 3 | `@(R)+` | R points at an address; R += 2 | `JMP @(R1)+` |
| 4 | `-(R)` | R −= 2 first, then the word it points at (a push) | `MOV R0, -(SP)` |
| 5 | `@-(R)` | R −= 2, then the address it points at | `TST @-(R2)` |
| 6 | `X(R)` | the word at R + X | `MOVB CARGO(R1), R0` |
| 7 | `@X(R)` | the address stored at R + X | `INC @HEALTH(R2)` |
| PC | `#n`, `@#a`, `LABEL`, `@LABEL` | immediate, absolute, relative, relative deferred | `MOV #5, @#IND1` |

### 5.4 Instructions

The original /40 model's instruction set (with byte forms `MOVB`, `CMPB`…):

* **Two operands:** `MOV CMP BIT BIC BIS ADD SUB`, `XOR`.
* **One operand:** `CLR COM INC DEC NEG ADC SBC TST ROR ROL ASR ASL SWAB SXT`.
* **Branches** (±127 words): `BR BNE BEQ BPL BMI BVC BVS BCC BCS BGE BLT BGT BLE BHI BLOS
  BHIS BLO`, and `SOB`.
* **Jumps and subroutines:** `JMP`, `JSR reg, dst`, `RTS reg`, `MARK` is left out.
* **Traps and control:** `TRAP n`, `EMT n`, `BPT`, `IOT`, `RTI`, `RTT`, `HALT`, `WAIT`,
  `RESET`, `NOP`, the flag operations `CLC CLV CLZ CLN SEC SEV SEZ SEN CCC SCC`.
* **Multiply and divide** are ROM routines (`MUL16`, `DIV16`); the hardware `MUL DIV ASH
  ASHC` come with the EIS option (designed as an upgrade, not in the catalogue yet), and
  without it they are illegal instructions (trap to `010`).

Every instruction's syntax, effect and flags are in Reference → Instructions (generated; a
test checks every instruction has a row).

### 5.5 Predefined symbols

Every program gets these names (six characters at most; a label with one of them is an
error, `NAME = expr` may reassign one):

* **I/O registers** (§5.6), `PSW`, `CARGO`, `PRGBAS` (`002000`), `IMGBAS` (`100000`).
* **ROM routines** (§5.9): `STEP SCAN SLEEP ACT USE SNAP SEND ERASE RUN LOG PUTMSG SNDIMG
  MUL16 DIV16 ABS DIRTO PLOT`.
* **CSR bits** `GO` 1, `IE` 100, `DONE` / `READY` 200, `ERR` 100000; **function codes**
  already shifted into bits 3–1: `F.T0`–`F.T3`, `F.M1`–`F.M5`, `F.HULL F.SOL F.ANT`, `F.ERAS`.
* **Error codes** `OK`, `E.INV E.FULL E.LOWP E.BLK E.NOTL E.NOSG E.HAZ E.DEPL E.PRE E.BUSY`.
* **Directions** `NORTH EAST SOUTH WEST`; **colours** `OFF RED GREEN BLUE AMBER`; **alerts**
  `A.NONE A.ECL A.SQL`; **program states** `P.NONE P.RDY P.RUN P.DONE P.FLT P.HLT`; why a run
  ended `W.DONE W.TIME W.PRE W.FLT W.BPT`; program faults `PF.ODD PF.NXM PF.PRO PF.STK PF.ILL
  PF.IOT PF.EMT PF.TRP`; preemption `PR.ALR PR.DMG PR.BAT`; message types `T.TEXT T.ERR T.LOG
  T.DATA T.IMG T.SPEC`, `SOH`, `ETX`; `SAFE`.
* **Tiles** by their short names: `NONE SAND GRAVEL VENT CLIFF IRON SILIC KIT SAMPLE CRATE
  ROVER` (`WorldRegistry` `shortName`).

### 5.6 The I/O page

Devices are registers at fixed addresses (`170000`–`177777`), read and written with any
instruction. Table: Reference → I/O page (generated from `src/core/machine/iopage.ts`);
details [`BLUE11_IO.md`](BLUE11_IO.md) §3.

| Block | Registers |
| :--- | :--- |
| Telemetry `176000` (read-only) | `BAT HULL SOLHLT ANTHLT X Y TICKL TICKH GROUND GNDHAZ TEMP HEATER CRGFRE SCIRDY RECFRE RADRNG ALERT ALRETA DROPS DROPX DROPY SUNAZ SUNEL SUNLIT SOLDST ORBAZ SIGNAL`. `X`, `Y`, `DROPX`, `DROPY`, `TEMP`, `SUNEL` are signed. Reading `TICKL` freezes `TICKH`, so the pair matches. |
| Actuators `176200` | `HDG` (write turns in place, wraps mod 4), `LIGHT`, `SOLOPN`, `SOLANG`, `ANTANG` (write the target, read the current bearing), `IND1`–`IND3`; `DISP` at `177570` |
| Devices `176400`… | drive `DRVCS DRVER DRVDIR DRVCNT`; radar `RADCS RADER RADDIR RADHIT RADDST`; tools `TOLCS TOLER TOLARG TOLLFT SEITYP SEIDST`; repair `REPCS REPER REPSLT REPLFT`; camera `CAMCS CAMER CAMDIR CAMLFT`; image `IMGCS IMGER IMGTYP IMGLFT IMGSIZ` |
| Output `176540` | `TXCS TXBUF TXFREE TXLOST`, `RECCS RECBUF RECFRE` (§3.8.3) |
| Cargo `176600` | one read-only byte per slot: `MOVB CARGO(R1), R0` |
| Program control `177000` (firmware writes) | `PRGCS PRGER PRGST PRGRES PRGPC SLICE PREMPT PRMPTD BATALM WDT REBOOT BOOTCS BOOTCT` (§3.9) |
| CPU and clock | `LKS` (`177546`, the line clock), `STKLIM` (`177774`), `PSW` (`177776`) |

**The device CSR** (every device block, after DEC's): bit 0 `GO` (write: start with the
latched parameters), bits 3–1 `FN` (the function), bit 6 `IE` (firmware: interrupt when
done), bit 7 `DONE` (idle), bit 15 `ERR` (refused or failed; the reason in `xxER`). One path
for every outcome: write the parameters, write `GO`; a refusal sets `ERR` and `xxER` **in the
same instruction**; then wait for `DONE` and look at `ERR`. Bits 7 and 15 are sign bits, so
`TSTB` / `TST` test them without a mask. Drive, tools, repair and camera share the chassis
(one at a time, `E.BUSY`); the radar runs alongside. `DRVCNT` counts down while driving and
reads 0 afterwards; writing 0 while driving stops at the end of the tile (`E.PRE`).

Registers marked *firmware only* (program control, `IE` bits, `LKS`, `STKLIM`) refuse
program writes with a protection fault.

### 5.7 Memory map

| Address | What |
| :--- | :--- |
| `000000`–`000177` | trap and interrupt vectors (the boot ROM fills them) |
| `000200`–`001777` | the firmware's region: code, data, its stack below `PRGBAS` (896 B) |
| `002000`–top of core | the program's region; its stack starts at the top of core (Mk-I core 2 KB: 1022 B of code and data) |
| `100000`– | image memory (`IMGBAS`, `IMGSIZ` bytes) |
| `160000`–`167777` | the ROM (read and execute only) |
| `170000`–`177777` | the I/O page |

64 KB are addressable; the Mk-I has 2 KB of core (memory boards are designed, §3.7). An
access where nothing is installed is a bus error (trap to `004`). Code and data share
memory: tables are read with `MOV`, and code can modify itself. The images are kept on the
rover ("on its disk"): a hard reboot copies both back into core (§3.3).

### 5.8 Cycles, traps and interrupts

* **Cycles:** one per bus access (§2.1); a tick gives `cyclesPerTick`. An instruction never
  runs half: if the budget is spent it waits for the next tick.
* **Traps** (vectors used by both contexts): `004` bus error (odd address, nothing there,
  protection, stack overflow below `STKLIM` / the program's limit), `010` illegal
  instruction, `014` `BPT` and the trace bit, `020` `IOT`, `030` `EMT`, `034` `TRAP n` (a
  system call the firmware serves). In the program a trap is a **program fault** that
  returns to the firmware (§3.9.2), except `TRAP` with a firmware handler. In the firmware
  the ROM's handlers reboot on a bus error or illegal instruction (boot reason 7) and halt on
  `BPT`; a trap inside a trap is a double fault (`FAULT`, §3.2).
* **Interrupts** arrive at tick starts: the line clock at level 6 (vector `100`, every tick
  while `LKS` has `IE`; the boot ROM sets it), the devices at level 4 (vectors `120`–`144`,
  when `DONE` becomes 1 with `IE` set) and `TX` room (`150`). The CPU takes one when its
  priority (`PSW` bits 7–5) is lower. `WAIT` sleeps until the next interrupt. Program
  interrupt handlers are firmware-only in v1.

### 5.9 The ROM

The ROM (`src/core/machine/rom.ts`, written in Blue-11 assembly, readable in Reference →
ROM) boots the rover and offers routines: `JSR PC, name`, arguments in `R0`, `R1` (a third
in `R2`, kept), the answer in `R0` with the flags set from it. **They may change `R0` and
`R1`**, nothing else.

| Routine | Arguments | Does |
| :--- | :--- | :--- |
| `STEP` | R0 direction, R1 tiles | drive and wait; R0 = `OK` or why it stopped |
| `SCAN` | R0 direction | one radar sweep; then `RADHIT`, `RADDST` |
| `ACT` | R0 argument, R1 `F.T0`…`F.T3` | use a tool and wait |
| `USE` | R0 cargo slot, R1 `F.HULL` / `F.SOL` / `F.ANT` | field repair |
| `SNAP` | R0 direction, R1 `F.M1`…`F.M5` | a photo into image memory |
| `ERASE` | – | zero image memory |
| `SNDIMG` | R0 photo type (0 = the last photo's) | send image memory home as `T.IMG` messages through the recorder |
| `SLEEP` | R0 ticks (≤ 32767) | wait |
| `RUN` | R0 ticks (0 = no limit) | firmware: run the program; R0 = `PRGST` |
| `LOG` | R0 tag, R1 value | a `T.LOG` message on TX |
| `PUTMSG` | R0 type, R1 buffer, R2 length | a whole message on TX, or `E.FULL` |
| `SEND` | as `PUTMSG` | the same into the recorder (waits for room) |
| `MUL16` / `DIV16` | R0, R1 | multiply (low 16 bits) / divide (quotient, remainder; `C` on divide by 0) |
| `ABS`, `DIRTO`, `PLOT` | | absolute value; the direction towards (dx, dy); set a pixel of a 64×64 grey photo |

### 5.10 Code size

Code is measured in bytes of its image, the region of core it occupies (§5.7); the Code tab
shows both regions and a listing (address and words in octal, as the assembler writes it).
Uploads cost energy per byte (§3.3, §3.9.3).

## 6. Milestones

Milestone status, the detailed plan for the next step, open decisions and the
backlog live in [`ROADMAP.md`](ROADMAP.md). This spec describes *what the game is*;
the roadmap tracks *where the work is*.

## 7. Visual overhaul roadmap (M8)

The renderer is a read-only consumer of the simulation, and every shape is drawn in
`src/render/VectorFactory.ts`, so this whole milestone can happen without touching
gameplay, saves or tests.

* **Bloom / glow:** `EffectComposer` + `UnrealBloomPass` on emissive lines (ore crystals,
  scan rays, status lamps, headlight, acid vents). Selective bloom so the grid stays crisp.
* **Fat lines:** `Line2` / `LineSegments2` + `LineMaterial` for real pixel widths
  (WebGL lines are 1 px). Width can scale with zoom and importance.
* **Symbolic ground:** the map is an orbital scan read through a legend, not scenery: low
  3D symbols (cliffs as pyramids joined into ridgelines, gravel as hatching, ore as
  deposits sunk into pits, vents as hazard rings). Cheap enough that terrain needs no
  level of detail; the rover keeps its detailed model.
* **Wider zoom range:** from a single tile up to a strategic map view; far zoom switches
  to a simplified minimap-style rendering.
* **Camera:** optional perspective mode, zoom-to-cursor, smooth orbit/rotation, cinematic
  follow.
* **Atmosphere:** day/night color grading, distance fade, dust particles, CRT /
  scanline post-effect toggle, animated hazards and pickups.
* **Terrain height:** if elevation is added to the simulation, render it as wireframe
  relief.
* **Performance budget:** simple symbols + per-frame build limits keep far zoom affordable; measure
  with a frame-time HUD.
