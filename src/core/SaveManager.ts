import { CHASSIS_MK1 } from './balance';
import { CHUNK_AREA, WorldChunk } from './ChunkedWorld';
import type { DirectorState } from './EventDirector';
import type { ProductDesc, QueuedFrame, ReceivedFrame, ReceivedProduct, SysFrame } from './downlink';
import { SimulationEngine, type SentRecord, type SupplyDrop } from './SimulationEngine';
import { UPGRADE_BY_ID } from './upgrades';
import { CpuState, ProgState, type Status } from './types';
import type { RoverVM } from './vm/RoverVM';
import type { Capture, Unit, UnitAction, UnitMotion } from './Unit';
import { fromHex, toHex } from './imaging';

export const SAVE_VERSION = 14;

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
  /** v12 (before: `lights` = [beacon colour, beacon blink, headlight]) */
  headlight: number;
  solar: [open: number, deploy: number, angle: number, target: number];
  antenna: [angle: number, target: number];
  sourceCode: string;
  /** v2 */
  upgrades: string[];
  seismic: [type: number, dist: number];
  /** v3 */
  indicators: number[];
  /** v7: @POST display */
  post: number;
  /** v4: downlink transmitter (v5: recorder, v6: dump replies) */
  link: { fifo: QueuedFrame[]; headSent: number; acc: number; lost: number; gap: number; products: ProductDesc[]; recSent: number; seq: number; sys: SysFrame[]; sysSent: number };
  action: UnitAction | null;
  motion: UnitMotion | null;
  cyclesLeft: number;
  vm: VmSave;
  /** v10: program slot (M10) */
  program: { source: string; vm: VmSave; state: ProgState; result: number; slice: number };
  /** v14: image memory (M12, SPEC §3.8.7): bytes as hex without trailing zeros, the capture, SEND's default type, edited since the SNAP */
  image: { mem: string; capture: Capture | null; mode: number; edited: boolean };
}

interface VmSave {
  ip: number;
  regs: number[];
  dataStack: number[];
  callStack: number[];
  state: CpuState;
  status: Status;
  faultReason: string;
  watchdog: number;
  instructionsExecuted: number;
  /** Set by the v10 -> v11 migration: `ip` and `callStack` are instruction indices, not byte addresses. */
  legacyIndex?: boolean;
}

function saveVm(vm: RoverVM): VmSave {
  return {
    ip: vm.ip,
    regs: Array.from(vm.regs),
    dataStack: [...vm.dataStack],
    callStack: [...vm.callStack],
    state: vm.state,
    status: vm.status,
    faultReason: vm.faultReason,
    watchdog: vm.watchdog,
    instructionsExecuted: vm.instructionsExecuted,
  };
}

function loadVm(vm: RoverVM, s: VmSave): void {
  // Before v11 an IP was an instruction index; now it is a byte address (SPEC §5.7.1).
  const instrs = vm.program?.instrs ?? [];
  const addr = (i: number) => (!s.legacyIndex ? i : i >= 0 && i < instrs.length ? instrs[i].addr : (vm.program?.code.length ?? 0));
  vm.ip = addr(s.ip);
  vm.regs.set(s.regs);
  vm.dataStack = [...s.dataStack];
  vm.callStack = s.callStack.map(addr);
  vm.state = s.state;
  vm.status = s.status;
  vm.faultReason = s.faultReason;
  vm.watchdog = s.watchdog;
  vm.instructionsExecuted = s.instructionsExecuted;
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
  /** v2 */
  drops: SupplyDrop[];
  nextDropId: number;
  /** v4: frames received by mission control */
  received: ReceivedFrame[];
  /** v5: science products received (or being received) by mission control */
  gallery: ReceivedProduct[];
  /** v8: subject types already delivered in a lit photo (first-of-a-kind bonus) */
  photoSubjects: number[];
  /** v9: anomaly tiles already credited ("x,y") */
  anomalyTiles: string[];
  /** v13: what mission control sent over the uplink (Comms timeline) */
  sent: SentRecord[];
  units: UnitSave[];
  chunks: ChunkSave[];
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
    anomalyTiles: [...e.anomalyTiles],
    sent: e.sent.map((r) => ({ ...r })),
    units: e.units.map(saveUnit),
    chunks,
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
    },
    solar: [u.solarOpen, u.solarDeploy, u.solarAngle, u.solarTarget],
    antenna: [u.antennaAngle, u.antennaTarget],
    sourceCode: u.sourceCode,
    upgrades: [...u.upgrades],
    seismic: [u.seismicType, u.seismicDist],
    action: u.action ? { ...u.action } : null,
    motion: u.motion ? { ...u.motion } : null,
    cyclesLeft: u.cyclesLeft,
    vm: saveVm(u.vm),
    program: { source: u.programSource, vm: saveVm(u.prog), state: u.progState, result: u.progResult, slice: u.slice },
    image: { mem: toHex(u.img.subarray(0, lastNonZero(u.img) + 1)), capture: u.capture ? { ...u.capture } : null, mode: u.snapMode, edited: u.imgEdited },
  };
}

const lastNonZero = (b: Uint8Array): number => {
  let i = b.length - 1;
  while (i >= 0 && b[i] === 0) i--;
  return i;
};

export class SaveError extends Error {}

/** v11 -> v12: rewrite the retired beacon ports onto the status lamps. */
const retireBeacon = (src: string): string => src.replace(/@LIGHT_COLOR\b/gi, '@IND1').replace(/@LIGHT_BLINK\b/gi, '@IND3');

/** Upgrade older snapshots step by step to the current version. */
export function migrate(raw: unknown): SaveSnapshot {
  const s = raw as SaveSnapshot & Record<string, unknown>;
  if (!s || typeof s !== 'object' || typeof s.seed !== 'number' || typeof s.version !== 'number') throw new SaveError('Not a Rover save file.');
  if (s.version > SAVE_VERSION) throw new SaveError(`Save version ${s.version} is newer than this game (${SAVE_VERSION}).`);
  let v = s.version;
  const out = structuredClone(s) as SaveSnapshot;
  if (v === 1) {
    // v1 -> v2: upgrades and supply drops did not exist yet.
    out.drops = [];
    out.nextDropId = 1;
    for (const u of out.units) {
      u.upgrades = [];
      u.seismic = [0, 0];
    }
    v = 2;
  }
  if (v === 2) {
    // v2 -> v3: indicator lamps (@IND1..@IND3) start dark.
    for (const u of out.units) u.indicators = [0, 0, 0];
    v = 3;
  }
  if (v === 3) {
    // v3 -> v4: byte downlink (M9). Empty FIFO, nothing received yet.
    out.received = [];
    for (const u of out.units) u.link = { fifo: [], headSent: 0, acc: 0, lost: 0, gap: 0 } as unknown as UnitSave['link'];
    v = 4;
  }
  if (v === 4) {
    // v4 -> v5: science recorder (M9 slice 2). Old science packets still waiting are
    // credited now (they have no spectrum); TX packet counters are gone.
    const units = out.units as (UnitSave & { scienceReady?: number; packetsSent?: number; lastTx?: unknown })[];
    const stats = out.stats as SaveSnapshot['stats'] & { packetsSent?: number };
    for (const u of units) {
      const waiting = u.scienceReady ?? 0;
      out.credits += waiting;
      stats.scienceDelivered += waiting;
      delete u.scienceReady;
      delete u.packetsSent;
      delete u.lastTx;
      Object.assign(u.link, { products: [], recSent: 0, seq: 0 });
    }
    stats.framesReceived = (stats.packetsSent ?? 0) + out.received.length;
    delete stats.packetsSent;
    out.gallery = [];
    v = 5;
  }
  if (v === 5) {
    // v5 -> v6: memory dumps (M9 slice 3). No dump replies waiting.
    for (const u of out.units) Object.assign(u.link, { sys: [], sysSent: 0 });
    v = 6;
  }
  if (v === 6) {
    // v6 -> v7: @POST display (M9 slice 4) starts at 00.
    for (const u of out.units) u.post = 0;
    v = 7;
  }
  if (v === 7) {
    // v7 -> v8: camera photos (M9 slice 5). No photo taken or delivered yet.
    out.photoSubjects = [];
    out.stats.photosTaken = 0;
    out.stats.photosDelivered = 0;
    v = 8;
  }
  if (v === 8) {
    // v8 -> v9: anomalies (M9 slice 6). Photos taken before carry no anomaly.
    out.anomalyTiles = [];
    out.stats.anomaliesFound = 0;
    v = 9;
  }
  if (v === 9) {
    // v9 -> v10: firmware + program slot (M10). The old code stays the firmware; no program.
    for (const u of out.units) {
      const ctx: VmSave = { ip: 0, regs: u.vm.regs.map(() => 0), dataStack: [], callStack: [], state: CpuState.RUNNING, status: 0 as Status, faultReason: '', watchdog: 0, instructionsExecuted: 0 };
      u.program = { source: '', vm: ctx, state: ProgState.PROG_NONE, result: 0, slice: -1 };
    }
    v = 10;
  }
  if (v === 10) {
    // v10 -> v11: machine code (M10 slice 2). IPs and return addresses become byte
    // addresses; they are converted after the program is compiled again (loadVm).
    for (const u of out.units) {
      u.vm.legacyIndex = true;
      u.program.vm.legacyIndex = true;
    }
    v = 11;
  }
  if (v === 11) {
    // v11 -> v12: the status beacon is gone; the three roof lamps are the status lights.
    // Old code keeps working: @LIGHT_COLOR becomes @IND1, @LIGHT_BLINK becomes @IND3
    // (same size: one port byte, so saved byte addresses stay valid), and the lamps
    // take over what the beacon showed.
    const units = out.units as (UnitSave & { lights?: [number, number, number] })[];
    for (const u of units) {
      const [color, blink, headlight] = u.lights ?? [0, 0, u.headlight ?? 0];
      delete u.lights;
      u.headlight = headlight;
      const usedColor = /@LIGHT_COLOR\b/i.test(u.sourceCode) || /@LIGHT_COLOR\b/i.test(u.program.source);
      const usedBlink = /@LIGHT_BLINK\b/i.test(u.sourceCode) || /@LIGHT_BLINK\b/i.test(u.program.source);
      u.sourceCode = retireBeacon(u.sourceCode);
      u.program.source = retireBeacon(u.program.source);
      if (usedColor) u.indicators[0] = color;
      if (usedBlink) u.indicators[2] = blink;
    }
    v = 12;
  }
  if (v === 12) {
    // v12 -> v13: mission control's sent record (Comms timeline) starts empty.
    out.sent = [];
    v = 13;
  }
  if (v === 13) {
    // v13 -> v14: image memory (M12). Empty, no capture.
    for (const u of out.units) u.image = { mem: '', capture: null, mode: 1, edited: false };
    v = 14;
  }
  if (v !== SAVE_VERSION) throw new SaveError(`Unsupported save version ${s.version}.`);
  out.version = v;
  return out;
}

/** Rebuild an engine from a snapshot (any supported version). Throws SaveError on bad data. */
export function deserialize(raw: unknown): SimulationEngine {
  const s = migrate(raw);

  const e = new SimulationEngine({ seed: s.seed });
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
    });
    u.seismicType = us.seismic[0];
    u.seismicDist = us.seismic[1];
    const mem = u.imageMemory(); // sized by the camera modes the upgrades installed
    mem.fill(0);
    mem.set(fromHex(us.image.mem).slice(0, mem.length));
    u.capture = us.image.capture ? { ...us.image.capture } : null;
    u.snapMode = us.image.mode;
    u.imgEdited = us.image.edited;
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
    });
    const res = e.compileFor(u, us.sourceCode);
    if (!res.program) throw new SaveError(`Saved firmware of ${us.name} no longer compiles: ${res.errors[0]?.message}`);
    u.sourceCode = us.sourceCode;
    u.firmwareBytes = res.flashUsed;
    u.vm.load(res.program);
    loadVm(u.vm, us.vm);
    const ps = us.program;
    const pres = e.compileFor(u, ps.source, 'program');
    if (!pres.program) throw new SaveError(`Saved program of ${us.name} no longer compiles: ${pres.errors[0]?.message}`);
    u.programSource = ps.source;
    u.programBytes = pres.flashUsed;
    u.prog.load(pres.program);
    loadVm(u.prog, ps.vm);
    u.progState = ps.state;
    u.progResult = ps.result;
    u.slice = ps.slice;
  }
  e.refreshDerived();
  return e;
}
