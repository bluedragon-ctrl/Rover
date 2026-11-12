import { BALANCE, CHASSIS_MK1, type ChassisDef } from './balance';
import { ChunkedWorld } from './ChunkedWorld';
import { EventBus } from './EventBus';
import { MapGenerator } from './MapGenerator';
import { getPort, writePortClamped, type PortContext } from './ports';
import { CpuState, DIR_VEC, Layer, Status } from './types';
import { Unit } from './Unit';
import { compile, type CompileResult, type Instr } from './vm/Compiler';
import type { VmHost } from './vm/RoverVM';
import { createDefaultRegistry, T, type WorldRegistry } from './WorldRegistry';

export interface EngineOptions {
  seed: number;
  registry?: WorldRegistry;
}

/**
 * Headless, deterministic simulation. No DOM, no Three.js, no wall-clock time.
 * Drive it with tick() (or a SimClock) and observe it through `events`.
 */
export class SimulationEngine {
  readonly events = new EventBus();
  readonly registry: WorldRegistry;
  readonly world: ChunkedWorld;
  readonly units: Unit[] = [];
  tick = 0;
  private nextUnitId = 1;
  private readonly portCtx: PortContext;

  constructor(readonly opts: EngineOptions) {
    this.registry = opts.registry ?? createDefaultRegistry();
    this.world = new ChunkedWorld(new MapGenerator(opts.seed));
    this.world.onTileChanged = (x, y, layer, id) => this.events.emit('TILE_CHANGED', { x, y, layer, id });
    const self = this;
    this.portCtx = {
      get tick() {
        return self.tick;
      },
      world: this.world,
      registry: this.registry,
    };
  }

  get seed(): number {
    return this.opts.seed;
  }

  spawnUnit(name: string, x = 0, y = 0, chassis: ChassisDef = CHASSIS_MK1): Unit {
    const u = new Unit(this.nextUnitId++, name, chassis);
    u.x = x;
    u.y = y;
    this.units.push(u);
    this.world.touchRadius(x, y, BALANCE.chunkBubbleRadius);
    return u;
  }

  getUnit(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  unitAt(x: number, y: number): Unit | undefined {
    return this.units.find((u) => u.x === x && u.y === y);
  }

  compileFor(unit: Unit, source: string): CompileResult {
    return compile(source, unit.chassis, this.registry.constants());
  }

  /** Compile and flash new firmware; hard reboot on success. */
  upload(unit: Unit, source: string): CompileResult {
    const res = this.compileFor(unit, source);
    if (!res.program) return res;
    unit.sourceCode = source;
    unit.action = null;
    unit.vm.load(res.program);
    unit.cyclesLeft = 0;
    this.log(unit, 'info', `Firmware flashed (${res.flashUsed}/${unit.chassis.flashLines} lines). Rebooting.`);
    return res;
  }

  /** Layer-aware tile read including the computed actor layer. */
  tileAt(x: number, y: number, layer: Layer): number {
    if (layer === Layer.ACTOR) return this.unitAt(x, y) ? T.ROVER : 0;
    return this.world.getTile(x, y, layer);
  }

  isBlocked(x: number, y: number): boolean {
    if (this.unitAt(x, y)) return true;
    const ob = this.world.getTile(x, y, Layer.OBSTACLE);
    return ob !== 0 && !!this.registry.get(ob)?.blocksMove;
  }

  // ---------------------------------------------------------------- ticking

  /** Advance one full tick. */
  advanceTick(): void {
    this.beginTick();
    for (const u of this.units) this.runCpu(u, Infinity);
  }

  /**
   * Debugger: execute exactly one instruction on `unit`, advancing world ticks as
   * needed (e.g. while the CPU is blocked). Returns false if the CPU cannot run.
   */
  stepInstruction(unit: Unit, maxTicks = 10_000): boolean {
    for (let guard = 0; guard < maxTicks; guard++) {
      if (unit.vm.state === CpuState.RUNNING && unit.cyclesLeft > 0) {
        this.runCpu(unit, 1);
        return true;
      }
      // Finish this tick for everyone else, then start a new one.
      for (const u of this.units) if (u !== unit) this.runCpu(u, Infinity);
      this.beginTick();
      if (!unit.powered || unit.vm.state === CpuState.FAULT) return false;
    }
    return false;
  }

  private beginTick(): void {
    this.tick++;
    this.world.now = this.tick;
    for (const u of this.units) {
      this.world.touchRadius(u.x, u.y, BALANCE.chunkBubbleRadius);
      this.updateUnitPhysics(u);
      u.cyclesLeft = u.vm.state === CpuState.RUNNING ? u.chassis.cyclesPerTick : 0;
    }
    if (this.tick % 100 === 0) this.world.evictStale(BALANCE.chunkEvictAfterTicks);
    this.events.emit('TICK', { tick: this.tick });
  }

  private runCpu(u: Unit, maxInstructions: number): void {
    let n = 0;
    while (u.cyclesLeft > 0 && u.vm.state === CpuState.RUNNING && n < maxInstructions) {
      const r = u.vm.step(this.hostFor(u), BALANCE.watchdogTicks);
      n++;
      u.cyclesLeft--;
      if (r === 'endTick') u.cyclesLeft = 0;
    }
    if (u.vm.state !== CpuState.RUNNING) u.cyclesLeft = 0;
    if (u.vm.state === CpuState.FAULT && u.vm.watchdog === BALANCE.watchdogTicks) {
      this.log(u, 'error', `CPU FAULT: ${u.vm.faultReason}. Watchdog reboot in ${BALANCE.watchdogTicks} ticks.`);
      this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
    }
  }

  private updateUnitPhysics(u: Unit): void {
    const vm = u.vm;
    if (vm.state === CpuState.DESTROYED) return;

    // Passive drain.
    if (u.powered) this.drain(u, BALANCE.idleDrainPerTick);

    if (vm.state === CpuState.FAULT) {
      if (--vm.watchdog <= 0) {
        vm.reboot();
        u.action = null;
        this.log(u, 'warn', 'Watchdog reboot.');
        this.events.emit('UNIT_STATE', { unitId: u.id, state: vm.state });
      }
      return;
    }

    if (vm.state === CpuState.POWER_OFF) return; // Solar cold-boot arrives with M4.

    const act = u.action;
    if (!act) return;
    if (--act.ticksLeft > 0) return;

    if (act.kind === 'WAIT') {
      u.action = null;
      vm.unblock();
      return;
    }

    // STEP: arrive on the tile.
    u.x = act.toX;
    u.y = act.toY;
    act.tilesLeft--;
    const terrain = this.registry.get(this.world.getTile(u.x, u.y, Layer.TERRAIN));
    if (terrain?.hazardDamage) {
      this.damage(u, terrain.hazardDamage);
      if (!u.powered) return;
      this.finishAction(u, Status.ERR_HAZARD);
      return;
    }
    if (act.tilesLeft <= 0) {
      this.finishAction(u, Status.OK);
      return;
    }
    const st = this.beginStepTile(u, act.dir, act.tilesLeft);
    if (st !== Status.OK) this.finishAction(u, st);
  }

  private finishAction(u: Unit, status: Status): void {
    u.action = null;
    this.setStatus(u, status);
    u.vm.unblock();
  }

  private setStatus(u: Unit, status: Status): void {
    u.vm.status = status;
    if (status !== Status.OK) this.events.emit('UNIT_STATUS', { unitId: u.id, status });
  }

  /** Start moving one tile. Returns OK if the move began. */
  private beginStepTile(u: Unit, dir: number, tilesLeft: number): Status {
    const [dx, dy] = DIR_VEC[dir];
    const tx = u.x + dx;
    const ty = u.y + dy;
    if (this.isBlocked(tx, ty)) return Status.ERR_BLOCKED;
    const terrain = this.registry.get(this.world.getTile(tx, ty, Layer.TERRAIN));
    const ticks = terrain?.moveTicks ?? 3;
    const energy = terrain?.moveEnergy ?? 40;
    if (u.energy < energy) return Status.ERR_LOW_POWER;
    this.drain(u, energy);
    if (!u.powered) return Status.ERR_LOW_POWER;
    u.heading = dir;
    u.action = { kind: 'STEP', dir, tilesLeft, ticksLeft: ticks, toX: tx, toY: ty };
    u.motion = { fromX: u.x, fromY: u.y, toX: tx, toY: ty, startTick: this.tick, endTick: this.tick + ticks };
    this.events.emit('UNIT_MOVED', { unitId: u.id, ...u.motion });
    return Status.OK;
  }

  private drain(u: Unit, amount: number): void {
    u.energy = Math.max(0, u.energy - amount);
    if (u.energy === 0 && u.powered) {
      u.vm.state = CpuState.POWER_OFF;
      u.action = null;
      u.cyclesLeft = 0;
      this.log(u, 'error', 'Battery depleted. Rover powered off.');
      this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
    }
  }

  private damage(u: Unit, amount: number): void {
    u.hull = Math.max(0, u.hull - amount);
    if (u.hull === 0) {
      u.vm.state = CpuState.DESTROYED;
      u.action = null;
      u.cyclesLeft = 0;
      this.log(u, 'error', 'Hull breached. Rover destroyed.');
      this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
    }
  }

  private log(u: Unit, level: 'info' | 'warn' | 'error', message: string): void {
    this.events.emit('LOG', { unitId: u.id, level, message });
  }

  // ---------------------------------------------------------------- hardware

  private hostFor(u: Unit): VmHost {
    return {
      readPort: (name) => getPort(name)?.read?.(u, this.portCtx) ?? 0,
      writePort: (name, v) => {
        const p = getPort(name);
        if (p) writePortClamped(p, u, v, this.portCtx);
      },
      hardware: (ins, values) => this.hardware(u, ins, values),
    };
  }

  private hardware(u: Unit, ins: Instr, v: number[]): number[] | void {
    const validDir = (d: number) => d >= 0 && d <= 3;
    switch (ins.op) {
      case 'SLEEP': {
        this.setStatus(u, Status.OK);
        if (v[0] > 0) {
          u.action = { kind: 'WAIT', ticksLeft: v[0] };
          u.vm.block();
        }
        return;
      }
      case 'SCAN': {
        const dir = v[0];
        if (!validDir(dir)) {
          this.setStatus(u, Status.ERR_INVALID);
          return [0, 0];
        }
        if (u.energy < BALANCE.scanEnergy) {
          this.setStatus(u, Status.ERR_LOW_POWER);
          return [0, 0];
        }
        this.drain(u, BALANCE.scanEnergy);
        u.heading = dir;
        const [dx, dy] = DIR_VEC[dir];
        let hit = 0;
        let dist = 0;
        for (let d = 1; d <= u.chassis.sensorRange; d++) {
          const x = u.x + dx * d;
          const y = u.y + dy * d;
          hit = this.tileAt(x, y, Layer.ACTOR) || this.tileAt(x, y, Layer.OBSTACLE) || this.tileAt(x, y, Layer.ITEM);
          if (hit) {
            dist = d;
            break;
          }
        }
        this.events.emit('SCAN_PULSE', { unitId: u.id, x: u.x, y: u.y, dir, dist: dist || u.chassis.sensorRange, hit });
        this.setStatus(u, Status.OK);
        if (u.powered) {
          u.action = { kind: 'WAIT', ticksLeft: BALANCE.scanTicks };
          u.vm.block();
        }
        return [hit, dist];
      }
      case 'STEP': {
        const dir = v[0];
        const tiles = v.length > 1 ? v[1] : 1;
        if (!validDir(dir) || tiles < 1) {
          this.setStatus(u, Status.ERR_INVALID);
          return;
        }
        const st = this.beginStepTile(u, dir, tiles);
        this.setStatus(u, st);
        if (st === Status.OK) u.vm.block();
        return;
      }
      case 'ACT':
      case 'USE':
        this.setStatus(u, Status.ERR_NO_TOOL); // Tools arrive in M5.
        return;
      case 'PEEK': {
        const slot = v[0];
        if (slot < 0 || slot >= u.cargo.length) {
          this.setStatus(u, Status.ERR_INVALID);
          return [0];
        }
        return [u.cargo[slot]];
      }
    }
  }

  // ---------------------------------------------------------------- admin

  readonly admin = {
    forceCharge: (u: Unit) => {
      u.energy = BALANCE.batteryCapacity;
      if (u.vm.state === CpuState.POWER_OFF) {
        u.vm.state = CpuState.RUNNING;
        u.vm.reboot();
        this.log(u, 'warn', 'ADMIN: battery recharged, cold boot.');
      } else this.log(u, 'warn', 'ADMIN: battery recharged.');
    },
    forceRepair: (u: Unit) => {
      u.hull = 100;
      if (u.vm.state === CpuState.DESTROYED) {
        u.vm.state = CpuState.RUNNING;
        u.vm.reboot();
      }
      this.log(u, 'warn', 'ADMIN: hull repaired.');
    },
    respawnAtOrigin: (u: Unit) => {
      u.x = 0;
      u.y = 0;
      u.action = null;
      u.motion = null;
      u.energy = BALANCE.batteryCapacity;
      u.hull = 100;
      u.vm.state = CpuState.RUNNING;
      u.vm.reboot();
      this.log(u, 'warn', 'ADMIN: respawned at origin.');
    },
  };
}
