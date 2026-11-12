# Rover — Game & Language Specification (`v1.3`)

This document supersedes `v1.2` of the architecture/language review. It fixes the
inconsistencies found in review and pins down the numbers the code relies on.
All tunable numbers live in `src/core/balance.ts`; this document lists defaults.

Status markers: **[M1–M3]** implemented in the first milestone, **[later]** designed
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
| Day length | 2400 ticks | 4 min real time at 10 Hz, `1x`. **[later: sun]** |

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
| Cargo | 4 slots | **[later]** |
| Sensor range | 6 tiles | Night range rules **[later]** |

### 3.1 Energy costs (defaults)

| Action | Ticks | Energy |
| :--- | :--- | :--- |
| Idle (CPU powered) | per tick | 1 |
| `STEP` onto `FLAT_SAND` | 3 / tile | 40 / tile |
| `STEP` onto `ROUGH_GRAVEL` | 6 / tile | 120 / tile |
| `STEP` onto `ACID_VENT` | 4 / tile | 60 / tile + 10 hull damage |
| `SCAN` | 1 | 10 |
| Headlight on **[later]** | per tick | 20 |
| Solar charge **[later]** | per tick | up to 60 × sun × alignment |

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

Upload cost **[later, M4]**: `ceil(UPLOAD_BASE + UPLOAD_PER_LINE × lines) × 100 / max(10, @SIGNAL_STR)`.
If the battery cannot pay, the upload is rejected and the old program keeps running.

### 3.4 Power-off and solar recovery

When energy reaches 0 the CPU powers off and any action is aborted. If the solar array
is deployed and charging, the rover **cold-boots** (hard reboot) once the battery
reaches 5 %. If the array was stowed, the rover is stuck: the admin console
(`forceCharge`, `forceRepair`, `respawnAtOrigin`) is the escape hatch.

## 4. World

* Infinite, signed integer coordinates. **`NORTH` = +Y, `EAST` = +X.**
* 16×16 chunks in a sparse `Map<"cx,cy", WorldChunk>`;
  `cx = floor(x / 16)`, `lx = ((x % 16) + 16) % 16`.
* Each chunk: four `Uint16Array(256)` layers, a `Uint8Array(256)` fog mask **[fog later]**,
  `dirty` flag (any modification vs. the generated state), `lastTouched` tick.
* Layers: 0 terrain · 1 obstacles & veins · 2 surface items · 3 actors.
* **Units are authoritative** for their own position; layer 3 is not stored and is
  computed from the `UnitRegistry` when queried.
* Generation is a pure function of `(seed, x, y)` built from integer hashing plus value
  noise, so chunk borders are seamless regardless of generation order. A 5×5 clear
  `FLAT_SAND` landing zone surrounds `(0, 0)`.
* Chunks within a 3×3 radius of any rover stay loaded. Clean (non-dirty) chunks that
  nothing has touched for a while are evicted and regenerated on demand. Dirty chunks
  and fog are never evicted (they are part of the save).
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
| | `ACT tool [arg]` | tool-defined | **[later]** Currently `ERR_NO_TOOL`. |
| | `PEEK slot -> dst` | 1 cycle | **[later]** Reads cargo slot item ID. |
| | `USE slot` | tool-defined | **[later]** |

`@STATUS` is written by every hardware instruction and by arithmetic errors; pure
compute instructions leave it alone.

### 5.5 Constants

* Directions: `NORTH=0`, `EAST=1`, `SOUTH=2`, `WEST=3`.
* Status: `OK=0`, `ERR_INVALID=1`, `ERR_FULL=2`, `ERR_LOW_POWER=3`, `ERR_BLOCKED=4`,
  `ERR_NO_TOOL=5`, `ERR_NO_SIGNAL=6`, `ERR_HAZARD=7`.
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
| `@HEADLIGHT` | RW | 0/1 | M1–M3 (visual; cost later) |
| `@CARGO_FREE`, `@SCIENCE_READY` | R | | later |
| `@SUN_AZIMUTH`, `@SUN_ELEV`, `@SUN_LIGHT` | R | | later |
| `@SOLAR_OPEN`, `@SOLAR_ANGLE` | RW | | later |
| `@ORBIT_AZIMUTH`, `@SIGNAL_STR` | R | | later |
| `@ANTENNA_ANGLE` | RW | | later |
| `@TX_DATA` | W | | later |

Writes are clamped to the port's range.

## 6. Milestones

| | Scope |
| :--- | :--- |
| **M0** | Vite + TS + Vitest scaffold, GitHub Pages workflow. |
| **M1** | Compiler + VM (cycle budget, faults, watchdog), unit tests. |
| **M2** | Registry, chunked world, generator, engine with `STEP`/`SCAN`/energy. |
| **M3** | Three.js wireframe viewport, CodeMirror editor, debugger, speed controls, admin buttons. |
| M4 | Sun, solar, antenna, signal-scaled upload, headlight cost, fog of war, baseline idle script. |
| M5 | Tools, cargo, spectrometer, science, first goals. |
| M6 | Save/load, storyteller events, admin console UI. |
| M7 | Upgrades, chunk pooling, polish. |
