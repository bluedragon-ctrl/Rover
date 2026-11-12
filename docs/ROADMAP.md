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
| **M6** | **Save/load, storyteller (events, eclipses, squalls), admin console** | ⏭ next |
| M7 | Upgrades & chassis tiers (Flash, registers, cycles, cargo, `TOOL_3`), spend credits | planned |
| M8 | Visual overhaul: bloom, fat lines, LOD, zoom, camera, atmosphere (SPEC §7) | planned |

## Next: M6 — Persistence & storyteller (detailed plan)

Goal: progress survives a page reload, and the world starts *happening* to the rover,
so programs need to react (stow panels in a squall, sleep through an eclipse).

### Persistence (`src/core/SaveManager.ts` headless + `src/ui/` glue)
- [ ] `serialize(engine) → SaveSnapshot` (versioned JSON, `version: 1`):
      seed, tick, credits, stats, completed goals, director state + RNG state,
      units (position, heading, energy, hull, cargo, science, actuators, lights,
      source code, VM: ip, regs, stacks, state, status, watchdog, current `action`),
      **only dirty/explored chunks**: changed layers (RLE or sparse diff vs. regenerated
      chunk) + fog RLE.
- [ ] `deserialize(snapshot) → SimulationEngine` (recompile source → program; the VM
      state is restored on top). Reject/upgrade unknown versions.
- [ ] Round-trip test: run N ticks, save, load, run M more ticks ⇒ identical to an
      uninterrupted N+M run (determinism guarantee).
- [ ] UI: autosave to `localStorage` every ~30 s and on page hide; "Save to file"
      (`<a download>`), "Load from file" (`<input type=file>`), "New world" confirms
      before discarding. Load the autosave on startup if present.

### Storyteller (`EventDirector`)
- [ ] Seeded `Rng` in the director (state saved). Scheduler that rolls events per sol.
- [ ] **Solar eclipse:** `env.lightFactor` ramps to 0 for ~150 ticks mid-day; announced
      ~200 ticks ahead via a new port `@ALERT` (0 none, 1 eclipse, 2 squall) and a log line.
- [ ] **Micrometeorite squall:** for ~100 ticks, rovers take hull damage per tick unless
      the solar array is stowed and the rover is not moving (or damage doubles with the
      panels open). Rewards `REPAIR_KIT` use.
- [ ] Event goals: *Survive an eclipse powered*, *Weather a squall with hull > 50*.
- [ ] Renderer: eclipse darkening, squall streaks; event banner in the HUD.
- [ ] Tests: event schedule is deterministic per seed; eclipse zeroes `@SUN_LIGHT`;
      squall damage rules.

### Admin console
- [ ] Admin tab: trigger eclipse/squall now, set time of day, give credits, teleport
      rover to a clicked tile, toggle invulnerability.

### Docs
- [ ] SPEC: save format, events, `@ALERT`; ROADMAP: tick boxes, M7 detailed plan.

## Resolved decisions (M5)

1. Science delivery: **automatic** with every successful `@TX_DATA` write.
2. Grabber reach: **adjacent tile only**.
3. Science credits: **currency** for M7 upgrades (delivered science + goal rewards).
4. Explorer firmware dish: **unchanged** (aligns only while charging; the Prospector
   template shows continuous tracking).

## Open decisions

1. Save slots: a single autosave + file export, or several named slots in `localStorage`?
2. Squall rule: damage only when the array is open, or always unless the rover is still?
3. Balance: the Prospector earns ~75 credits in its first 1.5 sols. Fine for now; revisit
   once M7 prices exist.

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
| 2026-11-12 | `ccr-fb6a40ee-nae64a` → PR | M5: tools, cargo, spectrometer, science credits, goals, Prospector template. |
