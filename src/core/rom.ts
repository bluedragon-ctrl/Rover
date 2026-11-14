/**
 * M14 ROM library (docs/ASSEMBLER_CORE.md §6): subroutines at code address 0xF000 that both
 * slots can CALL. They cost no Flash, run in the caller's context (its registers, stacks,
 * @STATUS) and take normal cycles. Reference → ROM shows the listing.
 *
 * Calling convention (§6.1): `CALL NAME args…` pushes the arguments; every routine pops all
 * of them. The drivers use no registers: they pop straight into the device ports. Helpers
 * return their answer in r0 and may change r0 and r1 (owner decision 2026-11-14: a routine
 * with two or more arguments cannot reach the second one without a second register).
 */
export const ROM_SOURCE = `; ROVER ROM v1: device drivers and helpers. Each one pops its arguments into the
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

; HELPERS. The answer comes back in r0. They may change r0 and r1
; (scratch, like ARM's r0-r3) and keep every other register.

; CALL ABS v: r0 = |v|.
ABS:    POP r0
        JGE r0 0 abs_x
        MUL r0 -1
abs_x:  RET

; CALL DIR_TO dx dy: r0 = the direction that shrinks the larger of
; |dx|, |dy| (a tie goes NORTH / SOUTH); -1 if both are 0 (arrived).
DIR_TO: POP r1                ; dy (pushed last)
        POP r0                ; dx
        PUSH r2
        MOV r2 r0
        JGE r2 0 dt_a
        MUL r2 -1             ; r2 = |dx|
dt_a:   PUSH r1               ; keep dy
        JGE r1 0 dt_b
        MUL r1 -1             ; r1 = |dy|
dt_b:   JGT r2 r1 dt_x        ; |dx| bigger: east or west
        POP r1                ; dy
        MOV r0 -1
        JEQ r1 0 dt_r         ; dx = dy = 0
        MOV r0 NORTH
        JGT r1 0 dt_r
        MOV r0 SOUTH
        JMP dt_r
dt_x:   POP r1                ; drop dy
        MOV r1 r0
        MOV r0 EAST
        JGT r1 0 dt_r
        MOV r0 WEST
dt_r:   POP r2
        RET

; CALL PUT16 addr v: store v as two bytes, high byte first, at data
; address addr (RAM, image memory). r0 = addr + 2 (the next free byte).
PUT16:  POP r1                ; v
        POP r0                ; addr
        STB [r0+1] r1         ; low byte (STB keeps the low 8 bits)
        SHR r1 8
        STB [r0] r1           ; high byte
        ADD r0 2
        RET

; CALL GET16 addr: r0 = the 16-bit value at addr, high byte first,
; with its sign (FE D4 = -300).
GET16:  POP r1                ; addr
        LDB r0 [r1]
        SHL r0 24             ; high byte to the top...
        LDB r1 [r1+1]
        SHL r1 16
        OR r0 r1
        DIV r0 65536          ; ...and back down: keeps the sign
        RET

; CALL PLOT x y grey: set pixel (x, y), 0-31, of a 32x32 2-bpp photo
; in image memory (modes 1, 2) to grey 0-3.
PLOT:   POP r1                ; grey
        AND r1 3
        POP r0                ; y
        SHL r0 2
        OR r1 r0              ; r1 = y * 4 + grey: two values, one register
        POP r0                ; x
        PUSH r2
        PUSH r3
        MOV r2 r1
        SHR r2 2              ; y
        SHL r2 3              ; y * 8: start of the row
        MOV r3 r0
        SHR r3 2
        ADD r2 r3             ; r2 = byte address: y * 8 + x / 4
        AND r0 3              ; pixel in the byte (0 = leftmost)
        MOV r3 3
        SUB r3 r0
        SHL r3 1              ; r3 = shift: 6, 4, 2 or 0
        AND r1 3
        SHL r1 r3             ; the grey, moved into place
        MOV r0 3
        SHL r0 r3             ; r0 = mask: the pixel's two bits
        LDB r3 [IMG+r2]
        OR r3 r0              ; set the pixel's bits...
        SUB r3 r0             ; ...take them away: now 00
        OR r3 r1              ; put the grey in
        STB [IMG+r2] r3
        POP r3
        POP r2
        RET
`;

/** Routines a program may CALL (reserved names: a label, CONST, ALIAS or VAR with one is an error). */
export const ROM_ENTRIES = ['SLEEP', 'STEP', 'SCAN', 'ACT', 'USE', 'SNAP', 'SEND', 'ERASE', 'RUN', 'ABS', 'DIR_TO', 'PUT16', 'GET16', 'PLOT'] as const;
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
  ABS: ['v'],
  DIR_TO: ['dx', 'dy'],
  PUT16: ['addr', 'v'],
  GET16: ['addr'],
  PLOT: ['x', 'y', 'grey'],
};

/** ROM routines only the firmware may call. */
export const FIRMWARE_ONLY_ROUTINES: ReadonlySet<string> = new Set(['RUN', 'PROGRAM']);
