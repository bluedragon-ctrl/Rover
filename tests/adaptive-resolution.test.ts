import { describe, expect, it } from 'vitest';
import { AdaptiveResolution } from '../src/render/AdaptiveResolution';

describe('AdaptiveResolution', () => {
  it('steps down when GPU-bound and slow, not when CPU-bound', () => {
    const a = new AdaptiveResolution(2);
    expect(a.update(1000, 30, 25, 60)).toBeNull(); // still settling after start
    expect(a.update(3000, 30, 25, 60)).toBeNull(); // slow but CPU-bound: fewer pixels won't help
    expect(a.update(3000, 30, 5, 60)).toBe(1.75);
    expect(a.update(4000, 30, 5, 60)).toBeNull(); // settling
    expect(a.update(6000, 30, 5, 10)).toBeNull(); // too few samples
    expect(a.update(6000, 30, 5, 60)).toBe(1.5);
  });

  it('never goes below min and steps back up after sustained full frame rate', () => {
    const a = new AdaptiveResolution(1.5, 1);
    let t = 3000;
    a.update(t, 40, 2, 60);
    a.update((t += 3000), 40, 2, 60);
    expect(a.ratio).toBe(1);
    expect(a.update((t += 3000), 40, 2, 60)).toBeNull();
    // Comfortable, but 1.25 was too slow recently: stays put until that is forgotten.
    for (let i = 0; i < 10; i++) a.update((t += 3000), 16.7, 2, 60);
    expect(a.ratio).toBe(1);
    // Once forgotten, the long comfortable stretch allows the step right away.
    expect(a.update((t += 60000), 16.7, 2, 60)).toBe(1.25);
    // The next step needs a fresh comfortable stretch.
    expect(a.update((t += 3000), 16.7, 2, 60)).toBeNull();
    expect(a.update((t += 9000), 16.7, 2, 60)).toBe(1.5);
  });

  it('does not change when frames are comfortable at max', () => {
    const a = new AdaptiveResolution(2);
    for (let t = 3000; t < 60000; t += 1000) expect(a.update(t, 16.7, 3, 60)).toBeNull();
    expect(a.ratio).toBe(2);
  });
});
