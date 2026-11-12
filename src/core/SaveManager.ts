import { CHASSIS_MK1 } from './balance';
import { CHUNK_AREA, WorldChunk } from './ChunkedWorld';
import type { DirectorState } from './EventDirector';
import { SimulationEngine } from './SimulationEngine';
import { CpuState, type Status } from './types';
import type { Unit, UnitAction, UnitMotion } from './Unit';

export const SAVE_VERSION = 1;

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
    solar: [u.solarOpen, u.solarDeploy, u.solarAngle, u.solarTarget],
    antenna: [u.antennaAngle, u.antennaTarget],
    packetsSent: u.packetsSent,
    lastTx: u.lastTx ? { ...u.lastTx } : null,
    sourceCode: u.sourceCode,
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

/** Rebuild an engine from a snapshot. Throws SaveError on unknown/invalid data. */
export function deserialize(raw: unknown): SimulationEngine {
  const s = raw as SaveSnapshot;
  if (!s || typeof s !== 'object' || typeof s.seed !== 'number') throw new SaveError('Not a Rover save file.');
  if (s.version !== SAVE_VERSION) throw new SaveError(`Unsupported save version ${s.version} (expected ${SAVE_VERSION}).`);

  const e = new SimulationEngine({ seed: s.seed });
  e.tick = s.tick;
  e.world.now = s.tick;
  e.credits = s.credits;
  Object.assign(e.stats, s.stats);
  Object.assign(e.cheats, s.cheats);
  e.nextUnitId = s.nextUnitId;
  e.director.loadState(s.director);

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
