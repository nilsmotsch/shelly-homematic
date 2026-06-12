import * as fs from 'fs';
import { ShellyConnector, DiscoveredDevice } from '../shelly/ShellyConnector';
import { HmVirtualInterface, DeviceInfo } from '../hm/HmVirtualInterface';
import { ChannelKind, DESCRIPTOR_VERSION } from '../hm/HmDeviceModel';
import { AddressRegistry, ChannelMapping, inferChannelKinds, CHANNEL_VALUE_MAPS } from '../devices/DeviceMapper';
import { renameCcuDevice } from '../hm/RegaClient';
import { getLogger } from '../utils/Logger';

// DESCRIPTOR_VERSION lives in HmDeviceModel (it versions the served
// descriptions and salts the getParamsetId cache key).

const ACTUATOR_KINDS = new Set<string>(['SWITCH', 'DIMMER', 'BLIND']);
// Datapoints that live on the POWERMETER channel (HM channel 2) when the
// device is an actuator+meter combo (HM-ES-PMSw1-Pl layout)
const POWER_KEYS = new Set(['POWER', 'ENERGY_COUNTER', 'VOLTAGE', 'CURRENT', 'FREQUENCY']);

// One HM device per Shelly channel: `primary` is the functional channel
// (HM channel 1); `meter` is a companion power meter at the same idx,
// exposed as HM channel 2 instead of a separate device.
interface ChannelRow {
  primary: ChannelMapping;
  meter?: ChannelMapping;
}

export interface ShellyChannelState {
  idx: number;
  kind: string;
  state: Record<string, unknown>;
}

// One row in the web UI — represents a single Shelly channel.
// Multi-channel devices (Plus2PM, SHSW-25) generate one ShellyDevice per channel.
export interface ShellyDevice {
  address: string;    // "${mac}:${channelIdx}" — used as exposure key in config
  mac: string;        // Shelly MAC
  channelIdx: number; // Shelly component index (0-based)
  hmAddress: string;  // SHELLY0001, etc.
  name: string;       // device name; multi-channel: appends " (Ch N)"
  model: string;
  gen: 1 | 2;
  ip: string;
  online: boolean;
  exposed: boolean;
  channels: ShellyChannelState[]; // exactly ONE channel for this row
}

export interface BridgeConfig {
  shelly: {
    discovery: { mdns: boolean; rescanInterval: number };
    manualDevices: string[];
    pollInterval: number;
  };
  hm: {
    interfaceName: string;
    port: number;
    bindHost: string;
    regaUrl?: string;
  };
  devices: {
    defaultExposed: boolean;
    exposed: Record<string, boolean>;
  };
  web: { enabled: boolean; port: number };
  logging: { level: string; file: string };
  // Set by index.ts after loading — where exposure changes get persisted
  configPath?: string;
}

function parseChannelKey(address: string): { mac: string; channelIdx: number } {
  const lastColon = address.lastIndexOf(':');
  if (lastColon === -1) return { mac: address, channelIdx: 0 };
  return { mac: address.slice(0, lastColon), channelIdx: parseInt(address.slice(lastColon + 1)) || 0 };
}

export class ShellyBridge {
  private config: BridgeConfig;
  private connector: ShellyConnector;
  private hmInterface: HmVirtualInterface;
  private registry: AddressRegistry;
  private exposedOverrides: Record<string, boolean>;
  private resyncTimer: NodeJS.Timeout | null = null;
  // Last announced channel layout per mac — re-register/re-announce when it
  // changes (Gen2 devices report their components only after the first status)
  private channelSigs = new Map<string, string>();
  // macs already (re)announced to the CURRENTLY registered CCU. Cleared whenever
  // a CCU (re)registers, because a reconnected/rebooted CCU may have forgotten
  // our devices. This is what lets a device discovered AFTER the CCU registered
  // (or after we restored a callback) still get announced, without re-announcing
  // on every event. In-memory only — not persisted like announcedSig.
  private sessionAnnounced = new Set<string>();
  // Pending debounced announcements per mac (see syncDeviceRegistration). The
  // layout signature evolves event-by-event right after (re)connect
  // (0:SWITCH:- → 0:SWITCH:M → …); announcing each step would churn
  // deleteDevices/newDevices at the CCU within the same second. Announce only
  // once the layout has been stable for ANNOUNCE_SETTLE_MS.
  private announceTimers = new Map<string, NodeJS.Timeout>();
  private static readonly ANNOUNCE_SETTLE_MS = 2000;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.exposedOverrides = { ...config.devices.exposed };

    const dataDir = process.env.SHELLY_HOMEMATIC_DATA_DIR || '.';
    this.registry = new AddressRegistry(dataDir);

    const shellyUser = process.env.SHELLY_USER;
    const shellyPass = process.env.SHELLY_PASSWORD;
    const auth = shellyUser && shellyPass ? { user: shellyUser, pass: shellyPass } : undefined;

    this.connector = new ShellyConnector(config.shelly, auth);

    this.hmInterface = new HmVirtualInterface({
      port: config.hm.port,
      bindHost: config.hm.bindHost,
      interfaceId: config.hm.interfaceName,
      getDevices: () => this.getExposedDeviceInfos(),
      onSetValue: (hmAddress, channelIdx, key, value) =>
        this.onCcuSetValue(hmAddress, channelIdx, key, value),
      onCcuRegistered: () => this.onCcuRegistered(),
      onCcuDeleteDevice: (hmAddress) => this.onCcuDeleteDevice(hmAddress),
      dataDir,
    });
  }

  // CCU WebUI "Löschen → Gerät ablernen": unexpose the channel and persist it
  // to config.json — without persistence the next bridge restart would still
  // see exposed=true and re-announce the device straight back into the CCU.
  private onCcuDeleteDevice(hmAddress: string): void {
    const ref = this.registry.getMacAndChannel(hmAddress);
    if (!ref) return;
    const channelKey = `${ref.mac}:${ref.channelIdx}`;
    this.exposedOverrides[channelKey] = false;
    if (this.config.configPath) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.config.configPath, 'utf-8'));
        if (!raw.devices) raw.devices = {};
        if (!raw.devices.exposed) raw.devices.exposed = {};
        raw.devices.exposed[channelKey] = false;
        fs.writeFileSync(this.config.configPath, JSON.stringify(raw, null, 2));
      } catch (err) {
        getLogger().error(`Failed to persist unexpose of ${channelKey}: ${err}`);
      }
    }
    getLogger().info(`Channel ${channelKey} (${hmAddress}) unexposed after CCU unlearn`);
  }

  async start(): Promise<void> {
    this.registry.load();
    await this.hmInterface.start();

    this.connector.on('deviceFound', (info) => this.syncDeviceRegistration(info.mac));
    this.connector.on('deviceEvent', (e) => {
      // Late registration: Gen2 channels are only inferable once state exists,
      // which is after deviceFound — register/announce on layout change
      this.syncDeviceRegistration(e.address);

      const hmAddress = this.registry.getChannelHmAddress(e.address, e.idx);
      if (!hmAddress) return;

      // Echoes of our own writes are deliberately forwarded: a real BidCos
      // interface sends an event after the device ACKs a command, and the CCU
      // WebUI only updates its controls from that event (suppressing it left
      // the UI stuck on the old state). No loop risk — the CCU does not turn
      // incoming events back into setValue calls, and the connector already
      // dedupes no-op state reports.
      this.onShellyEvent(hmAddress, e.address, e.component, e.idx, e.key, e.value);
    });

    this.connector.start();

    this.resyncTimer = setInterval(async () => {
      try {
        await this.connector.refreshAllStatuses();
        this.pushAllStatesToCcu();
      } catch (err) {
        getLogger().debug(`Resync error: ${err}`);
      }
    }, 5 * 60 * 1000);

    getLogger().info(`ShellyBridge started (HM interface port ${this.config.hm.port})`);
  }

  async stop(): Promise<void> {
    if (this.resyncTimer) { clearInterval(this.resyncTimer); this.resyncTimer = null; }
    for (const t of this.announceTimers.values()) clearTimeout(t);
    this.announceTimers.clear();
    this.connector.stop();
    await this.hmInterface.stop();
    getLogger().info('ShellyBridge stopped');
  }

  // Returns one ShellyDevice per channel (for web UI).
  getDevices(): Map<string, ShellyDevice> {
    const result = new Map<string, ShellyDevice>();

    // Seed with persisted (offline) channel entries
    for (const persisted of this.registry.getAllPersistedChannels()) {
      if (!persisted.name && !persisted.model) continue;
      const channelKey = `${persisted.mac}:${persisted.channelIdx}`;
      const explicit = Object.prototype.hasOwnProperty.call(this.exposedOverrides, channelKey);
      const exposed = explicit ? !!this.exposedOverrides[channelKey] : this.config.devices.defaultExposed;
      result.set(channelKey, {
        address: channelKey,
        mac: persisted.mac,
        channelIdx: persisted.channelIdx,
        hmAddress: persisted.hmAddress,
        name: persisted.name,
        model: persisted.model,
        gen: persisted.gen,
        ip: persisted.ip,
        online: false,
        exposed,
        channels: [{ idx: persisted.channelIdx, kind: persisted.kind, state: {} }],
      });
    }

    // Overlay with live devices (one row per functional channel)
    for (const [mac, dev] of this.connector.getAllDevices()) {
      const rows = this.getChannelRows(dev);

      // Determine if this is a multi-channel device (for name suffix)
      const multiChannel = rows.length > 1;

      for (const { primary: ch } of rows) {
        const hmAddress = this.registry.getChannelHmAddress(mac, ch.shellyIdx) || '';
        const channelKey = `${mac}:${ch.shellyIdx}`;
        const stateKey = `${ch.shellyComponent}:${ch.shellyIdx}`;
        const channelState = dev.state[stateKey] || {};
        const label = multiChannel ? ` (Ch ${ch.shellyIdx + 1})` : '';

        result.set(channelKey, {
          address: channelKey,
          mac,
          channelIdx: ch.shellyIdx,
          hmAddress,
          name: `${dev.info.name}${label}`,
          model: dev.info.model,
          gen: dev.info.gen,
          ip: dev.info.ip,
          online: dev.online,
          exposed: this.isExposed(mac, ch.shellyIdx),
          channels: [{ idx: ch.shellyIdx, kind: ch.kind, state: channelState }],
        });
      }
    }

    return result;
  }

  // Computes the HM device rows for a Shelly: one per functional channel.
  // A POWERMETER sharing an idx with an actuator becomes that row's `meter`
  // companion (HM channel 2) instead of a standalone device.
  private getChannelRows(dev: DiscoveredDevice): ChannelRow[] {
    const all = inferChannelKinds(dev.info.gen, dev.info.model, dev.state)
      .filter(c => c.kind !== 'MAINTENANCE');
    const actuatorIdxs = new Set(
      all.filter(c => ACTUATOR_KINDS.has(c.kind)).map(c => c.shellyIdx)
    );
    return all
      .filter(c => !(c.kind === 'POWERMETER' && actuatorIdxs.has(c.shellyIdx)))
      .map(primary => ({
        primary,
        meter: ACTUATOR_KINDS.has(primary.kind)
          ? all.find(c => c.kind === 'POWERMETER' && c.shellyIdx === primary.shellyIdx)
          : undefined,
      }));
  }

  private isExposed(mac: string, shellyIdx: number): boolean {
    const channelKey = `${mac}:${shellyIdx}`;
    const explicit = Object.prototype.hasOwnProperty.call(this.exposedOverrides, channelKey);
    return explicit ? !!this.exposedOverrides[channelKey] : this.config.devices.defaultExposed;
  }

  isCcuRegistered(): boolean {
    return this.hmInterface.isRegistered();
  }

  getHmPort(): number {
    return this.config.hm.port;
  }

  getInterfaceName(): string {
    return this.config.hm.interfaceName;
  }

  // address = "${mac}:${channelIdx}"
  async setDeviceExposed(address: string, exposed: boolean): Promise<void> {
    this.exposedOverrides[address] = exposed;
    const { mac, channelIdx } = parseChannelKey(address);
    const hmAddress = this.registry.getChannelHmAddress(mac, channelIdx);
    if (!hmAddress) return;
    const dev = this.connector.getAllDevices().get(mac);
    if (!dev) return;
    if (exposed) {
      const devInfo = this.buildChannelDeviceInfo(mac, channelIdx, hmAddress, dev);
      if (devInfo) {
        this.hmInterface.notifyNewDevices([devInfo]);
        this.scheduleCcuRename(hmAddress, this.ccuNameFor(dev, this.getChannelRows(dev), channelIdx));
      }
    } else {
      this.hmInterface.notifyDeleteDevices([hmAddress]);
    }
  }

  async setRelayState(address: string, channel: number, on: boolean): Promise<void> {
    await this.connector.setRelay(parseChannelKey(address).mac, channel, on);
  }

  async setLevel(address: string, channel: number, level: number): Promise<void> {
    await this.connector.setLevel(parseChannelKey(address).mac, channel, level);
  }

  async coverCommand(address: string, channel: number, cmd: 'open' | 'close' | 'stop'): Promise<void> {
    await this.connector.coverCommand(parseChannelKey(address).mac, channel, cmd);
  }

  discoverNow(): void {
    this.connector.discoverNow();
  }

  private static sigFor(rows: ChannelRow[]): string {
    return rows.map(r => `${r.primary.shellyIdx}:${r.primary.kind}:${r.meter ? 'M' : '-'}`).join(',');
  }

  // Registers channels in the registry and announces exposed ones to the CCU.
  // Safe to call on every event — acts only when the channel layout changed.
  private syncDeviceRegistration(mac: string): void {
    const dev = this.connector.getAllDevices().get(mac);
    if (!dev) return;

    const rows = this.getChannelRows(dev);
    const sig = ShellyBridge.sigFor(rows);
    if (this.channelSigs.get(mac) === sig) return;
    this.channelSigs.set(mac, sig);
    if (rows.length === 0) return; // nothing inferable yet (no state)

    getLogger().info(`Registering ${dev.info.model} ${mac}: ${sig}`);
    this.registry.updateDeviceMeta(mac, {
      name: dev.info.name,
      model: dev.info.model,
      gen: dev.info.gen,
      ip: dev.info.ip,
    });
    for (const { primary } of rows) {
      this.registry.getOrCreateChannel(mac, primary.shellyIdx, primary.kind as ChannelKind);
      this.registry.updateChannelKind(mac, primary.shellyIdx, primary.kind as ChannelKind);
    }

    // Debounced: every layout change resets the timer; rows/sig are recomputed
    // at fire time so only the settled layout is ever announced.
    const existing = this.announceTimers.get(mac);
    if (existing) clearTimeout(existing);
    this.announceTimers.set(mac, setTimeout(() => {
      this.announceTimers.delete(mac);
      const current = this.connector.getAllDevices().get(mac);
      if (!current) return;
      const settledRows = this.getChannelRows(current);
      if (settledRows.length === 0) return;
      this.announceIfChanged(mac, current, settledRows, ShellyBridge.sigFor(settledRows));
    }, ShellyBridge.ANNOUNCE_SETTLE_MS));
  }

  // Announces exposed channels to the registered CCU. Fires when either the
  // channel layout changed since we last announced (persisted announcedSig) OR
  // we haven't announced this device to the current CCU session yet (the CCU may
  // have forgotten it across its reboot/relearn). Only a layout change does a
  // deleteDevices first (that wipes CCU room/program assignments); a plain
  // session re-announce uses newDevices alone, which refreshes the device in
  // place. The CCU fills its Posteingang from newDevices, not listDevices.
  private announceIfChanged(mac: string, dev: DiscoveredDevice, rows: ChannelRow[], sig: string): void {
    if (!this.hmInterface.isRegistered()) return; // handled in onCcuRegistered
    const announced = this.registry.getAnnouncedSig(mac);
    const layoutChanged = announced !== sig;
    if (!layoutChanged && this.sessionAnnounced.has(mac)) return;

    for (const { primary } of rows) {
      if (!this.isExposed(mac, primary.shellyIdx)) continue;
      const hmAddress = this.registry.getChannelHmAddress(mac, primary.shellyIdx);
      if (!hmAddress) continue;
      const devInfo = this.buildChannelDeviceInfo(mac, primary.shellyIdx, hmAddress, dev);
      if (!devInfo) continue;
      if (layoutChanged && announced) this.hmInterface.notifyDeleteDevices([hmAddress]);
      this.hmInterface.notifyNewDevices([devInfo]);
      this.scheduleCcuRename(hmAddress, this.ccuNameFor(dev, rows, primary.shellyIdx));
    }
    this.registry.setAnnouncedSig(mac, sig);
    this.sessionAnnounced.add(mac);
  }

  // The Shelly's display name for one HM device row — same convention as the
  // Web UI: multi-channel Shellys get a " (Ch N)" suffix. Returns null for
  // unnamed devices (their name defaults to the bare mac).
  private ccuNameFor(dev: DiscoveredDevice, rows: ChannelRow[], shellyIdx: number): string | null {
    const name = dev.info.name?.trim();
    if (!name || name.toLowerCase() === dev.info.mac.toLowerCase()) return null;
    const label = rows.length > 1 ? ` (Ch ${shellyIdx + 1})` : '';
    return `${name}${label}`;
  }

  // ReGa names devices "TYPE SHELLYnnnn" by default; the Shelly's own name
  // only exists in ReGa's DOM, so we set it via a ReGa script (HVI pattern,
  // see RegaClient). ReGa processes our newDevices asynchronously — retry a
  // few times while the device hasn't materialized yet. The script itself
  // never overwrites a user-assigned name (it only renames default names).
  private scheduleCcuRename(hmAddress: string, name: string | null, attempt = 0): void {
    if (!name || !this.config.hm.regaUrl) return;
    setTimeout(async () => {
      const result = await renameCcuDevice(this.config.hm.regaUrl!, hmAddress, name);
      if (result === 'renamed') {
        getLogger().info(`CCU device ${hmAddress} named "${name}"`);
      } else if (result === 'conflict') {
        getLogger().warn(`CCU rename of ${hmAddress} skipped: name "${name}" already in use`);
      } else if ((result === 'notfound' || result === null) && attempt < 5) {
        this.scheduleCcuRename(hmAddress, name, attempt + 1);
      }
    }, 5000);
  }

  // Called when a CCU registers via init() (or when we restore a persisted
  // callback after a restart). On a DESCRIPTOR_VERSION bump we first delete all
  // previously learned devices so the CCU drops its cached descriptions and
  // relearns. Then we reset the session-announce set so every exposed device is
  // re-announced to this (possibly rebooted, forgetful) CCU — both the ones
  // already discovered now, and any discovered later via the deviceEvent path
  // (announceIfChanged), since at startup-restore time discovery hasn't run yet.
  private onCcuRegistered(): void {
    if (this.registry.getDescriptorVersion() !== DESCRIPTOR_VERSION) {
      const addresses = [...new Set(this.registry.getAllPersistedChannels().map(c => c.hmAddress))];
      if (addresses.length > 0) {
        getLogger().info(`Descriptor version changed → deleting ${addresses.length} device(s) so the CCU relearns`);
        this.hmInterface.notifyDeleteDevices(addresses);
      }
      this.registry.clearAnnouncedSigs();
      this.registry.setDescriptorVersion(DESCRIPTOR_VERSION);
    }

    this.sessionAnnounced.clear();
    for (const [mac, dev] of this.connector.getAllDevices()) {
      const rows = this.getChannelRows(dev);
      if (rows.length === 0) continue;
      this.announceIfChanged(mac, dev, rows, ShellyBridge.sigFor(rows));
    }
  }

  private onShellyEvent(
    hmAddress: string,
    mac: string,
    component: string,
    idx: number,
    shellyKey: string,
    shellyValue: unknown
  ): void {
    if (!this.isExposed(mac, idx)) return;

    const dev = this.connector.getAllDevices().get(mac);
    if (!dev) return;

    const channels = inferChannelKinds(dev.info.gen, dev.info.model, dev.state);
    const ch = channels.find(c => c.shellyComponent === component && c.shellyIdx === idx);
    if (!ch) return;

    const mapped = CHANNEL_VALUE_MAPS[ch.kind].toHomematic(shellyKey, shellyValue);
    if (!mapped) return;

    this.hmInterface.pushEvent(hmAddress, this.hmChannelFor(ch.kind, mapped.hmKey, channels, idx), mapped.hmKey, mapped.hmValue);
  }

  // HM channel routing: 0 = MAINTENANCE, 1 = functional channel, 2 = companion
  // POWERMETER on actuator+meter combos (HM-ES-PMSw1-Pl layout)
  private hmChannelFor(kind: string, hmKey: string, channels: ChannelMapping[], shellyIdx: number): number {
    if (kind === 'MAINTENANCE') return 0;
    if (POWER_KEYS.has(hmKey)) {
      const hasActuator = channels.some(c => ACTUATOR_KINDS.has(c.kind) && c.shellyIdx === shellyIdx);
      if (hasActuator) return 2;
    }
    return 1;
  }

  private async onCcuSetValue(hmAddress: string, channelIdx: number, key: string, value: unknown): Promise<void> {
    const ref = this.registry.getMacAndChannel(hmAddress);
    if (!ref) { getLogger().warn(`setValue: unknown hmAddress ${hmAddress}`); return; }
    const { mac, channelIdx: shellyIdx } = ref;
    const dev = this.connector.getAllDevices().get(mac);
    if (!dev) return;

    const row = this.getChannelRows(dev).find(r => r.primary.shellyIdx === shellyIdx);
    if (!row) return;
    const ch = row.primary;

    const toShelly = CHANNEL_VALUE_MAPS[ch.kind].toShelly(key, value);
    if (!toShelly) return;

    getLogger().debug(`CCU setValue → Shelly ${mac} ch${shellyIdx} ${key}=${value}`);

    switch (toShelly.shellyMethod) {
      case 'setRelay':
        await this.connector.setRelay(mac, shellyIdx, !!toShelly.shellyParams.on);
        break;
      case 'setLevel':
        await this.connector.setLevel(mac, shellyIdx, toShelly.shellyParams.level as number);
        break;
      case 'coverGoToPosition':
        await this.connector.coverGoToPosition(mac, shellyIdx, toShelly.shellyParams.pos as number);
        break;
      case 'coverCommand':
        await this.connector.coverCommand(mac, shellyIdx, toShelly.shellyParams.cmd as 'open' | 'close' | 'stop');
        break;
    }
  }

  private pushAllStatesToCcu(): void {
    for (const [mac, dev] of this.connector.getAllDevices()) {
      const channels = inferChannelKinds(dev.info.gen, dev.info.model, dev.state);
      for (const row of this.getChannelRows(dev)) {
        if (!this.isExposed(mac, row.primary.shellyIdx)) continue;
        const hmAddress = this.registry.getChannelHmAddress(mac, row.primary.shellyIdx);
        if (!hmAddress) continue;

        const pushState = (ch: ChannelMapping) => {
          const state = dev.state[`${ch.shellyComponent}:${ch.shellyIdx}`] || {};
          for (const [shellyKey, shellyValue] of Object.entries(state)) {
            const mapped = CHANNEL_VALUE_MAPS[ch.kind].toHomematic(shellyKey, shellyValue);
            if (!mapped) continue;
            const hmCh = this.hmChannelFor(ch.kind, mapped.hmKey, channels, ch.shellyIdx);
            this.hmInterface.pushEvent(hmAddress, hmCh, mapped.hmKey, mapped.hmValue);
          }
        };
        pushState(row.primary);
        if (row.meter && row.meter.shellyComponent !== row.primary.shellyComponent) pushState(row.meter);
      }
    }
  }

  private getExposedDeviceInfos(): DeviceInfo[] {
    const infos: DeviceInfo[] = [];
    for (const [mac, dev] of this.connector.getAllDevices()) {
      for (const { primary } of this.getChannelRows(dev)) {
        if (!this.isExposed(mac, primary.shellyIdx)) continue;
        const hmAddress = this.registry.getChannelHmAddress(mac, primary.shellyIdx);
        if (!hmAddress) continue;
        const devInfo = this.buildChannelDeviceInfo(mac, primary.shellyIdx, hmAddress, dev);
        if (devInfo) infos.push(devInfo);
      }
    }
    return infos;
  }

  // Builds a single-channel HM device for one Shelly channel
  private buildChannelDeviceInfo(
    mac: string,
    shellyIdx: number,
    hmAddress: string,
    dev: DiscoveredDevice
  ): DeviceInfo | null {
    const row = this.getChannelRows(dev).find(r => r.primary.shellyIdx === shellyIdx);
    if (!row) return null;

    // Runs raw component state through the value maps so getParamset/getValue
    // serve HM semantics (e.g. WATER enum, CURRENT in mA)
    const toHmState = (kind: ChannelKind, state: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(state)) {
        const mapped = CHANNEL_VALUE_MAPS[kind].toHomematic(k, v);
        if (mapped) out[mapped.hmKey] = mapped.hmValue;
      }
      return out;
    };

    const channels: Array<{ kind: ChannelKind; channelIdx: number }> = [
      { kind: row.primary.kind as ChannelKind, channelIdx: 1 }, // channel 1 = functional, 0 = MAINTENANCE
    ];
    if (row.meter) channels.push({ kind: 'POWERMETER', channelIdx: 2 });

    return {
      hmAddress,
      mac,
      model: dev.info.model,
      channels,
      getState: (channelIdx: number) => {
        if (channelIdx === 0) {
          const state = toHmState('MAINTENANCE', dev.state['maintenance:0'] || {});
          state.UNREACH = !dev.online;
          return state;
        }
        if (channelIdx === 1) {
          return toHmState(row.primary.kind, dev.state[`${row.primary.shellyComponent}:${shellyIdx}`] || {});
        }
        if (channelIdx === 2 && row.meter) {
          // Power data can live on the actuator component (Gen2 switch) and/or
          // a separate meter component (Gen1)
          const raw = {
            ...dev.state[`${row.primary.shellyComponent}:${shellyIdx}`],
            ...dev.state[`${row.meter.shellyComponent}:${shellyIdx}`],
          };
          return toHmState('POWERMETER', raw);
        }
        return {};
      },
    };
  }
}
