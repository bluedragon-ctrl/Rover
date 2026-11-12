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
| **M5** | **Tools, cargo, spectrometer, science, first goals** | ⏭ next |
| M6 | Save/load, storyteller (events, eclipses, squalls), admin console | planned |
| M7 | Upgrades & chassis tiers (Flash, registers, cycles, cargo, `TOOL_3`) | planned |
| M8 | Visual overhaul: bloom, fat lines, LOD, zoom, camera, atmosphere (SPEC §7) | planned |

## Next: M5 — Tools, cargo & science (detailed plan)

Goal: give exploration a purpose. The rover can mine, pick up and analyze things, and
send science home. A first set of goals gives the sandbox direction.

### Simulation (`src/core/`)
- [ ] **Cargo bay** on `Unit` (4 slots, item IDs). `@CARGO_FREE` port.
- [ ] `PEEK slot -> dst` returns the item ID (already routed to the host; just validate).
- [ ] **`ACT TOOL_0 dir` — drill:** adjacent tile in `dir` must have a tile with
      `tool: 'DRILL'` on layer 1. Blocks 8 ticks, costs energy; removes the vein
      (`setTile` → chunk dirty), puts the ore item in the first free slot.
      Errors: `ERR_INVALID` (nothing drillable), `ERR_FULL`, `ERR_LOW_POWER`, `ERR_DEPLOYED`?
- [ ] **`ACT TOOL_1 dir` — grabber:** picks a layer-2 item (`tool: 'GRABBER'`) from the
      adjacent tile in `dir` (decide: also allow the tile under the rover?). 2 ticks.
- [ ] **`ACT TOOL_2 slot` — spectrometer:** analyzes the item in `slot`, frees it, adds
      science packets (`SAMPLE` 3, ore 1). ~30 ticks. `@SCIENCE_READY` port.
- [ ] `TOOL_3` empty → `ERR_NO_TOOL`.
- [ ] **`USE slot`:** `REPAIR_KIT` restores hull (+30); other items `ERR_INVALID`.
- [ ] **Science uplink:** writing `@TX_DATA` while `@SCIENCE_READY > 0` sends one science
      packet (decrements it, adds to the world's science score). See open decision 1.
- [ ] Tool definitions declarative (tool table: ticks, energy, handler) so new tools need
      no VM changes; generate `TOOL_n` docs from it.
- [ ] **Goals v1** (`EventDirector` skeleton, deterministic): e.g. *First contact*
      (send a packet), *Surveyor* (map 500 tiles), *Prospector* (mine 3 ore),
      *Scientist* (deliver 5 science), *Night owl* (survive a night powered).
      Emits `GOAL_COMPLETED` events.
- [ ] Tests for every tool path, error codes, goals; determinism test still green.

### Presentation (`src/render/`, `src/ui/`)
- [ ] Cargo panel (4 slots with item names) and science counter in the debugger.
- [ ] Goals panel/tab with progress; toast on completion.
- [ ] FX: drill sparks, grab beam, spectrometer glow on the rover.
- [ ] Reference tab: tool table and new ports (auto-generated).
- [ ] New template firmware: "Prospector" (find ore, mine, analyze, transmit).

### Docs
- [ ] SPEC: tools, cargo, science, goals sections; ports table; status markers.
- [ ] This file: tick the boxes, move M5 to done, write the M6 detailed plan.

## Open decisions

1. **Science delivery:** automatic on any successful `@TX_DATA` write, or a dedicated
   port (e.g. `@TX_SCIENCE`)? Proposal: automatic, simplest for players.
2. **Grabber reach:** adjacent tile only, or also the tile under the rover?
3. **Score meaning:** is science a currency for M7 upgrades, or only a score? Proposal:
   currency (gives the sandbox a progression loop).
4. **Explorer firmware dish:** it only aligns the dish while charging, so uploads are
   often expensive. Keep as a teaching moment, or align the dish every loop?

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
| 2026-11-12 | `ccr-fb6a40ee-nae64a` | M0–M4 implemented; spec v1.3; M8 visual roadmap added. |
