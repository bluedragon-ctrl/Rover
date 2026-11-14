/**
 * M14 ROM library (docs/ASSEMBLER_CORE.md §6): subroutines at code address 0xF000 that both
 * slots can CALL. They cost no Flash, run in the caller's context (its registers, stacks,
 * @STATUS) and take normal cycles. Reference → ROM shows the listing.
 *
 * Calling convention (§6.1): `CALL NAME args…` pushes the arguments; every routine pops all
 * of them. The drivers use no registers: they pop straight into the device ports.
 */
export const ROM_SOURCE = `; ROVER ROM v1: device drivers. Each one pops its arguments into the
; device's ports, starts it, and WAITs until it is done, so @STATUS says
; how it ended. Read them, copy them, change them.

; CALL SLEEP ticks: do nothing for that many ticks (no energy).
SLEEP:  POP @TIMER            ; this slot's timer counts down...
        WAIT @TIMER           ; ...and the CPU sleeps until it reaches 0
        RET

; CALL STEP dir tiles: drive. @STATUS: OK, or why it was refused / stopped.
STEP:   POP @DRIVE_N          ; tiles (pushed last: popped first)
        POP @DRIVE            ; direction: starts the drive, @STATUS = accepted?
        JNE @STATUS OK step_x ; refused: busy, array open, wall ahead...
        WAIT @DRIVE           ; until the drive is idle; @STATUS = how it ended
step_x: RET

; CALL SCAN dir: one radar sweep. The answer waits in @RADAR_HIT, @RADAR_DIST.
SCAN:   POP @RADAR
        JNE @STATUS OK scan_x
        WAIT @RADAR
scan_x: RET

; CALL ACT tool arg: use the tool in hardpoint TOOL_0..TOOL_3 (arg: a
; direction or a cargo slot, as the tool needs).
ACT:    POP @TOOL_ARG
        POP @TOOL
        JNE @STATUS OK act_x
        WAIT @TOOL
act_x:  RET

; CALL USE slot system: repair a system with the material in a cargo slot.
USE:    POP @REPAIR_SYS
        POP @REPAIR
        JNE @STATUS OK use_x
        WAIT @REPAIR
use_x:  RET

; CALL SNAP dir mode: a photo into image memory.
SNAP:   POP @CAM_MODE
        POP @CAM
        JNE @STATUS OK snap_x
        WAIT @CAM
snap_x: RET

; CALL SEND type: image memory -> the science recorder (0 = the photo's mode).
SEND:   POP @SEND
        JNE @STATUS OK send_x
        WAIT @SEND
send_x: RET

; CALL ERASE: zero image memory.
ERASE:  MOV @ERASE 1
        JNE @STATUS OK era_x
        WAIT @ERASE
era_x:  RET

; CALL RUN ticks (firmware only): call the program for a time slice.
RUN:    POP @SLICE
        CALL PROGRAM          ; back here when the program ends or its time is up
        RET
`;

/** Routines a program may CALL (reserved names: a label, CONST, ALIAS or VAR with one is an error). */
export const ROM_ENTRIES = ['SLEEP', 'STEP', 'SCAN', 'ACT', 'USE', 'SNAP', 'SEND', 'ERASE', 'RUN'] as const;
export type RomEntry = (typeof ROM_ENTRIES)[number];

/**
 * The arguments each routine pops, in CALL order. The assembler checks the count: a routine
 * that pops more or fewer than were pushed would leave the data stack unbalanced.
 */
export const ROM_ARGS: Readonly<Record<RomEntry, readonly string[]>> = {
  SLEEP: ['ticks'],
  STEP: ['dir', 'tiles'],
  SCAN: ['dir'],
  ACT: ['tool', 'arg'],
  USE: ['slot', 'system'],
  SNAP: ['dir', 'mode'],
  SEND: ['type'],
  ERASE: [],
  RUN: ['ticks'],
};

/** ROM routines only the firmware may call. */
export const FIRMWARE_ONLY_ROUTINES: ReadonlySet<string> = new Set(['RUN', 'PROGRAM']);
