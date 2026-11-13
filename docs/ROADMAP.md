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
| **M8** | **Visual overhaul (SPEC §7)** | 🚧 in progress: asset preview, indicator lamps, **game renderer switched to v2**, frame-time HUD + geometry baseline, pan leash, **performance pass** (fog patching, culling, MSAA, merged rover, adaptive resolution), **symbolic ground tiles**; remaining items (fat lines, zoom range, atmosphere) deferred to the next visual pass |
| M8.1 | Radar `SCAN` vs. light-limited operator view; headlight cone; `@HEADING` | ✅ done |
| Flash bytes | Program size in machine-code bytes instead of lines (SPEC §5.7) | ✅ done; the byte gutter became the M10 listing pane |
| **M9** | **Downlink, debug log & science imaging (SPEC §3.8)** | ✅ slices 1–6 done (link layer, `LOG`, Console tab; recorder, spectra, Gallery tab; dumps, `BRK`, admin-only debugger; `@POST` display; camera + photos; upgrades, camera modes 3–5, fossil anomalies; save v9) |
| **M10** | **Firmware + program slot (SPEC §3.9)** | 🚧 slice 1 (core, save v10) done; slice 2 (machine code + byte addresses, save v11, Code tab / Console redesign, listing pane) in review |
| M11 | User interface review (after M10) | 🚧 Comms tab, Code tab dump box, Reference → Radio, Mission events: default since 2026-11-13 (save v13); `BRK` reports itself |
| M12 | Image memory: `SNAP` → `LDB` / `STB` → `SEND` (SPEC §3.8.7, guide [`IMAGE_MEMORY.md`](IMAGE_MEMORY.md)) | 🚧 slice 0 (bit instructions, extended opcodes) and slice 1 (image memory in the core, save v14) done; slice 2 (templates, Reference → Image, Gallery labels) next |

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
- [x] ~~Editor byte gutter~~: superseded by the machine-code listing pane (M10 slice 2,
      SPEC §5.7.1); the gutter was removed.
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
- [x] ~~**LOD by zoom (terrain)**~~: removed with the symbolic tiles (nothing small left to
      drop). Rover detail levels still open (wheels, hinges, dish ribs).
- [x] **Symbolic ground tiles (owner-approved 2026-11-13, in the game).** The map is an
      orbital scan read through a legend, not scenery; low 3D symbols say what matters for
      driving (owner: low-poly 3D, rover keeps its detailed model). `drawTileVec`
      (`VectorFactory.ts`), reviewed in `preview.html` first.
      - Cliff wall → pyramid (height by variant); neighbouring walls join with ridgelines to
        a saddle on the shared edge (`RIDGE` mask), so clusters read as ranges.
      - Rough gravel → 3 flat hatch strokes (was 3 pebble prisms); flat sand → no ripples.
      - Ore deposits sunk into the ground (owner: nothing floats): a dark pit with a lit rim,
        the marker half buried in it — iron a diamond, silicon an upright hex crystal (marker
        differs by shape, not only colour).
      - Acid vent → warning ring, rim and glowing pit. Pickups unchanged.
      - Pyramid faces shaded by direction so they read in the top-down view.
      - Ridges across chunk edges: `ChunkPool.ridgeMask` reads the neighbour chunk if loaded,
        else the generator (walls never change), so a chunk loading next door needs no
        rebuild (`tests/render-budget.test.ts`).
      - A mapped cliff draws its ridge toward an unmapped cliff next door: kept on purpose as
        a hint that the range continues (owner: fits the orbital scan).
      - Seed 1, 5×5 chunks: line verts 204k → 102k, fill tris 72k → 21k (budget test
        tightened); far-zoom LOD removed.
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

## M10 — Firmware + program slot (detailed plan)

Spec: [SPEC §3.9](SPEC.md). Outline decided with the owner on 2026-11-12, details on
2026-11-13:

- **Mk-I flash 256 B** (owner: a nice number, room for player programs *and* a standard
  firmware with comfort features). Flash upgrades become 384 / 512 B (ids `FLASH_48` /
  `FLASH_64` kept, prices unchanged). Measured before the change: firmware core + squall
  guard 61 B, comfort blocks 18 B, programs Explorer 57 / Fetch 72 / Prospector 79 B.
  None of them fit in 128 B with the comfort blocks.
- **Two separate sources**, compiled separately (own labels / `ALIAS` / `CONST`); flash
  check on the sum; slot rules: `RUN` and `@PROG_STATE` writes firmware-only, `END`
  program-only.
- **Writable `@PROG_STATE`**: firmware writes `PROG_NONE` to acknowledge, `PROG_READY` to
  restart. No extra states.
- **Dumps per slot**: Console Firmware / Program switch; program dumps are kinds 3/4 with
  `@PROG_STATE` in the state byte; *Continue* follows the switch.
- Proposed and adopted for the slices below (owner may still veto): `RUN` is a hardware
  instruction (ends the tick; `ERR_INVALID` when nothing is ready), control changes hands
  only at tick boundaries (deterministic, simple to save); a hard reboot leaves the program
  `PROG_READY` (task restarts as before M10); program upload base 200 instead of 500;
  merged Console tag dictionary.

### Slice 1 — core ✅
- [x] `balance.ts`: Mk-I 256 B, upgrades 384 / 512 B, `programUploadBase` 200.
- [x] Compiler: `RUN v`, `END [v]`, `slot` option and flash budget (other slot's bytes),
      slot rules, `PROG_*` constants, ports `@PROG_STATE` (RW) / `@PROG_RESULT` (R).
- [x] VM/engine: second context (`unit.prog`), `unit.cpu` = the context that runs now
      (actions, `@STATUS`), slices, `END`, program faults and `BRK` without watchdog,
      `hardReboot` resets both, `uploadProgram`, `RUN_AGAIN` command, dumps and
      *Continue* per slot (kinds 3/4, `DecodedDump.slot`).
- [x] `DEFAULT_FIRMWARE` 136 B (core 93 B + 7 comfort blocks 43 B, costs checked by a
      test) and `PROGRAM_TEMPLATES`: First steps 20 B (new, teaches `END`), Explorer 46,
      Prospector 79, Fetch 72 (now `END 1` / `END 0`). Old firmware templates and the
      factory firmware stay in the game until slice 2, so play is unchanged.
- [x] Save v10 (program source + context, `@PROG_STATE`, result, slice) + migration.
- [x] Tests `tests/m10.test.ts` (20): slot rules, shared flash, tick boundaries, actions
      finishing first, separate `@STATUS`, `END`/acknowledge/restart, fault and `BRK`
      isolation, reboots and power loss, uploads, dumps, default firmware + programs,
      save round-trip mid-slice, v9 migration. Reference tab notes for `RUN` / `END`.

### Slice 2 — UI + machine code (in review)
Owner (2026-11-13, during the slice): "do not be afraid of major menu/console changes";
the Code tab and Console were redesigned rather than extended.

- [x] New rovers ship `DEFAULT_FIRMWARE` (no program; the Program slot shows *First
      steps* as an unsent draft); Factory idle retired (kept for tests only).
- [x] Code tab (`src/ui/CodeWorkspace.ts`): Program (default) / Firmware (advanced)
      switch with one editor each (own undo), *Upload program* / *Upload firmware &
      reboot*, *Compile*, flash bar `firmware + program = n / 256 B`, state (`✓ on the
      rover` / `● not uploaded` / errors), templates split into programs and firmware
      (`FIRMWARE_TEMPLATES`: Default firmware + the all-in-one examples), warnings when the
      firmware (draft, or on the rover while editing the program) has no `RUN`. Side panel
      resizable (drag its left edge; browser preference).
- [x] Console: Uplink box (slot switch for Dump / Dump stacks / Continue, *Run again*) and
      Downlink box (filters All / Log / Dumps / System, raw hex), help folded away; merged
      tag dictionary (`T_BAT|T_X`, lines per slot); program dumps decoded with `prog:`
      addresses; FW / PROG badges.
- [x] Reference tab: `RUN`, `END`, `@PROG_*` render; intro on the two slots; opcode and
      port number columns and the operand byte layout.
- [x] **Machine code** (SPEC §5.7.1): `src/core/vm/isa.ts` (opcode table, operand modes,
      encoder, decoder), `PORT_CODES`; compiler emits `program.code`; labels, `lineToIp`,
      IPs and return addresses are byte addresses in the VM, dumps, call stack and
      debugger; save v11 converts v10 IPs. Tests `tests/machine-code.test.ts` (decoder
      round-trip over every shipped program, encoding examples, VM, migration, listing).
- [x] Listing pane (`src/ui/listing.ts` + Code tab): address | hex | source, in sync while
      typing, click a row → line, cursor and debugger line highlighted, per-slot range and
      totals. Reviewed in `preview.html?editor=1` (with the Console, on a live engine) and
      approved by the owner; on by default in the game (`?listing=0` hides it). Replaces
      the byte gutter.
- [x] Admin debugger follows the Code tab's slot (program context, `@PROG_STATE`, addresses).
- [x] Owner review: listing approved (2026-11-13) and enabled in the game by default.

**Decisions taken in slice 2 (owner may veto):**
1. Optional operands are counted in the opcode byte's top 3 bits (`STEP 1 2` = `34 01 02`):
   without it the decoder cannot tell a short immediate / register byte from the next
   opcode, and sizes had to stay as before. Costs: at most 31 instructions, `CALL` ≤ 7 args.
2. Port numbers = the order of `PORTS` at the time of the change (`@BAT` 0 … `@HEADLIGHT` 41).
3. Flash bar: the edited slot counts its draft, the other slot what is on the rover (that
   is what the upload checks).
4. The Console's slot switch is independent of the Code tab's slot and defaults to Program.

### Later / open
- Tune `SLICE` and charge thresholds in playtests.
- Goals that teach the split (first program `END`, first stripped firmware block?).

## M11 — User interface review (after M10)

Owner request: with firmware, program, console, gallery, dumps and upgrades the side
panel has grown tab by tab. Review the whole UI once M10 lands: information
architecture (what lives where), editor for two code slots, telemetry vs admin views,
what the top bar shows, discoverability for beginners. Proposals with screenshots first.

- [x] ~~Console redesign proposal behind `?console=2`~~: owner (2026-11-13) still found the
      three streams (Mission log, uplink, downlink) confusing; superseded by the next item
      and removed.
- [x] **Comms reorganisation** (owner agreed with the analysis; "the player needs to
      understand dump: what is copied, in which direction"). Organised by the player's
      question instead of by link direction (SPEC §3.9.3):
      - *What is my code doing?* → Code tab **Dump program / firmware state**
        (`src/ui/InspectPanel.ts`): *▲ Dump registers / ▲ Dump stacks*, flow line
        *▲ you ask → the rover dumps its state at that moment → ▼ the dump comes down*,
        newest dump as a card (registers named by `ALIAS`) with its age and a waiting line,
        ◆ mark in the listing, *Resume after BRK*, *Restart*. Follows the Code tab's slot
        (decision 4 of slice 2 retired). Owner: keep the word "dump" (it is the real term),
        but say it is one slot's CPU state, not the whole rover.
      - *What passed between us and the rover?* → **Comms** tab (`src/ui/CommsPanel.ts`,
        renamed Console): radio-link box and one ▲ sent / ▼ received timeline with
        request → dump status, merged LOG repeats, dumps, system, science, lost. Dumps are
        shown byte by byte with a `; comment` per field (`00 00 00 FF  r1 seen  255`);
        *Decode bytes* does the same for LOG / system messages.
      - *What does each byte mean?* → **Reference → Radio** sub-tab: up/down, header byte,
        numbers (byte order, two's complement), every frame type as a decoded example from
        the same decoder (`frameFields` in `src/ui/comms.ts`).
      - *What is happening in the world?* → **Mission events** strip: receipts for sent
        things left to Comms (`LOG` event `category`).
      - Core: `engine.sent` (last 100 commands and uploads, saved, **save v13**), `LOG`
        categories, compiler `regNames` (`ALIAS` names); shared non-DOM helpers in
        `src/ui/comms.ts`. Tests `tests/comms.test.ts`.
      - **Default in the game** (owner, 2026-11-13): the `?comms=1` flag, the Console tab and
        `ConsolePanel.ts` are gone; review page `preview.html?editor=1`.
- [x] Clarity pass (owner picked items 1–7 of the suggestions): not-running dumps, value
      comments for state / `@STATUS`, source links (Comms → Code tab), waiting estimate,
      foldable dump box, rejected sends in Comms, and **`BRK` sends a register dump by
      itself** (SPEC §3.8.4, rules change approved). Tests in `tests/comms.test.ts`.
- [ ] Open suggestions: a teaching goal ("dump your program's registers"); tab bar too wide
      (merge Goals + Upgrades into a *Mission* tab?).
- [ ] Phase 2 (rules decision for the owner): mission control knows the rover only from what
      it received: program faults and `BRK` hits as `SYS` frames, `CPU FAULT` / watchdog /
      battery alarms replaced by a ground-side "no contact for N ticks". Harder game; add a
      teaching event first.
- [ ] Known: the tab bar is wider than the default side panel (the Admin tab is cut off).

## M12 — Image memory (planned)

Owner idea (2026-11-13): let advanced players work with picture memory themselves (their own
pictures, changed photos), reflecting real techniques, but keep the model simple:
**take a picture → change it → send it**, every byte addressable. Rules in SPEC §3.8.7; the
player guide [`IMAGE_MEMORY.md`](IMAGE_MEMORY.md) explains the memory layout and has six
worked examples (line, test pattern, negative, stamp, plot, memory map). The examples were
run against a prototype of the rules: pictures, cycle counts and Flash sizes are measured
(all fit beside the default firmware; `plot` is the largest at 95 of 108 B).

Decided in the design:
- **One image memory, four instructions** (`SNAP`, `LDB`, `STB`, `SEND`), no control
  registers: the instructions are the control. `PEEK` stays the cargo instruction
  (names are case-insensitive), so the memory ops are `LDB` / `STB`.
- The **recorder (mass memory) is not addressable**: a product changed while the
  transmitter is half-way through it would arrive mixed. Editing happens before `SEND`.
- **Credits come from the capture, not from the bytes** (first `SEND` after a `SNAP`,
  same type); a provenance level (raw / edited / drawn) travels in the frame header.
- Image memory is **usable as RAM** (example 6): a deliberate power step for advanced
  players; `SNAP` overwrites it.
- `SNAP` without `SEND` no longer delivers anything: a break for players' own programs
  (no shipped program uses `SNAP`). The compiler warns about it.

Slices:
0. [x] **Bit instructions** (owner, 2026-11-13): `AND`, `OR`, `SHL`, `SHR` (1 cycle,
       compute, no `@STATUS`; shift counts clamped to 0–32, `SHR` logical). The 5-bit opcode
       field had only 1D–1F left, so **1F became an extension prefix** (2-byte opcodes
       `1F 01`–`1F 04`, like Z80 / x86 prefixes); 1D / 1E stay one byte, reserved for
       `LDB` / `STB`; `SEND` will be `1F 05`. Reference: *Bits* group, hex column shows
       `1F 01`, Basics → Machine code explains the prefix. Guide: byte recipes (address,
       read, mask, clear with `OR` + `SUB`, set), `plot` 104 → 95 B and 27 % faster,
       `put16` with `AND 0xFF` / `SHR 8`. Tests in `tests/vm.test.ts`,
       `tests/machine-code.test.ts`. No save change (source is recompiled on load; old
       programs encode as before).
1. [x] **Core.** `imageBytes(chassis)` (largest installed camera mode; `Unit.imageMemory()`
       grows it after an upgrade, keeping its contents); `Unit.img`, `capture`, `snapMode`,
       `imgEdited`; cleared at power-off, kept across reboots. `SNAP` (`capturePhoto`) fills
       image memory at the end of the exposure through the same `productPayload` that
       regenerates raw products, and keeps the capture with its noise seed; no more
       `ERR_FULL` on `SNAP`. `LDB` 1D / `STB` 1E (compute, through `VmHost.load` /
       `store`), `SEND` `1F 05` (hardware, 1 tick, `BALANCE.sendTicks`, no energy).
       Provenance `Level` in bits 2–1 of the science header (`scienceHeader(type, level)`,
       `headerLevel`); edited and drawn products carry `data` (hex), captured ones keep
       `noise`. Credits and *Photographer* only for captured photos; drawn pictures cannot
       be flagged. **Save v14** (`image`: memory as hex, capture, mode, edited) + v13
       migration. Minimal UI so nothing reads wrong: Gallery shows *drawn picture* /
       *edited* from the received header byte and no flag button on drawings; Reference
       notes for `SNAP` / `LDB` / `STB` / `SEND` (*Image memory* group), Radio header row,
       camera tool text, *Photographer* text. Comms needed nothing (science frames reach it
       as gallery rows). Tests `tests/image-memory.test.ts`: encoding, wrap and `& 255`, no
       `@STATUS`, drawn / raw / edited `SEND`s, credits once per capture, `SEND` errors and
       timing, reboot / power-off / upgrade growth, save mid-processing at four points ==
       uninterrupted, v13 migration, and **the six guide examples run from the Markdown**
       (Flash sizes = the guide's table, pictures checked); camera tests updated to
       `SNAP` + `SEND`.
2. [ ] **Examples and teaching.** The six examples from the guide as program templates
       (compiled and run in tests: assert the pictures); Reference → **Image** sub-tab
       (from the guide: diagram, rows and addresses, bits in a byte, modes table); Gallery
       labels *raw / edited / drawn* and a hex view per photo; compiler warning "`SNAP`
       without `SEND`"; Reference `SNAP` note updated.
3. [ ] **Goals.** A teaching goal (*Darkroom*: deliver an edited photo) and maybe
       *Postcard home* (a drawn picture). Rewards to decide.

Open (decide during slice 1 or in playtests):
- ~~`plot` needs 103 B on Mk-I: bit instructions?~~ → added (slice 0). Still open: `XOR` /
  `NOT` if clearing bits with `OR` + `SUB` proves too obscure.
- `SEND` energy (0 now: the transmitter pays per byte) and whether drawn pictures earn
  anything beyond goals.
- Later techniques on top: deleting products from the recorder (triage), holding the
  transmitter, hardware crop / thumbnails, compressed formats (`SEND type len`), stacking
  night photos.

## Resolved decisions (M7)

1. Upgrades are **picked up**: a supply crate lands near the rover; the grabber installs it.
2. Installed **immediately** on pickup (including Flash/register limits).
3. ~~More rovers later~~ → **dropped** (owner, 2026-11-13): one rover is plenty of work. The
   engine keeps its unit registry, but no multi-rover milestone or UI is planned.
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
| 2026-11-13 | `ccr-d9e2f47d-6jnxk7` | M10 detailed plan with the owner (Mk-I 256 B, two sources, writable `@PROG_STATE`, dumps per slot); slice 1 core: `RUN`/`END`, program context and slices, program upload, Run again, per-slot dumps, default firmware 136 B + 4 programs, save v10. |
| 2026-11-13 | `ccr-2bb4c6cf-qz99l5` | M8 performance pass: compact chunk vertices, in-place fog patching, vertex-shader culling, frustum culling, MSAA under bloom, merged rover rig, shader dust/squall, quarter-res bloom, adaptive pixel ratio, far-zoom LOD, idle throttle. |
| 2026-11-13 | `ccr-2bb4c6cf-qz99l5` (2) | Proposal in preview: symbolic ground tiles (pyramids with ridgelines, hatched gravel, ore markers, vent rings), `?style=symbolic`; orbital pre-survey idea in Backlog. |
| 2026-11-13 | `ccr-2bb4c6cf-qz99l5` (3) | Symbolic ground tiles approved and switched on in the game (ore sunk into pits, no floating markers); cross-chunk ridges, far-zoom LOD removed, geometry budget halved. |
| 2026-11-13 | `m10-slice2` | M10 slice 2: machine code (opcode/port tables, encoder/decoder, byte-address IPs, save v11), Code tab redesign (Program/Firmware slots, Upload program, Compile, flash bar, no-`RUN` warning), Console redesign (slot switch, Run again, merged tags, program dumps), Reference machine-code columns, listing pane in preview review; new rovers ship the default firmware. |
| 2026-11-13 | `m10-slice2` (2) | Listing pane approved by the owner; enabled in the game by default (`?listing=0` hides it). |
| 2026-11-13 | `claude/charming-hawking-a1szwz` | Status beacon removed (`@LIGHT_COLOR` / `@LIGHT_BLINK`, LED crystal on the rover): the three roof lamps `@IND1..3` are the only status lights; shipped firmware uses them (1 activity, 2 charging, 3 uplink; default firmware 148 B with a new uplink-lamp comfort block); save v12 rewrites old code onto the lamps; port numbers 33–34 retired. *Compile* button removed from the Code tab (the live listing and flash bar already show its result). |
| 2026-11-13 | `claude/charming-hawking-a1szwz` (2) | M11 start: Console redesign proposal behind `?console=2` (sections with **?** help hints, Mission log label, merged repeats, dump cards, bytes on request, auto-follow fix). |
| 2026-11-13 | `claude/modest-bell-w0qqbq` | Reference tab split into sub-tabs (Basics, Instructions, Ports, Tools, Registry) with grouped sections and a row filter; Registry lists tiles by layer (costs, tools, science, repairs) and constants by family. Unlisted opcodes/ports fall into "Other", so they still appear automatically. |
| 2026-11-13 | `claude/modest-bell-w0qqbq` (2) | Reference: Registry sub-tab renamed **Constants** (Tiles part, then Other constants); new **Registers** section in Basics (count per chassis, register-file upgrades, signed 32-bit wrap, all general purpose, `ALIAS`, separate per slot, zeroed on reboot). |
| 2026-11-13 | `ccr-2a541ea4-pbkrmo` | M11: Console analysis (three streams sorted by link direction, Mission log knows rover internals, request/reply split, two slot switches); Comms reorganisation behind `?comms=1`: Code tab *Look inside* (ask for a copy of registers / stacks, direction flow, copy cards, ◆ listing mark), Comms tab (radio link + one ▲/▼ timeline with request → copy status), Mission events strip; `engine.sent` + `LOG` categories, save v13; `?console=2` proposal removed. |
| 2026-11-13 | `ccr-2a541ea4-pbkrmo` (2) | M11 review feedback: "dump" wording kept (*Dump program state*, *▲ Dump registers / stacks*, one slot's CPU, not the whole rover); dumps in Comms byte by byte with a comment per field and `ALIAS` register names; *Decode bytes* for LOG / system messages; new **Reference → Radio** sub-tab (header byte, numbers, every frame type as a decoded example). |
| 2026-11-13 | `ccr-2a541ea4-pbkrmo` (3) | M11 clarity pass: `BRK` sends a register dump by itself (*sent by BRK*, "stopped at the BRK on line 5"); not-running program dumps marked; value comments for state / `@STATUS`; `fw L55` and dump addresses link to the Code tab; waiting estimate; foldable dump box; rejected sends listed in Comms (`engine.sent` `rejected`). |
| 2026-11-13 | `ccr-2a541ea4-pbkrmo` (4) | Comms is the default: Console tab, `ConsolePanel.ts`, its CSS and the `?comms=1` flag removed; "Console" wording replaced (Reference, shipped firmware comments, admin banner, SPEC). |
| 2026-11-13 | `claude/gallant-bell-hb1kyd` | M12 designed with the owner: image memory (`SNAP` → `LDB` / `STB` → `SEND`, SPEC §3.8.7) and player guide `docs/IMAGE_MEMORY.md` with six examples checked on a prototype interpreter; multiple rovers dropped from the plan (one rover is plenty of work). |
| 2026-11-13 | `claude/gallant-bell-hb1kyd` (2) | M12 slice 0: bit instructions `AND` / `OR` / `SHL` / `SHR`, opcode `1F` as extension prefix (2-byte opcodes; 1D / 1E reserved for `LDB` / `STB`), Reference *Bits* group; guide examples `plot` and `put16` rewritten with them and re-checked on the prototype. |
| 2026-11-13 | `claude/gallant-bell-hb1kyd` (3) | M12 slice 1: image memory in the core (`SNAP` into memory, `LDB` 1D / `STB` 1E, `SEND` 1F 05, raw / edited / drawn levels in the science header, credits per capture, save v14); minimal Gallery / Reference updates; tests run the six guide examples from the Markdown. |
