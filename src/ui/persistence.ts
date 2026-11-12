import { deserialize, serialize } from '../core/SaveManager';
import type { SimulationEngine } from '../core/SimulationEngine';

const KEY = 'rover.autosave.v1';

export function readAutosave(): unknown | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeAutosave(e: SimulationEngine): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...serialize(e), savedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false; // quota / private mode
  }
}

export function writeAutosaveRaw(snapshot: unknown): void {
  localStorage.setItem(KEY, JSON.stringify(snapshot));
}

export function clearAutosave(): void {
  localStorage.removeItem(KEY);
}

/** Load the autosave if it matches the requested seed (or no seed was requested). */
export function tryLoadAutosave(seedParam: number | null): { engine: SimulationEngine | null; error?: string } {
  const snap = readAutosave() as { seed?: number } | null;
  if (!snap) return { engine: null };
  if (seedParam !== null && snap.seed !== seedParam) return { engine: null };
  try {
    return { engine: deserialize(snap) };
  } catch (err) {
    return { engine: null, error: (err as Error).message };
  }
}

export function downloadSave(e: SimulationEngine): void {
  const blob = new Blob([JSON.stringify({ ...serialize(e), savedAt: new Date().toISOString() }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rover-seed${e.seed}-t${e.tick}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
