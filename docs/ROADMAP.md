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
| **M8** | **Visual overhaul (SPEC §7)** | 🚧 in progress: asset preview + indicator lamps done |
| **M8.1** | **Directional headlight: a forward cone becomes the real night sensor rule** | ⏭ next (plan below) |
| M9 | Multiple rovers (after single-rover tuning) | planned |

## Next: M8.1 — Directional headlight (detailed plan)

Decided in review: at night the headlight lights (and senses) **only a forward cone**, not a
circle. This changes rules, so it is its own PR, before the renderer switch-over.

Shape (numbers to `balance.ts`): the 1-tile ring around the rover is always sensed
(`nightSensorRange`); with `@HEADLIGHT 1` add tiles `1 ≤ forward ≤ 5` ahead with
`|lateral| ≤ 1` for `forward ≤ 2` and `≤ 2` beyond (≈ 20 tiles). Day stays a 6-tile circle.

- [ ] **One shared shape function** in core, e.g. `sensorTiles(u)` / `isSensed(u, dx, dy)`
      in `SimulationEngine`, used for fog reveal **and** by the renderer's `TileLighting`
      (so what is lit is exactly what is sensed). `revealAround` key must include heading.
- [ ] `ChunkedWorld.revealTiles(...)` (or a cone variant of `revealCircle`), deterministic.
- [ ] **SCAN at night:** today `SCAN dir` sets the heading first, so the cone would always
      point where the rover scans. Decide (see open decision 4); then implement.
- [ ] `@SENSOR_RANGE` description: range **ahead**; consider `@SENSOR_SIDE` (1 at night).
- [ ] Shipped firmware (Explorer / Prospector / Fetch): check night behaviour still works.
- [ ] Tests: cone reveal shape per heading, ring without headlight, determinism, save
      round trip (heading is already saved), firmware still compiles.
- [ ] SPEC §3 (sensor range table, `@HEADLIGHT`), Reference text via the port description.
- [ ] Renderer: `TileLighting` uses the shared shape instead of disc + beam emphasis.

## M8 — Visual overhaul (detailed plan)

**Review workflow:** new visuals go into [`preview.html`](../preview.html) (`npm run dev` →
`/preview.html`) first; the owner approves screenshots; only then they replace the game
renderer. The preview uses the same `VectorFactory` / `TileLighting` / `CameraRig` /
`PostFx` / `RoverRig` modules the game will use. Query params (`sun`, `headlight`,
`solar`, `deploy`, `drill`, `dist`, `pitch`, `yaw`, `fx`, `fy`, `labels`, `crt`) frame
reproducible screenshots.

Done (preview, approved so far): wireframe-with-dark-fill look; per-tile day/night
lighting shader with dusk grading; bloom; orbit/pan/zoom-to-cursor camera; detailed
rover (three-segment accordion solar wings, solid dish, LED, headlight bar + beam, drill
with sparks, wheels, CPU core); rock walls with strata, flat pebbles, volcano vents, iron
ore mounds (new `mound` shape), buried silicon crystals; **indicator lamps** `@IND1..3`
(already live in the game, see SPEC §3.3.1).

Remaining:
- [ ] **Switch the game renderer** to the v2 assets (`drawTileVec`, `buildRoverRig`,
      `TileLighting`, `CameraRig`, `PostFx`); compass must rotate with camera yaw.


Everything lives in `src/render/` (the renderer only reads the simulation), so gameplay
tests must stay untouched. Do it in small PRs, checking frame time at each step.

- [ ] **Frame-time HUD** (toggle): fps, ms/frame, chunk meshes, line vertices. Baseline first.
- [ ] **Bloom:** `EffectComposer` + `UnrealBloomPass`, selective (grid stays crisp; ore,
      beacons, scan/uplink FX, vents, supply crates glow). Settings toggle for slow GPUs.
- [ ] **Fat lines:** `LineSegments2` + `LineMaterial` for rover, ore, crates and FX;
      width scales with zoom. Keep 1 px for the terrain grid (cost).
- [ ] **LOD by zoom:** far = grid + silhouettes; near = pebbles, rock strata, detailed rover
      (wheels turning while driving, suspension bounce, panel hinges, dish ribs).
- [ ] **Zoom range** 0.15×–8×, zoom to cursor; far zoom switches to a minimap-like style.
- [ ] **Camera:** optional perspective mode, smooth follow, rotate with right-drag (then
      the compass must rotate too).
- [ ] **Atmosphere:** day/night colour grading (not just dimming), dust particles,
      animated vents and crates, optional CRT/scanline pass.
- [ ] Keep `VectorFactory.ts` as the single place shapes are defined.

## Resolved decisions (M7)

1. Upgrades are **picked up**: a supply crate lands near the rover; the grabber installs it.
2. Installed **immediately** on pickup (including Flash/register limits).
3. **More rovers later**, once the single-rover game is tuned (M9).
4. Prospector stays at 31/32 lines without squall handling: **a lesson** (Flash 48 fixes it).

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

1. ~~M8 look~~ → wireframe with dark opaque fills (hidden-line look), approved in preview.
2. Bloom on by default with a toggle (as in the preview) — confirm once measured in-game.
3. Upgrade prices: fine for now? (A Prospector run earns ~75 credits in 1.5 sols; the
   whole catalogue costs 745.)
4. **M8.1 SCAN vs. cone:** (a) keep `SCAN dir` turning the rover instantly (the cone always
   covers the scan, headlight only limits fog reveal), or (b) at night a `SCAN` off the
   current heading only reaches the 1-tile ring unless the rover turns first (needs a
   cheap turn instruction or `@HEADING` port). (b) makes the cone matter; recommended.

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
