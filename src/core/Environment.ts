import { BALANCE } from './balance';

/**
 * Integer trig: sin/cos of whole degrees scaled by 1000. Values are rounded at module
 * load, so tiny last-bit differences between JS engines cannot leak into the sim.
 */
const SIN1000 = new Int16Array(360);
for (let d = 0; d < 360; d++) SIN1000[d] = Math.round(Math.sin((d * Math.PI) / 180) * 1000);

export const wrapDeg = (d: number): number => ((Math.trunc(d) % 360) + 360) % 360;
export const sin1000 = (deg: number): number => SIN1000[wrapDeg(deg)];
export const cos1000 = (deg: number): number => SIN1000[wrapDeg(deg + 90)];

/** Smallest absolute angle between two compass bearings, 0..180. */
export function angleDiff(a: number, b: number): number {
  const d = wrapDeg(a - b);
  return d > 180 ? 360 - d : d;
}

export interface SunState {
  /** Compass bearing 0..359 (0 = north, 90 = east). */
  azimuth: number;
  /** -maxElev..maxElev degrees; > 0 means day. */
  elevation: number;
  /** 0..100 effective illumination (includes eclipses). */
  light: number;
}

/**
 * Deterministic sky: sun and relay orbiter positions are pure functions of the tick.
 * Eclipses and other events plug in through `lightFactor` (0..100). [M6]
 */
export class Environment {
  lightFactor = 100;

  /** Sun position ignoring eclipses (used by the storyteller to plan). */
  sunRaw(tick: number): SunState {
    const f = this.lightFactor;
    this.lightFactor = 100;
    const s = this.sun(tick);
    this.lightFactor = f;
    return s;
  }

  sun(tick: number): SunState {
    const { dayTicks, sunStartPhase, sunMaxElev } = BALANCE;
    const phaseDeg = Math.floor(((tick + Math.floor((sunStartPhase * dayTicks) / 360)) % dayTicks) * 360 / dayTicks);
    // phase 0 = sunrise in the east, 90 = noon in the south, 180 = sunset in the west.
    const azimuth = wrapDeg(90 + phaseDeg);
    const elevation = Math.round((sunMaxElev * sin1000(phaseDeg)) / 1000);
    const raw = elevation > 0 ? Math.round(sin1000(elevation) / 10) : 0;
    const light = Math.floor((raw * this.lightFactor) / 100);
    return { azimuth, elevation, light };
  }

  orbitAzimuth(tick: number): number {
    return wrapDeg(BALANCE.orbitStartAzimuth + Math.floor((tick * 360) / BALANCE.orbitTicks));
  }

  dayNumber(tick: number): number {
    return Math.floor((tick + Math.floor((BALANCE.sunStartPhase * BALANCE.dayTicks) / 360)) / BALANCE.dayTicks) + 1;
  }
}

/** Antenna gain: cos^4 of the pointing error, 0..100. 50 % at ~33° off. */
export function signalStrength(antennaAngle: number, orbitAzimuth: number): number {
  const c = cos1000(angleDiff(antennaAngle, orbitAzimuth));
  if (c <= 0) return 0;
  const c2 = (c * c) / 1000;
  return Math.round((c2 * c2) / 10_000);
}

/** Solar output per tick in energy units. */
export function solarGain(panelAngle: number, sun: SunState): number {
  if (sun.light <= 0) return 0;
  const c = cos1000(angleDiff(panelAngle, sun.azimuth));
  if (c <= 0) return 0;
  return Math.floor((BALANCE.solarMaxPerTick * sun.light * c) / 100_000);
}
