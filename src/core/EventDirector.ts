import { BALANCE } from './balance';
import { Rng } from './rng';
import type { SimulationEngine } from './SimulationEngine';
import { Alert } from './types';

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
  { id: 'first_contact', title: 'First contact', description: 'Transmit a packet to the relay orbiter (@TX_DATA).', target: 1, reward: 5, progress: (e) => e.stats.packetsSent },
  { id: 'night_owl', title: 'Night owl', description: 'Have a rover powered on at sunrise after a night.', target: 1, reward: 5, progress: (e) => e.stats.sunrisesPowered },
  { id: 'surveyor', title: 'Surveyor', description: 'Map 500 tiles.', target: 500, reward: 10, progress: (e) => e.world.mappedTiles },
  { id: 'trailblazer', title: 'Trailblazer', description: 'Drive 40 tiles (Manhattan distance) from the landing site.', target: 40, reward: 10, progress: (e) => e.stats.maxDistance },
  { id: 'prospector', title: 'Prospector', description: 'Mine 3 ore veins with the drill (ACT TOOL_0).', target: 3, reward: 10, progress: (e) => e.stats.oreMined },
  { id: 'collector', title: 'Collector', description: 'Pick up 2 surface items with the grabber (ACT TOOL_1).', target: 2, reward: 10, progress: (e) => e.stats.itemsCollected },
  { id: 'scientist', title: 'Scientist', description: 'Deliver 5 science packets to the orbiter.', target: 5, reward: 20, progress: (e) => e.stats.scienceDelivered },
  { id: 'eclipse', title: 'Into the dark', description: 'Keep a rover powered through a whole solar eclipse.', target: 1, reward: 15, progress: (e) => e.stats.eclipsesSurvived },
  { id: 'storm_chaser', title: 'Storm chaser', description: 'Come out of a micrometeorite squall with hull ≥ 50 and solar array ≥ 50.', target: 1, reward: 15, progress: (e) => e.stats.squallsWeathered },
];

export type WorldEventType = 'ECLIPSE' | 'SQUALL';

export interface ScheduledEvent {
  type: WorldEventType;
  warnTick: number;
  startTick: number;
  endTick: number;
  /** Started from the admin console: does not count toward goals. */
  admin?: boolean;
  /** Bookkeeping for goals: rover ids powered at the start (eclipse). */
  poweredAtStart?: number[];
}

export interface DirectorState {
  completed: string[];
  rngState: number;
  nextRollTick: number;
  events: ScheduledEvent[];
}

/**
 * The storyteller: schedules world events from a seeded RNG (one roll per sol),
 * announces them ahead of time, applies their environmental effect, and tracks goals.
 * Everything is a function of the seed and the tick, so saves replay identically.
 */
export class EventDirector {
  readonly completed = new Set<string>();
  rng: Rng;
  nextRollTick: number = BALANCE.eventEarliestTick;
  events: ScheduledEvent[] = [];

  constructor(private engine: SimulationEngine) {
    this.rng = new Rng((engine.seed ^ 0x5eed5eed) | 0);
  }

  /** Called at the start of every tick, before the sun is computed. */
  tick(t: number): void {
    const B = BALANCE;
    if (t >= this.nextRollTick) {
      this.rollSol(this.nextRollTick);
      this.nextRollTick += B.dayTicks;
    }
    for (const ev of this.events) {
      if (t === ev.warnTick && ev.warnTick < ev.startTick) this.emit('ALERT', ev);
      if (t === ev.startTick) this.onStart(ev);
      if (t === ev.endTick) this.onEnd(ev);
    }
    this.events = this.events.filter((ev) => ev.endTick >= t);
    this.applyEnvironment(t);
  }

  /** Eclipse light curve: ramp down, hold, ramp up. */
  applyEnvironment(t: number): void {
    let factor = 100;
    for (const ev of this.events) {
      if (ev.type !== 'ECLIPSE' || t < ev.startTick || t >= ev.endTick) continue;
      const ramp = BALANCE.eclipseRampTicks;
      const f = Math.min(t - ev.startTick, ev.endTick - 1 - t, ramp);
      factor = Math.min(factor, Math.max(0, Math.floor(100 - (f * 100) / ramp)));
    }
    this.engine.env.lightFactor = factor;
  }

  isActive(type: WorldEventType, t: number): boolean {
    return this.events.some((ev) => ev.type === type && t >= ev.startTick && t < ev.endTick);
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

  /** Admin: start an event right now (next tick). */
  triggerNow(type: WorldEventType): void {
    const t = this.engine.tick + 1;
    this.schedule(type, t, t).admin = true;
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
    return { completed: [...this.completed], rngState: this.rng.state, nextRollTick: this.nextRollTick, events: this.events.map((e) => ({ ...e })) };
  }

  loadState(s: DirectorState): void {
    this.completed.clear();
    for (const id of s.completed) this.completed.add(id);
    this.rng.state = s.rngState;
    this.nextRollTick = s.nextRollTick;
    this.events = s.events.map((e) => ({ ...e }));
  }

  // ------------------------------------------------------------------ internals

  private rollSol(from: number): void {
    const B = BALANCE;
    if (this.rng.next() < B.eclipseChancePerSol) {
      // Eclipses only make sense in daylight: pick a start when the sun is well up.
      for (let tries = 0; tries < 24; tries++) {
        const start = from + Math.floor(this.rng.next() * B.dayTicks);
        const sun = this.engine.env.sunRaw(start);
        if (sun.elevation >= 25 && this.engine.env.sunRaw(start + B.eclipseTicks).elevation >= 10) {
          this.schedule('ECLIPSE', start - B.eventWarnTicks, start);
          break;
        }
      }
    }
    if (this.rng.next() < B.squallChancePerSol) {
      const start = from + B.eventWarnTicks + Math.floor(this.rng.next() * (B.dayTicks - B.eventWarnTicks));
      this.schedule('SQUALL', start - B.eventWarnTicks, start);
    }
  }

  private schedule(type: WorldEventType, warnTick: number, startTick: number): ScheduledEvent {
    const len = type === 'ECLIPSE' ? BALANCE.eclipseTicks : BALANCE.squallTicks;
    const ev: ScheduledEvent = { type, warnTick, startTick, endTick: startTick + len };
    this.events.push(ev);
    this.events.sort((a, b) => a.startTick - b.startTick);
    return ev;
  }

  private onStart(ev: ScheduledEvent): void {
    if (ev.type === 'ECLIPSE') ev.poweredAtStart = this.engine.units.filter((u) => u.powered).map((u) => u.id);
    this.emit('START', ev);
  }

  private onEnd(ev: ScheduledEvent): void {
    const e = this.engine;
    if (ev.admin) {
      this.emit('END', ev);
      return;
    }
    if (ev.type === 'ECLIPSE') {
      if (e.units.some((u) => u.powered && ev.poweredAtStart?.includes(u.id))) e.stats.eclipsesSurvived++;
    } else if (e.units.some((u) => u.powered && u.hull >= 50 && u.solarHealth >= 50)) e.stats.squallsWeathered++;
    this.emit('END', ev);
  }

  private emit(phase: 'ALERT' | 'START' | 'END', ev: ScheduledEvent): void {
    this.engine.events.emit('WORLD_EVENT', { phase, type: ev.type, startTick: ev.startTick, endTick: ev.endTick });
  }
}
