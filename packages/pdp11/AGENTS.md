# Working on this library (for AI coding agents and humans)

This package is a **standalone, reusable library**: several projects are expected to use
it. Rover (the game in the surrounding repository) is only its first user. Keep it that way.

## Rules (tests enforce the first four: `tests/boundary.test.ts`)

1. **Nothing imports from outside this package.** `src/` imports only `./…`; `examples/`
   imports only `../src`. The one exception is `src/codemirror.ts`, which may import
   `@codemirror/*` and `@lezer/*` (optional peer dependencies).
2. **No runtime dependencies** in `package.json`. The main entry point (`src/index.ts`)
   must never load CodeMirror.
3. **Deterministic, integer-only:** no `Math.random`, `Date`, `performance.now`, timers,
   floating-point trig, DOM or `window` (except in `codemirror.ts`). The same inputs must
   give the same run, and states must survive JSON.
4. **The entry points are `.`, `./codemirror` and `./examples`** (the `exports` in
   `package.json`). A new public entry point is a deliberate change: add it there, in the
   README and in the boundary test.
5. **Errors are values.** The assembler returns `errors[]`; the CPU reports traps through
   `RunResult` and `onTrap`. Never throw into the host (internal exceptions are caught).
6. **Nothing host-specific.** Memory maps, device registers, ROMs, timing per frame and
   context switching are the host's business. If a host needs new behaviour from the CPU,
   add a general option or hook that a real PDP-11 had, or that is clearly documented as a
   departure (see `protectModes`, `stackLimit`, `onTrap`), and never a special case for
   one user.
7. **Behave like the real machine** (PDP-11/40, EIS optional). Every departure is listed in
   the README under "Where it departs from the real machine".

## When you change something

* Add or change a test in `tests/` first: they are the specification. Cycle counts, flags
  and trap behaviour all have tests.
* Run `npm test` and `npm run typecheck` in this folder. In the Rover repository also run
  the root `npm test`, because Rover's tests use the library.
* Update `README.md` (it is the user documentation: keep it self-contained and don't link
  outside this folder) and add a line to `CHANGELOG.md`. Bump the minor version for new
  features and the major version for breaking changes to the public API.
* Keep the examples working: `examples/examples.ts` and `examples/host.ts` are tested, and
  the README's quick start is run by `tests/readme.test.ts`.

## Where things are

| File | |
| :--- | :--- |
| `src/cpu.ts` | the CPU: registers, PSW, addressing modes, instructions, cycles, traps, interrupts |
| `src/isa.ts` | the opcode table (`INSTRUCTIONS`), `decodeOp`, `octal` |
| `src/assembler.ts` | the MACRO-11 subset: two passes, expressions, directives, listing |
| `src/disassembler.ts` | words → text |
| `src/machine.ts` | `SimpleMachine`: RAM, DL11 console, KW11-L clock (a reference host) |
| `src/codemirror.ts` | optional syntax highlighting |
| `src/index.ts` | the public API: export new public things here |
| `examples/` | tested example programs and the host example |
