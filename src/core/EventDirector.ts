import type { SimulationEngine } from './SimulationEngine';

export interface GoalDef {
  id: string;
  title: string;
  description: string;
  target: number;
  /** Science credits awarded on completion. */
  reward: number;
  progress(e: SimulationEngine): number;
}

/** First set of sandbox goals. Order = suggested order in the UI. */
export const GOALS: GoalDef[] = [
  { id: 'first_contact', title: 'First contact', description: 'Transmit a packet to the relay orbiter (@TX_DATA).', target: 1, reward: 5, progress: (e) => e.stats.packetsSent },
  { id: 'night_owl', title: 'Night owl', description: 'Have a rover powered on at sunrise after a night.', target: 1, reward: 5, progress: (e) => e.stats.sunrisesPowered },
  { id: 'surveyor', title: 'Surveyor', description: 'Map 500 tiles.', target: 500, reward: 10, progress: (e) => e.world.mappedTiles },
  { id: 'trailblazer', title: 'Trailblazer', description: 'Drive 40 tiles (Manhattan distance) from the landing site.', target: 40, reward: 10, progress: (e) => e.stats.maxDistance },
  { id: 'prospector', title: 'Prospector', description: 'Mine 3 ore veins with the drill (ACT TOOL_0).', target: 3, reward: 10, progress: (e) => e.stats.oreMined },
  { id: 'collector', title: 'Collector', description: 'Pick up 2 surface items with the grabber (ACT TOOL_1).', target: 2, reward: 10, progress: (e) => e.stats.itemsCollected },
  { id: 'scientist', title: 'Scientist', description: 'Deliver 5 science packets to the orbiter.', target: 5, reward: 20, progress: (e) => e.stats.scienceDelivered },
];

/**
 * The storyteller. M5: tracks goals. M6: will also schedule events (eclipses,
 * micrometeorite squalls) from the seeded RNG.
 */
export class EventDirector {
  readonly completed = new Set<string>();

  constructor(private engine: SimulationEngine) {}

  update(): void {
    for (const g of GOALS) {
      if (this.completed.has(g.id)) continue;
      if (g.progress(this.engine) >= g.target) {
        this.completed.add(g.id);
        this.engine.credits += g.reward;
        this.engine.events.emit('GOAL_COMPLETED', { id: g.id, title: g.title, reward: g.reward });
      }
    }
  }
}
