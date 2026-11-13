/** Firmware and programs shipped with the game. */

/** Pre-M10 factory firmware (retired in M10 slice 2: new rovers ship DEFAULT_FIRMWARE). Kept for tests. */
export const FACTORY_IDLE = `; FACTORY FIRMWARE: stationary self-management.
; Keeps the solar array on the sun (stowed during squalls), keeps the
; dish on the relay orbiter and logs a battery heartbeat.
; Replace it with your own code!

CONST BEAT_TICKS 50         ; ticks between heartbeats
CONST T_BAT 1               ; log tag: the Comms tab shows "T_BAT = 97"

loop:   MOV @SOLAR_OPEN 1
        JNE @ALERT ALERT_SQUALL aim
        MOV @SOLAR_OPEN 0                  ; squall: micrometeorites wreck open panels
aim:    MOV @SOLAR_ANGLE @SUN_AZIMUTH      ; motors slew toward targets
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH
        MOV @IND1 GREEN                    ; lamp 1 green: day
        JGT @SUN_ELEV 0 beat
        MOV @IND1 BLUE                     ; blue: night, waiting for dawn
beat:   MOV @IND3 OFF                      ; lamp 3: uplink
        JLT @SIGNAL_STR 20 wait            ; dish not on the orbiter yet
        LOG T_BAT @BAT                     ; heartbeat frame
        MOV @IND3 BLUE
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
go:     MOV @IND2 OFF             ; lamp 2: charging
        MOV @IND1 GREEN           ; lamp 1: exploring
        STEP dir 1
        JEQ @STATUS OK loop
        JMP turn                  ; blocked, hazard, deployed...: turn

charge: MOV @HEADLIGHT 0
        MOV @IND1 OFF
        MOV @IND2 AMBER
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
        MOV @IND1 GREEN             ; lamp 1 green: on the way
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
idle:   MOV @IND1 BLUE              ; lamp 1 blue: no crate to fetch
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
CONST T_BAT 1               ; log tags: the Comms tab shows "T_BAT = 97"
CONST T_RESULT 13
CONST T_END 14              ; T_END = 3: program done, 4: fault

fw:     MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; keep the dish on the orbiter
;--- comfort: lamp 3 blue while the dish is on the orbiter (12 B) ---
        MOV @IND3 OFF
        JLT @SIGNAL_STR 20 link
        MOV @IND3 BLUE
link:
;--- end ---
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
; "T_END = 3" (done) with the result in the Comms tab.

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

/**
 * Image memory examples (M12, SPEC §3.8.7): the six worked examples of docs/IMAGE_MEMORY.md,
 * word for word (a test keeps them identical). Programs: they END, except the memory map.
 */
export const IMAGE_LINE = `; LINE: your first picture. Clear image memory to black, draw a
; white line across the middle and send it home as a photo.

ALIAS r0 addr

        ERASE                 ; every byte 0 = 00 00 00 00 = four black pixels
        MOV addr 128          ; row 16 starts at byte 16 × 8 = 128
line:   STB addr 0xFF         ; 0xFF = 11 11 11 11 = four white pixels
        ADD addr 1
        JLT addr 136 line     ; one row = 8 bytes = 32 pixels
        SEND 1                ; decode as a 32×32 grey photo
        END 1
`;

export const IMAGE_TEST_PATTERN = `; TEST PATTERN: four grey bars, like a camera test card.
; One byte = four pixels. 85 = 0x55 = 01 01 01 01 = four dark-grey
; pixels, so level × 85 fills a byte with one grey: 0, 85, 170, 255.

ALIAS r0 addr
ALIAS r1 grey

        MOV addr 0
fill:   MOV grey addr
        MOD grey 8            ; which byte of its row (0–7)
        DIV grey 2            ; 2 bytes = 8 pixels per bar: level 0–3
        MUL grey 85
        STB addr grey
        ADD addr 1
        JLT addr 256 fill
        SEND 1
        END 1
`;

export const IMAGE_NEGATIVE = `; NEGATIVE: take a photo, turn it into a negative, send it.
; 255 − byte flips every pixel in the byte (0↔3, 1↔2).

ALIAS r0 addr
ALIAS r1 byte

        SNAP NORTH            ; into image memory: nothing is sent yet
        JNE @STATUS OK fail   ; ERR_LOW_POWER, ERR_INVALID...
        MOV addr 0
inv:    LDB byte addr         ; read
        MUL byte -1
        ADD byte 255          ; byte = 255 − byte
        STB addr byte         ; write back
        ADD addr 1
        JLT addr 256 inv
        SEND                  ; same format as the SNAP (mode 1)
        END 1
fail:   END 0
`;

export const IMAGE_STAMP = `; STAMP: take a photo and write where it was taken into its first
; four bytes (@X, then @Y, each 16-bit, high byte first), like the
; engineering header real spacecraft send with their images.
; In the Gallery, open the photo's hex view: the first bytes are yours.

ALIAS r0 addr
ALIAS r1 value
ALIAS r2 low

        SNAP NORTH
        JNE @STATUS OK fail
        MOV addr 0
        MOV value @X
        CALL put16
        MOV value @Y
        CALL put16
        SEND
        END 1
fail:   END 0

; put16: write value as two bytes (high, low) at addr; addr += 2
put16:  MOV low value
        AND low 0xFF          ; keep bits 7–0: the low byte
        SHR value 8           ; bits 15–8 move down to 7–0
        AND value 0xFF        ; the high byte: −300 → FE D4
        STB addr value
        ADD addr 1
        STB addr low
        ADD addr 1
        RET
`;

export const IMAGE_PLOT = `; PLOT: draw single pixels. Takes a photo and draws a white
; diagonal from the top-left corner to the bottom-right one.
; The plot routine works for any 2-bpp picture (modes 1 and 2).

        SNAP NORTH
        JNE @STATUS OK fail
        MOV r0 0
diag:   MOV r1 r0             ; y = x
        MOV r2 3              ; colour 3 = white
        CALL plot
        ADD r0 1
        JLT r0 32 diag
        SEND
        END 1
fail:   END 0

; plot: pixel (r0 = x, r1 = y) = colour r2 (0–3).
; Keeps r0; changes r1, r2 and r3.
plot:   PUSH r0
        SHL r1 3              ; y × 8: start of the row
        MOV r3 r0
        SHR r3 2              ; x / 4
        ADD r1 r3             ; r1 = address of the byte
        AND r0 3              ; pixel in the byte (0 = leftmost)
        MOV r3 3
        SUB r3 r0
        SHL r3 1              ; r3 = shift: 6, 4, 2 or 0
        SHL r2 r3             ; new colour moved into place
        MOV r0 3
        SHL r0 r3             ; r0 = mask: the pixel's two bits
        LDB r3 r1             ; the byte
        OR r3 r0              ; set the pixel's bits...
        SUB r3 r0             ; ...and take them away: now 00
        OR r3 r2              ; put the new colour in
        STB r1 r3
        POP r0
        RET
`;

export const IMAGE_MEMORY_MAP = `; MEMORY MAP: Explorer that remembers where it has been. Image
; memory is used as plain RAM: one byte per tile counts the visits,
; a 16×16 map that repeats every 16 tiles. Back on a known tile, the
; rover turns by the number of earlier visits, so it leaves a loop
; differently every time instead of circling forever.
; Do not SNAP in this program: a photo would overwrite the map.

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 cell

        ERASE                 ; forget the old map: image memory keeps
                              ; its contents through reboots
loop:   SCAN dir -> seen dist
        JEQ seen NONE go
        JGT dist 1 go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
go:     STEP dir 1
        JNE @STATUS OK turn
        MOV cell @Y
        MOD cell 16           ; map row 0–15 (also for negative @Y)
        MUL cell 16
        MOV seen @X
        MOD seen 16           ; map column 0–15
        ADD cell seen         ; byte address 0–255
        LDB seen cell         ; earlier visits
        ADD dir seen          ; known tile: turn by that many quarters
        MOD dir 4
        ADD seen 1
        STB cell seen         ; one more visit (wraps at 256)
        JMP loop
`;

/** Program templates (M10): the Code tab's Program slot offers these. */
export const PROGRAM_TEMPLATES: Record<string, string> = {
  'First steps': PROGRAM_FIRST_STEPS,
  Explorer: PROGRAM_EXPLORER,
  Prospector: PROGRAM_PROSPECTOR,
  'Fetch supply crate': PROGRAM_FETCH,
  'Image: Line': IMAGE_LINE,
  'Image: Test pattern': IMAGE_TEST_PATTERN,
  'Image: Negative': IMAGE_NEGATIVE,
  'Image: Stamp': IMAGE_STAMP,
  'Image: Plot': IMAGE_PLOT,
  'Image: Memory map': IMAGE_MEMORY_MAP,
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
