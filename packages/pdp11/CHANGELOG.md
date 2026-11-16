# Changelog

All notable changes to this package. Versions follow semantic versioning: the minor
version for new features, the major version for breaking changes to the public API.

## 0.1.0 (2026-11-16)

First version as a package of its own (it was the folder `src/pdp11/` of the Rover game).

* `Cpu`: the PDP-11/40 instruction set, EIS optional; the eight addressing modes; flags;
  traps and vectors; interrupts with priorities; `WAIT`; the T bit; a stack limit; the PSW
  at 177776; cycle models `per-bus-access` and `flat`; `onTrap`, `onModeChange`;
  `protectModes` (the PDP-11/45 rules for non-kernel modes); JSON `save()` / `load()`.
* `assemble`: a MACRO-11 subset in two passes, with local labels, expressions, directives,
  predefined symbols, DEC six-character names (or long names), a listing and a line map;
  errors as values.
* `disassemble`, the opcode tables, `octal`.
* `SimpleMachine`: RAM, a DL11 console and a KW11-L line clock.
* `pdp11/codemirror`: a CodeMirror 6 language and highlighting.
* `pdp11/examples`: seven tested console programs and `examples/host.ts`, a tested example
  of hosting the CPU in your own machine.
