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
| **M8** | **Visual overhaul (SPEC §7)** | ⏭ next |
| M9 | Multiple rovers (after single-rover tuning) | planned |

## Next: M8 — Visual overhaul (detailed plan)

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

1. M8 look: keep the strict vector/wireframe style, or allow filled translucent surfaces
   (e.g. faint terrain fill, glowing panels)?
2. Bloom on by default, or opt-in for performance?
3. Upgrade prices: fine for now? (A Prospector run earns ~75 credits in 1.5 sols; the
   whole catalogue costs 745.)

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
