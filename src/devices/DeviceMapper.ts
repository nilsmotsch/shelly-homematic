import { ChannelKind } from '../hm/HmDeviceModel';
import * as fs from 'fs';
import * as path from 'path';

export interface ChannelMapping {
  kind: ChannelKind;
  shellyComponent: string;
  shellyIdx: number;
}

export interface MappedDevice {
  mac: string;
  hmAddress: string;
  model: string;
  gen: 1 | 2;
  channels: ChannelMapping[];
}

// Converts a Shelly raw state (component:idx -> {key->value}) to HM paramset values
// and back, per channel kind.
export interface ValueMapping {
  toHomematic(shellyKey: string, shellyValue: unknown): { hmKey: string; hmValue: unknown } | null;
  toShelly(hmKey: string, hmValue: unknown): { shellyMethod: string; shellyParams: Record<string, unknown> } | null;
}

export const CHANNEL_VALUE_MAPS: Record<ChannelKind, ValueMapping> = {
  SWITCH: {
    toHomematic(key, value) {
      if (key === 'STATE') return { hmKey: 'STATE', hmValue: !!value };
      // Power readings on a switch component belong to the companion
      // POWERMETER channel (HM channel 2) — the bridge routes them there.
      if (key === 'POWER') return { hmKey: 'POWER', hmValue: value };
      if (key === 'ENERGY_COUNTER') return { hmKey: 'ENERGY_COUNTER', hmValue: value };
      if (key === 'VOLTAGE') return { hmKey: 'VOLTAGE', hmValue: value };
      if (key === 'CURRENT') return { hmKey: 'CURRENT', hmValue: (value as number) * 1000 }; // A → mA
      if (key === 'FREQUENCY') return { hmKey: 'FREQUENCY', hmValue: value };
      return null;
    },
    toShelly(hmKey, hmValue) {
      if (hmKey === 'STATE') return { shellyMethod: 'setRelay', shellyParams: { on: !!hmValue } };
      // TOGGLE is a momentary ACTION: any write flips the relay via Shelly's
      // native toggle command (Gen2 Switch.Toggle / Gen1 ?turn=toggle), so the
      // value carries no meaning. Lets programs say "umschalten" in one step.
      if (hmKey === 'TOGGLE') return { shellyMethod: 'toggleRelay', shellyParams: {} };
      return null;
    },
  },

  DIMMER: {
    toHomematic(key, value) {
      if (key === 'LEVEL') return { hmKey: 'LEVEL', hmValue: value }; // already 0-1
      if (key === 'STATE') return { hmKey: 'LEVEL', hmValue: value ? 1.0 : 0.0 };
      return null;
    },
    toShelly(hmKey, hmValue) {
      if (hmKey === 'LEVEL') {
        const pct = Math.round((hmValue as number) * 100);
        return { shellyMethod: 'setLevel', shellyParams: { level: pct } };
      }
      return null;
    },
  },

  BLIND: {
    toHomematic(key, value) {
      // HM convention: LEVEL 0.0 = closed, 1.0 = open (same as Shelly pos/100,
      // normalized in the clients)
      if (key === 'LEVEL') return { hmKey: 'LEVEL', hmValue: value };
      if (key === 'WORKING') return { hmKey: 'WORKING', hmValue: !!value };
      return null;
    },
    toShelly(hmKey, hmValue) {
      if (hmKey === 'LEVEL') {
        const shellyPos = Math.round((hmValue as number) * 100);
        return { shellyMethod: 'coverGoToPosition', shellyParams: { pos: shellyPos } };
      }
      if (hmKey === 'STOP') return { shellyMethod: 'coverCommand', shellyParams: { cmd: 'stop' } };
      return null;
    },
  },

  WEATHER: {
    toHomematic(key, value) {
      if (key === 'TEMPERATURE') return { hmKey: 'TEMPERATURE', hmValue: value };
      if (key === 'HUMIDITY') return { hmKey: 'HUMIDITY', hmValue: value };
      return null;
    },
    toShelly(_hmKey, _hmValue) { return null; },
  },

  CONTACT: {
    toHomematic(key, value) {
      if (key === 'STATE') return { hmKey: 'STATE', hmValue: !!value };
      return null;
    },
    toShelly(_hmKey, _hmValue) { return null; },
  },

  MOTION: {
    toHomematic(key, value) {
      if (key === 'MOTION') return { hmKey: 'MOTION', hmValue: !!value };
      // Shelly reports lux; HM-Sec-MDIR BRIGHTNESS is a unitless 0-255 scale
      if (key === 'ILLUMINATION' || key === 'BRIGHTNESS') {
        return { hmKey: 'BRIGHTNESS', hmValue: Math.max(0, Math.min(255, Math.round(value as number))) };
      }
      return null;
    },
    toShelly(_hmKey, _hmValue) { return null; },
  },

  WATER: {
    toHomematic(key, value) {
      // HM-Sec-WDS STATE enum: 0=DRY, 1=WET, 2=WATER
      if (key === 'STATE') return { hmKey: 'STATE', hmValue: value ? 2 : 0 };
      return null;
    },
    toShelly(_hmKey, _hmValue) { return null; },
  },

  POWERMETER: {
    toHomematic(key, value) {
      if (key === 'POWER') return { hmKey: 'POWER', hmValue: value };
      if (key === 'ENERGY_COUNTER') return { hmKey: 'ENERGY_COUNTER', hmValue: value };
      if (key === 'VOLTAGE') return { hmKey: 'VOLTAGE', hmValue: value };
      if (key === 'CURRENT') return { hmKey: 'CURRENT', hmValue: (value as number) * 1000 }; // A → mA
      if (key === 'FREQUENCY') return { hmKey: 'FREQUENCY', hmValue: value };
      return null;
    },
    toShelly(_hmKey, _hmValue) { return null; },
  },

  MAINTENANCE: {
    toHomematic(key, value) {
      if (key === 'LOWBAT' || key === 'LOW_BAT') return { hmKey: 'LOWBAT', hmValue: !!value };
      if (key === 'OPERATING_VOLTAGE') return { hmKey: 'OPERATING_VOLTAGE', hmValue: value };
      if (key === 'UNREACH') return { hmKey: 'UNREACH', hmValue: !!value };
      return null;
    },
    toShelly(_hmKey, _hmValue) { return null; },
  },
};

// Determine channel kinds from Shelly model info
export function inferChannelKinds(
  gen: 1 | 2,
  model: string,
  shellyState: Record<string, Record<string, unknown>>
): ChannelMapping[] {
  const channels: ChannelMapping[] = [];

  // Always add maintenance channel
  channels.push({ kind: 'MAINTENANCE', shellyComponent: 'maintenance', shellyIdx: 0 });

  // Infer from live state keys
  const seenComponents = new Set<string>();
  for (const key of Object.keys(shellyState)) {
    const [component, idxStr] = key.split(':');
    const idx = parseInt(idxStr || '0');
    const compKey = `${component}:${idx}`;
    if (seenComponents.has(compKey)) continue;
    seenComponents.add(compKey);

    if (component === 'switch' || component === 'relay') {
      // Check if it has POWER key → add POWERMETER too
      const state = shellyState[key];
      channels.push({ kind: 'SWITCH', shellyComponent: component, shellyIdx: idx });
      if ('POWER' in state || 'ENERGY_COUNTER' in state) {
        channels.push({ kind: 'POWERMETER', shellyComponent: 'meter', shellyIdx: idx });
      }
    } else if (component === 'light') {
      channels.push({ kind: 'DIMMER', shellyComponent: component, shellyIdx: idx });
    } else if (component === 'cover' || component === 'roller') {
      channels.push({ kind: 'BLIND', shellyComponent: component, shellyIdx: idx });
    } else if (component === 'temperature' || component === 'sensor') {
      const state = shellyState[key];
      if ('TEMPERATURE' in state || 'HUMIDITY' in state) {
        // Check if we already added a WEATHER channel at same idx
        if (!channels.some(c => c.kind === 'WEATHER' && c.shellyIdx === idx)) {
          channels.push({ kind: 'WEATHER', shellyComponent: component, shellyIdx: idx });
        }
      } else if ('MOTION' in state) {
        channels.push({ kind: 'MOTION', shellyComponent: component, shellyIdx: idx });
      } else if ('STATE' in state) {
        // Flood vs contact — use model name heuristic (SHWT-1 = Gen1 Shelly Flood)
        const lm = model.toLowerCase();
        if (lm.includes('flood') || lm.includes('water') || lm.includes('shwt')) {
          channels.push({ kind: 'WATER', shellyComponent: component, shellyIdx: idx });
        } else {
          channels.push({ kind: 'CONTACT', shellyComponent: component, shellyIdx: idx });
        }
      }
    } else if (component === 'humidity') {
      // Merge into WEATHER channel if already present for this idx
      if (!channels.some(c => c.kind === 'WEATHER' && c.shellyIdx === idx)) {
        channels.push({ kind: 'WEATHER', shellyComponent: component, shellyIdx: idx });
      }
    } else if (component === 'meter' || component === 'pm1' || component === 'em1') {
      if (!channels.some(c => c.kind === 'POWERMETER' && c.shellyIdx === idx)) {
        channels.push({ kind: 'POWERMETER', shellyComponent: component, shellyIdx: idx });
      }
    }
  }

  // Gen1 fallback: if no state keys yet, use model name
  if (channels.length === 1 && gen === 1) {
    const lm = model.toLowerCase();
    if (lm.includes('dimmer') || lm.includes('bulb') || lm.includes('duo')) {
      channels.push({ kind: 'DIMMER', shellyComponent: 'light', shellyIdx: 0 });
    } else if (lm.includes('roller') || lm.includes('2.5') || lm.includes('shelly2')) {
      channels.push({ kind: 'BLIND', shellyComponent: 'roller', shellyIdx: 0 });
    } else if (lm.includes('ht') || lm.includes('h&t')) {
      channels.push({ kind: 'WEATHER', shellyComponent: 'sensor', shellyIdx: 0 });
    } else if (lm.includes('flood') || lm.includes('shwt')) {
      channels.push({ kind: 'WATER', shellyComponent: 'sensor', shellyIdx: 0 });
    } else if (lm.includes('door') || lm.includes('window') || lm.includes('dw')) {
      channels.push({ kind: 'CONTACT', shellyComponent: 'sensor', shellyIdx: 0 });
    } else if (lm.includes('motion')) {
      channels.push({ kind: 'MOTION', shellyComponent: 'sensor', shellyIdx: 0 });
    } else {
      // Default: assume relay
      channels.push({ kind: 'SWITCH', shellyComponent: 'relay', shellyIdx: 0 });
    }
  }

  return channels;
}

// Per-channel entry in devices.json
interface PersistedChannelEntry {
  hmAddress: string;
  kind: string;
}

// Device-level metadata in devices.json
interface PersistedDeviceEntry {
  name: string;
  model: string;
  gen: 1 | 2;
  ip: string;
  // Per-channel HM addresses: channelIdx (as string) → entry
  channels: Record<string, PersistedChannelEntry>;
  // Channel-layout signature last announced to the CCU — prevents re-sending
  // deleteDevices/newDevices for an unchanged layout on every restart
  announcedSig?: string;
}

export interface PersistedChannelInfo {
  mac: string;
  channelIdx: number;
  hmAddress: string;
  kind: ChannelKind;
  name: string;
  model: string;
  gen: 1 | 2;
  ip: string;
}

// Persistent registry: maps (mac, channelIdx) ↔ HM address
// devices.json format:
// {
//   "<mac>": {
//     "name": "...", "model": "...", "gen": 2, "ip": "...",
//     "channels": { "0": { "hmAddress": "SHELLY0001", "kind": "SWITCH" }, ... }
//   }
// }
export class AddressRegistry {
  private indexPath: string;
  private devices = new Map<string, PersistedDeviceEntry>(); // mac → device
  private hmToRef = new Map<string, { mac: string; channelIdx: number }>(); // hmAddress → {mac, channelIdx}
  private nextIdx = 1;
  // Bumped when the HM device descriptions we serve change shape — lets the
  // bridge re-announce (deleteDevices+newDevices) to a CCU that cached old ones
  private descriptorVersion = 0;

  constructor(dataDir: string) {
    this.indexPath = path.join(dataDir, 'devices.json');
  }

  load(): void {
    try {
      if (!fs.existsSync(this.indexPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as Record<string, unknown>;

      for (const [mac, value] of Object.entries(raw)) {
        if (mac === '_meta') {
          const meta = value as Record<string, unknown>;
          if (typeof meta?.descriptorVersion === 'number') this.descriptorVersion = meta.descriptorVersion;
          continue;
        }
        if (typeof value === 'string') {
          // Old format: mac → hmAddress (string) — migrate to channel 0
          this.setChannelEntry(mac, 0, value, 'SWITCH');
        } else if (value && typeof value === 'object') {
          const v = value as Record<string, unknown>;
          if (typeof v.hmAddress === 'string') {
            // Old format: mac → { hmAddress, channels[] } — migrate channels to new format
            const oldChannels = (v.channels as ChannelMapping[] | undefined) || [];
            const newChannels: Record<string, PersistedChannelEntry> = {};
            if (oldChannels.length === 0) {
              newChannels['0'] = { hmAddress: v.hmAddress as string, kind: 'SWITCH' };
            } else {
              // Map old channels array to new format
              let idx = 0;
              for (const ch of oldChannels) {
                if (ch.kind === 'MAINTENANCE') continue;
                newChannels[String(ch.shellyIdx)] = { hmAddress: v.hmAddress as string, kind: ch.kind };
                idx++;
                if (idx > 1) break; // Old format was one HM addr for all channels
              }
              if (Object.keys(newChannels).length === 0) {
                newChannels['0'] = { hmAddress: v.hmAddress as string, kind: 'SWITCH' };
              }
            }
            const entry: PersistedDeviceEntry = {
              name: (v.name as string) || '',
              model: (v.model as string) || '',
              gen: (v.gen as 1 | 2) || 1,
              ip: (v.ip as string) || '',
              channels: newChannels,
            };
            this.devices.set(mac, entry);
          } else if (v.channels && typeof v.channels === 'object' && !Array.isArray(v.channels)) {
            // New format
            const entry = v as unknown as PersistedDeviceEntry;
            this.devices.set(mac, entry);
          }
        }

        // Register reverse map entries and update nextIdx
        const dev = this.devices.get(mac);
        if (dev) {
          for (const [chIdxStr, ch] of Object.entries(dev.channels)) {
            this.hmToRef.set(ch.hmAddress, { mac, channelIdx: parseInt(chIdxStr) });
            const n = parseInt(ch.hmAddress.replace('SHELLY', ''));
            if (!isNaN(n) && n >= this.nextIdx) this.nextIdx = n + 1;
          }
        }
      }
    } catch { /* ignore */ }
  }

  private setChannelEntry(mac: string, channelIdx: number, hmAddress: string, kind: string): void {
    if (!this.devices.has(mac)) {
      this.devices.set(mac, { name: '', model: '', gen: 1, ip: '', channels: {} });
    }
    const dev = this.devices.get(mac)!;
    dev.channels[String(channelIdx)] = { hmAddress, kind };
    this.hmToRef.set(hmAddress, { mac, channelIdx });
    const n = parseInt(hmAddress.replace('SHELLY', ''));
    if (!isNaN(n) && n >= this.nextIdx) this.nextIdx = n + 1;
  }

  getOrCreateChannel(mac: string, channelIdx: number, kind: ChannelKind): string {
    const dev = this.devices.get(mac);
    const existing = dev?.channels[String(channelIdx)];
    if (existing) return existing.hmAddress;

    const hmAddress = `SHELLY${String(this.nextIdx).padStart(4, '0')}`;
    this.nextIdx++;
    this.setChannelEntry(mac, channelIdx, hmAddress, kind);
    this.save();
    return hmAddress;
  }

  getChannelHmAddress(mac: string, channelIdx: number): string | undefined {
    return this.devices.get(mac)?.channels[String(channelIdx)]?.hmAddress;
  }

  getMacAndChannel(hmAddress: string): { mac: string; channelIdx: number } | undefined {
    return this.hmToRef.get(hmAddress);
  }

  // Backwards-compat alias used by bridge
  get(mac: string): string | undefined {
    // Return first channel's hmAddress if exists
    const dev = this.devices.get(mac);
    if (!dev) return undefined;
    const first = Object.values(dev.channels)[0];
    return first?.hmAddress;
  }

  getMac(hmAddress: string): string | undefined {
    return this.hmToRef.get(hmAddress)?.mac;
  }

  updateDeviceMeta(mac: string, info: { name: string; model: string; gen: 1 | 2; ip: string }): void {
    if (!this.devices.has(mac)) {
      this.devices.set(mac, { name: info.name, model: info.model, gen: info.gen, ip: info.ip, channels: {} });
    } else {
      const dev = this.devices.get(mac)!;
      Object.assign(dev, info);
    }
    this.save();
  }

  updateChannelKind(mac: string, channelIdx: number, kind: ChannelKind): void {
    const dev = this.devices.get(mac);
    if (!dev) return;
    const ch = dev.channels[String(channelIdx)];
    if (ch && ch.kind !== kind) { ch.kind = kind; this.save(); }
  }

  getAnnouncedSig(mac: string): string | undefined {
    return this.devices.get(mac)?.announcedSig;
  }

  setAnnouncedSig(mac: string, sig: string): void {
    const dev = this.devices.get(mac);
    if (!dev || dev.announcedSig === sig) return;
    dev.announcedSig = sig;
    this.save();
  }

  clearAnnouncedSigs(): void {
    for (const dev of this.devices.values()) delete dev.announcedSig;
    this.save();
  }

  getDescriptorVersion(): number {
    return this.descriptorVersion;
  }

  setDescriptorVersion(version: number): void {
    if (this.descriptorVersion === version) return;
    this.descriptorVersion = version;
    this.save();
  }

  getAllPersistedChannels(): PersistedChannelInfo[] {
    const result: PersistedChannelInfo[] = [];
    for (const [mac, dev] of this.devices) {
      for (const [chIdxStr, ch] of Object.entries(dev.channels)) {
        result.push({
          mac,
          channelIdx: parseInt(chIdxStr),
          hmAddress: ch.hmAddress,
          kind: ch.kind as ChannelKind,
          name: dev.name,
          model: dev.model,
          gen: dev.gen,
          ip: dev.ip,
        });
      }
    }
    return result;
  }

  private save(): void {
    try {
      const data: Record<string, unknown> = { _meta: { descriptorVersion: this.descriptorVersion } };
      for (const [mac, d] of this.devices) data[mac] = d;
      fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
      fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
  }
}
