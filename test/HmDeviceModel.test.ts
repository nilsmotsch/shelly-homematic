import {
  getParamsetDescription,
  buildParamset,
  buildChannelDescription,
  buildDeviceDescription,
  deviceTypeFor,
  ChannelKind,
} from '../src/hm/HmDeviceModel';

describe('getParamsetDescription', () => {
  test('SWITCH has STATE BOOL rw and WORKING BOOL ro', () => {
    const desc = getParamsetDescription('SWITCH');
    expect(desc.STATE.TYPE).toBe('BOOL');
    expect(desc.STATE.OPERATIONS).toBe(7); // read|write|event
    expect(desc.WORKING.OPERATIONS).toBe(5); // read|event (no write)
  });

  test('SWITCH has write-only visible TOGGLE action for programs', () => {
    const desc = getParamsetDescription('SWITCH');
    expect(desc.TOGGLE.TYPE).toBe('ACTION');
    expect(desc.TOGGLE.OPERATIONS).toBe(2); // write only
    expect(desc.TOGGLE.FLAGS & 1).toBe(1); // visible → enumerable in program editor
  });

  test('DIMMER has LEVEL FLOAT rw with 0-1 range', () => {
    const desc = getParamsetDescription('DIMMER');
    expect(desc.LEVEL.TYPE).toBe('FLOAT');
    expect(desc.LEVEL.MIN).toBe(0.0);
    expect(desc.LEVEL.MAX).toBe(1.0);
    expect(desc.LEVEL.OPERATIONS).toBe(7);
  });

  test('BLIND has LEVEL, STOP action, WORKING', () => {
    const desc = getParamsetDescription('BLIND');
    expect(desc.LEVEL.TYPE).toBe('FLOAT');
    expect(desc.STOP.TYPE).toBe('ACTION');
    expect(desc.WORKING.OPERATIONS).toBe(5);
  });

  test('WEATHER has TEMPERATURE and HUMIDITY read-only', () => {
    const desc = getParamsetDescription('WEATHER');
    expect(desc.TEMPERATURE.TYPE).toBe('FLOAT');
    expect(desc.TEMPERATURE.OPERATIONS).toBe(5);
    expect(desc.HUMIDITY.TYPE).toBe('FLOAT');
    expect(desc.HUMIDITY.OPERATIONS).toBe(5);
    expect(desc.TEMPERATURE.UNIT).toBe('°C');
  });

  test('CONTACT has STATE bool read-only', () => {
    const desc = getParamsetDescription('CONTACT');
    expect(desc.STATE.TYPE).toBe('BOOL');
    expect(desc.STATE.OPERATIONS).toBe(5);
  });

  test('POWERMETER has POWER and ENERGY_COUNTER', () => {
    const desc = getParamsetDescription('POWERMETER');
    expect(desc.POWER.UNIT).toBe('W');
    expect(desc.ENERGY_COUNTER.UNIT).toBe('Wh');
  });

  test('MAINTENANCE has UNREACH LOWBAT OPERATING_VOLTAGE (classic names)', () => {
    const desc = getParamsetDescription('MAINTENANCE');
    expect(desc.UNREACH.TYPE).toBe('BOOL');
    expect(desc.LOWBAT.TYPE).toBe('BOOL'); // classic BidCos name, not HmIP LOW_BAT
    expect(desc.OPERATING_VOLTAGE.TYPE).toBe('FLOAT');
  });

  test('WATER STATE is the HM-Sec-WDS enum', () => {
    const desc = getParamsetDescription('WATER');
    expect(desc.STATE.TYPE).toBe('ENUM');
    expect(desc.STATE.VALUE_LIST).toEqual(['DRY', 'WET', 'WATER']);
  });

  test('MOTION has BRIGHTNESS 0-255 like HM-Sec-MDIR', () => {
    const desc = getParamsetDescription('MOTION');
    expect(desc.BRIGHTNESS.TYPE).toBe('INTEGER');
    expect(desc.BRIGHTNESS.MAX).toBe(255);
  });

  // CONTROL drives the WebUI's native channel controls (Ein/Aus, slider, …);
  // values must match the CCU's own rftypes definitions. ID must echo the
  // parameter name (ReGa expects it, like the HVI reference).
  test('controllable datapoints carry the rftypes CONTROL string and their ID', () => {
    expect(getParamsetDescription('SWITCH').STATE.CONTROL).toBe('SWITCH.STATE');
    expect(getParamsetDescription('DIMMER').LEVEL.CONTROL).toBe('DIMMER.LEVEL');
    expect(getParamsetDescription('BLIND').LEVEL.CONTROL).toBe('BLIND.LEVEL');
    expect(getParamsetDescription('BLIND').STOP.CONTROL).toBe('BLIND.STOP');
    expect(getParamsetDescription('CONTACT').STATE.CONTROL).toBe('DOOR_SENSOR.STATE');
    expect(getParamsetDescription('POWERMETER').POWER.CONTROL).toBe('POWERMETER.POWER');
    expect(getParamsetDescription('SWITCH').STATE.ID).toBe('STATE');
    expect(getParamsetDescription('MAINTENANCE').UNREACH.ID).toBe('UNREACH');
    // no control attr in the rftypes for these — must stay unset
    expect(getParamsetDescription('WEATHER').TEMPERATURE.CONTROL).toBeUndefined();
    expect(getParamsetDescription('MOTION').MOTION.CONTROL).toBeUndefined();
  });

  const allKinds: ChannelKind[] = ['SWITCH','DIMMER','BLIND','WEATHER','CONTACT','MOTION','WATER','POWERMETER','MAINTENANCE'];
  test.each(allKinds)('kind %s has at least one parameter', (kind) => {
    const desc = getParamsetDescription(kind);
    expect(Object.keys(desc).length).toBeGreaterThan(0);
  });
});

describe('buildParamset', () => {
  test('uses state value when present', () => {
    const ps = buildParamset('SWITCH', { STATE: true, WORKING: false });
    expect(ps.STATE).toBe(true);
    expect(ps.WORKING).toBe(false);
  });

  test('falls back to DEFAULT when key missing', () => {
    const ps = buildParamset('SWITCH', {});
    expect(ps.STATE).toBe(false);
  });

  test('DIMMER level 50% = 0.5', () => {
    const ps = buildParamset('DIMMER', { LEVEL: 0.5 });
    expect(ps.LEVEL).toBe(0.5);
  });
});

describe('buildChannelDescription', () => {
  test('channel address is hmAddress:idx', () => {
    const ch = buildChannelDescription('SHELLY0001', 1, 'SWITCH', 'HM-LC-Sw1-Pl');
    expect(ch.ADDRESS).toBe('SHELLY0001:1');
    expect(ch.PARENT).toBe('SHELLY0001');
    expect(ch.PARENT_TYPE).toBe('HM-LC-Sw1-Pl');
  });

  test('channel types are the classic BidCos names the CCU knows', () => {
    expect(buildChannelDescription('SHELLY0001', 1, 'SWITCH', 'HM-LC-Sw1-Pl').TYPE).toBe('SWITCH');
    expect(buildChannelDescription('SHELLY0001', 1, 'BLIND', 'HM-LC-Bl1-FM').TYPE).toBe('BLIND');
    expect(buildChannelDescription('SHELLY0001', 1, 'CONTACT', 'HM-Sec-SC-2').TYPE).toBe('SHUTTER_CONTACT');
    expect(buildChannelDescription('SHELLY0001', 1, 'MOTION', 'HM-Sec-MDIR').TYPE).toBe('MOTION_DETECTOR');
    expect(buildChannelDescription('SHELLY0001', 1, 'WATER', 'HM-Sec-WDS').TYPE).toBe('WATERDETECTIONSENSOR');
  });

  test('actuator channels are receivers, sensors are senders', () => {
    expect(buildChannelDescription('SHELLY0001', 1, 'SWITCH', 'HM-LC-Sw1-Pl').DIRECTION).toBe(2);
    expect(buildChannelDescription('SHELLY0001', 1, 'WEATHER', 'HM-WDS10-TH-O').DIRECTION).toBe(1);
  });

  test('PARAMSETS includes VALUES and MASTER', () => {
    const ch = buildChannelDescription('SHELLY0001', 1, 'DIMMER', 'HM-LC-Dim1T-Pl');
    expect(ch.PARAMSETS).toContain('VALUES');
    expect(ch.PARAMSETS).toContain('MASTER');
  });
});

describe('deviceTypeFor', () => {
  test('plain switch → HM-LC-Sw1-Pl', () => {
    expect(deviceTypeFor([{ kind: 'SWITCH', channelIdx: 1 }])).toBe('HM-LC-Sw1-Pl');
  });

  test('switch with power meter → HM-ES-PMSw1-Pl', () => {
    expect(deviceTypeFor([
      { kind: 'SWITCH', channelIdx: 1 },
      { kind: 'POWERMETER', channelIdx: 2 },
    ])).toBe('HM-ES-PMSw1-Pl');
  });

  test('blind → HM-LC-Bl1-FM', () => {
    expect(deviceTypeFor([{ kind: 'BLIND', channelIdx: 1 }])).toBe('HM-LC-Bl1-FM');
  });

  test('standalone power meter → HM-ES-TX-WM', () => {
    expect(deviceTypeFor([{ kind: 'POWERMETER', channelIdx: 1 }])).toBe('HM-ES-TX-WM');
  });
});

describe('buildDeviceDescription', () => {
  test('device ADDRESS matches hmAddress', () => {
    const dev = buildDeviceDescription('SHELLY0001', 'SHLY1PM', [
      { kind: 'SWITCH', channelIdx: 1 },
    ]);
    expect(dev.ADDRESS).toBe('SHELLY0001');
  });

  test('CHILDREN includes channel 0 (maintenance)', () => {
    const dev = buildDeviceDescription('SHELLY0001', 'SHLY1PM', [
      { kind: 'SWITCH', channelIdx: 1 },
    ]);
    expect(dev.CHILDREN).toContain('SHELLY0001:0');
    expect(dev.CHILDREN).toContain('SHELLY0001:1');
  });

  test('has required HM fields', () => {
    const dev = buildDeviceDescription('SHELLY0001', 'SHLY1PM', [
      { kind: 'SWITCH', channelIdx: 1 },
    ]);
    expect(dev.FLAGS).toBeDefined();
    expect(dev.VERSION).toBeDefined();
    expect(dev.PARAMSETS).toContain('MASTER');
  });

  test('device TYPE is a native HM model', () => {
    const dev = buildDeviceDescription('SHELLY0001', 'SHLY1PM', [
      { kind: 'SWITCH', channelIdx: 1 },
      { kind: 'POWERMETER', channelIdx: 2 },
    ]);
    expect(dev.TYPE).toBe('HM-ES-PMSw1-Pl');
  });
});
