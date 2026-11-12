/**
 * Storyteller event catalogue. Declarative: add an entry here and the EventDirector
 * schedules it, gates it behind its prerequisites, and the UI lists it.
 */
export type WorldEventKind = 'ECLIPSE' | 'SQUALL';

export interface SquallDamage {
  /** 1 hull damage every N ticks (N/2 while driving). 0 = none. */
  hullEvery: number;
  /** 1 dish damage every N ticks. 0 = none. */
  antennaEvery: number;
  /** `solarDamage` to an array that is not fully stowed every N ticks. 0 = none. */
  solarEvery: number;
  solarDamage: number;
}

export interface EventRequirements {
  /** Goal ids that must be completed. */
  goals?: string[];
  /** Event ids that must have happened (started, not admin-triggered) at least once. */
  seen?: string[];
  /** Earliest sol (1-based). */
  minSol?: number;
}

export interface EventDef {
  id: string;
  kind: WorldEventKind;
  title: string;
  description: string;
  /** Gentle introductory variant. */
  teaching: boolean;
  /** Scheduled for certain at the first roll after it unlocks (one per sol). */
  guaranteedFirst?: boolean;
  chancePerSol: number;
  ticks: number;
  warnTicks: number;
  /** Eclipse: light factor at totality (0–100). */
  lightMin?: number;
  /** Squall damage profile. */
  damage?: SquallDamage;
  requires: EventRequirements;
}

/** Order matters: earlier entries win the "one guaranteed teaching event per sol" slot. */
export const EVENT_DEFS: EventDef[] = [
  {
    id: 'DUST_SQUALL',
    kind: 'SQUALL',
    title: 'Dust squall (training)',
    description: 'A light squall with a long warning. Teaches stowing the solar array on @ALERT.',
    teaching: true,
    guaranteedFirst: true,
    chancePerSol: 0.15,
    ticks: 60,
    warnTicks: 400,
    damage: { hullEvery: 20, antennaEvery: 0, solarEvery: 3, solarDamage: 1 },
    requires: { goals: ['first_contact'] },
  },
  {
    id: 'PARTIAL_ECLIPSE',
    kind: 'ECLIPSE',
    title: 'Partial eclipse (training)',
    description: 'Daylight dips to 40 % for a while. Teaches watching @SUN_LIGHT.',
    teaching: true,
    guaranteedFirst: true,
    chancePerSol: 0.15,
    ticks: 120,
    warnTicks: 300,
    lightMin: 40,
    requires: { goals: ['first_contact'] },
  },
  {
    id: 'SQUALL',
    kind: 'SQUALL',
    title: 'Micrometeorite squall',
    description: 'Wears the hull (more while driving) and dish; wrecks an open solar array.',
    teaching: false,
    chancePerSol: 0.35,
    ticks: 100,
    warnTicks: 200,
    damage: { hullEvery: 10, antennaEvery: 20, solarEvery: 3, solarDamage: 2 },
    requires: { seen: ['DUST_SQUALL'], minSol: 3 },
  },
  {
    id: 'ECLIPSE',
    kind: 'ECLIPSE',
    title: 'Total solar eclipse',
    description: 'Daylight goes to zero for 150 ticks: no solar charging.',
    teaching: false,
    chancePerSol: 0.3,
    ticks: 150,
    warnTicks: 200,
    lightMin: 0,
    requires: { seen: ['PARTIAL_ECLIPSE'], goals: ['night_owl'], minSol: 3 },
  },
];

export const EVENT_BY_ID: Record<string, EventDef> = Object.fromEntries(EVENT_DEFS.map((d) => [d.id, d]));

export function describeRequirements(r: EventRequirements, goalTitle: (id: string) => string = (id) => id): string {
  const parts: string[] = [];
  if (r.goals?.length) parts.push(`goal ${r.goals.map(goalTitle).join(', ')}`);
  if (r.seen?.length) parts.push(`after: ${r.seen.map((id) => EVENT_BY_ID[id]?.title ?? id).join(', ')}`);
  if (r.minSol) parts.push(`from sol ${r.minSol}`);
  return parts.join(' · ') || 'always';
}
