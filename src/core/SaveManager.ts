import { CHASSIS_MK1 } from './balance';
import { CHUNK_AREA, WorldChunk } from './ChunkedWorld';
import type { DirectorState } from './EventDirector';
import type { ProductDesc, QueuedFrame, ReceivedFrame, ReceivedProduct, SysFrame } from './downlink';
import { SimulationEngine, type PhotoAssembly, type SentRecord, type SupplyDrop } from './SimulationEngine';
import { UPGRADE_BY_ID } from './upgrades';
import type { CpuState, ProgState } from './types';
import type { Capture, Device, Unit, UnitAction, UnitMotion } from './Unit';
import { fromHex, toHex } from './imaging';
import type { MachineSave } from './machine/RoverMachine';
import type { ParserState, ReceivedMessage } from './messages';

/**
 * v21 (M15 slice 6): the rover's computer is the machine of src/core/machine/ and nothing
 * else. Older saves (Rover-ASM, v1–v20) are not migrated (owner decision, docs/BLUE11_CPU.md §12):
 * loading one raises OldSaveError and the game starts a new world.
 */
export const SAVE_VERSION = 21;

interface UnitSave {
  id: number;
  name: string;
  chassis: string;
  x: number;
  y: number;
  heading: number;
  energy: number;
  hull: number;
  solarHealth: number;
  antennaHealth: number;
  cargo: number[];
  headlight: number;
  solar: [open: number, deploy: number, angle: number, target: number];
  antenna: [angle: number, target: number];
  sourceCode: string;
  upgrades: string[];
  seismic: [type: number, dist: number];
  indicators: number[];
  /** The `DISP` display on the cabin. */
  post: number;
  /** Downlink: log FIFO, recorder products, dump replies, TX stream. */
  link: { fifo: QueuedFrame[]; headSent: number; acc: number; lost: number; gap: number; products: ProductDesc[]; recSent: number; seq: number; sys: SysFrame[]; sysSent: number; tx: number[]; txLost: number };
  action: UnitAction | null;
  motion: UnitMotion | null;
  cyclesLeft: number;
  /** Power, halts and faults. */
  cpu: { state: CpuState; faultReason: string; watchdog: number };
  /** Program slot. */
  program: { source: string; state: ProgState; result: number; slice: number };
  /** Image memory as hex without trailing zeros, the capture, the mode of the last photo. */
  image: { mem: string; capture: Capture | null; mode: number };
  /** Watchdog ticks left, fault protection [PREMPT, BATALM, PRMPTD], thermal [°C, heater], array dust %. */
  wdt: number;
  preempt: [mask: number, alarm: number, hit: number];
  thermal: [temp: number, heater: number];
  dust: number;
  /** Latched device parameters, the radar [ticks, dir, hit, dist], the image erase, each device's result. */
  devices: {
    driveN: number;
    toolArg: number;
    repairSys: number;
    camMode: number;
    sliceSet: number;
    radar: [ticks: number, dir: number, hit: number, dist: number];
    imgOp: Unit['imgOp'];
    results: Record<Device, number>;
  };
  /** The machine: core, CPU contexts, I/O page, images. */
  machine: MachineSave;
}

interface ChunkSave {
  cx: number;
  cy: number;
  /** Fog run-length encoding: alternating run lengths, starting with value 0. */
  fog: number[];
  /** Sparse diff vs. freshly generated chunk: [layer, index, id] triples, flattened. */
  diff: number[];
}

export interface SaveSnapshot {
  version: number;
  savedAt?: string;
  seed: number;
  tick: number;
  credits: number;
  stats: SimulationEngine['stats'];
  cheats: SimulationEngine['cheats'];
  mappedTiles: number;
  nextUnitId: number;
  director: DirectorState;
  drops: SupplyDrop[];
  nextDropId: number;
  /** Frames received by mission control. */
  received: ReceivedFrame[];
  /** Science products received (or being received) by mission control. */
  gallery: ReceivedProduct[];
  /** Subject types already delivered in a lit photo (first-of-a-kind bonus). */
  photoSubjects: number[];
  /** Camera modes already delivered as an edited photo. */
  editedTypes: number[];
  /** Anomaly tiles already credited ("x,y"). */
  anomalyTiles: string[];
  /** What mission control sent over the uplink (Comms timeline). */
  sent: SentRecord[];
  units: UnitSave[];
  chunks: ChunkSave[];
  /** Mission control's messages, and its parsers of the TX and recorder streams; photos being put together. */
  messages: ReceivedMessage[];
  parsers: Array<[unitId: number, state: ParserState]>;
  recParsers: Array<[unitId: number, state: ParserState]>;
  photoAsm: Array<[unitId: number, asm: PhotoAssembly]>;
}

function rle(a: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0;
  let run = 0;
  for (const v of a) {
    const b = v ? 1 : 0;
    if (b === cur) run++;
    else {
      out.push(run);
      cur = b;
      run = 1;
    }
  }
  out.push(run);
  return out;
}

function unrle(runs: number[], into: Uint8Array): void {
  let i = 0;
  let v = 0;
  for (const r of runs) {
    into.fill(v, i, i + r);
    i += r;
    v ^= 1;
  }
}

/** Headless save/load. Untouched chunks are not stored: they regenerate from the seed. */
export function serialize(e: SimulationEngine): SaveSnapshot {
  const chunks: ChunkSave[] = [];
  for (const c of e.world.loadedChunks()) {
    if (!c.dirty && !c.explored) continue;
    const fresh = new WorldChunk(c.cx, c.cy);
    e.world.generator.fillChunk(fresh);
    const diff: number[] = [];
    for (let l = 0; l < 3; l++) for (let i = 0; i < CHUNK_AREA; i++) if (c.layers[l][i] !== fresh.layers[l][i]) diff.push(l, i, c.layers[l][i]);
    chunks.push({ cx: c.cx, cy: c.cy, fog: rle(c.fog), diff });
  }
  chunks.sort((p, q) => p.cx - q.cx || p.cy - q.cy); // canonical order
  return {
    version: SAVE_VERSION,
    seed: e.seed,
    tick: e.tick,
    credits: e.credits,
    stats: { ...e.stats },
    cheats: { ...e.cheats },
    mappedTiles: e.world.mappedTiles,
    nextUnitId: e.nextUnitId,
    director: e.director.saveState(),
    drops: e.drops.map((d) => ({ ...d })),
    nextDropId: e.nextDropId,
    received: e.received.map((f) => ({ ...f, bytes: [...f.bytes] })),
    gallery: e.gallery.map((g) => ({ ...g })),
    photoSubjects: [...e.photoSubjects],
    editedTypes: [...e.editedTypes],
    anomalyTiles: [...e.anomalyTiles],
    sent: e.sent.map((r) => ({ ...r })),
    units: e.units.map(saveUnit),
    chunks,
    messages: e.messages.map((m) => ({ ...m, body: [...m.body] })),
    parsers: [...e.parsers.entries()].map(([id, p]): [number, ParserState] => [id, structuredClone(p)]),
    recParsers: [...e.recParsers.entries()].map(([id, p]): [number, ParserState] => [id, structuredClone(p)]),
    photoAsm: [...e.photoAsm.entries()].map(([id, a]): [number, PhotoAssembly] => [id, structuredClone(a)]),
  };
}

function saveUnit(u: Unit): UnitSave {
  return {
    id: u.id,
    name: u.name,
    chassis: u.chassis.name,
    x: u.x,
    y: u.y,
    heading: u.heading,
    energy: u.energy,
    hull: u.hull,
    solarHealth: u.solarHealth,
    antennaHealth: u.antennaHealth,
    cargo: [...u.cargo],
    headlight: u.headlight,
    indicators: [...u.indicators],
    post: u.post,
    link: {
      fifo: u.link.fifo.map((f) => ({ bytes: [...f.bytes], gap: f.gap })),
      headSent: u.link.headSent,
      acc: u.link.acc,
      lost: u.link.lost,
      gap: u.link.gap,
      products: u.link.products.map((p) => ({ ...p })),
      recSent: u.link.recSent,
      seq: u.link.seq,
      sys: u.link.sys.map((f) => ({ bytes: [...f.bytes], taken: f.taken })),
      sysSent: u.link.sysSent,
      tx: [...u.link.tx],
      txLost: u.link.txLost,
    },
    solar: [u.solarOpen, u.solarDeploy, u.solarAngle, u.solarTarget],
    antenna: [u.antennaAngle, u.antennaTarget],
    sourceCode: u.sourceCode,
    upgrades: [...u.upgrades],
    seismic: [u.seismicType, u.seismicDist],
    action: u.action ? { ...u.action } : null,
    motion: u.motion ? { ...u.motion } : null,
    cyclesLeft: u.cyclesLeft,
    cpu: { state: u.cpu.state, faultReason: u.cpu.faultReason, watchdog: u.cpu.watchdog },
    program: { source: u.programSource, state: u.progState, result: u.progResult, slice: u.slice },
    image: { mem: toHex(u.img.subarray(0, lastNonZero(u.img) + 1)), capture: u.capture ? { ...u.capture } : null, mode: u.snapMode },
    wdt: u.wdt,
    preempt: [u.preemptMask, u.batAlarm, u.preempted],
    thermal: [u.temp, u.heater],
    dust: u.solarDust,
    devices: {
      driveN: u.driveN,
      toolArg: u.toolArg,
      repairSys: u.repairSys,
      camMode: u.camMode,
      sliceSet: u.sliceSet,
      radar: [u.radarTicks, u.radarDir, u.radarHit, u.radarDist],
      imgOp: u.imgOp ? { ...u.imgOp } : null,
      results: { ...u.results },
    },
    machine: u.machine.save(),
  };
}

const lastNonZero = (b: Uint8Array): number => {
  let i = b.length - 1;
  while (i >= 0 && b[i] === 0) i--;
  return i;
};

export class SaveError extends Error {}

/** A save from before the computer was replaced (v1–v20): it cannot be loaded, start a new world. */
export class OldSaveError extends SaveError {
  constructor(readonly version: number) {
    super(`This save (version ${version}) is from before the rover's computer was replaced by the Blue-11. Old saves cannot be loaded: start a new world.`);
  }
}

/** Check a snapshot's version. There are no migrations since v21 (see SAVE_VERSION). */
export function migrate(raw: unknown): SaveSnapshot {
  const s = raw as SaveSnapshot;
  if (!s || typeof s !== 'object' || typeof s.seed !== 'number' || typeof s.version !== 'number') throw new SaveError('Not a Rover save file.');
  if (s.version > SAVE_VERSION) throw new SaveError(`Save version ${s.version} is newer than this game (${SAVE_VERSION}).`);
  if (s.version < SAVE_VERSION) throw new OldSaveError(s.version);
  return structuredClone(s);
}

/** Reassemble both images from their saved sources, then restore the machine. */
function loadMachine(e: SimulationEngine, u: Unit, us: UnitSave): void {
  const m = u.machine;
  const ms = us.machine;
  if (!ms) throw new SaveError(`Saved rover ${us.name} has no machine state.`);
  for (const slot of ['firmware', 'program'] as const) {
    const src = slot === 'firmware' ? ms.firmware : ms.program;
    if (!src) continue;
    const r = e.assembleFor(u, src, slot);
    if (!r.image) throw new SaveError(`Saved ${slot} of ${us.name} no longer assembles: ${r.errors[0]?.message}`);
    if (slot === 'firmware') m.firmware = r.image;
    else m.program = r.image.bytes.length ? r.image : null;
  }
  m.load(ms);
  u.sourceCode = us.sourceCode;
  u.firmwareBytes = m.firmware?.bytes.length ?? 0;
  u.programSource = us.program.source;
  u.programBytes = m.program?.bytes.length ?? 0;
  u.progState = us.program.state;
  u.progResult = us.program.result;
  u.slice = us.program.slice;
  u.cpu.state = us.cpu.state;
  u.cpu.faultReason = us.cpu.faultReason;
  u.cpu.watchdog = us.cpu.watchdog;
}

/** Rebuild an engine from a snapshot (any supported version). Throws SaveError on bad data. */
export function deserialize(raw: unknown): SimulationEngine {
  const s = migrate(raw);

  const e = new SimulationEngine({ seed: s.seed });
  e.messages = s.messages.map((m) => ({ ...m, body: [...m.body] }));
  e.parsers = new Map(s.parsers.map(([id, p]) => [id, structuredClone(p)]));
  e.recParsers = new Map(s.recParsers.map(([id, p]) => [id, structuredClone(p)]));
  e.photoAsm = new Map(s.photoAsm.map(([id, a]) => [id, structuredClone(a)]));
  e.tick = s.tick;
  e.world.now = s.tick;
  e.credits = s.credits;
  Object.assign(e.stats, s.stats);
  Object.assign(e.cheats, s.cheats);
  e.nextUnitId = s.nextUnitId;
  e.director.loadState(s.director);
  e.drops = s.drops.map((d) => ({ ...d }));
  e.nextDropId = s.nextDropId;
  e.received = s.received.map((f) => ({ ...f, bytes: [...f.bytes] }));
  e.gallery = s.gallery.map((g) => ({ ...g }));
  e.photoSubjects = [...s.photoSubjects];
  e.editedTypes = [...s.editedTypes];
  e.anomalyTiles = [...s.anomalyTiles];
  e.sent = s.sent.map((r) => ({ ...r }));

  for (const cs of s.chunks) {
    const c = e.world.getChunk(cs.cx, cs.cy);
    unrle(cs.fog, c.fog);
    c.explored = c.fog.some((v) => v !== 0);
    for (let i = 0; i < cs.diff.length; i += 3) c.layers[cs.diff[i]][cs.diff[i + 1]] = cs.diff[i + 2];
    c.dirty = cs.diff.length > 0;
    c.version++;
  }
  e.world.mappedTiles = s.mappedTiles;

  for (const us of s.units) {
    if (us.chassis !== CHASSIS_MK1.name) throw new SaveError(`Unknown chassis ${us.chassis}.`);
    const u = e.restoreUnit(us.id, us.name, CHASSIS_MK1);
    for (const id of us.upgrades) {
      const def = UPGRADE_BY_ID[id];
      if (!def) throw new SaveError(`Unknown upgrade ${id}.`);
      def.apply(u.chassis, u); // rebuild stats; counters are restored from the snapshot
      u.upgrades.push(id);
    }
    Object.assign(u.link, {
      fifo: us.link.fifo.map((f) => ({ bytes: [...f.bytes], gap: f.gap })),
      headSent: us.link.headSent,
      acc: us.link.acc,
      lost: us.link.lost,
      gap: us.link.gap,
      products: us.link.products.map((p) => ({ ...p })),
      recSent: us.link.recSent,
      seq: us.link.seq,
      sys: us.link.sys.map((f) => ({ bytes: [...f.bytes], taken: f.taken })),
      sysSent: us.link.sysSent,
      tx: [...us.link.tx],
      txLost: us.link.txLost,
    });
    u.seismicType = us.seismic[0];
    u.seismicDist = us.seismic[1];
    const mem = u.imageMemory(); // sized by the camera modes the upgrades installed
    mem.fill(0);
    mem.set(fromHex(us.image.mem).slice(0, mem.length));
    u.capture = us.image.capture ? { ...us.image.capture } : null;
    u.snapMode = us.image.mode;
    Object.assign(u, {
      x: us.x,
      y: us.y,
      heading: us.heading,
      energy: us.energy,
      hull: us.hull,
      solarHealth: us.solarHealth,
      antennaHealth: us.antennaHealth,
      cargo: [...us.cargo],
      headlight: us.headlight,
      indicators: [...us.indicators],
      post: us.post,
      solarOpen: us.solar[0],
      solarDeploy: us.solar[1],
      solarAngle: us.solar[2],
      solarTarget: us.solar[3],
      antennaAngle: us.antenna[0],
      antennaTarget: us.antenna[1],
      action: us.action,
      motion: us.motion,
      cyclesLeft: us.cyclesLeft,
      wdt: us.wdt,
      preemptMask: us.preempt[0],
      batAlarm: us.preempt[1],
      preempted: us.preempt[2],
      temp: us.thermal[0],
      heater: us.thermal[1],
      solarDust: us.dust,
      driveN: us.devices.driveN,
      toolArg: us.devices.toolArg,
      repairSys: us.devices.repairSys,
      camMode: us.devices.camMode,
      sliceSet: us.devices.sliceSet,
      radarTicks: us.devices.radar[0],
      radarDir: us.devices.radar[1],
      radarHit: us.devices.radar[2],
      radarDist: us.devices.radar[3],
      imgOp: us.devices.imgOp ? { ...us.devices.imgOp } : null,
      results: { ...us.devices.results },
    });
    loadMachine(e, u, us);
  }
  e.refreshDerived();
  return e;
}
