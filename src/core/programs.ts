/** Firmware shipped with the game. */

/** Pre-installed on every new rover: stationary self-management. */
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

export const TEMPLATES: Record<string, string> = {
  'Factory idle': FACTORY_IDLE,
  Explorer: DEMO_EXPLORER,
  Prospector: PROSPECTOR,
  'Fetch supply crate': FETCH_SUPPLY,
};
