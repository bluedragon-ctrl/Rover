import { describe, expect, it } from 'vitest';
import { BUS_ERROR, Cpu, PSW, SimpleMachine, assemble, type Bus } from '../../src/blue11';
import { o, runAsm } from './helpers';

/** Run a snippet followed by HALT; return the CPU. */
const run = (body: string, opts = {}) => runAsm(`${body}\n HALT\n`, opts).cpu;
const flags = (c: Cpu): string => `${c.n ? 'N' : '-'}${c.z ? 'Z' : '-'}${c.v ? 'V' : '-'}${c.c ? 'C' : '-'}`;

describe('blue11 CPU: data movement and addressing modes', () => {
  it('MOV with every addressing mode', () => {
    const { cpu: c, asm } = runAsm(`
        MOV #TAB, R1
        MOV (R1), R2          ; mode 1: 11
        MOV (R1)+, R3         ; mode 2: 11, R1 -> TAB+2
        MOV @(R1)+, R4        ; mode 3: word at PTR = 33
        MOV -(R1), R5         ; mode 4: back to PTR: R5 = address of TAB+4
        MOV 2(R1), R0         ; mode 6: word after PTR
        HALT
TAB:    .WORD 11, PTR, 0, 22
PTR:    .WORD 33`);
    expect(c.r[2]).toBe(o('11'));
    expect(c.r[3]).toBe(o('11'));
    expect(c.r[4]).toBe(o('33'));
    expect(c.r[5]).toBe(asm.symbols.get('PTR'));
    expect(c.r[0]).toBe(0);
  });

  it('deferred modes 5 and 7, relative and absolute', () => {
    const c = run(`
        MOV #END, R1
        MOV @-(R1), R2        ; R1 = END-2 (holds PTR), R2 = word at PTR
        MOV #TAB, R3
        MOV @2(R3), R4        ; word at TAB+2 is PTR -> 33
        MOV VAL, R5           ; relative
        MOV @#VAL, R0         ; absolute
        HALT
TAB:    .WORD 0, PTR
PTR:    .WORD 33
VAL:    .WORD 1234
        .WORD PTR
END:`);
    expect(c.r[2]).toBe(o('33'));
    expect(c.r[4]).toBe(o('33'));
    expect(c.r[5]).toBe(o('1234'));
    expect(c.r[0]).toBe(o('1234'));
  });

  it('MOVB into a register sign-extends; CLRB / BISB keep the high byte', () => {
    const c = run(`
        MOVB #200, R0
        MOV #177777, R1
        CLRB R1
        MOV #1000, R2
        BISB #7, R2`);
    expect(c.r[0]).toBe(0o177600);
    expect(c.r[1]).toBe(0o177400);
    expect(c.r[2]).toBe(0o1007);
  });

  it('byte autoincrement steps by 1, except on SP and PC', () => {
    const c = run(`
        MOV #S, R1
        MOVB (R1)+, R2
        MOVB (R1)+, R3
        HALT
S:      .BYTE 101, 102`);
    expect(c.r[2]).toBe(0o101);
    expect(c.r[3]).toBe(0o102);
  });

  it('push and pop through SP, JSR / RTS', () => {
    const c = run(`
        MOV #5, R0
        JSR PC, DOUBLE
        MOV R0, R1
        MOV #3, -(SP)
        MOV (SP)+, R2
        HALT
DOUBLE: ASL R0
        RTS PC`);
    expect(c.r[1]).toBe(10);
    expect(c.r[2]).toBe(3);
    expect(c.r[6]).toBe(0o1000);
  });

  it('JSR R5 with inline arguments', () => {
    const c = run(`
        JSR R5, ADD2
        .WORD 7, 12
        MOV R0, R1
        HALT
ADD2:   MOV (R5)+, R0
        ADD (R5)+, R0
        RTS R5`);
    expect(c.r[1]).toBe(0o21);
  });

  it('SOB loops', () => {
    const c = run(`
        MOV #10., R3
        CLR R0
1$:     ADD #2, R0
        SOB R3, 1$`);
    expect(c.r[0]).toBe(20);
    expect(c.r[3]).toBe(0);
  });
});

describe('blue11 CPU: flags', () => {
  it('ADD sets V on signed overflow and C on carry', () => {
    expect(flags(run('MOV #77777, R0\n ADD #1, R0'))).toBe('N-V-');
    expect(flags(run('MOV #177777, R0\n ADD #1, R0'))).toBe('-Z-C');
  });

  it('SUB / CMP borrow and overflow', () => {
    expect(flags(run('MOV #1, R0\n SUB #2, R0'))).toBe('N--C');
    expect(flags(run('MOV #100000, R0\n SUB #1, R0'))).toBe('--V-');
    expect(flags(run('CMP #1, #2'))).toBe('N--C');
    expect(flags(run('CMP #2, #2'))).toBe('-Z--');
    expect(flags(run('CMP #100000, #1'))).toBe('--V-'); // −32768 − 1 overflows
  });

  it('INC / DEC leave C alone; NEG sets C unless zero', () => {
    expect(flags(run('SEC\n MOV #77777, R0\n INC R0'))).toBe('N-VC');
    expect(flags(run('CLC\n MOV #100000, R0\n DEC R0'))).toBe('--V-');
    expect(flags(run('MOV #5, R0\n NEG R0'))).toBe('N--C');
    expect(flags(run('CLR R0\n NEG R0'))).toBe('-Z--');
  });

  it('MOV clears V and keeps C (the "flags belong to the last instruction" lesson)', () => {
    const c = run(`
        CMP #1, #12          ; 1 < 10: N set
        MOV #1, R1           ; MOV overwrites N and Z
        CLR R2
        BLT 1$
        INC R2
1$:     NOP`);
    expect(c.r[2]).toBe(1); // BLT was not taken
  });

  it('shifts and rotates through C', () => {
    const c = run(`
        MOV #100001, R0
        ASR R0                ; 140000, C=1
        MOV R0, R1
        CLC
        MOV #100000, R2
        ROL R2                ; 0, C=1
        ROL R2                ; 1, C=0
        MOV #1, R3
        SEC
        ROR R3                ; 100000, C=1`);
    expect(c.r[1]).toBe(0o140000);
    expect(c.r[2]).toBe(1);
    expect(c.r[3]).toBe(0o100000);
    expect(c.c).toBe(true);
  });

  it('SWAB, SXT, XOR, ADC, SBC, COM', () => {
    const c = run(`
        MOV #001377, R0
        SWAB R0               ; 177402
        SEN
        SXT R1                ; 177777
        MOV #170017, R2
        XOR R2, R1            ; 007760
        MOV #177777, R3
        SEC
        ADC R3                ; 0, C=1
        MOV #0, R4
        SBC R4                ; 177777, C=1
        COM R5`);
    expect(c.r[0]).toBe(0o177402);
    expect(c.r[1]).toBe(0o007760);
    expect(c.r[3]).toBe(0);
    expect(c.r[4]).toBe(0o177777);
    expect(c.r[5]).toBe(0o177777);
    expect(c.c).toBe(true);
  });

  it('signed and unsigned branches', () => {
    const c = run(`
        CLR R0
        CMP #177777, #1       ; -1 vs 1
        BLT 1$                ; signed: taken
        BIS #1, R0
1$:     CMP #177777, #1
        BHI 2$                ; unsigned 177777 > 1: taken
        BIS #2, R0
2$:     CMP #1, #1
        BGT 3$                ; not taken
        BIS #4, R0
3$:     NOP`);
    expect(c.r[0]).toBe(4);
  });

  it('flag instructions', () => {
    expect(flags(run('SCC'))).toBe('NZVC');
    expect(flags(run('SCC\n CLZ\n CLV'))).toBe('N--C');
  });
});

describe('blue11 CPU: cycles per bus access (BLUE11_CPU.md §4)', () => {
  const cost = (line: string, opts = {}): number => {
    const a = assemble(`${line}\nCOUNT: .WORD 0\nVAL: .WORD 0`, { origin: 0o1000 });
    expect(a.errors).toEqual([]);
    const m = new SimpleMachine(opts);
    m.boot(a);
    m.cpu.r[1] = 0o2000;
    m.cpu.r[2] = 0o2100;
    return m.cpu.step().cycles;
  };

  it('matches the table', () => {
    expect(cost('MOV R1, R2')).toBe(1);
    expect(cost('MOV #5, R0')).toBe(2);
    expect(cost('MOVB (R1)+, (R2)+')).toBe(3);
    expect(cost('INC @#COUNT')).toBe(4);
    expect(cost('CMP @#VAL, #20.')).toBe(4);
    expect(cost('BR .+2')).toBe(1);
    expect(cost('JSR PC, VAL')).toBe(3);
  });

  it('flat model: 1 per instruction', () => {
    expect(cost('INC @#COUNT', { cycles: 'flat' })).toBe(1);
  });

  it('RTS costs 2, RTI 3, a trap entry 4', () => {
    const a = assemble(' JSR PC, SUB\n HALT\nSUB: RTS PC');
    const m = new SimpleMachine();
    m.boot(a);
    m.cpu.step();
    expect(m.cpu.step().cycles).toBe(2);
    const b = assemble(' MOV #H, @#14\n BPT\n HALT\nH: RTI');
    m.boot(b);
    m.cpu.step();
    expect(m.cpu.step().cycles).toBe(1 + 4); // BPT fetch + entry
    expect(m.cpu.step().cycles).toBe(3);
  });

  it('EIS adds a fixed internal cost', () => {
    expect(cost('MUL R1, R2', { eis: true })).toBe(1 + 4);
    expect(cost('DIV R1, R2', { eis: true })).toBe(1 + 8);
  });
});

describe('blue11 CPU: traps', () => {
  it('odd address and missing memory trap to 4 with the PC of the instruction', () => {
    const { cpu, asm } = runAsm(`
        MOV #H, @#4
        MOV #340, @#6
        MOV #1001, R1
        MOV (R1), R0          ; odd word address
        HALT
H:      MOV (SP), R5          ; return address pushed by the trap
        HALT`);
    expect(cpu.r[5]).toBe(asm.symbols.get('H')! - 2); // PC after the faulting instruction
    expect(cpu.priority).toBe(7);
  });

  it('onTrap can stop instead of vectoring (the host handles it)', () => {
    const a = assemble(' MOV @#160000, R0\n HALT');
    const m = new SimpleMachine();
    m.boot(a);
    const seen: string[] = [];
    m.cpu.onTrap = (t) => { seen.push(t.cause); return 'stop'; };
    const r = m.run(100);
    expect(r.reason).toBe('trap');
    expect(r.trap).toMatchObject({ vector: 4, cause: 'bus-error', pc: 0o1000, detail: 0o160000 });
    expect(m.cpu.r[7]).toBe(0o1000);
    expect(seen).toEqual(['bus-error']);
  });

  it('TRAP n, EMT, BPT, IOT and illegal instructions use their vectors', () => {
    const { cpu } = runAsm(`
        MOV #HT, @#34
        MOV #HI, @#10
        CLR R1
        TRAP 7
        MUL R0, R2            ; no EIS: illegal
        HALT
HT:     INC R1
        RTI
HI:     ADD #10, R1
        RTI`);
    expect(cpu.r[1]).toBe(0o11);
  });

  it('a trap with no stack to push on is a double fault', () => {
    const { result, cpu } = runAsm(' MOV #157776, SP\n MOV #160001, SP\n MOV (R0), @#1\n HALT');
    expect(result.reason).toBe('double-fault');
    expect(cpu.halted).toBe(true);
  });

  it('stack limit traps a push below it', () => {
    const a = assemble(' MOV #1000, SP\n MOV R0, -(SP)\n HALT');
    const m = new SimpleMachine();
    m.boot(a);
    m.cpu.stackLimit = 0o1000;
    m.cpu.onTrap = () => 'stop';
    const r = m.run(100);
    expect(r.trap?.cause).toBe('stack-limit');
  });

  it('trace bit traps after each instruction', () => {
    const { cpu } = runAsm(`
        MOV #H, @#14
        CLR R1
        MOV #20, -(SP)        ; PSW with T
        MOV #GO, -(SP)
        RTT
GO:     NOP
        NOP
        HALT
H:      INC R1
        RTT                   ; RTI would trap again at once: that is why RTT exists
`);
    // RTT: no trap after it; then NOP, NOP, HALT... HALT stops before its trace trap.
    expect(cpu.r[1]).toBe(2);
  });

  it('PSW is on the bus at 177776; T cannot be set by a write', () => {
    const c = run('MOV #357, @#177776');
    expect(c.psw & 0o340).toBe(0o340);
    expect(c.psw & PSW.T).toBe(0);
  });
});

describe('blue11 CPU: interrupts, WAIT, HALT', () => {
  it('WAIT sleeps until an interrupt, which is taken by priority', () => {
    const { m, cpu, result } = runAsm(`
        MOV #CLK, @#100
        MOV #300, @#102
        MOV #100, @#177546    ; line clock interrupts on
        CLR R1
1$:     WAIT
        CMP R1, #3
        BLO 1$
        HALT
CLK:    INC R1
        RTI`, { clockCycles: 50 });
    expect(result.reason).toBe('halt');
    expect(cpu.r[1]).toBe(3);
    expect(m.cycles).toBeGreaterThanOrEqual(150);
  });

  it('a request at or below the CPU priority waits', () => {
    const bus: Bus = { read: () => 0, write: () => true };
    const c = new Cpu(bus);
    c.psw = 0o200; // priority 4
    c.interrupt(0o60, 4);
    c.waiting = true;
    expect(c.run(10).reason).toBe('wait');
    c.interrupt(0o100, 6);
    const r = c.run(4);
    expect(r.cycles).toBe(4);
    expect(c.waiting).toBe(false);
  });

  it('HALT stops and stays stopped until cleared', () => {
    const { cpu, result } = runAsm(' HALT\n MOV #1, R0\n HALT');
    expect(result.reason).toBe('halt');
    expect(cpu.r[7]).toBe(0o1002);
    cpu.halted = false;
    const m2 = cpu.run(10);
    expect(m2.reason).toBe('halt');
    expect(cpu.r[0]).toBe(1);
  });

  it('onModeChange reports PSW mode bits changing (the host gate)', () => {
    const a = assemble(' MOV #140000, -(SP)\n MOV #U, -(SP)\n RTI\nU: HALT');
    const m = new SimpleMachine();
    m.boot(a);
    const changes: Array<[number, number]> = [];
    m.cpu.onModeChange = (n, old) => changes.push([n, old]);
    m.run(100);
    expect(changes).toEqual([[3, 0]]);
  });
});

describe('blue11 CPU: EIS', () => {
  const eis = { eis: true };
  it('MUL: 32-bit product in an even/odd pair, C if it needs 32 bits', () => {
    const c = run('MOV #1000., R0\n MUL #1000., R0', eis);
    expect((c.r[0] << 16) | c.r[1]).toBe(1000000);
    expect(c.c).toBe(true);
    const d = run('MOV #-3, R1\n MUL #5, R1', eis);
    expect(d.r[1]).toBe(0xffff - 14);
    expect(d.n).toBe(true);
  });

  it('DIV: quotient and remainder; V and C on divide by zero', () => {
    const c = run('CLR R0\n MOV #17., R1\n DIV #5, R0', eis);
    expect(c.r[0]).toBe(3);
    expect(c.r[1]).toBe(2);
    const z = run('CLR R0\n MOV #17., R1\n DIV #0, R0', eis);
    expect(z.v && z.c).toBe(true);
    expect(z.r[1]).toBe(17);
  });

  it('ASH and ASHC', () => {
    const c = run('MOV #3, R0\n ASH #4, R0\n MOV #-8., R1\n ASH #-2, R1\n MOV #1, R2\n CLR R3\n ASHC #-1, R2', eis);
    expect(c.r[0]).toBe(48);
    expect(c.r[1]).toBe(0xffff - 1);
    expect(c.r[2]).toBe(0);
    expect(c.r[3]).toBe(0o100000);
  });
});

describe('blue11 CPU: save / load and determinism', () => {
  it('save, load and continue == uninterrupted', () => {
    const src = `
        MOV #CLK, @#100
        MOV #300, @#102
        MOV #100, @#177546
        CLR R1
        CLR R2
1$:     ADD R1, R2
        INC R1
        CMP R1, #500.
        BNE 1$
        HALT
CLK:    INC R4
        RTI`;
    const a = assemble(src);
    const full = new SimpleMachine({ clockCycles: 37 });
    full.boot(a);
    full.run(100000);

    const m1 = new SimpleMachine({ clockCycles: 37 });
    m1.boot(a);
    m1.run(1234);
    const state = m1.cpu.save();
    const ram = m1.ram.slice();
    const json = JSON.parse(JSON.stringify(state));
    // Continue on the same machine from the saved state (devices kept).
    m1.cpu.reset();
    m1.cpu.load(json);
    m1.ram.set(ram);
    m1.run(100000);
    expect(m1.cpu.r).toEqual(full.cpu.r);
    expect(m1.cycles).toBe(full.cycles);
  });

  it('a bus that refuses writes faults (protection)', () => {
    const mem = new Uint16Array(32768);
    mem[0o1000 / 2] = 0o010037; // MOV R0, @#2000
    mem[0o1002 / 2] = 0o2000;
    const bus: Bus = {
      read: (a) => (a < 0o4000 ? (mem[a >> 1]) : BUS_ERROR),
      write: () => false,
    };
    const c = new Cpu(bus);
    c.r[7] = 0o1000;
    c.r[6] = 0o1000;
    c.onTrap = () => 'stop';
    expect(c.run(10).trap).toMatchObject({ cause: 'bus-error', detail: 0o2000 });
  });
});

describe('blue11 CPU: protectModes (user-mode rules of the original /45 model)', () => {
  // Enter user mode with RTI, then try to get out of it.
  const user = (body: string) => `
        MOV  #TRAP4, @#4
        MOV  #0, @#6            ; the handler runs in kernel mode, priority 0
        MOV  #170000, -(SP)     ; user mode
        MOV  #USER, -(SP)
        RTI
USER:   ${body}
        MOV  @#177776, R1       ; reading the PSW is allowed
        HALT
TRAP4:  MOV  #1, R5
        HALT`;

  it('a PSW write in user mode traps to 4; RTI cannot lower the mode or change the priority', () => {
    const w = runAsm(user('CLR @#177776'), { protectModes: true });
    expect(w.cpu.r[5]).toBe(1);
    const r = runAsm(user('MOV #340, -(SP)\n        MOV #1$, -(SP)\n        RTI\n1$:     NOP'), { protectModes: true });
    expect(r.cpu.r[5]).toBe(0);
    expect(r.cpu.r[1] >> 14).toBe(3); // still user
    expect((r.cpu.r[1] >> 5) & 7).toBe(0); // priority unchanged
  });

  it('without the option the CPU is a plain /40 model (no modes enforced)', () => {
    const r = runAsm(user('CLR @#177776'));
    expect(r.cpu.r[5]).toBe(0);
    expect(r.cpu.r[1]).toBe(0);
  });
});
