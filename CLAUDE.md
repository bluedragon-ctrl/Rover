# Rover — working notes for contributors and AI sessions

Browser sandbox game: program a planetary rover's computer, the Blue-11, in Blue-11 assembly. Vite + TypeScript +
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
npm run dev        # dev server (game; /preview.html assets; /simulator.html Blue-11 simulator)
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
- All gameplay numbers live in `src/core/balance.ts` (the computer's memory map and sizes in
  `BLUE11`) and the tile registry.
- New tiles: `WorldRegistry` (`shortName`, six characters at most, auto-becomes a predefined
  symbol).
  New I/O registers: `src/core/machine/iopage.ts` (they become predefined symbols and appear
  in Reference → I/O page; six-character DEC names, `symbols.ts` tests each one).
  New devices: a device block in `iopage.ts` (`DEVICE_BLOCKS`, CSR with `GO` / `FN` / `IE` /
  `DONE` / `ERR`, an `xxER` register), its logic in `SimulationEngine.device()`, progress in
  `Unit.deviceLeft()`, the result in `Unit.results`, a driver routine in
  `src/core/machine/rom.ts` (add it to `ROM_ROUTINES`: its comment becomes Reference → ROM).
  New instructions: in the library (`src/blue11/isa.ts`, `cpu.ts`; follow
  `src/blue11/AGENTS.md`) and a row in `INSTR_DOC` in `src/ui/ReferenceBlue11.ts` (a test checks).
  New system names (codes, bits, constants): `src/core/machine/names.ts`.
  New tools: `src/core/tools.ts` (check/complete) + mount in a chassis in `balance.ts`.
  New goals: `GOALS` in `src/core/EventDirector.ts`.
  New world events: `EVENT_DEFS` in `src/core/events.ts` (with prerequisites; add a
  teaching variant first for anything harsh).
  Repair materials: `repairs` on the tile in `WorldRegistry`.
  New upgrades: `UPGRADES` in `src/core/upgrades.ts` (modify the rover's own `chassis`;
  never the shared `CHASSIS_MK1`).
- `src/blue11/` is a **standalone library** (CPU, assembler, disassembler): nothing in it may
  import from the game (a test enforces it); Rover-specific things (memory map, I/O page,
  gate, ROM) live outside it. API: `src/blue11/README.md`; rules for changing it:
  `src/blue11/AGENTS.md`. `simulator.html` (`src/simulator/`) is its standalone page; its
  examples are tested.
- Rover's side of the computer lives in `src/core/machine/`: the I/O page `iopage.ts`, the
  bus, protection, gate, interrupts and saves `RoverMachine.ts`, the boot ROM and routines
  `rom.ts` (`ROM_ROUTINES` become predefined symbols), system names `names.ts`, all
  predefined symbols `symbols.ts`. Design: `docs/BLUE11_CPU.md`, `docs/BLUE11_IO.md`.
- The UI reaches the computer through `src/ui/toolchain.ts` (language, assembling, templates,
  listing). UI code reads the machine only through `registers`, `stackWords`, `peek` and
  `ioSnapshot` (never `read`: `TICKL` has a side effect).
- Shapes are drawn only in `src/render/VectorFactory.ts` (keeps M8 visual work local).
- New or changed visuals go into `preview.html` (`src/preview/`) first; the owner reviews
  screenshots before they replace what the game renders.
- Shipped code (`src/core/programs.ts`: default firmware, firmware templates, lessons) must
  assemble, fit its region and run to its expected result: `tests/blue11-programs.test.ts`.
- Photos are packed little-endian (the first pixel in a byte's low bits; `src/core/photos.ts`).

- **New simulation state must be saved:** add it to `src/core/SaveManager.ts`. The
  round-trip test (save mid-run, load, continue == uninterrupted run) catches omissions
  that affect the simulation. Bump `SAVE_VERSION` and add a migration for format changes
  (v21 started over: saves from before the Blue-11 raise `OldSaveError`, no migrations).
- Storyteller randomness only through `EventDirector.rng` (seeded, saved).

## Gotchas
- **Numbers are octal** in Blue-11 assembly: `14` is twelve, `14.` is fourteen. Easy to get
  wrong in tests and templates.
- Names are case-insensitive and at most six characters; predefined names (registers, ROM
  routines like `STEP`, `SCAN`, `SLEEP`, `PLOT`, codes like `E.BUSY`) are reserved: a label
  `step:` is an assembler error.
- ROM routines take R0, R1 (R2 kept) and answer in R0 with the flags set; they may change R0
  and R1. Tests keep their results in R2–R5.
- Actuator state (solar array, dish, lights, display) is physical and survives reboots;
  firmware must not assume a fresh state.
- A device start is refused or accepted in the same instruction (`ERR` and `xxER`); there is
  no shared status. Wait for `DONE`, then read `ERR`.
- A hard reboot takes 3 ticks of boot ROM before the firmware's first instruction: tests
  that count ticks use `boot()` or wait for a condition (`tests/helpers/rover.ts`).
- I/O registers are unsigned except the bearings, `HDG` and the signed telemetry (`X`, `Y`,
  `TEMP`, `SUNEL`, `DROPX`, `DROPY`): writing −5 to a lamp clamps 177773 to 4.
