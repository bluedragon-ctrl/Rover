/**
 * M15 predefined symbols of the PDP-11 core (docs/PDP11_IO.md §10): what the MACRO-11
 * assembler knows before the first line, like DEC's system macro library: the system names
 * (names.ts), the ROM's entry points (rom.ts, so a program writes `JSR PC, STEP`) and the
 * tiles. Six characters at most (owner decision 17); a test checks every one.
 */

import type { WorldRegistry } from '../WorldRegistry';
import { systemSymbols } from './names';
import { ROM_EXPORTS } from './rom';

export { ERROR_NAMES, FUNCTION_NAMES, systemSymbols } from './names';

/** Every predefined symbol for a rover (tiles from the registry). */
export function predefinedSymbols(registry: WorldRegistry): Record<string, number> {
  return { ...systemSymbols(), ...ROM_EXPORTS, ...registry.shortConstants() };
}

/** A DEC name: 1–6 letters, digits, `.` and `$`, not starting with a digit. */
export const isDecName = (name: string): boolean => /^[A-Z.$][A-Z0-9.$]{0,5}$/.test(name);
