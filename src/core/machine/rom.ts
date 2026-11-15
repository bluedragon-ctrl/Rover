/**
 * M15 boot ROM (docs/PDP11_CPU.md §10), slice 3 part: boot, default handlers and the
 * program's exit stub. Drivers (`STEP`, `SCAN`, …), helpers (`MUL16`, …) and safe mode
 * come with slice 4. Readable MACRO-11, assembled once at 160000; nothing is hidden.
 *
 * Before the ROM runs, the disk controller (the host) has copied both images into core and
 * set `STKLIM` to the end of the firmware image (PDP11_CPU.md §6.2).
 */

import { assemble, type AssembleResult } from '../../pdp11';
import { BootReason } from '../downlink';
import { PDP11 } from '../balance';

export const ROM_SOURCE = `; Rover boot ROM (M15). Reset starts here, at priority 7.
BOOT:   MOV  #PRGBAS, SP        ; the firmware's stack grows down from the program base
        CLR  R0                 ; fill the vectors in use (000-150) with "ignore it":
        MOV  #UNEXP, R1         ;   handler address
        MOV  #340, R2           ;   and its PSW, priority 7
        MOV  #<VECEND/4>, R3    ;   vectors to fill
1$:     MOV  R1, (R0)+          ; registers, not memory, for what repeats:
        MOV  R2, (R0)+          ;   5 cycles a vector
        SOB  R3, 1$
        MOV  #PROBE, @#4        ; find the top of core: a bus error ends the search
        MOV  #2000, R0          ; the first 1 KB block is always there
2$:     TST  (R0)               ; is there memory here?
        ADD  #2000, R0          ; yes: try the next 1 KB
        BR   2$
PROBE:  ADD  #4, SP             ; the bus error came at R0, the first missing block:
                                ; forget the trap's PC and PSW
        MOV  #BUSERR, @#4       ; the real handlers
        MOV  #ILLINS, @#10
        MOV  #BPTH, @#14
        MOV  #TRPDEF, @#34
        MOV  #IE, @#LKS         ; line clock on: WAIT wakes at least once a tick
        CLR  -(SP)              ; the firmware's PSW: priority 0
        MOV  #200, -(SP)        ; the firmware starts at its first word
        RTI                     ; R0 = top of core

UNEXP:  RTI                     ; an interrupt or trap nobody handles: ignore it

BUSERR: MOV  #${BootReason.FAULT}., @#REBOOT    ; bus error in the firmware: reboot (reason: fault)
ILLINS: MOV  #${BootReason.FAULT}., @#REBOOT    ; illegal instruction: the same
BPTH:   HALT                    ; BPT or trace in the firmware: stop for the debugger
        RTI                     ; Continue resumes after the BPT

TRPDEF: HALT                    ; TRAP with no system call handler. Never runs: the gate
                                ; sees this address in vector 034 and ends the program
                                ; with P.FLT (PRGER = PF.TRP)

EXIT:   HALT                    ; a program's first return address: RTS PC from its
                                ; top level ends it like HALT (R0 = its result)
`;

function build(): AssembleResult {
  const a = assemble(ROM_SOURCE, {
    origin: PDP11.romBase,
    symbols: { VECEND: 0o154, PRGBAS: PDP11.programBase, LKS: 0o177546, REBOOT: 0o177024, IE: 0o100 },
  });
  if (!a.ok) throw new Error(`ROM does not assemble: ${a.errors.map((e) => `${e.line}: ${e.message}`).join('; ')}`);
  return a;
}

export const ROM = build();
export const ROM_BYTES: Uint8Array = ROM.bytes;
const label = (name: string): number => {
  const v = ROM.labels.has(name) ? ROM.symbols.get(name) : undefined;
  if (v === undefined) throw new Error(`ROM label ${name} missing`);
  return v;
};
/** Entry points the host needs. */
export const ROM_ENTRY = { BOOT: label('BOOT'), TRPDEF: label('TRPDEF'), EXIT: label('EXIT'), UNEXP: label('UNEXP') } as const;
