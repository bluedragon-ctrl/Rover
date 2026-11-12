/** Starter firmware shipped with a new world. */
export const DEMO_EXPLORER = `; Rover Mk-I demo firmware: wander and turn right at obstacles.
; Edit me, then press Upload (Ctrl+Enter) to flash and reboot.

ALIAS r0 dir        ; current heading (NORTH/EAST/SOUTH/WEST)
ALIAS r1 seen       ; tile type returned by SCAN
ALIAS r2 dist       ; distance to it
CONST LOW_BAT 15

loop:   JLT @BAT LOW_BAT rest
        SCAN dir -> seen dist
        JEQ seen NONE go          ; nothing ahead
        JGT dist 1 go             ; something ahead, but not adjacent
        JEQ seen SAMPLE go        ; items are driven over, not around
        JEQ seen REPAIR_KIT go
turn:   ADD dir 1                 ; turn right: dir = (dir + 1) mod 4
        MOD dir 4
        MOV @LIGHT_COLOR AMBER
        JMP loop
go:     MOV @LIGHT_COLOR GREEN
        STEP dir 1
        JEQ @STATUS OK loop
        JMP turn                  ; blocked, hazard or low power: turn

rest:   MOV @LIGHT_COLOR RED
        MOV @LIGHT_BLINK 1
        SLEEP 100
        MOV @LIGHT_BLINK 0
        JMP loop
`;
