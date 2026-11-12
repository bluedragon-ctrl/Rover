# Rover — Game & Language Specification (`v1.5`)

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

* **Compute instructions** (`MOV`, arithmetic, stack, jumps, `CALL`/`RET`, `PEEK`) cost
  **1 cycle** each. Several run per tick.
* **Hardware instructions** (`SCAN`, `STEP`, `ACT`, `USE`, `SLEEP`) **end the current
  tick** and may block the CPU for a number of ticks while the physical action happens.
* Port writes (e.g. `MOV @LIGHT_COLOR 2`) are compute instructions: instant.

This keeps logic snappy, makes physical actions cost real time, and naturally caps
runaway loops (an infinite `JMP` loop just burns cycles; it cannot freeze the game).

Tick order: (1) world/event update, (2) each unit's in-flight action advances and may
complete (unblocking its CPU), (3) passive energy drain, (4) each CPU spends its cycles.

## 3. The Rover (Mk-I chassis)

Each rover owns a copy of its chassis stats; upgrades (§3.7) modify that copy.

| Stat | Mk-I | Notes |
| :--- | :--- | :--- |
| Flash | 128 bytes | Machine-code size (§5.7). Comments, blank lines, label definitions, `ALIAS`, `CONST` are free. |
| Registers | 4 (`r0`–`r3`) | Signed 32-bit, wrap on overflow. |
| Data stack | 8 entries | `PUSH`/`POP`, `CALL` arguments. |
| Call stack | 8 frames | Return addresses only. |
| Battery | 100 000 energy units | Exposed as `@BAT` = 0–100 (%). |
| Hull | 100 | `@HULL`. |
| Subsystems | solar array 100, dish 100 | `@SOLAR_HEALTH`, `@ANTENNA_HEALTH`. **[M6]** |
| Cargo | 4 slots | Item IDs (= tile IDs). **[M5]** |
| Hardpoints | `TOOL_0` drill, `TOOL_1` grabber, `TOOL_2` spectrometer, `TOOL_3` empty | **[M5]** |
| Sensor range | 6 tiles | `SCAN` radar, every direction, day and night. The operator's *view* needs light: 6 by day, 1-tile ring at night plus the headlight cone (§3.1.1). **[M4, M8.1]** |
| Downlink | 2 B/tick at full signal, log FIFO 32 B, science recorder 1024 B | Link + log FIFO **[M9]**; recorder **[M9, planned]** §3.8 |
| Camera | mast camera, 32×32 2 bpp | `SNAP dir [mode]`. **[M9, planned]** §3.8.5 |

### 3.1 Energy costs (defaults)

| Action | Ticks | Energy |
| :--- | :--- | :--- |
| Idle (CPU powered) | per tick | 1 |
| `STEP` onto `FLAT_SAND` | 3 / tile | 40 / tile |
| `STEP` onto `ROUGH_GRAVEL` | 6 / tile | 120 / tile |
| `STEP` onto `ACID_VENT` | 4 / tile | 60 / tile + 10 hull damage |
| `SCAN` | 1 | 10 |
| Turn in place (`@HEADING` write) | instant | 5 |
| Headlight on | per tick | 8 |
| Actuator moving (array deploy, panel or dish slew) | per tick, each | 1 |
| `@TX_DATA` packet | instant | 30 |
| Solar charge | per tick | `floor(60 × SUN_LIGHT/100 × cos(panel − sun azimuth))`, only when fully deployed |

### 3.1.1 Radar, operator view and the headlight **[M8.1]**

The rover and the player "see" differently:

* **`SCAN` is radar.** It reaches the chassis sensor range (6 tiles; 8 with the
  Long-range radar upgrade) in every direction, by day and by night. It needs no light
  and does not turn the rover. Firmware can always navigate.
* **The operator view needs light.** What the player sees (and what gets permanently
  mapped in the fog of war, and lit by the renderer) is one shape, `src/core/sensors.ts`:

| Condition | Operator sees |
| :--- | :--- |
| Day (`@SUN_ELEV > 0`) | Disc of radius 6 (`dx² + dy² ≤ r² + r`) around the rover. |
| Night | The 1-tile ring around the rover (radius-1 disc, diagonals included). |
| Night, `@HEADLIGHT 1` (powered) | Ring **plus a forward cone** along `@HEADING`: `1 ≤ forward ≤ 5`, `|lateral| ≤ 1` for `forward ≤ 2`, `≤ 2` beyond (21 tiles). |

* So at night a player cannot look at unexplored ground and type `STEP NORTH 5`: they need
  the headlight pointed that way, already-mapped terrain, or firmware that uses `SCAN`.
* Each `SCAN` also sends a brief red **radar wave** around the rover out to the radar
  range: tiles flash as the front passes, then fade, and unmapped terrain in range is
  briefly outlined in red. It is a glimpse for the player only; it maps nothing. (`SCAN` still returns just the first hit along `dir`.)
* The rover faces `@HEADING`. `STEP` and directional tools (`ACT TOOL_n dir`) turn it;
  writing `@HEADING` turns it in place (5 energy, value wraps mod 4, so `ADD @HEADING 1`
  turns right). Use it to aim the headlight.

### 3.2 CPU states

| State | Meaning |
| :--- | :--- |
| `RUNNING` | Executing instructions. |
| `BLOCKED` | Waiting for a hardware action (`STEP`, `SCAN`, `SLEEP`, ...). |
| `HALTED` | **[M9, planned]** Stopped by `BRK`; resumes on *Continue* or upload (§3.8.4). No watchdog. |
| `FAULT` | Stack overflow/underflow. A **watchdog** hard-reboots the CPU after 50 ticks. |
| `POWER_OFF` | Battery empty (§3.4). |
| `DESTROYED` | Hull at 0. Only the admin console can recover. |

### 3.3 Hard reboot (on code upload or watchdog)

`IP = 0`, all registers zeroed, both stacks cleared, any in-flight action aborted,
`@STATUS = OK`. Physical state (position, battery, hull, cargo, actuator ports) is kept.

Upload cost **[M4]**: `ceil((500 + 12 × bytes) × 100 / max(10, @SIGNAL_STR))` energy
(≈ 1.5 % for an 85-byte program at full signal, 10× that with the dish misaligned).
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
* **Indicator lamps [M8]:** three lamps on the cabin roof, `@IND1`, `@IND2`, `@IND3`
  (left to right), each takes a light colour constant (`OFF`, `RED`, `GREEN`, `BLUE`,
  `AMBER`, 0–4). They are purely a visual channel for the player: free, no gameplay
  effect, no `@STATUS`. Like the beacon they are physical and survive reboots; they go
  dark while the rover is powered off.
* **TX:** writing `@TX_DATA` sends a packet if `@SIGNAL_STR >= 50` and sets `@STATUS`
  (`OK`, `ERR_NO_SIGNAL`, `ERR_LOW_POWER`). This is the one port write that touches
  `@STATUS`.
  **[M9, planned]** replaced by the byte-based downlink (§3.8): `@TX_DATA` becomes
  `LOG 0 value`, science travels in the recorder.

### 3.3.2 Tools, cargo and science **[M5]**

Tools are declared in `src/core/tools.ts`; hardpoint assignment comes from the chassis.
`ACT TOOL_n arg` validates immediately (errors cost no time), then pays energy, blocks
the CPU for the tool's duration and applies the effect when it finishes (re-checking
that the target is still there). Tools work with the solar array deployed.

| Instruction | Tool | Ticks | Energy | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `ACT TOOL_0 dir` | Mining drill | 8 | 600 | Removes the adjacent ore vein (`IRON_ORE`, `SILICON_ORE`) and stores it in the first free slot. |
| `ACT TOOL_1 dir` | Grabber | 2 | 100 | Picks up the adjacent surface item (`SAMPLE`, `REPAIR_KIT`). Adjacent tiles only. |
| `ACT TOOL_2 slot` | Spectrometer | 30 | 300 | Analyzes the item in `slot` and frees it: `SAMPLE` +3 science, ore +1. |
| `ACT TOOL_3` | (empty) | – | – | `ERR_NO_TOOL`. |
| `USE slot [system]` | Field repair | 10 | 200 | Repairs `system` (default `SYS_HULL`) by **consuming the material** in cargo `slot` (see table below). |

Errors: `ERR_INVALID` (bad direction/slot, nothing usable there), `ERR_FULL` (no free
cargo slot), `ERR_LOW_POWER`, `ERR_NO_TOOL`.

**Science:** analyzed science waits in `@SCIENCE_READY`. Every *successful* `@TX_DATA`
write carries one science packet home (decision: automatic, no extra port). **[M9, planned]**
the spectrometer records a 16-byte spectrum in the science recorder instead, delivered
by the downlink (§3.8.5). Delivered
science adds **science credits**, as do completed goals. Credits are the currency for
M7 upgrades.

**Goals [M5]:** the `EventDirector` (future storyteller) tracks a fixed set of sandbox
goals (First contact, Night owl, Surveyor, Trailblazer, Prospector, Collector, Scientist),
each with a credit reward. Checked every 10 ticks; deterministic.

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
| Dust squall | ✔ (guaranteed first) | goal *First contact* | 15 % | 400 | 60 | Hull −1 / 20 ticks; open array −1 / 3 ticks. |
| Partial eclipse | ✔ (guaranteed first) | goal *First contact* | 15 % | 300 | 120 | Light dips to 40 %. |
| Micrometeorite squall | | Dust squall seen, sol ≥ 3 | 35 % | 200 | 100 | Hull −1 / 10 ticks (/5 while driving); dish −1 / 20; open array −2 / 3 ticks (≈ −66). |
| Total solar eclipse | | Partial eclipse seen, goal *Night owl*, sol ≥ 3 | 30 % | 200 | 150 | Light → 0. Daytime only. |

Event goals: *Into the dark* (a rover powered through a whole eclipse), *Storm chaser*
(out of a squall with hull ≥ 50 and solar ≥ 50). Admin-started events ignore
prerequisites and count neither toward goals nor toward "seen" prerequisites.

## 3.6 Persistence **[M6]**

`SaveManager.serialize/deserialize` (headless). A save (`version: 4`; v1–v3 files are migrated
by `migrate()`) holds the seed, supply drops, installed upgrades, each rover's downlink
(log FIFO, transmitter budget, `@LOG_LOST`), the console's last 200 received frames,
tick, credits, stats, cheats, storyteller state (RNG, schedule, completed goals), full
unit and VM state (firmware source is recompiled on load), and **only chunks that are
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

| Upgrade | Cost | Effect | Requires |
| :--- | :--- | :--- | :--- |
| Flash 192 B / Flash 256 B | 40 / 90 | Program memory 192 / 256 bytes | – / Flash 192 B |
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

## 3.8 Downlink, debugging and science products **[M9, in progress]**

Built so far (slice 1): the link (§3.8.1) with the log FIFO, log and boot frames
(§3.8.2), `LOG`, `@LOG_FREE`, `@LOG_LOST` and the Console tab (§3.8.3). Still planned:
the recorder and science frames, `@TX_DATA` as `LOG 0`, `@POST`, dumps and `BRK`,
the camera and the upgrades.

Design principle: **mission control knows only what the rover sent**, plus the program
it uploaded itself. There is no live view of registers, stacks or ports for the player
(the old debugger becomes an admin-only "omniscient" view). Everything the player learns
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
  (1 = code upload, 2 = watchdog, 3 = cold boot, 4 = admin).
* **Science frames:** `tag` = product type (§3.8.5), then a sequence byte (0–255,
  wrapping, per rover), then the payload. Overhead is 2 bytes per product.

### 3.8.3 Debug log: `LOG`, the console, `@POST`

| Instruction | Cycles | Bytes | Semantics |
| :--- | :--- | :--- | :--- |
| `LOG tag [src]` | 1 | 1 + 1 + src | Queues a log frame. `tag` is a compile-time constant 0–14. Compute instruction: **no `@STATUS` change**, no energy (the transmitter pays). If the whole frame does not fit in the FIFO it is **dropped** and `@LOG_LOST` increments. |

* `@LOG_FREE` (R): free bytes in the log FIFO. `@LOG_LOST` (RW): frames dropped since
  boot; saturates at 255; write sets it (usually 0).
* `@TX_DATA` (W) becomes shorthand for `LOG 0 value`, kept for old programs. It still
  writes `@STATUS` (`OK`, or `ERR_FULL` when the frame was dropped). It no longer carries
  science.
* **Console** (mission-control tab): every received frame with its tick of arrival,
  raw hex and the decoded value. Tags are named from the uploaded program, like a
  `defmt` / spacecraft-EVR dictionary: with `CONST T_BAT 5`, `LOG T_BAT @BAT` shows as
  `T_BAT = 812 (L17)`. A raw-hex toggle hides the decoding. Lost frames show as a gap
  ("⚠ 3 frames lost"): the transmitter counts drops and reports the count with the next
  frame that gets through (link-layer bookkeeping, not part of the frame bytes). The
  console keeps the last 200 frames (saved).
* **`@POST` (RW, 0–255):** a two-digit hexadecimal display on the rover body, like a PC
  POST card. Free, no link needed, no `@STATUS`; physical (survives reboots), dark while
  powered off. The player can read it only while the rover is inside their view
  (§3.1.1): at night, near the rover or in the headlight cone.

### 3.8.4 Memory dumps and `BRK`

* **Dump** (console button): an uplinked command, paid like a small upload
  (`dumpEnergy` = `ceil(150 × 100 / max(10, @SIGNAL_STR))`), rejected without power.
  The rover answers with a tag-15 dump frame (IP 2 B, `@STATUS` 1 B, CPU state 1 B,
  each installed register 4 B, data-stack depth 1 B, call-stack depth 1 B: 22 B on Mk-I,
  38 B with 8 registers; stack contents need a second command, "dump stacks"). The console shows it as a **snapshot with the
  tick it was taken**, never as a live view.
* **`BRK`** (1 cycle, 1 byte, compute): the CPU enters the new state `HALTED`. Physical
  actions already in progress finish; the world keeps running; the watchdog does not
  fire. The console offers *Dump* and *Continue* (both uplinked commands; *Continue*
  costs the same as a dump). An upload also ends the halt (hard reboot).
* **Admin view:** the old live debugger stays available behind the admin toggle, clearly
  labelled, for development and when stuck.

### 3.8.5 Science products and the recorder

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
  silicon: flat and bright; vent sulfates: green peak) with small per-position variation.
* **Camera** (mast, not a hardpoint): `SNAP dir [mode=1]`, blocks 10 ticks,
  200 energy, writes `@STATUS`: `ERR_FULL` (not enough recorder space),
  `ERR_INVALID` (bad direction or mode not installed), `ERR_LOW_POWER`. Subject: the first
  obstacle or item within 2 tiles in `dir`, else the ground tile in front. **Light:**
  `@SUN_LIGHT ≥ 20`, or the headlight on and `@HEADING = dir`; otherwise the photo is dark
  and noisy (auto-exposure amplifies sensor noise) and worth nothing.
* `@REC_FREE` (R): free recorder bytes. `@SCIENCE_READY` (R): products waiting in the
  recorder (meaning unchanged: science waiting for downlink).
* **Content is deterministic:** a product is stored as a descriptor (type, subject tile,
  position, light, tick); its bytes come from a pure, integer-only function of the world
  seed and the descriptor (`src/core/imaging.ts`, no `Math.random`, no float trig in the
  tick path), so saves stay small and runs stay reproducible.

**Credits on delivery** (tunable, `BALANCE`): spectrum = the item's `science` value
(sample 3, ore 1, as today); lit photo = 1, +5 the first time a subject type is
delivered; dark photo = 0. **Anomalies:** rare tiles (seeded, e.g. 1 in 40 cliff walls
and samples) show a pattern only a photo reveals; flagging a delivered anomaly photo in
the gallery pays +20, a wrong flag −5, one flag per photo.

**Gallery** (mission-control tab): received photos (crisp pixels, scaled up) and spectra
(bar charts), each with tick, position, size and hex view.

### 3.8.6 Upgrades (catalogue additions)

| Upgrade | Cost | Effect | Requires |
| :--- | :--- | :--- | :--- |
| Recorder 2 KB / 4 KB | 40 / 80 | Science recorder 2048 / 4096 B | – / 2 KB |
| High-gain amplifier | 60 | Link 3 B/tick at full signal | – |
| Trace buffer | 30 | Log FIFO 64 B | – |
| Colour filter wheel | 60 | Camera mode 3 | – |
| Hi-res sensor | 80 | Camera mode 4 | Recorder 2 KB |
| Colour sensor | 100 | Camera mode 5 | Colour filter wheel, Recorder 2 KB |

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
* `->` is optional sugar for output operands (`SCAN dir -> r1 r2` ≡ `SCAN dir r1 r2`).
* **Running off the end of the program wraps to line 0**: every program is an implicit
  main loop, saving a `JMP` line.

### 5.2 Operands

| Kind | Syntax | Notes |
| :--- | :--- | :--- |
| Register | `r0`…`r3` | Using a register beyond the chassis count is a compile error. |
| Alias | any name bound with `ALIAS` | Compile-time only. |
| Immediate | `42`, `-7`, `0xFF` | |
| Constant | `NORTH`, `IRON_ORE`, `ERR_BLOCKED`, any `CONST` name | Resolved at compile time. |
| Port | `@BAT`, `@LIGHT_COLOR`, ... | Writing a read-only port is a compile error. |
| Label | `loop` | Jump/call targets only. |

**Every value operand accepts a register, port, immediate or constant**, including
directions, tool slots and cargo slots (`STEP r0`, `PEEK r1 -> r2`).

### 5.3 Directives (0 bytes)

| Directive | Meaning |
| :--- | :--- |
| `ALIAS <reg> <name>` | Name a register. |
| `CONST <name> <value>` | Name an integer constant. |

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
| Flow | `JMP label` | 1 cycle | |
| | `JEQ / JNE / JLT / JGT / JLE / JGE a b label` | 1 cycle | Compare and branch. |
| | `CALL label [args...]` | 1 cycle | Pushes args in order to the data stack, return address to the call stack. |
| | `RET` | 1 cycle | Pop call stack. Underflow → `FAULT`. |
| Hardware | `SLEEP ticks` | blocks `ticks` | `ticks <= 0` just ends the tick. |
| | `SCAN dir -> type dist` | blocks 1 | Radar ray across layers 1–3 up to the sensor range, day or night (§3.1.1; does not turn the rover). Returns the first hit's tile ID and distance, or `NONE` and `0`. |
| | `STEP dir [tiles=1]` | blocks per tile | Moves tile by tile; aborts with `ERR_BLOCKED`, `ERR_LOW_POWER` or `ERR_HAZARD` (moved onto a hazard). |
| | `ACT tool [arg]` | tool-defined | Fire the tool in hardpoint `tool` (§3.3.2). |
| | `PEEK slot -> dst` | 1 cycle | Item ID in cargo `slot` (0 = empty); bad slot → `ERR_INVALID`. |
| | `USE slot` | 5 ticks | Consume a cargo item (§3.3.2). |
| | `SNAP dir [mode]` | blocks 10 | **[M9, planned]** Photograph the subject in `dir` into the science recorder (§3.8.5). |
| Debug | `LOG tag [src]` | 1 cycle | **[M9]** Queue a log frame for the downlink; compute, no `@STATUS` (§3.8.3). |
| | `BRK` | 1 cycle | **[M9, planned]** Halt the CPU (`HALTED`) until *Continue* or an upload (§3.8.4). |

`@STATUS` is written by every hardware instruction and by arithmetic errors; pure
compute instructions leave it alone.

### 5.5 Constants

* Directions: `NORTH=0`, `EAST=1`, `SOUTH=2`, `WEST=3`.
* Status: `OK=0`, `ERR_INVALID=1`, `ERR_FULL=2`, `ERR_LOW_POWER=3`, `ERR_BLOCKED=4`,
  `ERR_NO_TOOL=5`, `ERR_NO_SIGNAL=6`, `ERR_HAZARD=7`, `ERR_DEPLOYED=8`.
* Tools: `TOOL_0`…`TOOL_3`.
* Systems: `SYS_HULL=0`, `SYS_SOLAR=1`, `SYS_ANTENNA=2`.
* Alerts: `ALERT_NONE=0`, `ALERT_ECLIPSE=1`, `ALERT_SQUALL=2`.
* Colors: `OFF=0`, `RED=1`, `GREEN=2`, `BLUE=3`, `AMBER=4`.
* Tiles: `NONE=0` plus every `constName` in `WorldRegistry` (`FLAT_SAND`, `IRON_ORE`, `ROVER`, ...).

### 5.6 Ports

| Port | Access | Range | Status |
| :--- | :--- | :--- | :--- |
| `@BAT` | R | 0–100 | M1–M3 |
| `@HULL` | R | 0–100 | M1–M3 |
| `@X`, `@Y` | R | signed | M1–M3 |
| `@STATUS` | R | 0–7 | M1–M3 |
| `@TICK` | R | ticks since world start | M1–M3 |
| `@GROUND` | R | layer 0 tile ID under the rover | M1–M3 |
| `@GROUND_HAZARD` | R | 0–2 | M1–M3 |
| `@LIGHT_COLOR` | RW | 0–4 | M1–M3 |
| `@LIGHT_BLINK` | RW | 0/1 | M1–M3 |
| `@HEADLIGHT` | RW | 0/1 | M4 (costs energy; M8.1: lights a forward cone for the operator at night) |
| `@HEADING` | RW | 0–3 (`NORTH`…`WEST`); write turns in place, wraps mod 4 | M8.1 |
| `@IND1`, `@IND2`, `@IND3` | RW | 0–4 (`OFF`…`AMBER`) | M8 (indicator lamps, visual only) |
| `@SENSOR_RANGE` | R | SCAN (radar) range, any direction, day and night | M4, M8.1 |
| `@SUN_AZIMUTH`, `@SUN_ELEV`, `@SUN_LIGHT` | R | 0–359, −70..70, 0–100 | M4 |
| `@SOLAR_OPEN` | RW | 0/1 | M4 |
| `@SOLAR_ANGLE` | RW | 0–359 (write = target, read = current) | M4 |
| `@ORBIT_AZIMUTH`, `@SIGNAL_STR` | R | 0–359, 0–100 | M4 |
| `@ANTENNA_ANGLE` | RW | 0–359 (write = target, read = current) | M4 |
| `@TX_DATA` | W | any int | M4 (M9: = `LOG 0 value`) |
| `@CARGO_FREE` | R | free cargo slots | M5 |
| `@SOLAR_HEALTH`, `@ANTENNA_HEALTH` | R | 0–100 | M6 |
| `@ALERT` | R | `ALERT_*` | M6 |
| `@ALERT_ETA` | R | ticks until the alerted event | M6 |
| `@DROPS`, `@DROP_X`, `@DROP_Y` | R | supply crates waiting / nearest crate | M7 |
| `@SEISMIC_TYPE`, `@SEISMIC_DIST` | R | last seismic scan | M7 |
| `@SCIENCE_READY` | R | science products waiting for downlink | M5 (M9: products in the recorder) |
| `@LOG_FREE` | R | free bytes in the log FIFO | M9 |
| `@LOG_LOST` | RW | log frames dropped (saturates at 255) | M9 |
| `@REC_FREE` | R | free bytes in the science recorder | M9, planned |
| `@POST` | RW | 0–255, two-digit hex display on the rover | M9, planned |

Writes are clamped to the port's range; angle ports wrap modulo 360.

### 5.7 Program size (Flash bytes)

A program's size is its machine code: each instruction is one opcode byte plus its
operands. Only the instruction lines count; comments, blank lines, label definitions,
`ALIAS` and `CONST` exist at compile time only and emit nothing. Size does not affect
speed (every compute instruction is still 1 cycle). Numbers live in `ENCODING`
(`src/core/balance.ts`).

| Element | Bytes | Notes |
| :--- | :--- | :--- |
| Opcode | 1 | |
| Register / alias | 1 | Operand byte: addressing mode + register index. |
| Port | 1 | Operand byte: addressing mode + port number. |
| Immediate 0…15 | 1 | Packed into the operand byte (short immediate). |
| Immediate −128…127 | 2 | Operand byte + 1 data byte. |
| Immediate −32768…32767 | 3 | + 2 data bytes. |
| Larger immediate | 5 | + 4 data bytes (registers are 32-bit). |
| Label reference | 2 | Absolute address of a jump / `CALL` target. |

Constants cost what their value costs: `NORTH`, `RED`, `TOOL_1` are 1 byte; a tile ID
above 15 or `CONST SPEED 90` is 2. Examples: `RET` = 1, `MOV r0 r1` = 3,
`JLE @BAT 20 home` = 1 + 1 + 2 + 2 = 6. The compiler reports the size per line and the
first line that no longer fits.

## 6. Milestones

Milestone status, the detailed plan for the next step, open decisions and the
backlog live in [`ROADMAP.md`](ROADMAP.md). This spec describes *what the game is*;
the roadmap tracks *where the work is*.

## 7. Visual overhaul roadmap (M8)

The renderer is a read-only consumer of the simulation, and every shape is drawn in
`src/render/VectorFactory.ts`, so this whole milestone can happen without touching
gameplay, saves or tests.

* **Bloom / glow:** `EffectComposer` + `UnrealBloomPass` on emissive lines (ore crystals,
  scan rays, beacon, headlight, acid vents). Selective bloom so the grid stays crisp.
* **Fat lines:** `Line2` / `LineSegments2` + `LineMaterial` for real pixel widths
  (WebGL lines are 1 px). Width can scale with zoom and importance.
* **Level of detail:** two or three geometry tiers per chunk keyed on zoom: far = grid +
  silhouettes, near = pebbles, rock strata, contour lines, detailed rover (spinning
  wheels, unfolding panels, rotating dish, suspension bounce).
* **Wider zoom range:** from a single tile up to a strategic map view; far zoom switches
  to a simplified minimap-style rendering.
* **Camera:** optional perspective mode, zoom-to-cursor, smooth orbit/rotation, cinematic
  follow.
* **Atmosphere:** day/night color grading, distance fade, dust particles, CRT /
  scanline post-effect toggle, animated hazards and pickups.
* **Terrain height:** if elevation is added to the simulation, render it as wireframe
  relief.
* **Performance budget:** LOD + per-frame build limits keep far zoom affordable; measure
  with a frame-time HUD.
