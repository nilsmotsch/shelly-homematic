import { EventEmitter } from 'events';
import * as dgram from 'dgram';
import { getLogger } from '../utils/Logger';

export interface CoIoTUpdate {
  ip: string;
  mac: string;
  data: Array<{ serial: number; id: number; value: unknown }>;
}

const COIOT_MULTICAST = '224.0.1.187';
const COIOT_PORT = 5683;

export class CoIoTListener extends EventEmitter {
  private socket: dgram.Socket | null = null;

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;

    sock.on('message', (msg, rinfo) => {
      try {
        this.handlePacket(msg, rinfo.address);
      } catch (err) {
        getLogger().debug(`CoIoT parse error: ${err}`);
      }
    });

    sock.on('error', (err) => {
      getLogger().error(`CoIoT socket error: ${err.message}`);
    });

    sock.bind(COIOT_PORT, () => {
      try {
        sock.addMembership(COIOT_MULTICAST);
        getLogger().info(`CoIoT listener started on ${COIOT_MULTICAST}:${COIOT_PORT}`);
      } catch (err) {
        getLogger().warn(`CoIoT multicast join failed: ${err} — battery sensor push will not work`);
      }
    });
  }

  stop(): void {
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  private handlePacket(buf: Buffer, ip: string): void {
    // CoAP fixed header: 4 bytes (Ver|T|TKL, Code, Message ID x2)
    if (buf.length < 4) return;

    const tkl = buf[0] & 0x0f;
    let offset = 4 + tkl; // skip header + token
    if (offset > buf.length) return;

    // Parse CoAP options to find Uri-Path and CoIoT custom option
    let mac = '';
    let uriPath = '';
    let optNum = 0;

    while (offset < buf.length) {
      const b = buf[offset];
      if (b === 0xff) { offset++; break; } // payload marker

      let delta = (b >> 4) & 0x0f;
      let len = b & 0x0f;
      offset++;

      if (delta === 13) { delta = buf[offset++] + 13; }
      else if (delta === 14) { delta = ((buf[offset++] << 8) | buf[offset++]) + 269; }

      if (len === 13) { len = buf[offset++] + 13; }
      else if (len === 14) { len = ((buf[offset++] << 8) | buf[offset++]) + 269; }

      optNum += delta;
      const optVal = buf.slice(offset, offset + len);
      offset += len;

      if (optNum === 11) { // Uri-Path
        const part = optVal.toString('utf8');
        if (uriPath) uriPath += '/';
        uriPath += part;
      } else if (optNum === 3332) { // CoIoT custom option — device MAC
        mac = optVal.toString('utf8').toLowerCase().replace(/:/g, '');
      }
    }

    if (uriPath !== 'cit/s' && uriPath !== '/cit/s') return;

    // Parse JSON payload
    if (offset >= buf.length) return;
    const payload = buf.slice(offset).toString('utf8');
    const json = JSON.parse(payload) as Record<string, unknown>;

    // CoIoT status body: { serial: N, G: [[serial, id, value], ...] }
    const G = json.G as Array<[number, number, unknown]> | undefined;
    if (!Array.isArray(G)) return;

    const data = G.map(([serial, id, value]) => ({ serial, id, value }));
    this.emit('coiotUpdate', { ip, mac, data });
  }
}
