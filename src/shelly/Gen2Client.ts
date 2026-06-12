import { EventEmitter } from 'events';
import * as http from 'http';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import { getLogger } from '../utils/Logger';

export interface Gen2Update {
  component: string;
  idx: number;
  key: string;
  value: unknown;
}

interface Auth { user: string; pass: string }

interface DigestChallenge {
  realm: string;
  nonce: string;
  algorithm: string;
}

export class Gen2Client extends EventEmitter {
  private ip: string;
  private auth?: Auth;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = false;
  private rpcId = 1;
  private digestChallenge: DigestChallenge | null = null;

  constructor(ip: string, auth?: Auth) {
    super();
    this.ip = ip;
    this.auth = auth;
  }

  connect(): void {
    this.stopped = false;
    this.openWebSocket();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.terminate(); this.ws = null; }
  }

  async setSwitch(idx: number, on: boolean): Promise<void> {
    await this.rpcHttp('Switch.Set', { id: idx, on });
  }

  async setLight(idx: number, on: boolean, brightness?: number): Promise<void> {
    const params: Record<string, unknown> = { id: idx, on };
    if (brightness !== undefined) params.brightness = brightness;
    await this.rpcHttp('Light.Set', params);
  }

  async coverOpen(idx: number): Promise<void> { await this.rpcHttp('Cover.Open', { id: idx }); }
  async coverClose(idx: number): Promise<void> { await this.rpcHttp('Cover.Close', { id: idx }); }
  async coverStop(idx: number): Promise<void> { await this.rpcHttp('Cover.Stop', { id: idx }); }
  async coverGoToPosition(idx: number, pos: number): Promise<void> {
    await this.rpcHttp('Cover.GoToPosition', { id: idx, pos });
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.rpcHttp('Shelly.GetStatus', {});
  }

  private openWebSocket(): void {
    const url = `ws://${this.ip}/rpc`;
    const ws = new WebSocket(url);
    this.ws = ws;

    // The Shelly binds its NotifyStatus destination to the rpc `src` string,
    // one session per src. A fixed src means that after a bridge restart the
    // binding can stick to the previous (half-dead) TCP session and the new
    // connection silently receives NO notifications until the zombie times
    // out. A unique src per connection always gets a fresh binding.
    const src = `shelly-homematic-${crypto.randomBytes(4).toString('hex')}`;
    let keepalive: NodeJS.Timeout | null = null;

    ws.on('open', () => {
      this.backoff = 1000;
      getLogger().debug(`Gen2 WS connected: ${this.ip} (src=${src})`);
      // Send src registration + initial status request
      ws.send(JSON.stringify({ id: this.rpcId++, src, method: 'Shelly.GetStatus', params: {} }));
      // Keepalive so the Shelly notices dead peers quickly and our session
      // isn't dropped as idle.
      keepalive = setInterval(() => ws.ping(), 30000);
      this.emit('online');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleWsMessage(msg);
      } catch { /* ignore parse errors */ }
    });

    ws.on('close', () => {
      getLogger().debug(`Gen2 WS disconnected: ${this.ip}`);
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
      this.emit('offline');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      getLogger().debug(`Gen2 WS error ${this.ip}: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.openWebSocket();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  private handleWsMessage(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;
    if (method === 'NotifyStatus' || method === 'NotifyFullStatus') {
      const params = msg.params as Record<string, unknown> | undefined;
      if (!params) return;
      this.parseStatusParams(params);
    } else if (msg.result) {
      // Response to our GetStatus request
      const result = msg.result as Record<string, unknown>;
      this.parseStatusParams(result);
    }
  }

  private parseStatusParams(params: Record<string, unknown>): void {
    for (const [key, val] of Object.entries(params)) {
      if (typeof val !== 'object' || val === null) continue;
      const v = val as Record<string, unknown>;

      // switch:N
      const swMatch = key.match(/^switch:(\d+)$/);
      if (swMatch) {
        const idx = parseInt(swMatch[1]);
        if (v.output !== undefined) this.emit('update', { component: 'switch', idx, key: 'STATE', value: !!v.output });
        if (v.apower !== undefined) this.emit('update', { component: 'switch', idx, key: 'POWER', value: v.apower });
        if (v.voltage !== undefined) this.emit('update', { component: 'switch', idx, key: 'VOLTAGE', value: v.voltage });
        if (v.current !== undefined) this.emit('update', { component: 'switch', idx, key: 'CURRENT', value: v.current });
        if (v.freq !== undefined) this.emit('update', { component: 'switch', idx, key: 'FREQUENCY', value: v.freq });
        if (v.aenergy !== undefined) {
          const ae = v.aenergy as Record<string, unknown>;
          if (ae.total !== undefined) this.emit('update', { component: 'switch', idx, key: 'ENERGY_COUNTER', value: ae.total });
        }
        continue;
      }

      // pm1:N / em1:N (standalone power meters: PM Mini, EM)
      const pmMatch = key.match(/^(pm1|em1):(\d+)$/);
      if (pmMatch) {
        const comp = pmMatch[1];
        const idx = parseInt(pmMatch[2]);
        if (v.apower !== undefined) this.emit('update', { component: comp, idx, key: 'POWER', value: v.apower });
        if (v.act_power !== undefined) this.emit('update', { component: comp, idx, key: 'POWER', value: v.act_power });
        if (v.voltage !== undefined) this.emit('update', { component: comp, idx, key: 'VOLTAGE', value: v.voltage });
        if (v.current !== undefined) this.emit('update', { component: comp, idx, key: 'CURRENT', value: v.current });
        if (v.freq !== undefined) this.emit('update', { component: comp, idx, key: 'FREQUENCY', value: v.freq });
        if (v.aenergy !== undefined) {
          const ae = v.aenergy as Record<string, unknown>;
          if (ae.total !== undefined) this.emit('update', { component: comp, idx, key: 'ENERGY_COUNTER', value: ae.total });
        }
        continue;
      }

      // light:N
      const lightMatch = key.match(/^light:(\d+)$/);
      if (lightMatch) {
        const idx = parseInt(lightMatch[1]);
        if (v.output !== undefined) this.emit('update', { component: 'light', idx, key: 'STATE', value: !!v.output });
        if (v.brightness !== undefined) this.emit('update', { component: 'light', idx, key: 'LEVEL', value: (v.brightness as number) / 100 });
        continue;
      }

      // cover:N
      const coverMatch = key.match(/^cover:(\d+)$/);
      if (coverMatch) {
        const idx = parseInt(coverMatch[1]);
        if (v.current_pos !== undefined) {
          // Shelly pos 0=closed 100=open → HM LEVEL 0.0=closed 1.0=open
          this.emit('update', { component: 'cover', idx, key: 'LEVEL', value: (v.current_pos as number) / 100 });
        }
        if (v.state !== undefined) {
          this.emit('update', { component: 'cover', idx, key: 'WORKING', value: v.state === 'opening' || v.state === 'closing' });
        }
        continue;
      }

      // temperature:N
      const tempMatch = key.match(/^temperature:(\d+)$/);
      if (tempMatch) {
        const idx = parseInt(tempMatch[1]);
        if (v.tC !== undefined) this.emit('update', { component: 'temperature', idx, key: 'TEMPERATURE', value: v.tC });
        continue;
      }

      // humidity:N
      const humMatch = key.match(/^humidity:(\d+)$/);
      if (humMatch) {
        const idx = parseInt(humMatch[1]);
        if (v.rh !== undefined) this.emit('update', { component: 'humidity', idx, key: 'HUMIDITY', value: v.rh });
        continue;
      }

      // devicepower:N (battery)
      const batMatch = key.match(/^devicepower:(\d+)$/);
      if (batMatch) {
        const bat = v.battery as Record<string, unknown> | undefined;
        if (bat?.percent !== undefined) {
          this.emit('update', { component: 'maintenance', idx: 0, key: 'LOWBAT', value: (bat.percent as number) < 20 });
          this.emit('update', { component: 'maintenance', idx: 0, key: 'OPERATING_VOLTAGE', value: (bat.percent as number) / 100 * 3.0 });
        }
        continue;
      }
    }
  }

  private async rpcHttp(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    const path = `/rpc/${method}${qs ? '?' + qs : ''}`;

    // First attempt — may get 401 if auth required
    const resp1 = await this.httpGet(path, undefined);
    if (resp1.status === 401 && this.auth) {
      const challenge = this.parseWwwAuthenticate(resp1.wwwAuth || '');
      if (challenge) {
        const authHeader = this.buildDigestHeader('GET', path, challenge, this.auth);
        const resp2 = await this.httpGet(path, authHeader);
        return JSON.parse(resp2.body);
      }
    }
    return JSON.parse(resp1.body);
  }

  private httpGet(path: string, authHeader: string | undefined): Promise<{ status: number; body: string; wwwAuth?: string }> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {};
      if (authHeader) headers['Authorization'] = authHeader;
      const req = http.get({ hostname: this.ip, path, headers, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          body,
          wwwAuth: res.headers['www-authenticate'] as string | undefined,
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  private parseWwwAuthenticate(header: string): DigestChallenge | null {
    if (!header.startsWith('Digest ')) return null;
    const get = (name: string) => {
      const m = header.match(new RegExp(`${name}="([^"]+)"`));
      return m ? m[1] : '';
    };
    return { realm: get('realm'), nonce: get('nonce'), algorithm: get('algorithm') || 'MD5' };
  }

  private buildDigestHeader(method: string, uri: string, c: DigestChallenge, auth: Auth): string {
    const ha1 = crypto.createHash('md5').update(`${auth.user}:${c.realm}:${auth.pass}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = crypto.createHash('md5').update(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex');
    return `Digest username="${auth.user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  }
}
