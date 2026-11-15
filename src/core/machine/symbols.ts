/**
 * M15 predefined symbols of the PDP-11 core (docs/PDP11_IO.md §10): what the MACRO-11
 * assembler knows before the first line, like DEC's system macro library. Six characters
 * at most (owner decision 17); a test checks every one.
 */

import { PDP11 } from '../balance';
import { Alert, Dir, LightColor, ProgState, Preempt, Status } from '../types';
import type { WorldRegistry } from '../WorldRegistry';
import { CARGO_BASE, CSR, IO_REGISTERS, ProgFault, Why } from './iopage';
import { MsgType, SOH, ETX } from '../messages';

/** `E.` status codes (`OK` stays): today's values, new names. */
export const ERROR_NAMES: Record<string, Status> = {
  OK: Status.OK,
  'E.INV': Status.ERR_INVALID,
  'E.FULL': Status.ERR_FULL,
  'E.LOWP': Status.ERR_LOW_POWER,
  'E.BLK': Status.ERR_BLOCKED,
  'E.NOTL': Status.ERR_NO_TOOL,
  'E.NOSG': Status.ERR_NO_SIGNAL,
  'E.HAZ': Status.ERR_HAZARD,
  'E.DEPL': Status.ERR_DEPLOYED,
  'E.PRE': Status.ERR_PREEMPTED,
  'E.BUSY': Status.ERR_BUSY,
};

/** Function codes, already shifted into CSR bits 3–1. */
const fn = (n: number) => n << 1;
export const FUNCTION_NAMES: Record<string, number> = {
  'F.T0': fn(0), 'F.T1': fn(1), 'F.T2': fn(2), 'F.T3': fn(3),
  'F.M1': fn(1), 'F.M2': fn(2), 'F.M3': fn(3), 'F.M4': fn(4), 'F.M5': fn(5),
  'F.HULL': fn(0), 'F.SOL': fn(1), 'F.ANT': fn(2),
  'F.SEND': fn(1), 'F.ERAS': fn(2),
};

/** Every predefined symbol for a rover (tiles from the registry). */
export function predefinedSymbols(registry: WorldRegistry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of IO_REGISTERS) out[r.name] = r.addr;
  out.CARGO = CARGO_BASE;
  out.PSW = 0o177776;
  out.PRGBAS = PDP11.programBase;
  out.IMGBAS = PDP11.imageBase;
  out.GO = CSR.GO;
  out.IE = CSR.IE;
  out.DONE = CSR.DONE;
  out.READY = CSR.DONE;
  out.ERR = CSR.ERR;
  Object.assign(out, ERROR_NAMES, FUNCTION_NAMES);
  for (const [k, v] of Object.entries(MsgType)) out[`T.${k}`] = v;
  out.SOH = SOH;
  out.ETX = ETX;
  out['A.NONE'] = Alert.ALERT_NONE;
  out['A.ECL'] = Alert.ALERT_ECLIPSE;
  out['A.SQL'] = Alert.ALERT_SQUALL;
  out['P.NONE'] = ProgState.PROG_NONE;
  out['P.RDY'] = ProgState.PROG_READY;
  out['P.RUN'] = ProgState.PROG_RUNNING;
  out['P.DONE'] = ProgState.PROG_DONE;
  out['P.FLT'] = ProgState.PROG_FAULT;
  out['P.HLT'] = ProgState.PROG_HALTED;
  out['PR.ALR'] = Preempt.PRE_ALERT;
  out['PR.DMG'] = Preempt.PRE_DAMAGE;
  out['PR.BAT'] = Preempt.PRE_LOW_BAT;
  for (const [k, v] of Object.entries(Why)) if (k !== 'NONE') out[`W.${k}`] = v << 1;
  for (const [k, v] of Object.entries(ProgFault)) out[`PF.${k}`] = v;
  for (const k of ['NORTH', 'EAST', 'SOUTH', 'WEST'] as const) out[k] = Dir[k];
  for (const k of ['OFF', 'RED', 'GREEN', 'BLUE', 'AMBER'] as const) out[k] = LightColor[k];
  Object.assign(out, registry.shortConstants());
  return out;
}

/** A DEC name: 1–6 letters, digits, `.` and `$`, not starting with a digit. */
export const isDecName = (name: string): boolean => /^[A-Z.$][A-Z0-9.$]{0,5}$/.test(name);
