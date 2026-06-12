// Bump whenever the served HM device/channel/paramset descriptions change
// shape — on the next CCU init() the bridge re-announces everything
// (deleteDevices+newDevices) so the CCU drops cached descriptions, and the
// getParamsetId cache key changes so ReGa re-fetches paramset descriptions.
// History (v2-v5 in git): native types, self-closing-tag relearns, RPC handler
// fixes, descriptor fields.
// v6: CONTROL/ID in paramset descriptions (native WebUI controls) and
// WATER channel type WATERLEVEL → WATERDETECTIONSENSOR.
// v7: FLAGS visible bit on all user-facing datapoints — ReGa hides datapoints
// without it, and a channel with zero visible datapoints disappears from
// "Status und Bedienung" entirely (the POWERMETER channel was invisible).
// v8: FLOAT values/MIN/MAX/DEFAULT serialized as explicit <double> — ReGa
// stores 0 when an <int> arrives on a FLOAT datapoint (CURRENT in whole mA,
// LEVEL at exactly 0/1).
// v9: POWERMETER BOOT datapoint — the CCU's auto-created energy-statistics
// program reads DPByControl('POWERMETER.BOOT') every minute and threw a
// ScriptRuntimeError without it.
// v10: POWERMETER FREQUENCY datapoint (mapped from Shelly Gen2 'freq') — the
// WebUI powermeter control (esp/controls/powermeter.fn) dereferences
// DPByControl('POWERMETER.FREQUENCY') unguarded when rendering the channel.
export const DESCRIPTOR_VERSION = 10;

export type ChannelKind =
  | 'SWITCH'
  | 'DIMMER'
  | 'BLIND'
  | 'WEATHER'
  | 'CONTACT'
  | 'MOTION'
  | 'WATER'
  | 'POWERMETER'
  | 'MAINTENANCE';

// Operations bitmask: 1=read, 2=write, 4=event
const OPS_RWE = 7; // actuator
const OPS_RE  = 5; // sensor (read+event)

export interface ParamDesc {
  TYPE: string;
  OPERATIONS: number;
  FLAGS: number;
  DEFAULT: unknown;
  MIN?: unknown;
  MAX?: unknown;
  UNIT?: string;
  VALUE_LIST?: string[];
  TAB_ORDER: number;
  // The WebUI keys its native channel controls (Ein/Aus buttons, slider, …)
  // on this string (e.g. "SWITCH.STATE"); without it ReGa renders a generic
  // value box. Values must match the CCU's own /firmware/rftypes/*.xml.
  CONTROL?: string;
  ID?: string;
}

export interface ParamsetDescription {
  [param: string]: ParamDesc;
}

// ReGa expects each parameter description to carry its own name as ID
// (the reference implementation emits this too).
function withIds(ps: ParamsetDescription): ParamsetDescription {
  for (const [key, desc] of Object.entries(ps)) desc.ID = key;
  return ps;
}

// Classic BidCos maintenance channel — LOWBAT (not HmIP's LOW_BAT) so the CCU
// shows the standard battery/servicemessage handling.
// FLAGS bits: 1=visible, 2=internal, 8=service, 16=sticky. ReGa only renders
// a channel in "Status und Bedienung" if it has ≥1 enabled VISIBLE datapoint
// (`DPs().EnumEnabledVisibleIDs()` in hdevichannels.htm) — FLAGS without the
// visible bit hides the datapoint AND, if all are hidden, the whole channel.
// Values mirror HVI / the rftypes ui_flags (service → 9, sticky → 24).
const MAINTENANCE_PARAMSET: ParamsetDescription = withIds({
  UNREACH: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 9, DEFAULT: false, TAB_ORDER: 0 },
  STICKY_UNREACH: { TYPE: 'BOOL', OPERATIONS: OPS_RWE, FLAGS: 24, DEFAULT: false, TAB_ORDER: 1 },
  CONFIG_PENDING: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 9, DEFAULT: false, TAB_ORDER: 2 },
  LOWBAT: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 9, DEFAULT: false, TAB_ORDER: 3 },
  OPERATING_VOLTAGE: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 3.6, UNIT: 'V', TAB_ORDER: 4 },
  RSSI_DEVICE: { TYPE: 'INTEGER', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0, MIN: -128, MAX: 0, UNIT: 'dBm', TAB_ORDER: 5 },
});

// CONTROL strings below come from the CCU's own /firmware/rftypes/*.xml for the
// impersonated types (rf_s, rf_es_pmsw, rf_bl, rf_dim_1t_644, rf_sec_sco, …).

const SWITCH_PARAMSET: ParamsetDescription = withIds({
  STATE: { TYPE: 'BOOL', OPERATIONS: OPS_RWE, FLAGS: 1, DEFAULT: false, TAB_ORDER: 0, CONTROL: 'SWITCH.STATE' },
  WORKING: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 3, DEFAULT: false, TAB_ORDER: 1 },
});

const DIMMER_PARAMSET: ParamsetDescription = withIds({
  LEVEL: { TYPE: 'FLOAT', OPERATIONS: OPS_RWE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 1.0, UNIT: '100%', TAB_ORDER: 0, CONTROL: 'DIMMER.LEVEL' },
  OLD_LEVEL: { TYPE: 'ACTION', OPERATIONS: 2, FLAGS: 1, DEFAULT: false, TAB_ORDER: 1, CONTROL: 'DIMMER.OLD_LEVEL' },
  WORKING: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 3, DEFAULT: false, TAB_ORDER: 2 },
});

const BLIND_PARAMSET: ParamsetDescription = withIds({
  LEVEL: { TYPE: 'FLOAT', OPERATIONS: OPS_RWE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 1.0, UNIT: '100%', TAB_ORDER: 0, CONTROL: 'BLIND.LEVEL' },
  STOP: { TYPE: 'ACTION', OPERATIONS: 2, FLAGS: 1, DEFAULT: false, TAB_ORDER: 1, CONTROL: 'BLIND.STOP' },
  WORKING: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 3, DEFAULT: false, TAB_ORDER: 2 },
});

// rf_ash550.xml: WEATHER channel datapoints carry no control attribute
const WEATHER_PARAMSET: ParamsetDescription = withIds({
  TEMPERATURE: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: -40.0, MAX: 85.0, UNIT: '°C', TAB_ORDER: 0 },
  HUMIDITY: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 100.0, UNIT: '%', TAB_ORDER: 1 },
});

const CONTACT_PARAMSET: ParamsetDescription = withIds({
  STATE: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: false, TAB_ORDER: 0, CONTROL: 'DOOR_SENSOR.STATE' },
});

// HM-Sec-MDIR shape: MOTION + BRIGHTNESS (0-255, unitless); no control attrs
const MOTION_PARAMSET: ParamsetDescription = withIds({
  MOTION: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: false, TAB_ORDER: 0 },
  BRIGHTNESS: { TYPE: 'INTEGER', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0, MIN: 0, MAX: 255, UNIT: '', TAB_ORDER: 1 },
});

// HM-Sec-WDS shape: STATE is an ENUM (0=DRY, 1=WET, 2=WATER), not a BOOL
const WATER_PARAMSET: ParamsetDescription = withIds({
  STATE: { TYPE: 'ENUM', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0, MIN: 0, MAX: 2, VALUE_LIST: ['DRY', 'WET', 'WATER'], TAB_ORDER: 0 },
});

// HM-ES-PMSw1-Pl channel 2 shape (subset). BOOT is required: confirming a
// metering device in the inbox auto-creates an energy-statistics ReGa program
// that reads DPByControl('POWERMETER.BOOT') every minute — without the
// datapoint it throws a ScriptRuntimeError each run and the WebUI shows the
// "internal error" banner. BOOT means "energy counter was reset"; Shelly
// totals persist across reboots, so it stays false.
const POWERMETER_PARAMSET: ParamsetDescription = withIds({
  BOOT: { TYPE: 'BOOL', OPERATIONS: OPS_RE, FLAGS: 3, DEFAULT: false, TAB_ORDER: 4, CONTROL: 'POWERMETER.BOOT' },
  POWER: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 3680.0, UNIT: 'W', TAB_ORDER: 0, CONTROL: 'POWERMETER.POWER' },
  ENERGY_COUNTER: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 838860.7, UNIT: 'Wh', TAB_ORDER: 1, CONTROL: 'POWERMETER.ENERGY_COUNTER' },
  VOLTAGE: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 980.0, UNIT: 'V', TAB_ORDER: 2, CONTROL: 'POWERMETER.VOLTAGE' },
  CURRENT: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 0.0, MIN: 0.0, MAX: 16000.0, UNIT: 'mA', TAB_ORDER: 3, CONTROL: 'POWERMETER.CURRENT' },
  FREQUENCY: { TYPE: 'FLOAT', OPERATIONS: OPS_RE, FLAGS: 1, DEFAULT: 50.0, MIN: 48.72, MAX: 51.27, UNIT: 'Hz', TAB_ORDER: 5, CONTROL: 'POWERMETER.FREQUENCY' },
});

export function getParamsetDescription(kind: ChannelKind): ParamsetDescription {
  switch (kind) {
    case 'SWITCH': return SWITCH_PARAMSET;
    case 'DIMMER': return DIMMER_PARAMSET;
    case 'BLIND': return BLIND_PARAMSET;
    case 'WEATHER': return WEATHER_PARAMSET;
    case 'CONTACT': return CONTACT_PARAMSET;
    case 'MOTION': return MOTION_PARAMSET;
    case 'WATER': return WATER_PARAMSET;
    case 'POWERMETER': return POWERMETER_PARAMSET;
    case 'MAINTENANCE': return MAINTENANCE_PARAMSET;
  }
}

export function buildParamset(kind: ChannelKind, state: Record<string, unknown>): Record<string, unknown> {
  const desc = getParamsetDescription(kind);
  const result: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(desc)) {
    result[key] = key in state ? state[key] : d.DEFAULT;
  }
  return result;
}

export interface HmChannelDescription {
  ADDRESS: string;
  PARENT: string;
  PARENT_TYPE: string;
  TYPE: string;
  FLAGS: number;
  VERSION: number;
  RF_ADDRESS: number;
  UPDATABLE: boolean;
  LINK_SOURCE_ROLES: string;
  LINK_TARGET_ROLES: string;
  PARAMSETS: string[];
  INDEX: number;
  AES_ACTIVE: number;
  DIRECTION: number;
  GROUP: string;
  TEAM: string;
  TEAM_TAG: string;
  TEAM_CHANNELS: unknown[];
  CHILDREN: unknown[];
}

export interface HmDeviceDescription {
  ADDRESS: string;
  // Always '' for devices — but it MUST be present: the WebUI's device
  // settings CGI (ic_deviceparameters.cgi) reads dev_descr(PARENT)
  // unguarded; a missing TCL array element crashes the whole page into
  // "An internal error was detected in the service software".
  PARENT: string;
  TYPE: string;
  FLAGS: number;
  VERSION: number;
  // RX_MODE = receive mode bitmask (1 = ALWAYS). The CCU needs this to know the
  // device is permanently reachable; without it config never completes and the
  // device is stuck in "Fehler" / CONFIG_PENDING in the Posteingang.
  RX_MODE: number;
  PARAMSETS: string[];
  CHILDREN: string[];
  FIRMWARE: string;
  AVAILABLE_FIRMWARE: string;
  INTERFACE: string;
  ROAMING: number;
  UPDATABLE: string;
  RF_ADDRESS: number;
  PHYSICAL_ADDRESS: number;
  CHANNELS: unknown[];
}

// Real BidCos firmware versions for the types we impersonate (from the CCU's
// own /firmware/rftypes/*.xml). The CCU does not strictly validate this value
// (the reference impl ships mismatched versions and still works), but matching
// keeps the device from looking like outdated firmware.
function versionFor(type: string): number {
  switch (type) {
    case 'HM-LC-Sw1-Pl': return 26;
    case 'HM-LC-Dim1T-Pl': return 17;
    case 'HM-LC-Bl1-FM': return 13;
    case 'HM-ES-PMSw1-Pl': return 16;
    default: return 1;
  }
}

// Classic BidCos channel types — these are what the CCU WebUI keys its
// native controls on (a "SWITCH" channel gets a toggle, a "BLIND" channel
// gets up/stop/down + slider, etc.). Do not invent new names here.
export function kindToType(kind: ChannelKind): string {
  switch (kind) {
    case 'SWITCH': return 'SWITCH';
    case 'DIMMER': return 'DIMMER';
    case 'BLIND': return 'BLIND';
    case 'WEATHER': return 'WEATHER';
    case 'CONTACT': return 'SHUTTER_CONTACT';
    case 'MOTION': return 'MOTION_DETECTOR';
    case 'WATER': return 'WATERDETECTIONSENSOR'; // HM-Sec-WDS channel type per rf_wds_v1_1.xml
    case 'POWERMETER': return 'POWERMETER';
    case 'MAINTENANCE': return 'MAINTENANCE';
  }
}

export interface DeviceLayout {
  kind: ChannelKind;
  channelIdx: number;
}

// The CCU resolves icons and channel rendering from the device TYPE via its
// device database, so we impersonate the closest real BidCos device
// (the same trick CUxD uses). The channel layout we expose must match the
// real device: channel 0 MAINTENANCE + the functional channel(s) below.
export function deviceTypeFor(channels: DeviceLayout[]): string {
  const kinds = channels.map((c) => c.kind);
  const primary =
    kinds.find((k) => k !== 'POWERMETER' && k !== 'MAINTENANCE') ||
    kinds.find((k) => k !== 'MAINTENANCE') ||
    'SWITCH';
  switch (primary) {
    case 'SWITCH': return kinds.includes('POWERMETER') ? 'HM-ES-PMSw1-Pl' : 'HM-LC-Sw1-Pl';
    case 'DIMMER': return 'HM-LC-Dim1T-Pl';
    case 'BLIND': return 'HM-LC-Bl1-FM';
    case 'WEATHER': return 'HM-WDS10-TH-O';
    case 'CONTACT': return 'HM-Sec-SC-2';
    case 'MOTION': return 'HM-Sec-MDIR';
    case 'WATER': return 'HM-Sec-WDS';
    case 'POWERMETER': return 'HM-ES-TX-WM';
    default: return 'HM-LC-Sw1-Pl';
  }
}

function directionFor(kind: ChannelKind): number {
  // 1 = sender (sensor), 2 = receiver (actuator), 0 = none
  switch (kind) {
    case 'SWITCH':
    case 'DIMMER':
    case 'BLIND':
      return 2;
    case 'MAINTENANCE':
      return 0;
    default:
      return 1;
  }
}

export function buildChannelDescription(
  hmAddress: string,
  channelIdx: number,
  kind: ChannelKind,
  parentType: string
): HmChannelDescription {
  return {
    ADDRESS: `${hmAddress}:${channelIdx}`,
    PARENT: hmAddress,
    PARENT_TYPE: parentType,
    TYPE: kindToType(kind),
    FLAGS: kind === 'MAINTENANCE' ? 3 : 1, // maintenance channels are visible+internal
    VERSION: versionFor(parentType),
    RF_ADDRESS: 0,
    UPDATABLE: true,
    LINK_SOURCE_ROLES: '',
    LINK_TARGET_ROLES: '',
    PARAMSETS: ['MASTER', 'VALUES'],
    INDEX: channelIdx,
    AES_ACTIVE: 0,
    DIRECTION: directionFor(kind),
    GROUP: '',
    TEAM: '',
    TEAM_TAG: '',
    TEAM_CHANNELS: [],
    CHILDREN: [],
  };
}

export function buildDeviceDescription(
  hmAddress: string,
  model: string,
  channels: DeviceLayout[],
  interfaceId = 'ShellyHM'
): HmDeviceDescription {
  const children = channels.map((c) => `${hmAddress}:${c.channelIdx}`);
  // Always add channel 0 (MAINTENANCE)
  if (!children.includes(`${hmAddress}:0`)) children.unshift(`${hmAddress}:0`);

  const type = deviceTypeFor(channels);
  return {
    ADDRESS: hmAddress,
    PARENT: '',
    TYPE: type,
    FLAGS: 1,
    VERSION: versionFor(type),
    RX_MODE: 1, // ALWAYS — device is permanently reachable
    PARAMSETS: ['MASTER'],
    CHILDREN: children,
    FIRMWARE: '1.0.0',
    AVAILABLE_FIRMWARE: '1.0.0',
    INTERFACE: interfaceId,
    ROAMING: 0,
    UPDATABLE: '1',
    RF_ADDRESS: 0,
    PHYSICAL_ADDRESS: 0,
    CHANNELS: [],
  };
}
