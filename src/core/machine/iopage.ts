/**
 * M15 I/O page (docs/BLUE11_IO.md §3): Rover's devices as DEC-style registers at fixed
 * addresses. The device logic is unchanged (SimulationEngine.device(), Unit.deviceLeft(),
 * the world); this table is only the face the CPU sees. Add a register here and it appears
 * as a predefined symbol (symbols.ts).
 */

import { BALANCE, BLUE11 } from '../balance';
import type { ChunkedWorld } from '../ChunkedWorld';
import { signalStrength, wrapDeg, type SunState } from '../Environment';
import { ProgState, Status } from '../types';
import type { WorldRegistry } from '../WorldRegistry';
import type { Device, Unit } from '../Unit';
import { MsgType, parseStream } from '../messages';

/** What the device registers need from the world and the engine (SimulationEngine.ioCtx). */
export interface IoContext {
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
  /** Firmware write to `PRGST`: P.NONE acknowledges, P.RDY restarts the program. */
  setProgState(u: Unit, v: number): void;
  /** A device start (or a `DRVCNT` write while driving): SimulationEngine.device(). */
  device(u: Unit, start: DeviceStart, v: number): void;
}

/** What a device block's GO (or `DRVCNT`) asks the engine to do. */
export type DeviceStart = 'DRIVE' | 'DRIVE_N' | 'RADAR' | 'TOOL' | 'REPAIR' | 'CAM' | 'ERASE';

/** RO read-only, RW read/write, WO write-only (reads 0), FW written by the firmware only (the program may read). */
export type Access = 'RO' | 'RW' | 'WO' | 'FW';

/** CSR bits (BLUE11_IO.md §3.1). */
export const CSR = { GO: 0o1, FN: 0o16, IE: 0o100, DONE: 0o200, ERR: 0o100000 } as const;

/** The six devices with a CSR, each a block of eight words from `base`. */
export type DevKey = 'drv' | 'rad' | 'tol' | 'rep' | 'cam' | 'img';
export interface DeviceBlock {
  key: DevKey;
  prefix: string;
  base: number;
  vector: number;
  title: string;
}
export const DEVICE_BLOCKS: readonly DeviceBlock[] = [
  { key: 'drv', prefix: 'DRV', base: 0o176400, vector: 0o120, title: 'Drive' },
  { key: 'rad', prefix: 'RAD', base: 0o176420, vector: 0o124, title: 'Radar' },
  { key: 'tol', prefix: 'TOL', base: 0o176440, vector: 0o130, title: 'Tools' },
  { key: 'rep', prefix: 'REP', base: 0o176460, vector: 0o134, title: 'Repair' },
  { key: 'cam', prefix: 'CAM', base: 0o176500, vector: 0o140, title: 'Camera' },
  { key: 'img', prefix: 'IMG', base: 0o176520, vector: 0o144, title: 'Image' },
];
export const TX_VECTOR = 0o150;
export const CLOCK_VECTOR = 0o100;
/** Device interrupts request at level 4, the line clock at 6 (BLUE11_CPU.md §8). */
export const DEVICE_LEVEL = 4;
export const CLOCK_LEVEL = 6;

/** `BOOTCS` bit 8: safe mode latched. */
export const BOOT_SAFE = 0o400;

/** `PRGCS` bits 3–1: why the last program run ended (BLUE11_IO.md §3.7). */
export const Why = { NONE: 0, DONE: 1, TIME: 2, PRE: 3, FLT: 4, BPT: 5 } as const;
/** `PRGER`: program fault codes. */
export const ProgFault = { ODD: 1, NXM: 2, PRO: 3, STK: 4, ILL: 5, IOT: 6, EMT: 7, TRP: 8 } as const;
export const PROG_FAULT_NAMES: Record<number, string> = {
  1: 'odd address', 2: 'no memory there', 3: 'write-protected', 4: 'stack overflow',
  5: 'illegal instruction', 6: 'IOT', 7: 'EMT', 8: 'TRAP without a handler',
};

/** One device's latched CSR state. `done` is the DONE bit last seen (for the edge), `ev` an interrupt event waiting. */
export interface DevLatch {
  fn: number;
  ie: boolean;
  done: boolean;
  ev: boolean;
  /** Parameter registers (+4 and, for the drive, +6 is DRVCNT on the unit). */
  arg: number;
}

/** Register state the CPU latched (saved; reset by a hard reboot or `RESET`). */
export interface IoState {
  dev: Record<DevKey, DevLatch>;
  /** Image device: which function ran last (its result is `IMGER`). */
  imgLast: 'send' | 'erase';
  /** `TICKH` as frozen by the last `TICKL` read. */
  tickH: number;
  /** `LKS`: bit 7 a tick passed, bit 6 IE. */
  lks: number;
  tx: { ie: boolean; ready: boolean; ev: boolean };
  /** `PRGCS` why / err, `PRGER`, `PRGPC`. */
  prg: { why: number; err: boolean; code: number; pc: number };
}

export function freshIo(): IoState {
  const latch = (): DevLatch => ({ fn: 0, ie: false, done: true, ev: false, arg: 0 });
  return {
    dev: { drv: latch(), rad: latch(), tol: latch(), rep: latch(), cam: latch(), img: latch() },
    imgLast: 'send',
    tickH: 0,
    lks: 0,
    tx: { ie: false, ready: true, ev: false },
    prg: { why: 0, err: false, code: 0, pc: 0 },
  };
}

/** What a register needs from its machine. */
export interface IoHost {
  readonly u: Unit;
  readonly ctx: IoContext;
  readonly io: IoState;
  /** The program's registers are loaded (FW registers refuse its writes). */
  readonly program: boolean;
  /** `PRGCS` GO from the firmware. */
  gate(): void;
  /** `REBOOT`: hard reboot after this instruction with this boot reason. */
  reboot(reason: number): void;
  /** The firmware's stack limit (`STKLIM`). */
  fwStackLimit: number;
  /** A device event (refused start, IE set while DONE): interrupt now if enabled. */
  raise(key: DevKey): void;
  /** A start was accepted: its pending interrupt goes. */
  started(key: DevKey): void;
}

export interface IoRegister {
  addr: number;
  name: string;
  access: Access;
  description: string;
  /** 16-bit value (signed values come back as two's complement). */
  read?: (h: IoHost) => number;
  write?: (h: IoHost, v: number) => void;
  /** A second address for a register named elsewhere (no symbol of its own). */
  alias?: true;
}

const s16 = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Which unit device a block's DONE and result come from. */
function unitDevice(h: IoHost, key: DevKey): Device {
  switch (key) {
    case 'drv': return 'drive';
    case 'rad': return 'radar';
    case 'tol': return 'tool';
    case 'rep': return 'repair';
    case 'cam': return 'cam';
    default: return h.io.imgLast;
  }
}

/** DONE: the device is idle (finished, or never started). */
export function deviceDone(u: Unit, io: IoState, key: DevKey): boolean {
  if (key === 'img') return u.deviceLeft('send') === 0 && u.deviceLeft('erase') === 0;
  return u.deviceLeft(unitDevice({ io } as IoHost, key)) === 0;
}

function csrRead(h: IoHost, key: DevKey): number {
  const l = h.io.dev[key];
  const done = deviceDone(h.u, h.io, key);
  const err = done && h.u.results[unitDevice(h, key)] !== Status.OK;
  return (err ? CSR.ERR : 0) | (done ? CSR.DONE : 0) | (l.ie ? CSR.IE : 0) | (l.fn << 1);
}

/** Start a device with its latched parameters (GO). */
function start(h: IoHost, key: DevKey): void {
  const { u, ctx, io } = h;
  const l = io.dev[key];
  switch (key) {
    case 'drv':
      ctx.device(u, 'DRIVE', l.arg);
      break;
    case 'rad':
      ctx.device(u, 'RADAR', l.arg);
      break;
    case 'tol':
      ctx.device(u, 'TOOL', l.fn);
      break;
    case 'rep':
      u.repairSys = l.fn;
      ctx.device(u, 'REPAIR', l.arg);
      break;
    case 'cam':
      u.camMode = l.fn;
      ctx.device(u, 'CAM', l.arg);
      break;
    case 'img':
      if (l.fn === 2) {
        io.imgLast = 'erase';
        ctx.device(u, 'ERASE', l.arg);
      } else {
        // FN 1 (the camera's send) is retired on this core: the ROM's SNDIMG frames the photo
        // into the recorder instead (BLUE11_IO.md §3.5a). Anything else is invalid.
        io.imgLast = 'send';
        u.results.send = Status.ERR_INVALID;
      }
      break;
  }
  if (deviceDone(u, io, key)) h.raise(key); // refused: DONE stays 1, ERR = 1, in this instruction
  else {
    if (key === 'drv') u.driveN = 0; // DRVCNT counts down; it reads 0 after the drive
    h.started(key);
  }
}

function csrWrite(h: IoHost, key: DevKey, v: number, hasFn: boolean): void {
  const l = h.io.dev[key];
  if (hasFn) l.fn = (v >> 1) & 7;
  if (!h.program) {
    const ie = (v & CSR.IE) !== 0;
    const raise = ie && !l.ie && deviceDone(h.u, h.io, key);
    l.ie = ie;
    if (raise) h.raise(key);
  }
  if (v & CSR.GO) start(h, key);
}

function deviceRegisters(b: DeviceBlock): IoRegister[] {
  const { key, prefix: p, base } = b;
  const hasFn = key !== 'drv' && key !== 'rad';
  const fnText: Record<DevKey, string> = {
    drv: '', rad: '',
    tol: ' FN (bits 3–1): hardpoint F.T0…F.T3.',
    rep: ' FN: system F.HULL, F.SOL, F.ANT.',
    cam: ' FN: camera mode F.M1…F.M5.',
    img: ' FN: F.ERAS (zero image memory). Photos go home through the recorder (ROM SNDIMG).',
  };
  const left = (d: Device) => (h: IoHost) => h.u.deviceLeft(d);
  const regs: IoRegister[] = [
    {
      addr: base,
      name: `${p}CS`,
      access: 'RW',
      description: `${b.title} control/status: GO (bit 0) starts it, DONE (bit 7) idle, ERR (bit 15) refused or failed, IE (bit 6, firmware) interrupt at vector ${b.vector.toString(8)}.${fnText[key]}`,
      read: (h) => csrRead(h, key),
      write: (h, v) => csrWrite(h, key, v, hasFn),
    },
    { addr: base + 2, name: `${p}ER`, access: 'RO', description: `${b.title} error: OK or why the last start was refused or the last run failed (E.…)`, read: (h) => h.u.results[unitDevice(h, key)] },
  ];
  const arg = (name: string, description: string, max = 0xffff): IoRegister => ({
    addr: base + 4,
    name,
    access: 'RW',
    description,
    read: (h) => h.io.dev[key].arg,
    write: (h, v) => (h.io.dev[key].arg = clamp(v, 0, max)),
  });
  switch (key) {
    case 'drv':
      regs.push(
        arg('DRVDIR', 'Direction of the next drive: NORTH…WEST'),
        {
          addr: base + 6,
          name: 'DRVCNT',
          access: 'RW',
          description: 'Tiles to drive; counts down while driving and reads 0 after the drive. Written while driving: the tiles left; 0 stops at the end of this tile (E.PRE)',
          read: (h) => {
            const a = h.u.action;
            if (a?.kind === 'STEP') return a.stop ? 0 : a.tilesLeft;
            return h.u.driveN;
          },
          write: (h, v) => {
            const driving = h.u.action?.kind === 'STEP';
            h.ctx.device(h.u, 'DRIVE_N', clamp(v, 0, 30_000));
            if (driving) h.u.driveN = 0;
          },
        },
      );
      break;
    case 'rad':
      regs.push(
        arg('RADDIR', 'Direction of the next sweep'),
        { addr: base + 6, name: 'RADHIT', access: 'RO', description: 'First thing the last sweep found (a tile), NONE if nothing', read: (h) => h.u.radarHit },
        { addr: base + 8, name: 'RADDST', access: 'RO', description: 'Its distance in tiles, 0 if nothing', read: (h) => h.u.radarDist },
      );
      break;
    case 'tol':
      regs.push(
        {
          addr: base + 4,
          name: 'TOLARG',
          access: 'RW',
          description: 'Argument of the next tool use: a direction or a cargo slot',
          read: (h) => h.u.toolArg,
          write: (h, v) => (h.u.toolArg = v & 0xffff),
        },
        { addr: base + 6, name: 'TOLLFT', access: 'RO', description: 'Ticks left of the tool use', read: left('tool') },
        { addr: base + 8, name: 'SEITYP', access: 'RO', description: 'Ore found by the last seismic scan (F.T3), 0 = none', read: (h) => h.u.seismicType },
        { addr: base + 10, name: 'SEIDST', access: 'RO', description: 'Distance to it, 0 = none', read: (h) => h.u.seismicDist },
      );
      break;
    case 'rep':
      regs.push(arg('REPSLT', 'Cargo slot with the repair material'), { addr: base + 6, name: 'REPLFT', access: 'RO', description: 'Ticks left of the repair', read: left('repair') });
      break;
    case 'cam':
      regs.push(arg('CAMDIR', 'Direction of the next photo'), { addr: base + 6, name: 'CAMLFT', access: 'RO', description: 'Ticks left of the exposure', read: left('cam') });
      break;
    case 'img':
      regs.push(
        { addr: base + 4, name: 'IMGTYP', access: 'RO', description: 'Mode of the last photo the camera took (1–5): ROM SNDIMG with R0 = 0 sends that', read: (h) => h.u.snapMode },
        { addr: base + 6, name: 'IMGLFT', access: 'RO', description: 'Ticks left of the erase', read: (h) => h.u.deviceLeft('send') || h.u.deviceLeft('erase') },
        { addr: base + 8, name: 'IMGSIZ', access: 'RO', description: 'Bytes of image memory the installed camera has (from IMGBAS)', read: (h) => h.u.imageMemory().length },
      );
      break;
  }
  return regs;
}

type Read = (u: Unit, c: IoContext) => number;

/** Telemetry (176000, read-only). */
const TELEMETRY: Array<[name: string, read: Read | null, description: string]> = [
  ['BAT', (u) => u.batteryPercent, 'Battery 0–100 %'],
  ['HULL', (u) => u.hull, 'Hull integrity 0–100'],
  ['SOLHLT', (u) => u.solarHealth, 'Solar array integrity 0–100 (scales charging)'],
  ['ANTHLT', (u) => u.antennaHealth, 'Dish integrity 0–100 (scales signal)'],
  ['X', (u) => u.x, 'World X (east +), signed'],
  ['Y', (u) => u.y, 'World Y (north +), signed'],
  ['TICKL', null, 'Ticks since world start, low word; reading it freezes TICKH'],
  ['TICKH', null, 'High word of the tick counter, as frozen by the last TICKL read'],
  ['GROUND', (u, c) => c.world.getTile(u.x, u.y, 0), 'Terrain tile under the rover'],
  ['GNDHAZ', (u, c) => c.registry.get(c.world.getTile(u.x, u.y, 0))?.hazardLevel ?? 0, 'Hazard level of the terrain under the rover 0–2'],
  ['TEMP', (u) => u.temp, `Internal temperature in °C, signed (${BALANCE.ambientDayC} °C in full sun, ${BALANCE.ambientNightC} °C at night; the heaters hold ${BALANCE.heaterSetpointC} °C)`],
  ['HEATER', (u) => u.heater, `1 while the survival heaters run (${BALANCE.heaterPerTick} energy a tick)`],
  ['CRGFRE', (u) => u.cargo.filter((c) => c === 0).length, 'Empty cargo slots'],
  ['SCIRDY', (u) => u.link.products.length, 'Science products waiting for the downlink'],
  ['RECFRE', null, 'Free recorder bytes'],
  ['RADRNG', (u, c) => c.sensorRange(u), 'Radar range in tiles'],
  ['ALERT', (_u, c) => c.alert().type, 'Announced or active world event: A.NONE, A.ECL, A.SQL'],
  ['ALRETA', (_u, c) => c.alert().eta, 'Ticks until it starts'],
  ['DROPS', (_u, c) => c.drops().length, 'Landed supply crates'],
  ['DROPX', (u, c) => c.nearestDrop(u)?.x ?? u.x, 'X of the nearest landed crate (own X if none), signed'],
  ['DROPY', (u, c) => c.nearestDrop(u)?.y ?? u.y, 'Y of the nearest landed crate, signed'],
  ['SUNAZ', (_u, c) => c.sun.azimuth, 'Sun bearing 0–359'],
  ['SUNEL', (_u, c) => c.sun.elevation, 'Sun elevation in degrees, signed (<= 0 is night)'],
  ['SUNLIT', (_u, c) => c.sun.light, 'Illumination 0–100'],
  ['SOLDST', (u) => u.solarDust, 'Dust on the solar array 0–100 %'],
  ['ORBAZ', (_u, c) => c.orbitAzimuth, 'Relay orbiter bearing 0–359'],
  ['SIGNAL', (u, c) => Math.floor((signalStrength(u.antennaAngle, c.orbitAzimuth) * u.antennaHealth) / 100), 'Uplink quality 0–100'],
];

/** Actuators (176200, read/write): read, write (already wrapped or clamped), and the clamp range or 'angle'. */
const ACTUATORS: Array<[name: string, read: (u: Unit) => number, write: (u: Unit, v: number, c: IoContext) => void, range: [number, number] | 'angle', description: string]> = [
  ['HDG', (u) => u.heading, (u, v, c) => c.turn(u, ((v % 4) + 4) % 4), [-32768, 32767], `Direction the rover faces; write turns in place (${BALANCE.turnEnergy} energy, wraps mod 4)`],
  ['LIGHT', (u) => u.headlight, (u, v) => (u.headlight = v), [0, 1], `Headlight 0 / 1 (${BALANCE.headlightPerTick} energy a tick)`],
  ['SOLOPN', (u) => u.solarOpen, (u, v) => (u.solarOpen = v), [0, 1], 'Solar array 0 stow, 1 deploy'],
  ['SOLANG', (u) => u.solarAngle, (u, v) => (u.solarTarget = v), 'angle', 'Panel bearing: write the target, read the current one'],
  ['ANTANG', (u) => u.antennaAngle, (u, v) => (u.antennaTarget = v), 'angle', 'Dish bearing: write the target, read the current one'],
  ...[1, 2, 3].map((n): (typeof ACTUATORS)[number] => [`IND${n}`, (u) => u.indicators[n - 1], (u, v) => (u.indicators[n - 1] = v), [0, 4], n === 1 ? 'Status lamp 1: OFF, RED, GREEN, BLUE, AMBER' : `Status lamp ${n}`]),
];

function telemetryAndActuators(): IoRegister[] {
  const regs: IoRegister[] = [];
  TELEMETRY.forEach(([name, read, description], i) => {
    const addr = 0o176000 + 2 * i;
    if (name === 'TICKL') {
      regs.push({
        addr, name, access: 'RO', description,
        read: (h) => {
          h.io.tickH = Math.floor(h.ctx.tick / 65536) & 0xffff;
          return h.ctx.tick & 0xffff;
        },
      });
    } else if (name === 'TICKH') regs.push({ addr, name, access: 'RO', description, read: (h) => h.io.tickH });
    else if (name === 'RECFRE') regs.push({ addr, name, access: 'RO', description: `${description} (the same as RECFRE in the recorder block, 176554)`, read: recFree, alias: true });
    else regs.push({ addr, name, access: 'RO', description, read: (h) => read!(h.u, h.ctx) });
  });
  ACTUATORS.forEach(([name, read, write, range, description], i) => {
    regs.push({
      addr: 0o176200 + 2 * i,
      name,
      access: 'RW',
      description,
      read: (h) => read(h.u),
      write: (h, v) => {
        const x = range === 'angle' || name === 'HDG' ? s16(v) : v; // bearings and the heading are signed
        write(h.u, range === 'angle' ? wrapDeg(x) : clamp(x, range[0], range[1]), h.ctx);
      },
    });
  });
  return regs;
}

/** Program control and watchdog (177000, firmware writes; BLUE11_IO.md §3.7). */
const CONTROL: IoRegister[] = [
  {
    addr: 0o177000,
    name: 'PRGCS',
    access: 'FW',
    description: 'Program control. Write GO: the gate, run the program. Read: bits 3–1 why the last run ended (W.…), bit 15 the gate was refused (not P.RDY)',
    read: (h) => (h.io.prg.err ? CSR.ERR : 0) | (h.io.prg.why << 1),
    write: (h, v) => {
      if (v & CSR.GO) h.gate();
    },
  },
  { addr: 0o177002, name: 'PRGER', access: 'RO', description: 'Program fault code (PF.…) of the last fault', read: (h) => h.io.prg.code },
  {
    addr: 0o177004,
    name: 'PRGST',
    access: 'FW',
    description: 'Program state P.NONE…P.HLT; write P.NONE to acknowledge, P.RDY to restart it from the top',
    read: (h) => h.u.progState,
    write: (h, v) => h.ctx.setProgState(h.u, v === ProgState.PROG_NONE || v === ProgState.PROG_READY ? v : -1),
  },
  { addr: 0o177006, name: 'PRGRES', access: 'RO', description: 'The program\'s R0 when it ended (its exit code)', read: (h) => h.u.progResult & 0xffff },
  { addr: 0o177010, name: 'PRGPC', access: 'RO', description: 'The program\'s PC when it last came back', read: (h) => h.io.prg.pc },
  {
    addr: 0o177012,
    name: 'SLICE',
    access: 'FW',
    description: 'Ticks the next program run may last, 0 = no limit; read in the program: ticks left',
    read: (h) => (h.u.slice >= 0 ? h.u.slice : h.u.sliceSet) & 0xffff,
    write: (h, v) => (h.u.sliceSet = clamp(v, 0, 30_000)),
  },
  { addr: 0o177014, name: 'PREMPT', access: 'FW', description: 'What ends a program run at once: PR.ALR, PR.DMG, PR.BAT', read: (h) => h.u.preemptMask, write: (h, v) => (h.u.preemptMask = v & 7) },
  { addr: 0o177016, name: 'PRMPTD', access: 'RO', description: 'The PREMPT bits that ended the last run', read: (h) => h.u.preempted },
  { addr: 0o177020, name: 'BATALM', access: 'FW', description: 'Battery threshold for PR.BAT, 0–100 %', read: (h) => h.u.batAlarm, write: (h, v) => (h.u.batAlarm = clamp(v, 0, 100)) },
  {
    addr: 0o177022,
    name: 'WDT',
    access: 'FW',
    description: 'Watchdog: write n > 0 to arm and kick it; read: ticks left',
    read: (h) => h.u.wdt & 0xffff,
    write: (h, v) => {
      if (v > 0) h.u.wdt = Math.min(v, BALANCE.wdtMaxTicks);
    },
  },
  {
    addr: 0o177026,
    name: 'BOOTCS',
    access: 'FW',
    description: 'Boot status: bits 7–0 why the rover booted (RO); bit 8 SAFE, safe mode latched: kept through reboots, cleared by a firmware upload (the boot ROM sets it)',
    read: (h) => (h.u.bootReason & 0xff) | (h.u.safeMode ? BOOT_SAFE : 0),
    write: (h, v) => (h.u.safeMode = (v & BOOT_SAFE) !== 0),
  },
  {
    addr: 0o177030,
    name: 'BOOTCT',
    access: 'RO',
    description: `Fault and watchdog reboots in the last ${BLUE11.safeModeTicks} ticks, this boot included`,
    read: (h) => h.u.faultBoots.length,
  },
  {
    addr: 0o177024,
    name: 'REBOOT',
    access: 'FW',
    description: 'Write a boot reason: hard reboot after this instruction (the ROM\'s fault handlers use it)',
    read: () => 0,
    write: (h, v) => h.reboot(v & 0xff),
  },
];

/** Output: the TX device (176540; BLUE11_IO.md §3.5). */
const OUTPUT: IoRegister[] = [
  {
    addr: 0o176540,
    name: 'TXCS',
    access: 'RW',
    description: `TX control/status: bit 7 READY (room for a byte), bit 6 IE (firmware) interrupt at vector ${TX_VECTOR.toString(8)} when room comes back`,
    read: (h) => (h.u.link.txFree(BLUE11.txFifoBytes) > 0 ? CSR.DONE : 0) | (h.io.tx.ie ? CSR.IE : 0),
    write: (h, v) => {
      if (h.program) return;
      const ie = (v & CSR.IE) !== 0;
      const raise = ie && !h.io.tx.ie && h.u.link.txFree(BLUE11.txFifoBytes) > 0;
      h.io.tx.ie = ie;
      if (raise) h.io.tx.ev = true;
    },
  },
  { addr: 0o176542, name: 'TXBUF', access: 'WO', description: 'Queue one byte for the downlink (dropped and counted in TXLOST if the FIFO is full)', read: () => 0,
    write: (h, v) => {
      h.u.link.txPut(v, BLUE11.txFifoBytes);
      h.io.tx.ready = h.u.link.txFree(BLUE11.txFifoBytes) > 0;
    },
  },
  { addr: 0o176544, name: 'TXFREE', access: 'RO', description: `Free FIFO bytes (${BLUE11.txFifoBytes} on Mk-I)`, read: (h) => h.u.link.txFree(BLUE11.txFifoBytes) },
  { addr: 0o176546, name: 'TXLOST', access: 'RW', description: 'Bytes dropped since boot (saturates at 255; write to set)', read: (h) => h.u.link.txLost, write: (h, v) => (h.u.link.txLost = clamp(v, 0, 255)) },
];

/** The recorder: CPU messages stored and forwarded (BLUE11_IO.md §3.5). */
const recFree = (h: IoHost): number => h.u.link.recFree(h.u.recorderBytes);
const RECORDER: IoRegister[] = [
  {
    addr: 0o176550,
    name: 'RECCS',
    access: 'RO',
    description: 'Recorder status: bit 7 READY (room for a byte)',
    read: (h) => (recFree(h) > 0 ? CSR.DONE : 0),
  },
  {
    addr: 0o176552,
    name: 'RECBUF',
    access: 'WO',
    description: 'Store one byte of a message in the recorder (store and forward: it reaches ground even through a bad link). Dropped if the recorder is full: check RECFRE first',
    read: () => 0,
    write: (h, v) => recordByte(h.u, v),
  },
  { addr: 0o176554, name: 'RECFRE', access: 'RO', description: 'Free recorder bytes', read: recFree },
];

/**
 * A byte into the recorder. The recorder follows the messages it stores, so a photo's header
 * (T.IMG chunk 0) takes the camera's capture of that type with it (what earns its credits).
 */
export function recordByte(u: Unit, v: number): void {
  if (!u.link.recPut(v, u.recorderBytes)) return;
  for (const m of parseStream(u.recParser, [v & 0xff], u.id, 0)) {
    if (m.status !== 'ok' || m.type !== MsgType.IMG || m.body[1] !== 0) continue;
    const cap = u.capture?.type === m.body[0] ? u.capture : null;
    if (cap) u.capture = null;
    u.imgCaps.push(cap);
  }
}

/** Clock, CPU and console registers at their traditional addresses. */
const SYSTEM: IoRegister[] = [
  {
    addr: 0o177546,
    name: 'LKS',
    access: 'FW',
    description: `Line clock (KW11-L): bit 7 set every tick (write 0 to clear), bit 6 IE: interrupt at vector ${CLOCK_VECTOR.toString(8)}`,
    read: (h) => h.io.lks,
    write: (h, v) => (h.io.lks = (h.io.lks & v & CSR.DONE) | (v & CSR.IE)),
  },
  {
    addr: 0o177570,
    name: 'DISP',
    access: 'RW',
    description: 'Console display register: the two-digit display on the back of the cabin (0–255)',
    read: (h) => h.u.post,
    write: (h, v) => (h.u.post = v & 0xff),
  },
  {
    addr: 0o177774,
    name: 'STKLIM',
    access: 'FW',
    description: 'The firmware\'s stack limit: a push below it traps to 4',
    read: (h) => h.fwStackLimit,
    write: (h, v) => (h.fwStackLimit = v & 0xfffe),
  },
];

/** `CARGO`: one read-only byte per slot (8 reserved). */
export const CARGO_BASE = 0o176600;
export const CARGO_BYTES = 8;

export const IO_REGISTERS: readonly IoRegister[] = [...telemetryAndActuators(), ...DEVICE_BLOCKS.flatMap(deviceRegisters), ...OUTPUT, ...RECORDER, ...CONTROL, ...SYSTEM].sort((a, b) => a.addr - b.addr);

const byAddr = new Map(IO_REGISTERS.map((r) => [r.addr, r]));
export const ioRegister = (addr: number): IoRegister | undefined => byAddr.get(addr & 0xfffe);
