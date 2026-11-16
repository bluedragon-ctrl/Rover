# Working on the Blue-11 library (for AI coding agents and people)

`src/blue11/` is a **standalone, reusable library**: CPU, assembler (a subset of the original syntax),
disassembler, device bus. Rover (the game around it) is its first user, not its owner.
User documentation: [`README.md`](README.md). Design rationale: `docs/BLUE11_CPU.md` §14.

## Rules (the first three are enforced by `tests/blue11/boundary.test.ts`)

1. **Nothing imports from outside this folder.** Files import only `./…`. The one
   exception is `codemirror.ts`, which may import `@codemirror/*` and `@lezer/*`; `index.ts`
   must never load it.
2. **No runtime dependencies.**
3. **Deterministic and integer-only:** no `Math.random`, `Date`, `performance.now`, timers,
   floating-point trig, DOM or `window` (except in `codemirror.ts`). Time is CPU cycles.
   The same inputs give the same run; states survive JSON.
4. **Errors in the program are values** (`assemble` returns `errors` / `warnings`, the CPU
   reports `RunResult`s and calls `onTrap`). **Mistakes by the host may throw** (a device
   overlapping another), and only at setup time, never during `run`.
5. **Nothing host-specific.** Memory maps, ROMs, Rover's I/O page and gate live in
   `src/core/machine/`. If a host needs new behaviour, add a general option or hook that
   the original machine had, or one documented as a departure (`protectModes`, `stackLimit`,
   `onTrap`, `onInstruction`), never a special case for one user.
6. **Behave like the original machine** (the /40 model, EIS optional) and **assemble like the original assembler.**
   Every departure is listed in the README ("Where it departs from the real machine",
   "Assembler compatibility"). Original features we lack are errors, never silently ignored.

## When you change something

- Tests first: they are the specification (cycle counts, flags and traps all have tests).
- `npm test` (the whole repository: Rover's tests use the library), `npm run build`.
- Update `README.md` with the change. Its code blocks are run by
  `tests/blue11/readme-examples.test.ts`, which also fails if a README block is not in it:
  edit both together. A new compatibility claim gets a test in `tests/blue11/syntax*.test.ts`.
- Export new public things from `index.ts`, and document them in the README.

## Where things are

| Change | File | Tests |
| :--- | :--- | :--- |
| An instruction | `isa.ts` (name, opcode, format), `cpu.ts` (`exec`), `disassembler.ts` for a new format | `cpu.test.ts`; `assembler.test.ts` assembles and disassembles every table entry |
| Assembler syntax, directives, warnings | `assembler.ts` | `assembler.test.ts`, `syntax.test.ts`, `syntax-compat.test.ts` |
| Bus, devices, time, `WAIT` | `devices.ts` (`DeviceMachine`, `DL11`, `KW11L`) | `devices.test.ts`, `review-fixes.test.ts` |
| `SimpleMachine` | `machine.ts` | `examples.test.ts` (the simulator's programs) |
| Syntax highlighting | `codemirror.ts` | – |
| Public API | `index.ts` | `boundary.test.ts` |
| Docs | `README.md` | `readme-examples.test.ts` |
