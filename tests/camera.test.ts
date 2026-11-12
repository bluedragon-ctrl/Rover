import { describe, expect, it } from 'vitest';
import { CameraRig } from '../src/render/CameraRig';

const fakeEl = { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;

describe('CameraRig leash', () => {
  it('keeps the focus within the leash radius of the rover', () => {
    const rig = new CameraRig(fakeEl);
    rig.leash = { x: 10, y: 10, r: 24 };
    rig.focusX = 100;
    rig.focusY = 10;
    rig.update(0);
    expect(rig.focusX).toBeCloseTo(34);
    expect(rig.focusY).toBeCloseTo(10);
    rig.focusX = 20;
    rig.focusY = 25;
    rig.update(0);
    expect([rig.focusX, rig.focusY]).toEqual([20, 25]); // inside: untouched
    rig.leash = null;
    rig.focusX = 500;
    rig.update(0);
    expect(rig.focusX).toBe(500);
  });
});
