# Rover

A browser sandbox game: program an autonomous planetary rover in a tiny stack-based
assembly language (**Rover-ASM**) and watch it explore an infinite, procedurally
generated world rendered as vector wireframes.

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
  vm/          Rover-ASM compiler and VM
src/render/    Three.js viewport (floating origin, chunk meshes, FX)
src/ui/        editor, debugger, language reference
tests/         Vitest suites for the core
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and deploys on every push to `main`.
Enable it once in the repository: **Settings → Pages → Source: GitHub Actions**.
