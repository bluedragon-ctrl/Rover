/** Firmware shipped with the game. */

/** Pre-installed on every new rover: stationary self-management. */
export const FACTORY_IDLE = `; FACTORY FIRMWARE: stationary self-management.
; Keeps the solar array on the sun (stowed during squalls), keeps the
; dish on the relay orbiter and sends a battery heartbeat.
; Replace it with your own code!

CONST BEAT_TICKS 50         ; ticks between heartbeats

loop:   MOV @SOLAR_OPEN 1
        JNE @ALERT ALERT_SQUALL aim
        MOV @SOLAR_OPEN 0                  ; squall: micrometeorites wreck open panels
aim:    MOV @SOLAR_ANGLE @SUN_AZIMUTH      ; motors slew toward targets
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH
        MOV @LIGHT_COLOR GREEN             ; green: day
        JGT @SUN_ELEV 0 beat
        MOV @LIGHT_COLOR BLUE              ; blue: night, waiting for dawn
beat:   MOV @LIGHT_BLINK 0
        JLT @SIGNAL_STR 50 wait            ; no uplink yet
        MOV @TX_DATA @BAT                  ; heartbeat packet
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

/** Template: mine ore, grab samples, analyze them and beam the science home. */
export const PROSPECTOR = `; PROSPECTOR: wander; mine ore and grab samples found next to
; the rover, analyze cargo, and beam science to the orbiter.

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 slot

boot:   MOV @SOLAR_OPEN 0
        SLEEP 20
loop:   JLT @BAT 30 charge
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; keep the dish on the orbiter
        JEQ @SCIENCE_READY 0 look
        JLT @SIGNAL_STR 50 look
        MOV @TX_DATA @SCIENCE_READY       ; each packet carries 1 science
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

export const TEMPLATES: Record<string, string> = {
  'Factory idle': FACTORY_IDLE,
  Explorer: DEMO_EXPLORER,
  Prospector: PROSPECTOR,
};
