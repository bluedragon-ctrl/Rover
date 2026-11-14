# Rover — Game & Language Specification (`v1.6`)

This document supersedes `v1.2` of the architecture/language review. It fixes the
inconsistencies found in review and pins down the numbers the code relies on.
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
| CPU cycles per tick | 4 (Mk-I) | Chassis stat; upgrades raise it. |
| Day length | 2400 ticks | 4 min real time at 10 Hz, `1x`. The game starts shortly after sunrise. **[M4]** |

The simulation is a fixed-timestep loop independent of rendering. Every random choice
uses a seeded PRNG; the core uses no `Math.random`, no wall-clock time and no
transcendental math (`sin`, `cos`) whose results might differ across browsers. Angles use
integer lookup tables.

### 2.1 Cycle budget: "think fast, move slow"

Each tick, every powered rover's CPU receives `cyclesPerTick` cycles.

* **Every instruction costs 1 cycle.** Mk-I has 8 cycles per tick (**[M14]**; 4 before, when
  the hardware had its own instructions). Several instructions run per tick.
* **[M14] There are no hardware instructions.** The CPU only computes and moves data; the
  hardware is a set of **devices** driven through ports (§5.9). Writing a device's start
  port (`MOV @DRIVE EAST`) is a 1-cycle port write that starts it; **`WAIT @port`** puts the
  CPU to sleep (`BLOCKED`, the tick ends) until the device is done. The ROM's routines
  (`CALL STEP EAST 3`, `CALL SCAN dir`, `CALL SLEEP 20`…) do both for you.
* Port writes (e.g. `MOV @IND1 2`) are compute instructions: instant.

This keeps logic snappy, makes physical actions cost real time, and naturally caps
runaway loops (an infinite `JMP` loop just burns cycles; it cannot freeze the game).

Tick order: (1) world/event update, (2) passive energy drain and actuators, (3) every device
advances (timers, radar, image send / erase, the drive or tool at work) and may finish, (4)
fault protection and the slice timer may return control to the firmware, (5) a CPU asleep in
`WAIT` wakes if its port reads 0, (6) each CPU spends its cycles.

## 3. The Rover (Mk-I chassis)

Each rover owns a copy of its chassis stats; upgrades (§3.7) modify that copy.

| Stat | Mk-I | Notes |
| :--- | :--- | :--- |
| Flash | 512 bytes (128 before M10, 256 before M14) | Machine-code size (§5.7), shared by firmware and program (§3.9). Comments, blank lines, label definitions, `ALIAS`, `CONST`, `VAR` are free; `DATA` costs its bytes. |
| RAM **[M14]** | 64 bytes at data address `0x000` | Shared by firmware and program, zero after a hard reboot; `VAR`, `LDB` / `STB` (§5.8). |
| Registers | 4 (`r0`–`r3`) | Signed 32-bit, wrap on overflow. |
| Data stack | 16 entries (8 before M14) | `PUSH`/`POP`, `CALL` arguments. |
| Cycles per tick | 8 (4 before M14) | §2.1; overclock upgrades 12 / 16. |
| Call stack | 8 frames | Return addresses only. |
| Battery | 100 000 energy units | Exposed as `@BAT` = 0–100 (%). |
| Hull | 100 | `@HULL`. |
| Subsystems | solar array 100, dish 100 | `@SOLAR_HEALTH`, `@ANTENNA_HEALTH`. **[M6]** |
| Cargo | 4 slots | Item IDs (= tile IDs). **[M5]** |
| Hardpoints | `TOOL_0` drill, `TOOL_1` grabber, `TOOL_2` spectrometer, `TOOL_3` empty | **[M5]** |
| Sensor range | 6 tiles | Radar (`@RADAR`, `CALL SCAN`), every direction, day and night. The operator's *view* needs light: 6 by day, 1-tile ring at night plus the headlight cone (§3.1.1). **[M4, M8.1]** |
| Downlink | 2 B/tick at full signal, log FIFO 32 B, science recorder 1024 B | **[M9]** §3.8 |
| Camera | mast camera, 32×32 2 bpp (modes 1–2) | `CALL SNAP dir mode` (`@CAM`, `@CAM_MODE`); modes 3–5 by upgrade. **[M9]** §3.8.5 |
| Image memory | 256 bytes (the largest installed camera mode), at data address `IMG` = `0x100` (M14) | A photo fills it, `LDB` / `STB` read and write it, `CALL SEND` sends it. **[M12]** §3.8.7 |
| ROM **[M14]** | device drivers at code address `0xF000` | `CALL STEP`, `CALL SCAN`… cost no Flash (§5.9). |
| Thermal | survival heaters hold −40 °C | `@TEMP`, `@HEATER`; dust on the array `@SOLAR_DUST`. **[M13]** §3.3.4 |
| Watchdog, fault protection | `@WDT`; `@PREEMPT`, `@BAT_ALARM` | Firmware-armed reset timer and slice preemption. **[M13]** §3.9.5, §3.9.2 |

### 3.1 Energy costs (defaults)

| Action | Ticks | Energy |
| :--- | :--- | :--- |
| Idle (CPU powered) | per tick | 1 |
| Drive (`@DRIVE`, `CALL STEP`) onto `FLAT_SAND` | 3 / tile | 40 / tile |
| Drive onto `ROUGH_GRAVEL` | 6 / tile | 120 / tile |
| Drive onto `ACID_VENT` | 4 / tile | 60 / tile + 10 hull damage |
| Radar sweep (`@RADAR`, `CALL SCAN`) | 1 | 10 |
| Turn in place (`@HEADING` write) | instant | 5 |
| Headlight on | per tick | 8 |
| Actuator moving (array deploy, panel or dish slew) | per tick, each | 1 |
| Survival heaters **[M13]** | per tick while `@HEATER` = 1 (cold: night, low sun) | 6 (§3.3.4) |
| Downlink transmitter | per tick in which bytes are sent | 2 (§3.8.1) |
| Solar charge | per tick | `floor(60 × SUN_LIGHT/100 × cos(panel − sun azimuth))` × `@SOLAR_HEALTH`% × (100 − `@SOLAR_DUST`)%, only when fully deployed |

### 3.1.1 Radar, operator view and the headlight **[M8.1]**

The rover and the player "see" differently:

* **The radar** (`@RADAR`, the ROM's `CALL SCAN`; `SCAN` before M14) reaches the chassis sensor range (6 tiles; 8 with the
  Long-range radar upgrade) in every direction, by day and by night. It needs no light
  and does not turn the rover. Firmware can always navigate.
* **The operator view needs light.** What the player sees (and what gets permanently
  mapped in the fog of war, and lit by the renderer) is one shape, `src/core/sensors.ts`:

| Condition | Operator sees |
| :--- | :--- |
| Day (`@SUN_ELEV > 0`) | Disc of radius 6 (`dx² + dy² ≤ r² + r`) around the rover. |
| Night | The 1-tile ring around the rover (radius-1 disc, diagonals included). |
| Night, `@HEADLIGHT 1` (powered) | Ring **plus a forward cone** along `@HEADING`: `1 ≤ forward ≤ 5`, `|lateral| ≤ 1` for `forward ≤ 2`, `≤ 2` beyond (21 tiles). |

* So at night a player cannot look at unexplored ground and type `CALL STEP NORTH 5`: they
  need the headlight pointed that way, already-mapped terrain, or code that uses the radar.
* Each radar sweep also sends a brief red **radar wave** around the rover out to the radar
  range: tiles flash as the front passes, then fade, and unmapped terrain in range is
  briefly outlined in red. It is a glimpse for the player only; it maps nothing. (The sweep still answers with just the first hit along `dir`.)
* The rover faces `@HEADING`. The drive and directional tools (`CALL ACT TOOL_n dir`) turn it;
  writing `@HEADING` turns it in place (5 energy, value wraps mod 4, so `ADD @HEADING 1`
  turns right). Use it to aim the headlight.

### 3.2 CPU states

| State | Meaning |
| :--- | :--- |
| `RUNNING` | Executing instructions. |
| `BLOCKED` | **[M14]** Asleep in `WAIT @port` until the port reads 0 (inside `CALL STEP`, `CALL SLEEP`…), or the firmware inside `CALL PROGRAM` while the program runs. |
| `HALTED` | **[M9]** Stopped by `BRK`; resumes on *Continue* or upload (§3.8.4). No watchdog. |
| `FAULT` | Stack overflow/underflow. The **fault reset** (boot reason "watchdog") hard-reboots the CPU after 50 ticks. A hang without a fault is caught only by the firmware's `@WDT` (§3.9.5). |
| `POWER_OFF` | Battery empty (§3.4). |
| `DESTROYED` | Hull at 0. Only the admin console can recover. |

### 3.3 Hard reboot (on code upload or watchdog)

`IP = 0`, all registers zeroed, both stacks cleared, RAM zeroed (M14), every device stopped
(drive, tool, radar, image send / erase, both timers) with its latched arguments back to the
reboot values and its result `OK` (M14, §5.9), `@STATUS = OK`. Physical state (position, battery, hull, cargo, actuator ports,
image memory) is kept.

Upload cost **[M4]**: `ceil((500 + 6 × bytes) × 100 / max(10, @SIGNAL_STR))` energy
(`uploadPerByte` 6 since M14, 12 before: Flash doubled; ≈ 1 % for an 85-byte program at full
signal, 10× that with the dish misaligned).
If the battery cannot pay, or the rover is powered off, the upload is rejected and the
old program keeps running. New rovers ship with factory firmware installed for free.

### 3.3.1 Sky, solar array and antenna **[M4]**

* **Sun:** azimuth and elevation are pure functions of the tick (integer trig tables).
  Sunrise is in the east (90°), noon in the south (180°) at 70°, sunset in the west.
  `@SUN_LIGHT = sin(elevation) × 100`, 0 at night (and during eclipses, M6).
* **Relay orbiter:** circles the sky once per 1800 ticks; `@ORBIT_AZIMUTH`.
* **Signal:** `@SIGNAL_STR = 100 × cos⁴(dish − orbiter)`; ≈ 50 at 33° off, 0 beyond 90°.
* **Motors:** writing `@SOLAR_ANGLE` / `@ANTENNA_ANGLE` sets a target; the turntable slews
  3°/tick and reading the port returns the *current* angle. Writing `@SOLAR_OPEN` starts a
  20-tick deploy/stow. Actuator state is physical: it survives reboots.
* **Movement lock:** `STEP` fails with `ERR_DEPLOYED` while the array is commanded open
  or not fully stowed.
* **Status lamps [M8]:** the rover's only status lights: three lamps on the cabin roof,
  `@IND1`, `@IND2`, `@IND3` (left to right), each takes a light colour constant (`OFF`,
  `RED`, `GREEN`, `BLUE`, `AMBER`, 0–4). They are purely a visual channel for the player:
  free, no gameplay effect, no `@STATUS`. They are physical and survive reboots; they go
  dark while the rover is powered off. Shipped firmware uses them the same way: lamp 1 =
  what the rover is doing (green running, blue done / idle, red fault), lamp 2 = power
  (amber charging), lamp 3 = uplink (blue while the dish is on the orbiter). The separate
  status beacon (`@LIGHT_COLOR`, `@LIGHT_BLINK`, M1–M8) was removed in save v12: old
  saves have those ports rewritten to `@IND1` / `@IND3`.
* **TX [M9]:** the byte-based downlink (§3.8) sends everything. Writing `@TX_DATA` is
  old shorthand for `LOG 0 value` that also sets `@STATUS` (`OK`, or `ERR_FULL` when the
  log FIFO had no room); it is the one port write that touches `@STATUS`. Before M9 it
  sent a 30-energy packet that also carried one science point.

### 3.3.2 Tools, cargo and science **[M5]**

Tools are declared in `src/core/tools.ts`; hardpoint assignment comes from the chassis.
`ACT TOOL_n arg` validates immediately (errors cost no time), then pays energy, blocks
the CPU for the tool's duration and applies the effect when it finishes (re-checking
that the target is still there). Tools work with the solar array deployed.

| Instruction | Tool | Ticks | Energy | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `ACT TOOL_0 dir` | Mining drill | 8 | 600 | Removes the adjacent ore vein (`IRON_ORE`, `SILICON_ORE`) and stores it in the first free slot. |
| `ACT TOOL_1 dir` | Grabber | 2 | 100 | Picks up the adjacent surface item (`SAMPLE`, `REPAIR_KIT`). Adjacent tiles only. |
| `ACT TOOL_2 slot` | Spectrometer | 30 | 300 | Analyzes the item in `slot`, frees it and records a spectrum (§3.8.5) worth `SAMPLE` 3 credits, ore 1. `ERR_FULL` (item kept) if the recorder lacks 18 bytes. |
| `ACT TOOL_3` | (empty) | – | – | `ERR_NO_TOOL`. |
| `USE slot [system]` | Field repair | 10 | 200 | Repairs `system` (default `SYS_HULL`) by **consuming the material** in cargo `slot` (see table below). |

Errors: `ERR_INVALID` (bad direction/slot, nothing usable there), `ERR_FULL` (no free
cargo slot), `ERR_LOW_POWER`, `ERR_NO_TOOL`.

**Science [M9]:** the spectrometer records a 16-byte spectrum in the science recorder;
`@SCIENCE_READY` counts the products waiting there. The downlink sends them by itself
(§3.8.5), and a product pays its credits when its last byte arrives. (M5–M8: every
successful `@TX_DATA` write carried one science point home.) Delivered
science adds **science credits**, as do completed goals. Credits are the currency for
M7 upgrades.

**Goals [M5]:** the `EventDirector` (future storyteller) tracks a fixed set of sandbox
goals (First contact, Night owl, Surveyor, Trailblazer, Prospector, Collector, Scientist),
each with a credit reward. Checked every 10 ticks; deterministic. Since M9, *First
contact* = mission control receives a first frame the firmware sent (a `LOG` frame or a
science product; the automatic boot frame does not count) and *Scientist* = 5 science
products delivered. M9 adds *Photographer* (3 lit photos) and *Anomaly hunter* (one correct anomaly flag,
§3.8.5). M12 adds *Darkroom* (one lit edited photo, §3.8.7).

### 3.3.3 Subsystem damage **[M6]**

Besides the hull, the solar array and the dish have their own integrity (0–100).
A damaged array charges proportionally less (`gain × @SOLAR_HEALTH / 100`); a damaged
dish gives proportionally weaker signal (`@SIGNAL_STR × @ANTENNA_HEALTH / 100`), which
also makes uploads more expensive. Repair with `USE slot SYS_SOLAR` / `SYS_ANTENNA`.
Hull 0 destroys the rover; a 0 subsystem just stops working.

Repairs consume materials from cargo (`USE slot system`); the item is used up. Which
material fixes what (`repairs` in the tile registry):

| Material | `SYS_HULL` | `SYS_SOLAR` | `SYS_ANTENNA` |
| :--- | :--- | :--- | :--- |
| `REPAIR_KIT` | +30 | +40 | +40 |
| `IRON_ORE` | +10 | – | +15 |
| `SILICON_ORE` | – | +20 | – |

A material that cannot fix the chosen system gives `ERR_INVALID` and is not consumed.
Ore is therefore a choice: analyze it for science, or keep it as spare parts.

### 3.3.4 Thermal and dust **[M13]**

Real rovers lose most of their night-time energy to keeping warm, and their solar output
to dust. Both are automatic hardware here: firmware cannot switch them off, only plan
around them. Numbers in `BALANCE`.

* **Ambient:** `ambientTemp(@SUN_LIGHT)` = −80 °C at light 0 (night, total eclipse) up to
  +20 °C at light 100, linear (−40 °C at light 40, so the evening and early morning are
  cold too).
* **`@TEMP`** (R, °C): the rover's internal temperature. Thermal inertia: it moves 1 °C toward
  the ambient every 4 ticks (on ticks divisible by 4). A new rover starts at the ambient.
* **Survival heaters** (thermostat): while the rover is powered and `@TEMP` ≤ −40 °C with
  the ambient below −40 °C, the heaters run (`@HEATER` = 1, 6 energy per tick) and hold
  the temperature, or warm a colder rover by 1 °C per 4 ticks. They run about 1450 ticks
  per sol (≈ 9 % of the battery). A powered-off rover has no heaters and cools to the
  ambient; there is no cold damage yet.
* **`@SOLAR_DUST`** (R, 0–100 %): +1 % every 800 ticks the array is not fully stowed
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

Every event is announced ahead of time: `@ALERT` reports the most urgent announced or
active event (`ALERT_NONE=0`, `ALERT_ECLIPSE=1`, `ALERT_SQUALL=2`) and `@ALERT_ETA` the
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

`SaveManager.serialize/deserialize` (headless). A save (`version: 17`; v1–v16 files are migrated
by `migrate()`) holds the seed, supply drops, installed upgrades, each rover's downlink
(log FIFO, transmitter budget, `@LOG_LOST`, recorder descriptors and progress, sequence
number, dump replies waiting), mission control's last 200 received frames, the gallery's last 100 products,
mission control's last 100 sent commands and uploads (v13, the Comms timeline),
tick, credits, stats, cheats, storyteller state (RNG, schedule, completed goals), full
unit and VM state (firmware source is recompiled on load; v16: `@WDT`, fault protection,
temperature, heater, array dust; v17: RAM and the RAM top the firmware was assembled for), and **only chunks that are
dirty or explored**: fog as run lengths plus a sparse `[layer, index, id]` diff against
the regenerated chunk. A saved-then-loaded world continues **bit-identically** to an
uninterrupted one (tested). Typical size: a few KB.

The browser keeps one autosave in `localStorage` (every 30 s and on page hide) and resumes
it on startup unless the URL asks for a different `?seed`. Saves can be exported to and
imported from JSON files.

## 3.7 Upgrades & supply drops **[M7]**

Science credits buy upgrades (`src/core/upgrades.ts`) in the Upgrades tab. A purchase
is **not instant**: a supply crate (`SUPPLY_CRATE`, layer 2) is dropped by parachute on a
clear tile 3–6 tiles (Manhattan) from the rover and lands after 80 ticks. The rover must
pick it up with the grabber (`ACT TOOL_1 dir`); the upgrade is **installed immediately**
on pickup and needs no cargo slot. Ports: `@DROPS` (landed crates waiting), `@DROP_X`,
`@DROP_Y` (nearest landed crate; the rover's own position if none). Template:
*Fetch supply crate*.

Built in slice 6 (`src/core/upgrades.ts`, ids in brackets). The chassis carries
`linkBytesPerTick`, `logFifoBytes`, `recorderBytes` and `cameraModes`.

| Upgrade | Cost | Effect | Requires |
| :--- | :--- | :--- | :--- |
| Flash 768 B / Flash 1 KB | 40 / 90 | Flash 768 / 1024 bytes (384 / 512 before M14, 192 / 256 before M10) | – / Flash 768 B |
| RAM 128 B / RAM 256 B **[M14]** | 40 / 80 | RAM 128 / 256 bytes, grown in place (contents kept; the firmware's `VAR`s keep the addresses it was assembled with) | – / RAM 128 B |
| Register file r0–r5 / r0–r7 | 40 / 80 | 6 / 8 registers (values kept) | – / r0–r5 |
| CPU overclock I / II | 50 / 100 | 6 / 8 cycles per tick | – / I |
| Cargo racks | 35 | 6 cargo slots | – |
| Battery pack | 60 | Capacity 150 000 (`@BAT` stays a percentage) | – |
| High-efficiency cells | 50 | Solar output +25 % | – |
| Long-range radar | 40 | SCAN range 8, day and night | – |
| Hull plating | 60 | Squall hull wear halved | – |
| Seismic scanner | 80 | Fits `TOOL_3`: `ACT TOOL_3 dir` finds the nearest ore vein ≤ 12 tiles away *through walls* (4 ticks, 150 energy) → `@SEISMIC_TYPE`, `@SEISMIC_DIST` | – |

Flash and register upgrades change compiler limits at once; the running program is
unaffected (it already fits). Goal *Upgraded*: install a first upgrade.

## 3.8 Downlink, debugging and science products **[M9]**

Built so far: the link (§3.8.1) with the log FIFO, log and boot frames (§3.8.2), `LOG`,
`@LOG_FREE`, `@LOG_LOST`, `@TX_DATA` as `LOG 0` and the Console tab (§3.8.3) (slice 1);
the science recorder, science frames, spectra, `@REC_FREE` and the Gallery tab
(§3.8.5) (slice 2); dumps, `BRK`, `HALTED` and the admin-only debugger (§3.8.4) (slice 3);
`@POST` (§3.8.3) (slice 4); the camera, `SNAP` and photos (§3.8.5) (slice 5); the upgrades
(§3.8.6), camera modes 3–5 and anomalies (§3.8.5) (slice 6).

Design principle: **mission control knows only what the rover sent**, plus the program
it uploaded itself. There is no live view of registers, stacks or ports for the player
(the old debugger is an admin-only "omniscient" view). Everything the player learns
about the rover's memory crosses the radio link as bytes, so the encoding is the game.

### 3.8.1 The link

The rover has **one downlink transmitter** shared by two on-board buffers:

```
CPU ── LOG ──► log FIFO (32 B, lossy)       ─┐
                                             ├─► transmitter ─► orbiter ─► mission control
SNAP / spectrometer ─► science recorder     ─┘
                       (1024 B, reliable)
```

* **Rate:** `linkBytesPerTick` = 2 bytes per tick at `@SIGNAL_STR` 100, proportional to
  signal (integer accumulator: each tick adds `2 × @SIGNAL_STR` to a byte budget; every
  100 sends one byte). Nothing is sent below `linkMinSignal` = 20.
* **Order:** a pending memory dump first, then the log FIFO, then the recorder (oldest
  product first). Logging a lot therefore starves science: a deliberate trade-off.
  Log and recorder are separate virtual channels (like CCSDS virtual channels): a log
  frame may take over the link between two bytes of a product, which then resumes.
* **Energy:** `linkEnergyPerTick` = 2 for every tick in which at least one byte is sent.
  A badly aimed dish sends the same bytes more slowly and so costs more energy.
* The transmitter runs by itself; firmware never waits for it. It keeps running while the
  CPU is halted or faulted, and stops when the rover is powered off.

### 3.8.2 Frames (on-air format)

Every frame starts with one header byte:

```
bit   7      6..3     2..1     0
    [kind] [ tag ]  [size]  [0]
kind 0 = log frame       size = payload length: 0 → 0 B, 1 → 1 B, 2 → 2 B, 3 → 4 B
kind 1 = science frame   size = 0; followed by 1 sequence byte, then the product payload
```

* **Log frames** carry a signed value, big-endian, in the smallest of 1/2/4 bytes that
  holds it (−128..127 → 1 B, −32768..32767 → 2 B, else 4 B): the same idea as immediates in
  Flash (§5.7). `LOG 5` = `28` (1 B); `LOG 5 r0` with r0 = 42 = `2A 2A` (2 B);
  with r0 = −300 = `2C FE D4` (3 B).
* **Tag 15** is reserved for the system: boot frames, dump replies. `LOG 15` is a compile
  error.
* **Boot frame:** after every hard reboot the rover queues `LOG 15 reason`
  (1 = code upload, 2 = watchdog (the fault reset, §3.2), 3 = cold boot, 4 = admin,
  5 = watchdog timeout (`@WDT` not kicked, §3.9.5) **[M13]**, 6 = software update (a save
  migration rewrote the rover's code, §5.8) **[M14]**).
* **Science frames:** `tag` = product type (§3.8.5), then a sequence byte (0–255,
  wrapping, per rover), then the payload. Overhead is 2 bytes per product.

### 3.8.3 Debug log: `LOG`, the console, `@POST`

| Instruction | Cycles | Bytes | Semantics |
| :--- | :--- | :--- | :--- |
| `LOG tag [src]` | 1 | 1 + 1 + src | Queues a log frame. `tag` is a compile-time constant 0–14. Compute instruction: **no `@STATUS` change**, no energy (the transmitter pays). If the whole frame does not fit in the FIFO it is **dropped** and `@LOG_LOST` increments. |

* `@LOG_FREE` (R): free bytes in the log FIFO. `@LOG_LOST` (RW): frames dropped since
  boot; saturates at 255; write sets it (usually 0).
* `@TX_DATA` (W) is shorthand for `LOG 0 value`, kept for old programs. It still
  writes `@STATUS` (`OK`, or `ERR_FULL` when the frame was dropped). It no longer carries
  science.
* **Comms tab** (mission control; the M9 *Console* until M11, §3.9.3): every received frame
  with its tick of arrival and the decoded value. Tags are named from the uploaded program,
  like a `defmt` / spacecraft-EVR dictionary: with `CONST T_BAT 5`, `LOG T_BAT @BAT` shows as
  `T_BAT = 812 fw L17`. *Decode bytes* explains every byte. Lost frames show as a gap
  ("LOST 3 LOG messages dropped"): the transmitter counts drops and reports the count with
  the next frame that gets through (link-layer bookkeeping, not part of the frame bytes).
  Mission control keeps the last 200 frames (saved).
* **`@POST` (RW, 0–255) [M9]:** a two-digit hexadecimal display (red seven-segment
  digits, `00`–`FF`, `b` and `d` lower case) on a bezel at the **back of the cabin**, like a
  PC POST card. Free, no link needed, no `@STATUS`; writes clamp to 0–255; physical
  (survives reboots), dark while powered off. Mission control does not receive it: the
  operator reads it in the 3D view. The view is centred on the rover, so its display is
  always in view.

### 3.8.4 Memory dumps and `BRK`

* **Uplinked commands** (Code tab dump box: *Dump registers*, *Dump stacks*, *Resume after
  BRK* = `CONTINUE`, *Restart* = `RUN_AGAIN`): paid like a
  small upload, `commandCost` = `ceil(dumpEnergy × 100 / max(10, @SIGNAL_STR))` with
  `dumpEnergy` = 150 (1.5 % battery at full signal, 15 % at signal ≤ 10); free with the
  admin *Free uploads* cheat. Rejected (nothing paid) while the rover is powered off,
  when the battery cannot pay, or when `dumpQueueMax` = 4 dump replies are still waiting.
* **Dump replies** are taken the moment the command arrives and wait in their own queue,
  sent **before the log FIFO** (a third virtual channel; it may preempt a log frame or a
  product between bytes). On air: `F8` (kind 1, tag 15), dump kind, payload length, payload.
  * *Dump* (kind 1): IP (byte address) of the next instruction 2 B, `@STATUS` 1 B, CPU state 1 B
    (0 `RUNNING`, 1 `BLOCKED`, 2 `HALTED`, 3 `FAULT`), each installed register 4 B, data-stack
    depth 1 B, call-stack depth 1 B: 22 B payload on Mk-I (25 B on air, ~13 ticks at full
    signal), 38 B with 8 registers. Example: `F8 01 16 00 09 00 02 …`.
  * *Dump stacks* (kind 2): data-stack depth 1 B + 4 B per entry, call-stack depth 1 B
    + 2 B (return IP) per entry.
  * Mission control shows a dump as a **snapshot with the tick it was taken**, never as a live
    view, with IPs turned into source lines of the uploaded program:
    `FIRMWARE DUMP (snapshot t254): next fw:0x02A (L13) · HALTED · @STATUS OK · r0=20 … · stacks 3/0`
    (byte addresses since M10, §5.7.1).
    Dumps are system frames: they do not count toward goals.
* **`BRK`** (1 cycle, 1 byte, compute, no `@STATUS`): the CPU enters `HALTED`; the IP
  already points past the `BRK`. Actuators keep moving to their targets, the transmitter
  keeps sending, the world keeps running; the watchdog does not fire. *Continue* resumes
  at the next tick; a running CPU ignores it (it is still paid: mission control does not
  know the state without a dump). An upload also ends the halt (hard reboot).
  A halted CPU cannot steer the dish: as the orbiter moves on, the link fades, so aim the
  dish soon before a `BRK`.
  **`BRK` reports itself [M11]:** when a `BRK` halts the firmware or the program, the rover
  queues a register dump of that slot unasked (kind 1 or 3, taken that tick; dropped if
  `dumpQueueMax` dumps already wait). It costs no uplink energy and travels like any dump
  (ahead of the log). Mission control shows it as *sent by BRK*: a halted register dump with
  no matching request. Its *next* is the instruction after the `BRK`, so the `BRK` itself is
  at *next* − 1.
* **Admin view:** the old live debugger (registers, stacks, ports, current line,
  single-step) is hidden unless *Live debugger* is ticked on the Admin tab; it is labelled
  as showing what mission control cannot know. A browser preference, not saved with the world.

### 3.8.5 Science products and the recorder

Built: the recorder, science frames, spectra (type 0), the Gallery tab, the camera
(`SNAP`) and photos (all five formats; Mk-I installs modes 1–2, upgrades add 3–5), and
anomalies.

Science lives in the **science recorder** (Mk-I 1024 B) until it has been sent
completely; it is never lost. A product interrupted by a link drop resumes where it
stopped; mission control shows the received part (photos fill in row by row, the rest is
hatched). The space is freed when the last byte is sent.

| Type | Product | Payload | On air | Source |
| :--- | :--- | :--- | :--- | :--- |
| 0 | Spectrum: 16 bands 400–1000 nm, 1 B each | 16 B | 18 B | spectrometer, `ACT TOOL_2 slot` |
| 1 | Photo 32×32, 2 bpp grey | 256 B | 258 B | camera, Mk-I |
| 2 | Photo 32×32, 2 bpp grey, ordered dither | 256 B | 258 B | camera, Mk-I |
| 3 | Photo 32×32, 4 bpp, 16-colour planet palette | 512 B | 514 B | upgrade *Colour filter wheel* |
| 4 | Photo 64×64, 2 bpp grey, dithered | 1024 B | 1026 B | upgrade *Hi-res sensor* |
| 5 | Photo 32×32, 8 bpp RGB332 | 1024 B | 1026 B | upgrade *Colour sensor* |

Pixels are packed MSB-first, row by row (2 bpp: four pixels per byte, leftmost in the top
bits). The camera auto-exposes (stretches the frame's darkest..brightest luma to the full
range, keeping hue) before quantizing. Reference renders: `preview.html?photos=1`.

* **Spectrometer** (`ACT TOOL_2 slot`, unchanged timing and energy): needs 18 free
  recorder bytes (else `ERR_FULL`, the item is kept), then frees the cargo slot and
  records one spectrum. Each material has its own curve (iron: absorption near 900 nm;
  silicon: flat and bright; samples, vent sulfates: green peak), scaled by a per-position
  brightness (88–112 %), with per-position band variation (±6) and a little sensor noise
  per measurement (±2). The descriptor holds the material, the rover's position and tick.
* **Camera** (mast, not a hardpoint): `SNAP dir [mode=1]`, blocks 10 ticks,
  200 energy, writes `@STATUS`: `ERR_INVALID` (bad direction or mode not installed),
  `ERR_LOW_POWER`. **[M12]** The photo goes into image memory; `SEND` records it in the
  recorder (`ERR_FULL` there), changed by the program or not (§3.8.7). Subject: the first
  rover, obstacle or item within 2 tiles in `dir`; with nothing that close, a **landscape**
  (subject `NONE`): a loose view of what really lies ahead over a 90° field of view. Cliff
  walls up to 16 tiles away rise as ridges (about 3 tiles tall, so nearer ones stand taller,
  hazier with distance), ore veins as low coloured hills, a far range always on the horizon;
  the ground shows sand, gravel or glowing vents from the first 4 tiles ahead; the sun appears
  when it is above the horizon within 50° of the view; at night the sky is dark with stars
  and the headlight lights the foreground. The view is sampled when the photo is taken and
  kept in the descriptor (skyline of 16 columns, ground, sun, light). **Light:**
  `@SUN_LIGHT ≥ 20`, or the headlight on and `@HEADING = dir`; otherwise the photo is dark
  and noisy (auto-exposure amplifies sensor noise) and worth nothing. The camera sits on the
  mast: `SNAP` does **not** turn the rover. Subject and light are taken when the exposure
  ends (after the 10 ticks). The scene depends on the subject type and the subject tile (the
  same rock photographed again looks the same, apart from a little sensor noise).
* `@REC_FREE` (R): free recorder bytes. `@SCIENCE_READY` (R): products waiting in the
  recorder (meaning unchanged: science waiting for downlink).
* **Content is deterministic:** a product is stored as a descriptor (type, subject tile,
  position, light, tick); its bytes come from a pure, integer-only function of the world
  seed and the descriptor (`src/core/imaging.ts`, no `Math.random`, no float trig in the
  tick path), so saves stay small and runs stay reproducible. **[M12]** The same function
  fills image memory at the end of a `SNAP`; edited and drawn products carry their bytes.

**Credits on delivery** (tunable, `BALANCE`): spectrum = the item's `science` value
(sample 3, ore 1, as today); lit photo = 1, +5 the first time a subject type is
delivered (decided on delivery; the list of subject types already delivered is saved);
dark photo = 0 (a landscape counts as its own subject type). Goal *Photographer*: deliver 3 lit photos.

**Anomalies:** 1 in `anomalyOneIn` = 40 cliff walls and samples (seeded per tile from the
world seed, the same for both kinds) hold a **fossil**: a small ribbed spiral shell set in
the cliff strata, or a pyritized shell instead of an ordinary sample. Only a photo of the
tile as its subject (within 2 tiles) shows it; landscapes, spectra and dark photos never do.
The shell is tinted like its rock: in a 32×32 grey photo it is a pale disc that might be a
pebble, while hi-res (mode 4) and the colour modes show the spiral clearly (reference renders:
`preview.html?anomaly=1`). Mission control judges by eye: **Flag anomaly** on a complete,
lit photo in the gallery, one flag per photo. Right: +`anomalyFlagCredits` 20 the first
time that tile is flagged (a later photo of the same tile is "already catalogued": nothing);
wrong: −`anomalyWrongFlag` 5, never below 0 credits. The flag and its outcome are saved with
the gallery entry; credited tiles are saved. Goal *Anomaly hunter*: one correct flag (30 cr).

**Gallery** (mission-control tab): received photos (crisp pixels, scaled up) and spectra
(bar charts), each with tick, position, size and hex view. A product appears with its
first received byte; the missing part is hatched until the last byte arrives. The
gallery keeps the last 100 products (saved). Old saves: science points still waiting in
`@SCIENCE_READY` are credited when the save is loaded (no spectrum exists for them).

### 3.8.6 Upgrades (catalogue additions)

| Upgrade | Cost | Effect | Requires |
| :--- | :--- | :--- | :--- |
| Recorder 2 KB / 4 KB (`REC_2K` / `REC_4K`) | 40 / 80 | Science recorder 2048 / 4096 B | – / 2 KB |
| High-gain amplifier (`LINK_3`) | 60 | Link 3 B/tick at full signal | – |
| Trace buffer (`TRACE_64`) | 30 | Log FIFO 64 B | – |
| Colour filter wheel (`CAM_COLOUR`) | 60 | Camera mode 3 | – |
| Hi-res sensor (`CAM_HIRES`) | 80 | Camera mode 4 | Recorder 2 KB |
| Colour sensor (`CAM_RGB`) | 100 | Camera mode 5 | Colour filter wheel, Recorder 2 KB |

### 3.8.7 Image memory **[M12]**

Designed with the owner (2026-11-13): take a picture → change it → send it, with every byte
readable and writable. Built: the core (M12 slice 1), the **Reference → Image** sub-tab, six
program templates *Image: …* and the compiler warning below (slice 2). Player guide with the
six worked examples (the templates, word for word, run by the tests):
[`IMAGE_MEMORY.md`](IMAGE_MEMORY.md).

* **Code tab warning:** code that `SNAP`s while neither slot on the rover ever `SEND`s is
  flagged (*takes photos but never sends them*); it still compiles and uploads.

* **Image memory:** one flat byte array per rover, as big as the largest photo the
  installed camera modes take (`imageBytes(chassis)`: Mk-I 256 B; 512 B with *Colour
  filter wheel*, 1024 B with *Hi-res sensor* or *Colour sensor*). **Non-volatile**, like a
  real camera's flash (owner, 2026-11-13): it keeps its contents through reboots and
  power-off; only a new `SNAP` (overwrites it) and `ERASE` clear it, never `SEND`. Zeroed
  at landing. Saved.
* **`SNAP dir [mode]`** (timing, energy, subject and light rules unchanged, §3.8.5)
  writes the photo's bytes (layout §3.8.5) into image memory instead of the recorder and
  remembers the **capture** (the descriptor, the mode and the noise seed). `ERR_FULL` no
  longer applies. Like the memory, the capture survives reboots and power-off.
* **`LDB dst [addr]`** / **`STB [addr] src`** (1 cycle each, compute: no energy, no `@STATUS`;
  opcodes 1D / 1E): read a byte (0–255) / write `src & 255`. **[M14]** Image memory sits in
  the data address space at `IMG` (§5.8): byte `n` of the picture is `[IMG+n]`; an address
  outside it faults (before M14 addresses wrapped modulo the memory size, without brackets).
  The bit instructions (`AND`, `OR`, `SHL`, `SHR`, §5.4) take pixels apart.
* **`SEND [type]`** (hardware, blocks `sendTicks` 1 tick, `sendEnergy` 10; extended
  opcode `1F 05`): copies the first `photoBytes(type)` bytes into the recorder as a product
  of `type` (photo types 1–5; default: the mode of the last `SNAP`, else 1). Writes
  `@STATUS`: `OK`; `ERR_FULL` if the recorder lacks room; `ERR_INVALID` for a bad type or
  one larger than image memory; `ERR_LOW_POWER`. Image memory is unchanged.
* **`ERASE`** (hardware, blocks `eraseTicks` 2, `eraseEnergy` 10; extended opcode
  `1F 06`): zeroes image memory and drops the capture (a `SEND` after it is *drawn*).
  `@STATUS` `OK` or `ERR_LOW_POWER`. The only way to clear image memory besides a `SNAP`.
* **Provenance:** bits 2–1 of a science frame's header (unused so far) carry the
  processing level: `00` *raw* (sent as captured), `01` *edited* (an `STB` since the
  `SNAP`), `10` *drawn* (no capture behind it). The Gallery labels every photo by it (a
  *raw* / *edited* / *drawn* chip), from the received bytes alone. Its **hex view** (click
  the hex line) shows the decoded header byte, the sequence byte and the payload 16 bytes
  per row, numbered like image memory addresses.
* **Credits** come from the capture, never from the bytes: the **first** `SEND` after a
  `SNAP`, with `type` = the `SNAP`'s mode, carries the capture (lit photo 1, +5 first of a
  subject type; anomaly flags allowed, checked against the real tile). Every other `SEND`
  is *drawn*: no credits, cannot be flagged (owner, 2026-11-13: no rewards for drawn
  pictures for now). Goal *Photographer* counts captured photos.
* **First-edit bonus** (owner, 2026-11-13: every kind of edit is rewarded the first time):
  a lit *edited* photo earns `editFirstBonus` = +5 the first time for each photo type
  (camera mode 1–5), on top of the photo credits. The list of modes already credited is
  saved (v15). Goal *Darkroom* (reward 15): deliver one lit edited photo.
* **Storage:** raw products stay descriptors in the recorder and gallery (bytes
  regenerated, as today); edited and drawn products store their bytes (`data`, hex), and
  captured ones keep the noise seed, so the original photo can always be regenerated.
  Save v14 adds the memory (hex, trailing zeros dropped), the capture, `SEND`'s default
  type and the edited flag; older saves start with zeroed memory.
* Spectra are unchanged (straight to the recorder, §3.8.5).

## 3.9 Firmware and programs **[M10]**

Design agreed with the owner (2026-11-12, details 2026-11-13). Slice 1 built the rules
below in the core; slice 2 the Code tab (Program / Firmware slots, listing) and the Console
controls.

The rover runs two pieces of code on its one CPU, like a spacecraft's flight software
running uplinked command sequences, or a small OS starting user programs:

* **Firmware** keeps the rover alive (sun, dish, squalls, low battery, lights) and decides
  when the program runs. The factory firmware ships with every rover. Advanced players
  edit and upload it (full upload cost, hard reboot), as before M10.
* **Program**: the player's task (Explorer, Prospector, Fetch, ...). Beginners only write
  programs. *Upload program* pays only for the program's bytes and does **not** reboot.

### 3.9.1 Slots, flash and contexts

* **Two separate sources**, compiled separately: each has its own labels, `ALIAS` and
  `CONST` names. Firmware bytes + program bytes must fit the chassis flash (**Mk-I 512 B** since M14, 256 B
  since M10); each slot is compiled against the space the other leaves, and the overflow
  error names both sizes.
* **Separate contexts**: each slot has its own IP, registers (the chassis count each), data
  and call stack, and `@STATUS`. Everything physical is shared: ports, actuators, cargo,
  lights, the downlink.
* Slot rules (compile errors): `CALL RUN` / `CALL PROGRAM` and writes to `@PROG_STATE`,
  `@SLICE` (and the other firmware-only ports) only in the firmware; `END` only in a program.
* A firmware without `CALL RUN` / `CALL PROGRAM` never runs the program (every pre-M10
  firmware is like that).

### 3.9.2 `CALL PROGRAM`, `END` and the program state

**[M14]** The firmware **calls** the program like a subroutine, and a **timer interrupt**
brings control back, as every real operating system runs a task (ARM's *SysTick*). Before
M14 a `RUN ticks` instruction did this cooperatively (see below for what changed).

| Code | Cycles | Bytes | Semantics |
| :--- | :--- | :--- | :--- |
| `MOV @SLICE ticks` | 1 cycle | 2+ | Firmware only: the ticks the next call may run, 0–30000; **0 = no time limit** (the reboot value). |
| `CALL PROGRAM` | 1 cycle | 3 | Firmware only, no arguments. If `@PROG_STATE` is `PROG_READY`: `@STATUS = OK`, the return address goes on the firmware's call stack, and the program's context (its own registers, stacks, `@STATUS`, timer) continues where it was (from `0x000` after a restart) **in the same tick** with the cycles left. Otherwise nothing happens and `@STATUS = ERR_INVALID`. |
| `CALL RUN ticks` | 4 + | 5 | ROM routine: `POP @SLICE`, `CALL PROGRAM`, `RET`. |
| `END [value]` | 1 cycle | 1 (+ v) | Program only. `@PROG_STATE = PROG_DONE`, `@PROG_RESULT = value` (default 0); back to the firmware. |
| `RET` at the program's top level | 1 cycle | 1 | Like `END r0`: "return from main" (the calling convention of §5.9). |

* **The program returns to the firmware**, which continues after its `CALL PROGRAM` (in the
  same tick if cycles are left), on `END` or a top-level `RET` (`PROG_DONE`), when **its
  slice runs out** (`PROG_READY`, `@PREEMPTED = 0`), on a `@PREEMPT` condition
  (`PROG_READY`, `@PREEMPTED` = the bits), a fault (`PROG_FAULT`) or `BRK` (`PROG_HALTED`).
* **Interrupts happen only at the start of a tick, between instructions.** `@SLICE` counts
  down at the start of each tick of the call; at 0 the timer interrupt fires. A program
  asleep in `WAIT` is simply suspended there and **its devices keep running** (a drive goes
  on, its timer counts): called again, the `WAIT` checks again. Nothing is aborted. Slices
  are exact, so a program's `CALL SLEEP 2000` no longer starves the firmware (§3.9.5).
  Running off the end of a program still wraps to its first line: a program loops until it
  `END`s. Read inside the program, `@SLICE` gives the ticks left.
* *Before M14* `RUN ticks` was a hardware instruction: a slice ended only between
  instructions, so a `SLEEP` or `STEP` started in it ran to completion first (cooperative),
  and `@PREEMPT` aborted the action instead.
* **`@PROG_STATE`** (RW): `PROG_NONE` 0 (nothing to run), `PROG_READY` 1 (the next `RUN` starts
  or resumes it), `PROG_RUNNING` 2 (only the program itself and dumps see this),
  `PROG_DONE` 3, `PROG_FAULT` 4, `PROG_HALTED` 5. The firmware writes `PROG_NONE` to
  **acknowledge** a finished or faulted program (it stays in flash but is not run), or
  `PROG_READY` to **restart** it from the top (fresh context). Other values, and writes
  while no program is in flash, are ignored.
* **`@PROG_RESULT`** (R): the value of the last `END`; 0 after a restart.
* **Program faults** (stack overflow/underflow) set `PROG_FAULT` and end the slice. No
  watchdog: the firmware keeps running and decides what to do. A firmware fault still
  watchdog-reboots the whole CPU.
* **Fault protection (`@PREEMPT`) [M13, M14]:** the firmware can arm conditions that end a
  slice at once. `@PREEMPT` (RW, firmware-only write, 0–7) is a mask of
  `PRE_ALERT` 1 (a world event is announced: its warning starts this tick), `PRE_DAMAGE` 2
  (hull, array or dish lost integrity this tick), `PRE_LOW_BAT` 4 (`@BAT` below
  `@BAT_ALARM`, RW firmware-only, 0–100). Checked at the start of every tick of a slice:
  when one fires, the program is **interrupted** between instructions, like a time-up. Its
  devices keep running: **the firmware decides** what to do with them (`MOV @DRIVE_N 0`
  stops the drive at the end of its tile; the program's `WAIT @DRIVE` then reads
  `ERR_PREEMPTED`, 9: "stopped by a command"). The program stays `PROG_READY`, so the next
  `CALL PROGRAM` resumes it where it was. `@PREEMPTED` (R) holds the bits that fired (0 when a
  slice ended normally) until the next `CALL PROGRAM` clears it. `@PREEMPT`,
  `@BAT_ALARM` and `@PREEMPTED` are CPU state: 0 after every hard reboot. `PRE_LOW_BAT` is
  level-triggered: below the alarm every new slice ends at the next tick, so the firmware
  should charge first. The default firmware does not arm it (its 50-tick slices already check
  between slices, and the dish needs that rhythm); the firmware template *Fault protection*
  does (`PRE_ALERT + PRE_LOW_BAT`, stops the drive, logs `T_PREEMPT`).
* **`BRK` in a program** sets `PROG_HALTED` and ends the slice; the firmware runs on.
  *Continue* (Program slot) sets `PROG_READY`, so the next `CALL PROGRAM` resumes after the `BRK`.
  `BRK` in the firmware halts the whole CPU as before (§3.8.4).
* **Hard reboots** (firmware upload, watchdog, watchdog timeout, solar cold boot, admin) reset both contexts.
  `@PROG_STATE` becomes `PROG_READY` if a program is in flash (the task restarts from the
  top, as before M10), else `PROG_NONE`.

### 3.9.3 Uploads and mission-control commands

* **Upload program**: `ceil((200 + 6 × program bytes) × 100 / max(10, @SIGNAL_STR))`
  energy (`programUploadBase`). No reboot, the firmware context is untouched. A running
  slice ends (devices it started keep running, M14); the new program starts fresh as
  `PROG_READY`. Uploading an empty program erases it (`PROG_NONE`).
* **Upload firmware**: as §3.3 (base 500 + 6 × firmware bytes, hard reboot); rejected if
  firmware + program would not fit the flash.
* **Code tab**: a **Program** (default) / **Firmware** (advanced) switch, each slot with its
  own editor and templates (programs: the lesson set below and the *Image: …* examples;
  firmware: Default firmware and the pre-M10 all-in-one examples), *Upload program* or *Upload
  firmware & reboot*, a flash bar `firmware 166 + program 44 = 210 / 512 B` (the
  edited slot counts its draft, the other slot what is on the rover), and a warning when
  the firmware has no `CALL RUN` / `CALL PROGRAM`. New rovers ship the default firmware and no program (the
  Program slot shows *First steps* as an unsent draft).
* **Commands per slot**: *Dump registers*, *Dump stacks* and *Resume after BRK* address one
  slot (the Code tab's). Program dumps are kinds 3 and 4, laid out like kinds 1 and 2
  (§3.8.4) with `@PROG_STATE` in the CPU-state byte. *Restart* (uplink `RUN_AGAIN`, paid like
  a dump) restarts the program from the top, like the firmware writing `PROG_READY`;
  rejected if there is no program. (M10 had these on a Console tab with its own slot
  switch; M11 moved them to the Code tab.)
* Mission control decodes log tags with both slots' `CONST` names; a tag both slots name
  differently shows both (`T_BAT|T_X`), with lines per slot (`fw L12 prog L3`).
* **Comms tab and *Dump program state* [M11]** (review page `preview.html?editor=1`;
  replaced the M9/M10 Console). Organised by the player's
  question instead of by link direction:
  * **Code tab → *Dump program / firmware state*** (follows the Code tab's slot; the
    Console's own slot switch is gone): *▲ Dump registers*, *▲ Dump stacks* (uplink `DUMP` /
    `DUMP_STACKS`), *▶ Resume after BRK*, *↻ Restart* (program only). A flow line says the
    direction: *▲ you ask → the rover dumps its state at that moment → ▼ the dump comes
    down*. The help says a dump is one slot's CPU, not the whole rover. The newest dump of
    each kind is a card ("dumped on the rover at t2132, 35 ticks ago"; next address with a
    link to its line; state, `@STATUS`, stack depths; registers named by `ALIAS`: `r1 seen`),
    with a *waiting* line while a request is unanswered (and why: no downlink below signal
    20). The listing marks the dumped next instruction with ◆ while the editor holds the
    uploaded code. A dump taken before a later upload of its slot is flagged as pointing into
    old code.
  * **Comms tab** (renamed Console): a *Radio link* box (▼ signal meter with the minimum,
    log queue, science recorder, lost; ▲ request cost) and one timeline of both directions:
    ▲ sent (`CODE` uploads, `CMD` requests with *✓ dump arrived t…* / *… waiting*), ▼ received
    (`LOG` with merged repeats, `DUMP`, `SYS`, `SCI` products → Gallery, `LOST`). Dumps are
    always shown **byte by byte**: each field's bytes, name, value and a `; comment`
    (`00 00 00 FF  r1 seen  255`, `FF FF FF FF  r2 dist  -1 ; negative…`); *Decode bytes*
    does the same for LOG and system messages (header bits `0|0001|01|0`, value). Filters
    All / ▲ Sent / LOG / Dumps / System / Science, ↓ newest. Read-only.
  * **Reference → Radio**: what goes up and down (and that code never comes back down), the
    header byte, numbers (byte order, two's complement, LOG value sizes, addresses), and
    every frame type as a decoded example (LOG, LOG without value, boot message, register
    dump, stack dump, dump kinds). The examples come from the same decoder as Comms.
  * **Mission events** (the strip under the side panel): world and game only (goals,
    weather, supplies, upgrades, admin, rejected actions, rover alarms). Receipts for what
    was sent are left to Comms (`LOG` event `category`: `world` / `sent` / `rover`).
  * Clarity pass: dumps of a program that is not running (`PROG_NONE`, `PROG_DONE`) say
    *not running* and mark nothing; comments name the value's meaning (`ERR_BLOCKED ; the
    drive hit an obstacle`, `PROG_HALTED ; stopped by BRK…`); a halted dump says *stopped at the
    BRK on line 5; continues at line 6*. Source references are links: `fw L55` on a LOG row,
    a dump's *next* and return addresses open that line in the Code tab. A waiting request
    shows an estimate (`≈ 14 ticks at signal 94`; dumps go first, register dump 9 + 4 ×
    registers B, stack dump ≥ 5 B). The dump box folds (▾) and shows only kinds with a dump
    or a request. Rejected commands and uploads are listed in Comms (`✗ … not sent: …`).
  * Mission control's sent record (`engine.sent`, last 100, saved v13; rejected attempts
    marked `rejected`, cost 0, never paired): pairs a request
    with its dump by rover, slot, kind and the tick the dump was taken (= the tick it was
    sent). Not part of the simulation. The compiler exports `ALIAS` names (`regNames`).
  * Later (needs a rules decision): rover-internal alarms (`CPU FAULT`, program fault,
    watchdog) only via the downlink, so mission control knows only what it received.

### 3.9.4 Default firmware

A **core** plus **comfort blocks**, each between marker comments with its byte cost, so
experienced players can delete what they do not need and give the bytes to their program.
The full default firmware is 166 B (comfort 55 B of it; 158 B before M14's `CALL RUN` /
`CALL SLEEP`), leaving 346 B on Mk-I (512 B since M14): the shipped programs need 22–104 B
(all fit; tested). **[M13]** Its core arms and kicks the
watchdog (`CONST WDT_TICKS 1000`, a kick at the top of the main loop and in the charge loop,
10 B). The firmware template *Fault protection* is the default firmware plus `@PREEMPT`
and a drive stop (18 B more: programs up to 328 B fit next to it).

**Program templates as lessons.** Each non-image template starts with a header: what it
does, `; Learn:` (what it teaches) and `; Try:` (a change to make next); comments cost no
Flash. Together the templates use every instruction (tested), and the tests run each one.
**[M14]** The save v18 migration rewrote them onto the ROM (`CALL STEP`…); slice 4 made
them a course on the device model: the first five go *ROM call → the ports behind it → a
variable in RAM → data in Flash → two devices at once*, and every header says which device
and ports a ROM call stands for. They are listed in that order in the Code tab.

| Template | Teaches | B |
|----------|---------|---|
| First steps | registers, `ALIAS`, `CALL STEP`, `@STATUS`, a loop, `END` | 22 |
| Drive yourself **[M14]** | devices: `@DRIVE_N`, `@DRIVE`, `WAIT`: what `CALL STEP` really is | 30 |
| Count with a variable **[M14]** | `VAR`, load / change / store (`LDB`, `ADD`, `STB`), RAM survives *Run again*, 16-bit `CALL GET16` / `PUT16`, helpers change `r0` / `r1` | 68 |
| Route **[M14]** | `DATA`, `LDF`, `VAR`, `LDB` / `STB` | 70 |
| Drive and scan at once **[M14]** | two devices at once (the radar is outside the chassis interlock), polling `@DRIVE`, edge detection, top-level `RET` returns `r0` | 48 |
| Explorer | the radar (`CALL SCAN`, `@RADAR_HIT`), tile constants, `MOD`, telling errors apart (`ERR_HAZARD`), `LOG` | 65 |
| Photographer | `CALL SNAP` / `CALL SEND`, `@HEADING` for the headlight, `@REC_FREE` | 44 |
| Prospector | tools (`CALL ACT`), cargo (`[CARGO+slot]`), `CALL` / `RET` | 104 |
| Field repair | `CALL USE slot system`, nested loops, picking a port with jumps | 72 |
| Fetch supply crate | positions, `SUB`, direction from a sign, result codes | 78 |
| Spiral | `CALL` with arguments, `POP` order, `LOG`, `BRK` | 52 |
| Seismic survey | an upgrade tool (`TOOL_3`), searching for a minimum, `JGE` / `JLE` | 75 |
| Weather station | `CALL SLEEP` timing, `@TICK`, `DIV`, the alert ports | 37 |
| Image: … (6) | image memory, bits, `PUSH` (guide `IMAGE_MEMORY.md`) | 31–104 |

* Core: keep the dish on the orbiter; stow the array on a squall warning; charge below a
  threshold (`CONST LOW_BAT`, `FULL_BAT`) and give the program no slices while charging;
  give time slices (`CONST SLICE`); log the outcome (Comms: `T_DONE = 3` with the result, or `T_FAULT`) and
  acknowledge it.
* Comfort: program-state lamp (`@IND1`), battery/charging lamp (`@IND2`), uplink lamp
  (`@IND3`), automatic
  headlight at night, `@POST` shows the last program result, battery heartbeat frame.

Templates (Explorer, Prospector, Fetch) become programs: their charging and dish code
moves to the firmware.

### 3.9.5 Watchdog timer `@WDT` **[M13]**

The fault reset (§3.2) only catches crashes. A firmware that hangs without faulting (an
endless loop, a `SLEEP` that is far too long, a wait that never ends) used to run forever.
Real flight computers have a **watchdog timer**: hardware that resets the CPU unless the
software "kicks" it in time.

* **`@WDT`** (RW, writes firmware-only, 0–30000). Writing n > 0 **arms** the watchdog (the
  first time) and **kicks** it: it now expires n ticks from this one. Writing 0 does
  nothing: once armed it cannot be switched off until the next hard reboot (like an
  independent watchdog on a real microcontroller). Read: ticks left, 0 = not armed.
* It counts down once per tick while the firmware is `RUNNING` or `BLOCKED`, including
  while the program runs (the firmware is then inside `CALL PROGRAM`). `BRK` (`HALTED`) freezes it, as a debugger does; a `FAULT`
  leaves it to the fault reset; a powered-off rover does not count.
* When it reaches 0: hard reboot (§3.3) with boot reason 5, *watchdog timeout*; the
  Comms tab shows `BOOT: watchdog timeout`. A hard reboot disarms it (0), so a firmware
  arms it again with its first kick.
* After a reboot nothing is armed: firmware that never writes `@WDT` (every pre-M13
  firmware) behaves as before.
* **Slices count:** while the program runs, the firmware cannot kick. Since M14 slices are
  exact (§3.9.2), so the firmware is back after `@SLICE` ticks whatever the program does;
  choose the timeout longer than a slice. A call **without a time limit** (`@SLICE 0`)
  trusts the program: one that sleeps longer than the timeout trips the watchdog, and the
  reboot restarts it. (Before M14, a program's long `SLEEP` starved the firmware this way
  under any slice.) The default firmware uses 1000 ticks and 50-tick slices.

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
  `FLAT_SAND` landing zone surrounds `(0, 0)`.
* Chunks within a 3×3 radius of any rover stay loaded. Chunks that are neither dirty
  nor explored and that nothing has touched for a while are evicted and regenerated on
  demand. Dirty and explored chunks stay (they are part of the save).
* Tile ID `0` is `NONE` in every layer. Tiles are declared in `WorldRegistry`; each
  declaration's `constName` automatically becomes a language constant.

## 5. Rover-ASM language

### 5.1 Lexical rules

* One instruction per line: `[label:] OPCODE arg arg ...`. Everything (opcodes,
  registers, labels, aliases, constants, ports) is case-insensitive, to avoid beginner
  frustration.
* `;` starts a comment. Commas between arguments are optional.
* Numbers: decimal (`-12`), hex (`0x1F`).
* `->` is ignored (it was sugar for the output operands of `SCAN` and `PEEK`, retired in
  M14).
* **Running off the end of the program wraps to line 0**: every program is an implicit
  main loop, saving a `JMP` line.

### 5.2 Operands

| Kind | Syntax | Notes |
| :--- | :--- | :--- |
| Register | `r0`…`r3` | Using a register beyond the chassis count is a compile error. |
| Alias | any name bound with `ALIAS` | Compile-time only. |
| Immediate | `42`, `-7`, `0xFF` | |
| Constant | `NORTH`, `IRON_ORE`, `ERR_BLOCKED`, any `CONST` name | Resolved at compile time. |
| Port | `@BAT`, `@IND1`, ... | Writing a read-only port is a compile error. |
| Label | `loop` | Jump/call targets only. **[M14]** The ROM routines (`SLEEP`, `STEP`, `SCAN`, `ACT`, `USE`, `SNAP`, `SEND`, `ERASE`, `RUN`) and `PROGRAM` are labels every slot knows: reserved names. |
| Port to wait on **[M14]** | `@DRIVE`, `@TIMER` | `WAIT` only: any readable port. |

**Every value operand accepts a register, port, immediate or constant**, including
directions, tool slots and cargo slots (`CALL STEP r0 1`, `CALL ACT TOOL_2 r1`).

| Memory address **[M14]** | `[40]`, `[count]`, `[r1]`, `[r1+4]`, `[IMG+r0]`, `[route+i+1]` | Only in `LDB`, `STB`, `LDF` (a *load / store architecture*). One register at most (the base); numbers, `CONST`s, `VAR`s and labels add up to the offset. Spaces inside the brackets are allowed. |

### 5.3 Directives (0 bytes)

| Directive | Meaning |
| :--- | :--- |
| `ALIAS <reg> <name>` | Name a register. |
| `CONST <name> <value>` | Name an integer constant. |
| `VAR <name> [size]` | **[M14]** Reserve `size` bytes of RAM (default 1); `name` is its address (§5.8). |
| `[label:] DATA <byte> …` | **[M14]** Bytes −128…255 (numbers or `CONST`s) in Flash. Costs one byte each; the assembler puts every `DATA` block in the slot's **data section** after the code, and the label names it. |

### 5.4 Instructions

The grammar is **not frozen**. New instructions are added when they remove real
friction, but the set should stay small enough to learn in one sitting.

| Group | Instruction | Cycles / ticks | Semantics |
| :--- | :--- | :--- | :--- |
| Data | `MOV dst src` | 1 cycle | `dst` = register or writable port. |
| | `PUSH src` | 1 cycle | Data stack; overflow → `FAULT`. |
| | `POP dst` | 1 cycle | Underflow → `FAULT`. |
| Arithmetic | `ADD dst src` / `SUB` / `MUL` | 1 cycle | 32-bit signed, wraps. |
| | `DIV dst src` | 1 cycle | Truncates toward zero. Divide by 0 → `dst = 0`, `@STATUS = ERR_INVALID`. |
| | `MOD dst src` | 1 cycle | **Euclidean**: result is never negative for positive `src` (`-1 MOD 4 = 3`). Turning is `ADD dir 1` + `MOD dir 4`. |
| Bits | `AND dst src` / `OR dst src` | 1 cycle | **[M12]** Bitwise on the 32-bit value (`0xB6 AND 0x0F` = `0x06`, `0x50 OR 3` = `0x53`). 2-byte opcode (§5.7.1). |
| | `SHL dst n` / `SHR dst n` | 1 cycle | **[M12]** Shift left / right by `n` bits; zeros come in (`SHR` is logical: `-8 SHR 1` = `0x7FFFFFFC`; use `DIV` for signed division). `n` is clamped to 0–32, so 32 or more gives 0. No `@STATUS`. 2-byte opcode. |
| Flow | `JMP label` | 1 cycle | |
| | `JEQ / JNE / JLT / JGT / JLE / JGE a b label` | 1 cycle | Compare and branch. |
| | `CALL label [args...]` | 1 cycle | Pushes args in order to the data stack, return address to the call stack. **[M14]** `label` may be a ROM routine (§5.9; the assembler checks its argument count), or `PROGRAM` (firmware only, §3.9.2). |
| | `RET` | 1 cycle | Pop call stack. Underflow → `FAULT`; **[M14]** in the program at its top level: return to the firmware with `@PROG_RESULT = r0`. |
| Devices | `WAIT @port` | 1 cycle, then asleep | **[M14]** If the port reads non-zero the CPU sleeps (`BLOCKED`, the tick ends, no energy) and checks again at the start of every tick. When it reads 0: on a device's progress port (§5.9) the device's result goes into `@STATUS`; the program continues. Any readable port works (`WAIT @ALERT_ETA`). |
| Memory | `LDB dst [addr]` | 1 cycle | **[M12, M14]** Load the byte (0–255) at data address `addr` (§5.8); compute. No memory there: `FAULT`. |
| | `STB [addr] src` | 1 cycle | **[M12, M14]** Store `src & 255` at data address `addr`; compute. Cargo is read-only; no memory there: `FAULT`. |
| | `LDF dst [addr]` | 1 cycle | **[M14]** Load the byte at `addr` of this slot's own Flash (code, then the data section), or of the ROM at `0xF000`+; compute. Past the slot: `FAULT`. Opcode 13 (`1F 07` in slice 2). |
| Debug | `LOG tag [src]` | 1 cycle | **[M9]** Queue a log frame for the downlink; compute, no `@STATUS` (§3.8.3). |
| Slots | `END [value]` | 1 cycle | **[M10]** Program only: finish with `PROG_DONE` and `@PROG_RESULT` (§3.9.2). |
| | `BRK` | 1 cycle | **[M9]** Halt the CPU (`HALTED`) until *Continue* or an upload; the rover sends a register dump by itself **[M11]** (§3.8.4). |

`@STATUS` is written by device start writes (accepted, or why not), by `WAIT` on a device
port (how it ended), by `CALL PROGRAM` and by `DIV` / `MOD` by 0; everything else leaves it
alone. **Retired in M14** (save v18 rewrites old code, §5.9): `SLEEP`, `SCAN`, `STEP`, `ACT`,
`PEEK`, `USE`, `SNAP`, `SEND`, `ERASE`, `RUN` (now ROM routines or memory) and `@TX_DATA`
(`LOG 0 v`).

### 5.5 Constants

* Directions: `NORTH=0`, `EAST=1`, `SOUTH=2`, `WEST=3`.
* Status: `OK=0`, `ERR_INVALID=1`, `ERR_FULL=2`, `ERR_LOW_POWER=3`, `ERR_BLOCKED=4`,
  `ERR_NO_TOOL=5`, `ERR_NO_SIGNAL=6`, `ERR_HAZARD=7`, `ERR_DEPLOYED=8`,
  `ERR_PREEMPTED=9` **[M13, M14]** (stopped by a command before it finished: a drive
  stopped with `@DRIVE_N 0`), `ERR_BUSY=10` **[M14]** (the device, or one it shares the
  chassis with, is still working).
* Tools: `TOOL_0`…`TOOL_3`.
* Systems: `SYS_HULL=0`, `SYS_SOLAR=1`, `SYS_ANTENNA=2`.
* Alerts: `ALERT_NONE=0`, `ALERT_ECLIPSE=1`, `ALERT_SQUALL=2`.
* Program state **[M10]**: `PROG_NONE=0`, `PROG_READY=1`, `PROG_RUNNING=2`, `PROG_DONE=3`,
  `PROG_FAULT=4`, `PROG_HALTED=5`.
* Fault protection **[M13]**: `PRE_ALERT=1`, `PRE_DAMAGE=2`, `PRE_LOW_BAT=4` (bits of `@PREEMPT`).
* Colors: `OFF=0`, `RED=1`, `GREEN=2`, `BLUE=3`, `AMBER=4`.
* Tiles: `NONE=0` plus every `constName` in `WorldRegistry` (`FLAT_SAND`, `IRON_ORE`, `ROVER`, ...).

### 5.6 Ports

| Port | Access | Range | Status |
| :--- | :--- | :--- | :--- |
| `@BAT` | R | 0–100 | M1–M3 |
| `@HULL` | R | 0–100 | M1–M3 |
| `@X`, `@Y` | R | signed | M1–M3 |
| `@STATUS` | R | 0–10; each slot has its own (M10) | M1–M3 |
| `@TICK` | R | ticks since world start | M1–M3 |
| `@GROUND` | R | layer 0 tile ID under the rover | M1–M3 |
| `@GROUND_HAZARD` | R | 0–2 | M1–M3 |
| `@HEADLIGHT` | RW | 0/1 | M4 (costs energy; M8.1: lights a forward cone for the operator at night) |
| `@HEADING` | RW | 0–3 (`NORTH`…`WEST`); write turns in place, wraps mod 4 | M8.1 |
| `@IND1`, `@IND2`, `@IND3` | RW | 0–4 (`OFF`…`AMBER`) | M8 (status lamps, visual only; replace the removed `@LIGHT_COLOR` / `@LIGHT_BLINK` beacon) |
| `@SENSOR_RANGE` | R | radar range, any direction, day and night | M4, M8.1 |
| `@SUN_AZIMUTH`, `@SUN_ELEV`, `@SUN_LIGHT` | R | 0–359, −70..70, 0–100 | M4 |
| `@SOLAR_OPEN` | RW | 0/1 | M4 |
| `@SOLAR_ANGLE` | RW | 0–359 (write = target, read = current) | M4 |
| `@ORBIT_AZIMUTH`, `@SIGNAL_STR` | R | 0–359, 0–100 | M4 |
| `@ANTENNA_ANGLE` | RW | 0–359 (write = target, read = current) | M4 |
| ~~`@TX_DATA`~~ | – | retired in M14 (it was `LOG 0 value`); number 30 free for one reuse | M4–M13 |
| `@CARGO_FREE` | R | free cargo slots | M5 |
| `@SOLAR_HEALTH`, `@ANTENNA_HEALTH` | R | 0–100 | M6 |
| `@ALERT` | R | `ALERT_*` | M6 |
| `@ALERT_ETA` | R | ticks until the alerted event | M6 |
| `@DROPS`, `@DROP_X`, `@DROP_Y` | R | supply crates waiting / nearest crate | M7 |
| `@SEISMIC_TYPE`, `@SEISMIC_DIST` | R | last seismic scan | M7 |
| `@SCIENCE_READY` | R | science products waiting for downlink | M5 (M9: products in the recorder) |
| `@LOG_FREE` | R | free bytes in the log FIFO | M9 |
| `@LOG_LOST` | RW | log frames dropped (saturates at 255) | M9 |
| `@REC_FREE` | R | free bytes in the science recorder | M9 |
| `@POST` | RW | 0–255, two-digit hex display on the back of the cabin | M9 |
| `@PROG_STATE` | RW (writes: firmware only) | `PROG_*`; write `PROG_NONE` = acknowledge, `PROG_READY` = restart | M10 |
| `@PROG_RESULT` | R | value of the program's last `END` | M10 |
| `@WDT` | RW (writes: firmware only) | 0–30000: write n > 0 arms / kicks (n ticks); read = ticks left, 0 = not armed | M13 |
| `@PREEMPT` | RW (writes: firmware only) | 0–7, `PRE_*` bits that end a slice at once | M13 |
| `@BAT_ALARM` | RW (writes: firmware only) | 0–100, threshold of `PRE_LOW_BAT` | M13 |
| `@PREEMPTED` | R | `PRE_*` bits that ended the last slice early; cleared by `CALL PROGRAM` | M13 |
| `@SLICE` | RW (writes: firmware only) | 0–30000 ticks for the next `CALL PROGRAM`, 0 = no limit; read in the program: ticks left | M14 |
| Device ports | see §5.9 | `@TIMER`, `@DRIVE`, `@DRIVE_N`, `@RADAR`, `@RADAR_HIT`, `@RADAR_DIST`, `@TOOL`, `@TOOL_ARG`, `@REPAIR`, `@REPAIR_SYS`, `@CAM`, `@CAM_MODE`, `@SEND`, `@ERASE` | M14 |
| `@TEMP`, `@HEATER` | R | °C; survival heaters 0/1 | M13 |
| `@SOLAR_DUST` | R | 0–100 % dust on the array | M13 |

Writes are clamped to the port's range; angle ports wrap modulo 360.

### 5.7 Program size (Flash bytes)

A program's size is its machine code: each instruction is one opcode byte plus its
operands. Only the instruction lines count; comments, blank lines, label definitions,
`ALIAS` and `CONST` exist at compile time only and emit nothing. Size does not affect
speed (every compute instruction is still 1 cycle). Numbers live in `ENCODING`
(`src/core/balance.ts`).

| Element | Bytes | Notes |
| :--- | :--- | :--- |
| Opcode | 1 | 2 for extended instructions (`AND`, `OR`, `SHL`, `SHR`; §5.7.1). |
| Register / alias | 1 | Operand byte: addressing mode + register index. |
| Port | 1 | Operand byte: addressing mode + port number. |
| Immediate 0…15 | 1 | Packed into the operand byte (short immediate). |
| Immediate −128…127 | 2 | Operand byte + 1 data byte. |
| Immediate −32768…32767 | 3 | + 2 data bytes. |
| Larger immediate | 5 | + 4 data bytes (registers are 32-bit). |
| Label reference | 2 | Absolute address of a jump / `CALL` target. |
| `[r]` **[M14]** | 1 | Operand byte `00100rrr`. |
| `[n]`, `[r+n]` **[M14]** | 3 | Operand byte `00011100` / `00101rrr` + 16-bit address / signed offset. Decided by the syntax: `[x+r]` is 3 B even when `x` is 0. |
| `DATA` value **[M14]** | 1 | In the data section after the code. |

Constants cost what their value costs: `NORTH`, `RED`, `TOOL_1` are 1 byte; a tile ID
above 15 or `CONST SPEED 90` is 2. Examples: `RET` = 1, `MOV r0 r1` = 3,
`JLE @BAT 20 home` = 1 + 1 + 2 + 2 = 6. The compiler reports the size per line and the
first line that no longer fits.

#### 5.7.1 Machine code and the listing **[M10]**

Decided with the owner (2026-11-13): the compiler emits real bytes, and the player sees
an assembler listing (address, hex bytes, source line) and the final byte count of each
slot, assembled on the ground (free) while typing.

* **Opcode byte** `kkknnnnn`: `nnnnn` is the instruction from a fixed table (`MOV` 01,
  `PUSH` 02, … `RET` 11, `LOG` 19, `BRK` 1A, `END` 1C; the Reference tab lists them). 1D and
  1E are `LDB` / `STB` (§3.8.7). **[M14]** The retired hardware instructions freed 12–18
  and 1B; once (owner decision, every save is recompiled by the v18 migration) two were
  reused: **12 `WAIT`, 13 `LDF`**. 14–18 and 1B are free for later.
* **Extended instructions:** `nnnnn` = `1F` is a prefix; the next byte is the
  instruction's number in a second table: `AND` 01, `OR` 02, `SHL` 03, `SHR` 04 (05–07,
  once `SEND`, `ERASE`, `LDF`, are free). Like the prefix bytes of real CPUs (Z80 `CB` / `ED`, x86
  `0F`): one byte longer, same speed. `AND r0 3` = `1F 01 10 03`. `kkk` in the prefix byte
  counts optional operands as usual.
* `kkk` counts the
  optional operands present (`LOG t [v]`, `END [v]`, the arguments of `CALL`), because a
  short-immediate or register byte looks like an opcode: `LOG 2` = `19 02`,
  `LOG 2 r0` = `39 02 10`, `END 1` = `3C 01`. Hence `CALL` passes at most 7 arguments.
  `CALL STEP 1 2` = `50 F0 05 01 02` (the ROM routine's address, two arguments).
* **Operand byte**: `0000vvvv` short immediate 0–15 · `00010rrr` register r0–r7 ·
  `01pppppp` port (fixed port numbers 0–63, `PORT_CODES` in `ports.ts`: `@BAT` = 0 → `40`;
  the Reference tab lists them; numbers of removed ports: 30 and 33–34;
  **[M14]** the devices took 49–63; owner decision 2026-11-14: the next ports reuse the
  retired numbers 30, 33, 34 once, and only then the extended operand `00011011 pppppppp`
  of `ASSEMBLER_CORE.md` §9) · `00011000` / `00011001` / `00011010` followed by an
  8 / 16 / 32-bit big-endian two's-complement immediate · **[M14]** `00011100` + 2 bytes
  `[n]` · `00100rrr` `[r]` · `00101rrr` + 2 bytes `[r+n]` (signed offset). Other values are
  invalid.
* **Data section [M14]**: the `DATA` bytes follow the last instruction. The CPU wraps to
  0x000 at the end of the instructions, so it never runs into data; a jump into the data
  section faults (no instruction starts there).
* **Label reference**: 2 raw bytes, the big-endian byte address of the target (no operand
  byte; the instruction says where a label goes).
* Sizes are exactly the table above. Example: `JLE @BAT 20 home` with `home` at 0x2A →
  `0E 40 18 14 00 2A`.
* **Addresses are byte addresses everywhere**: listing, dumps
  (`next prog:0x02A (L13)`), return addresses on the call stack, the debugger. The VM still
  executes decoded instructions (same cycle costs); running past the last byte wraps to
  0x000. A return address that does not start an instruction (only a corrupted one could)
  faults. Saves before v11 stored instruction indices; loading converts them.
* **Code address space [M14]**: each slot from `0x000`, the `PROGRAM` gate `0xE000` (firmware
  `CALL PROGRAM`; a dump of the firmware during a slice shows `next 0xE000`), the ROM
  `0xF000`–`0xFFFF` (listing and dumps: `rom:0xF012`). A ROM instruction has no source line
  in the player's code (the editor marks no line while the CPU is inside the ROM).
* **Each slot starts at 0x000** (own address space): a firmware change never moves the
  program, so it never has to be re-uploaded. The listing labels addresses `fw:0x02A` /
  `prog:0x010`; the total shows `firmware 136 + program 46 = 182 / 256 B`.
* **The listing** (Code tab, below the editor): one row per instruction, label and
  directive (comments and blank lines are left out); address | up to 6 hex bytes (longer
  instructions continue on the next row) | source. Kept in sync while typing (a slot with
  errors still lists, with estimated sizes and `??` bytes); clicking a row jumps to its
  line, the cursor's line is highlighted, and so is the admin debugger's next line.
  There is no separate *Compile* button (removed 2026-11-13): the listing and the flash
  bar already show the result live.

### 5.8 Memory **[M14]**

Design and reasons: [`ASSEMBLER_CORE.md`](ASSEMBLER_CORE.md) §7 (slice 2 of M14 is built).

| Data addresses | What | Access |
| :--- | :--- | :--- |
| `0x000`… | RAM: `chassis.ramBytes` (Mk-I 64 B; upgrades 128 / 256) | read / write |
| `0x100`… (`IMG`) | image memory, `imageBytes(chassis)` (256 / 512 / 1024 B) | read / write |
| `0x600`… (`CARGO`) | cargo, one byte per slot (the item's tile ID) | read only |
| anything else | nothing | `FAULT` "No memory at 0x…" |

* Constants `RAM` = 0, `IMG` = `0x100`, `CARGO` = `0x600` (`MEMORY_MAP` in `balance.ts`).
* **RAM is shared** by firmware and program (owner, 2026-11-14: overwriting the other
  slot's memory, or running past the end, is allowed: a real-life bug to learn from). It is
  zero after every hard reboot; a program upload keeps it; it is saved.
* **`VAR`**: the program's `VAR`s get addresses from 0 upward, the firmware's from the top
  of RAM downward. Each slot is compiled against the RAM the other slot's `VAR`s take; an
  overlap (or a `VAR` larger than RAM) is a compile error naming both sizes. The Code tab
  shows `RAM firmware + program = used / size` next to the Flash totals. A firmware is
  assembled for the RAM it was flashed with: after a RAM upgrade its `VAR`s keep their
  addresses until the next firmware upload (saved as `fwRamTop`).
* **Save v17**: v16 code is rewritten on load (`LDB d a` → `LDB d [IMG+a]`, `STB a v` →
  `STB [IMG+a] v`); a rover whose code changed is hard-rebooted with boot reason 6
  (*software update*), because its saved instruction addresses no longer match.
* Lesson template *Route* (`DATA`, `LDF`, `VAR`, `LDB`, `STB`).

### 5.9 Devices and the ROM **[M14]**

Design and reasons: [`ASSEMBLER_CORE.md`](ASSEMBLER_CORE.md) §3–§6 (slice 3 of M14 is built).
The CPU only computes and moves data; everything physical is a **device** behind ports, as
in a real machine (a CPU has no "drive" instruction: it writes a motor controller's
registers).

**A device** has a **start port** (write = start; the write sets `@STATUS`: `OK` = accepted,
or why not), a **progress port** (read: work left, 0 = idle; for every device the start port
itself), latched **argument ports** (they keep their value until written again; reboot
values below) and **result ports**. `WAIT @port` sleeps until the progress port reads 0 and
then copies the device's **result** (how its work ended) into `@STATUS`. A refused start
also becomes the result, so a `WAIT` right after it reports the refusal.

| Device | Arguments (reboot value) | Start (write) | Progress (read) | Results | Timing, energy (unchanged from the old instruction) | ROM routine |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Timer, **one per slot** | – | `@TIMER` ticks (`OK`) | ticks left | – | free | `CALL SLEEP ticks` |
| Drive | `@DRIVE_N` tiles (1) | `@DRIVE` direction | tiles left, counting the current one | `@X`, `@Y`, `@HEADING`; result `OK`, `ERR_BLOCKED`, `ERR_HAZARD`, `ERR_LOW_POWER`, `ERR_PREEMPTED` | 3–6 ticks, 40–120 energy per tile (§3.1); refused: `ERR_BUSY`, `ERR_DEPLOYED`, `ERR_BLOCKED`, `ERR_LOW_POWER`, `ERR_INVALID` (bad direction, `@DRIVE_N` 0) | `CALL STEP dir tiles` |
| Radar | – | `@RADAR` direction | 1 while sweeping | `@RADAR_HIT` (tile ID, `NONE`), `@RADAR_DIST` (0 = nothing) | 1 tick, 10 energy; the answer is measured when the sweep ends | `CALL SCAN dir` |
| Tools | `@TOOL_ARG` direction / slot (0) | `@TOOL` hardpoint 0–3 | ticks left | the tool's (cargo, `@SEISMIC_*`, spectra); result | per tool (§3.3.2); `ERR_NO_TOOL`, `ERR_INVALID`, `ERR_FULL`, `ERR_LOW_POWER` | `CALL ACT tool arg` |
| Repair | `@REPAIR_SYS` (`SYS_HULL`) | `@REPAIR` cargo slot | ticks left | `@HULL`…; result | 10 ticks, 200 energy | `CALL USE slot system` |
| Camera | `@CAM_MODE` (1) | `@CAM` direction | ticks left | image memory; result | 10 ticks, 200 energy | `CALL SNAP dir mode` |
| Image send | – | `@SEND` type (0 = the mode of the last photo) | ticks left | a product in the recorder | 1 tick, 10 energy; `ERR_FULL`, `ERR_INVALID`, `ERR_LOW_POWER` | `CALL SEND type` |
| Image erase | – | `@ERASE` any value | ticks left | image memory zeroed | 2 ticks, 10 energy | `CALL ERASE` |
| Program slice | – | `@SLICE` ticks (firmware) | ticks left | `@PROG_STATE` | §3.9.2 | `CALL RUN ticks` |

* **Interlocks** (physical): drive, tools, repair and camera share the chassis and the arm:
  one at a time, the others answer `ERR_BUSY` (10). `@SEND` and `@ERASE` are refused while
  the camera exposes, and one at a time. Radar and timers work alongside anything: a rover
  can **sweep the radar while it drives**, and compute, log and use memory while any device
  works.
* **Stopping the drive:** writing `@DRIVE_N` while driving sets the tiles left (counting the
  current one); `0` stops at the end of the current tile, and the drive's result is
  `ERR_PREEMPTED` ("stopped by a command").
* **Cargo** is memory, not a device: `LDB item [CARGO+slot]` (was `PEEK`, §5.8).
* A hard reboot (§3.3) stops every device and resets the arguments and results; the timers
  are part of each slot's context.

**The ROM** is a fixed library at code addresses `0xF000`… that both slots can `CALL`
(`ROM_SOURCE` in `src/core/rom.ts`, 330 B). It costs no Flash, runs in the caller's context
(its registers, stacks, `@STATUS`) and takes normal cycles; **Reference → ROM** shows its
listing, so a player can read exactly what `STEP` does, copy it and change it. Calling
convention: `CALL NAME args…` pushes the arguments; each routine pops all of them. The
drivers use no registers: they pop straight into the ports, start the device, return at once
if it refused, else `WAIT` for it. **Helpers** return their answer in `r0`; they may change
`r0` and `r1` and keep every other register (owner, 2026-11-14; like ARM's scratch
registers: with two arguments there is no other way to reach the second one):

```
STEP:   POP @DRIVE_N          ; tiles (pushed last: popped first)
        POP @DRIVE            ; direction: starts the drive, @STATUS = accepted?
        JNE @STATUS OK step_x
        WAIT @DRIVE           ; until the drive is idle; @STATUS = how it ended
step_x: RET
```

* Drivers: `SLEEP ticks`, `STEP dir tiles`, `SCAN dir`, `ACT tool arg`, `USE slot system`,
  `SNAP dir mode`, `SEND type`, `ERASE`, `RUN ticks` (firmware only).
* Helpers: `ABS v` (`r0` = |v|); `DIR_TO dx dy` (`r0` = the direction that shrinks the
  larger of |dx|, |dy|, a tie goes north / south, −1 if both are 0); `PUT16 addr v` (two
  bytes, high first, at a data address; `r0` = addr + 2); `GET16 addr` (`r0` = that
  16-bit value with its sign); `PLOT x y grey` (one pixel of a 32×32 2-bpp photo in image
  memory).
* Every argument is
  required; the assembler checks the count (a routine that pops more or fewer than were
  pushed would unbalance the data stack). Their names, `PROGRAM` and `WAIT` are reserved.
* `LDF` reads ROM bytes too (`LDF r0 [STEP]`).
* Not built yet (decided for M14, see ROADMAP): the boot ROM with safe mode.

**Save v18:** device state (latched arguments, radar, image send / erase, results) and each
slot's timer are saved. v17 code is rewritten on load (`ASSEMBLER_CORE.md` §10: `STEP d n` →
`CALL STEP d n`, `STEP d` → `CALL STEP d 1`, `SCAN d -> a b` → `CALL SCAN d` + `MOV a
@RADAR_HIT` + `MOV b @RADAR_DIST`, `ACT t` → `CALL ACT t 0`, `USE s` → `CALL USE s SYS_HULL`,
`SNAP d` → `CALL SNAP d 1`, `SEND` → `CALL SEND 0`, `ERASE` → `CALL ERASE`, `PEEK s -> d` →
`LDB d [CARGO+s]`, `RUN t` → `CALL RUN t`, `MOV @TX_DATA v` → `LOG 0 v`; player names that
are now reserved get a `_`: `step:` → `step_:`). A rover whose code changed (or that uses the
renumbered `LDF`) is hard-rebooted with boot reason 6 (*software update*).

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
