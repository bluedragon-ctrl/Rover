# Roadmap & Progress

Living document. **Update it in every PR** that changes scope or finishes work, so the
next session (human or AI) can continue without re-reading the whole history.

Spec: [`SPEC.md`](SPEC.md) · Workflow: [`../CLAUDE.md`](../CLAUDE.md)

## Status

| Milestone | Scope | Status |
| :--- | :--- | :--- |
| M0 | Vite + TS + Vitest scaffold, GitHub Pages workflow | ✅ done |
| M1 | Rover-ASM compiler + VM (cycle budget, faults, watchdog) | ✅ done |
| M2 | Registry, chunked infinite world, generator, engine (`STEP`/`SCAN`/energy) | ✅ done |
| M3 | Three.js wireframe viewport, CodeMirror editor, debugger, speed controls, admin | ✅ done |
| M4 | Sun, solar, antenna, upload cost, headlight, fog of war, factory firmware | ✅ done |
| M5 | Tools, cargo, spectrometer, science, first goals | ✅ done |
| M6 | Save/load + autosave, storyteller with prerequisites & teaching events, subsystem damage, material repairs, admin console | ✅ done |
| M7 | Upgrades bought with credits, delivered as supply crates, seismic scanner, save v2 | ✅ done |
| **M8** | **Visual overhaul (SPEC §7)** | 🚧 in progress: asset preview, indicator lamps, **game renderer switched to v2**, frame-time HUD + geometry baseline, pan leash, **performance pass** (fog patching, culling, MSAA, merged rover, LOD, adaptive resolution); remaining items (fat lines, zoom range, atmosphere) deferred to the next visual pass |
| M8.1 | Radar `SCAN` vs. light-limited operator view; headlight cone; `@HEADING` | ✅ done |
| Flash bytes | Program size in machine-code bytes instead of lines (SPEC §5.7) | ✅ core done; editor byte gutter awaiting preview approval |
| **M9** | **Downlink, debug log & science imaging (SPEC §3.8)** | ✅ slices 1–6 done (link layer, `LOG`, Console tab; recorder, spectra, Gallery tab; dumps, `BRK`, admin-only debugger; `@POST` display; camera + photos; upgrades, camera modes 3–5, fossil anomalies; save v9); ⏭ next: M10 detailed plan |
| M10 | Firmware + program slot (SPEC §3.9) | planned: design agreed, plan below |
| M11 | User interface review (after M10) | planned |
| M12 | Multiple rovers (after single-rover tuning) | planned |

## Done: Flash measured in bytes

Decided with the owner: program size reflects real machine code (SPEC §5.7) instead of
one Flash line per instruction. Opcode 1 B, register/port 1 B, immediates 1/2/3/5 B by
value (0–15 packed into the operand byte), label references 2 B; label definitions,
`ALIAS`, `CONST` and comments are free. Size does not change cycle costs.

- [x] `ENCODING` in `balance.ts`; `chassis.flashBytes` (Mk-I 128 B; upgrades 192 / 256 B,
      ids `FLASH_48` / `FLASH_64` kept for saves).
- [x] Compiler: `flashUsed` in bytes, `lineBytes` per source line (an estimate on lines
      with errors), overflow error on the first line that does not fit; `instrBytes`,
      `operandBytes`, `immBytes` exported.
- [x] Upload cost per byte (`uploadPerByte` 12 ≈ the old 50 per line).
- [x] UI: `Flash n/128 B` counter, upgrades panel, Reference tab table (generated from
      `ENCODING`).
- [x] Shipped firmware sizes: Factory idle 46 B, Explorer 104 B, Fetch 78 B,
      **Prospector 120/128 B** (the M7 "almost full" lesson still holds).
- [x] Tests: operand sizes, error-line estimates, byte limit + error line, every template
      fits Mk-I; upload-cost and Flash-upgrade tests updated.
- [ ] **Editor byte gutter** (bytes per line next to the line numbers): in the preview
      (`/preview.html?editor=1`, `&program=Explorer` etc.), awaiting screenshot approval;
      then set `showBytes: true` in `src/main.ts`.
- No save format change (chassis stats are rebuilt from upgrade ids).

## Done: M8.1 — Radar vs. operator view, directional headlight

Decided in review: **the rover's `SCAN` is radar** (chassis range, every direction, day and
night, no light needed); **only the player's view is impaired at night**. The operator sees
(maps, and the renderer lights) a 6-tile disc by day; at night the 1-tile ring, plus with
`@HEADLIGHT 1` a forward cone (`1 ≤ forward ≤ 5`, 3 wide for 2 tiles then 5 wide). So at
night the player cannot just look and type `STEP NORTH 5`. SPEC §3.1.1.

- [x] One shared view shape in `src/core/sensors.ts` (`inDisc`, `inCone`, `coneOffsets`);
      engine `viewShape` / `isVisible`; reveal key includes the cone heading.
- [x] `ChunkedWorld.revealTile` / `revealTiles`.
- [x] `SCAN` = radar at `chassis.sensorRange` (no light, does not turn the rover);
      `@SENSOR_RANGE` reports it. Day view is `BALANCE.dayViewRange` (the radar upgrade no
      longer widens the daytime map). Upgrade renamed *Long-range radar* (id `LIDAR_8` kept).
- [x] `@HEADING` port (RW, 5 energy per turn, wraps mod 4) to aim the headlight.
- [x] Shipped firmware unchanged (radar works at night).
- [x] Tests (`tests/headlight.test.ts`): cone shape and rotation, ring without headlight,
      cone reveal per heading, radar at night vs. unmapped walls, `@HEADING`, day disc,
      firmware, save round trip.
- [x] `TileLighting` cone numbers injected from `HEADLIGHT_CONE`; preview and the old
      renderer's ring show the operator view.
- [x] **Radar wave** (preview, awaiting screenshot approval): each `SCAN` sends a red wave
      out to the radar range; tiles flash as the front passes and fade over ~4 tiles. Visual
      only, maps nothing (`TileLighting.uPulses`, `radarFront`; preview `?radar=0.45`).
- No save format change (heading was already saved; the reveal key is derived).

## M8 — Visual overhaul (detailed plan)

**Review workflow:** new visuals go into [`preview.html`](../preview.html) (`npm run dev` →
`/preview.html`) first; the owner approves screenshots; only then they replace the game
renderer. The preview uses the same `VectorFactory` / `TileLighting` / `CameraRig` /
`PostFx` / `RoverRig` modules the game will use. Query params (`sun`, `headlight`,
`solar`, `deploy`, `drill`, `dist`, `pitch`, `yaw`, `fx`, `fy`, `labels`, `crt`; `editor`, `photos`) frame
reproducible screenshots.

Done (preview, approved so far): wireframe-with-dark-fill look; per-tile day/night
lighting shader with dusk grading; bloom; orbit/pan/zoom-to-cursor camera; detailed
rover (three-segment accordion solar wings, solid dish, LED, headlight bar + beam, drill
with sparks, wheels, CPU core); rock walls with strata, flat pebbles, volcano vents, iron
ore mounds (new `mound` shape), buried silicon crystals; **indicator lamps** `@IND1..3`
(already live in the game, see SPEC §3.3.1).

- [x] **Switch the game renderer** to the v2 assets: `ThreeScene` now uses `CameraRig`
      (left-drag pan, right/Ctrl-drag orbit, wheel zoom to cursor, Q/E rotate 90°, V
      angled ↔ top-down, double-click / F follow), `PostFx` bloom (B toggles), `TileLighting`
      (day/dusk grading, night view disc + headlight cone from `engine.viewShape`),
      `buildRoverRig` + `RoverAnimator` (solar wings, dish, CPU core, indicators, wheels,
      drill with sparks), fog + dust like the preview. Compass rotates with camera yaw.
      `uPulses` driven by `SCAN_PULSE` + `engine.sensorRange(u)`. `ChunkPool` builds a
      line + fill mesh per chunk; **unmapped tiles get their real geometry flagged
      `hidden`** (new `hidden` vertex attribute in `LineBatch` / `FillBatch`), discarded by
      the shader except under a radar wave. v1 `drawTile` / `buildRoverMesh` removed.
      Dev builds expose `window.__rover = { engine, scene, rover }` for console/screenshots.
      The world-info line shows fps (details in the frame-time HUD, P).
- [x] Owner playtest of the switched renderer (feel of pan/orbit defaults, start zoom 14,
      bloom strength, dust). Cost: see the geometry baseline below (hidden geometry +14%).

Remaining:


Everything lives in `src/render/` (the renderer only reads the simulation), so gameplay
tests must stay untouched. Do it in small PRs, checking frame time at each step.

- [x] **Frame-time HUD** (P toggles, `?perf=1`, remembered): fps, avg / p95 / worst frame
      ms, CPU ms inside `render()`, draw calls, triangles, lines, chunk meshes, line verts,
      fill tris, chunk rebuilds per frame and their ms, canvas size, bloom (`FrameStats`,
      `PerfHud`). Low CPU ms with a long frame ⇒ GPU-bound.
- [x] **Geometry baseline** (`tests/render-budget.test.ts`, headless, seed 1, 5×5 chunks):
      179k line verts and 72k fill tris of real geometry; with fog of war 204k (the hidden
      geometry is the real tiles, so it only adds the survey crosses, +14%, not ×2 as
      estimated earlier). Budgets: <12k line verts and <4.5k fill tris per chunk. A chunk
      build takes ~4 ms, so rebuilds are now time-budgeted (`buildBudgetMs` 6, at least one
      per frame) instead of a flat 4 per frame (up to ~16 ms hitches while panning).
- [x] **Baseline on real GPUs** (owner, 2026-11-12): tested on a PC, performance is not an
      issue. **Decision:** LOD, fat lines and other optimizations wait for the next visual
      pass; M9 goes first.
- [x] **Pan leash** (owner): the camera focus stays within `PAN_LEASH` = 24 tiles of the
      followed rover (else the first rover); dragging further stops at the edge. Bounds
      what the renderer must build around the rover (`CameraRig.leash`, `tests/camera.test.ts`).
- [x] **Bloom:** `PostFx` (threshold bloom keeps the grid crisp), B toggles it.
- [ ] **Fat lines:** `LineSegments2` + `LineMaterial` for rover, ore, crates and FX;
      width scales with zoom. Keep 1 px for the terrain grid (cost).
- [x] **Performance pass** (2026-11-13, owner-approved list; seed 1, headless Chromium):
      - Chunk builds into typed arrays, compact 24-byte vertices (`col` Uint16×4 = rgb +
        visibility flag, `tile` Int16×2): build ~8.1 → ~1.2 ms, chunk memory −33%.
      - **Fog changes no longer rebuild chunks:** newly mapped tiles get their visibility
        flags patched in place (`ChunkPool.patch`, per-tile vertex ranges). Driving went from
        ~1.3 rebuilds per step (6–17 ms each) to none; only chunks scrolling into view build.
      - Hidden terrain culled per vertex (no fragment `discard`); chunks frustum-culled and
        skipped beyond the fog.
      - Rover: static parts merged per rigid node (`RigMerge`), lamps/@POST in one
        recoloured mesh (`ColorCells`): 88 → ~40 draw calls per rover.
      - Dust and squall animated in shaders; per-frame allocations removed.
      - Look changes: 4× MSAA under bloom (lines were aliased whenever bloom was on), soft
        round dust motes, quarter-resolution bloom (slightly softer), adaptive pixel ratio
        (`AdaptiveResolution`, `?dpr=N` pins it), far-zoom LOD, ~30 fps while paused and idle.
      - Result, zoom 14 / 60: draw calls 153 → 79 / 252 → 133, lines drawn 139k → 67k /
        444k → 104k.
      - Tried and dropped: nearer fog (D) — the visible chunks sit well inside the fog at every
        zoom, so it saved nothing measurable.
- [x] **LOD by zoom (terrain):** beyond camera distance 36 (back below 30) chunks drop corner
      ticks, ripples, pebbles, strata and vent smoke (line verts −47%, fill tris −37%).
      Rover detail levels still open (wheels, hinges, dish ribs).
- [ ] **Symbolic ground tiles (proposal, in preview; owner review pending).** The map is an
      orbital scan read through a legend, not scenery; low 3D symbols say what matters for
      driving (owner: low-poly 3D, rover keeps its detailed model). `preview.html?style=symbolic`
      or the STYLE button; code in `drawTileSym` (`VectorFactory.ts`).
      - Cliff wall → pyramid (height by variant); neighbouring walls join with ridgelines to
        a saddle on the shared edge (`RIDGE` mask), so clusters read as ranges.
      - Rough gravel → 3 flat hatch strokes (was 3 pebble prisms); flat sand → no ripples.
      - Ore deposits sunk into the ground (owner: nothing floats): a dark pit with a lit rim,
        the marker half buried in it — iron a diamond, silicon an upright hex crystal (marker
        differs by shape, not only colour).
      - Acid vent → warning ring, rim and glowing pit. Pickups unchanged.
      - Pyramid faces shaded by direction so they read in the top-down view.
      - Preview patch: 5,981 → 2,627 line segments (−56%), 4,840 → 1,007 triangles (−79%).
      - If approved: switch `ChunkPool` to it (ridge mask needs neighbour lookups across
        chunk edges), drop the far-zoom LOD, tighten the geometry budget test.
- [ ] **Zoom range** 0.15×–8×, zoom to cursor; far zoom switches to a minimap-like style.
- [x] **Camera:** perspective orbit camera, smooth follow, rotate with right-drag; the
      compass rotates with it (done in the renderer switch).
- [ ] **Atmosphere:** day/night colour grading (not just dimming), dust particles,
      animated vents and crates, optional CRT/scanline pass.
- [ ] Keep `VectorFactory.ts` as the single place shapes are defined.

## M9 — Downlink, debug log & science imaging (detailed plan)

Spec: [SPEC §3.8](SPEC.md). Decided with the owner (2026-11-12):

- **Mission control knows only what the rover sent** (plus the uploaded source). The
  live register/port debugger becomes **admin-only**; players use the log, dumps and
  `BRK`. No variable history unless the firmware sent it.
- **One byte-based downlink** (2 B/tick at full signal, ≥ 20 signal) shared by a lossy
  **log FIFO** (32 B) and a reliable **science recorder** (1024 B); log has priority.
- **Frame header** `[kind:1][tag:4][size:2][0]`, log payloads 0/1/2/4 B signed (like
  Flash immediates); tag 15 = system (boot reason, dumps).
- **Energy per transmitting tick** (2), not per byte: bandwidth is the real limit, and a
  misaligned dish costs more energy for the same bytes.
- **`LOG tag [src]`** is a 1-cycle compute instruction (no `@STATUS`), inspired by ARM
  ITM, `defmt` and spacecraft event records: the ground names tags from the program's
  `CONST`s.
- **`@POST`** two-digit hex display on the rover body (free, visible only in view).
- **Science uses memory:** spectrometer → 16 B spectrum; new mast **camera** `SNAP` →
  photos. 16 B photos were too poor (owner review of the POC); **Mk-I camera is
  32×32 at 2 bpp = 256 B**, with upgrade tiers for colour and resolution. Photos are the
  expensive, prized product; spectra the cheap, steady one.

Slices, one PR each, in order. Every slice: tests green, build, SPEC markers updated from
"M9, planned" to "M9", session-log row.

1. [x] **Link layer + `LOG`.** `src/core/downlink.ts`: frame encoder/decoder, `Downlink`
       (log FIFO that drops whole frames, integer byte accumulator, gap count), 2 energy
       per sending tick, nothing below signal 20, runs while faulted, stops when powered
       off. `LOG tag [src]` (new operand kind `k` = compile-time constant; `LOG 15` and
       tags outside 0–14 are errors; the compiler returns a `logTags` dictionary of CONST
       names and lines). Ports `@LOG_FREE` / `@LOG_LOST`. Boot frame `LOG 15 reason` on
       every hard reboot (upload, watchdog, cold boot, admin), which also resets
       `@LOG_LOST`. `chassis.logFifoBytes` 32; `BALANCE.link*`. Engine `received` (last
       200) + `DOWNLINK_FRAME` event. Console tab (`src/ui/ConsolePanel.ts`): decoded
       frames named from `CONST`s with source lines, raw-hex toggle, lost-frame gaps, FIFO
       / lost / signal status. Save v4 + migration. `@TX_DATA` and shipped firmware
       unchanged until slice 2. Tests: `tests/downlink.test.ts` (SPEC encoding examples,
       signed round trip, compile rules and sizes, 1 cycle / no `@STATUS`, FIFO overflow
       and saturation, rate vs signal, energy only while sending, faulted vs powered off,
       boot reasons, ports, save mid-frame == uninterrupted, v3 migration, console text).
2. [x] **Recorder + spectra; retire packet science.** `Downlink` gains the recorder
       (`ProductDesc` descriptors, `recSent`, wrapping `seq`); `pump` sends the log first,
       then the recorder, byte by byte (a log frame may preempt a product; it resumes).
       Spectrometer records a spectrum (`ERR_FULL` keeps the item; credits = the item's
       `science`), `@REC_FREE`, `@SCIENCE_READY` = products waiting, credits on full
       delivery. `@TX_DATA` = `LOG 0` (`@STATUS` OK / `ERR_FULL`); `txEnergy`,
       `txMinSignal`, `packetsSent`, `lastTx` removed. `src/core/imaging.ts`: integer-only
       spectrum generator (material curve × position brightness + position variation +
       sensor noise). Goals: *First contact* = first firmware frame received (boot frames
       don't count, else it completes by itself), *Scientist* = 5 products. Factory
       firmware logs `T_BAT`; Prospector drops its TX loop (Flash freed). Engine `gallery`
       (last 100, partial products update as bytes arrive) + `SCIENCE_DELIVERED` event;
       Gallery tab (`src/ui/GalleryPanel.ts`, SVG bar chart, hatched missing bands, hex).
       Uplink pulse fx now fires when frames arrive (renderer throttles to 1 per 400 ms).
       Save v5: migration credits science points still waiting. Tests in
       `tests/downlink.test.ts` (recorder space and seq wrap, log preemption, ERR_FULL
       keeps the item, in-order delivery and credits, partial gallery entries, spectrum
       shape/determinism, boot frames vs First contact, save mid-product, v4 migration,
       hatch rendering).
3. [x] **Debugger admin-only, dumps, `BRK`.** Debugger panel, current-line highlight and
       *Step instr* behind the Admin tab's *Live debugger* toggle (browser preference).
       `engine.command(u, 'DUMP' | 'DUMP_STACKS' | 'CONTINUE')`: uplink cost
       (`dumpEnergy` 150 scaled by signal), rejected without power/energy or with 4 dumps
       waiting. Dump replies (`F8 kind len payload`, `encodeCpuDump` / `encodeStackDump` /
       `decodeDump`) snapshot the CPU on arrival and go before the log FIFO; received
       frames carry `taken`. `BRK` (1 cycle, compute) → `HALTED`; *Continue* resumes,
       upload reboots, no watchdog, admin stepper stops. Console buttons with cost, dumps
       decoded with source lines. Save v6 (dump queue). Tests in `tests/debug.test.ts`.
4. [x] **`@POST` display.** Preview first (`preview.html`: two italic red seven-segment
       digits with ghost segments on a bezel at the back of the cabin, `?post=`, +1 /
       count-up buttons), owner approved the screenshots (kept on the back), then the game
       renderer (`buildRoverRig({ post })`, `RoverPose.post`, dark while powered off).
       Port `@POST` (0–255, free, no `@STATUS`, survives reboots), `Unit.post`, save v7.
       Tests in `tests/indicators.test.ts`.
5. [x] **Camera + photos.** `SNAP dir [mode]` (hardware op, blocks `snapTicks` 10,
       `snapEnergy` 200; internal `CAMERA` tool with `keepsHeading`: the mast camera does
       not turn the rover); `chassis.cameraModes` (Mk-I `[1, 2]`). Subject (first rover /
       obstacle / item within `snapReach` 2, else a **landscape**, owner request: skyline of
       16 columns over 90° from cliffs/ore up to `horizonRange` 16 tiles, ground from the
       first 4 tiles, sun position, light; `engine.horizonView`, stored as
       `ProductDesc.horizon`, drawn by `horizonScene`; auto-exposure clips the brightest 3 %
       so the sun does not black out the frame) and light
       (`@SUN_LIGHT ≥ 20` or headlight aimed at `dir`) taken when the exposure ends;
       descriptor gains `sx`, `sy`, `lit`. `src/core/photos.ts`: integer-only generator,
       POC scenes ported to Q10 fixed point (waves from `SIN1000`, `Math.sqrt` only via
       `isqrt`) plus scenes for repair kits, supply crates and rovers; per-subject-tile
       seed, sensor noise per exposure, dark frames = dim signal + strong noise; auto-exposure;
       all five formats (grey, dither, 16-colour palette, 64×64, RGB332) encode and decode,
       so slice 6 only adds the upgrades. Credits decided on delivery (`photoCredits` 1,
       `photoFirstBonus` 5, dark 0; `engine.photoSubjects`). Stats `photosTaken`,
       `photosDelivered`; goal *Photographer* (3 lit photos, 15 cr); *Scientist* counts
       photos too. Gallery: crisp 128 px photo, missing rows hatched, subject / dark /
       format, hex shortened. Reference tab, `@REC_FREE` text. Save v8 + migration.
       Tests in `tests/photos.test.ts`. The tool FX uses the generic white tool effect (no
       new 3D visual; a camera flash would go through the preview first).
6. [x] **Upgrades + anomalies.** Step 1: six catalogue additions (SPEC §3.8.6: `REC_2K`,
       `REC_4K`, `LINK_3`, `TRACE_64`, `CAM_COLOUR`, `CAM_HIRES`, `CAM_RGB`), new
       `chassis.linkBytesPerTick` drives the link, prerequisites became a list (the colour
       sensor needs two), shop header shows the new stats. Step 2: anomalies decided with
       the owner: **fossil** shells (cliff strata; pyritized fossil instead of a sample),
       integer-only spiral in `photos.ts` (`iangle`, Archimedean whorls, sutures, ribs);
       preview `preview.html?anomaly=1` renders the game generator through all modes; the
       owner chose the **subtle** look (a pale disc in 32×32 grey, a clear spiral in hi-res
       and colour, so the camera upgrades matter). 1 in 40 cliff walls / samples, seeded per
       tile (`isAnomaly`), only as the photo's subject; `ProductDesc.anomaly` is ground truth
       the gallery never shows. *Flag anomaly* on complete, lit photos (`engine.flagAnomaly`):
       +20 once per tile ("already catalogued" afterwards pays nothing), wrong −5 never below
       0, one flag per photo. Goal *Anomaly hunter* (1 correct flag, 30 cr). Save v9
       (`anomalyTiles`, `stats.anomaliesFound`, gallery `flag`). Tests in
       `tests/m9-upgrades.test.ts` and `tests/anomalies.test.ts`.

Later (backlog): `@REC_PEEK` so firmware can inspect recorder bytes (on-board triage,
compression); bit errors at low signal and a checksum lesson; panorama `SNAP` of the
horizon; unknown minerals identified only by spectrum. Rare local fauna and flora (see Backlog) reuse this pipeline.

## M10 — Firmware + program slot (outline)

Spec: [SPEC §3.9](SPEC.md). Decided with the owner (2026-11-12), after M9:

- Two pieces of code on one CPU: **firmware** (housekeeping, advanced players edit it)
  and a **program** (the player's task; beginners only write programs).
- **Shared flash, separate registers / stacks / IP** per slot.
- **`RUN ticks`** gives the program a time slice and resumes it next time; program ends
  with `END value`; `@PROG_STATE` / `@PROG_RESULT`; program faults return to the
  firmware instead of a watchdog reboot; `BRK` halts only the program.
- **Default firmware = small core + optional comfort blocks** (status lamps for the
  program state, `@POST` codes, heartbeat), each marked with its flash cost so
  experienced players can strip them to free memory for programs.
- Program upload is cheap (program bytes only) and does not reboot; Console *Run again*.

To settle when the detailed plan is written: compiler/flash layout of the two slots, which comfort blocks ship and their byte cost
(the core must leave a useful program budget on Mk-I 128 B),
dumps per slot, save format, how shipped templates split, migration of old saves (old
firmware becomes the firmware slot, no program).

## M11 — User interface review (after M10)

Owner request: with firmware, program, console, gallery, dumps and upgrades the side
panel has grown tab by tab. Review the whole UI once M10 lands: information
architecture (what lives where), editor for two code slots, telemetry vs admin views,
what the top bar shows, discoverability for beginners. Proposals with screenshots first.

## Resolved decisions (M7)

1. Upgrades are **picked up**: a supply crate lands near the rover; the grabber installs it.
2. Installed **immediately** on pickup (including Flash/register limits).
3. **More rovers later**, once the single-rover game is tuned (now M12).
4. Prospector stays at 31/32 lines without squall handling: **a lesson** (Flash 48 fixes it).
   Now 120/128 bytes; the Flash 192 B upgrade fixes it.

## Resolved decisions (M6)

1. Saves: **one autosave** in the browser + file export/import.
2. Squalls: **damage individual systems**: light hull wear (more while driving), dish wear,
   heavy damage to an open solar array. Subsystem health scales charging / signal.
3. Rewards: fine for now, tune later.
4. Events have **prerequisites** (goals, previously seen events, sol); gentle **teaching**
   versions are guaranteed first (`src/core/events.ts`).
5. **Repairs consume materials** from cargo: kits fix anything; iron ore patches hull and
   dish, silicon ore patches solar cells. New goal *Field engineer*.

## Resolved decisions (M5)

1. Science delivery: automatic with every successful `@TX_DATA` write.
2. Grabber reach: adjacent tile only.
3. Science credits: currency for M7 upgrades.
4. Explorer firmware dish: unchanged.

## Open decisions

M9 (tune in playtests, defaults in SPEC §3.8): link rate 2 B/tick and min signal 20;
log FIFO 32 B / recorder 1024 B; transmitter 2 energy/tick; `SNAP` 10 ticks / 200
energy; photo credits (1, +5 first of a subject) and anomaly rate/rewards; upgrade
prices (anomalies: 1 in 40, +20 / −5). Is 128 ticks per Mk-I photo at full signal right against a ~300-tick orbiter
window with a fixed dish?


1. ~~M8 look~~ → wireframe with dark opaque fills (hidden-line look), approved in preview.
2. Bloom on by default with a toggle (as in the preview) — confirm once measured in-game.
3. Upgrade prices: fine for now? (A Prospector run earns ~75 credits in 1.5 sols; the
   whole catalogue costs 1195 since M9 slice 6.)
4. ~~M8.1 SCAN vs. cone~~ → `SCAN` is radar (ignores light, does not turn); the cone only
   limits what the **player** sees at night. `@HEADING` aims the headlight (5 energy).
5. Explorer firmware toggles `@HEADLIGHT` 0→1 every loop at night (mapping can miss the
   cone on a tick boundary). Harmless now; fix when Flash allows.
6. ~~Radar blips~~ → every `SCAN` shows a brief red radar wave around the rover (visual
   only). Turn cost 5 energy stays until playtests.

## Backlog / ideas

- **Local rare fauna and flora (planned, owner request 2026-11-13).** Rare native life to
  discover, so the planet gives the player much more to explore than rocks and fossils.
  Builds on the M9 science pipeline (photos, spectra, gallery flagging, first-of-a-kind
  credits). Ideas to settle when it is planned: flora as rare tiles tied to habitats (lichen
  mats near acid vents, crystal-like growths on cliffs, night-blooming patches that are only
  visible or active in the dark); fauna as small slow-moving creatures (seeded, deterministic
  movement through `src/core/`, no `Math.random`) that wander, hide from the headlight or
  come out at dusk, so finding them means planning when and where to look; a species
  catalogue in mission control (discovered / photographed / analyzed, with rarity and
  biome), identified from photos and spectra (biosignature bands); rewards per new species,
  with goals for catalogue milestones; rules for not harming life (the drill or grabber on a
  living tile costs credits or reputation). Visuals (3D markers, photo scenes) go through
  the preview first, as always.

- **Orbital pre-survey + sky (idea, owner liked it 2026-11-13; after symbolic tiles).** The
  view is a satellite scan, so unexplored tiles could show coarse orbital data (e.g. faint
  mountain outlines only, no ore or items) while the rover's sensors fill in the detail.
  Changes what the player knows before exploring (fog rules in `src/core/`), so it is a
  gameplay decision; pair it with a visible sky (horizon, orbiting satellite passes).

- More storyteller events using the catalogue: dust devils that push the rover, solar
  flares that scramble the uplink, ore-rich meteor falls (reward events), distress beacon
  missions. Teaching variants first.
- Upgrade ideas: second tool modules for `TOOL_3` (field welder, fabricator), solar
  tracker automation, larger stacks.
- Crafting: combine ores into a `REPAIR_KIT` (needs a fabricator module, M7 `TOOL_3`?).

- Breakpoints in the editor gutter; "run to cursor".
- Multiple rovers (engine already supports units; UI is single-rover).
- Autosave in `localStorage` (M6).
- Minimap of explored area.
- Mobile layout.
- Upload-cost preview that accounts for the dish slewing during the upload.

## Session log

| Date | PR / branch | Summary |
| :--- | :--- | :--- |
| 2026-11-12 | `ccr-fb6a40ee-nae64a` | M0–M4 implemented; spec v1.3; M8 visual roadmap added. Branch later renamed to `main`. |
| 2026-11-12 | PR #2 (merged) | M5: tools, cargo, spectrometer, science credits, goals, Prospector template. |
| 2026-11-12 | PR #3 | M6: save/load + autosave, storyteller events, subsystem damage, admin console; then event prerequisites + teaching events and material-consuming repairs (review feedback). |
| 2026-11-12 | (next PR) | M7: upgrades via supply crates, seismic scanner, Fetch template, save v2 + migration. |
| 2026-11-12 | `ccr-685ffa2c-m6av8z` | M8 asset preview page (v2 vector assets, tile lighting, bloom, orbit camera, accordion solar wings, volcano vents, ore mounds, buried crystals); indicator lamps `@IND1..3` (save v3); M8.1 directional headlight planned. |
| 2026-11-12 | `ccr-4522f0b5-0m8b66` | M8.1: `SCAN` is radar (day and night); the player's view needs light (night ring + headlight cone, shared `sensors.ts`, TileLighting); `@HEADING` port; Long-range radar upgrade. |
| 2026-11-12 | `ccr-27c44841-89sznb` | Flash measured in machine-code bytes (SPEC §5.7): encoding table, 128/192/256 B, upload cost per byte, Reference tab; editor byte gutter in preview. |
| 2026-11-12 | `ccr-31b53af7-npq5g8` | M9 designed (SPEC §3.8 v1.5): byte downlink, `LOG` debug channel, admin-only debugger, dumps/`BRK`, `@POST`, science recorder, spectra and camera photos with upgrade tiers; photo POC `preview.html?photos=1`; multiple rovers renumbered to M10. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` | M8: game renderer switched to the v2 assets (CameraRig, PostFx bloom, TileLighting, rover rig + animator, dust/fog); radar wave outlines unmapped terrain via hidden chunk geometry; compass rotates with the camera; Q/E/B keys; v1 shapes removed. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (2) | M8: frame-time HUD (P, `?perf=1`: frame ms avg/p95/max, render CPU ms, draw calls, geometry counts); headless geometry budget test (179k/204k line verts for 25 chunks, hidden geometry +14%); chunk rebuilds time-budgeted. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (3) | M8: pan leash, camera focus stays within 24 tiles of the rover (owner request). |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (4) | M9 slice 1: byte downlink with lossy log FIFO, `LOG tag [src]`, `@LOG_FREE` / `@LOG_LOST`, boot frames, Console tab with CONST-named tags, save v4. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (5) | M9 slice 2: science recorder, spectra (`imaging.ts`), `@REC_FREE`, `@TX_DATA` = `LOG 0`, goals on frames/products, firmware updated, Gallery tab, save v5. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (6) | M9 slice 3: uplinked Dump / Dump stacks / Continue, dump frames ahead of the log, `BRK` and `HALTED`, live debugger admin-only, save v6. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (6b) | Design: firmware + program slot agreed as M10 (SPEC §3.9), UI review as M11, multiple rovers renumbered to M12. |
| 2026-11-12 | `ccr-a25966c0-1wr43t` (7) | M9 slice 4: `@POST` two-digit hex display (preview reviewed, then game), port, save v7; M10/M11 design docs from PR #12 that missed the merge. |
| 2026-11-13 | `ccr-2c7af876-8dzljn` | M9 slice 5: mast camera `SNAP dir [mode]`, integer-only photo generator (all 5 formats), light and subject rules, partial photos in the gallery, first-of-a-kind credits, goal *Photographer*, save v8. |
| 2026-11-13 | `ccr-2c7af876-8dzljn` (2) | M9 slice 5: landscape photos when nothing is within reach (ridges from real cliffs and ore, ground, sun, night sky with headlight foreground). |
| 2026-11-13 | `ccr-1e08ca42-e1n32b` | M9 slice 6: downlink/camera upgrades (recorder 2/4 KB, amplifier, trace buffer, camera modes 3–5), fossil anomalies (preview reviewed, subtle look), gallery flagging, goal *Anomaly hunter*, save v9. M9 complete. |
| 2026-11-13 | `ccr-1e08ca42-e1n32b` (2) | Docs: rare local fauna and flora noted as planned future exploration content (Backlog). |
| 2026-11-13 | `ccr-2bb4c6cf-qz99l5` | M8 performance pass: compact chunk vertices, in-place fog patching, vertex-shader culling, frustum culling, MSAA under bloom, merged rover rig, shader dust/squall, quarter-res bloom, adaptive pixel ratio, far-zoom LOD, idle throttle. |
| 2026-11-13 | `ccr-2bb4c6cf-qz99l5` (2) | Proposal in preview: symbolic ground tiles (pyramids with ridgelines, hatched gravel, ore markers, vent rings), `?style=symbolic`; orbital pre-survey idea in Backlog. |
