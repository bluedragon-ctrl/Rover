# Rover

A browser sandbox game: program an autonomous planetary rover's 16-bit computer, the
**Blue-11**, in **Blue-11 assembly** (octal, eight addressing modes, traps and interrupts)
and watch it explore an infinite, procedurally generated world rendered as vector
wireframes. `simulator.html` runs the Blue-11 on its own.

* Spec: [`docs/SPEC.md`](docs/SPEC.md) · Roadmap & status: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Contributing: [`CLAUDE.md`](CLAUDE.md)
* Stack: Vite + TypeScript + Three.js + CodeMirror 6, tests with Vitest.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # headless simulation tests
npm run build    # static bundle in dist/
```

`?seed=123` in the URL picks the world seed.

## Layout

```
src/core/      headless deterministic simulation (no DOM / Three.js)
  machine/     the rover's side of the computer: I/O page, bus, gate, boot ROM
src/blue11/    the Blue-11 CPU, assembler and disassembler (standalone library)
src/simulator/ the standalone Blue-11 simulator page
src/render/    Three.js viewport (floating origin, chunk meshes, FX)
src/ui/        editor, debugger, language reference
tests/         Vitest suites for the core
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and deploys on every push to `main`.
Enable it once in the repository: **Settings → Pages → Source: GitHub Actions**.
