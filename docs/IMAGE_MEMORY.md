# Image memory: player guide **[M12]**

Status: **in the game** (M12). Rules in [`SPEC.md`](SPEC.md) §3.8.7, plan in
[`ROADMAP.md`](ROADMAP.md) M12. In the game, **Reference → Image** sums this guide up, and the
six examples are Code tab program templates (*Image: Line* … *Image: Memory map*), word for
word: a test keeps them identical to the code below. The tests also run all six examples
(`tests/image-memory.test.ts`): the pictures, byte values and Flash sizes below are checked
on every change. Cycle counts were measured on a prototype of the rules.

---

## 1. The idea

The camera no longer sends a photo by itself. Taking a picture, changing it and sending it
are three separate steps, and your program decides what happens in between:

```
            SNAP                     SEND
  camera ─────────► image memory ─────────► science recorder ──► downlink ──► Gallery
                     (256 bytes)             (waits to be sent)
                        ▲     │
                    STB │     │ LDB
                        └─ your program ─┘
```

* **`SNAP dir [mode]`** takes a picture into **image memory**. Nothing is sent yet.
* **`LDB`** reads one byte of image memory, **`STB`** writes one.
* **`SEND [type]`** copies image memory into the science recorder as a product. From
  there the downlink sends it home, as before.

Image memory is ordinary memory: you can also draw a picture into it from nothing, or use
it to remember things that have nothing to do with pictures (example 6).

Real rovers work the same way. Curiosity's cameras keep their images in the camera's own
memory; the rover then makes *products* from them (thumbnails, crops, compressed copies)
and only those products are sent to Earth.

## 2. Instructions

| Instruction | Cycles | What it does |
| :--- | :--- | :--- |
| `SNAP dir [mode]` | blocks 10 ticks, 200 energy | Photograph the subject in `dir` into image memory (overwrites all of it). Writes `@STATUS`. |
| `LDB dst addr` | 1 cycle | `dst` = byte at `addr` (always 0–255). |
| `STB addr src` | 1 cycle | Byte at `addr` = `src` (only the low 8 bits are kept: 256 → 0, −1 → 255). |
| `SEND [type]` | blocks 1 tick, 10 energy | Copy image memory into the recorder as a product of `type` (default: the mode of the last `SNAP`). Image memory is kept. Writes `@STATUS`: `ERR_FULL` (no room in the recorder), `ERR_INVALID` (bad type, or the type is bigger than image memory), `ERR_LOW_POWER`. |
| `ERASE` | blocks 2 ticks, 10 energy | Set every byte of image memory to 0 and forget the last `SNAP` (a `SEND` after it is a drawn picture). Writes `@STATUS`: `ERR_LOW_POWER`. |

`LDB` and `STB` are compute instructions like `MOV`: no energy, no `@STATUS`.

The **bit instructions** `AND`, `OR`, `SHL`, `SHR` (1 cycle each, compute) are made for
taking bytes apart (§3): `AND dst mask` keeps only the bits set in `mask`, `OR dst bits`
sets bits, `SHL dst n` / `SHR dst n` move all bits `n` places left / right (zeros come in;
`SHL 2` = × 4, `SHR 2` = / 4). Their opcode is 2 bytes (`1F 01` …), so each costs one
Flash byte more than `ADD`.

## 3. How a picture is stored

### Rows and addresses (camera modes 1 and 2: 32×32 grey)

The picture is stored row by row, top row first. Each pixel has 4 grey levels, so it needs
2 bits, and **one byte holds 4 pixels**. A row of 32 pixels is 8 bytes; the whole picture is
32 × 8 = **256 bytes**, addresses 0–255.

```
            x: 0–3    4–7    8–11  ...  28–31
row  0:  byte   0      1      2    ...    7
row  1:  byte   8      9     10    ...   15
  ...
row 31:  byte 248    249    250    ...  255
```

**address = y × 8 + x / 4** (division rounds down). Pixel (10, 3) is in byte
3 × 8 + 10 / 4 = 26.

### Inside a byte

The leftmost pixel sits in the top two bits:

```
bit:     7 6    5 4    3 2    1 0
       pixel 0 pixel 1 pixel 2 pixel 3      (x MOD 4 tells which)
weight:   64     16      4      1
```

A pixel's value is 0 = black, 1 = dark grey, 2 = light grey, 3 = white. The byte is
`pixel0 × 64 + pixel1 × 16 + pixel2 × 4 + pixel3`. Pixel (10, 3) is pixel 10 MOD 4 = 2 of
byte 26, weight 4.

Handy byte values:

| Byte | Binary | Pixels |
| :--- | :--- | :--- |
| `0` | `00 00 00 00` | four black |
| `85` = `0x55` | `01 01 01 01` | four dark grey |
| `170` = `0xAA` | `10 10 10 10` | four light grey |
| `255` = `0xFF` | `11 11 11 11` | four white |
| `192` = `0xC0` | `11 00 00 00` | white, then three black |
| `3` = `0x03` | `00 00 00 11` | three black, then white |

Pixel `k` of a byte (k = x AND 3) sits `shift = 6 − 2k` bits up: 6, 4, 2 or 0. With the
bit instructions:

| Task | Code | Example (byte `0xD8` = `11 01 10 00`, pixel 1) |
| :--- | :--- | :--- |
| byte address | `y SHL 3` + `x SHR 2` | (5, 2): 2 × 8 + 1 = 17 |
| read a pixel | `(byte SHR shift) AND 3` | `0xD8 SHR 4` = `1101`, `AND 3` = 1 |
| mask of a pixel | `3 SHL shift` | `3 SHL 4` = `00 11 00 00` |
| clear a pixel | `OR mask`, then `SUB mask` (there is no NOT) | `11 11 10 00` − `00 11 00 00` = `11 00 10 00` |
| set its colour | `OR (colour SHL shift)` | `OR 2 SHL 4` = `11 10 10 00` |

Without bit instructions the same works with arithmetic: read = `(byte / weight) MOD 4`,
change = `byte − old × weight + new × weight`; slower, but just as correct.

### Other camera modes (upgrades)

Image memory is as big as the largest picture your camera can take: 256 B on Mk-I, 512 B
with the *Colour filter wheel*, 1024 B with the *Hi-res* or *Colour sensor*.

| Mode | Picture | Pixels per byte | Bytes per row | Size | Pixel value |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1, 2 | 32×32 grey | 4 | 8 | 256 B | 0–3 grey |
| 3 | 32×32 colour | 2 | 16 | 512 B | 0–15, a colour of the planet palette (top 4 bits = left pixel) |
| 4 | 64×64 grey | 4 | 16 | 1024 B | 0–3 grey |
| 5 | 32×32 colour | 1 | 32 | 1024 B | bits `RRRGGGBB` (red 0–7, green 0–7, blue 0–3) |

In mode 5 one byte is one pixel: **address = y × 32 + x**, the easiest mode to draw in.

## 4. Things to know

* **Image memory keeps its contents** through reboots and even when the battery runs
  flat: like a real camera's flash memory. Only two things clear it: a new `SNAP`
  (overwrites it) and `ERASE`. A program that needs a blank picture starts with `ERASE`
  (example 1).
* **`SNAP` overwrites all of it.** Do not mix photos with data you want to keep.
* **Addresses wrap** around the memory size: on Mk-I, address 256 is byte 0 and −1 is
  byte 255. No error, so check your arithmetic.
* **`SEND` copies**: image memory is unchanged afterwards and can be sent again (only the
  first `SEND` after a `SNAP` earns credits).
* **`SEND type` only says how mission control decodes the bytes.** `SEND 1` on a drawing
  shows it as a 32×32 grey photo; sending a mode-3 colour picture as `SEND 1` shows noise.
* **Mission control sees what you did.** The product header says whether the picture is
  *raw* (sent as the camera took it), *edited* (changed with `STB` after the `SNAP`) or
  *drawn* (no camera picture behind it). The Gallery labels each photo.
* **Credits** come from what the camera saw, never from the bytes: the first `SEND` after a
  `SNAP`, with the same type as the `SNAP`'s mode, earns the photo credits (lit photo 1, +5
  the first time for a subject type), edited or not. An **edited** photo earns +5 more
  the first time in each camera mode (goal *Darkroom*: deliver your first one). Other
  `SEND`s earn nothing. Anomaly flags are checked against the real tile, so a painted
  fossil costs credits.
* **Speed.** The Mk-I CPU runs 4 cycles per tick. A loop that touches every byte costs
  about 6 cycles per byte: roughly **400 ticks** (a sixth of a sol) for a whole picture,
  three times longer than sending it (128 ticks at full signal). The firmware runs your
  program in time slices, so long loops just take several slices. *CPU overclock*
  upgrades make processing faster.
* **Flash.** Every example fits next to the default firmware (108 B free on Mk-I).
  Example 5 is the largest (95 B): delete a comfort block of the firmware if you want to
  add more to it.

## 5. Examples

Measured on Mk-I (4 cycles per tick). Ticks are CPU time only; `SNAP` adds 10 ticks, `SEND`
1 and `ERASE` 2.

| # | Example | Teaches | Flash | CPU time |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Line | rows, addresses, `ERASE` | 27 B | 28 cycles ≈ 7 ticks |
| 2 | Test pattern | grey levels, computing from the address | 34 B | 1795 cycles ≈ 450 ticks |
| 3 | Negative | `SNAP` → change → `SEND` | 41 B | 1541 cycles ≈ 390 ticks |
| 4 | Stamp | numbers as bytes (masks and shifts), negative numbers | 60 B | 27 cycles ≈ 7 ticks |
| 5 | Plot | single pixels inside a byte (bit instructions) | 95 B | 773 cycles ≈ 190 ticks |
| 6 | Memory map | image memory as plain RAM | 72 B | runs forever |

### Example 1: Line, your first picture

```
; LINE: your first picture. Clear image memory to black, draw a
; white line across the middle and send it home as a photo.

ALIAS r0 addr

        ERASE                 ; every byte 0 = 00 00 00 00 = four black pixels
        MOV addr 128          ; row 16 starts at byte 16 × 8 = 128
line:   STB addr 0xFF         ; 0xFF = 11 11 11 11 = four white pixels
        ADD addr 1
        JLT addr 136 line     ; one row = 8 bytes = 32 pixels
        SEND 1                ; decode as a 32×32 grey photo
        END 1
```

The Gallery shows a black square with one white line through the middle, labelled
*drawn*. Without the `ERASE` the line would be drawn over whatever image memory still
holds, for example your last photo. **Try:** clear it yourself with a loop of `STB`
instead of `ERASE` (256 bytes: how long does it take?); draw the line at the top (row 0)
or bottom (row 31); draw a thick line (rows 15–17); draw a border round the picture.

### Example 2: Test pattern, grey levels

```
; TEST PATTERN: four grey bars, like a camera test card.
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
```

Four vertical bars, black on the left to white on the right. The value of every byte is
computed from its address: `addr MOD 8` is the column of bytes, `addr / 8` would be the
row. **Try:** horizontal bars (use `addr / 64`); a checkerboard (add the row and the
column of bytes, then `MOD 2`).

### Example 3: Negative, change a real photo

```
; NEGATIVE: take a photo, turn it into a negative, send it.
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
```

The read → change → write loop is the heart of all image processing. The photo arrives
labelled *edited*, and still earns its credits: it is the first `SEND` after the `SNAP`.
In daylight it also completes the goal *Darkroom* and earns the first-edit bonus for
mode 1; try the other camera modes for their bonuses once you have the upgrades.
**Try:** brighten the photo (each pixel +1, but not above 3: use the recipe of §3, or a
cleverer byte trick); mirror it left to right.

### Example 4: Stamp, numbers as bytes

```
; STAMP: take a photo and write where it was taken into its first
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
```

At (5, −300) the first bytes are `00 05 FE D4`: 5, and −300 in 16-bit two's complement,
high byte first, the same way the radio sends numbers (Reference → Radio). `AND 0xFF`
keeps the lowest 8 bits; `SHR 8` moves the next 8 down. Because `SHR` fills with zeros, this
works for negative numbers too (without bit instructions: `MOD 256` for the low byte, then
subtract it and `DIV 256`). The top-left
corner of the photo shows them as a few odd pixels. **Try:** add `@TICK` (use 4 bytes:
call a `put16` for the high and the low half); stamp `@SUN_LIGHT` to see why a photo
came out dark.

### Example 5: Plot, single pixels

```
; PLOT: draw single pixels. Takes a photo and draws a white
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
```

`plot` is a reusable routine: copy it into your own programs. It follows the recipe of
§3: address, shift, mask, clear the old colour (`OR` then `SUB`, as there is no NOT), put
the new one in. With only four registers it saves `x` on the data stack; the caller sets
`y` again for every pixel. **Try:** draw the
other diagonal (y = 31 − x); a crosshair through the centre; your initials in a corner of
a photo; a filled square.

### Example 6: Memory map, image memory as RAM

```
; MEMORY MAP: Explorer that remembers where it has been. Image
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
```

The plain Explorer (turn right at obstacles) easily ends up driving the same circle
forever. In test rooms with scattered rocks it got stuck after 19–50 tiles; this version
kept going and covered 780–850 tiles in the same time. Memory turns a reflex into a
strategy. **Try:** send the map home with `SEND 1` and decode it in the Gallery's hex
view: byte `row × 16 + column` is the visit count of that tile. As a picture it looks
scrambled (one map row of 16 bytes fills two photo rows, and a count of 1 is a single
dark-grey pixel), so making it readable is a nice puzzle. Or remove the `ERASE`: image
memory keeps its contents through reboots and power loss, so the rover then remembers
its map even after a watchdog reboot or a flat battery.

## 6. Ideas for your own programs

* **Thumbnail:** shrink the photo to 16×16 in the top-left quarter (keep every second
  pixel of every second row), clear the rest.
* **Black and white:** every pixel 0–1 becomes 0, 2–3 becomes 3. Slow on Mk-I: a good
  reason for the overclock upgrade.
* **Is it worth sending?** Count the white pixels before `SEND`; skip dull photos to save
  recorder space and link time.
* **Postcard home:** draw a picture for mission control.
* **Fossil hunting:** fossils show best in mode 4 (64×64). Crop and enlarge the part of
  the picture around the subject before sending.

## 7. Background: the real techniques

* **Camera buffer, then products:** Curiosity's Mastcam, MAHLI and MARDI store images in
  their own flash; the rover makes thumbnails, crops and compressed versions from them, and
  the team asks for the full frame only when the thumbnail looks interesting.
* **Engineering data with the image:** spacecraft image formats carry time, pointing
  and camera settings in a header next to the pixels (example 4).
* **Test patterns and calibration targets:** cameras send known patterns to check the
  link and the sensor; Spirit and Opportunity carried a sundial reading "Two worlds, one
  sun" (example 2).
* **Onboard selection:** Spirit took sequences of images to look for dust devils and sent
  only the frames that showed one. Curiosity's AEGIS picks its own rock targets.
* **Processing level:** archives label data as raw or processed, so scientists always know
  what they are looking at (the *raw / edited / drawn* labels).
