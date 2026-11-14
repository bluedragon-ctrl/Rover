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
        JLT @SIGNAL_STR 20 nap             ; dish not on the orbiter yet
        LOG T_BAT @BAT                     ; heartbeat frame
        MOV @IND3 BLUE
nap:    CALL SLEEP BEAT_TICKS
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
ALIAS r1 seen       ; tile type the radar found (@RADAR_HIT)
ALIAS r2 dist       ; distance to it
CONST LOW_BAT 30
CONST FULL_BAT 90

boot:   MOV @SOLAR_OPEN 0         ; panels survive reboots: stow them first
        CALL SLEEP 20             ; stowing takes 20 ticks
loop:   JLT @BAT LOW_BAT charge
        MOV @HEADLIGHT 0
        JGT @SUN_ELEV 0 look
        MOV @HEADLIGHT 1          ; night: headlight (the operator sees the way)
look:   CALL SCAN dir
        MOV seen @RADAR_HIT
        MOV dist @RADAR_DIST
        JEQ seen NONE go          ; nothing ahead
        JGT dist 1 go             ; something ahead, but not adjacent
        JEQ seen SAMPLE go        ; items are driven over, not around
        JEQ seen REPAIR_KIT go
turn:   ADD dir 1                 ; turn right: dir = (dir + 1) mod 4
        MOD dir 4
        JMP loop
go:     MOV @IND2 OFF             ; lamp 2: charging
        MOV @IND1 GREEN           ; lamp 1: exploring
        CALL STEP dir 1
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
        CALL SLEEP 20
        JLT @BAT FULL_BAT chg
                                  ; falls off the end -> wraps to boot: stow & go
`;

/** Template: mine ore, grab samples, analyze them; the downlink sends the spectra home. */
export const PROSPECTOR = `; PROSPECTOR (all-in-one firmware): wander; mine ore and grab
; samples found next to the rover and analyze them. Each spectrum
; waits in the recorder until the downlink has sent it: keep the dish
; on the orbiter.
;
; Learn: a firmware that charges and works without a program. Note that it
; does not stow the array for squalls: a gap the default firmware
; closes. Try: add the squall check (see "All-in-one Explorer").

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 slot

boot:   MOV @SOLAR_OPEN 0
        CALL SLEEP 20
loop:   JLT @BAT 30 charge
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; spectra go home by themselves
look:   CALL SCAN dir
        MOV seen @RADAR_HIT
        MOV dist @RADAR_DIST
        JGT dist 1 go                     ; target not adjacent yet
        JEQ seen IRON_ORE mine
        JEQ seen SILICON_ORE mine
        JEQ seen SAMPLE grab
        JEQ seen NONE go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
mine:   CALL ACT TOOL_0 dir               ; drill: 8 ticks
        JMP lab
grab:   CALL ACT TOOL_1 dir               ; grabber: 2 ticks
lab:    MOV slot 0
an:     CALL ACT TOOL_2 slot              ; spectrometer (ERR_INVALID if empty)
        ADD slot 1
        JLT slot 4 an
        JMP loop
go:     CALL STEP dir 1
        JEQ @STATUS OK loop
        JMP turn
charge: MOV @SOLAR_OPEN 1
chg:    MOV @SOLAR_ANGLE @SUN_AZIMUTH
        CALL SLEEP 20
        JLT @BAT 90 chg                   ; then wraps to boot: stow & go
`;

/** Template: drive to the nearest landed supply crate and grab it (installs the upgrade). */
export const FETCH_SUPPLY = `; FETCH (all-in-one firmware): drive to the nearest supply crate
; and grab it, which installs the upgrade. Greedy: no obstacle
; avoidance (yours to add!).
;
; Learn: a firmware that never ends: with no crate it waits (CALL SLEEP)
; and checks again. It does not charge: watch @BAT on long trips.
; Try: the program "Fetch supply crate" for the version with results.

ALIAS r0 dx
ALIAS r1 dy

boot:   MOV @SOLAR_OPEN 0
        CALL SLEEP 20
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
        CALL ACT TOOL_1 NORTH   ; adjacent: grab = install
        JMP loop
go_e:   CALL STEP EAST 1
        JMP loop
go_w:   CALL STEP WEST 1
        JMP loop
go_n:   CALL STEP NORTH 1
        JMP loop
go_s:   CALL STEP SOUTH 1
        JMP loop
idle:   MOV @IND1 BLUE              ; lamp 1 blue: no crate to fetch
        CALL SLEEP 50
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
export const DEFAULT_FIRMWARE = `; DEFAULT FIRMWARE: keeps the rover alive and calls your program
; for time slices (CALL RUN). Upload programs in the Program slot.
; Blocks marked "comfort" are optional: delete one (between its
; ;--- lines) to give its bytes to your program.

CONST LOW_BAT 30            ; charge when the battery drops below this
CONST FULL_BAT 90           ; ...until it reaches this
CONST SLICE 50              ; ticks per program time slice
CONST T_BAT 1               ; log tags: the Comms tab shows "T_BAT = 97"
CONST T_RESULT 13
CONST T_END 14              ; T_END = 3: program done, 4: fault
CONST WDT_TICKS 1000        ; watchdog: no kick for this long = hang, reboot

fw:     MOV @WDT WDT_TICKS                 ; kick the watchdog (arms it at boot)
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH ; keep the dish on the orbiter
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
        CALL SLEEP 20
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
        CALL RUN SLICE                     ; ROM: @SLICE = SLICE, CALL PROGRAM
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
        CALL SLEEP 20
        JMP fw

charge: MOV @HEADLIGHT 0
;--- comfort: lamp 2 amber while charging (3 B) ---
        MOV @IND2 AMBER
;--- end ---
chg:    MOV @WDT WDT_TICKS                 ; charging can take a whole night: keep kicking
        MOV @SOLAR_OPEN 1
        JNE @ALERT ALERT_SQUALL aim
        MOV @SOLAR_OPEN 0                  ; squall: keep the array stowed
aim:    MOV @SOLAR_ANGLE @SUN_AZIMUTH
        MOV @ANTENNA_ANGLE @ORBIT_AZIMUTH
        CALL SLEEP 20
        JLT @BAT FULL_BAT chg
;--- comfort: lamp 2 off when charged (3 B) ---
        MOV @IND2 OFF
;--- end ---
`;

/** Apply exact text edits; a missing anchor is a bug (the template would silently drift). */
function edited(src: string, edits: [string, string][]): string {
  return edits.reduce((out, [from, to]) => {
    if (!out.includes(from)) throw new Error(`template anchor not found: ${from}`);
    return out.replace(from, to);
  }, src);
}

/**
 * Firmware template (SPEC §3.9.2): the default firmware plus fault protection. Built from
 * DEFAULT_FIRMWARE so the two never drift apart.
 */
export const FIRMWARE_FAULT_PROTECTION = edited(DEFAULT_FIRMWARE, [
  [
    `; DEFAULT FIRMWARE: keeps the rover alive and calls your program
; for time slices (CALL RUN). Upload programs in the Program slot.
`,
    `; FAULT PROTECTION FIRMWARE: the default firmware, plus it takes
; control back at once when something goes wrong.
;
; The default firmware only looks around between time slices of 50
; ticks. Here the CPU interrupts the program at once when a world
; event is announced or the battery drops below LOW_BAT (@PREEMPT,
; @BAT_ALARM). Devices the program started keep running: this firmware
; stops the drive at the end of its tile (@DRIVE_N 0; the program's
; WAIT then reads ERR_PREEMPTED). The next CALL RUN resumes the program
; where it was. Comms shows "T_PREEMPT = 1" (alert) or 4.
;
; Learn: @PREEMPT and the PRE_* bits, @BAT_ALARM, @PREEMPTED: why
; flight software must be able to stop a running task. It is 18 B
; bigger than the default firmware: programs up to 328 B fit with it.
; Try: also stop for damage: CONST PROTECT 7 (PRE_ALERT + PRE_DAMAGE
; + PRE_LOW_BAT = 1 + 2 + 4).
;
`,
  ],
  [
    `CONST WDT_TICKS 1000        ; watchdog: no kick for this long = hang, reboot
`,
    `CONST WDT_TICKS 1000        ; watchdog: no kick for this long = hang, reboot
CONST PROTECT 5             ; PRE_ALERT (1) + PRE_LOW_BAT (4)
CONST T_PREEMPT 12          ; T_PREEMPT = why a slice was cut short (PRE_* bits)
`,
  ],
  [
    `fw:     MOV @WDT WDT_TICKS`,
    `boot:   MOV @PREEMPT PROTECT               ; set once: a reboot switches it off
        MOV @BAT_ALARM LOW_BAT             ; PRE_LOW_BAT below this
fw:     MOV @WDT WDT_TICKS`,
  ],
  [
    `        CALL RUN SLICE                     ; ROM: @SLICE = SLICE, CALL PROGRAM
        JEQ @PROG_STATE PROG_READY fw`,
    `        CALL RUN SLICE                     ; ROM: @SLICE = SLICE, CALL PROGRAM
        JEQ @PREEMPTED 0 cont              ; slice cut short?
        MOV @DRIVE_N 0                     ; stop the wheels at the end of this tile
        LOG T_PREEMPT @PREEMPTED           ; tell mission control why
cont:   JEQ @PROG_STATE PROG_READY fw`,
  ],
]);

/*
 * Program templates (M10; reworked as lessons after M12). Each header says what the
 * program does, what it teaches (Learn) and what to change next (Try); together they
 * use every instruction and the main ports. Comments cost no Flash. Tests compile each
 * one within the default firmware's budget and run it.
 */

/** Program 1: the shortest useful one. */
export const PROGRAM_FIRST_STEPS = `; FIRST STEPS: drive a 3×3 square, then end.
;
; Learn: registers and ALIAS, CALL STEP, checking @STATUS, a loop, END.
;
; The CPU has four registers, r0–r3; each holds a number and starts
; at 0. ALIAS gives one a name. CALL STEP runs the ROM's drive routine
; (Reference → ROM); like every device, the drive puts its outcome in
; @STATUS: OK, or an error such as ERR_BLOCKED. The firmware calls this
; program for time slices; when it
; ENDs, the Comms tab shows "T_END = 3" (done) and "T_RESULT = 1",
; and the rover's @POST display shows the result.
; Try: a bigger square; END with the number of sides driven.

ALIAS r0 dir              ; heading: 0 NORTH, 1 EAST, 2 SOUTH, 3 WEST

side:   CALL STEP dir 3           ; ROM: drive 3 tiles in direction dir
        JNE @STATUS OK stuck      ; blocked, hazard, low power...
        ADD dir 1                 ; turn right: NORTH -> EAST -> ...
        JLT dir 4 side            ; fewer than 4 sides: next side
        END 1                     ; result 1: square done
stuck:  END 0                     ; result 0: something was in the way
`;

/** Program 1b (M14): the same square through the drive's ports: what CALL STEP really does. */
export const PROGRAM_DRIVE_YOURSELF = `; DRIVE YOURSELF: the same 3×3 square as First steps, but talking
; to the drive directly instead of calling the ROM.
;
; Learn: devices and ports, WAIT, what CALL STEP really does.
;
; The CPU cannot drive: it writes numbers into the drive's ports and
; the drive does the work. @DRIVE_N says how far; writing a direction
; to @DRIVE starts it, and @STATUS says at once whether it was
; accepted (ERR_BUSY, ERR_DEPLOYED, ERR_BLOCKED...). WAIT @DRIVE
; sleeps until the drive is idle (the CPU just waits, for free), then
; @STATUS says how the drive ended. Reference → ROM shows the ROM's
; STEP: the same instructions.
; Try: sweep the radar while the wheels turn: MOV @RADAR dir, then
; WAIT @RADAR and read @RADAR_HIT, before the WAIT @DRIVE.

ALIAS r0 dir

        MOV @DRIVE_N 3            ; how far: the drive remembers it
side:   MOV @DRIVE dir            ; which way: writing it starts the drive
        JNE @STATUS OK stuck      ; refused? (busy, array open, wall ahead)
        WAIT @DRIVE               ; sleep until the drive is idle...
        JNE @STATUS OK stuck      ; ...then @STATUS says how it ended
        ADD dir 1
        JLT dir 4 side
        END 1
stuck:  END 0
`;

/** Program 2: wander forever. */
export const PROGRAM_EXPLORER = `; EXPLORER: wander, turn right at obstacles, report acid vents.
;
; Learn: the radar (CALL SCAN), tile constants, MOD to wrap a counter,
; telling @STATUS errors apart, LOG frames for mission control.
;
; CALL SCAN dir sweeps the radar; the first thing in that direction
; waits in @RADAR_HIT (NONE if nothing within range) and its distance
; in @RADAR_DIST; it works day and night. Items (samples, kits) are
; driven over, not around.
; Driving onto an ACID_VENT costs 10 hull and ends the drive with
; ERR_HAZARD; this program then logs the vent's position (Comms:
; "T_VENT_X", "T_VENT_Y"). The program never ENDs: between slices the
; firmware charges the battery, then the program goes on where it was.
; Try: turn left instead; pick the turn from @TICK MOD 2 (random-ish).

CONST T_VENT_X 2            ; log tags (0–14): your names in the Comms tab
CONST T_VENT_Y 3

ALIAS r0 dir        ; heading 0–3
ALIAS r1 seen       ; tile type the radar found
ALIAS r2 dist       ; distance to it

loop:   CALL SCAN dir
        MOV seen @RADAR_HIT
        MOV dist @RADAR_DIST
        JEQ seen NONE go          ; nothing ahead
        JGT dist 1 go             ; something ahead, but not adjacent
        JEQ seen SAMPLE go        ; items are driven over
        JEQ seen REPAIR_KIT go
turn:   ADD dir 1                 ; turn right: dir = (dir + 1) mod 4
        MOD dir 4
        JMP loop
go:     CALL STEP dir 1
        JEQ @STATUS OK loop
        JNE @STATUS ERR_HAZARD turn ; blocked: something moved in
        LOG T_VENT_X @X           ; on an acid vent: tell mission control
        LOG T_VENT_Y @Y
        JMP turn                  ; and leave it
`;

/** Program 3: the camera (SNAP and SEND). */
export const PROGRAM_PHOTOGRAPHER = `; PHOTOGRAPHER: photograph all four directions, send the photos
; home, END with how many were sent.
;
; Learn: CALL SNAP and CALL SEND, aiming the headlight with @HEADING,
; waiting for space in the science recorder (@REC_FREE).
;
; CALL SNAP dir mode takes a photo of the first thing within 2 tiles in
; that direction (or the landscape) into image memory; SEND copies it into
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
        CALL SNAP dir 1           ; mode 1: 32×32 grey, into image memory
        JNE @STATUS OK next       ; ERR_LOW_POWER...: skip this one
room:   JGE @REC_FREE PHOTO_BYTES keep
        CALL SLEEP 10             ; recorder full: let the downlink empty it
        JMP room
keep:   CALL SEND 0               ; image memory -> science recorder
        ADD sent 1
next:   ADD dir 1
        JLT dir 4 shot
        END sent                  ; result: photos sent (0–4)
`;

/** Program 4: tools, cargo and a subroutine. */
export const PROGRAM_PROSPECTOR = `; PROSPECTOR: wander; mine ore veins and pick up samples next to
; the rover, analyze them and send the spectra home.
;
; Learn: tools (CALL ACT TOOL_n arg), cargo ([CARGO+slot]), a
; subroutine of your own (CALL / RET).
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

loop:   CALL SCAN dir
        MOV seen @RADAR_HIT
        MOV dist @RADAR_DIST
        JGT dist 1 go             ; target not adjacent yet
        JEQ seen IRON_ORE mine
        JEQ seen SILICON_ORE mine
        JEQ seen SAMPLE grab
        JEQ seen NONE go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
mine:   CALL ACT TOOL_0 dir       ; drill: 8 ticks, ore into cargo
        JMP done
grab:   CALL ACT TOOL_1 dir       ; grabber: 2 ticks, item into cargo
done:   CALL lab
        JMP loop
go:     CALL STEP dir 1
        JEQ @STATUS OK loop
        JMP turn

; lab: analyze everything in cargo. Changes seen and slot.
lab:    MOV slot 0
item:   LDB seen [CARGO+slot]     ; item in the slot, 0 = empty
        JEQ seen 0 skip           ; empty slot: nothing to analyze
        CALL ACT TOOL_2 slot      ; spectrometer: spectrum to the recorder
skip:   ADD slot 1
        JLT slot 4 item           ; Mk-I has 4 cargo slots (0–3)
        RET
`;

/** Program 5: cargo and repairs. */
export const PROGRAM_FIELD_REPAIR = `; FIELD REPAIR: repair worn systems with what is in cargo, END
; with the number of repairs.
;
; Learn: CALL USE slot system, nested loops, choosing a port with jumps.
;
; Systems: SYS_HULL (0), SYS_SOLAR (1), SYS_ANTENNA (2), with health
; in @HULL, @SOLAR_HEALTH, @ANTENNA_HEALTH (0–100). A repair takes 10
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
try:    LDB value [CARGO+slot]    ; the health is not needed any more
        JEQ value 0 nextslot      ; empty slot
        CALL USE slot sys
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
        CALL ACT TOOL_1 NORTH     ; there: grab = install
        JNE @STATUS OK loop
        END 1
nocrate: END 0
go:     CALL STEP dir 1
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
; The stack holds 16 numbers: every CALL argument must be POPped.
; Each corner arrives in the Comms tab as "T_X = ..." and "T_Y = ...".
; At the end BRK halts the program and the rover sends its registers
; home (Comms: a DUMP "sent by BRK"); press Continue to END.
; Try: stop early when the radar sees a SAMPLE; spiral the other way.

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
        CALL STEP r2 r3           ; blocked? it just stops early
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
; CALL ACT TOOL_3 dir (4 ticks) hears the nearest ore vein up to 12 tiles
; away in dir, even through walls: @SEISMIC_DIST = distance, 0 = none.
; Without the upgrade the hardpoint is empty: ERR_NO_TOOL.
; END 1 = mined, 0 = no scanner, 2 = no ore in range, 3 = blocked on
; the way (the scanner hears through walls, the rover cannot drive).
; Try: when blocked, scan again from where the rover stopped.

ALIAS r0 dir
ALIAS r1 best       ; direction of the nearest vein so far
ALIAS r2 near       ; its distance (99 = none yet)

        MOV near 99
listen: CALL ACT TOOL_3 dir
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
        CALL STEP best near
drill:  CALL ACT TOOL_0 best      ; ore into cargo
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
; Learn: CALL SLEEP for timing, @TICK, DIV, the alert ports.
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
calm:   CALL SLEEP 100
        JMP loop
`;

/** Program 10 (M14): constant data in Flash and a variable in RAM. */
export const PROGRAM_ROUTE = `; ROUTE: drive a route stored in Flash, then report how many legs
; worked.
;
; Learn: constant data in Flash (DATA, LDF), a variable in RAM (VAR,
; LDB, STB), addresses in brackets.
;
; DATA puts bytes into Flash; the assembler moves them after the code,
; so the program never runs into them. LDF reads one byte: route is the
; address of the first one, [route+i] the address of entry i. The route
; is pairs (direction, tiles) and ends with STOP. VAR reserves RAM and
; names its address: good is one byte that counts the legs that worked.
; RAM is shared with the firmware and is zero after a reboot.
; Try: add legs; LOG the number of a leg that failed; drive it backwards.

CONST T_LEGS 2              ; log tag
CONST STOP 255              ; end of the route

VAR good                    ; legs driven without a problem (1 byte of RAM)

ALIAS r0 i          ; index into the route
ALIAS r1 dir
ALIAS r2 tiles
ALIAS r3 n

        STB [good] 0              ; start counting from 0
next:   LDF dir [route+i]         ; read the route from Flash
        JEQ dir STOP done
        LDF tiles [route+i+1]
        CALL STEP dir tiles
        ADD i 2                   ; next pair
        JNE @STATUS OK next       ; blocked: try the next leg
        LDB n [good]              ; good = good + 1: load, add, store
        ADD n 1
        STB [good] n
        JMP next
done:   LDB n [good]
        LOG T_LEGS n
        END n

route:  DATA EAST 3, NORTH 2, WEST 3, SOUTH 2, STOP
`;

/**
 * Image memory examples (M12, SPEC §3.8.7): the six worked examples of docs/IMAGE_MEMORY.md,
 * word for word (a test keeps them identical). Programs: they END, except the memory map.
 */
export const IMAGE_LINE = `; LINE: your first picture. Clear image memory to black, draw a
; white line across the middle and send it home as a photo.

ALIAS r0 addr

        CALL ERASE            ; every byte 0 = 00 00 00 00 = four black pixels
        MOV addr 128          ; row 16 starts at byte 16 × 8 = 128
line:   STB [IMG+addr] 0xFF   ; 0xFF = 11 11 11 11 = four white pixels
        ADD addr 1
        JLT addr 136 line     ; one row = 8 bytes = 32 pixels
        CALL SEND 1           ; decode as a 32×32 grey photo
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
        STB [IMG+addr] grey
        ADD addr 1
        JLT addr 256 fill
        CALL SEND 1
        END 1
`;

export const IMAGE_NEGATIVE = `; NEGATIVE: take a photo, turn it into a negative, send it.
; 255 − byte flips every pixel in the byte (0↔3, 1↔2).

ALIAS r0 addr
ALIAS r1 byte

        CALL SNAP NORTH 1     ; into image memory: nothing is sent yet
        JNE @STATUS OK fail   ; ERR_LOW_POWER, ERR_INVALID...
        MOV addr 0
inv:    LDB byte [IMG+addr]   ; read
        MUL byte -1
        ADD byte 255          ; byte = 255 − byte
        STB [IMG+addr] byte   ; write back
        ADD addr 1
        JLT addr 256 inv
        CALL SEND 0           ; same format as the SNAP (mode 1)
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

        CALL SNAP NORTH 1
        JNE @STATUS OK fail
        MOV addr 0
        MOV value @X
        CALL put16
        MOV value @Y
        CALL put16
        CALL SEND 0
        END 1
fail:   END 0

; put16: write value as two bytes (high, low) at addr; addr += 2
put16:  MOV low value
        AND low 0xFF          ; keep bits 7–0: the low byte
        SHR value 8           ; bits 15–8 move down to 7–0
        AND value 0xFF        ; the high byte: −300 → FE D4
        STB [IMG+addr] value
        ADD addr 1
        STB [IMG+addr] low
        ADD addr 1
        RET
`;

export const IMAGE_PLOT = `; PLOT: draw single pixels. Takes a photo and draws a white
; diagonal from the top-left corner to the bottom-right one.
; The plot routine works for any 2-bpp picture (modes 1 and 2).

        CALL SNAP NORTH 1
        JNE @STATUS OK fail
        MOV r0 0
diag:   MOV r1 r0             ; y = x
        MOV r2 3              ; colour 3 = white
        CALL plot
        ADD r0 1
        JLT r0 32 diag
        CALL SEND 0
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
        LDB r3 [IMG+r1]       ; the byte
        OR r3 r0              ; set the pixel's bits...
        SUB r3 r0             ; ...and take them away: now 00
        OR r3 r2              ; put the new colour in
        STB [IMG+r1] r3
        POP r0
        RET
`;

export const IMAGE_MEMORY_MAP = `; MEMORY MAP: Explorer that remembers where it has been. Image
; memory is used as a big scratch RAM (the rover's real RAM has only
; 64 B): one byte per tile counts the visits,
; a 16×16 map that repeats every 16 tiles. Back on a known tile, the
; rover turns by the number of earlier visits, so it leaves a loop
; differently every time instead of circling forever.
; Do not take photos in this program: one would overwrite the map.

ALIAS r0 dir
ALIAS r1 seen
ALIAS r2 dist
ALIAS r3 cell

        CALL ERASE            ; forget the old map: image memory keeps
                              ; its contents through reboots
loop:   CALL SCAN dir
        MOV seen @RADAR_HIT
        MOV dist @RADAR_DIST
        JEQ seen NONE go
        JGT dist 1 go
turn:   ADD dir 1
        MOD dir 4
        JMP loop
go:     CALL STEP dir 1
        JNE @STATUS OK turn
        MOV cell @Y
        MOD cell 16           ; map row 0–15 (also for negative @Y)
        MUL cell 16
        MOV seen @X
        MOD seen 16           ; map column 0–15
        ADD cell seen         ; byte address 0–255
        LDB seen [IMG+cell]   ; earlier visits
        ADD dir seen          ; known tile: turn by that many quarters
        MOD dir 4
        ADD seen 1
        STB [IMG+cell] seen   ; one more visit (wraps at 256)
        JMP loop
`;

/** Program templates (M10): the Code tab's Program slot offers these. */
export const PROGRAM_TEMPLATES: Record<string, string> = {
  'First steps': PROGRAM_FIRST_STEPS,
  'Drive yourself': PROGRAM_DRIVE_YOURSELF,
  Explorer: PROGRAM_EXPLORER,
  Photographer: PROGRAM_PHOTOGRAPHER,
  Prospector: PROGRAM_PROSPECTOR,
  'Field repair': PROGRAM_FIELD_REPAIR,
  'Fetch supply crate': PROGRAM_FETCH,
  Spiral: PROGRAM_SPIRAL,
  'Seismic survey': PROGRAM_SEISMIC,
  'Weather station': PROGRAM_WEATHER,
  Route: PROGRAM_ROUTE,
  'Image: Line': IMAGE_LINE,
  'Image: Test pattern': IMAGE_TEST_PATTERN,
  'Image: Negative': IMAGE_NEGATIVE,
  'Image: Stamp': IMAGE_STAMP,
  'Image: Plot': IMAGE_PLOT,
  'Image: Memory map': IMAGE_MEMORY_MAP,
};

/**
 * Firmware examples (M10, Code tab Firmware slot): the default firmware, its fault
 * protection variant, then the pre-M10 all-in-one firmwares, which do everything themselves and never call a program.
 */
export const FIRMWARE_TEMPLATES: Record<string, string> = {
  'Default firmware': DEFAULT_FIRMWARE,
  'Fault protection': FIRMWARE_FAULT_PROTECTION,
  'All-in-one Explorer (no program)': DEMO_EXPLORER,
  'All-in-one Prospector (no program)': PROSPECTOR,
  'All-in-one Fetch (no program)': FETCH_SUPPLY,
};
