# Rover — Game & Language Specification (`v1.3`)

This document supersedes `v1.2` of the architecture/language review. It fixes the
inconsistencies found in review and pins down the numbers the code relies on.
All tunable numbers live in `src/core/balance.ts`; this document lists defaults.

Status markers: **[M1–M3]**, **[M4]**, **[M5]** implemented in that milestone, **[later]** designed
but not yet implemented.

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

| Stat | Mk-I | Notes |
| :--- | :--- | :--- |
| Flash | 32 instruction lines | Comments, blank lines, labels, `ALIAS`, `CONST` are free. |
| Registers | 4 (`r0`–`r3`) | Signed 32-bit, wrap on overflow. |
| Data stack | 8 entries | `PUSH`/`POP`, `CALL` arguments. |
| Call stack | 8 frames | Return addresses only. |
| Battery | 100 000 energy units | Exposed as `@BAT` = 0–100 (%). |
| Hull | 100 | `@HULL`. |
| Cargo | 4 slots | Item IDs (= tile IDs). **[M5]** |
| Hardpoints | `TOOL_0` drill, `TOOL_1` grabber, `TOOL_2` spectrometer, `TOOL_3` empty | **[M5]** |
| Sensor range | 6 tiles | 1 at night, 5 at night with headlight. **[M4]** |

### 3.1 Energy costs (defaults)

| Action | Ticks | Energy |
| :--- | :--- | :--- |
| Idle (CPU powered) | per tick | 1 |
| `STEP` onto `FLAT_SAND` | 3 / tile | 40 / tile |
| `STEP` onto `ROUGH_GRAVEL` | 6 / tile | 120 / tile |
| `STEP` onto `ACID_VENT` | 4 / tile | 60 / tile + 10 hull damage |
| `SCAN` | 1 | 10 |
| Headlight on | per tick | 8 |
| Actuator moving (array deploy, panel or dish slew) | per tick, each | 1 |
| `@TX_DATA` packet | instant | 30 |
| Solar charge | per tick | `floor(60 × SUN_LIGHT/100 × cos(panel − sun azimuth))`, only when fully deployed |

### 3.2 CPU states

| State | Meaning |
| :--- | :--- |
| `RUNNING` | Executing instructions. |
| `BLOCKED` | Waiting for a hardware action (`STEP`, `SCAN`, `SLEEP`, ...). |
| `FAULT` | Stack overflow/underflow. A **watchdog** hard-reboots the CPU after 50 ticks. |
| `POWER_OFF` | Battery empty (§3.4). |
| `DESTROYED` | Hull at 0. Only the admin console can recover. |

### 3.3 Hard reboot (on code upload or watchdog)

`IP = 0`, all registers zeroed, both stacks cleared, any in-flight action aborted,
`@STATUS = OK`. Physical state (position, battery, hull, cargo, actuator ports) is kept.

Upload cost **[M4]**: `ceil((500 + 50 × lines) × 100 / max(10, @SIGNAL_STR))` energy
(≈ 1.5 % for a 20-line program at full signal, 10× that with the dish misaligned).
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
* **TX:** writing `@TX_DATA` sends a packet if `@SIGNAL_STR >= 50` and sets `@STATUS`
  (`OK`, `ERR_NO_SIGNAL`, `ERR_LOW_POWER`). This is the one port write that touches
  `@STATUS`.

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
| `USE slot` | – | 5 | 0 | Consumes an item: `REPAIR_KIT` +30 hull. |

Errors: `ERR_INVALID` (bad direction/slot, nothing usable there), `ERR_FULL` (no free
cargo slot), `ERR_LOW_POWER`, `ERR_NO_TOOL`.

**Science:** analyzed science waits in `@SCIENCE_READY`. Every *successful* `@TX_DATA`
write carries one science packet home (decision: automatic, no extra port). Delivered
science adds **science credits**, as do completed goals. Credits are the currency for
M7 upgrades.

**Goals [M5]:** the `EventDirector` (future storyteller) tracks a fixed set of sandbox
goals (First contact, Night owl, Surveyor, Trailblazer, Prospector, Collector, Scientist),
each with a credit reward. Checked every 10 ticks; deterministic.

### 3.4 Power-off and solar recovery

When energy reaches 0 the CPU powers off and any action is aborted. If the solar array
is deployed and charging, the rover **cold-boots** (hard reboot) once the battery
reaches 5 % **[M4]**. If the array was stowed, the rover is stuck: the admin console
(`forceCharge`, `forceRepair`, `respawnAtOrigin`) is the escape hatch.

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

### 5.3 Directives (0 Flash lines)

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
| | `SCAN dir -> type dist` | blocks 1 | Ray across layers 1–3 up to sensor range. Returns the first hit's tile ID and distance, or `NONE` and `0`. |
| | `STEP dir [tiles=1]` | blocks per tile | Moves tile by tile; aborts with `ERR_BLOCKED`, `ERR_LOW_POWER` or `ERR_HAZARD` (moved onto a hazard). |
| | `ACT tool [arg]` | tool-defined | Fire the tool in hardpoint `tool` (§3.3.2). |
| | `PEEK slot -> dst` | 1 cycle | Item ID in cargo `slot` (0 = empty); bad slot → `ERR_INVALID`. |
| | `USE slot` | 5 ticks | Consume a cargo item (§3.3.2). |

`@STATUS` is written by every hardware instruction and by arithmetic errors; pure
compute instructions leave it alone.

### 5.5 Constants

* Directions: `NORTH=0`, `EAST=1`, `SOUTH=2`, `WEST=3`.
* Status: `OK=0`, `ERR_INVALID=1`, `ERR_FULL=2`, `ERR_LOW_POWER=3`, `ERR_BLOCKED=4`,
  `ERR_NO_TOOL=5`, `ERR_NO_SIGNAL=6`, `ERR_HAZARD=7`, `ERR_DEPLOYED=8`.
* Tools: `TOOL_0`…`TOOL_3`.
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
| `@HEADLIGHT` | RW | 0/1 | M4 (costs energy, extends night range) |
| `@SENSOR_RANGE` | R | current SCAN range | M4 |
| `@SUN_AZIMUTH`, `@SUN_ELEV`, `@SUN_LIGHT` | R | 0–359, −70..70, 0–100 | M4 |
| `@SOLAR_OPEN` | RW | 0/1 | M4 |
| `@SOLAR_ANGLE` | RW | 0–359 (write = target, read = current) | M4 |
| `@ORBIT_AZIMUTH`, `@SIGNAL_STR` | R | 0–359, 0–100 | M4 |
| `@ANTENNA_ANGLE` | RW | 0–359 (write = target, read = current) | M4 |
| `@TX_DATA` | W | any int | M4 |
| `@CARGO_FREE` | R | free cargo slots | M5 |
| `@SCIENCE_READY` | R | science packets waiting for uplink | M5 |

Writes are clamped to the port's range; angle ports wrap modulo 360.

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
