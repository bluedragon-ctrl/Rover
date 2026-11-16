import { describe, expect, it } from 'vitest';

/** Every source file of the library, as text (new files are picked up automatically). */
const FILES = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
/** The examples and the package manifest. */
const EXAMPLE_FILES = import.meta.glob('../examples/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PKG = (import.meta.glob('../package.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)['../package.json'];
const entries = Object.entries(FILES).map(([path, src]) => [path.split('/').pop()!, src] as const);

describe('pdp11 library boundary', () => {
  it('finds the library files', () => {
    expect(entries.map(([f]) => f)).toContain('cpu.ts');
  });

  it('imports nothing from outside its folder', () => {
    for (const [f, src] of entries) {
      for (const m of src.matchAll(/(?:import|export)[^'";]*from\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        // The CodeMirror mode is a separate, optional entry point.
        const optional = f === 'codemirror.ts' && /^@(codemirror|lezer)\//.test(spec);
        expect(optional || (spec.startsWith('./') && !spec.includes('..')), `${f} imports ${spec}`).toBe(true);
      }
    }
  });

  it('index.ts does not pull in the optional CodeMirror mode', () => {
    const index = entries.find(([f]) => f === 'index.ts')![1];
    expect(index).not.toMatch(/codemirror/);
  });

  it('follows the core rules: no DOM, no randomness, no wall-clock time, no float trig', () => {
    for (const [f, src] of entries) {
      if (f === 'codemirror.ts') continue;
      expect(src, f).not.toMatch(/Math\.(random|sin|cos)|Date\.now|new Date|performance\.now|document\.|window\./);
    }
  });

  it('examples import only the package itself and follow the same rules', () => {
    const ex = Object.entries(EXAMPLE_FILES);
    expect(ex.length).toBeGreaterThan(0);
    for (const [path, src] of ex) {
      for (const m of src.matchAll(/(?:import|export)[^'";]*from\s*['"]([^'"]+)['"]/g))
        expect(m[1] === '../src' || m[1].startsWith('./'), `${path} imports ${m[1]}`).toBe(true);
      expect(src, path).not.toMatch(/Math\.(random|sin|cos)|Date\.now|new Date|performance\.now|document\.|window\./);
    }
  });

  it('the package declares its entry points and no runtime dependencies', () => {
    const pkg = JSON.parse(PKG) as { exports: Record<string, string>; dependencies?: object };
    expect(Object.keys(pkg.exports)).toEqual(['.', './codemirror', './examples']);
    expect(pkg.dependencies).toBeUndefined();
  });
});
