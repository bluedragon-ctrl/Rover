import { describe, expect, it } from 'vitest';
import { cpuHtml, DEVICES, devicesHtml, memoryMapHtml } from '../src/ui/ReferencePanel';
import { PORTS } from '../src/core/ports';
import { ROM_ENTRIES } from '../src/core/rom';
import { CHASSIS_MK1, MEMORY_MAP } from '../src/core/balance';
import { ROM_BASE } from '../src/core/vm/isa';
import { romCompile } from '../src/core/vm/Compiler';

/** M14 slice 4: Reference sections CPU, Devices and Memory map (docs/ASSEMBLER_CORE.md §11). */
describe('Reference: CPU, Devices, Memory map', () => {
  // The device start ports: the ports whose write goes to SimulationEngine.device() (DevicePort).
  const starts = ['TIMER', 'DRIVE', 'RADAR', 'TOOL', 'REPAIR', 'CAM', 'SEND', 'ERASE'];

  it('lists every device once, with ports that exist and a ROM driver', () => {
    expect(DEVICES.map((d) => d.start).sort()).toEqual([...starts].sort());
    const names = new Set(PORTS.map((p) => p.name));
    for (const d of DEVICES) {
      for (const p of [d.start, ...d.params]) expect(names.has(p), p).toBe(true);
      expect(ROM_ENTRIES as readonly string[]).toContain(d.rom);
    }
    const html = devicesHtml();
    for (const d of DEVICES) expect(html).toContain(`<code>@${d.start}</code>`);
    expect(html).toContain('CALL STEP dir tiles');
  });

  it('CPU takes its numbers from the Mk-I chassis', () => {
    const html = cpuHtml();
    expect(html).toContain(`${CHASSIS_MK1.cyclesPerTick} per tick`);
    expect(html).toContain(`${CHASSIS_MK1.dataStack} numbers per slot`);
    expect(html).toContain(`${CHASSIS_MK1.callStack} return addresses`);
    expect(html).toContain('Machine code');
  });

  it('Memory map gives the real address ranges', () => {
    const html = memoryMapHtml();
    expect(html).toContain(`0x${(MEMORY_MAP.RAM + CHASSIS_MK1.ramBytes - 1).toString(16).toUpperCase().padStart(3, '0')}`);
    expect(html).toContain('0x1FF'); // image memory end on Mk-I (256 B)
    expect(html).toContain('0x603'); // 4 cargo slots
    expect(html).toContain('up to 256 B'); // RAM upgrades
    expect(html).toContain('up to 1024 B'); // Flash upgrades
    const end = (ROM_BASE + romCompile().flashUsed - 1).toString(16).toUpperCase();
    expect(html).toContain(`0x${end}`);
  });
});
