import { BALANCE, CHASSIS_MK1, type ChassisDef } from './balance';
import { ChunkedWorld } from './ChunkedWorld';
import { EventBus } from './EventBus';
import { MapGenerator } from './MapGenerator';
import { EventDirector } from './EventDirector';
import { hash3 } from './rng';
import { UPGRADE_BY_ID } from './upgrades';
import type { SquallDamage } from './events';
import { TOOLS, type ToolDef } from './tools';
import { Environment, signalStrength, solarGain, wrapDeg, angleDiff, type SunState } from './Environment';
import { getPort, writePortClamped, type PortContext } from './ports';
import { CpuState, DIR_VEC, Layer, Status } from './types';
import { Unit } from './Unit';
import { compile, type CompileResult, type Instr } from './vm/Compiler';
import type { VmHost } from './vm/RoverVM';
import { coneOffsets, shapeContains, type SensorShape } from './sensors';
import { createDefaultRegistry, T, type WorldRegistry } from './WorldRegistry';

export interface EngineOptions {
  seed: number;
  registry?: WorldRegistry;
}

export interface SupplyDrop {
  id: number;
  upgrade: string;
  x: number;
  y: number;
  landTick: number;
  landed: boolean;
}

export interface UploadResult extends CompileResult {
  /** Energy charged for the upload (0 if rejected or free). */
  cost: number;
  /** Set when the program compiled but the rover could not accept it. */
  rejected?: string;
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
  readonly env = new Environment();
  readonly cheats = { freeUpload: false, invulnerable: false };
  readonly director: EventDirector;
  /** World-wide counters used by goals and the UI. */
  readonly stats = {
    packetsSent: 0,
    scienceDelivered: 0,
    oreMined: 0,
    itemsCollected: 0,
    itemsAnalyzed: 0,
    maxDistance: 0,
    sunrisesPowered: 0,
    eclipsesSurvived: 0,
    repairs: 0,
    upgradesInstalled: 0,
    squallsWeathered: 0,
  };
  /** Science credits: delivered science + goal rewards. Spent on upgrades. */
  credits = 0;
  /** Ordered upgrades: in flight (landed=false) or waiting on the ground. */
  drops: SupplyDrop[] = [];
  nextDropId = 1;
  tick = 0;
  sun: SunState;
  orbitAzimuth: number;
  nextUnitId = 1;
  readonly portCtx: PortContext;

  constructor(readonly opts: EngineOptions) {
    this.registry = opts.registry ?? createDefaultRegistry();
    this.world = new ChunkedWorld(new MapGenerator(opts.seed));
    this.world.onTileChanged = (x, y, layer, id) => this.events.emit('TILE_CHANGED', { x, y, layer, id });
    this.director = new EventDirector(this);
    this.sun = this.env.sun(0);
    this.orbitAzimuth = this.env.orbitAzimuth(0);
    const self = this;
    this.portCtx = {
      get tick() {
        return self.tick;
      },
      get sun() {
        return self.sun;
      },
      get orbitAzimuth() {
        return self.orbitAzimuth;
      },
      world: this.world,
      registry: this.registry,
      sensorRange: (u) => this.sensorRange(u),
      turn: (u, dir) => this.turn(u, dir),
      alert: () => this.director.alert(this.tick),
      drops: () => this.drops.filter((d) => d.landed),
      nearestDrop: (u) => this.nearestDrop(u),
      transmit: (u, v) => this.transmit(u, v),
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
    this.revealAround(u);
    return u;
  }

  /** Save/load: recreate a unit with a known id (no reveal, no program). */
  restoreUnit(id: number, name: string, chassis: ChassisDef): Unit {
    const u = new Unit(id, name, chassis);
    this.units.push(u);
    return u;
  }

  /** Recompute state derived from the tick (sun, orbiter, eclipse light) after a load. */
  refreshDerived(): void {
    this.director.applyEnvironment(this.tick);
    this.sun = this.env.sun(this.tick);
    this.orbitAzimuth = this.env.orbitAzimuth(this.tick);
    for (const u of this.units) this.world.touchRadius(u.x, u.y, BALANCE.chunkBubbleRadius);
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

  signalOf(u: Unit): number {
    return Math.floor((signalStrength(u.antennaAngle, this.orbitAzimuth) * u.antennaHealth) / 100);
  }

  /**
   * What the operator (player) sees around `u` right now: mapped into the fog of war and
   * lit by the renderer (shared with TileLighting; see sensors.ts). Needs light: daylight,
   * or at night the ring plus the headlight cone. The rover's own SCAN is radar and does
   * not depend on this.
   */
  viewShape(u: Unit): SensorShape {
    if (this.sun.elevation > 0) return { radius: BALANCE.dayViewRange, cone: -1 };
    return { radius: BALANCE.nightSensorRange, cone: u.headlight && u.powered ? u.heading : -1 };
  }

  /** Can the operator see the tile at offset (dx, dy) from `u` right now? */
  isVisible(u: Unit, dx: number, dy: number): boolean {
    return shapeContains(this.viewShape(u), dx, dy);
  }

  /** SCAN (radar) range in tiles: any direction, day or night (@SENSOR_RANGE). */
  sensorRange(u: Unit): number {
    return u.chassis.sensorRange;
  }

  /** Turn in place (@HEADING write). Costs a little energy; no-op if already facing `dir`. */
  private turn(u: Unit, dir: number): void {
    if (!u.powered || dir === u.heading) return;
    this.drain(u, BALANCE.turnEnergy);
    if (!u.powered) return;
    u.heading = dir;
  }

  /** Energy needed to flash a program of `bytes` at the current signal strength. */
  uploadCost(u: Unit, bytes: number): number {
    if (this.cheats.freeUpload) return 0;
    const base = BALANCE.uploadBase + BALANCE.uploadPerByte * bytes;
    return Math.ceil((base * 100) / Math.max(BALANCE.uploadSignalFloor, this.signalOf(u)));
  }

  /**
   * Compile and flash new firmware over the uplink; hard reboot on success.
   * `factory` installs firmware for free (new rovers, admin tools).
   */
  upload(unit: Unit, source: string, opts: { factory?: boolean } = {}): UploadResult {
    const res: UploadResult = { ...this.compileFor(unit, source), cost: 0 };
    if (!res.program) return res;
    if (!opts.factory) {
      if (!unit.powered) {
        res.rejected = `Rover is ${unit.vm.state}: it cannot receive firmware.`;
        return res;
      }
      const cost = this.uploadCost(unit, res.flashUsed);
      if (unit.energy <= cost) {
        res.rejected = `Upload needs ${(cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(unit)}; rover has ${(unit.energy / 1000).toFixed(1)}%.`;
        return res;
      }
      unit.energy -= cost;
      res.cost = cost;
    }
    unit.sourceCode = source;
    unit.action = null;
    unit.vm.load(res.program);
    unit.cyclesLeft = 0;
    const costMsg = res.cost ? `, cost ${(res.cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(unit)}` : '';
    this.log(unit, 'info', `Firmware flashed (${res.flashUsed}/${unit.chassis.flashBytes} bytes${costMsg}). Rebooting.`);
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
    const wasNight = this.sun.elevation <= 0;
    this.director.tick(this.tick);
    this.sun = this.env.sun(this.tick);
    const squall = this.director.active('SQUALL', this.tick)?.damage ?? null;
    if (wasNight && this.sun.elevation > 0) for (const u of this.units) if (u.powered) this.stats.sunrisesPowered++;
    this.orbitAzimuth = this.env.orbitAzimuth(this.tick);
    for (const u of this.units) {
      this.world.touchRadius(u.x, u.y, BALANCE.chunkBubbleRadius);
      this.updatePower(u);
      if (squall) this.applySquall(u, squall);
      this.updateUnitPhysics(u);
      this.revealAround(u);
      u.cyclesLeft = u.vm.state === CpuState.RUNNING ? u.chassis.cyclesPerTick : 0;
    }
    for (const d of this.drops) if (!d.landed && d.landTick === this.tick) this.landDrop(d);
    if (this.tick % 100 === 0) this.world.evictStale(BALANCE.chunkEvictAfterTicks);
    if (this.tick % 10 === 0) this.director.updateGoals();
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

  private revealAround(u: Unit): void {
    const s = this.viewShape(u);
    const key = `${u.x},${u.y},${s.radius},${s.cone}`;
    if (key === u.lastRevealKey) return;
    u.lastRevealKey = key;
    this.world.revealCircle(u.x, u.y, s.radius);
    if (s.cone >= 0) this.world.revealTiles(u.x, u.y, coneOffsets(s.cone));
  }

  /** Solar, actuators, lights and passive drain. Runs before actions each tick. */
  private updatePower(u: Unit): void {
    if (u.vm.state === CpuState.DESTROYED) return;
    const B = BALANCE;

    // Solar charging works even when powered off: that is how a dead rover recovers.
    u.lastSolarGain = u.solarDeployed ? Math.floor((solarGain(u.solarAngle, this.sun) * u.solarHealth * u.chassis.solarPercent) / 10_000) : 0;
    u.energy = Math.min(u.chassis.batteryCapacity, u.energy + u.lastSolarGain);

    if (u.vm.state === CpuState.POWER_OFF) {
      if (u.energy * 100 >= B.coldBootPercent * u.chassis.batteryCapacity) {
        u.vm.state = CpuState.RUNNING;
        u.vm.reboot();
        this.log(u, 'warn', 'Solar cold boot: battery recovered, firmware restarted.');
        this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
      }
      return;
    }

    let drain = B.idleDrainPerTick;
    if (u.headlight) drain += B.headlightPerTick;
    // Motors: deploy/stow array, slew panel and dish toward their targets.
    const deployTarget = u.solarOpen ? B.solarDeployTicks : 0;
    if (u.solarDeploy !== deployTarget) {
      u.solarDeploy += u.solarDeploy < deployTarget ? 1 : -1;
      drain += B.actuatorEnergyPerTick;
    }
    const slew = (cur: number, target: number): number => {
      const d = angleDiff(cur, target);
      if (d === 0) return cur;
      drain += B.actuatorEnergyPerTick;
      const step = Math.min(d, B.actuatorSlewDegPerTick);
      return wrapDeg(wrapDeg(target - cur) <= 180 ? cur + step : cur - step);
    };
    u.solarAngle = slew(u.solarAngle, u.solarTarget);
    u.antennaAngle = slew(u.antennaAngle, u.antennaTarget);
    this.drain(u, drain);
  }

  /** Micrometeorites: light hull wear (more while driving), dish wear, heavy damage to an exposed array. */
  private applySquall(u: Unit, d: SquallDamage): void {
    if (u.vm.state === CpuState.DESTROYED || this.cheats.invulnerable) return;
    const t = this.tick;
    if (d.hullEvery) {
      const base = d.hullEvery * u.chassis.hullArmor;
      const every = u.action?.kind === 'STEP' ? Math.max(1, Math.floor(base / 2)) : base;
      if (t % every === 0) this.damage(u, 1);
    }
    if (d.solarEvery && !u.solarStowed && t % d.solarEvery === 0) u.solarHealth = Math.max(0, u.solarHealth - d.solarDamage);
    if (d.antennaEvery && t % d.antennaEvery === 0) u.antennaHealth = Math.max(0, u.antennaHealth - 1);
  }

  private transmit(u: Unit, value: number): void {
    const signal = this.signalOf(u);
    let status = Status.OK;
    if (signal < BALANCE.txMinSignal) status = Status.ERR_NO_SIGNAL;
    else if (u.energy < BALANCE.txEnergy) status = Status.ERR_LOW_POWER;
    const ok = status === Status.OK;
    let science = false;
    if (ok) {
      this.drain(u, BALANCE.txEnergy);
      u.packetsSent++;
      this.stats.packetsSent++;
      if (u.scienceReady > 0) {
        u.scienceReady--;
        this.stats.scienceDelivered++;
        this.credits++;
        science = true;
      }
    }
    u.lastTx = { tick: this.tick, value, ok };
    this.setStatus(u, status);
    this.events.emit('UPLINK_PULSE', { unitId: u.id, x: u.x, y: u.y, value, ok, science });
  }

  private updateUnitPhysics(u: Unit): void {
    const vm = u.vm;
    if (vm.state === CpuState.DESTROYED) return;

    if (vm.state === CpuState.FAULT) {
      if (--vm.watchdog <= 0) {
        vm.reboot();
        u.action = null;
        this.log(u, 'warn', 'Watchdog reboot.');
        this.events.emit('UNIT_STATE', { unitId: u.id, state: vm.state });
      }
      return;
    }

    if (vm.state === CpuState.POWER_OFF) return;

    const act = u.action;
    if (!act) return;
    if (--act.ticksLeft > 0) return;

    if (act.kind === 'WAIT') {
      u.action = null;
      vm.unblock();
      return;
    }

    if (act.kind === 'TOOL') {
      const st = TOOLS[act.tool].complete(this, u, act.arg, act.arg2);
      this.finishAction(u, st);
      this.events.emit('TOOL_DONE', { unitId: u.id, tool: act.tool, status: st });
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
    this.stats.maxDistance = Math.max(this.stats.maxDistance, Math.abs(u.x) + Math.abs(u.y));
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
    if (u.solarOpen || !u.solarStowed) return Status.ERR_DEPLOYED;
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

  // ---------------------------------------------------------------- upgrades

  /** Why `id` cannot be bought for `u` right now, or null if it can. */
  upgradeBlocker(u: Unit, id: string): string | null {
    const def = UPGRADE_BY_ID[id];
    if (!def) return 'unknown upgrade';
    if (u.upgrades.includes(id)) return 'installed';
    if (this.drops.some((d) => d.upgrade === id)) return 'on its way';
    if (def.requires && !u.upgrades.includes(def.requires)) return `needs ${UPGRADE_BY_ID[def.requires]?.title ?? def.requires}`;
    if (this.credits < def.cost) return `needs ${def.cost} credits`;
    if (!u.powered) return 'rover is offline';
    return null;
  }

  /** Spend credits and send a supply crate; it lands near `u` after supplyDropTicks. */
  buyUpgrade(u: Unit, id: string): string | null {
    const why = this.upgradeBlocker(u, id);
    if (why) return why;
    const spot = this.findDropSpot(u);
    if (!spot) return 'no clear landing spot near the rover';
    this.credits -= UPGRADE_BY_ID[id].cost;
    const d: SupplyDrop = { id: this.nextDropId++, upgrade: id, x: spot[0], y: spot[1], landTick: this.tick + BALANCE.supplyDropTicks, landed: false };
    this.drops.push(d);
    this.events.emit('SUPPLY', { phase: 'ORDERED', upgrade: id, x: d.x, y: d.y, landTick: d.landTick });
    this.log(u, 'info', `Ordered ${UPGRADE_BY_ID[id].title}: supply crate lands at (${d.x}, ${d.y}) in ${BALANCE.supplyDropTicks} ticks.`);
    return null;
  }

  /** Deterministic clear tile on a Manhattan ring 3..6 tiles from the rover. */
  private findDropSpot(u: Unit): [number, number] | null {
    const B = BALANCE;
    for (let k = 0; k < 64; k++) {
      const h = hash3(this.seed, this.tick, this.nextDropId, k);
      const dist = B.supplyDropMinDist + (h % (B.supplyDropMaxDist - B.supplyDropMinDist + 1));
      const dx = ((h >>> 8) % (2 * dist + 1)) - dist;
      const dy = ((h >>> 20) & 1 ? 1 : -1) * (dist - Math.abs(dx));
      const x = u.x + dx;
      const y = u.y + dy;
      const terrain = this.registry.get(this.world.getTile(x, y, Layer.TERRAIN));
      if (terrain?.hazardDamage) continue;
      if (this.world.getTile(x, y, Layer.OBSTACLE) || this.world.getTile(x, y, Layer.ITEM) || this.unitAt(x, y)) continue;
      if (this.drops.some((d) => d.x === x && d.y === y)) continue;
      return [x, y];
    }
    return null;
  }

  private landDrop(d: SupplyDrop): void {
    d.landed = true;
    // The spot was checked when ordered; reveal it so the crate is visible on the map.
    this.world.setTile(d.x, d.y, Layer.ITEM, T.SUPPLY_CRATE);
    this.world.revealCircle(d.x, d.y, 1);
    this.events.emit('SUPPLY', { phase: 'LANDED', upgrade: d.upgrade, x: d.x, y: d.y, landTick: d.landTick });
  }

  nearestDrop(u: Unit): SupplyDrop | null {
    let best: SupplyDrop | null = null;
    let bd = Infinity;
    for (const d of this.drops) {
      if (!d.landed) continue;
      const dist = Math.abs(d.x - u.x) + Math.abs(d.y - u.y);
      if (dist < bd || (dist === bd && best && d.id < best.id)) {
        best = d;
        bd = dist;
      }
    }
    return best;
  }

  /** Grabber picked up a supply crate at (x, y): install its upgrade on `u` immediately. */
  openSupplyCrate(u: Unit, x: number, y: number): void {
    const i = this.drops.findIndex((d) => d.landed && d.x === x && d.y === y);
    if (i < 0) return;
    const [d] = this.drops.splice(i, 1);
    this.installUpgrade(u, d.upgrade);
    this.events.emit('SUPPLY', { phase: 'INSTALLED', upgrade: d.upgrade, x, y, landTick: d.landTick });
    this.log(u, 'info', `Installed ${UPGRADE_BY_ID[d.upgrade]?.title}.`);
  }

  installUpgrade(u: Unit, id: string): void {
    const def = UPGRADE_BY_ID[id];
    if (!def || u.upgrades.includes(id)) return;
    def.apply(u.chassis, u);
    u.upgrades.push(id);
    this.stats.upgradesInstalled++;
  }

  /** Validate, pay and start a tool action; the effect applies when it completes. */
  private startTool(u: Unit, tool: ToolDef, arg: number, arg2?: number): void {
    let st = tool.check(this, u, arg, arg2);
    if (st === Status.OK && u.energy < tool.energy) st = Status.ERR_LOW_POWER;
    this.setStatus(u, st);
    if (st !== Status.OK) return;
    this.drain(u, tool.energy);
    if (!u.powered) return;
    u.action = { kind: 'TOOL', tool: tool.id, arg, arg2, ticksLeft: tool.ticks };
    u.vm.block();
    const t = tool.target?.(u, arg) ?? null;
    if (tool.arg === 'dir' && arg >= 0 && arg <= 3) u.heading = arg;
    this.events.emit('TOOL_USED', { unitId: u.id, tool: tool.id, x: u.x, y: u.y, targetX: t?.[0] ?? null, targetY: t?.[1] ?? null, ticks: tool.ticks });
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
    if (this.cheats.invulnerable) return;
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
        // Radar: needs no light and does not turn the rover.
        const range = this.sensorRange(u);
        this.drain(u, BALANCE.scanEnergy);
        const [dx, dy] = DIR_VEC[dir];
        let hit = 0;
        let dist = 0;
        for (let d = 1; d <= range; d++) {
          const x = u.x + dx * d;
          const y = u.y + dy * d;
          hit = this.tileAt(x, y, Layer.ACTOR) || this.tileAt(x, y, Layer.OBSTACLE) || this.tileAt(x, y, Layer.ITEM);
          if (hit) {
            dist = d;
            break;
          }
        }
        this.events.emit('SCAN_PULSE', { unitId: u.id, x: u.x, y: u.y, dir, dist: dist || range, hit });
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
      case 'ACT': {
        const slot = v[0];
        if (slot < 0 || slot >= u.chassis.tools.length) {
          this.setStatus(u, Status.ERR_INVALID);
          return;
        }
        const id = u.chassis.tools[slot];
        if (!id) {
          this.setStatus(u, Status.ERR_NO_TOOL);
          return;
        }
        this.startTool(u, TOOLS[id], v.length > 1 ? v[1] : 0);
        return;
      }
      case 'USE':
        this.startTool(u, TOOLS.USE_ITEM, v[0], v[1]);
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
      u.energy = u.chassis.batteryCapacity;
      if (u.vm.state === CpuState.POWER_OFF) {
        u.vm.state = CpuState.RUNNING;
        u.vm.reboot();
        this.log(u, 'warn', 'ADMIN: battery recharged, cold boot.');
      } else this.log(u, 'warn', 'ADMIN: battery recharged.');
    },
    forceRepair: (u: Unit) => {
      u.hull = 100;
      u.solarHealth = 100;
      u.antennaHealth = 100;
      if (u.vm.state === CpuState.DESTROYED) {
        u.vm.state = CpuState.RUNNING;
        u.vm.reboot();
      }
      this.log(u, 'warn', 'ADMIN: hull repaired.');
    },
    teleport: (u: Unit, x: number, y: number): boolean => {
      if (this.isBlocked(x, y)) return false;
      u.x = x;
      u.y = y;
      u.action = null;
      u.motion = null;
      if (u.vm.state === CpuState.BLOCKED) u.vm.unblock();
      this.revealAround(u);
      this.log(u, 'warn', `ADMIN: teleported to (${x}, ${y}).`);
      return true;
    },
    respawnAtOrigin: (u: Unit) => {
      u.x = 0;
      u.y = 0;
      u.action = null;
      u.motion = null;
      u.energy = u.chassis.batteryCapacity;
      u.hull = 100;
      u.solarHealth = 100;
      u.antennaHealth = 100;
      u.vm.state = CpuState.RUNNING;
      u.vm.reboot();
      this.revealAround(u);
      this.log(u, 'warn', 'ADMIN: respawned at origin.');
    },
  };
}
