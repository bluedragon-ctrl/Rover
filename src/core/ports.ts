import type { ChunkedWorld } from './ChunkedWorld';
import { type SunState, signalStrength, wrapDeg } from './Environment';
import type { Unit } from './Unit';
import type { WorldRegistry } from './WorldRegistry';
import { BALANCE, CHASSIS_MK1 } from './balance';

export interface PortContext {
  readonly tick: number;
  readonly sun: SunState;
  readonly orbitAzimuth: number;
  world: ChunkedWorld;
  registry: WorldRegistry;
  sensorRange(u: Unit): number;
  turn(u: Unit, dir: number): void;
  alert(): { type: number; eta: number };
  drops(): { x: number; y: number }[];
  nearestDrop(u: Unit): { x: number; y: number } | null;
  transmit(u: Unit, value: number): void;
  /** Firmware write to @PROG_STATE: PROG_NONE acknowledges, PROG_READY restarts (M10). */
  setProgState(u: Unit, v: number): void;
}

export interface PortDef {
  name: string; // without '@'
  description: string;
  read?: (u: Unit, ctx: PortContext) => number;
  write?: (u: Unit, v: number, ctx: PortContext) => void;
  min?: number;
  max?: number;
  /** Angle port: writes wrap modulo 360 instead of clamping. */
  angle?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Memory-mapped I/O. Add a port here and it is instantly usable from Rover-ASM. */
export const PORTS: PortDef[] = [
  // Telemetry
  { name: 'BAT', description: 'Battery 0–100 %', read: (u) => u.batteryPercent },
  { name: 'HULL', description: 'Hull integrity 0–100', read: (u) => u.hull },
  { name: 'SOLAR_HEALTH', description: 'Solar array integrity 0–100 (scales charging)', read: (u) => u.solarHealth },
  { name: 'ANTENNA_HEALTH', description: 'Dish integrity 0–100 (scales signal)', read: (u) => u.antennaHealth },
  { name: 'X', description: 'World X (east +)', read: (u) => u.x },
  { name: 'Y', description: 'World Y (north +)', read: (u) => u.y },
  { name: 'STATUS', description: 'Result of last hardware op / TX (OK, ERR_*)', read: (u) => u.cpu.status },
  { name: 'TICK', description: 'Ticks since world start', read: (_u, c) => c.tick },
  { name: 'GROUND', description: 'Terrain tile under rover', read: (u, c) => c.world.getTile(u.x, u.y, 0) },
  {
    name: 'GROUND_HAZARD',
    description: 'Hazard level of terrain under rover 0–2',
    read: (u, c) => c.registry.get(c.world.getTile(u.x, u.y, 0))?.hazardLevel ?? 0,
  },
  { name: 'CARGO_FREE', description: 'Number of empty cargo slots', read: (u) => u.cargo.filter((c) => c === 0).length },
  { name: 'SCIENCE_READY', description: 'Science products in the recorder waiting for the downlink', read: (u) => u.link.products.length },
  { name: 'REC_FREE', description: 'Free bytes in the science recorder (a spectrum needs 18, a Mk-I photo 258)', read: (u) => u.link.recFree(u.chassis.recorderBytes) },
  { name: 'ALERT', description: 'Announced/active world event: ALERT_NONE, ALERT_ECLIPSE, ALERT_SQUALL', read: (_u, c) => c.alert().type },
  { name: 'ALERT_ETA', description: 'Ticks until the alerted event starts (0 = active or none)', read: (_u, c) => c.alert().eta },
  { name: 'SEISMIC_TYPE', description: 'Ore found by the last seismic scan (TOOL_3), 0 = none', read: (u) => u.seismicType },
  { name: 'SEISMIC_DIST', description: 'Distance to that ore, 0 = none', read: (u) => u.seismicDist },
  { name: 'DROPS', description: 'Supply crates that have landed and wait to be picked up', read: (_u, c) => c.drops().length },
  { name: 'DROP_X', description: 'X of the nearest landed supply crate (own X if none)', read: (u, c) => c.nearestDrop(u)?.x ?? u.x },
  { name: 'DROP_Y', description: 'Y of the nearest landed supply crate (own Y if none)', read: (u, c) => c.nearestDrop(u)?.y ?? u.y },
  {
    name: 'SENSOR_RANGE',
    description: `SCAN range in tiles (radar: every direction, day and night; ${CHASSIS_MK1.sensorRange} on Mk-I)`,
    read: (u, c) => c.sensorRange(u),
  },
  {
    name: 'HEADING',
    description: `Direction the rover faces (NORTH..WEST). STEP turns it; write to turn in place (${BALANCE.turnEnergy} energy, wraps mod 4). The headlight shines this way`,
    read: (u) => u.heading,
    write: (u, v, c) => c.turn(u, ((v % 4) + 4) % 4),
  },

  // Sun & solar
  { name: 'SUN_AZIMUTH', description: 'Sun bearing 0–359 (0 = north, 90 = east)', read: (_u, c) => c.sun.azimuth },
  { name: 'SUN_ELEV', description: 'Sun elevation in degrees; <= 0 is night', read: (_u, c) => c.sun.elevation },
  { name: 'SUN_LIGHT', description: 'Illumination 0–100 (0 at night / eclipse)', read: (_u, c) => c.sun.light },
  {
    name: 'SOLAR_OPEN',
    description: 'Solar array 0 = stow, 1 = deploy (takes 20 ticks; blocks STEP unless fully stowed)',
    min: 0,
    max: 1,
    read: (u) => u.solarOpen,
    write: (u, v) => (u.solarOpen = v),
  },
  {
    name: 'SOLAR_ANGLE',
    description: 'Panel bearing 0–359. Write sets target; read gives current (slews 3°/tick)',
    angle: true,
    read: (u) => u.solarAngle,
    write: (u, v) => (u.solarTarget = v),
  },

  // Comms
  { name: 'ORBIT_AZIMUTH', description: 'Relay orbiter bearing 0–359', read: (_u, c) => c.orbitAzimuth },
  {
    name: 'ANTENNA_ANGLE',
    description: 'Dish bearing 0–359. Write sets target; read gives current (slews 3°/tick)',
    angle: true,
    read: (u) => u.antennaAngle,
    write: (u, v) => (u.antennaTarget = v),
  },
  { name: 'SIGNAL_STR', description: 'Uplink quality 0–100 (dish alignment × dish health)', read: (u, c) => Math.floor((signalStrength(u.antennaAngle, c.orbitAzimuth) * u.antennaHealth) / 100) },
  { name: 'TX_DATA', description: 'Old shorthand for LOG 0 value: queues a log frame; sets @STATUS (OK, ERR_FULL if the FIFO had no room)', write: (u, v, c) => c.transmit(u, v) },
  {
    name: 'LOG_FREE',
    description: 'Free bytes in the log FIFO (LOG frames wait here for the downlink)',
    read: (u) => u.link.free(u.chassis.logFifoBytes),
  },
  {
    name: 'LOG_LOST',
    description: 'LOG frames dropped because the FIFO was full, since boot (saturates at 255; write to set, usually 0)',
    min: 0,
    max: 255,
    read: (u) => u.link.lost,
    write: (u, v) => (u.link.lost = v),
  },

  // Lights
  { name: 'LIGHT_COLOR', description: 'Status beacon color 0–4', min: 0, max: 4, read: (u) => u.lightColor, write: (u, v) => (u.lightColor = v) },
  { name: 'LIGHT_BLINK', description: 'Beacon blink 0/1', min: 0, max: 1, read: (u) => u.lightBlink, write: (u, v) => (u.lightBlink = v) },
  ...[1, 2, 3].map(
    (n): PortDef => ({
      name: `IND${n}`,
      description: `Indicator lamp ${n} on the cabin roof: OFF, RED, GREEN, BLUE, AMBER (0–4). Visual only, free, survives reboots`,
      min: 0,
      max: 4,
      read: (u) => u.indicators[n - 1],
      write: (u, v) => (u.indicators[n - 1] = v),
    }),
  ),
  {
    name: 'POST',
    description: 'Two-digit hex display on the back of the cabin, like a PC POST card (0–255, shown as 00–FF). Visual only, free, no @STATUS, survives reboots; the operator reads it when the rover is in view',
    min: 0,
    max: 255,
    read: (u) => u.post,
    write: (u, v) => (u.post = v),
  },
  // Firmware + program (M10, SPEC §3.9.2)
  {
    name: 'PROG_STATE',
    description:
      'Program state: PROG_NONE, PROG_READY, PROG_RUNNING, PROG_DONE, PROG_FAULT, PROG_HALTED. Firmware only: write PROG_NONE to acknowledge, PROG_READY to restart the program from the top',
    min: 0,
    max: 5,
    read: (u) => u.progState,
    write: (u, v, c) => c.setProgState(u, v),
  },
  { name: 'PROG_RESULT', description: 'Value of the program\'s last END (0 after a restart)', read: (u) => u.progResult },
  {
    name: 'HEADLIGHT',
    description: `Headlight 0/1 (${BALANCE.headlightPerTick} energy/tick): at night lights a cone ${BALANCE.headlightSensorRange} tiles along @HEADING (3 wide, then 5) so the operator can see and map it. SCAN does not need it`,
    min: 0,
    max: 1,
    read: (u) => u.headlight,
    write: (u, v) => (u.headlight = v),
  },
];

const byName = new Map(PORTS.map((p) => [p.name, p]));

export function getPort(name: string): PortDef | undefined {
  return byName.get(name.toUpperCase().replace(/^@/, ''));
}

export function writePortClamped(p: PortDef, u: Unit, v: number, ctx: PortContext): void {
  if (!p.write) return;
  p.write(u, p.angle ? wrapDeg(v) : clamp(v, p.min ?? -2147483648, p.max ?? 2147483647), ctx);
}
