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
  /** Firmware write to @PROG_STATE: PROG_NONE acknowledges, PROG_READY restarts (M10). */
  setProgState(u: Unit, v: number): void;
  /** M14: a write to a device's start port (or @DRIVE_N while driving); sets @STATUS. */
  device(u: Unit, port: DevicePort, v: number): void;
}

/** M14 device start ports (docs/ASSEMBLER_CORE.md §4): writing one starts the device. */
export type DevicePort = 'TIMER' | 'DRIVE' | 'DRIVE_N' | 'RADAR' | 'TOOL' | 'REPAIR' | 'CAM' | 'SEND' | 'ERASE';

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
  { name: 'STATUS', description: 'Result of the last device start (OK = accepted, or why not), of the last WAIT on a device (how it ended), or DIV / MOD by 0 (ERR_INVALID). Each slot has its own', read: (u) => u.cpu.status },
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
    description: `Radar range in tiles (every direction, day and night; ${CHASSIS_MK1.sensorRange} on Mk-I)`,
    read: (u, c) => c.sensorRange(u),
  },
  {
    name: 'HEADING',
    description: `Direction the rover faces (NORTH..WEST). the drive turns it; write to turn in place (${BALANCE.turnEnergy} energy, wraps mod 4). The headlight shines this way`,
    read: (u) => u.heading,
    write: (u, v, c) => c.turn(u, ((v % 4) + 4) % 4),
  },

  {
    name: 'TEMP',
    description: `Internal temperature in °C. Follows the ambient slowly (${BALANCE.ambientDayC} °C in full sun, ${BALANCE.ambientNightC} °C at night); the survival heaters keep it at ${BALANCE.heaterSetpointC} °C or above`,
    read: (u) => u.temp,
  },
  { name: 'HEATER', description: `1 while the survival heaters run (${BALANCE.heaterPerTick} energy/tick: cold nights cost battery), else 0. Automatic thermostat`, read: (u) => u.heater },

  // Sun & solar
  { name: 'SUN_AZIMUTH', description: 'Sun bearing 0–359 (0 = north, 90 = east)', read: (_u, c) => c.sun.azimuth },
  { name: 'SUN_ELEV', description: 'Sun elevation in degrees; <= 0 is night', read: (_u, c) => c.sun.elevation },
  { name: 'SUN_LIGHT', description: 'Illumination 0–100 (0 at night / eclipse)', read: (_u, c) => c.sun.light },
  { name: 'SOLAR_DUST', description: 'Dust on the solar array 0–100 % (charging gets what is left). Builds up while the array is open; folding it (a full stow) shakes off half', read: (u) => u.solarDust },
  {
    name: 'SOLAR_OPEN',
    description: 'Solar array 0 = stow, 1 = deploy (takes 20 ticks; the drive refuses unless fully stowed)',
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
  ...[1, 2, 3].map(
    (n): PortDef => ({
      name: `IND${n}`,
      description: `Status lamp ${n} on the cabin roof: OFF, RED, GREEN, BLUE, AMBER (0–4). Visual only, free, survives reboots. The default firmware uses 1 for the program, 2 for charging, 3 for the uplink`,
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
  // Watchdog and fault protection (SPEC §3.9.2, §3.9.5)
  {
    name: 'WDT',
    description: `Watchdog timer. Firmware writes n > 0 to arm it and to "kick" it: if n ticks pass without another kick, the rover hard-reboots (boot reason: watchdog timeout). Once armed it cannot be switched off until a reboot (writing 0 does nothing). Read: ticks left, 0 = not armed. Firmware only`,
    min: 0,
    max: BALANCE.wdtMaxTicks,
    read: (u) => u.wdt,
    write: (u, v) => {
      if (v > 0) u.wdt = v;
    },
  },
  {
    name: 'PREEMPT',
    description: 'What ends a program slice at once (bits, add them up): PRE_ALERT a world event is announced, PRE_DAMAGE hull/array/dish lose integrity, PRE_LOW_BAT @BAT drops below @BAT_ALARM. The program is interrupted between instructions; its devices keep running (stop the drive with @DRIVE_N 0); the next CALL PROGRAM resumes it. 0 = off (reboot default). Firmware only',
    min: 0,
    max: 7,
    read: (u) => u.preemptMask,
    write: (u, v) => (u.preemptMask = v),
  },
  { name: 'BAT_ALARM', description: 'Battery threshold for PRE_LOW_BAT, 0–100 % (0 after a reboot). Firmware only', min: 0, max: 100, read: (u) => u.batAlarm, write: (u, v) => (u.batAlarm = v) },
  { name: 'PREEMPTED', description: 'The @PREEMPT conditions that ended the last program slice early (bits), 0 if it ended normally. Cleared by CALL PROGRAM', read: (u) => u.preempted },
  {
    name: 'HEADLIGHT',
    description: `Headlight 0/1 (${BALANCE.headlightPerTick} energy/tick): at night lights a cone ${BALANCE.headlightSensorRange} tiles along @HEADING (3 wide, then 5) so the operator can see and map it. SCAN does not need it`,
    min: 0,
    max: 1,
    read: (u) => u.headlight,
    write: (u, v) => (u.headlight = v),
  },

  // Devices (M14, docs/ASSEMBLER_CORE.md §4): write the start port to start, read it for the
  // work left (0 = idle), WAIT on it to sleep until done and get the result in @STATUS.
  {
    name: 'TIMER',
    description: 'Timer of this slot (each slot has its own). Write n: count down n ticks (@STATUS OK). Read: ticks left. WAIT @TIMER sleeps until 0 (the ROM\'s SLEEP)',
    min: 0,
    max: 1_000_000,
    read: (u) => u.cpu.timer,
    write: (u, v, c) => c.device(u, 'TIMER', v),
  },
  {
    name: 'DRIVE',
    description: `Drive. Write a direction: drive @DRIVE_N tiles that way (3–6 ticks and 40–120 energy per tile by terrain). @STATUS: OK, ERR_BUSY (drive, tools, repair or camera working), ERR_DEPLOYED (array not stowed), ERR_BLOCKED (first tile), ERR_LOW_POWER, ERR_INVALID. Read: tiles left (0 = idle). WAIT @DRIVE: @STATUS = how it ended (OK, ERR_BLOCKED, ERR_HAZARD, ERR_LOW_POWER, ERR_PREEMPTED = stopped)`,
    read: (u) => u.deviceLeft('drive'),
    write: (u, v, c) => c.device(u, 'DRIVE', v),
  },
  {
    name: 'DRIVE_N',
    description: 'Tiles the next drive goes (latched, 1 after a reboot). Written while driving: changes the tiles left, counting the current one; 0 stops at the end of the current tile (the drive ends with ERR_PREEMPTED)',
    min: 0,
    max: 30_000,
    read: (u) => u.driveN,
    write: (u, v, c) => c.device(u, 'DRIVE_N', v),
  },
  {
    name: 'RADAR',
    description: `Radar. Write a direction: one sweep (${BALANCE.scanTicks} tick, ${BALANCE.scanEnergy} energy; any light, does not turn the rover; works while driving). Read: 1 while sweeping. Answer in @RADAR_HIT and @RADAR_DIST (the ROM's SCAN)`,
    read: (u) => u.deviceLeft('radar'),
    write: (u, v, c) => c.device(u, 'RADAR', v),
  },
  { name: 'RADAR_HIT', description: 'First thing the last sweep found (a tile ID: obstacle, item, ROVER), NONE (0) if nothing in range', read: (u) => u.radarHit },
  { name: 'RADAR_DIST', description: 'Distance to it in tiles, 0 if nothing', read: (u) => u.radarDist },
  {
    name: 'TOOL',
    description: 'Tools. Write a hardpoint 0–3 (TOOL_0..TOOL_3): use that tool on @TOOL_ARG (a direction or cargo slot). @STATUS: OK, ERR_BUSY, ERR_NO_TOOL, ERR_INVALID, ERR_FULL, ERR_LOW_POWER. Read: ticks left. WAIT @TOOL: @STATUS = the result (the ROM\'s ACT)',
    read: (u) => u.deviceLeft('tool'),
    write: (u, v, c) => c.device(u, 'TOOL', v),
  },
  { name: 'TOOL_ARG', description: 'Argument of the next tool use: a direction or a cargo slot (latched, 0 after a reboot)', read: (u) => u.toolArg, write: (u, v) => (u.toolArg = v) },
  {
    name: 'REPAIR',
    description: 'Field repair. Write a cargo slot: repair @REPAIR_SYS with the material in it (10 ticks, 200 energy). Read: ticks left. WAIT @REPAIR: the result (the ROM\'s USE)',
    read: (u) => u.deviceLeft('repair'),
    write: (u, v, c) => c.device(u, 'REPAIR', v),
  },
  { name: 'REPAIR_SYS', description: 'System the next repair fixes: SYS_HULL, SYS_SOLAR, SYS_ANTENNA (latched, SYS_HULL after a reboot)', min: 0, max: 2, read: (u) => u.repairSys, write: (u, v) => (u.repairSys = v) },
  {
    name: 'CAM',
    description: `Mast camera. Write a direction: a photo in mode @CAM_MODE into image memory (${BALANCE.snapTicks} ticks, ${BALANCE.snapEnergy} energy; does not turn the rover). Read: ticks left. WAIT @CAM: the result (the ROM's SNAP)`,
    read: (u) => u.deviceLeft('cam'),
    write: (u, v, c) => c.device(u, 'CAM', v),
  },
  { name: 'CAM_MODE', description: 'Camera mode of the next photo, 1–5 as installed (latched, 1 after a reboot)', min: 0, max: 5, read: (u) => u.camMode, write: (u, v) => (u.camMode = v) },
  {
    name: 'SEND',
    description: `Image send. Write a photo type (0 = the mode of the last photo): image memory → the science recorder (${BALANCE.sendTicks} tick, ${BALANCE.sendEnergy} energy). @STATUS: OK, ERR_BUSY (camera exposing), ERR_FULL, ERR_INVALID, ERR_LOW_POWER. Read: ticks left`,
    min: 0,
    max: 5,
    read: (u) => u.deviceLeft('send'),
    write: (u, v, c) => c.device(u, 'SEND', v),
  },
  {
    name: 'ERASE',
    description: `Image erase. Write any value: zero image memory and forget the capture (${BALANCE.eraseTicks} ticks, ${BALANCE.eraseEnergy} energy). Read: ticks left`,
    read: (u) => u.deviceLeft('erase'),
    write: (u, v, c) => c.device(u, 'ERASE', v),
  },
  {
    name: 'SLICE',
    description: 'Program time slice. Firmware writes the ticks the next CALL PROGRAM may run (0 = no limit, the default); when they are used up, the timer interrupt returns control to the firmware. Read inside the program: ticks left. Firmware only',
    min: 0,
    max: 30_000,
    read: (u) => (u.slice >= 0 ? u.slice : u.sliceSet),
    write: (u, v) => (u.sliceSet = v),
  },
];

/**
 * Fixed machine-code port numbers 0–63 (SPEC §5.7.1): the operand byte `01pppppp`.
 * Append only: a port keeps its number forever, also if it moves in PORTS. A retired
 * port leaves an empty slot ('') that is never reused (33, 34: the old status beacon;
 * 30: `@TX_DATA`, retired in M14). M14's devices took the last free numbers (49–63); the
 * next port needs the extended operand of docs/ASSEMBLER_CORE.md §9.
 */
export const PORT_CODES: readonly string[] = [
  'BAT', 'HULL', 'SOLAR_HEALTH', 'ANTENNA_HEALTH', 'X', 'Y', 'STATUS', 'TICK',
  'GROUND', 'GROUND_HAZARD', 'CARGO_FREE', 'SCIENCE_READY', 'REC_FREE', 'ALERT', 'ALERT_ETA', 'SEISMIC_TYPE',
  'SEISMIC_DIST', 'DROPS', 'DROP_X', 'DROP_Y', 'SENSOR_RANGE', 'HEADING', 'SUN_AZIMUTH', 'SUN_ELEV',
  'SUN_LIGHT', 'SOLAR_OPEN', 'SOLAR_ANGLE', 'ORBIT_AZIMUTH', 'ANTENNA_ANGLE', 'SIGNAL_STR', '', 'LOG_FREE',
  'LOG_LOST', '', '', 'IND1', 'IND2', 'IND3', 'POST', 'PROG_STATE', 'PROG_RESULT',
  'HEADLIGHT', 'WDT', 'PREEMPT', 'BAT_ALARM', 'PREEMPTED', 'TEMP', 'HEATER', 'SOLAR_DUST',
  'TIMER', 'DRIVE', 'DRIVE_N', 'RADAR', 'RADAR_HIT', 'RADAR_DIST', 'TOOL', 'TOOL_ARG',
  'REPAIR', 'REPAIR_SYS', 'CAM', 'CAM_MODE', 'SEND', 'ERASE', 'SLICE',
];

const byName = new Map(PORTS.map((p) => [p.name, p]));

export function getPort(name: string): PortDef | undefined {
  return byName.get(name.toUpperCase().replace(/^@/, ''));
}

export function writePortClamped(p: PortDef, u: Unit, v: number, ctx: PortContext): void {
  if (!p.write) return;
  p.write(u, p.angle ? wrapDeg(v) : clamp(v, p.min ?? -2147483648, p.max ?? 2147483647), ctx);
}
