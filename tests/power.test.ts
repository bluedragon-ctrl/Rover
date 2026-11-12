import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { angleDiff, cos1000, Environment, signalStrength, sin1000, solarGain } from '../src/core/Environment';
import { DEMO_EXPLORER, FACTORY_IDLE } from '../src/core/programs';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, Status } from '../src/core/types';

const factory = { factory: true };

it('shipped firmware compiles', () => {
  const eng = new SimulationEngine({ seed: 1 });
  const u = eng.spawnUnit('t');
  for (const src of [FACTORY_IDLE, DEMO_EXPLORER]) expect(eng.compileFor(u, src).errors).toEqual([]);
});

describe('Environment', () => {
  it('has integer trig and angle helpers', () => {
    expect([sin1000(0), sin1000(90), sin1000(-90), cos1000(180)]).toEqual([0, 1000, -1000, -1000]);
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(90, 270)).toBe(180);
  });

  it('runs a day/night cycle with sunrise in the east and noon in the south', () => {
    const env = new Environment();
    let day = 0, night = 0;
    let noon = { elevation: -999, azimuth: 0 };
    for (let t = 0; t < BALANCE.dayTicks; t++) {
      const s = env.sun(t);
      if (s.elevation > 0) day++;
      else night++;
      if (s.elevation > noon.elevation) noon = s;
    }
    expect(day / BALANCE.dayTicks).toBeGreaterThan(0.45);
    expect(night / BALANCE.dayTicks).toBeGreaterThan(0.45);
    expect(noon.elevation).toBe(BALANCE.sunMaxElev);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(15);
    expect(env.sun(0).elevation).toBeGreaterThan(0); // game starts in the morning
  });

  it('signal and solar gain peak when aligned', () => {
    expect(signalStrength(100, 100)).toBe(100);
    expect(signalStrength(100, 133)).toBeGreaterThanOrEqual(45);
    expect(signalStrength(100, 133)).toBeLessThanOrEqual(55);
    expect(signalStrength(0, 180)).toBe(0);
    const sun = { azimuth: 180, elevation: 70, light: 94 };
    expect(solarGain(180, sun)).toBeGreaterThan(solarGain(240, sun));
    expect(solarGain(0, sun)).toBe(0);
  });
});

describe('solar array & motors', () => {
  it('deploys over time, slews, charges, and blocks STEP until stowed', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    eng.upload(u, 'MOV @SOLAR_OPEN 1\nMOV @SOLAR_ANGLE @SUN_AZIMUTH\nSTEP NORTH\nMOV r0 @STATUS\nSLEEP 1000', factory);
    u.energy = 50_000;
    eng.advanceTick(); // STEP refused, ends the tick
    eng.advanceTick();
    expect(u.vm.regs[0]).toBe(Status.ERR_DEPLOYED);
    for (let i = 0; i < 80; i++) eng.advanceTick();
    expect(u.solarDeployed).toBe(true);
    expect(u.solarAngle).toBe(u.solarTarget);
    expect(u.lastSolarGain).toBeGreaterThan(0);
    const e = u.energy;
    for (let i = 0; i < 50; i++) eng.advanceTick();
    expect(u.energy).toBeGreaterThan(e);
  });

  it('cold-boots from solar after a power-off if the array was deployed', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    eng.upload(u, FACTORY_IDLE, factory);
    for (let i = 0; i < 100; i++) eng.advanceTick();
    expect(u.solarDeployed).toBe(true);
    u.energy = 1;
    eng.advanceTick();
    eng.advanceTick();
    // Either already dead or about to be; drain until off.
    for (let i = 0; i < 5 && u.vm.state !== CpuState.POWER_OFF; i++) {
      u.energy = 0;
      eng.advanceTick();
    }
    u.energy = 0;
    (eng as unknown as { drain: (u: unknown, n: number) => void }).drain(u, 1);
    expect(u.vm.state).toBe(CpuState.POWER_OFF);
    let booted = false;
    for (let i = 0; i < 3000 && !booted; i++) {
      eng.advanceTick();
      booted = u.vm.state !== CpuState.POWER_OFF;
    }
    expect(booted).toBe(true);
    expect(u.batteryPercent).toBeGreaterThanOrEqual(BALANCE.coldBootPercent);
  });

  it('stays dead if the array was stowed', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    eng.upload(u, 'SLEEP 100', factory);
    u.energy = 3;
    for (let i = 0; i < 3000; i++) eng.advanceTick();
    expect(u.vm.state).toBe(CpuState.POWER_OFF);
  });
});

describe('comms', () => {
  it('TX needs signal; the factory firmware aligns the dish and transmits', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    eng.upload(u, 'MOV @TX_DATA 1\nMOV r0 @STATUS\nSLEEP 1000', factory);
    eng.advanceTick();
    expect(u.vm.regs[0]).toBe(Status.ERR_NO_SIGNAL);
    eng.upload(u, FACTORY_IDLE, factory);
    for (let i = 0; i < 300; i++) eng.advanceTick();
    expect(eng.signalOf(u)).toBeGreaterThan(90);
    expect(u.packetsSent).toBeGreaterThan(0);
  });

  it('upload cost scales inversely with signal and is rejected without enough energy', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    u.antennaAngle = eng.orbitAzimuth;
    const good = eng.uploadCost(u, 20);
    u.antennaAngle = (eng.orbitAzimuth + 180) % 360;
    const bad = eng.uploadCost(u, 20);
    expect(bad).toBe(good * 10);
    u.energy = eng.uploadCost(u, 1) - 1;
    const r = eng.upload(u, 'SLEEP 1');
    expect(r.rejected).toMatch(/battery/);
    u.antennaAngle = eng.orbitAzimuth;
    const ok = eng.upload(u, 'SLEEP 1');
    expect(ok.rejected).toBeUndefined();
    expect(ok.cost).toBe(eng.uploadCost(u, 1));
  });
});

describe('night & fog', () => {
  it('sensor range drops at night and the headlight restores part of it', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const u = eng.spawnUnit('t');
    eng.upload(u, 'SLEEP 10000', factory);
    while (eng.sun.elevation > 0) eng.advanceTick();
    expect(eng.sensorRange(u)).toBe(BALANCE.nightSensorRange);
    u.headlight = 1;
    expect(eng.sensorRange(u)).toBe(BALANCE.headlightSensorRange);
  });

  it('reveals fog around the rover and keeps explored chunks', () => {
    const eng = new SimulationEngine({ seed: 1 });
    eng.spawnUnit('t');
    expect(eng.world.isMapped(0, 0)).toBe(true);
    expect(eng.world.isMapped(6, 0)).toBe(true);
    expect(eng.world.isMapped(10, 0)).toBe(false);
    eng.world.now = 1e6;
    eng.world.evictStale(10);
    expect(eng.world.hasChunk(0, 0)).toBe(true);
    void Layer;
  });

  it('explorer drives off after replacing the factory firmware (panels deployed)', () => {
    const eng = new SimulationEngine({ seed: 12345 });
    const u = eng.spawnUnit('t');
    eng.upload(u, FACTORY_IDLE, factory);
    for (let i = 0; i < 300; i++) eng.advanceTick();
    expect(u.solarDeployed).toBe(true);
    expect(eng.upload(u, DEMO_EXPLORER).rejected).toBeUndefined();
    for (let i = 0; i < 300; i++) eng.advanceTick();
    expect(Math.abs(u.x) + Math.abs(u.y)).toBeGreaterThan(3);
  });

  it('explorer firmware survives several sols on its own', () => {
    const eng = new SimulationEngine({ seed: 12345 });
    const u = eng.spawnUnit('t');
    eng.upload(u, DEMO_EXPLORER, factory);
    let minBat = 100;
    const cells = new Set<string>();
    for (let i = 0; i < BALANCE.dayTicks * 3; i++) {
      eng.advanceTick();
      minBat = Math.min(minBat, u.batteryPercent);
      cells.add(`${u.x},${u.y}`);
    }
    expect(u.vm.state).not.toBe(CpuState.FAULT);
    expect(cells.size).toBeGreaterThan(50);
    expect(u.powered || u.solarDeployed).toBe(true);
    console.log(`explorer 3 sols: min battery ${minBat}%, end ${u.batteryPercent}%, ${cells.size} tiles visited, state ${u.vm.state}`);
  });
});
