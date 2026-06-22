import { EventEmitter } from 'events';
import * as http from 'http';
import { Bonjour, Service, Browser } from 'bonjour-service';
import { getLogger } from '../utils/Logger';

export interface ShellyInfo {
  ip: string;
  mac: string;
  gen: 1 | 2;
  model: string;
  auth: boolean;
  name: string;
}

export class ShellyDiscovery extends EventEmitter {
  private rescanInterval: number;
  private manualDevices: string[];
  private bonjour: Bonjour;
  private rescanTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  // mDNS browsers are created ONCE and kept for the lifetime of discovery.
  // Each bonjour.find() attaches a permanent 'response' listener to the shared
  // mDNS socket and is never auto-removed, so calling find() on every rescan
  // (as we used to) leaked one Browser — plus its listener and service cache —
  // every interval. Over days that accumulated thousands of browsers, each
  // re-querying on every multicast packet: a slow memory leak and a query
  // storm that pinned RSS/CPU. We now create the browsers once and just
  // re-issue their PTR query via update() to rescan.
  private browsers: Browser[] = [];

  constructor(opts: { rescanInterval: number; manualDevices: string[] }) {
    super();
    this.rescanInterval = opts.rescanInterval * 1000;
    this.manualDevices = opts.manualDevices;
    this.bonjour = new Bonjour();
  }

  start(): void {
    if (this.browsers.length === 0) {
      this.createBrowsers();
    } else {
      // Already running (e.g. manual rediscovery) — just re-query, never
      // create another browser.
      for (const b of this.browsers) b.update();
    }
    this.probeManualDevices();
    if (this.rescanInterval > 0 && !this.rescanTimer) {
      this.rescanTimer = setInterval(() => {
        for (const b of this.browsers) b.update();
        this.probeManualDevices();
      }, this.rescanInterval);
    }
  }

  stop(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const b of this.browsers) {
      try { b.stop(); } catch { /* ignore */ }
    }
    this.browsers = [];
    this.bonjour.destroy();
  }

  // Create the persistent mDNS browsers (once). The browsers keep listening
  // continuously, so devices that announce themselves between rescans are
  // still picked up; rescan only forces a fresh PTR query.
  private createBrowsers(): void {
    // Gen2+: _shelly._tcp
    this.browsers.push(this.bonjour.find({ type: 'shelly' }, (svc: Service) => {
      const ip = svc.addresses?.[0] || svc.host;
      if (ip) this.probe(ip);
    }));

    // Gen1: _http._tcp with hostname matching shelly*
    this.browsers.push(this.bonjour.find({ type: 'http' }, (svc: Service) => {
      const host = svc.host || '';
      if (/^shelly/i.test(host)) {
        const ip = svc.addresses?.[0] || host;
        if (ip) this.probe(ip);
      }
    }));
  }

  private probeManualDevices(): void {
    for (const ip of this.manualDevices) {
      this.probe(ip);
    }
  }

  probe(ip: string): void {
    this.fetchShellyInfo(ip)
      .then((info) => {
        if (!this.seen.has(info.mac)) {
          this.seen.add(info.mac);
          getLogger().info(`Discovered Shelly ${info.model} (${info.mac}) at ${ip} gen${info.gen}`);
          this.emit('deviceFound', info);
        }
      })
      .catch(() => {
        // Not a Shelly or unreachable — ignore
      });
  }

  private fetchShellyInfo(ip: string): Promise<ShellyInfo> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://${ip}/shelly`, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const mac: string = (j.mac || j.id || '').replace(/:/g, '').toLowerCase();
            if (!mac) { reject(new Error('no mac')); return; }
            const gen: 1 | 2 = j.gen === 2 || j.gen === 3 ? 2 : 1;
            resolve({
              ip,
              mac,
              gen,
              model: j.app || j.type || 'unknown',
              auth: !!j.auth_en || !!j.auth,
              name: j.name || j.hostname || mac,
            });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }
}
