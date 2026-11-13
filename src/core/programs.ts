/** Firmware and programs shipped with the game. */

/** Pre-M10 factory firmware (retired in M10 slice 2: new rovers ship DEFAULT_FIRMWARE). Kept for tests. */
export const FACTORY_IDLE = `; FACTORY FIRMWARE: stationary self-management.
; Keeps the solar array on the sun (stowed during squalls), keeps the
; dish on the relay orbiter and logs a battery heartbeat.
; Replace it with your own code!

CONST BEAT_TICKS 50         ; ticks between heartbeats
CONST T_BAT 1               ; log tag: the Console shows "T_BAT = 97"

loop:   MOV @SOLAR_OPEN 1
        JNE @ALERT ALERT_SQUALL aim
        MOV @SOLAR_OPEN 0                  ; squall: micrometeorites wreck open panels
aim:    MOV @SOLAR_ANGLE @SUN_AZIMUTH      ; motors slew toward targets
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH
        MOV @LIGHT_COLOR GREEN             ; green: day
        JGT @SUN_ELEV 0 beat
        MOV @LIGHT_COLOR BLUE              ; blue: night, waiting for dawn
beat:   MOV @LIGHT_BLINK 0
        JLT @SIGNAL_STR 20 wait            ; dish not on the orbiter yet
        LOG T_BAT @BAT                     ; heartbeat frame
        MOV @LIGHT_BLINK 1
wait:   SLEEP BEAT_TICKS
`;

/** Template: drive around, turn at obstacles, stop to charge when low. */
export const DEMO_EXPLORER = `; EXPLORER: wander, turn right at obstacles,
; deploy solar panels to recharge when the battery runs low.

ALIAS r0 dir        ; heading (NORTH/EAST/SOUTH/WEST)
ALIAS r1 seen       ; tile type returned by SCAN
ALIAS r2 dist       ; distance to it
CONST LOW_BAT 30
CONST FULL_BAT 90

boot:   MOV @SOLAR_OPEN 0         ; panels survive reboots: stow them first
        SLEEP 20                  ; stowing takes 20 ticks
loop:   JLT @BAT LOW_BAT charge
        MOV @HEADLIGHT 0
        JGT @SUN_ELEV 0 look
        MOV @HEADLIGHT 1          ; night: headlight restores SCAN range
look:   SCAN dir -> seen dist
        JEQ seen NONE go          ; nothing ahead
        JGT dist 1 go             ; something ahead, but not adjacent
        JEQ seen SAMPLE go        ; items are driven over, not around
        JEQ seen REPAIR_KIT go
turn:   ADD dir 1                 ; turn right: dir = (dir + 1) mod 4
        MOD dir 4
        JMP loop
go:     MOV @LIGHT_COLOR GREEN
        STEP dir 1
        JEQ @STATUS OK loop
        JMP turn                  ; blocked, hazard, deployed...: turn

charge: MOV @HEADLIGHT 0
        MOV @LIGHT_COLOR AMBER
chg:    MOV @SOLAR_OPEN 1
        JNE @ALERT ALERT_SQUALL aim
        MOV @SOLAR_OPEN 0         ; squall warning: keep the array stowed
aim:    MOV @SOLAR_ANGLE @SUN_AZIMUTH
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH
        SLEEP 20
        JLT @BAT FULL_BAT chg
                                  ; falls off the end -> wraps to boot: stow & go
`;

/** Template: mine ore, grab samples, analyze them; the downlink sends the spectra home. */
export const PROSPECTOR = `; PROSPECTOR: wander; mine ore and grab samples found next to
; the rover and analyze them. Each spectrum waits in the recorder
; until the downlink has sent it: keep the dish on the orbiter.

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 slot

boot:   MOV @SOLAR_OPEN 0
        SLEEP 20
loop:   JLT @BAT 30 charge
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; spectra go home by themselves
look:   SCAN dir -> seen dist
        JGT dist 1 go                     ; target not adjacent yet
        JEQ seen IRON_ORE mine
        JEQ seen SILICON_ORE mine
        JEQ seen SAMPLE grab
        JEQ seen NONE go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
mine:   ACT TOOL_0 dir                    ; drill: 8 ticks
        JMP lab
grab:   ACT TOOL_1 dir                    ; grabber: 2 ticks
lab:    MOV slot 0
an:     ACT TOOL_2 slot                   ; spectrometer (ERR_INVALID if empty)
        ADD slot 1
        JLT slot 4 an
        JMP loop
go:     STEP dir 1
        JEQ @STATUS OK loop
        JMP turn
charge: MOV @SOLAR_OPEN 1
chg:    MOV @SOLAR_ANGLE @SUN_AZIMUTH
        SLEEP 20
        JLT @BAT 90 chg                   ; then wraps to boot: stow & go
`;

/** Template: drive to the nearest landed supply crate and grab it (installs the upgrade). */
export const FETCH_SUPPLY = `; FETCH: drive to the nearest supply crate and grab it, which
; installs the upgrade. Greedy: no obstacle avoidance (yours to add!).

ALIAS r0 dx
ALIAS r1 dy

boot:   MOV @SOLAR_OPEN 0
        SLEEP 20
loop:   JEQ @DROPS 0 idle
        MOV dx @DROP_X
        SUB dx @X
        MOV dy @DROP_Y
        SUB dy @Y
        SUB dy 1                ; aim for the tile just south of the crate
        JGT dx 0 go_e
        JLT dx 0 go_w
        JGT dy 0 go_n
        JLT dy 0 go_s
        ACT TOOL_1 NORTH        ; adjacent: grab = install
        JMP loop
go_e:   STEP EAST
        JMP loop
go_w:   STEP WEST
        JMP loop
go_n:   STEP NORTH
        JMP loop
go_s:   STEP SOUTH
        JMP loop
idle:   MOV @LIGHT_COLOR BLUE
        SLEEP 50
`;

/** Pre-M10 all-in-one firmwares (tests; the UI offers FIRMWARE_TEMPLATES). */
export const TEMPLATES: Record<string, string> = {
  'Factory idle': FACTORY_IDLE,
  Explorer: DEMO_EXPLORER,
  Prospector: PROSPECTOR,
  'Fetch supply crate': FETCH_SUPPLY,
};

// ------------------------------------------------------------------ M10: firmware + programs

/**
 * Default firmware (SPEC §3.9.4): a core that keeps the rover alive and runs the program
 * in time slices, plus optional comfort blocks. Byte costs are checked by tests.
 */
export const DEFAULT_FIRMWARE = `; DEFAULT FIRMWARE: keeps the rover alive and runs your program
; in time slices (RUN). Upload programs in the Program slot.
; Blocks marked "comfort" are optional: delete one (between its
; ;--- lines) to give its bytes to your program.

CONST LOW_BAT 30            ; charge when the battery drops below this
CONST FULL_BAT 90           ; ...until it reaches this
CONST SLICE 50              ; ticks per program time slice
CONST T_BAT 1               ; log tags: the Console shows "T_BAT = 97"
CONST T_RESULT 13
CONST T_END 14              ; T_END = 3: program done, 4: fault

fw:     MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; keep the dish on the orbiter
        JNE @ALERT ALERT_SQUALL power
        MOV @SOLAR_OPEN 0                  ; squall warning: stow the array
power:  JLT @BAT LOW_BAT charge
        JNE @PROG_STATE PROG_READY idle    ; nothing to run
        JEQ @SOLAR_OPEN 0 night            ; array left open (charging, old code)?
        MOV @SOLAR_OPEN 0                  ; stow it before the program drives
        SLEEP 20
night:
;--- comfort: automatic headlight at night (11 B) ---
        MOV @HEADLIGHT 0
        JGT @SUN_ELEV 0 go
        MOV @HEADLIGHT 1
;--- end ---
go:
;--- comfort: lamp 1 green while the program runs (3 B) ---
        MOV @IND1 GREEN
;--- end ---
        RUN SLICE
        JEQ @PROG_STATE PROG_READY fw      ; slice used up: housekeeping, next slice
        JEQ @PROG_STATE PROG_HALTED idle   ; BRK: waits for Continue
;--- comfort: lamp 1 blue = done, red = fault (11 B) ---
        MOV @IND1 BLUE
        JEQ @PROG_STATE PROG_DONE shown
        MOV @IND1 RED
shown:
;--- end ---
;--- comfort: @POST shows the program's result (3 B) ---
        MOV @POST @PROG_RESULT
;--- end ---
        LOG T_END @PROG_STATE
        LOG T_RESULT @PROG_RESULT
        MOV @PROG_STATE PROG_NONE          ; acknowledged: "Run again" restarts it
idle:   MOV @HEADLIGHT 0
;--- comfort: battery heartbeat while idle (9 B) ---
        JLT @SIGNAL_STR 20 nap
        LOG T_BAT @BAT
nap:
;--- end ---
        SLEEP 20
        JMP fw

charge: MOV @HEADLIGHT 0
;--- comfort: lamp 2 amber while charging (3 B) ---
        MOV @IND2 AMBER
;--- end ---
chg:    MOV @SOLAR_OPEN 1
        JNE @ALERT ALERT_SQUALL aim
        MOV @SOLAR_OPEN 0                  ; squall: keep the array stowed
aim:    MOV @SOLAR_ANGLE @SUN_AZIMUTH
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH
        SLEEP 20
        JLT @BAT FULL_BAT chg
;--- comfort: lamp 2 off when charged (3 B) ---
        MOV @IND2 OFF
;--- end ---
`;

/** Program: the shortest useful one. Drives a square and ends. */
export const PROGRAM_FIRST_STEPS = `; FIRST STEPS: drive a 3x3 square, then END.
; The firmware runs this program in time slices and reports
; "T_END = 3" (done) with the result on the Console.

ALIAS r0 dir

side:   STEP dir 3
        JNE @STATUS OK stuck      ; blocked, hazard...
        ADD dir 1                 ; turn right
        JLT dir 4 side
        END 1                     ; result 1: square done
stuck:  END 0                     ; result 0: something was in the way
`;

/** Program: Explorer without its own charging code (the firmware charges). */
export const PROGRAM_EXPLORER = `; EXPLORER: wander, turn right at obstacles.
; The firmware charges the battery, aims the dish and turns on
; the headlight at night between time slices.

ALIAS r0 dir        ; heading (NORTH/EAST/SOUTH/WEST)
ALIAS r1 seen       ; tile type returned by SCAN
ALIAS r2 dist       ; distance to it

loop:   SCAN dir -> seen dist
        JEQ seen NONE go          ; nothing ahead
        JGT dist 1 go             ; something ahead, but not adjacent
        JEQ seen SAMPLE go        ; items are driven over, not around
        JEQ seen REPAIR_KIT go
turn:   ADD dir 1                 ; turn right: dir = (dir + 1) mod 4
        MOD dir 4
        JMP loop
go:     STEP dir 1
        JEQ @STATUS OK loop
        JMP turn                  ; blocked, hazard...: turn
`;

/** Program: Prospector without its own charging code. */
export const PROGRAM_PROSPECTOR = `; PROSPECTOR: wander; mine ore and grab samples found next to
; the rover and analyze them. Each spectrum waits in the recorder
; until the downlink has sent it. The firmware charges.

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 slot

loop:   MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; spectra go home by themselves
        SCAN dir -> seen dist
        JGT dist 1 go                     ; target not adjacent yet
        JEQ seen IRON_ORE mine
        JEQ seen SILICON_ORE mine
        JEQ seen SAMPLE grab
        JEQ seen NONE go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
mine:   ACT TOOL_0 dir                    ; drill: 8 ticks
        JMP lab
grab:   ACT TOOL_1 dir                    ; grabber: 2 ticks
lab:    MOV slot 0
an:     ACT TOOL_2 slot                   ; spectrometer (ERR_INVALID if empty)
        ADD slot 1
        JLT slot 4 an
        JMP loop
go:     STEP dir 1
        JEQ @STATUS OK loop
        JMP turn
`;

/** Program: fetch the nearest supply crate, then END. */
export const PROGRAM_FETCH = `; FETCH: drive to the nearest supply crate and grab it, which
; installs the upgrade. Greedy: no obstacle avoidance (yours to add!).
; END 1 when the crate is installed, END 0 if there is none.

ALIAS r0 dx
ALIAS r1 dy

loop:   JEQ @DROPS 0 nocrate
        MOV dx @DROP_X
        SUB dx @X
        MOV dy @DROP_Y
        SUB dy @Y
        SUB dy 1                ; aim for the tile just south of the crate
        JGT dx 0 go_e
        JLT dx 0 go_w
        JGT dy 0 go_n
        JLT dy 0 go_s
        ACT TOOL_1 NORTH        ; adjacent: grab = install
        JNE @STATUS OK loop
        END 1
nocrate: END 0
go_e:   STEP EAST
        JMP loop
go_w:   STEP WEST
        JMP loop
go_n:   STEP NORTH
        JMP loop
go_s:   STEP SOUTH
        JMP loop
`;

/** Program templates (M10): the Code tab's Program slot offers these. */
export const PROGRAM_TEMPLATES: Record<string, string> = {
  'First steps': PROGRAM_FIRST_STEPS,
  Explorer: PROGRAM_EXPLORER,
  Prospector: PROGRAM_PROSPECTOR,
  'Fetch supply crate': PROGRAM_FETCH,
};

/**
 * Firmware examples (M10, Code tab Firmware slot): the default firmware, then the
 * pre-M10 all-in-one firmwares, which do everything themselves and never RUN a program.
 */
export const FIRMWARE_TEMPLATES: Record<string, string> = {
  'Default firmware': DEFAULT_FIRMWARE,
  'All-in-one Explorer (no RUN)': DEMO_EXPLORER,
  'All-in-one Prospector (no RUN)': PROSPECTOR,
  'All-in-one Fetch (no RUN)': FETCH_SUPPLY,
};
