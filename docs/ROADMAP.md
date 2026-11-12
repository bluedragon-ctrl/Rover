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
| **M8** | **Visual overhaul (SPEC §7)** | 🚧 in progress: asset preview + indicator lamps done; ⏭ next: switch the game renderer |
| M8.1 | Radar `SCAN` vs. light-limited operator view; headlight cone; `@HEADING` | ✅ done |
| Flash bytes | Program size in machine-code bytes instead of lines (SPEC §5.7) | ✅ core done; editor byte gutter awaiting preview approval |
| M9 | Multiple rovers (after single-rover tuning) | planned |

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
      Drive `uPulses` from `SCAN_PULSE` + `engine.sensorRange(u)`. The radar wave must
      also briefly show **unmapped** tiles, so chunks need (hidden) geometry for them that
      only the wave makes visible.


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
