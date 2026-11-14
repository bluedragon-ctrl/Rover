# Rover — working notes for contributors and AI sessions

Browser sandbox game: program a planetary rover in Rover-ASM. Vite + TypeScript +
Three.js + CodeMirror 6, Vitest for the core.

## Start here
1. Read [`docs/ROADMAP.md`](docs/ROADMAP.md): current status, the **detailed plan for the
   next milestone**, open decisions.
2. Read [`docs/SPEC.md`](docs/SPEC.md) for game rules and the language.
3. `npm install && npm test` must be green before you change anything.

## Workflow
- One milestone (or a coherent slice of one) per branch and **pull request into `main`**.
- Every PR: tests green, `npm run build` passes, ROADMAP status/checkboxes updated,
  SPEC updated if rules or the language changed, a session-log row added.
- Do not merge your own PRs; the owner reviews and merges.
- Commit messages: short summary line, bullet list of changes.

## Commands
```bash
npm run dev        # dev server
npm test           # vitest (headless core)
npm run typecheck
npm run build      # typecheck + production bundle in dist/
```

## Architecture rules (do not break)
- `src/core/` is **headless and deterministic**: no DOM, no Three.js, no `Math.random`,
  no wall-clock time, no `Math.sin/cos` in the tick path (use `Environment.ts` tables).
  Same seed + same inputs ⇒ identical run. There is a test for this.
- The renderer (`src/render/`) and UI (`src/ui/`) only **read** sim state and listen to
  `EventBus` events; they never mutate the simulation (admin buttons go through
  `engine.admin` / `engine.cheats`).
- All gameplay numbers live in `src/core/balance.ts` and the tile registry.
- New tiles: `WorldRegistry` (constName auto-becomes a language constant).
  New ports: `src/core/ports.ts` (auto-appears in compiler and Reference tab; numbers 0–63 are
  full since M14: the next one needs the extended operand, see `ASSEMBLER_CORE.md` §9).
  New instructions: `src/core/vm/isa.ts` signature + opcode tables, `RoverVM.ts`.
  New devices (M14): a start port in `ports.ts` (`DevicePort`), its logic in
  `SimulationEngine.device()`, progress in `Unit.deviceLeft()`, the result in `Unit.results`
  (`WAIT_DEVICE` maps the port), a driver routine in `src/core/rom.ts` (+ `ROM_ARGS`).
  New tools: `src/core/tools.ts` (check/complete) + mount in a chassis in `balance.ts`.
  New goals: `GOALS` in `src/core/EventDirector.ts`.
  New world events: `EVENT_DEFS` in `src/core/events.ts` (with prerequisites; add a
  teaching variant first for anything harsh).
  Repair materials: `repairs` on the tile in `WorldRegistry`.
  New upgrades: `UPGRADES` in `src/core/upgrades.ts` (modify the rover's own `chassis`;
  never the shared `CHASSIS_MK1`).
- Shapes are drawn only in `src/render/VectorFactory.ts` (keeps M8 visual work local).
- New or changed visuals go into `preview.html` (`src/preview/`) first; the owner reviews
  screenshots before they replace what the game renders.
- Shipped firmware (`src/core/programs.ts`) must compile and is covered by tests.

- **New simulation state must be saved:** add it to `src/core/SaveManager.ts`. The
  round-trip test (save mid-run, load, continue == uninterrupted run) catches omissions
  that affect the simulation. Bump `SAVE_VERSION` and add a migration for format changes.
- Storyteller randomness only through `EventDirector.rng` (seeded, saved).

## Gotchas
- Names are case-insensitive: a label `beat` clashes with `CONST BEAT`.
- Actuator state (solar array, dish, lights) is physical and survives reboots;
  firmware must not assume a fresh state.
- M14: there are no hardware instructions. Device start writes set `@STATUS` (accepted?),
  `WAIT @port` on a device copies its result (how it ended); other instructions don't
  (except `DIV`/`MOD` by 0 and `CALL PROGRAM`).
- ROM routine names (`STEP`, `SCAN`, `SLEEP`, …), `PROGRAM` and `WAIT` are reserved: a label
  `step:` or `wait:` is a compile error.
