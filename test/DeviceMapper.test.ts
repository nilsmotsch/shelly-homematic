import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressRegistry, CHANNEL_VALUE_MAPS, inferChannelKinds } from '../src/devices/DeviceMapper';

// --- ValueMapping ---

describe('CHANNEL_VALUE_MAPS.SWITCH', () => {
  const map = CHANNEL_VALUE_MAPS.SWITCH;

  test('STATE true → HM STATE true', () => {
    const r = map.toHomematic('STATE', true);
    expect(r).toEqual({ hmKey: 'STATE', hmValue: true });
  });

  test('STATE false → HM STATE false', () => {
    const r = map.toHomematic('STATE', false);
    expect(r?.hmValue).toBe(false);
  });

  test('HM STATE true → setRelay on:true', () => {
    const r = map.toShelly('STATE', true);
    expect(r?.shellyMethod).toBe('setRelay');
    expect(r?.shellyParams.on).toBe(true);
  });

  test('unknown key → null', () => {
    expect(map.toHomematic('UNKNOWN', 1)).toBeNull();
  });
});

describe('CHANNEL_VALUE_MAPS.DIMMER', () => {
  const map = CHANNEL_VALUE_MAPS.DIMMER;

  test('LEVEL 0.5 passthrough', () => {
    const r = map.toHomematic('LEVEL', 0.5);
    expect(r?.hmValue).toBe(0.5);
  });

  test('LEVEL 1.0 → setLevel 100', () => {
    const r = map.toShelly('LEVEL', 1.0);
    expect(r?.shellyParams.level).toBe(100);
  });

  test('LEVEL 0.0 → setLevel 0', () => {
    const r = map.toShelly('LEVEL', 0.0);
    expect(r?.shellyParams.level).toBe(0);
  });

  test('LEVEL 0.505 rounds to 51', () => {
    const r = map.toShelly('LEVEL', 0.505);
    expect(r?.shellyParams.level).toBe(51);
  });
});

describe('CHANNEL_VALUE_MAPS.BLIND', () => {
  const map = CHANNEL_VALUE_MAPS.BLIND;

  // HM convention: LEVEL 0.0 = closed, 1.0 = open (matches Shelly pos/100)
  test('LEVEL passes through', () => {
    expect(map.toHomematic('LEVEL', 0.0)?.hmValue).toBe(0.0);
    expect(map.toHomematic('LEVEL', 1.0)?.hmValue).toBe(1.0);
  });

  test('HM LEVEL 1 (open) → Shelly pos 100', () => {
    const r = map.toShelly('LEVEL', 1.0);
    expect(r?.shellyMethod).toBe('coverGoToPosition');
    expect(r?.shellyParams.pos).toBe(100);
  });

  test('HM LEVEL 0 (closed) → Shelly pos 0', () => {
    const r = map.toShelly('LEVEL', 0.0);
    expect(r?.shellyParams.pos).toBe(0);
  });

  test('HM STOP → coverCommand stop', () => {
    const r = map.toShelly('STOP', true);
    expect(r?.shellyMethod).toBe('coverCommand');
    expect(r?.shellyParams.cmd).toBe('stop');
  });
});

describe('CHANNEL_VALUE_MAPS.WATER', () => {
  test('flood maps to HM-Sec-WDS enum (0=DRY, 2=WATER)', () => {
    expect(CHANNEL_VALUE_MAPS.WATER.toHomematic('STATE', true)?.hmValue).toBe(2);
    expect(CHANNEL_VALUE_MAPS.WATER.toHomematic('STATE', false)?.hmValue).toBe(0);
  });
});

describe('CHANNEL_VALUE_MAPS.MAINTENANCE', () => {
  test('LOW_BAT and LOWBAT both map to classic LOWBAT', () => {
    expect(CHANNEL_VALUE_MAPS.MAINTENANCE.toHomematic('LOW_BAT', true)?.hmKey).toBe('LOWBAT');
    expect(CHANNEL_VALUE_MAPS.MAINTENANCE.toHomematic('LOWBAT', true)?.hmKey).toBe('LOWBAT');
  });
});

describe('CHANNEL_VALUE_MAPS.POWERMETER', () => {
  test('CURRENT converts A to mA', () => {
    expect(CHANNEL_VALUE_MAPS.POWERMETER.toHomematic('CURRENT', 0.5)?.hmValue).toBe(500);
  });
});

describe('CHANNEL_VALUE_MAPS.WEATHER', () => {
  const map = CHANNEL_VALUE_MAPS.WEATHER;

  test('TEMPERATURE passthrough', () => {
    const r = map.toHomematic('TEMPERATURE', 22.5);
    expect(r).toEqual({ hmKey: 'TEMPERATURE', hmValue: 22.5 });
  });

  test('toShelly returns null (read-only)', () => {
    expect(map.toShelly('TEMPERATURE', 22.5)).toBeNull();
  });
});

// --- AddressRegistry ---

describe('AddressRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('allocates sequential HM addresses', () => {
    const reg = new AddressRegistry(tmpDir);
    reg.load();
    expect(reg.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH')).toBe('SHELLY0001');
    expect(reg.getOrCreateChannel('112233445566', 0, 'SWITCH')).toBe('SHELLY0002');
  });

  test('returns the same address on repeated calls', () => {
    const reg = new AddressRegistry(tmpDir);
    reg.load();
    const first = reg.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH');
    const second = reg.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH');
    expect(first).toBe(second);
  });

  test('each channel gets its own address', () => {
    const reg = new AddressRegistry(tmpDir);
    reg.load();
    expect(reg.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH')).toBe('SHELLY0001');
    expect(reg.getOrCreateChannel('aabbccddeeff', 1, 'SWITCH')).toBe('SHELLY0002');
  });

  test('persists across instances', () => {
    const reg1 = new AddressRegistry(tmpDir);
    reg1.load();
    const addr = reg1.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH');

    const reg2 = new AddressRegistry(tmpDir);
    reg2.load();
    expect(reg2.getChannelHmAddress('aabbccddeeff', 0)).toBe(addr);
  });

  test('reverse lookup works', () => {
    const reg = new AddressRegistry(tmpDir);
    reg.load();
    reg.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH');
    expect(reg.getMac('SHELLY0001')).toBe('aabbccddeeff');
  });

  test('descriptor version persists', () => {
    const reg1 = new AddressRegistry(tmpDir);
    reg1.load();
    expect(reg1.getDescriptorVersion()).toBe(0);
    reg1.getOrCreateChannel('aabbccddeeff', 0, 'SWITCH');
    reg1.setDescriptorVersion(2);

    const reg2 = new AddressRegistry(tmpDir);
    reg2.load();
    expect(reg2.getDescriptorVersion()).toBe(2);
    expect(reg2.getChannelHmAddress('aabbccddeeff', 0)).toBe('SHELLY0001');
  });
});

// --- inferChannelKinds ---

describe('inferChannelKinds', () => {
  test('switch:0 state → SWITCH channel + MAINTENANCE', () => {
    const kinds = inferChannelKinds(2, 'SHELLYPLUS1', { 'switch:0': { STATE: false } });
    expect(kinds.some(c => c.kind === 'SWITCH')).toBe(true);
    expect(kinds.some(c => c.kind === 'MAINTENANCE')).toBe(true);
  });

  test('switch:0 with POWER → SWITCH + POWERMETER', () => {
    const kinds = inferChannelKinds(2, 'SHELLYPLUS1PM', { 'switch:0': { STATE: false, POWER: 0, ENERGY_COUNTER: 0 } });
    expect(kinds.some(c => c.kind === 'SWITCH')).toBe(true);
    expect(kinds.some(c => c.kind === 'POWERMETER')).toBe(true);
  });

  test('temperature:0 + humidity:0 → WEATHER', () => {
    const kinds = inferChannelKinds(2, 'SHELLYHT', {
      'temperature:0': { TEMPERATURE: 20 },
      'humidity:0': { HUMIDITY: 50 },
    });
    const weatherChannels = kinds.filter(c => c.kind === 'WEATHER');
    expect(weatherChannels.length).toBe(1);
  });

  test('cover:0 → BLIND', () => {
    const kinds = inferChannelKinds(2, 'SHELLYCOVERPM', { 'cover:0': { LEVEL: 0 } });
    expect(kinds.some(c => c.kind === 'BLIND')).toBe(true);
  });

  test('light:0 → DIMMER', () => {
    const kinds = inferChannelKinds(2, 'SHELLYDIMMER2', { 'light:0': { LEVEL: 0.5 } });
    expect(kinds.some(c => c.kind === 'DIMMER')).toBe(true);
  });

  test('gen1 no state, flood model → WATER fallback', () => {
    const kinds = inferChannelKinds(1, 'shellyflood', {});
    expect(kinds.some(c => c.kind === 'WATER')).toBe(true);
  });

  test('gen1 no state, dimmer model → DIMMER fallback', () => {
    const kinds = inferChannelKinds(1, 'shellydimmer', {});
    expect(kinds.some(c => c.kind === 'DIMMER')).toBe(true);
  });
});
