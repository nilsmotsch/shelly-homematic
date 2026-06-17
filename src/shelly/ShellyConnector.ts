import { EventEmitter } from 'events';
import { ShellyDiscovery, ShellyInfo } from './ShellyDiscovery';
import { Gen1Client } from './Gen1Client';
import { Gen2Client } from './Gen2Client';
import { CoIoTListener, CoIoTUpdate } from './CoIoTListener';
import { getLogger } from '../utils/Logger';

export interface DeviceEvent {
  address: string; // MAC
  component: string;
  idx: number;
  key: string;
  value: unknown;
}

export interface DiscoveredDevice {
  info: ShellyInfo;
  gen1?: Gen1Client;
  gen2?: Gen2Client;
  online: boolean;
  state: Record<string, Record<string, unknown>>; // component:idx -> {key->value}
}

interface ConnectorConfig {
  discovery: { mdns: boolean; rescanInterval: number };
  manualDevices: string[];
  pollInterval: number;
}

interface Auth { user: string; pass: string }

export class ShellyConnector extends EventEmitter {
  private config: ConnectorConfig;
  private auth?: Auth;
  private discovery: ShellyDiscovery;
  private coiot: CoIoTListener;
  private devices = new Map<string, DiscoveredDevice>();

  constructor(config: ConnectorConfig, auth?: Auth) {
    super();
    this.config = config;
    this.auth = auth;
    this.discovery = new ShellyDiscovery({
      rescanInterval: config.discovery.mdns ? config.discovery.rescanInterval : 0,
      manualDevices: config.manualDevices,
    });
    this.coiot = new CoIoTListener();
  }

  start(): void {
    this.discovery.on('deviceFound', (info) => this.onDeviceFound(info));
    this.discovery.start();
    this.coiot.on('coiotUpdate', (u) => this.onCoIoTUpdate(u));
    this.coiot.start();
  }

  stop(): void {
    this.discovery.stop();
    this.coiot.stop();
    for (const [, dev] of this.devices) {
      dev.gen1?.stopPolling();
      dev.gen2?.disconnect();
    }
  }

  discoverNow(): void {
    getLogger().info('Manual rediscovery triggered');
    this.discovery.start();
  }

  async setRelay(address: string, channel: number, on: boolean): Promise<void> {
    const dev = this.devices.get(address);
    if (!dev) throw new Error(`Device ${address} not found`);
    if (dev.gen2) {
      await dev.gen2.setSwitch(channel, on);
    } else if (dev.gen1) {
      await dev.gen1.setRelay(channel, on);
    }
  }

  async toggleRelay(address: string, channel: number): Promise<void> {
    const dev = this.devices.get(address);
    if (!dev) throw new Error(`Device ${address} not found`);
    if (dev.gen2) {
      await dev.gen2.toggleSwitch(channel);
    } else if (dev.gen1) {
      await dev.gen1.toggleRelay(channel);
    }
  }

  async setLevel(address: string, channel: number, levelPct: number): Promise<void> {
    const dev = this.devices.get(address);
    if (!dev) throw new Error(`Device ${address} not found`);
    const on = levelPct > 0;
    if (dev.gen2) {
      await dev.gen2.setLight(channel, on, levelPct);
    } else if (dev.gen1) {
      await dev.gen1.setLight(levelPct, on);
    }
  }

  async coverCommand(address: string, channel: number, cmd: 'open' | 'close' | 'stop'): Promise<void> {
    const dev = this.devices.get(address);
    if (!dev) throw new Error(`Device ${address} not found`);
    if (dev.gen2) {
      if (cmd === 'open') await dev.gen2.coverOpen(channel);
      else if (cmd === 'close') await dev.gen2.coverClose(channel);
      else await dev.gen2.coverStop(channel);
    } else if (dev.gen1) {
      await dev.gen1.setRoller(cmd);
    }
  }

  // pos: Shelly convention, 0=closed … 100=open
  async coverGoToPosition(address: string, channel: number, pos: number): Promise<void> {
    const dev = this.devices.get(address);
    if (!dev) throw new Error(`Device ${address} not found`);
    if (dev.gen2) {
      await dev.gen2.coverGoToPosition(channel, pos);
    } else if (dev.gen1) {
      await dev.gen1.setRoller('open', pos);
    }
  }

  getDeviceState(address: string): Record<string, Record<string, unknown>> {
    return this.devices.get(address)?.state || {};
  }

  getAllDevices(): Map<string, DiscoveredDevice> {
    return this.devices;
  }

  async refreshAllStatuses(): Promise<void> {
    for (const [addr, dev] of this.devices) {
      try {
        if (dev.gen2) {
          const status = await dev.gen2.getStatus();
          this.applyGen2Status(addr, status);
        } else if (dev.gen1) {
          const status = await dev.gen1.getStatus();
          this.applyGen1Status(addr, status);
        }
      } catch (err) {
        getLogger().debug(`Status refresh failed for ${addr}: ${err}`);
      }
    }
  }

  private onDeviceFound(info: ShellyInfo): void {
    if (this.devices.has(info.mac)) {
      // Update IP in case it changed via DHCP
      const dev = this.devices.get(info.mac)!;
      dev.info.ip = info.ip;
      return;
    }

    getLogger().info(`Connecting to Shelly ${info.model} ${info.mac} at ${info.ip}`);

    const dev: DiscoveredDevice = { info, online: false, state: {} };

    if (info.gen === 2) {
      const client = new Gen2Client(info.ip, this.auth);
      client.on('update', (u) => this.onUpdate(info.mac, u.component, u.idx, u.key, u.value));
      client.on('online', () => { dev.online = true; });
      client.on('offline', () => { dev.online = false; this.emit('deviceOffline', info.mac); });
      client.connect();
      dev.gen2 = client;
    } else {
      const client = new Gen1Client(info.ip, this.config.pollInterval, this.auth);
      client.on('update', (u) => this.onUpdate(info.mac, u.component, u.idx, u.key, u.value));
      client.startPolling();
      dev.gen1 = client;
      dev.online = true;
    }

    this.devices.set(info.mac, dev);
    this.emit('deviceFound', info);
  }

  private onUpdate(address: string, component: string, idx: number, key: string, value: unknown): void {
    const dev = this.devices.get(address);
    if (!dev) return;
    const stateKey = `${component}:${idx}`;
    if (!dev.state[stateKey]) dev.state[stateKey] = {};
    if (dev.state[stateKey][key] === value) return; // no change
    dev.state[stateKey][key] = value;
    this.emit('deviceEvent', { address, component, idx, key, value });
  }

  private onCoIoTUpdate(u: CoIoTUpdate): void {
    const dev = this.devices.get(u.mac);
    if (!dev) {
      // First time seeing this device via CoIoT — probe it
      this.discovery.probe(u.ip);
      return;
    }
    dev.online = true;
    // CoIoT data is raw sensor readings — pass through as generic sensor updates
    for (const { id, value } of u.data) {
      // Map common CoIoT data IDs to component/key (abbreviated mapping)
      const mapping = COIOT_ID_MAP[id];
      if (mapping) {
        this.onUpdate(u.mac, mapping.component, mapping.idx, mapping.key, value);
      }
    }
  }

  private applyGen2Status(address: string, status: Record<string, unknown>): void {
    // Fake update events from a full status response
    const gen2 = this.devices.get(address)?.gen2;
    if (!gen2) return;
    // Re-emit all known keys by diffing against current state
    const dev = this.devices.get(address)!;
    for (const [key, val] of Object.entries(status)) {
      if (typeof val === 'object' && val !== null) {
        const v = val as Record<string, unknown>;
        const swM = key.match(/^switch:(\d+)$/);
        if (swM) {
          const idx = parseInt(swM[1]);
          if (v.output !== undefined) this.onUpdate(address, 'switch', idx, 'STATE', !!v.output);
        }
        const ltM = key.match(/^light:(\d+)$/);
        if (ltM) {
          const idx = parseInt(ltM[1]);
          if (v.brightness !== undefined) this.onUpdate(address, 'light', idx, 'LEVEL', (v.brightness as number) / 100);
        }
        const cvM = key.match(/^cover:(\d+)$/);
        if (cvM) {
          const idx = parseInt(cvM[1]);
          if (v.current_pos !== undefined) this.onUpdate(address, 'cover', idx, 'LEVEL', (v.current_pos as number) / 100);
        }
        const pmM = key.match(/^(pm1|em1):(\d+)$/);
        if (pmM) {
          const idx = parseInt(pmM[2]);
          const power = v.apower !== undefined ? v.apower : v.act_power;
          if (power !== undefined) this.onUpdate(address, pmM[1], idx, 'POWER', power);
        }
        const tpM = key.match(/^temperature:(\d+)$/);
        if (tpM) {
          const idx = parseInt(tpM[1]);
          if (v.tC !== undefined) this.onUpdate(address, 'temperature', idx, 'TEMPERATURE', v.tC);
        }
      }
    }
    dev.online = true;
  }

  private applyGen1Status(address: string, status: Record<string, unknown>): void {
    const dev = this.devices.get(address);
    if (!dev) return;
    dev.online = true;
    const relays = status.relays as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(relays)) {
      relays.forEach((r, idx) => {
        if (r.ison !== undefined) this.onUpdate(address, 'relay', idx, 'STATE', !!r.ison);
      });
    }
    const lights = status.lights as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(lights)) {
      lights.forEach((l, idx) => {
        if (l.brightness !== undefined) this.onUpdate(address, 'light', idx, 'LEVEL', (l.brightness as number) / 100);
      });
    }
    const rollers = status.rollers as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(rollers)) {
      rollers.forEach((r, idx) => {
        if (r.current_pos !== undefined) this.onUpdate(address, 'roller', idx, 'LEVEL', (r.current_pos as number) / 100);
      });
    }
    const thermometers = status.thermometers as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(thermometers)) {
      thermometers.forEach((t, idx) => {
        if (t.tC !== undefined) this.onUpdate(address, 'sensor', idx, 'TEMPERATURE', t.tC);
      });
    }
  }
}

// Abbreviated CoIoT data ID map for common sensor IDs (from the official CoIoT spec)
const COIOT_ID_MAP: Record<number, { component: string; idx: number; key: string }> = {
  // Temperature (H&T, Door/Window 2, etc.)
  3101: { component: 'sensor', idx: 0, key: 'TEMPERATURE' },
  // Humidity (H&T)
  3103: { component: 'sensor', idx: 0, key: 'HUMIDITY' },
  // Flood (Flood sensor)
  6106: { component: 'sensor', idx: 0, key: 'STATE' },
  // Door/Window
  3108: { component: 'sensor', idx: 0, key: 'STATE' },
  // Motion
  6107: { component: 'sensor', idx: 0, key: 'MOTION' },
  // Battery
  3111: { component: 'maintenance', idx: 0, key: 'OPERATING_VOLTAGE' },
};
