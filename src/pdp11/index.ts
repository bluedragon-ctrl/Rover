/**
 * PDP-11 compatible CPU, assembler and disassembler: a standalone library.
 *
 * Rover is its first user, not its owner: nothing in this folder imports from the game
 * (a test enforces it). Deterministic, integer-only, no DOM. Design: docs/PDP11_CPU.md §14.
 */

export { Cpu, BUS_ERROR, VEC, PSW, PSW_ADDRESS } from './cpu';
export type { Bus, CpuOptions, CpuState, CycleModel, RunResult, StopReason, TrapCause, TrapInfo } from './cpu';
export { assemble } from './assembler';
export type { AsmError, AsmLine, AssembleOptions, AssembleResult, NameStyle } from './assembler';
export { disassemble } from './disassembler';
export type { Disassembled, DisassembleOptions } from './disassembler';
export { INSTRUCTIONS, BY_NAME, decodeOp, octal } from './isa';
export type { Format, OpInfo } from './isa';
export { DeviceMachine, DL11, KW11L } from './devices';
export type { Device, DeviceMachineOptions, DL11Options } from './devices';
export { SimpleMachine, DEV, CSR } from './machine';
export type { MachineOptions } from './machine';
