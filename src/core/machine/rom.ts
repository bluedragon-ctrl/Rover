/**
 * M15 ROM (docs/PDP11_CPU.md §10, PDP11_IO.md §6): boot with safe mode, default handlers,
 * the program's exit stub, the device drivers and the helpers. Readable MACRO-11, assembled
 * once at 160000; nothing is hidden (Reference → ROM shows this source).
 *
 * Calling convention: `JSR PC, NAME`. Arguments in R0 and R1 (a third in R2, which is kept);
 * the result in R0, with the flags from it (`BNE` = not OK); R0 and R1 are scratch, every
 * other register is kept. Drivers return the device's error code (`OK` = 0).
 *
 * Before the ROM runs, the disk controller (the host) has copied both images into core and
 * set `STKLIM` to the end of the firmware image (PDP11_CPU.md §6.2).
 */

import { assemble, type AssembleResult } from '../../pdp11';
import { BootReason } from '../downlink';
import { PDP11 } from '../balance';
import { IMG_CHUNK } from '../messages';
import { systemSymbols } from './names';

export const ROM_SOURCE = `; Rover ROM (M15). Reset starts here, at priority 7.
;
; ---------------------------------------------------------------- boot
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
        CMP  @#BOOTCT, #SAFEN   ; safe mode: SAFEN fault or watchdog reboots in a row
        BLO  3$                 ;   (within SAFET ticks) mean the firmware is broken
        BIS  #SAFE, @#BOOTCS    ; latched until mission control uploads a firmware
3$:     MOV  #200, R1           ; the firmware starts at its first word...
        BIT  #SAFE, @#BOOTCS
        BEQ  4$
        MOV  #SAFEFW, R1        ; ...unless the rover is in safe mode
4$:     CLR  -(SP)              ; the firmware's PSW: priority 0
        MOV  R1, -(SP)
        RTI                     ; R0 = top of core

; ---------------------------------------------------------------- default handlers
UNEXP:  RTI                     ; an interrupt or trap nobody handles: ignore it

BUSERR: MOV  #FAULT, @#REBOOT   ; bus error in the firmware: reboot (reason: fault)
ILLINS: MOV  #FAULT, @#REBOOT   ; illegal instruction: the same
BPTH:   HALT                    ; BPT or trace in the firmware: stop for the debugger
        RTI                     ; Continue resumes after the BPT

TRPDEF: HALT                    ; TRAP with no system call handler. Never runs: the gate
                                ; sees this address in vector 034 and ends the program
                                ; with P.FLT (PRGER = PF.TRP)

EXIT:   HALT                    ; a program's first return address: RTS PC from its
                                ; top level ends it like HALT (R0 = its result)

; ---------------------------------------------------------------- safe mode
; The built-in firmware the boot ROM runs instead of a broken one: it keeps the rover
; alive and talking until mission control uploads a new firmware. It never runs the
; program. Comms shows "SAFE MODE", then a battery heartbeat (LOG tag 1).
SAFEFW: MOV  #RED, @#IND1       ; lamp 1 red: safe mode
        CLR  @#IND2
        CLR  @#IND3
        CLR  @#LIGHT
        MOV  #T.TEXT, R0
        MOV  #SAFMSG, R1
        MOV  #SAFLEN, R2
        JSR  PC, PUTMSG         ; tell mission control (if the link is up)
1$:     MOV  @#ORBAZ, @#ANTANG  ; dish on the orbiter
        MOV  #1, @#SOLOPN       ; array open, on the sun...
        CMP  @#ALERT, #A.SQL
        BNE  2$
        CLR  @#SOLOPN           ; ...but stowed when a squall is coming
2$:     MOV  @#SUNAZ, @#SOLANG
        MOV  #1, R0             ; heartbeat: LOG 1, battery
        MOV  @#BAT, R1
        JSR  PC, LOG
        MOV  #50., R0
        JSR  PC, SLEEP
        BR   1$
SAFMSG: .ASCII /SAFE MODE/
SAFLEN = . - SAFMSG
        .EVEN

; ---------------------------------------------------------------- drivers
; Every driver follows the same path (PDP11_IO.md §3.1): parameters, GO, wait for DONE,
; R0 = the device's error register: OK, or why it was refused or failed.

; STEP: drive R1 tiles in direction R0.
STEP:   MOV  R1, @#DRVCNT       ; how far
        MOV  R0, @#DRVDIR       ; which way
        BIS  #GO, @#DRVCS       ; start (BIS keeps IE); refused: DONE + ERR at once
        MOV  #DRVCS, R1
        BR   DWAIT

; SCAN: one radar sweep in direction R0. Then RADHIT = what it found, RADDST = how far.
SCAN:   MOV  R0, @#RADDIR
        BIS  #GO, @#RADCS
        MOV  #RADCS, R1
        BR   DWAIT

; ACT: use a tool. R0 = its argument (a direction, or a cargo slot), R1 = the hardpoint
; F.T0 ... F.T3. Mk-I: F.T0 drill, F.T1 grabber, F.T2 spectrometer.
ACT:    MOV  R0, @#TOLARG
        BIS  #GO, R1            ; function + GO
        BIC  #16, @#TOLCS       ; clear the old function (keeps IE)...
        BIS  R1, @#TOLCS        ; ...and start with the new one
        MOV  #TOLCS, R1
        BR   DWAIT

; USE: repair a system with the item in cargo slot R0. R1 = F.HULL, F.SOL or F.ANT.
USE:    MOV  R0, @#REPSLT
        BIS  #GO, R1
        BIC  #16, @#REPCS
        BIS  R1, @#REPCS
        MOV  #REPCS, R1
        BR   DWAIT

; SNAP: take a photo in direction R0 into image memory. R1 = the mode F.M1 ... F.M5.
SNAP:   MOV  R0, @#CAMDIR
        BIS  #GO, R1
        BIC  #16, @#CAMCS
        BIS  R1, @#CAMCS
        MOV  #CAMCS, R1
        BR   DWAIT

; ERASE: zero image memory.
ERASE:  MOV  #F.ERAS!GO, R0
        BIC  #16, @#IMGCS
        BIS  R0, @#IMGCS
        MOV  #IMGCS, R1
                                ; falls into DWAIT
; DWAIT: wait until the device whose CSR is at R1 is DONE; R0 = its error register,
; the word after the CSR.
DWAIT:
1$:     TSTB (R1)               ; DONE (bit 7)?
        BMI  2$                 ; yes
        WAIT                    ; no: sleep until the next interrupt (next tick at the latest)
        BR   1$
2$:     MOV  2(R1), R0          ; OK (0) or why not; Z set if OK
        RTS  PC

; SLEEP: wait R0 ticks (up to 32767).
SLEEP:  MOV  @#TICKL, R1        ; now...
        ADD  R0, R1             ; ...+ R0 = wake-up time (may wrap past 177777: fine)
1$:     WAIT
        CMP  @#TICKL, R1        ; now - wake-up time...
        BMI  1$                 ; ...still negative: not yet (BMI, not BLT: wraps right)
        CLR  R0
        RTS  PC

; RUN: let the program run for R0 ticks (0 = no limit). Firmware only. Returns R0 = the
; program's state when it came back (P.RDY: time up or preempted; P.DONE, P.FLT, P.HLT);
; PRGCS says why.
RUN:    MOV  R0, @#SLICE
        MOV  #GO, @#PRGCS       ; the gate: the program runs from here...
        MOV  @#PRGST, R0        ; ...and the firmware continues here when it comes back
        RTS  PC

; LOG: a T.LOG message on the real-time stream: tag R0 (one byte), value R1 (one word,
; low byte first). All or nothing: R0 = OK, or E.FULL if the TX FIFO has no room for it.
LOG:    CMP  @#TXFREE, #7       ; SOH, type, length, tag, low, high, ETX
        BLO  9$
        MOVB #SOH, @#TXBUF
        MOVB #T.LOG, @#TXBUF
        MOVB #3, @#TXBUF        ; body: 3 bytes
        MOVB R0, @#TXBUF        ; tag
        MOVB R1, @#TXBUF        ; value, low byte...
        SWAB R1
        MOVB R1, @#TXBUF        ; ...then the high byte
        MOVB #ETX, @#TXBUF
        CLR  R0
        RTS  PC
9$:     MOV  #E.FULL, R0
        RTS  PC

; PUTMSG: one message on the real-time stream, all or nothing. R0 = its type, R1 = the
; address of its body, R2 = the body's length (0-255; kept). R0 = OK, E.FULL if the TX
; FIFO has no room for all of it (nothing is written), E.INV if R2 > 255.
PUTMSG: CMP  R2, #255.
        BHI  8$
        MOV  R2, -(SP)          ; room needed: the body + 4
        ADD  #4, (SP)
        CMP  @#TXFREE, (SP)+
        BLO  9$
        MOVB #SOH, @#TXBUF
        MOVB R0, @#TXBUF        ; type
        MOVB R2, @#TXBUF        ; length
        MOV  R2, R0
        BEQ  2$
1$:     MOVB (R1)+, @#TXBUF     ; the body
        SOB  R0, 1$
2$:     MOVB #ETX, @#TXBUF
        CLR  R0
        RTS  PC
8$:     MOV  #E.INV, R0
        RTS  PC
9$:     MOV  #E.FULL, R0
        RTS  PC

; SEND: the same message into the recorder instead (store and forward: it reaches ground
; even through a bad link). R0 = type, R1 = body, R2 = length (kept). Waits until the
; recorder has room. R0 = OK, or E.INV if R2 > 255.
SEND:   CMP  R2, #255.
        BHI  8$
        MOV  R2, -(SP)          ; room needed: the body + 4
        ADD  #4, (SP)
1$:     CMP  @#RECFRE, (SP)
        BHIS 2$
        WAIT                    ; the downlink empties the recorder meanwhile
        BR   1$
2$:     TST  (SP)+
        MOVB #SOH, @#RECBUF
        MOVB R0, @#RECBUF
        MOVB R2, @#RECBUF
        MOV  R2, R0
        BEQ  4$
3$:     MOVB (R1)+, @#RECBUF
        SOB  R0, 3$
4$:     MOVB #ETX, @#RECBUF
        CLR  R0
        RTS  PC
8$:     MOV  #E.INV, R0
        RTS  PC

; SNDIMG: send the photo in image memory home through the recorder, as T.IMG messages of
; CHUNK bytes; each body is: type, chunk number, chunks, the bytes. Ground puts them back
; together. R0 = photo type 1-5 (0 = the mode of the last photo, IMGTYP). Waits for room
; in the recorder. R0 = OK, or E.INV (no such type, or bigger than this camera's memory).
SNDIMG: TST  R0
        BNE  1$
        MOV  @#IMGTYP, R0       ; 0: the last photo's mode
1$:     DEC  R0                 ; types 1-5 -> 0-4
        CMP  R0, #4
        BHI  9$                 ; unsigned: 0 - 1 is 177777, too big as well
        MOV  R2, -(SP)
        MOV  R3, -(SP)
        MOV  R4, -(SP)
        MOV  R0, R4
        INC  R4                 ; R4 = type
        ASL  R0                 ; a word table
        MOV  NCHUNK(R0), R3     ; R3 = chunks in a photo of this type
        MOV  R3, R1             ; bytes = chunks x 128: SWAB is x 256 (chunks < 256)...
        SWAB R1
        CLC
        ROR  R1                 ; ...and half of it
        CMP  R1, @#IMGSIZ
        BHI  8$                 ; this camera has no memory for it
        MOV  #IMGBAS, R1        ; R1 = the next byte to send
        CLR  R2                 ; R2 = chunk number
2$:     CMP  @#RECFRE, #CHUNK+7 ; room for a whole chunk message?
        BHIS 3$
        WAIT
        BR   2$
3$:     MOVB #SOH, @#RECBUF
        MOVB #T.IMG, @#RECBUF
        MOVB #CHUNK+3, @#RECBUF ; body length
        MOVB R4, @#RECBUF       ; type
        MOVB R2, @#RECBUF       ; chunk number
        MOVB R3, @#RECBUF       ; chunks
        MOV  #CHUNK, R0
4$:     MOVB (R1)+, @#RECBUF    ; the pixels
        SOB  R0, 4$
        MOVB #ETX, @#RECBUF
        INC  R2
        CMP  R2, R3
        BLO  2$                 ; next chunk
        CLR  R0
        BR   7$
8$:     MOV  #E.INV, R0
7$:     MOV  (SP)+, R4
        MOV  (SP)+, R3
        MOV  (SP)+, R2
        TST  R0
        RTS  PC
9$:     MOV  #E.INV, R0
        RTS  PC
NCHUNK: .WORD 8., 8., 16., 32., 32. ; 64x64 2 bpp, dithered, 4 bpp; 128x128; 64x64 8 bpp

; ---------------------------------------------------------------- helpers

; MUL16: R0 = R0 x R1 (low 16 bits; the same for signed and unsigned). Shift and add.
MUL16:  MOV  R2, -(SP)          ; save R2
        CLR  R2                 ; R2 = running sum
1$:     TST  R1                 ; multiplier used up?
        BEQ  3$
        CLC                     ; shift R1 right, with a 0 coming in at the top
        ROR  R1                 ;   ...its lowest bit lands in the carry flag
        BCC  2$                 ; bit was 0: nothing to add
        ADD  R0, R2             ; bit was 1: add the shifted multiplicand
2$:     ASL  R0                 ; multiplicand x 2
        BR   1$
3$:     MOV  R2, R0             ; result in R0
        MOV  (SP)+, R2          ; restore R2
        TST  R0
        RTS  PC

; DIV16: R0 = R0 / R1, R1 = remainder (unsigned). C = 1 if R1 was 0 (R0, R1 unchanged).
DIV16:  TST  R1
        BNE  1$
        SEC                     ; divide by zero: report it in the carry flag
        RTS  PC
1$:     MOV  R2, -(SP)
        MOV  R3, -(SP)
        MOV  R1, R2             ; R2 = divisor
        CLR  R1                 ; R1 = remainder, built up bit by bit
        MOV  #16., R3           ; 16 quotient bits
2$:     ASL  R0                 ; next dividend bit out of R0...
        ROL  R1                 ;   ...into the remainder
        BCS  4$                 ; a 17th bit: certainly >= divisor
        CMP  R1, R2             ; remainder >= divisor? (unsigned)
        BLO  3$
4$:     SUB  R2, R1             ; yes: subtract...
        INC  R0                 ;   ...and the quotient bit is 1
3$:     SOB  R3, 2$             ; 16 times
        MOV  (SP)+, R3
        MOV  (SP)+, R2
        CLC
        RTS  PC

; ABS: R0 = |R0| (100000 stays 100000: it has no positive twin).
ABS:    TST  R0
        BPL  1$
        NEG  R0
1$:     RTS  PC

; DIRTO: the direction that takes you closer along the larger of |dx| = |R0| (east +)
; and |dy| = |R1| (north +): R0 = NORTH ... WEST, or -1 (N set) if both are 0.
DIRTO:  MOV  R2, -(SP)
        MOV  R0, R2             ; R2 = |dx|
        BPL  1$
        NEG  R2
1$:     MOV  R1, -(SP)          ; |dy| on the stack
        BPL  2$
        NEG  (SP)
2$:     CMP  R2, (SP)+          ; |dx| >= |dy|?
        BLT  5$                 ; no: go north or south
        TST  R0
        BEQ  6$                 ; |dx| >= |dy| and dx = 0: both 0, arrived
        BMI  3$
        MOV  #EAST, R0
        BR   7$
3$:     MOV  #WEST, R0
        BR   7$
5$:     MOV  #NORTH, R0
        TST  R1
        BPL  7$
        MOV  #SOUTH, R0
        BR   7$
6$:     MOV  #-1, R0
7$:     MOV  (SP)+, R2
        TST  R0
        RTS  PC

; PLOT: set pixel (x = R0, y = R1) of a 64x64 2-bpp photo (modes 1 and 2) to grey R2
; (0 black ... 3 white; R2 is kept). A row is 16 bytes, four pixels a byte, the leftmost
; in the top bits. R0 = OK, or E.INV (nothing drawn) if x or y is outside 0-63.
PLOT:   CMP  R0, #63.
        BHI  9$                 ; unsigned: negative numbers are too big as well
        CMP  R1, #63.
        BHI  9$
        MOV  R3, -(SP)
        MOV  R4, -(SP)
        ASL  R1                 ; y x 16: the row's first byte
        ASL  R1
        ASL  R1
        ASL  R1
        MOV  R0, R3
        ASR  R3                 ; x / 4: the byte in the row
        ASR  R3
        ADD  R3, R1
        ADD  #IMGBAS, R1        ; R1 = the byte's address
        BIC  #177774, R0        ; x MOD 4: which pixel of the byte
        MOV  #3, R3
        SUB  R0, R3
        ASL  R3                 ; R3 = (3 - x MOD 4) x 2: how far to shift
        MOV  #3, R0             ; R0 = mask, R4 = grey, both still in the low bits
        MOV  R2, R4
        BIC  #177774, R4
        TST  R3
        BEQ  2$
1$:     ASL  R0                 ; move both into place
        ASL  R4
        DEC  R3
        BNE  1$
2$:     BICB R0, (R1)           ; clear the pixel...
        BISB R4, (R1)           ; ...and set its new grey
        MOV  (SP)+, R4
        MOV  (SP)+, R3
        CLR  R0
        RTS  PC
9$:     MOV  #E.INV, R0
        RTS  PC
`;

/** The routines a program may call (`JSR PC, STEP`): predefined, reserved names. */
export const ROM_ROUTINES = ['STEP', 'SCAN', 'SLEEP', 'ACT', 'USE', 'SNAP', 'SEND', 'ERASE', 'RUN', 'LOG', 'PUTMSG', 'SNDIMG', 'MUL16', 'DIV16', 'ABS', 'DIRTO', 'PLOT'] as const;

function build(): AssembleResult {
  const a = assemble(ROM_SOURCE, {
    origin: PDP11.romBase,
    names: 'dec',
    symbols: {
      ...systemSymbols(),
      VECEND: 0o154,
      FAULT: BootReason.FAULT,
      SAFEN: PDP11.safeModeBoots,
      SAFET: PDP11.safeModeTicks,
      CHUNK: IMG_CHUNK,
    },
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
export const ROM_ENTRY = { BOOT: label('BOOT'), TRPDEF: label('TRPDEF'), EXIT: label('EXIT'), UNEXP: label('UNEXP'), SAFEFW: label('SAFEFW') } as const;
/** The routines' addresses: predefined symbols of every program. */
export const ROM_EXPORTS: Record<string, number> = Object.fromEntries(ROM_ROUTINES.map((n) => [n, label(n)]));
