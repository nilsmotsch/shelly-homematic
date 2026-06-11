import { EventEmitter } from 'events';
import * as http from 'http';
import { Bonjour, Service } from 'bonjour-service';
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

  constructor(opts: { rescanInterval: number; manualDevices: string[] }) {
    super();
    this.rescanInterval = opts.rescanInterval * 1000;
    this.manualDevices = opts.manualDevices;
    this.bonjour = new Bonjour();
  }

  start(): void {
    this.scan();
    this.probeManualDevices();
    if (this.rescanInterval > 0) {
      this.rescanTimer = setInterval(() => {
        this.scan();
        this.probeManualDevices();
      }, this.rescanInterval);
    }
  }

  stop(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.bonjour.destroy();
  }

  private scan(): void {
    // Gen2+: _shelly._tcp
    this.bonjour.find({ type: 'shelly' }, (svc: Service) => {
      const ip = svc.addresses?.[0] || svc.host;
      if (ip) this.probe(ip);
    });

    // Gen1: _http._tcp with hostname matching shelly*
    this.bonjour.find({ type: 'http' }, (svc: Service) => {
      const host = svc.host || '';
      if (/^shelly/i.test(host)) {
        const ip = svc.addresses?.[0] || host;
        if (ip) this.probe(ip);
      }
    });
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
