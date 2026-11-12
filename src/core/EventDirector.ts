import { BALANCE } from './balance';
import { Rng } from './rng';
import type { SimulationEngine } from './SimulationEngine';
import { Alert } from './types';
import { EVENT_BY_ID, EVENT_DEFS, type EventDef, type WorldEventKind } from './events';

export interface GoalDef {
  id: string;
  title: string;
  description: string;
  target: number;
  /** Science credits awarded on completion. */
  reward: number;
  progress(e: SimulationEngine): number;
}

/** Sandbox goals. Order = suggested order in the UI. */
export const GOALS: GoalDef[] = [
  { id: 'first_contact', title: 'First contact', description: 'Receive a first frame over the downlink (LOG, with the dish on the relay orbiter).', target: 1, reward: 5, progress: (e) => e.stats.framesReceived },
  { id: 'night_owl', title: 'Night owl', description: 'Have a rover powered on at sunrise after a night.', target: 1, reward: 5, progress: (e) => e.stats.sunrisesPowered },
  { id: 'surveyor', title: 'Surveyor', description: 'Map 500 tiles.', target: 500, reward: 10, progress: (e) => e.world.mappedTiles },
  { id: 'trailblazer', title: 'Trailblazer', description: 'Drive 40 tiles (Manhattan distance) from the landing site.', target: 40, reward: 10, progress: (e) => e.stats.maxDistance },
  { id: 'prospector', title: 'Prospector', description: 'Mine 3 ore veins with the drill (ACT TOOL_0).', target: 3, reward: 10, progress: (e) => e.stats.oreMined },
  { id: 'collector', title: 'Collector', description: 'Pick up 2 surface items with the grabber (ACT TOOL_1).', target: 2, reward: 10, progress: (e) => e.stats.itemsCollected },
  { id: 'scientist', title: 'Scientist', description: 'Deliver 5 science products (spectra) over the downlink.', target: 5, reward: 20, progress: (e) => e.stats.scienceDelivered },
  { id: 'field_engineer', title: 'Field engineer', description: 'Repair a system with material from cargo (USE slot SYS_*).', target: 1, reward: 10, progress: (e) => e.stats.repairs },
  { id: 'upgraded', title: 'Upgraded', description: 'Buy an upgrade and pick up its supply crate with the grabber.', target: 1, reward: 5, progress: (e) => e.stats.upgradesInstalled },
  { id: 'eclipse', title: 'Into the dark', description: 'Keep a rover powered through a whole solar eclipse.', target: 1, reward: 15, progress: (e) => e.stats.eclipsesSurvived },
  { id: 'storm_chaser', title: 'Storm chaser', description: 'Come out of a micrometeorite squall with hull ≥ 50 and solar array ≥ 50.', target: 1, reward: 15, progress: (e) => e.stats.squallsWeathered },
];

export type WorldEventType = WorldEventKind;

export interface ScheduledEvent {
  /** EventDef id (see events.ts). */
  def: string;
  type: WorldEventKind;
  warnTick: number;
  startTick: number;
  endTick: number;
  /** Started from the admin console: does not count toward goals or prerequisites. */
  admin?: boolean;
  /** Bookkeeping for goals: rover ids powered at the start (eclipse). */
  poweredAtStart?: number[];
}

export interface DirectorState {
  completed: string[];
  rngState: number;
  nextRollTick: number;
  events: ScheduledEvent[];
  /** How many times each event def has happened (non-admin). */
  history: Record<string, number>;
}

/**
 * The storyteller: once per sol it looks at which events are unlocked (prerequisites:
 * goals, previously experienced events, sol), schedules guaranteed teaching events
 * first, rolls the rest from a seeded RNG, announces them, applies their effects and
 * tracks goals. Everything is a function of seed + tick + player progress.
 */
export class EventDirector {
  readonly completed = new Set<string>();
  rng: Rng;
  nextRollTick: number = BALANCE.eventEarliestTick;
  events: ScheduledEvent[] = [];
  history: Record<string, number> = {};

  constructor(private engine: SimulationEngine) {
    this.rng = new Rng((engine.seed ^ 0x5eed5eed) | 0);
  }

  /** Called at the start of every tick, before the sun is computed. */
  tick(t: number): void {
    if (t >= this.nextRollTick) {
      this.rollSol(this.nextRollTick);
      this.nextRollTick += BALANCE.dayTicks;
    }
    for (const ev of this.events) {
      if (t === ev.warnTick && ev.warnTick < ev.startTick) this.emit('ALERT', ev);
      if (t === ev.startTick) this.onStart(ev);
      if (t === ev.endTick) this.onEnd(ev);
    }
    this.events = this.events.filter((ev) => ev.endTick >= t);
    this.applyEnvironment(t);
  }

  isUnlocked(def: EventDef): boolean {
    const r = def.requires;
    if (r.goals?.some((g) => !this.completed.has(g))) return false;
    if (r.seen?.some((id) => !this.history[id])) return false;
    if (r.minSol && this.engine.env.dayNumber(this.engine.tick) < r.minSol) return false;
    return true;
  }

  /** Eclipse light curve: ramp down to the def's minimum, hold, ramp up. */
  applyEnvironment(t: number): void {
    let factor = 100;
    for (const ev of this.events) {
      if (ev.type !== 'ECLIPSE' || t < ev.startTick || t >= ev.endTick) continue;
      const min = EVENT_BY_ID[ev.def]?.lightMin ?? 0;
      const ramp = BALANCE.eclipseRampTicks;
      const f = Math.min(t - ev.startTick, ev.endTick - 1 - t, ramp);
      factor = Math.min(factor, Math.max(min, Math.floor(100 - (f * (100 - min)) / ramp)));
    }
    this.engine.env.lightFactor = factor;
  }

  isActive(type: WorldEventKind, t: number): boolean {
    return this.active(type, t) !== null;
  }

  /** The active event of a kind (its def drives the effect), or null. */
  active(type: WorldEventKind, t: number): EventDef | null {
    const ev = this.events.find((e) => e.type === type && t >= e.startTick && t < e.endTick);
    return ev ? EVENT_BY_ID[ev.def] : null;
  }

  /** Most urgent announced or active event, for the @ALERT port and the HUD. */
  alert(t: number): { type: Alert; eta: number; event: ScheduledEvent | null } {
    let best: ScheduledEvent | null = null;
    for (const ev of this.events) {
      if (t < ev.warnTick || t >= ev.endTick) continue;
      if (!best || ev.startTick < best.startTick) best = ev;
    }
    if (!best) return { type: Alert.ALERT_NONE, eta: 0, event: null };
    return { type: best.type === 'ECLIPSE' ? Alert.ALERT_ECLIPSE : Alert.ALERT_SQUALL, eta: Math.max(0, best.startTick - t), event: best };
  }

  /** Admin: start an event right now (next tick), ignoring prerequisites. */
  triggerNow(defId: string): void {
    const def = EVENT_BY_ID[defId];
    if (!def) throw new Error(`Unknown event ${defId}`);
    const t = this.engine.tick + 1;
    this.schedule(def, t, t).admin = true;
  }

  updateGoals(): void {
    for (const g of GOALS) {
      if (this.completed.has(g.id)) continue;
      if (g.progress(this.engine) >= g.target) {
        this.completed.add(g.id);
        this.engine.credits += g.reward;
        this.engine.events.emit('GOAL_COMPLETED', { id: g.id, title: g.title, reward: g.reward });
      }
    }
  }

  saveState(): DirectorState {
    return {
      completed: [...this.completed],
      rngState: this.rng.state,
      nextRollTick: this.nextRollTick,
      events: this.events.map((e) => ({ ...e })),
      history: { ...this.history },
    };
  }

  loadState(s: DirectorState): void {
    this.completed.clear();
    for (const id of s.completed) this.completed.add(id);
    this.rng.state = s.rngState;
    this.nextRollTick = s.nextRollTick;
    this.events = s.events.map((e) => ({ ...e }));
    this.history = { ...(s.history ?? {}) };
  }

  // ------------------------------------------------------------------ internals

  private rollSol(from: number): void {
    const kindsThisSol = new Set<WorldEventKind>();
    let guaranteedUsed = false;
    for (const def of EVENT_DEFS) {
      // Always consume the same RNG draws per def so the schedule stays stable.
      const roll = this.rng.next();
      const timing = this.rng.next();
      if (!this.isUnlocked(def) || kindsThisSol.has(def.kind)) continue;
      const pending = this.events.some((e) => e.def === def.id && !e.admin);
      const guaranteed = !!def.guaranteedFirst && !this.history[def.id] && !pending && !guaranteedUsed;
      if (!guaranteed && roll >= def.chancePerSol) continue;
      const start = this.pickStart(def, from, timing);
      if (start === null) continue;
      this.schedule(def, start - def.warnTicks, start);
      kindsThisSol.add(def.kind);
      if (guaranteed) guaranteedUsed = true;
    }
  }

  /** Choose a start tick in [from, from + day). Eclipses need the sun well up. */
  private pickStart(def: EventDef, from: number, timing: number): number | null {
    const B = BALANCE;
    const earliest = from + def.warnTicks;
    const span = B.dayTicks - def.warnTicks;
    if (def.kind !== 'ECLIPSE') return earliest + Math.floor(timing * span);
    for (let i = 0; i < 24; i++) {
      const start = earliest + Math.floor(((timing + i / 24) % 1) * span);
      if (this.engine.env.sunRaw(start).elevation >= 25 && this.engine.env.sunRaw(start + def.ticks).elevation >= 10) return start;
    }
    return null;
  }

  private schedule(def: EventDef, warnTick: number, startTick: number): ScheduledEvent {
    const ev: ScheduledEvent = { def: def.id, type: def.kind, warnTick, startTick, endTick: startTick + def.ticks };
    this.events.push(ev);
    this.events.sort((a, b) => a.startTick - b.startTick);
    return ev;
  }

  private onStart(ev: ScheduledEvent): void {
    if (!ev.admin) this.history[ev.def] = (this.history[ev.def] ?? 0) + 1;
    if (ev.type === 'ECLIPSE') ev.poweredAtStart = this.engine.units.filter((u) => u.powered).map((u) => u.id);
    this.emit('START', ev);
  }

  private onEnd(ev: ScheduledEvent): void {
    const e = this.engine;
    if (!ev.admin) {
      if (ev.type === 'ECLIPSE') {
        if (e.units.some((u) => u.powered && ev.poweredAtStart?.includes(u.id))) e.stats.eclipsesSurvived++;
      } else if (e.units.some((u) => u.powered && u.hull >= 50 && u.solarHealth >= 50)) e.stats.squallsWeathered++;
    }
    this.emit('END', ev);
  }

  private emit(phase: 'ALERT' | 'START' | 'END', ev: ScheduledEvent): void {
    this.engine.events.emit('WORLD_EVENT', { phase, type: ev.type, def: ev.def, startTick: ev.startTick, endTick: ev.endTick });
  }
}
