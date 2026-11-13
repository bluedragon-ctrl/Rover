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
export const DEMO_EXPLORER = `; EXPLORER (all-in-one firmware): wander, turn right at obstacles,
; deploy solar panels to recharge when the battery runs low.
;
; Learn: what a firmware must do by itself when it runs no program:
; charging (@SOLAR_OPEN, @SOLAR_ANGLE), the dish, the squall warning,
; the headlight, and that the array stays open across a reboot.
; This is the code of the program "Explorer" plus the jobs the default
; firmware does for it. Try: compare it with "Default firmware".

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
export const PROSPECTOR = `; PROSPECTOR (all-in-one firmware): wander; mine ore and grab
; samples found next to the rover and analyze them. Each spectrum
; waits in the recorder until the downlink has sent it: keep the dish
; on the orbiter.
;
; Learn: a firmware that charges and works without RUN. Note that it
; does not stow the array for squalls: a gap the default firmware
; closes. Try: add the squall check (see "All-in-one Explorer").

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
export const FETCH_SUPPLY = `; FETCH (all-in-one firmware): drive to the nearest supply crate
; and grab it, which installs the upgrade. Greedy: no obstacle
; avoidance (yours to add!).
;
; Learn: a firmware that never ends: with no crate it waits (SLEEP)
; and checks again. It does not charge: watch @BAT on long trips.
; Try: the program "Fetch supply crate" for the version with results.

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

/*
 * Program templates (M10; reworked as lessons after M12). Each header says what the
 * program does, what it teaches (Learn) and what to change next (Try); together they
 * use every instruction and the main ports. Comments cost no Flash. Tests compile each
 * one within the default firmware's budget and run it.
 */

/** Program 1: the shortest useful one. */
export const PROGRAM_FIRST_STEPS = `; FIRST STEPS: drive a 3×3 square, then end.
;
; Learn: registers and ALIAS, STEP, checking @STATUS, a loop, END.
;
; The CPU has four registers, r0–r3; each holds a number and starts
; at 0. ALIAS gives one a name. Hardware instructions (STEP, SCAN,
; ACT...) put their outcome in @STATUS: OK, or an error such as
; ERR_BLOCKED. The firmware runs this program in time slices; when it
; ENDs, the Comms tab shows "T_END = 3" (done) and "T_RESULT = 1",
; and the rover's @POST display shows the result.
; Try: a bigger square; END with the number of sides driven.

ALIAS r0 dir              ; heading: 0 NORTH, 1 EAST, 2 SOUTH, 3 WEST

side:   STEP dir 3                ; drive 3 tiles in direction dir
        JNE @STATUS OK stuck      ; blocked, hazard, low power...
        ADD dir 1                 ; turn right: NORTH -> EAST -> ...
        JLT dir 4 side            ; fewer than 4 sides: next side
        END 1                     ; result 1: square done
stuck:  END 0                     ; result 0: something was in the way
`;

/** Program 2: wander forever. */
export const PROGRAM_EXPLORER = `; EXPLORER: wander, turn right at obstacles, report acid vents.
;
; Learn: SCAN (radar), tile constants, MOD to wrap a counter, telling
; @STATUS errors apart, LOG frames for mission control.
;
; SCAN dir -> seen dist returns the first thing in that direction
; (NONE if nothing within range) and how far away it is; it works day
; and night. Items (samples, kits) are driven over, not around.
; Driving onto an ACID_VENT costs 10 hull and ends the STEP with
; ERR_HAZARD; this program then logs the vent's position (Comms:
; "T_VENT_X", "T_VENT_Y"). The program never ENDs: between slices the
; firmware charges the battery, then the program goes on where it was.
; Try: turn left instead; pick the turn from @TICK MOD 2 (random-ish).

CONST T_VENT_X 2            ; log tags (0–14): your names in the Comms tab
CONST T_VENT_Y 3

ALIAS r0 dir        ; heading 0–3
ALIAS r1 seen       ; tile type returned by SCAN
ALIAS r2 dist       ; distance to it

loop:   SCAN dir -> seen dist
        JEQ seen NONE go          ; nothing ahead
        JGT dist 1 go             ; something ahead, but not adjacent
        JEQ seen SAMPLE go        ; items are driven over
        JEQ seen REPAIR_KIT go
turn:   ADD dir 1                 ; turn right: dir = (dir + 1) mod 4
        MOD dir 4
        JMP loop
go:     STEP dir 1
        JEQ @STATUS OK loop
        JNE @STATUS ERR_HAZARD turn ; blocked: something moved in
        LOG T_VENT_X @X           ; on an acid vent: tell mission control
        LOG T_VENT_Y @Y
        JMP turn                  ; and leave it
`;

/** Program 3: SNAP and SEND. */
export const PROGRAM_PHOTOGRAPHER = `; PHOTOGRAPHER: photograph all four directions, send the photos
; home, END with how many were sent.
;
; Learn: SNAP and SEND, aiming the headlight with @HEADING, waiting
; for space in the science recorder (@REC_FREE).
;
; SNAP dir takes a photo of the first thing within 2 tiles in that
; direction (or the landscape) into image memory; SEND copies it into
; the science recorder, and the downlink sends it home while the dish
; is on the orbiter (the firmware keeps it there). Only a lit photo
; earns credits: daylight, or the headlight shining at the subject.
; The firmware turns the headlight on at night; it shines along
; @HEADING, so face what you photograph. Photos appear in the Gallery
; tab; the first photo of each kind of subject earns a bonus.
; Try: SNAP only when SCAN sees a CLIFF_WALL or SAMPLE within 2 tiles.
; Between SNAP and SEND you can change the photo: see "Image: ...".

CONST PHOTO_BYTES 258       ; a mode-1 photo in the recorder (256 + header)

ALIAS r0 dir
ALIAS r1 sent       ; photos sent so far

shot:   MOV @HEADING dir          ; turn in place to face it
        SNAP dir                  ; mode 1: 32×32 grey, into image memory
        JNE @STATUS OK next       ; ERR_LOW_POWER...: skip this one
wait:   JGE @REC_FREE PHOTO_BYTES keep
        SLEEP 10                  ; recorder full: let the downlink empty it
        JMP wait
keep:   SEND                      ; image memory -> science recorder
        ADD sent 1
next:   ADD dir 1
        JLT dir 4 shot
        END sent                  ; result: photos sent (0–4)
`;

/** Program 4: tools, cargo and a subroutine. */
export const PROGRAM_PROSPECTOR = `; PROSPECTOR: wander; mine ore veins and pick up samples next to
; the rover, analyze them and send the spectra home.
;
; Learn: tools (ACT TOOL_n), cargo (PEEK), a subroutine (CALL / RET).
;
; Mk-I hardpoints: TOOL_0 drill (mines an adjacent ore vein into
; cargo), TOOL_1 grabber (picks up an adjacent item), TOOL_2
; spectrometer (analyzes the item in a cargo slot and frees the slot).
; Spectra wait in the science recorder (@SCIENCE_READY counts them)
; until the downlink sends them: a sample earns 3 credits, ore 1.
; CALL lab jumps to lab and remembers where it came from; RET goes back.
; Try: keep IRON_ORE in cargo for repairs (see Field repair).

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 slot

loop:   SCAN dir -> seen dist
        JGT dist 1 go             ; target not adjacent yet
        JEQ seen IRON_ORE mine
        JEQ seen SILICON_ORE mine
        JEQ seen SAMPLE grab
        JEQ seen NONE go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
mine:   ACT TOOL_0 dir            ; drill: 8 ticks, ore into cargo
        JMP done
grab:   ACT TOOL_1 dir            ; grabber: 2 ticks, item into cargo
done:   CALL lab
        JMP loop
go:     STEP dir 1
        JEQ @STATUS OK loop
        JMP turn

; lab: analyze everything in cargo. Changes seen and slot.
lab:    MOV slot 0
item:   PEEK slot -> seen         ; item in the slot, 0 = empty
        JEQ seen 0 skip           ; empty slot: nothing to analyze
        ACT TOOL_2 slot           ; spectrometer: spectrum to the recorder
skip:   ADD slot 1
        JLT slot 4 item           ; Mk-I has 4 cargo slots (0–3)
        RET
`;

/** Program 5: PEEK and USE. */
export const PROGRAM_FIELD_REPAIR = `; FIELD REPAIR: repair worn systems with what is in cargo, END
; with the number of repairs.
;
; Learn: USE slot system, nested loops, choosing a port with jumps.
;
; Systems: SYS_HULL (0), SYS_SOLAR (1), SYS_ANTENNA (2), with health
; in @HULL, @SOLAR_HEALTH, @ANTENNA_HEALTH (0–100). USE takes 10
; ticks and uses the item up. REPAIR_KIT: +30 hull, +40 solar, +40
; dish; IRON_ORE: +10 hull, +15 dish; SILICON_ORE: +20 solar. An item
; that cannot repair a system fails with ERR_INVALID, so the program
; simply tries every slot. Get materials with the grabber or the drill
; first (Prospector). Goal "Field engineer": one repair.
; Try: repair the dish first; keep one REPAIR_KIT for emergencies.

CONST WORN 80               ; repair systems below this health

ALIAS r0 sys        ; system being checked: 0, 1, 2
ALIAS r1 slot       ; cargo slot being tried: 0–3
ALIAS r2 value      ; a health, then an item
ALIAS r3 fixed      ; repairs made

check:  MOV value @HULL           ; read the health of system sys:
        JEQ sys SYS_HULL test     ; one port per system, so pick it
        MOV value @SOLAR_HEALTH   ; with jumps
        JEQ sys SYS_SOLAR test
        MOV value @ANTENNA_HEALTH
test:   JGE value WORN nextsys    ; healthy enough
        MOV slot 0
try:    PEEK slot -> value        ; the health is not needed any more
        JEQ value 0 nextslot      ; empty slot
        USE slot sys
        JNE @STATUS OK nextslot   ; this item cannot repair sys
        ADD fixed 1
        JMP check                 ; still worn? try again
nextslot: ADD slot 1
        JLT slot 4 try
nextsys: ADD sys 1
        JLT sys 3 check
        END fixed
`;

/** Program 6: positions and directions. */
export const PROGRAM_FETCH = `; FETCH: drive to the nearest supply crate and pick it up, which
; installs the upgrade. END 1 = installed, 0 = no crate, 2 = stuck.
;
; Learn: positions (@X, @Y, @DROP_X, @DROP_Y), SUB for differences,
; picking a direction from a sign, "set a default, then jump".
;
; Buy an upgrade in the Upgrades tab: its crate lands 3–6 tiles away
; after 80 ticks (@DROPS counts the crates that have landed). The
; rover heads for the tile just south of the crate, then grabs NORTH.
; It drives straight at it: with a rock in the way it ENDs with 2.
; Try: when blocked, step sideways once and go on (see Explorer).

ALIAS r0 dx         ; how far east the target is (negative: west)
ALIAS r1 dy         ; how far north
ALIAS r2 dir

loop:   JEQ @DROPS 0 nocrate
        MOV dx @DROP_X
        SUB dx @X
        MOV dy @DROP_Y
        SUB dy @Y
        SUB dy 1                  ; the tile south of the crate
        MOV dir EAST              ; guess a direction, then check it
        JGT dx 0 go
        MOV dir WEST
        JLT dx 0 go
        MOV dir NORTH
        JGT dy 0 go
        MOV dir SOUTH
        JLT dy 0 go
        ACT TOOL_1 NORTH          ; there: grab = install
        JNE @STATUS OK loop
        END 1
nocrate: END 0
go:     STEP dir
        JEQ @STATUS OK loop
        END 2                     ; something is in the way
`;

/** Program 7: CALL with arguments, the data stack, LOG and BRK. */
export const PROGRAM_SPIRAL = `; SPIRAL: search around the start in a growing square spiral
; (legs of 1, 1, 2, 2, 3, 3... tiles), logging every corner.
;
; Learn: subroutines with arguments, the data stack (POP), LOG, BRK.
;
; CALL leg dir len pushes dir, then len, onto the data stack and jumps
; to leg; leg POPs them back in reverse order (last in, first out).
; The stack holds 8 numbers: every CALL argument must be POPped.
; Each corner arrives in the Comms tab as "T_X = ..." and "T_Y = ...".
; At the end BRK halts the program and the rover sends its registers
; home (Comms: a DUMP "sent by BRK"); press Continue to END.
; Try: stop early when SCAN sees a SAMPLE; spiral the other way.

CONST LEGS 6                ; longest leg, in tiles
CONST T_X 2                 ; log tags for the corners
CONST T_Y 3

ALIAS r0 dir
ALIAS r1 len

        MOV len 1
spiral: CALL leg dir len          ; two legs of the same length...
        ADD dir 1
        MOD dir 4
        CALL leg dir len
        ADD dir 1
        MOD dir 4
        ADD len 1                 ; ...then one tile longer
        JLE len LEGS spiral
        BRK                       ; look at the dump, then Continue
        END len

; leg(dir, len): drive len tiles in dir, log the corner. Uses r2, r3.
leg:    POP r3                    ; len: pushed last, popped first
        POP r2                    ; dir
        STEP r2 r3                ; blocked? it just stops early
        LOG T_X @X
        LOG T_Y @Y
        RET
`;

/** Program 8: an upgrade tool and a search for the minimum. */
export const PROGRAM_SEISMIC = `; SEISMIC SURVEY: listen for ore in four directions, drive to the
; nearest vein and mine it. Needs the seismic scanner upgrade.
;
; Learn: finding the smallest value in a loop, a tool that answers
; through ports (@SEISMIC_TYPE, @SEISMIC_DIST), result codes.
;
; ACT TOOL_3 dir (4 ticks) hears the nearest ore vein up to 12 tiles
; away in dir, even through walls: @SEISMIC_DIST = distance, 0 = none.
; Without the upgrade the hardpoint is empty: ERR_NO_TOOL.
; END 1 = mined, 0 = no scanner, 2 = no ore in range, 3 = blocked on
; the way (the scanner hears through walls, the rover cannot drive).
; Try: when blocked, scan again from where the rover stopped.

ALIAS r0 dir
ALIAS r1 best       ; direction of the nearest vein so far
ALIAS r2 near       ; its distance (99 = none yet)

        MOV near 99
listen: ACT TOOL_3 dir
        JEQ @STATUS ERR_NO_TOOL notool
        JEQ @SEISMIC_DIST 0 next  ; nothing that way
        JGE @SEISMIC_DIST near next ; not nearer than the best so far
        MOV near @SEISMIC_DIST    ; new nearest
        MOV best dir
next:   ADD dir 1
        JLT dir 4 listen
        JEQ near 99 noore
        SUB near 1                ; stop next to the vein
        JEQ near 0 drill          ; already there
        STEP best near
drill:  ACT TOOL_0 best           ; ore into cargo
        JNE @STATUS OK blocked
        END 1
noore:  END 2
blocked: END 3
notool: END 0
`;

/** Program 9: timing and alerts. */
export const PROGRAM_WEATHER = `; WEATHER STATION: stay put and report the weather: the sunlight
; every 100 ticks, plus every warning of a squall or an eclipse.
; Runs until you upload another program.
;
; Learn: SLEEP for timing, @TICK, DIV, the alert ports.
;
; @SUN_LIGHT is 0–100. @ALERT is ALERT_NONE or the event on its way
; (ALERT_SQUALL, ALERT_ECLIPSE); @ALERT_ETA is the ticks until it
; starts. The firmware already stows the solar array for a squall:
; this program only reports. A sol is 2400 ticks; this program counts
; it in 24 "hours" of 100 ticks from the landing (tick 0), so hour 0
; is not midnight: watch @SUN_LIGHT to see when the sun rises.
; Try: only log when the light changed; LOG the hour of sunrise.

CONST T_HOUR 2              ; log tags
CONST T_LIGHT 3
CONST T_ALERT 4
CONST T_ETA 5

ALIAS r0 hour

loop:   MOV hour @TICK
        MOD hour 2400             ; ticks since the sol started
        DIV hour 100              ; whole hours: 0–23
        LOG T_HOUR hour
        LOG T_LIGHT @SUN_LIGHT
        JEQ @ALERT ALERT_NONE calm
        LOG T_ALERT @ALERT
        LOG T_ETA @ALERT_ETA
calm:   SLEEP 100
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
  Photographer: PROGRAM_PHOTOGRAPHER,
  Prospector: PROGRAM_PROSPECTOR,
  'Field repair': PROGRAM_FIELD_REPAIR,
  'Fetch supply crate': PROGRAM_FETCH,
  Spiral: PROGRAM_SPIRAL,
  'Seismic survey': PROGRAM_SEISMIC,
  'Weather station': PROGRAM_WEATHER,
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
