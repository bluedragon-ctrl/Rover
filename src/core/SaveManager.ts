import { CHASSIS_MK1 } from './balance';
import { CHUNK_AREA, WorldChunk } from './ChunkedWorld';
import type { DirectorState } from './EventDirector';
import type { QueuedFrame, ReceivedFrame } from './downlink';
import { SimulationEngine, type SupplyDrop } from './SimulationEngine';
import { UPGRADE_BY_ID } from './upgrades';
import { CpuState, type Status } from './types';
import type { Unit, UnitAction, UnitMotion } from './Unit';

export const SAVE_VERSION = 4;

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
  scienceReady: number;
  lights: [number, number, number];
  solar: [open: number, deploy: number, angle: number, target: number];
  antenna: [angle: number, target: number];
  packetsSent: number;
  lastTx: Unit['lastTx'];
  sourceCode: string;
  /** v2 */
  upgrades: string[];
  seismic: [type: number, dist: number];
  /** v3 */
  indicators: number[];
  /** v4: downlink transmitter */
  link: { fifo: QueuedFrame[]; headSent: number; acc: number; lost: number; gap: number };
  action: UnitAction | null;
  motion: UnitMotion | null;
  cyclesLeft: number;
  vm: {
    ip: number;
    regs: number[];
    dataStack: number[];
    callStack: number[];
    state: CpuState;
    status: Status;
    faultReason: string;
    watchdog: number;
    instructionsExecuted: number;
  };
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
    units: e.units.map(saveUnit),
    chunks,
  };
}

function saveUnit(u: Unit): UnitSave {
  const vm = u.vm;
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
    scienceReady: u.scienceReady,
    lights: [u.lightColor, u.lightBlink, u.headlight],
    indicators: [...u.indicators],
    link: {
      fifo: u.link.fifo.map((f) => ({ bytes: [...f.bytes], gap: f.gap })),
      headSent: u.link.headSent,
      acc: u.link.acc,
      lost: u.link.lost,
      gap: u.link.gap,
    },
    solar: [u.solarOpen, u.solarDeploy, u.solarAngle, u.solarTarget],
    antenna: [u.antennaAngle, u.antennaTarget],
    packetsSent: u.packetsSent,
    lastTx: u.lastTx ? { ...u.lastTx } : null,
    sourceCode: u.sourceCode,
    upgrades: [...u.upgrades],
    seismic: [u.seismicType, u.seismicDist],
    action: u.action ? { ...u.action } : null,
    motion: u.motion ? { ...u.motion } : null,
    cyclesLeft: u.cyclesLeft,
    vm: {
      ip: vm.ip,
      regs: Array.from(vm.regs),
      dataStack: [...vm.dataStack],
      callStack: [...vm.callStack],
      state: vm.state,
      status: vm.status,
      faultReason: vm.faultReason,
      watchdog: vm.watchdog,
      instructionsExecuted: vm.instructionsExecuted,
    },
  };
}

export class SaveError extends Error {}

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
    for (const u of out.units) u.link = { fifo: [], headSent: 0, acc: 0, lost: 0, gap: 0 };
    v = 4;
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
    });
    u.seismicType = us.seismic[0];
    u.seismicDist = us.seismic[1];
    Object.assign(u, {
      x: us.x,
      y: us.y,
      heading: us.heading,
      energy: us.energy,
      hull: us.hull,
      solarHealth: us.solarHealth,
      antennaHealth: us.antennaHealth,
      cargo: [...us.cargo],
      scienceReady: us.scienceReady,
      lightColor: us.lights[0],
      lightBlink: us.lights[1],
      headlight: us.lights[2],
      indicators: [...us.indicators],
      solarOpen: us.solar[0],
      solarDeploy: us.solar[1],
      solarAngle: us.solar[2],
      solarTarget: us.solar[3],
      antennaAngle: us.antenna[0],
      antennaTarget: us.antenna[1],
      packetsSent: us.packetsSent,
      lastTx: us.lastTx,
      action: us.action,
      motion: us.motion,
      cyclesLeft: us.cyclesLeft,
    });
    const res = e.compileFor(u, us.sourceCode);
    if (!res.program) throw new SaveError(`Saved firmware of ${us.name} no longer compiles: ${res.errors[0]?.message}`);
    u.sourceCode = us.sourceCode;
    u.vm.load(res.program);
    const vm = u.vm;
    vm.ip = us.vm.ip;
    vm.regs.set(us.vm.regs);
    vm.dataStack = [...us.vm.dataStack];
    vm.callStack = [...us.vm.callStack];
    vm.state = us.vm.state;
    vm.status = us.vm.status;
    vm.faultReason = us.vm.faultReason;
    vm.watchdog = us.vm.watchdog;
    vm.instructionsExecuted = us.vm.instructionsExecuted;
  }
  e.refreshDerived();
  return e;
}
