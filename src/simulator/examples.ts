/**
 * Example programs for the standalone simulator (simulator.html). Each one is covered by
 * a test: it assembles and prints what `expect` says.
 */

/** Device register names the simulator predefines (DL11 console, KW11-L clock). */
export const SIM_SYMBOLS: Record<string, number> = {
  RCSR: 0o177560, RBUF: 0o177562, XCSR: 0o177564, XBUF: 0o177566, LKS: 0o177546, PSW: 0o177776,
};

export interface Example {
  name: string;
  source: string;
  /** Console output after running to HALT (tests). */
  expect: string;
  /** Characters typed on the console before running (tests). */
  input?: string;
  /** Needs the EIS option. */
  eis?: boolean;
}

const PUTC = `
; PUTC: print the character in R0 (waits until the terminal is ready).
PUTC:   TSTB @#XCSR             ; ready? (bit 7 = sign bit of the low byte)
        BPL  PUTC               ; not yet: test again
        MOVB R0, @#XBUF         ; send the character to the terminal
        RTS  PC                 ; back to the caller`;

const DIV16 = `
; DIV16: R0 = R0 / R1, R1 = remainder (unsigned). C = 1 if R1 was 0.
DIV16:  TST  R1                 ; dividing by 0?
        BNE  1$                 ; no: go on
        SEC                     ; yes: set C to say so...
        RTS  PC                 ; ...and return
1$:     MOV  R2, -(SP)          ; save R2 and R3 on the stack:
        MOV  R3, -(SP)          ;   the caller's values come back at the end
        MOV  R1, R2             ; R2 = divisor
        CLR  R1                 ; R1 = remainder, built bit by bit
        MOV  #16., R3           ; 16 quotient bits
2$:     ASL  R0                 ; next dividend bit out of R0...
        ROL  R1                 ;   ...into the remainder
        BCS  4$                 ; a 17th bit came out: surely big enough
        CMP  R1, R2             ; remainder >= divisor?
        BLO  3$                 ; no: this quotient bit is 0
4$:     SUB  R2, R1             ; take the divisor out of the remainder
        INC  R0                 ; quotient bit = 1
3$:     SOB  R3, 2$             ; R3 = R3 - 1; bits left: the next one
        MOV  (SP)+, R3          ; restore R3 and R2
        MOV  (SP)+, R2          ;   (the opposite order of saving)
        CLC                     ; C = 0: no error
        RTS  PC                 ; back to the caller`;

const PRDEC = `
; PRDEC: print R0 as an unsigned decimal number. Changes R0, R1.
PRDEC:  MOV  #10., R1            ; divide by ten
        JSR  PC, DIV16          ; R0 = R0 / 10, R1 = the last digit
        MOV  R1, -(SP)          ; keep the digit on the stack
        TST  R0                 ; any higher digits left?
        BEQ  1$                 ; no: print this one
        JSR  PC, PRDEC          ; print the higher digits first (recursion)
1$:     MOV  (SP)+, R0          ; take the digit back off the stack
        ADD  #'0, R0            ; digit -> character
        JMP  PUTC               ; PUTC returns for us`;

const MUL16 = `
; MUL16: R0 = R0 * R1 (low 16 bits). Changes R1.
MUL16:  MOV  R2, -(SP)          ; save R2
        CLR  R2                 ; running sum
1$:     TST  R1                 ; multiplier bits left?
        BEQ  3$                 ; no: done
        CLC                     ; C = 0, so ROR shifts a 0 in at the top
        ROR  R1                 ; lowest bit of the multiplier -> C
        BCC  2$                 ; bit 0: add nothing
        ADD  R0, R2             ; bit 1: add the shifted multiplicand
2$:     ASL  R0                 ; multiplicand * 2
        BR   1$                 ; the next bit
3$:     MOV  R2, R0             ; the answer in R0
        MOV  (SP)+, R2          ; restore R2
        RTS  PC                 ; back to the caller`;

const CRLF = `
; CRLF: start a new line. Changes R0.
CRLF:   MOV  #15, R0            ; carriage return (octal 15)
        JSR  PC, PUTC           ; print it
        MOV  #12, R0            ; line feed
        JMP  PUTC               ; print it; PUTC returns for us`;

export const EXAMPLES: Example[] = [
  {
    name: 'Hello, world',
    expect: 'HELLO, WORLD!\r\n',
    source: `; Hello, world: print a text, one character at a time, on the console.
; Learn: MOVB (R1)+ walks through bytes, TSTB/BPL waits for the terminal.
; Try:   step through it (Step) and watch R1 and the PC move.

        .TITLE  HELLO           ; the program's name (for the listing)
START:  MOV  #MSG, R1           ; R1 points at the text
1$:     MOVB (R1)+, R0          ; next character; the Z flag is set at the 0 byte
        BEQ  2$                 ; end of text
        JSR  PC, PUTC           ; print the character in R0
        BR   1$                 ; and the next one
2$:     HALT                    ; stop the CPU

MSG:    .ASCIZ  /HELLO, WORLD!/<15><12> ; the text, CR, LF and a 0 byte
        .EVEN                   ; code must start at an even address
${PUTC}
        .END START
`,
  },
  {
    name: 'Squares (multiply in software)',
    expect: '1 4 9 16 25 36 49 64 81 100 121 144 \r\n',
    source: `; Squares: print 1*1 ... 12*12. There is no multiply instruction without the
; EIS option: MUL16 shifts and adds, the way programs did it before hardware multiply.
; Learn: subroutines (JSR PC / RTS PC), the stack, decimal output by repeated division.
; Try:   turn on EIS and replace the JSR PC, MUL16 with MUL R0, R0 (watch the cycles).

START:  MOV  #1, R4             ; R4 = n
1$:     MOV  R4, R0             ; R0 = n...
        MOV  R4, R1             ; ...R1 = n
        JSR  PC, MUL16          ; R0 = n * n
        JSR  PC, PRDEC          ; print it in decimal
        MOV  #' , R0            ; a space
        JSR  PC, PUTC           ; print it
        INC  R4                 ; the next n
        CMP  R4, #12.           ; up to twelve
        BLOS 1$                 ; unsigned <=
        JSR  PC, CRLF           ; end the line
        HALT                    ; stop the CPU
${MUL16}
${PRDEC}
${DIV16}
${CRLF}
${PUTC}
        .END START
`,
  },
  {
    name: 'Fibonacci (carry flag)',
    expect: '1 1 2 3 5 8 13 21 34 55 89 144 233 377 610 987 1597 2584 4181 6765 10946 17711 28657 46368 \r\n',
    source: `; Fibonacci numbers until they no longer fit in 16 bits.
; Learn: ADD sets C when the result needs a 17th bit; BCS reacts to it.
; Try:   change BCS to BVS: signed overflow happens earlier (at 32768).

START:  MOV  #1, R2             ; a
        MOV  #1, R3             ; b
1$:     MOV  R2, R0             ; print a...
        JSR  PC, PRDEC          ; ...in decimal
        MOV  #' , R0            ; a space
        JSR  PC, PUTC           ; print it
        MOV  R2, R4             ; R4 = a...
        ADD  R3, R4             ; a + b
        BCS  2$                 ; carry: the next one doesn't fit
        MOV  R3, R2             ; a = b
        MOV  R4, R3             ; b = a + b
        BR   1$                 ; and the next number
2$:     MOV  R3, R0             ; print the last one that fits
        JSR  PC, PRDEC          ; in decimal
        MOV  #' , R0            ; a space
        JSR  PC, PUTC           ; print it
        JSR  PC, CRLF           ; end the line
        HALT                    ; stop the CPU
${PRDEC}
${DIV16}
${CRLF}
${PUTC}
        .END START
`,
  },
  {
    name: 'Line clock (interrupts, WAIT)',
    expect: '**********\r\n',
    source: `; Line clock: the KW11-L interrupts every tick (here every 1000 cycles).
; The handler counts ticks; the main loop sleeps in WAIT and prints a star
; every 10 ticks.
; Learn: vectors (100 = clock), PSW priority, RTI, sleeping instead of busy-waiting.
; Try:   remove the WAIT: the program still works, but burns every cycle.

START:  MOV  #CLOCK, @#100       ; vector: handler address...
        MOV  #300, @#102         ; ...and the PSW for it (priority 6)
        CLR  R4                  ; ticks
        CLR  R5                  ; stars printed
        MOV  #100, @#LKS         ; clock interrupts on (bit 6 = IE)
1$:     WAIT                     ; sleep until an interrupt
        CMP  R4, #10.            ; ten ticks yet?
        BLO  1$                  ; no: sleep again
        CLR  R4                  ; count the next ten from 0
        MOV  #'*, R0             ; a star
        JSR  PC, PUTC            ; print it
        INC  R5                  ; one more star
        CMP  R5, #10.            ; ten stars yet?
        BLO  1$                  ; no: sleep again
        CLR  @#LKS               ; clock off
        JSR  PC, CRLF            ; end the line
        HALT                     ; stop the CPU

CLOCK:  INC  R4                  ; runs once per tick, between two instructions
        RTI                      ; back to where the interrupt came in
${CRLF}
${PUTC}
        .END START
`,
  },
  {
    name: 'Echo (keyboard interrupt)',
    input: 'Hello.',
    expect: 'HELLO.',
    source: `; Echo: type in the console box; each key interrupts the program, which
; prints it back in upper case. A full stop ends the program.
; Learn: the receiver interrupt (vector 60), reading RBUF clears DONE, and
;        "check, then wait": the handler may already have run before the first
;        WAIT, so the loop tests R5 before sleeping (or it could sleep forever).
; Try:   echo the keys in lower case instead.

START:  MOV  #KEY, @#60           ; vector 60: the key handler...
        MOV  #200, @#62          ; priority 4
        CLR  R5                  ; set by the handler at '.'
        MOV  #100, @#RCSR        ; receiver interrupts on
1$:     TST  R5                  ; done? check first...
        BNE  2$                  ; yes: stop
        WAIT                     ; ...then sleep until the next key
        BR   1$                  ; and check again
2$:     HALT                     ; stop the CPU

KEY:    MOV  R0, -(SP)           ; a handler must keep every register it uses
        MOVB @#RBUF, R0          ; the key that was typed
        CMPB R0, #'a             ; below 'a'?
        BLO  1$                  ; yes: not a small letter
        CMPB R0, #'z             ; above 'z'?
        BHI  1$                  ; yes: not a small letter
        SUB  #40, R0             ; 'a' - 'A' = 40 octal
1$:     JSR  PC, PUTC            ; print it
        CMPB R0, #'.             ; a full stop?
        BNE  2$                  ; no: keep going
        INC  R5                  ; yes: tell the main loop to stop
2$:     MOV  (SP)+, R0           ; restore R0
        RTI                      ; back to the main loop
${PUTC}
        .END START
`,
  },
  {
    name: 'TRAP as a system call',
    expect: 'OK',
    source: `; TRAP n: a "system call". The CPU jumps through vector 34; the handler finds
; n in the low byte of the TRAP instruction, just before the return address.
; Learn: traps push PC and PSW; @(SP) style addressing; BIC to mask bits.
; Try:   add TRAP 2 that prints R0 as a decimal number.

START:  MOV  #SYSCAL, @#34        ; vector 34: the TRAP handler...
        MOV  #340, @#36          ; run the handler at priority 7
        MOV  #'O, R0             ; the letter O
        TRAP 0                   ; print R0
        MOV  #'K, R0             ; the letter K
        TRAP 0                   ; print R0
        TRAP 1                   ; stop
        HALT                     ; (never reached: TRAP 1 halts)

SYSCAL: MOV  R1, -(SP)           ; save R1
        MOV  2(SP), R1           ; the return address (pushed by the trap)
        MOV  -2(R1), R1          ; the TRAP instruction itself
        BIC  #177400, R1         ; keep n (the low byte)
        BNE  1$                  ; not 0: TRAP 1
        JSR  PC, PUTC            ; TRAP 0: print R0
        MOV  (SP)+, R1           ; restore R1
        RTI                      ; back after the TRAP
1$:     HALT                     ; TRAP 1: halt
${PUTC}
        .END START
`,
  },
  {
    name: 'Addressing modes tour',
    expect: '',
    source: `; The eight addressing modes, one per line. Step through and watch the
; registers and the memory view (TAB is at the address the listing shows).
; Learn: # is a value, @# is an address; (R)+ is C's *p++.

START:  MOV  #TAB, R1           ; immediate: R1 = address of TAB
        MOV  R1, R2             ; mode 0, register:        R2 = R1
        MOV  (R1), R3           ; mode 1, deferred:        R3 = TAB[0] (address of ONE)
        MOV  (R1)+, R3          ; mode 2, autoincrement:   the same, then R1 += 2
        MOV  @(R1)+, R3         ; mode 3, autoinc deferred: R3 = *TAB[1] = 7, R1 += 2
        MOV  -(R1), R4          ; mode 4, autodecrement:   R1 -= 2, R4 = TAB[1]
        MOV  @-(R1), R4         ; mode 5, autodec deferred: R1 -= 2, R4 = *TAB[0] = 1
        MOV  4(R2), R5          ; mode 6, index:           R5 = TAB[2] = 3
        MOV  @2(R2), R5         ; mode 7, index deferred:  R5 = *TAB[1] = 7
        MOV  ONE, R0            ; relative (PC + offset):  R0 = 1
        MOV  @#SEVEN, R0        ; absolute:                R0 = 7
        HALT                    ; stop the CPU

TAB:    .WORD ONE, SEVEN, 3     ; two pointers and a number
ONE:    .WORD 1                 ; a word holding 1
SEVEN:  .WORD 7                 ; a word holding 7
        .END START
`,
  },
];
