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
| **M8** | **Visual overhaul (SPEC §7)** | 🚧 in progress: asset preview, indicator lamps, **game renderer switched to v2**, frame-time HUD + geometry baseline; ⏭ next: owner GPU numbers (P HUD), then LOD by zoom |
| M8.1 | Radar `SCAN` vs. light-limited operator view; headlight cone; `@HEADING` | ✅ done |
| Flash bytes | Program size in machine-code bytes instead of lines (SPEC §5.7) | ✅ core done; editor byte gutter awaiting preview approval |
| **M9** | **Downlink, debug log & science imaging (SPEC §3.8)** | 📝 designed; ⏭ next after M8; photo POC in `preview.html?photos=1` |
| M10 | Multiple rovers (after single-rover tuning) | planned |

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
- [ ] Owner playtest of the switched renderer (feel of pan/orbit defaults, start zoom 14,
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
- [ ] **Baseline on real GPUs** (owner): note the HUD numbers at the default view, zoomed
      out to the max, and at night, on a desktop and a laptop. Decide LOD from that.
- [x] **Pan leash** (owner): the camera focus stays within `PAN_LEASH` = 24 tiles of the
      followed rover (else the first rover); dragging further stops at the edge. Bounds
      what the renderer must build around the rover (`CameraRig.leash`, `tests/camera.test.ts`).
- [x] **Bloom:** `PostFx` (threshold bloom keeps the grid crisp), B toggles it.
- [ ] **Fat lines:** `LineSegments2` + `LineMaterial` for rover, ore, crates and FX;
      width scales with zoom. Keep 1 px for the terrain grid (cost).
- [ ] **LOD by zoom:** far = grid + silhouettes; near = pebbles, rock strata, detailed rover
      (wheels turning while driving, suspension bounce, panel hinges, dish ribs).
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

1. [ ] **Link layer + `LOG`.** `src/core/downlink.ts` (FIFO, byte accumulator, frame
       encoder, per-tick energy), `LOG` in `Compiler.ts` signature table + `RoverVM.ts`
       (tag 0–14 compile-time constant; `LOG 15` error), ports `@LOG_FREE` / `@LOG_LOST`,
       boot frame on hard reboot, `BALANCE.link*`. Engine emits `DOWNLINK_FRAME` (bytes +
       decoded) for the UI. `@TX_DATA` = `LOG 0` **only after slice 2** (science still
       rides on it until then). Console tab (`src/ui/ConsolePanel.ts`): received frames,
       raw hex toggle, tag names from `CONST`, lost-frame gaps. Save: FIFO bytes, lost
       counter, accumulator, last 200 received frames (bump `SAVE_VERSION` to 4 + migration).
       Tests: frame encoding (examples in SPEC §3.8.2), FIFO overflow drops whole frames,
       rate vs signal, no send below 20, energy only while sending, save round-trip
       mid-frame, determinism.
2. [ ] **Recorder + spectra; retire packet science.** Recorder (descriptors + sent
       offset), science frames with sequence byte, spectrometer writes a spectrum
       (`ERR_FULL` keeps the item), `@REC_FREE`, `@SCIENCE_READY` = products waiting,
       credits on full delivery. `@TX_DATA` becomes `LOG 0` (`@STATUS` OK / `ERR_FULL`).
       `src/core/imaging.ts`: integer-only, seeded spectrum generator. Goals: *First
       contact* = first frame received, *Scientist* = 5 products delivered. Update
       Prospector/Factory firmware (heartbeat → `LOG`, drop the TX science loop; Flash
       freed) and their tests. Gallery tab with spectra (bar chart + hex).
3. [ ] **Debugger admin-only, dumps, `BRK`.** Debugger panel behind the admin toggle;
       console *Dump* / *Dump stacks* / *Continue* commands (uplink cost, SPEC §3.8.4);
       CPU state `HALTED`; dump snapshots shown with their tick.
4. [ ] **`@POST` display.** Preview first (`preview.html`, two 7-segment digits on the
       cabin), owner screenshot review, then the game renderer; visible only in the
       operator's view.
5. [ ] **Camera + photos.** `SNAP dir [mode]` (modes 1–2 on Mk-I), subject rules and light
       rule from SPEC §3.8.5, deterministic integer image generator per subject (port the
       POC scenes from `src/preview/photos.ts`, no float trig in the tick path; the
       generator only runs when a product is created or decoded), partial photos in the
       gallery, credits incl. first-of-a-kind bonus. Goal *Photographer*.
6. [ ] **Upgrades + anomalies.** Catalogue additions (SPEC §3.8.6), camera modes 3–5,
       seeded anomaly tiles, gallery flagging (+20 / −5). Goal *Anomaly hunter*.

Later (backlog): `@REC_PEEK` so firmware can inspect recorder bytes (on-board triage,
compression); bit errors at low signal and a checksum lesson; panorama `SNAP` of the
horizon; unknown minerals identified only by spectrum.

## Resolved decisions (M7)

1. Upgrades are **picked up**: a supply crate lands near the rover; the grabber installs it.
2. Installed **immediately** on pickup (including Flash/register limits).
3. **More rovers later**, once the single-rover game is tuned (now M10).
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
prices. Is 128 ticks per Mk-I photo at full signal right against a ~300-tick orbiter
window with a fixed dish?


1. ~~M8 look~~ → wireframe with dark opaque fills (hidden-line look), approved in preview.
2. Bloom on by default with a toggle (as in the preview) — confirm once measured in-game.
3. Upgrade prices: fine for now? (A Prospector run earns ~75 credits in 1.5 sols; the
   whole catalogue costs 745.)
4. ~~M8.1 SCAN vs. cone~~ → `SCAN` is radar (ignores light, does not turn); the cone only
   limits what the **player** sees at night. `@HEADING` aims the headlight (5 energy).
5. Explorer firmware toggles `@HEADLIGHT` 0→1 every loop at night (mapping can miss the
   cone on a tick boundary). Harmless now; fix when Flash allows.
6. ~~Radar blips~~ → every `SCAN` shows a brief red radar wave around the rover (visual
   only). Turn cost 5 energy stays until playtests.

## Backlog / ideas

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
