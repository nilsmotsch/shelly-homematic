import { EventEmitter } from 'events';
import * as http from 'http';
import { getLogger } from '../utils/Logger';

export interface Gen1Update {
  component: string; // 'relay' | 'light' | 'roller' | 'sensor'
  idx: number;
  key: string;
  value: unknown;
}

interface Auth { user: string; pass: string }

export class Gen1Client extends EventEmitter {
  private ip: string;
  private auth?: Auth;
  private pollInterval: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastStatus: Record<string, unknown> = {};

  constructor(ip: string, pollInterval: number, auth?: Auth) {
    super();
    this.ip = ip;
    this.pollInterval = pollInterval;
    this.auth = auth;
  }

  startPolling(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollInterval);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async setRelay(idx: number, on: boolean): Promise<void> {
    await this.get(`/relay/${idx}?turn=${on ? 'on' : 'off'}`);
  }

  async toggleRelay(idx: number): Promise<void> {
    await this.get(`/relay/${idx}?turn=toggle`);
  }

  async setLight(brightness: number, on: boolean): Promise<void> {
    const turn = on || brightness > 0 ? 'on' : 'off';
    await this.get(`/light/0?turn=${turn}&brightness=${brightness}`);
  }

  async setRoller(cmd: 'open' | 'close' | 'stop', pos?: number): Promise<void> {
    if (cmd === 'stop') {
      await this.get('/roller/0?go=stop');
    } else if (pos !== undefined) {
      await this.get(`/roller/0?go=to_pos&roller_pos=${pos}`);
    } else {
      await this.get(`/roller/0?go=${cmd}`);
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.getJson('/status');
  }

  private async poll(): Promise<void> {
    try {
      const status = await this.getStatus();
      this.diffAndEmit(status);
      this.lastStatus = status;
    } catch (err) {
      getLogger().debug(`Gen1 poll ${this.ip}: ${err}`);
    }
  }

  private diffAndEmit(status: Record<string, unknown>): void {
    // Relays
    const relays = status.relays as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(relays)) {
      relays.forEach((r, idx) => {
        const prev = ((this.lastStatus.relays as Array<Record<string, unknown>>)?.[idx]) || {};
        if (r.ison !== prev.ison) this.emit('update', { component: 'relay', idx, key: 'STATE', value: !!r.ison });
        if (r.power !== undefined && r.power !== prev.power) this.emit('update', { component: 'relay', idx, key: 'POWER', value: r.power });
      });
    }

    // Lights
    const lights = status.lights as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(lights)) {
      lights.forEach((l, idx) => {
        const prev = ((this.lastStatus.lights as Array<Record<string, unknown>>)?.[idx]) || {};
        if (l.ison !== prev.ison) this.emit('update', { component: 'light', idx, key: 'STATE', value: !!l.ison });
        if (l.brightness !== undefined && l.brightness !== prev.brightness) {
          this.emit('update', { component: 'light', idx, key: 'LEVEL', value: (l.brightness as number) / 100 });
        }
      });
    }

    // Rollers
    const rollers = status.rollers as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(rollers)) {
      rollers.forEach((r, idx) => {
        const prev = ((this.lastStatus.rollers as Array<Record<string, unknown>>)?.[idx]) || {};
        if (r.current_pos !== undefined && r.current_pos !== prev.current_pos) {
          // Shelly pos 0=closed 100=open → HM LEVEL 0.0=closed 1.0=open
          this.emit('update', { component: 'roller', idx, key: 'LEVEL', value: (r.current_pos as number) / 100 });
        }
        if (r.state !== prev.state) {
          this.emit('update', { component: 'roller', idx, key: 'WORKING', value: r.state === 'opening' || r.state === 'closing' });
        }
      });
    }

    // Temperature sensors
    const thermometers = status.thermometers as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(thermometers)) {
      thermometers.forEach((t, idx) => {
        const prev = ((this.lastStatus.thermometers as Array<Record<string, unknown>>)?.[idx]) || {};
        if (t.tC !== undefined && t.tC !== prev.tC) {
          this.emit('update', { component: 'sensor', idx, key: 'TEMPERATURE', value: t.tC });
        }
      });
    }

    // Humidity
    const humid = status.humidity as Record<string, unknown> | undefined;
    if (humid?.value !== undefined) {
      const prevHumid = this.lastStatus.humidity as Record<string, unknown> | undefined;
      if (humid.value !== prevHumid?.value) {
        this.emit('update', { component: 'sensor', idx: 0, key: 'HUMIDITY', value: humid.value });
      }
    }

    // Flood / contact sensors
    const sensor = status.sensor as Record<string, unknown> | undefined;
    if (sensor?.state !== undefined) {
      const prevSensor = this.lastStatus.sensor as Record<string, unknown> | undefined;
      if (sensor.state !== prevSensor?.state) {
        this.emit('update', { component: 'sensor', idx: 0, key: 'STATE', value: sensor.state === 'wet' || sensor.state === 'open' || sensor.state === true });
      }
    }

    // Motion
    const motion = status.motion as boolean | undefined;
    const prevMotion = this.lastStatus.motion as boolean | undefined;
    if (motion !== undefined && motion !== prevMotion) {
      this.emit('update', { component: 'sensor', idx: 0, key: 'MOTION', value: motion });
    }

    // Energy meters
    const meters = status.meters as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(meters)) {
      meters.forEach((m, idx) => {
        const prev = ((this.lastStatus.meters as Array<Record<string, unknown>>)?.[idx]) || {};
        if (m.power !== undefined && m.power !== prev.power) {
          this.emit('update', { component: 'meter', idx, key: 'POWER', value: m.power });
        }
        if (m.total !== undefined && m.total !== prev.total) {
          this.emit('update', { component: 'meter', idx, key: 'ENERGY_COUNTER', value: (m.total as number) / 60 }); // Wmin → Wh
        }
      });
    }

    // Battery
    const bat = status.bat as Record<string, unknown> | undefined;
    const prevBat = this.lastStatus.bat as Record<string, unknown> | undefined;
    if (bat?.value !== undefined && bat.value !== prevBat?.value) {
      this.emit('update', { component: 'maintenance', idx: 0, key: 'OPERATING_VOLTAGE', value: (bat.value as number) / 100 * 3.0 });
      this.emit('update', { component: 'maintenance', idx: 0, key: 'LOWBAT', value: (bat.value as number) < 20 });
    }
  }

  private get(path: string): Promise<void> {
    return this.getJson(path).then(() => undefined);
  }

  private getJson(path: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = { hostname: this.ip, path, timeout: 5000 };
      if (this.auth) {
        opts.auth = `${this.auth.user}:${this.auth.pass}`;
      }
      const req = http.get(opts, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`JSON parse error: ${err}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }
}
