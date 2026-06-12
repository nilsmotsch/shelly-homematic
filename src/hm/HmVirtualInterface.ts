import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/Logger';
import {
  ChannelKind,
  DESCRIPTOR_VERSION,
  ParamDesc,
  ParamsetDescription,
  getParamsetDescription,
  buildParamset,
  buildChannelDescription,
  buildDeviceDescription,
  deviceTypeFor,
  DeviceLayout,
} from './HmDeviceModel';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const XmlRpcDeserializer = require('xmlrpc/lib/deserializer');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const XmlRpcSerializer = require('xmlrpc/lib/serializer');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const XmlRpcCustomType = require('xmlrpc/lib/customtype');

// ReGa rejects <int> values on FLOAT datapoints/params and stores 0 instead.
// The stock serializer emits integral JS numbers as <int> (e.g. CURRENT 24 mA,
// blind LEVEL 0/1), so FLOAT-typed values must be forced to an explicit
// <double> tag — the same fix as the HVI fork's `explicitDouble`.
function xmlDouble(v: number): unknown {
  const t = new XmlRpcCustomType(v);
  t.tagName = 'double';
  return t;
}

function coerceFloat(desc: ParamDesc | undefined, value: unknown): unknown {
  if (desc?.TYPE === 'FLOAT' && typeof value === 'number' && Number.isInteger(value)) {
    return xmlDouble(value);
  }
  return value;
}

export interface DeviceInfo {
  hmAddress: string;
  mac: string;
  model: string;
  channels: Array<{ kind: ChannelKind; channelIdx: number }>;
  getState: (channelIdx: number) => Record<string, unknown>;
}

export interface HmVirtualInterfaceOptions {
  port: number;
  bindHost: string;
  interfaceId: string;
  getDevices: () => DeviceInfo[];
  onSetValue: (hmAddress: string, channelIdx: number, key: string, value: unknown) => Promise<void>;
  // Called after a CCU registered via init() — lets the bridge re-announce
  // devices whose descriptions changed since the CCU last saw them
  onCcuRegistered?: () => void;
  // Called when the CCU unlearns a device (WebUI Löschen → deleteDevice RPC).
  // The bridge unexposes the channel so it doesn't get re-announced.
  onCcuDeleteDevice?: (hmAddress: string) => void;
  // Directory for persisting CCU callbacks across restarts (see saveCallbacks).
  dataDir?: string;
}

interface CcuClient {
  methodCall(method: string, params: unknown[], cb: (err: Error | null, value?: unknown) => void): void;
}

interface CcuCallback {
  client: CcuClient;
  interfaceId: string;
  url: string;
}

export class HmVirtualInterface {
  private httpServer: http.Server;
  private opts: HmVirtualInterfaceOptions;
  // The CCU registers multiple logic-layer clients (ReGa and the Java
  // HMServer, e.g. "1009" and "ShellyHM_java") — each gets its own callback,
  // keyed by interfaceId, and every event must go to all of them.
  private ccuCallbacks = new Map<string, CcuCallback>();
  private pendingEvents: Array<{ address: string; key: string; value: unknown }> = [];
  // Where the registered callbacks are persisted. ReGa/HMServer only call
  // init() at *their* startup and never ping or re-init our ipc interface
  // afterwards, so without this an addon restart silently orphans us until the
  // CCU itself restarts. We persist the callbacks and restore them on start().
  private persistPath: string;

  constructor(opts: HmVirtualInterfaceOptions) {
    this.opts = opts;
    this.persistPath = path.join(opts.dataDir || '.', 'ccu-callbacks.json');
    // Hand-rolled HTTP server:
    // 1. Sends Content-Length (required by CCU's old C++ XML-RPC client)
    // 2. Avoids <string/> self-closing tags that the CCU XML-RPC parser rejects
    this.httpServer = http.createServer((req, res) => {
      const deserializer = new XmlRpcDeserializer();
      deserializer.deserializeMethodCall(req, (err: Error | null, methodName: string, params: unknown[]) => {
        if (err) {
          getLogger().warn(`HM RPC parse error: ${err}`);
          res.writeHead(400);
          res.end();
          return;
        }
        this.dispatchSingle(methodName, params)
          .then((result) => this.sendResponse(res, result))
          .catch((err) => {
            this.sendFault(res, -1, String(err));
          });
      });
    });
  }

  // The CCU's rfd C++ XML-RPC parser rejects self-closing empty tags and parses
  // them as nil — fatal for e.g. an empty MASTER paramset, which serializes to
  // <struct/> and makes getParamsetDescription "fail" (device → Posteingang
  // "Fehler"). Expand every empty XML-RPC container tag to an explicit pair.
  private fixSelfClosing(xml: string): string {
    return xml.replace(/<(string|struct|array|data|value|i4|int|boolean|double)\/>/g, '<$1></$1>');
  }

  // Hand-rolled XML-RPC client for callbacks to the CCU (event, newDevices,
  // deleteDevices). The stock xmlrpc client serializes empty strings/arrays as
  // self-closing tags (<string/>, <data/>), which ReGa's parser reads as nil —
  // channel descriptions in newDevices contain empty LINK_*_ROLES/GROUP/TEAM
  // strings, so ReGa created the device but dropped every channel (Posteingang
  // stuck on "Fehler"). Outbound calls must go through fixSelfClosing too.
  // Calls are FIFO-serialized per client: deleteDevices/newDevices pairs (and
  // event streams) must arrive at ReGa in send order, but independent HTTP
  // requests give no such guarantee — a raced deleteDevices arriving after the
  // final newDevices silently removed devices from ReGa again.
  private createCcuClient(urlObj: URL): CcuClient {
    const host = urlObj.hostname;
    const port = parseInt(urlObj.port || '2001');
    const reqPath = urlObj.pathname || '/';
    const fix = (xml: string) => this.fixSelfClosing(xml);
    let queue: Promise<void> = Promise.resolve();

    const doCall = (method: string, params: unknown[], cb: (err: Error | null, value?: unknown) => void): Promise<void> =>
      new Promise((resolve) => {
        let called = false;
        const done = (err: Error | null, value?: unknown) => {
          if (called) return;
          called = true;
          resolve();
          cb(err, value);
        };
        let xml: string;
        try {
          xml = fix(XmlRpcSerializer.serializeMethodCall(method, params));
        } catch (err) {
          done(err as Error);
          return;
        }
        const buf = Buffer.from(xml, 'utf8');
        const req = http.request(
          {
            host,
            port,
            path: reqPath,
            method: 'POST',
            headers: { 'Content-Type': 'text/xml', 'Content-Length': buf.length },
          },
          (res) => {
            const deserializer = new XmlRpcDeserializer();
            deserializer.deserializeMethodResponse(res, (err: Error | null, value: unknown) => done(err, value));
          }
        );
        req.setTimeout(15000, () => req.destroy(new Error('CCU callback timeout')));
        req.on('error', (err) => done(err));
        req.end(buf);
      });

    return {
      methodCall(method: string, params: unknown[], cb: (err: Error | null, value?: unknown) => void): void {
        queue = queue.then(() => doCall(method, params, cb));
      },
    };
  }

  private sendResponse(res: http.ServerResponse, value: unknown): void {
    let xml: string = XmlRpcSerializer.serializeMethodResponse(value);
    xml = this.fixSelfClosing(xml);
    const buf = Buffer.from(xml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/xml',
      'Content-Length': buf.length,
    });
    res.end(buf);
  }

  private sendFault(res: http.ServerResponse, code: number, message: string): void {
    let xml: string = XmlRpcSerializer.serializeFault({ faultCode: code, faultString: message });
    xml = this.fixSelfClosing(xml);
    const buf = Buffer.from(xml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/xml',
      'Content-Length': buf.length,
    });
    res.end(buf);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('listening', () => {
        getLogger().info(`HM virtual interface listening on ${this.opts.bindHost}:${this.opts.port}`);
        this.restoreCallbacks().finally(() => resolve());
      });
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.opts.port, this.opts.bindHost);
    });
  }

  private saveCallbacks(): void {
    try {
      const data = [...this.ccuCallbacks.values()].map(cb => ({ interfaceId: cb.interfaceId, url: cb.url }));
      fs.writeFileSync(this.persistPath, JSON.stringify(data));
    } catch (err) {
      getLogger().warn(`Failed to persist CCU callbacks: ${err}`);
    }
  }

  // On startup, re-register the callbacks the CCU gave us before we restarted —
  // the CCU won't send init() again on its own. Each is probed with a quick TCP
  // connect so we don't resurrect a callback whose ReGa is actually gone; dead
  // ones are pruned and events keep queuing in pendingEvents until a real init.
  private async restoreCallbacks(): Promise<void> {
    let saved: Array<{ interfaceId: string; url: string }>;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      saved = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
    } catch (err) {
      getLogger().warn(`Failed to read persisted CCU callbacks: ${err}`);
      return;
    }

    let restored = false;
    for (const { interfaceId, url } of saved) {
      try {
        const urlObj = new URL(url);
        const port = parseInt(urlObj.port || '2001');
        if (!(await this.probeAlive(urlObj.hostname, port))) {
          getLogger().info(`Persisted CCU callback ${interfaceId} (${url}) not reachable — dropping`);
          continue;
        }
        const client = this.createCcuClient(urlObj);
        this.ccuCallbacks.set(interfaceId, { client, interfaceId, url });
        getLogger().info(`Restored CCU callback: ${url} (interfaceId=${interfaceId})`);
        restored = true;
      } catch (err) {
        getLogger().warn(`Failed to restore CCU callback ${interfaceId}: ${err}`);
      }
    }

    this.saveCallbacks(); // prune any dropped entries from disk
    if (restored) {
      this.opts.onCcuRegistered?.();
      const pending = this.pendingEvents.splice(0);
      for (const e of pending) {
        const parts = e.address.split(':');
        this.pushEvent(parts[0], parseInt(parts[1] || '0'), e.key, e.value);
      }
    }
  }

  private probeAlive(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: 2000 });
      const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  isRegistered(): boolean {
    return this.ccuCallbacks.size > 0;
  }

  pushEvent(hmAddress: string, channelIdx: number, key: string, value: unknown): void {
    const address = `${hmAddress}:${channelIdx}`;
    if (this.ccuCallbacks.size === 0) {
      this.pendingEvents.push({ address, key, value });
      if (this.pendingEvents.length > 1000) this.pendingEvents.shift();
      return;
    }
    const kind = this.getChannelKind(address);
    const wireValue = kind ? coerceFloat(getParamsetDescription(kind)[key], value) : value;
    this.callAllCcu('event', (cb) => [cb.interfaceId, address, key, wireValue]);
  }

  notifyNewDevices(devices: DeviceInfo[]): void {
    if (this.ccuCallbacks.size === 0) return;
    const descs = this.buildDeviceDescriptions(devices);
    this.callAllCcu('newDevices', (cb) => [cb.interfaceId, descs]);
  }

  notifyDeleteDevices(hmAddresses: string[]): void {
    if (this.ccuCallbacks.size === 0) return;
    this.callAllCcu('deleteDevices', (cb) => [cb.interfaceId, hmAddresses]);
  }

  private async dispatchSingle(method: string, params: unknown[]): Promise<unknown> {
    getLogger().debug(`HM RPC: ${method}(${JSON.stringify(params).slice(0, 120)})`);

    switch (method) {
      case 'system.listMethods':
        return [
          'system.listMethods', 'system.multicall',
          'init', 'listDevices', 'getDeviceDescription',
          'getParamsetDescription', 'getParamset', 'getValue', 'setValue',
          'deleteDevice',
          'ping', 'getLinks', 'reportValueUsage', 'setMetadata', 'getMetadata',
          'getAllMetadata', 'deleteMetadata', 'getInstallMode', 'setInstallMode',
        ];

      case 'system.multicall': {
        const calls = params[0] as Array<{ methodName: string; params: unknown[] }>;
        const results: unknown[] = [];
        for (const call of calls) {
          try {
            const r = await this.dispatchSingle(call.methodName, call.params);
            results.push([r]);
          } catch (err) {
            results.push([{ faultCode: -1, faultString: String(err) }]);
          }
        }
        return results;
      }

      case 'init': {
        const rawUrl = params[0] as string;
        const interfaceIdParam = params[1] as string | undefined;
        if (!rawUrl) {
          // init("", id) = unregister that consumer only. Multiple consumers
          // register with us (ReGa, HMServer, matter-homematic) — clearing all
          // callbacks because one shuts down would orphan the others.
          if (interfaceIdParam && this.ccuCallbacks.has(interfaceIdParam)) {
            getLogger().info(`CCU client unregistered: ${interfaceIdParam}`);
            this.ccuCallbacks.delete(interfaceIdParam);
          } else if (!interfaceIdParam) {
            getLogger().info('CCU unregistered (empty init URL)');
            this.ccuCallbacks.clear();
          }
          this.saveCallbacks();
        } else if (!interfaceIdParam) {
          // init(url, "") / init(url) = unregister that callback URL
          const url = rawUrl.replace(/^xmlrpc_bin:\/\//, 'xmlrpc://');
          for (const [id, cb] of this.ccuCallbacks) {
            if (cb.url === url) {
              getLogger().info(`CCU client unregistered: ${id} (${url})`);
              this.ccuCallbacks.delete(id);
            }
          }
          this.saveCallbacks();
        } else {
          const interfaceId = interfaceIdParam;
          // CCU may send xmlrpc_bin:// (binary protocol); normalize to xmlrpc://
          const url = rawUrl.replace(/^xmlrpc_bin:\/\//, 'xmlrpc://');
          getLogger().info(`CCU registered: ${url} (interfaceId=${interfaceId})`);
          const urlObj = new URL(url);
          const client = this.createCcuClient(urlObj);
          this.ccuCallbacks.set(interfaceId, { client, interfaceId, url });
          this.saveCallbacks();
          // Re-announce changed device descriptions before flushing events
          this.opts.onCcuRegistered?.();
          const pending = this.pendingEvents.splice(0);
          for (const e of pending) {
            const parts = e.address.split(':');
            this.pushEvent(parts[0], parseInt(parts[1] || '0'), e.key, e.value);
          }
        }
        return '';
      }

      case 'listDevices':
        return this.buildDeviceDescriptions(this.opts.getDevices());

      case 'getDeviceDescription':
        return this.buildSingleDescription(params[0] as string);

      case 'getParamsetDescription': {
        const address = params[0] as string;
        const paramsetType = params[1] as string;
        if (paramsetType === 'VALUES') {
          const kind = this.getChannelKind(address);
          if (kind) return this.wireParamsetDescription(getParamsetDescription(kind));
        }
        return {};
      }

      case 'getParamset': {
        const address = params[0] as string;
        const paramsetType = params[1] as string;
        if (paramsetType === 'VALUES') {
          const { device, channelIdx } = this.resolveAddress(address);
          if (device) {
            const kind = device.channels.find(c => c.channelIdx === channelIdx)?.kind
              || (channelIdx === 0 ? 'MAINTENANCE' as ChannelKind : null);
            if (kind) {
              const desc = getParamsetDescription(kind);
              const values = buildParamset(kind, device.getState(channelIdx));
              for (const [k, v] of Object.entries(values)) values[k] = coerceFloat(desc[k], v);
              return values;
            }
          }
        }
        return {};
      }

      case 'getValue': {
        const address = params[0] as string;
        const key = params[1] as string;
        const { device, channelIdx } = this.resolveAddress(address);
        if (device) {
          const kind = device.channels.find(c => c.channelIdx === channelIdx)?.kind
            || (channelIdx === 0 ? 'MAINTENANCE' as ChannelKind : null);
          const desc = kind ? getParamsetDescription(kind)[key] : undefined;
          const state = device.getState(channelIdx);
          if (key in state) return coerceFloat(desc, state[key]);
          if (desc) return coerceFloat(desc, desc.DEFAULT);
        }
        return null;
      }

      case 'setValue': {
        const address = params[0] as string;
        const key = params[1] as string;
        const value = params[2];
        const { device, channelIdx } = this.resolveAddress(address);
        if (device) await this.opts.onSetValue(device.hmAddress, channelIdx, key, value);
        return '';
      }

      // WebUI "Löschen → Gerät ablernen": ReGa asks the interface to unlearn
      // the device and expects a deleteDevices callback as confirmation —
      // without it the device never leaves the CCU's list. We unexpose the
      // channel (persisted) so it isn't re-announced; the SHELLYnnnn address
      // stays reserved for a later re-expose.
      case 'deleteDevice': {
        const address = (params[0] as string || '').split(':')[0];
        if (address) {
          getLogger().info(`CCU unlearned device ${address}`);
          this.opts.onCcuDeleteDevice?.(address);
          this.notifyDeleteDevices([address]);
        }
        return [];
      }

      case 'ping': {
        // CCU watchdog: it expects a CENTRAL PONG *event* echoing the caller
        // id — without it ReGa marks the interface dead and re-inits forever
        const callerId = (params[0] as string | undefined) || '';
        this.callAllCcu('event', (cb) => [cb.interfaceId, 'CENTRAL', 'PONG', callerId]);
        return true;
      }

      // During teach-in the CCU calls these and expects specific result TYPES.
      // The old `default: ''` returned a string where ReGa wants an array/struct
      // (e.g. getLinks), which fails the call and drops the device to "Fehler".
      // Shapes mirror thkl's Homematic-Virtual-Interface reference.
      case 'getLinks':
      case 'getLinkPeers':
        return [];

      // Spec: reportValueUsage(address, valueId, refCounter) → Boolean.
      // Returning [] makes ReGa log "invalid result type" on every call —
      // it calls this per datapoint when deleting devices and when opening
      // the device settings page, which then aborts with the WebUI's
      // "internal error" page.
      case 'reportValueUsage':
        return true;

      case 'getParamsetId': {
        // Stable cache key per channel kind + paramset — ReGa caches paramset
        // descriptions under this id, so it must differ across kinds/paramsets
        // AND change when the served descriptions change (DESCRIPTOR_VERSION),
        // otherwise ReGa keeps serving stale cached descriptions forever.
        const address = params[0] as string;
        const paramsetType = (params[1] as string) || 'VALUES';
        const kind = this.getChannelKind(address) || 'MAINTENANCE';
        return `${kind}:${paramsetType}:v${DESCRIPTOR_VERSION}`;
      }

      case 'getInstallMode':
        return 0;

      case 'getMetadata':
      case 'getAllMetadata':
        return {};

      default:
        return '';
    }
  }

  // FLOAT params must serialize MIN/MAX/DEFAULT as <double> even for whole
  // numbers (LEVEL 0.0/1.0 would otherwise go out as <int> and ReGa stores 0).
  // Returns wrapped copies — the shared description constants stay untouched.
  private wireParamsetDescription(desc: ParamsetDescription): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, d] of Object.entries(desc)) {
      if (d.TYPE === 'FLOAT') {
        out[name] = {
          ...d,
          DEFAULT: coerceFloat(d, d.DEFAULT),
          ...(d.MIN !== undefined ? { MIN: coerceFloat(d, d.MIN) } : {}),
          ...(d.MAX !== undefined ? { MAX: coerceFloat(d, d.MAX) } : {}),
        };
      } else {
        out[name] = d;
      }
    }
    return out;
  }

  private buildDeviceDescriptions(devices: DeviceInfo[]): unknown[] {
    const result: unknown[] = [];
    for (const dev of devices) {
      const layouts: DeviceLayout[] = dev.channels.map(c => ({ kind: c.kind, channelIdx: c.channelIdx }));
      const parentType = deviceTypeFor(layouts);
      result.push(buildDeviceDescription(dev.hmAddress, dev.model, layouts, this.opts.interfaceId));
      result.push(buildChannelDescription(dev.hmAddress, 0, 'MAINTENANCE', parentType));
      for (const ch of dev.channels) {
        result.push(buildChannelDescription(dev.hmAddress, ch.channelIdx, ch.kind, parentType));
      }
    }
    return result;
  }

  private buildSingleDescription(address: string): unknown {
    const colonIdx = address.indexOf(':');
    if (colonIdx === -1) {
      const dev = this.opts.getDevices().find(d => d.hmAddress === address);
      if (!dev) return {};
      return buildDeviceDescription(
        dev.hmAddress, dev.model,
        dev.channels.map(c => ({ kind: c.kind, channelIdx: c.channelIdx })),
        this.opts.interfaceId
      );
    }
    const { device, channelIdx } = this.resolveAddress(address);
    if (!device) return {};
    const kind = device.channels.find(c => c.channelIdx === channelIdx)?.kind
      || (channelIdx === 0 ? 'MAINTENANCE' as ChannelKind : null);
    if (!kind) return {};
    const parentType = deviceTypeFor(device.channels.map(c => ({ kind: c.kind, channelIdx: c.channelIdx })));
    return buildChannelDescription(device.hmAddress, channelIdx, kind, parentType);
  }

  private getChannelKind(address: string): ChannelKind | null {
    const { device, channelIdx } = this.resolveAddress(address);
    if (!device) return null;
    if (channelIdx === 0) return 'MAINTENANCE';
    return device.channels.find(c => c.channelIdx === channelIdx)?.kind || null;
  }

  private resolveAddress(address: string): { device: DeviceInfo | null; channelIdx: number } {
    const parts = address.split(':');
    const hmAddress = parts[0];
    const channelIdx = parts.length > 1 ? parseInt(parts[1]) : 0;
    const device = this.opts.getDevices().find(d => d.hmAddress === hmAddress) || null;
    return { device, channelIdx };
  }

  // Fans a call out to every registered CCU client (params depend on the
  // client's interfaceId). Failures are logged per client, never thrown.
  private callAllCcu(method: string, paramsFor: (cb: CcuCallback) => unknown[]): void {
    for (const cb of this.ccuCallbacks.values()) {
      cb.client.methodCall(method, paramsFor(cb), (err) => {
        if (err) getLogger().debug(`CCU ${method} to ${cb.interfaceId} (${cb.url}) failed: ${err}`);
      });
    }
  }
}
