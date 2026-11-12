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
| M6 | Save/load + autosave, storyteller (eclipses, squalls), subsystem damage, admin console | ✅ done |
| **M7** | **Upgrades & chassis tiers: spend credits** | ⏭ next |
| M8 | Visual overhaul: bloom, fat lines, LOD, zoom, camera, atmosphere (SPEC §7) | planned |

## Next: M7 — Upgrades (detailed plan)

Goal: close the progression loop. Credits (science + goals) buy hardware that removes the
tight Mk-I limits, so better programs become possible.

### Simulation
- [ ] Per-unit mutable stats: `Unit.chassis` becomes the base `ChassisDef` plus a list of
      installed upgrade ids; derived stats computed in one place (`effectiveChassis(u)`).
      Everything that reads `chassis.*` uses it (VM limits, sensor range, cargo, battery).
- [ ] Upgrade catalogue `src/core/upgrades.ts` (declarative, tiered), e.g.:
      Flash 32 → 48 → 64 lines · registers 4 → 6 → 8 · cycles/tick 4 → 6 → 8 ·
      cargo 4 → 6 → 8 · battery 100 % → 150 % · sensor range 6 → 8 · solar efficiency
      +25 % · dish gain (cos⁴ → cos²) · reinforced hull (squall damage −50 %).
- [ ] **`TOOL_3` modules** (pick one first): *Seismic scanner* (`ACT TOOL_3 dir` → nearest
      ore within 12 tiles along the ray, result via a new port) or *Field welder*
      (repairs a subsystem without a kit, slowly, costs energy).
- [ ] `engine.buyUpgrade(u, id)`: checks credits and prerequisites; applies on the next
      reboot (firmware limits change) or instantly (physical). Decision 1 below.
- [ ] Save format v2 with installed upgrades; v1 saves load with no upgrades
      (first migration test).
- [ ] Tests: each upgrade's effect; compiler accepts r4–r7 / longer programs only when
      installed; save migration; credits never go negative.

### Presentation
- [ ] **Upgrades** tab: catalogue with costs, tiers, owned state, buy buttons.
- [ ] Rover mesh shows installed upgrades (bigger array, extra dish ring, TOOL_3 module).
- [ ] Reference tab shows the rover's *current* limits.

### Docs
- [ ] SPEC: upgrades section, chassis stats as base + upgrades; ROADMAP: M8 plan.

## Resolved decisions (M6)

1. Saves: **one autosave** in the browser + file export/import.
2. Squalls: **damage individual systems**: light hull wear (more while driving), dish wear,
   heavy damage to an open solar array. Subsystem health scales charging / signal.
3. Rewards: fine for now, tune later.

## Resolved decisions (M5)

1. Science delivery: automatic with every successful `@TX_DATA` write.
2. Grabber reach: adjacent tile only.
3. Science credits: currency for M7 upgrades.
4. Explorer firmware dish: unchanged.

## Open decisions

1. Upgrade delivery: **instant** purchase, or a **supply drop** (a crate lands near the
   rover and must be collected with the grabber — more gameplay)?
2. Flash/register upgrades: apply immediately, or only after the next firmware upload
   (more realistic, avoids changing limits under a running program)?
3. Should a second rover be purchasable in M7, or later?
4. Prospector firmware (31/32 lines) has no room to stow its array on squall alerts. Leave
   it as a lesson, or wait for the Flash upgrade?

## Backlog / ideas

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
| 2026-11-12 | `ccr-fb6a40ee-nae64a` → PR | M6: save/load + autosave, storyteller events, subsystem damage, admin console. |
