import type { CpuState, Status } from './types';
import type { WorldEventType } from './EventDirector';

export interface SimEvents {
  TICK: { tick: number };
  UNIT_MOVED: { unitId: number; fromX: number; fromY: number; toX: number; toY: number; startTick: number; endTick: number };
  TILE_CHANGED: { x: number; y: number; layer: number; id: number };
  SCAN_PULSE: { unitId: number; x: number; y: number; dir: number; dist: number; hit: number };
  UPLINK_PULSE: { unitId: number; x: number; y: number; value: number; ok: boolean; science: boolean };
  TOOL_USED: { unitId: number; tool: string; x: number; y: number; targetX: number | null; targetY: number | null; ticks: number };
  TOOL_DONE: { unitId: number; tool: string; status: number };
  GOAL_COMPLETED: { id: string; title: string; reward: number };
  WORLD_EVENT: { phase: 'ALERT' | 'START' | 'END'; type: WorldEventType; def: string; startTick: number; endTick: number };
  UNIT_STATE: { unitId: number; state: CpuState };
  UNIT_STATUS: { unitId: number; status: Status };
  LOG: { unitId: number; level: 'info' | 'warn' | 'error'; message: string };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof SimEvents, Set<Handler<never>>>();

  on<K extends keyof SimEvents>(type: K, fn: Handler<SimEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof SimEvents>(type: K, payload: SimEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) (fn as Handler<SimEvents[K]>)(payload);
  }
}
