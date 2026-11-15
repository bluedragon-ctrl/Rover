/**
 * M15 shipped code for the PDP-11 core (docs/PDP11_CPU.md §15, slice 4): the default
 * firmware and every lesson, rewritten in MACRO-11. The Rover-ASM versions in programs.ts
 * stay for the current game until the switch-over (slice 6). Tests assemble and run each.
 *
 * Numbers are octal unless they end in a dot (`50.` is fifty). Names have at most six
 * characters. The ROM's routines take R0 and R1 (a third in R2, kept) and answer in R0
 * with the flags set from it; they may change R0 and R1, nothing else.
 */

// ------------------------------------------------------------------ firmware

/** Default firmware: the line clock, the gate (RUN), the watchdog and fault protection. */
export const PDP_DEFAULT_FIRMWARE = `; DEFAULT FIRMWARE: keeps the rover alive and runs your program in
; time slices. Upload programs in the Program slot.
;
; Three jobs run at once:
; * the line clock interrupts every tick, also while the program runs;
;   its handler (CLOCK) keeps the dish on the orbiter, the array on the
;   sun, stows it for a squall and shows the link on lamp 3;
; * the main loop charges the battery and runs the program for
;   SLICE ticks at a time (the ROM's RUN: the gate, PRGCS);
; * fault protection (PREMPT): an announced world event or a battery
;   below LOWBAT takes control back at once, mid-slice.
; The watchdog (WDT) reboots the rover if the main loop hangs.
; Comms: L.BAT battery heartbeat, L.END program state (3 done, 4 fault),
; L.RES its result, L.PRE why a slice was cut short (PR. bits).

LOWBAT = 30.                    ; charge below this battery level...
FULBAT = 90.                    ; ...until this one
SLTIX  = 50.                    ; ticks per program slice
WDTIX  = 1000.                  ; watchdog: no kick for this long = a hang
SLOW   = 8.                     ; the clock's housekeeping every 8 ticks
L.BAT  = 1                      ; log tags
L.PRE  = 12.
L.RES  = 13.
L.END  = 14.

START:  MOV  #CLOCK, @#100      ; line clock vector: handler...
        MOV  #300, @#102        ; ...and its PSW: priority 6
        MOV  #PR.ALR!PR.BAT, @#PREMPT ; fault protection, set once a boot
        MOV  #LOWBAT, @#BATALM
MAIN:   MOV  #WDTIX, @#WDT      ; kick the watchdog (arms it at boot)
        CMP  @#BAT, #LOWBAT
        BLO  CHARGE
        CMP  @#PRGST, #P.RDY
        BNE  IDLE               ; nothing to run
        TST  @#SOLOPN           ; array open (charging, old code)?
        BEQ  1$
        CLR  @#SOLOPN           ; stow it before the program drives
        MOV  #20., R0
        JSR  PC, SLEEP
1$:     CLR  @#LIGHT            ; headlight on at night
        TST  @#SUNEL
        BGT  2$
        MOV  #1, @#LIGHT
2$:     MOV  #GREEN, @#IND1     ; lamp 1 green: the program runs
        MOV  #SLTIX, R0
        JSR  PC, RUN            ; the gate; R0 = PRGST when it comes back
        CMP  R0, #P.RDY
        BNE  3$
        TST  @#PRMPTD           ; time up, or cut short?
        BEQ  MAIN
        CLR  @#DRVCNT           ; cut short: stop the wheels at the end of the tile
        MOV  #L.PRE, R0
        MOV  @#PRMPTD, R1
        JSR  PC, LOG
        BR   MAIN
3$:     CMP  R0, #P.HLT
        BEQ  IDLE               ; BPT: it waits for Continue
        MOV  #BLUE, @#IND1      ; lamp 1 blue: done, red: fault
        CMP  R0, #P.DONE
        BEQ  4$
        MOV  #RED, @#IND1
4$:     MOV  @#PRGRES, @#DISP   ; the cabin display shows the result
        MOV  #L.END, R0
        MOV  @#PRGST, R1
        JSR  PC, LOG
        MOV  #L.RES, R0
        MOV  @#PRGRES, R1
        JSR  PC, LOG
        CLR  @#PRGST            ; P.NONE: acknowledged; "Run again" restarts it
IDLE:   CLR  @#LIGHT
        CMP  @#SIGNAL, #20.
        BLO  5$
        MOV  #L.BAT, R0         ; heartbeat while idle
        MOV  @#BAT, R1
        JSR  PC, LOG
5$:     MOV  #20., R0
        JSR  PC, SLEEP
        BR   MAIN

CHARGE: CLR  @#LIGHT
        MOV  #AMBER, @#IND2     ; lamp 2 amber: charging
6$:     MOV  #WDTIX, @#WDT      ; charging can take a whole night: keep kicking
        CMP  @#ALERT, #A.SQL
        BEQ  7$                 ; squall: the clock keeps the array stowed
        MOV  #1, @#SOLOPN
7$:     MOV  #20., R0
        JSR  PC, SLEEP
        CMP  @#BAT, #FULBAT
        BLO  6$
        CLR  @#IND2
        BR   MAIN

; CLOCK: the line clock's handler, every tick. It may run in the middle of
; the program, on the program's registers: it uses none. Most ticks it only
; counts down (about 12 cycles with the interrupt and RTI).
CLOCK:  DEC  CNT
        BNE  9$
        MOV  #SLOW, CNT
        MOV  @#ORBAZ, @#ANTANG  ; dish on the orbiter
        MOV  @#SUNAZ, @#SOLANG  ; array on the sun
        CMP  @#ALERT, #A.SQL
        BNE  8$
        CLR  @#SOLOPN           ; squall warning: stow the array
8$:     CLR  @#IND3             ; lamp 3 blue while the link is up
        CMP  @#SIGNAL, #20.
        BLO  9$
        MOV  #BLUE, @#IND3
9$:     RTI
CNT:    .WORD 1
`;

/** Firmware lesson: the gate and nothing else. */
export const PDP_MINIMAL_FIRMWARE = `; MINIMAL FIRMWARE: the smallest firmware that runs a program. No
; charging, no dish, no watchdog: the rover runs flat if you keep it.
;
; Learn: the gate. Writing GO to PRGCS hands the CPU to the program; the
; firmware continues after that instruction when the program comes back
; (done, fault, BPT, or its SLICE used up). PRGST says how it ended.
; Try: count the runs in a register and show it on the display (DISP).

START:  CLR  @#SLICE            ; 0: no time limit
1$:     MOV  #GO, @#PRGCS       ; the gate: refused (PRGCS bit 15) if not P.RDY
        WAIT                    ; sleep until the next tick
        BR   1$
`;

/** All-in-one firmware: Explorer without a program, charging by itself. */
export const PDP_ALLIN_EXPLORER = `; EXPLORER (all-in-one firmware): wander, turn right at obstacles,
; deploy the solar array to recharge when the battery runs low.
;
; Learn: what a firmware must do by itself when it runs no program:
; charging (SOLOPN, SOLANG), the dish, the squall warning, the headlight,
; and that the array stays open across a reboot.
; Try: compare it with "Default firmware" + the program "Explorer".

LOWBAT = 30.
FULBAT = 90.

START:  CLR  @#SOLOPN           ; the array survives reboots: stow it first
        MOV  #20., R0           ; stowing takes 20 ticks
        JSR  PC, SLEEP
        CLR  R2                 ; R2 = direction
LOOP:   CMP  @#BAT, #LOWBAT
        BLO  CHARGE
        CLR  @#LIGHT
        TST  @#SUNEL
        BGT  LOOK
        MOV  #1, @#LIGHT        ; night: headlight
LOOK:   MOV  R2, R0
        JSR  PC, SCAN
        MOV  @#RADHIT, R3
        BEQ  AHEAD              ; NONE: nothing ahead
        CMP  @#RADDST, #1
        BGT  AHEAD              ; something, but not adjacent
        CMP  R3, #SAMPLE        ; items are driven over, not around
        BEQ  AHEAD
        CMP  R3, #KIT
        BEQ  AHEAD
TURN:   INC  R2                 ; turn right
        BIC  #177774, R2        ; MOD 4
        BR   LOOP
AHEAD:  CLR  @#IND2
        MOV  #GREEN, @#IND1
        MOV  R2, R0
        MOV  #1, R1
        JSR  PC, STEP
        BEQ  LOOP
        BR   TURN

CHARGE: CLR  @#LIGHT
        CLR  @#IND1
        MOV  #AMBER, @#IND2
1$:     MOV  #1, @#SOLOPN
        CMP  @#ALERT, #A.SQL
        BNE  2$
        CLR  @#SOLOPN           ; squall warning: keep the array stowed
2$:     MOV  @#SUNAZ, @#SOLANG
        MOV  @#ORBAZ, @#ANTANG
        MOV  #20., R0
        JSR  PC, SLEEP
        CMP  @#BAT, #FULBAT
        BLO  1$
        BR   START              ; stow and go
`;

/** All-in-one firmware: Prospector, charging by itself. */
export const PDP_ALLIN_PROSPECTOR = `; PROSPECTOR (all-in-one firmware): wander; mine ore and grab samples
; next to the rover and analyze them. The spectra wait in the recorder
; until the downlink has sent them: keep the dish on the orbiter.
;
; Learn: a firmware that charges and works without a program. It does not
; stow the array for squalls: a gap the default firmware closes.
; Try: add the squall check (see "All-in-one Explorer").

START:  CLR  @#SOLOPN
        MOV  #20., R0
        JSR  PC, SLEEP
        CLR  R2                 ; direction
LOOP:   CMP  @#BAT, #30.
        BLO  CHARGE
        MOV  @#ORBAZ, @#ANTANG  ; spectra go home by themselves
        MOV  R2, R0
        JSR  PC, SCAN
        CMP  @#RADDST, #1
        BGT  AHEAD              ; not adjacent yet
        MOV  @#RADHIT, R3
        BEQ  AHEAD
        CMP  R3, #IRON
        BEQ  MINE
        CMP  R3, #SILIC
        BEQ  MINE
        CMP  R3, #SAMPLE
        BEQ  GRAB
TURN:   INC  R2
        BIC  #177774, R2
        BR   LOOP
MINE:   MOV  #F.T0, R1          ; drill
        BR   USEIT
GRAB:   MOV  #F.T1, R1          ; grabber
USEIT:  MOV  R2, R0
        JSR  PC, ACT
        CLR  R3                 ; analyze every slot (E.INV if empty)
1$:     MOV  R3, R0
        MOV  #F.T2, R1          ; spectrometer
        JSR  PC, ACT
        INC  R3
        CMP  R3, #4
        BLT  1$
        BR   LOOP
AHEAD:  MOV  R2, R0
        MOV  #1, R1
        JSR  PC, STEP
        BEQ  LOOP
        BR   TURN
CHARGE: MOV  #1, @#SOLOPN
2$:     MOV  @#SUNAZ, @#SOLANG
        MOV  #20., R0
        JSR  PC, SLEEP
        CMP  @#BAT, #90.
        BLO  2$
        BR   START
`;

/** All-in-one firmware: fetch supply crates forever. */
export const PDP_ALLIN_FETCH = `; FETCH (all-in-one firmware): drive to the nearest supply crate and
; grab it, which installs the upgrade. Greedy: no obstacle avoidance.
;
; Learn: a firmware that never ends: with no crate it sleeps and checks
; again. It does not charge: watch BAT on long trips.
; Try: the program "Fetch supply crate" for the version with results.

START:  CLR  @#SOLOPN
        MOV  #20., R0
        JSR  PC, SLEEP
LOOP:   TST  @#DROPS
        BEQ  IDLE
        MOV  #GREEN, @#IND1     ; lamp 1 green: on the way
        MOV  @#DROPX, R0        ; dx = DROPX - X
        SUB  @#X, R0
        MOV  @#DROPY, R1        ; dy = DROPY - Y - 1: aim south of the crate
        SUB  @#Y, R1
        DEC  R1
        JSR  PC, DIRTO          ; R0 = the way to go, -1 = there
        BMI  THERE
        MOV  #1, R1
        JSR  PC, STEP
        BR   LOOP
THERE:  MOV  #NORTH, R0
        MOV  #F.T1, R1
        JSR  PC, ACT            ; adjacent: grab = install
        BR   LOOP
IDLE:   MOV  #BLUE, @#IND1      ; lamp 1 blue: no crate to fetch
        MOV  #50., R0
        JSR  PC, SLEEP
        BR   LOOP
`;

// ------------------------------------------------------------------ programs

export const PDP_FIRST_STEPS = `; FIRST STEPS: drive a 3x3 square, then end.
;
; Learn: registers, MOV and # (a number), calling the ROM (JSR PC, STEP),
; checking a result with BNE, a loop, HALT with a result in R0.
;
; The CPU has eight registers, R0-R7; R6 is the stack pointer (SP), R7
; the program counter (PC). JSR PC, STEP runs the ROM's drive routine
; (Reference -> ROM): it takes the direction in R0 and the tiles in R1
; and answers in R0: OK (0), or why not (E.BLK, E.HAZ...). The answer
; also sets the flags, so BNE ("branch if not equal to zero") catches
; every error. HALT ends the program; the firmware sends R0 home
; (Comms: L.END = 3, L.RES = 1) and shows it on the cabin display.
; Numbers are octal: 3 is three, 10 is eight; 10. is ten.
; Try: a bigger square; HALT with the number of sides driven.

START:  CLR  R2                 ; R2 = direction: 0 NORTH, 1 EAST, 2 SOUTH, 3 WEST
SIDE:   MOV  R2, R0             ; STEP takes the direction in R0...
        MOV  #3, R1             ; ...and the tiles in R1
        JSR  PC, STEP           ; R0 = OK or why not
        BNE  STUCK              ; blocked, hazard, low power...
        INC  R2                 ; turn right: NORTH -> EAST -> ...
        CMP  R2, #4
        BLT  SIDE               ; fewer than 4 sides: the next one
        MOV  #1, R0             ; result 1: square done
        HALT
STUCK:  CLR  R0                 ; result 0: something was in the way
        HALT
`;

export const PDP_DRIVE_YOURSELF = `; DRIVE YOURSELF: the same 3x3 square as First steps, but talking to
; the drive's registers instead of calling the ROM.
;
; Learn: devices are memory (the I/O page), the CSR's GO / DONE / ERR
; bits, WAIT, and what STEP really does.
;
; The CPU cannot drive: it writes numbers to the drive's registers and
; the drive does the work. DRVCNT says how far, DRVDIR which way, and
; GO in DRVCS starts it. DONE (bit 7) says the drive is idle; ERR (bit
; 15) says it was refused or failed, and DRVER says why. Bits 7 and 15
; are sign bits, so TSTB and TST test them without a mask. WAIT sleeps
; until the next interrupt: the line clock wakes it every tick.
; Reference -> ROM shows STEP: the same instructions.
; Try: CLR @#DRVCNT right after the start: the drive stops at the end of
; its first tile and DRVER reads E.PRE.

DIR = %2                        ; a name for R2

START:  CLR  DIR                ; NORTH
1$:     MOV  #3, @#DRVCNT       ; how far
        MOV  DIR, @#DRVDIR      ; which way
        MOV  #GO, @#DRVCS       ; start
2$:     TSTB @#DRVCS            ; DONE (bit 7)?
        BMI  3$
        WAIT                    ; no: sleep until the next tick
        BR   2$
3$:     TST  @#DRVCS            ; ERR (bit 15)?
        BMI  STUCK              ; why: DRVER
        INC  DIR
        CMP  DIR, #4
        BLT  1$
        MOV  #1, R0             ; result 1: square done
        RTS  PC                 ; "return from main" ends the program
STUCK:  MOV  @#DRVER, R0        ; result: why it stopped
        RTS  PC
`;

export const PDP_COUNT = `; COUNT WITH A VARIABLE: drive a 2x2 square one tile at a time and
; count the tiles in memory. HALT with how often the program has run:
; press "Run again" (Comms) and both counts keep growing.
;
; Learn: variables in memory (.WORD), INC on memory, which registers the
; ROM may change.
;
; The registers are the CPU's working space, but memory is bigger.
; .WORD 0 reserves a word in the program and the label names its
; address. Unlike Rover-ASM, the PDP-11 adds to memory directly: INC
; TILES reads the word, adds 1 and writes it back in one instruction.
; Run again restarts the program without reloading it, so the words keep
; their values; a reboot loads the program again and they start at 0.
; The ROM's routines may change R0 and R1, so this program keeps its own
; numbers in R2 and R3.
; Try: count in a register instead of RUNS: it starts from 0 every run.

LEG = 2                         ; tiles per side
L.TIL = 2                       ; log tag: tiles driven in all runs

START:  INC  RUNS               ; one more run
        CLR  R2                 ; direction
SIDE:   CLR  R3                 ; tiles on this side
TILE:   MOV  R2, R0
        MOV  #1, R1
        JSR  PC, STEP           ; one tile at a time, to count them
        BNE  STUCK
        INC  TILES
        INC  R3
        CMP  R3, #LEG
        BLT  TILE
        INC  R2                 ; corner: turn right
        CMP  R2, #4
        BLT  SIDE
STUCK:  MOV  #L.TIL, R0
        MOV  TILES, R1
        JSR  PC, LOG
        MOV  RUNS, R0           ; result: runs so far
        HALT

RUNS:   .WORD 0                 ; how often the program ran
TILES:  .WORD 0                 ; tiles driven, all runs together
`;

export const PDP_ROUTE = `; ROUTE: drive a route stored in the program, then report how many
; legs worked.
;
; Learn: data in the program (.BYTE), a pointer register, autoincrement
; (R3)+, MOVB.
;
; Code and data share memory: ROUTE is the address of the first byte of
; the table. MOVB (R3)+, R0 reads the byte R3 points at and moves R3 on
; to the next one: C's *p++. The table is pairs (direction, tiles) and
; ends with 377, which MOVB sign-extends to -1, so BMI finds the end.
; Put data where the program never runs into it: after its HALT.
; Try: add legs; LOG the number of a leg that failed; drive it backwards.

L.LEGS = 2                      ; log tag

START:  CLR  GOOD
        MOV  #ROUTE, R3         ; R3 points at the next entry
NEXT:   MOVB (R3)+, R0          ; direction
        BMI  FIN               ; 377: the end of the route
        MOVB (R3)+, R1          ; tiles
        JSR  PC, STEP
        BNE  NEXT               ; blocked: try the next leg
        INC  GOOD
        BR   NEXT
FIN:    MOV  #L.LEGS, R0
        MOV  GOOD, R1
        JSR  PC, LOG
        MOV  GOOD, R0
        HALT

GOOD:   .WORD 0                 ; legs driven without a problem
ROUTE:  .BYTE EAST, 3, NORTH, 2, WEST, 3, SOUTH, 2, 377
`;

export const PDP_DRIVE_AND_SCAN = `; DRIVE AND SCAN AT ONCE: drive 10 tiles east and count the samples
; lying north of the way, sweeping the radar while the wheels turn.
; Returns the number of samples seen.
;
; Learn: two devices working at the same time, polling DONE, edge
; detection, RTS PC at the top level as the end of a program.
;
; STEP waits until the drive is done: nothing else happens on the way.
; Started by hand, the drive goes on by itself and the CPU is free. The
; drive, tools, repair and camera share the chassis and work one at a
; time (E.BUSY), but the radar may sweep while driving. A sample stays in
; sight for several sweeps, so the program counts only the moment it
; appears: the sweep before saw something else.
; Try: also look SOUTH; stop at the first sample (CLR @#DRVCNT).

L.SMP = 2                       ; log tag: how far north a new sample lies

START:  CLR  R2                 ; samples seen
        CLR  R3                 ; what the sweep before found
        MOV  #10., @#DRVCNT
        MOV  #EAST, @#DRVDIR
        MOV  #GO, @#DRVCS       ; start the drive; don't wait for it
        TST  @#DRVCS            ; refused (array open, wall ahead...)?
        BMI  FIN
LOOK:   MOV  #NORTH, R0
        JSR  PC, SCAN           ; one sweep: a tick; the wheels go on
        CMP  @#RADHIT, #SAMPLE
        BNE  MORE
        CMP  R3, #SAMPLE
        BEQ  MORE               ; still the same sample
        INC  R2                 ; a new one
        MOV  #L.SMP, R0
        MOV  @#RADDST, R1
        JSR  PC, LOG
MORE:   MOV  @#RADHIT, R3
        TSTB @#DRVCS            ; drive DONE?
        BPL  LOOK               ; still driving: sweep again
FIN:    MOV  R2, R0
        RTS  PC                 ; result: samples seen
`;

export const PDP_EXPLORER = `; EXPLORER: wander, turn right at obstacles, report acid vents.
;
; Learn: the radar (SCAN, RADHIT, RADDST), tile names, BIC as MOD 4,
; telling errors apart, LOG for mission control.
;
; SCAN sweeps the radar one tick in a direction: the first thing there
; waits in RADHIT (NONE = 0 if nothing in range) and its distance in
; RADDST; the radar works day and night. Items (samples, kits) are
; driven over, not around. BIC #177774 clears every bit but the lowest
; two: the number MOD 4. Driving onto a VENT costs hull and ends the
; drive with E.HAZ; the program then logs where (Comms: tags 2 and 3).
; It never ends: between slices the firmware charges, then it goes on.
; Try: turn left instead; pick the turn from TICKL's lowest bit.

L.VX = 2                        ; log tags: where the vent is
L.VY = 3

START:  CLR  R2                 ; R2 = heading 0-3
LOOP:   MOV  R2, R0
        JSR  PC, SCAN
        MOV  @#RADHIT, R3       ; MOV sets the flags too:
        BEQ  AHEAD              ;   NONE: nothing ahead
        CMP  @#RADDST, #1
        BGT  AHEAD              ; something ahead, but not adjacent
        CMP  R3, #SAMPLE        ; items are driven over
        BEQ  AHEAD
        CMP  R3, #KIT
        BEQ  AHEAD
TURN:   INC  R2                 ; turn right...
        BIC  #177774, R2        ; ...MOD 4
        BR   LOOP
AHEAD:  MOV  R2, R0
        MOV  #1, R1
        JSR  PC, STEP
        BEQ  LOOP
        CMP  R0, #E.HAZ
        BNE  TURN               ; blocked: something moved in
        MOV  #L.VX, R0          ; on an acid vent: tell mission control
        MOV  @#X, R1
        JSR  PC, LOG
        MOV  #L.VY, R0
        MOV  @#Y, R1
        JSR  PC, LOG
        BR   TURN               ; and leave it
`;

export const PDP_PHOTOGRAPHER = `; PHOTOGRAPHER: photograph all four directions, send the photos
; home, HALT with how many were sent.
;
; Learn: SNAP and SNDIMG, aiming the headlight with HDG, the recorder.
;
; SNAP takes a photo in direction R0 with the mode in R1 (F.M1: 64x64
; grey): 10 ticks, then it is in image memory at IMGBAS (1 KB). SNDIMG
; sends it home through the recorder as eight messages of 128 bytes;
; it waits when the recorder is full, while the downlink empties it (the
; firmware keeps the dish on the orbiter). Only a lit photo earns
; credits: daylight, or the headlight shining at the subject. The
; headlight shines along HDG, so face what you photograph. Photos appear
; in the Gallery; the first of each kind of subject earns a bonus.
; Try: only photograph a CLIFF or a SAMPLE the radar sees within 2 tiles.

START:  CLR  R2                 ; direction
        CLR  R3                 ; photos sent
SHOT:   MOV  R2, @#HDG          ; turn in place to face it
        MOV  R2, R0
        MOV  #F.M1, R1
        JSR  PC, SNAP           ; into image memory
        BNE  NEXT               ; E.LOWP...: skip this one
        MOV  #1, R0             ; type 1: a 64x64 grey photo
        JSR  PC, SNDIMG         ; image memory -> recorder -> home
        BNE  NEXT
        INC  R3
NEXT:   INC  R2
        CMP  R2, #4
        BLT  SHOT
        MOV  R3, R0             ; result: photos sent (0-4)
        HALT
`;

export const PDP_PROSPECTOR = `; PROSPECTOR: wander; mine ore veins and pick up samples next to the
; rover, analyze them and send the spectra home.
;
; Learn: tools (ACT), cargo bytes (CARGO, index mode), a subroutine of
; your own (JSR PC / RTS PC) that keeps the caller's registers.
;
; ACT uses a tool: R0 = its argument (a direction, or a cargo slot),
; R1 = the hardpoint. Mk-I: F.T0 drill (mines an adjacent ore vein into
; cargo), F.T1 grabber (picks up an adjacent item), F.T2 spectrometer
; (analyzes the item in a cargo slot and frees it). Spectra wait in the
; recorder until the downlink sends them: a sample earns 3 credits, ore 1.
; TSTB CARGO(R3) reads the byte at CARGO + R3: the item in slot R3, 0 if
; empty. JSR PC, LAB pushes the return address on the stack; RTS PC pops
; it. LAB saves R3 on the stack first and restores it: the usual rule.
; Try: keep IRON in cargo for repairs (see Field repair).

START:  CLR  R2                 ; direction
LOOP:   MOV  R2, R0
        JSR  PC, SCAN
        CMP  @#RADDST, #1
        BGT  AHEAD              ; target not adjacent yet
        MOV  @#RADHIT, R3
        BEQ  AHEAD              ; nothing
        CMP  R3, #IRON
        BEQ  MINE
        CMP  R3, #SILIC
        BEQ  MINE
        CMP  R3, #SAMPLE
        BEQ  GRAB
TURN:   INC  R2
        BIC  #177774, R2
        BR   LOOP
MINE:   MOV  #F.T0, R1          ; drill: 8 ticks, ore into cargo
        BR   TOOL
GRAB:   MOV  #F.T1, R1          ; grabber: 2 ticks, item into cargo
TOOL:   MOV  R2, R0
        JSR  PC, ACT
        JSR  PC, LAB
        BR   LOOP
AHEAD:  MOV  R2, R0
        MOV  #1, R1
        JSR  PC, STEP
        BEQ  LOOP
        BR   TURN

; LAB: analyze everything in cargo. Changes R0 and R1 only.
LAB:    MOV  R3, -(SP)          ; save R3
        CLR  R3                 ; slot
1$:     TSTB CARGO(R3)          ; item in the slot? 0 = empty
        BEQ  2$
        MOV  R3, R0
        MOV  #F.T2, R1          ; spectrometer: a spectrum into the recorder
        JSR  PC, ACT
2$:     INC  R3
        CMP  R3, #4             ; Mk-I has 4 cargo slots (0-3)
        BLT  1$
        MOV  (SP)+, R3          ; restore R3
        RTS  PC
`;

export const PDP_FIELD_REPAIR = `; FIELD REPAIR: repair worn systems with what is in cargo, HALT with
; the number of repairs.
;
; Learn: USE, tables of addresses, index deferred mode @TABLE(R2),
; nested loops.
;
; USE repairs a system with the item in cargo slot R0; R1 = the system:
; F.HULL, F.SOL or F.ANT. A repair takes 10 ticks and uses the item up;
; an item that cannot repair that system fails with E.INV, so the
; program simply tries every slot. HEALTH is a table of register
; addresses: @HEALTH(R2) reads the address at HEALTH + R2, then the
; register there, so one instruction checks any system. R2 counts in
; words (0, 2, 4). Get materials with the grabber or the drill first
; (Prospector). Goal "Field engineer": one repair.
; Try: repair the dish first; keep one KIT for emergencies.

WORN = 80.                      ; repair systems below this health

START:  CLR  R4                 ; repairs made
        CLR  R2                 ; system x 2: a word index
CHECK:  CMP  @HEALTH(R2), #WORN ; this system's health
        BHIS NEXTS              ; healthy enough
        CLR  R3                 ; cargo slot
TRY:    TSTB CARGO(R3)
        BEQ  NEXTSL             ; empty slot
        MOV  R3, R0
        MOV  FUNS(R2), R1
        JSR  PC, USE
        BNE  NEXTSL             ; this item cannot repair it
        INC  R4
        BR   CHECK              ; still worn? try again
NEXTSL: INC  R3
        CMP  R3, #4
        BLT  TRY
NEXTS:  ADD  #2, R2             ; the next system
        CMP  R2, #6
        BLT  CHECK
        MOV  R4, R0
        HALT

HEALTH: .WORD HULL, SOLHLT, ANTHLT ; the health registers' addresses
FUNS:   .WORD F.HULL, F.SOL, F.ANT ; and the matching repair functions
`;

export const PDP_FETCH = `; FETCH: drive to the nearest supply crate and pick it up, which
; installs the upgrade. HALT 1 = installed, 0 = no crate, 2 = stuck.
;
; Learn: positions (X, Y, DROPX, DROPY), SUB for differences, the ROM
; helper DIRTO, the sign flag after a call.
;
; Buy an upgrade in the Upgrades tab: its crate lands 3-6 tiles away
; after 80 ticks (DROPS counts the landed crates). The rover heads for
; the tile just south of the crate, then grabs NORTH. DIRTO takes the
; distance east in R0 and north in R1 and answers the direction to go,
; or -1 (N flag set) when both are 0. It drives straight at the crate:
; with a rock in the way it HALTs with 2.
; Try: when blocked, step sideways once and go on (see Explorer).

START:
LOOP:   TST  @#DROPS
        BEQ  NOCRAT
        MOV  @#DROPX, R0        ; how far east the crate is
        SUB  @#X, R0
        MOV  @#DROPY, R1        ; how far north...
        SUB  @#Y, R1
        DEC  R1                 ; ...the tile south of it is
        JSR  PC, DIRTO
        BMI  THERE              ; -1: arrived
        MOV  #1, R1
        JSR  PC, STEP
        BEQ  LOOP
        MOV  #2, R0             ; something is in the way
        HALT
THERE:  MOV  #NORTH, R0
        MOV  #F.T1, R1
        JSR  PC, ACT            ; grab = install
        BNE  LOOP
        MOV  #1, R0
        HALT
NOCRAT: CLR  R0
        HALT
`;

export const PDP_SPIRAL = `; SPIRAL: search around the start in a growing square spiral (legs of
; 1, 1, 2, 2, 3, 3... tiles), logging every corner.
;
; Learn: subroutines that call subroutines, the stack, BPT.
;
; JSR PC, TWO pushes the return address on the stack (SP moves down a
; word) and jumps; RTS PC pops it. TWO calls LEG once and then simply
; runs into it: the second leg returns for both. Each corner arrives in
; the Comms tab under tags 2 (X) and 3 (Y). At the end BPT stops the
; program for the debugger; press Continue to end it.
; Try: stop early when the radar sees a SAMPLE; spiral the other way.

LEGS = 6                        ; the longest leg, in tiles

START:  CLR  R2                 ; direction
        MOV  #1, R3             ; leg length
1$:     JSR  PC, TWO            ; two legs of this length...
        INC  R3                 ; ...then one tile longer
        CMP  R3, #LEGS
        BLE  1$
        BPT                     ; look at the registers, then Continue
        MOV  R3, R0
        HALT

; TWO: two legs of R3 tiles, turning right after each. Changes R2.
TWO:    JSR  PC, LEG            ; the first leg, then on into LEG for the second
; LEG: one leg of R3 tiles in direction R2, log the corner, turn right.
LEG:    MOV  R2, R0
        MOV  R3, R1
        JSR  PC, STEP           ; blocked? it just stops early
        MOV  #2, R0
        MOV  @#X, R1
        JSR  PC, LOG
        MOV  #3, R0
        MOV  @#Y, R1
        JSR  PC, LOG
        INC  R2
        BIC  #177774, R2
        RTS  PC
`;

export const PDP_SEISMIC = `; SEISMIC SURVEY: listen for ore in four directions, drive to the
; nearest vein and mine it. Needs the seismic scanner upgrade.
;
; Learn: finding the smallest value in a loop, a tool that answers
; through registers (SEITYP, SEIDST), result codes, unsigned branches.
;
; ACT with F.T3 (4 ticks) hears the nearest ore vein up to 12 tiles away
; in direction R0, even through walls: SEIDST = its distance, 0 = none.
; Without the upgrade the hardpoint is empty: E.NOTL. BLO and BHIS
; compare unsigned numbers; distances are never negative.
; HALT 1 = mined, 0 = no scanner, 2 = no ore in range, 3 = blocked on the
; way (the scanner hears through walls, the rover cannot drive).
; Try: when blocked, scan again from where the rover stopped.

START:  CLR  R2                 ; direction
        MOV  #99., R4           ; nearest distance so far (99. = none)
LISTEN: MOV  R2, R0
        MOV  #F.T3, R1
        JSR  PC, ACT
        CMP  R0, #E.NOTL
        BEQ  NOTOOL
        MOV  @#SEIDST, R0
        BEQ  NEXT               ; nothing that way
        CMP  R0, R4
        BHIS NEXT               ; not nearer than the best so far
        MOV  R0, R4             ; the new nearest
        MOV  R2, R3             ; and its direction
NEXT:   INC  R2
        CMP  R2, #4
        BLT  LISTEN
        CMP  R4, #99.
        BEQ  NOORE
        DEC  R4                 ; stop next to the vein
        BEQ  DRILL              ; already there
        MOV  R3, R0
        MOV  R4, R1
        JSR  PC, STEP
DRILL:  MOV  R3, R0
        MOV  #F.T0, R1
        JSR  PC, ACT            ; ore into cargo
        BNE  BLOCKD
        MOV  #1, R0
        HALT
NOORE:  MOV  #2, R0
        HALT
BLOCKD: MOV  #3, R0
        HALT
NOTOOL: CLR  R0
        HALT
`;

export const PDP_WEATHER = `; WEATHER STATION: stay put and report the weather: the sunlight every
; 100 ticks, plus every warning of a squall or an eclipse. Runs until
; you upload another program.
;
; Learn: SLEEP for timing, the tick counter, DIV16 (the remainder too),
; the alert registers.
;
; SLEEP sleeps R0 ticks on the tick counter TICKL. SUNLIT is 0-100.
; ALERT is A.NONE or the event on its way (A.SQL, A.ECL); ALRETA is the
; ticks until it starts. A sol is 2400 ticks; DIV16 divides R0 by R1 and
; leaves the remainder in R1, so two divisions give the hour 0-23
; (counted from the landing, not from midnight). There is no divide
; instruction: DIV16 is the ROM's shift-and-subtract loop, about 150
; cycles (the EIS upgrade adds a hardware DIV).
; Try: TICKL wraps after 65536 ticks (27 sols): use TICKH as well. Only
; log the light when it changed.

L.HOUR = 2                      ; log tags
L.LGT  = 3
L.ALR  = 4
L.ETA  = 5

START:
LOOP:   MOV  @#TICKL, R0
        MOV  #2400., R1
        JSR  PC, DIV16          ; R1 = ticks into the sol
        MOV  R1, R0
        MOV  #100., R1
        JSR  PC, DIV16          ; R0 = the hour
        MOV  R0, R1
        MOV  #L.HOUR, R0
        JSR  PC, LOG
        MOV  #L.LGT, R0
        MOV  @#SUNLIT, R1
        JSR  PC, LOG
        TST  @#ALERT
        BEQ  CALM               ; A.NONE
        MOV  #L.ALR, R0
        MOV  @#ALERT, R1
        JSR  PC, LOG
        MOV  #L.ETA, R0
        MOV  @#ALRETA, R1
        JSR  PC, LOG
CALM:   MOV  #100., R0
        JSR  PC, SLEEP
        BR   LOOP
`;

// ------------------------------------------------------------------ image lessons (64x64)

export const PDP_IMAGE_LINE = `; LINE: your first picture. Clear image memory to black, draw a white
; line across the middle and send it home as a photo.
;
; Image memory starts at IMGBAS. A 64x64 grey photo has 2 bits a pixel:
; four pixels a byte, 16 bytes a row, 1 KB in all. Byte 0 = 00 00 00 00
; is four black pixels; 377 = 11 11 11 11 four white ones. Row 32 starts
; at byte 32 x 16 = 512, octal 1000.

START:  JSR  PC, ERASE          ; every byte 0
        MOV  #IMGBAS+1000, R1   ; row 32
        MOV  #16., R2           ; one row = 16 bytes = 64 pixels
1$:     MOVB #377, (R1)+
        SOB  R2, 1$
        MOV  #1, R0             ; send it as a 64x64 grey photo
        JSR  PC, SNDIMG
        MOV  #1, R0
        HALT
`;

export const PDP_IMAGE_TEST_PATTERN = `; TEST PATTERN: four grey bars, like a camera test card.
;
; A byte holds four pixels, so 125 (octal: 01 01 01 01) is four
; dark-grey pixels; 0, 125, 252 and 377 are the four greys. The byte's
; place in its row is its number MOD 16 (BIC #177760 keeps the low four
; bits); divided by 4 (two ASRs) it picks the bar. GREYS(R0) reads the
; byte at GREYS + R0: a table lookup.

START:  MOV  #IMGBAS, R1
        CLR  R2                 ; byte number 0-1777
1$:     MOV  R2, R0
        BIC  #177760, R0        ; MOD 16: which byte of its row (0-15)
        ASR  R0                 ; / 4: which bar (0-3)
        ASR  R0
        MOVB GREYS(R0), (R1)+
        INC  R2
        CMP  R2, #2000          ; 1024 bytes
        BLO  1$
        MOV  #1, R0
        JSR  PC, SNDIMG
        MOV  #1, R0
        HALT
GREYS:  .BYTE 0, 125, 252, 377
`;

export const PDP_IMAGE_NEGATIVE = `; NEGATIVE: take a photo, turn it into a negative, send it.
;
; COM flips every bit of a word: in a 2-bit pixel that turns 0 into 3
; and 1 into 2, a negative. A word is two bytes, eight pixels; 1 KB is
; 512 words (octal 1000), so the loop runs 512 times. SNDIMG with R0 = 0
; sends it in the mode of the last photo.

START:  MOV  #NORTH, R0
        MOV  #F.M1, R1
        JSR  PC, SNAP           ; into image memory: nothing is sent yet
        BNE  FAIL               ; E.LOWP, E.BUSY...
        MOV  #IMGBAS, R1
        MOV  #1000, R2          ; 512 words
1$:     COM  (R1)+              ; read, flip, write back
        SOB  R2, 1$
        CLR  R0                 ; the same format as the SNAP
        JSR  PC, SNDIMG
        MOV  #1, R0
        HALT
FAIL:   CLR  R0
        HALT
`;

export const PDP_IMAGE_STAMP = `; STAMP: take a photo and write where it was taken into its first four
; bytes, like the engineering header real spacecraft send with images.
; In the Gallery, open the photo's hex view: the first bytes are yours.
;
; A MOV copies a whole word, from one address to another: no register
; needed. Words are little-endian: the low byte first.

START:  MOV  #NORTH, R0
        MOV  #F.M1, R1
        JSR  PC, SNAP
        BNE  FAIL
        MOV  @#X, @#IMGBAS      ; bytes 0-1: X
        MOV  @#Y, @#IMGBAS+2    ; bytes 2-3: Y
        CLR  R0
        JSR  PC, SNDIMG
        MOV  #1, R0
        HALT
FAIL:   CLR  R0
        HALT
`;

export const PDP_IMAGE_PLOT = `; PLOT: draw single pixels. Takes a photo and draws a white diagonal
; from the top-left corner to the bottom-right one with the ROM's PLOT
; (64x64 2-bpp pictures: modes 1 and 2).
;
; PLOT takes x in R0, y in R1 and the grey in R2, which it keeps; it may
; change R0 and R1, so the loop counts in R3. Reference -> ROM shows how
; it finds the byte (y x 16 + x / 4) and the two bits in it.

START:  MOV  #NORTH, R0
        MOV  #F.M1, R1
        JSR  PC, SNAP
        BNE  FAIL
        MOV  #3, R2             ; white
        CLR  R3
1$:     MOV  R3, R0             ; pixel (R3, R3)
        MOV  R3, R1
        JSR  PC, PLOT
        INC  R3
        CMP  R3, #64.
        BLO  1$
        CLR  R0
        JSR  PC, SNDIMG
        MOV  #1, R0
        HALT
FAIL:   CLR  R0
        HALT
`;

export const PDP_IMAGE_MEMORY_MAP = `; MEMORY MAP: Explorer that remembers where it has been. Image memory
; is used as a big scratch RAM: one byte per tile counts the visits, a
; 32x32 map that repeats every 32 tiles. Back on a known tile, the rover
; turns by the number of earlier visits, so it leaves a loop differently
; every time instead of circling forever.
; Do not take photos in this program: one would overwrite the map.
;
; BIC #177740 keeps the low five bits: MOD 32, also for negative X and Y.
; Five ASLs multiply by 32. MOVB sign-extends, so BIC #177400 clears the
; high byte; INCB adds one to the byte in memory.

START:  JSR  PC, ERASE          ; forget the old map: image memory keeps
                                ; its contents through reboots
        CLR  R2                 ; direction
LOOP:   MOV  R2, R0
        JSR  PC, SCAN
        TST  @#RADHIT
        BEQ  AHEAD
        CMP  @#RADDST, #1
        BGT  AHEAD
TURN:   INC  R2
        BIC  #177774, R2
        BR   LOOP
AHEAD:  MOV  R2, R0
        MOV  #1, R1
        JSR  PC, STEP
        BNE  TURN
        MOV  @#Y, R3
        BIC  #177740, R3        ; map row 0-31
        ASL  R3                 ; x 32
        ASL  R3
        ASL  R3
        ASL  R3
        ASL  R3
        MOV  @#X, R0
        BIC  #177740, R0        ; map column 0-31
        ADD  R0, R3             ; byte 0-1777
        MOVB IMGBAS(R3), R0     ; earlier visits
        BIC  #177400, R0
        ADD  R0, R2             ; known tile: turn by that many quarters
        BIC  #177774, R2
        INCB IMGBAS(R3)         ; one more visit (wraps at 256)
        BR   LOOP
`;

/** Program templates for the PDP-11 core, in the Code tab's course order. */
export const PDP_PROGRAM_TEMPLATES: Record<string, string> = {
  'First steps': PDP_FIRST_STEPS,
  'Drive yourself': PDP_DRIVE_YOURSELF,
  'Count with a variable': PDP_COUNT,
  Route: PDP_ROUTE,
  'Drive and scan at once': PDP_DRIVE_AND_SCAN,
  Explorer: PDP_EXPLORER,
  Photographer: PDP_PHOTOGRAPHER,
  Prospector: PDP_PROSPECTOR,
  'Field repair': PDP_FIELD_REPAIR,
  'Fetch supply crate': PDP_FETCH,
  Spiral: PDP_SPIRAL,
  'Seismic survey': PDP_SEISMIC,
  'Weather station': PDP_WEATHER,
  'Image: Line': PDP_IMAGE_LINE,
  'Image: Test pattern': PDP_IMAGE_TEST_PATTERN,
  'Image: Negative': PDP_IMAGE_NEGATIVE,
  'Image: Stamp': PDP_IMAGE_STAMP,
  'Image: Plot': PDP_IMAGE_PLOT,
  'Image: Memory map': PDP_IMAGE_MEMORY_MAP,
};

/**
 * Firmware templates for the PDP-11 core. The default firmware includes fault protection
 * (it was a separate template on Rover-ASM); the minimal one shows the gate alone.
 */
export const PDP_FIRMWARE_TEMPLATES: Record<string, string> = {
  'Default firmware': PDP_DEFAULT_FIRMWARE,
  'Minimal (the gate only)': PDP_MINIMAL_FIRMWARE,
  'All-in-one Explorer (no program)': PDP_ALLIN_EXPLORER,
  'All-in-one Prospector (no program)': PDP_ALLIN_PROSPECTOR,
  'All-in-one Fetch (no program)': PDP_ALLIN_FETCH,
};
