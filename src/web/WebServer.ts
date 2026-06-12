import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { getLogger } from '../utils/Logger';
import { appVersion } from '../utils/Version';
import type { ShellyDevice } from '../bridge/ShellyBridge';

interface WebServerDeps {
  getDevices: () => Map<string, ShellyDevice>;
  isCcuRegistered: () => boolean;
  getHmPort: () => number;
  getInterfaceName: () => string;
  configPath: string;
  // Persistent data dir (devices.json, ccu-callbacks.json) — target of factoryReset
  dataDir: string;
  restartBridge: () => Promise<void>;
  setDeviceExposed: (address: string, exposed: boolean) => Promise<void>;
  setRelayState: (address: string, channel: number, on: boolean) => Promise<void>;
  setLevel: (address: string, channel: number, level: number) => Promise<void>;
  coverCommand: (address: string, channel: number, cmd: 'open' | 'close' | 'stop') => Promise<void>;
  discoverNow: () => void;
  onShellyWsMessage?: (ip: string, msg: Record<string, unknown>) => void;
  logFilePath: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class WebServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private port: number;
  private deps: WebServerDeps;
  private staticDir: string;
  private startTime: Date;

  constructor(port: number, deps: WebServerDeps) {
    this.port = port;
    this.deps = deps;
    const candidates = [
      path.resolve(__dirname, '..', '..', 'html'),
      path.resolve(__dirname, '..', 'html'),
    ];
    this.staticDir = candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
    this.startTime = new Date();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Inbound WebSocket endpoint for Gen2 battery sensors (outbound WS configured on device)
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url === '/shelly-ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleShellyWs(ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        getLogger().info(`Web UI available at http://localhost:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this.wss.close();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleShellyWs(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    getLogger().debug(`Gen2 battery sensor connected from ${ip}`);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (this.deps.onShellyWsMessage) this.deps.onShellyWsMessage(ip, msg);
      } catch { /* ignore parse errors */ }
    });
    ws.on('close', () => {
      getLogger().debug(`Gen2 battery sensor disconnected from ${ip}`);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = url.parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';

    if (pathname === '/api/') {
      const method = parsed.query.method as string;
      if (!method) {
        this.sendJson(res, 400, { error: 'Missing method parameter' });
        return;
      }
      this.handleApi(method, req, res);
    } else {
      this.serveStatic(pathname, res);
    }
  }

  private handleApi(method: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    switch (method) {
      case 'getBridgeStatus':
        this.sendJson(res, 200, this.getBridgeStatus());
        break;

      case 'getDevices':
        this.sendJson(res, 200, this.getDevices());
        break;

      case 'getLog':
        this.handleGetLog(req, res);
        break;

      case 'getConfig':
        this.sendJson(res, 200, this.getConfig());
        break;

      case 'setDeviceExposed':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleSetDeviceExposed(req, res);
        break;

      case 'setDefaultExposed':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleSetDefaultExposed(req, res);
        break;

      case 'setRelayState':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleSetRelayState(req, res);
        break;

      case 'setLevel':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleSetLevel(req, res);
        break;

      case 'coverCommand':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleCoverCommand(req, res);
        break;

      case 'discoverNow':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.deps.discoverNow();
        this.sendJson(res, 200, { success: true });
        break;

      case 'restartBridge':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleRestartBridge(res);
        break;

      case 'factoryReset':
        if (req.method !== 'POST') { this.sendJson(res, 405, { error: 'POST required' }); return; }
        this.handleFactoryReset(res);
        break;

      default:
        this.sendJson(res, 404, { error: `Unknown method: ${method}` });
    }
  }

  // Deletes everything the addon persists (uninstall deliberately preserves
  // the config dir, so this is the explicit "start over / purge before
  // uninstall" path): device address mapping, exposure config, CCU callback
  // registrations. The CCU keeps its learned SHELLYnnnn devices — they become
  // orphans until re-exposed and re-taught.
  private handleFactoryReset(res: http.ServerResponse): void {
    const targets = [
      this.deps.configPath,
      path.join(this.deps.dataDir, 'devices.json'),
      path.join(this.deps.dataDir, 'ccu-callbacks.json'),
    ];
    const deleted: string[] = [];
    for (const f of targets) {
      try {
        if (fs.existsSync(f)) { fs.unlinkSync(f); deleted.push(path.basename(f)); }
      } catch (err) {
        getLogger().error(`Factory reset: failed to delete ${f}: ${err}`);
      }
    }
    getLogger().warn(`Factory reset via Web UI — deleted: ${deleted.join(', ') || '(nothing)'}`);
    this.sendJson(res, 202, {
      success: true,
      message:
        `Deleted: ${deleted.join(', ') || 'nothing'}. Bridge restarting. ` +
        'Restart the CCU now — ReGa only registers interfaces at its own startup, ' +
        'so devices cannot be announced until then.',
    });
    this.deps.restartBridge().catch((err) => {
      getLogger().error(`Restart after factory reset failed: ${err}`);
    });
  }

  private handleRestartBridge(res: http.ServerResponse): void {
    this.sendJson(res, 202, { success: true, message: 'Restart initiated.' });
    getLogger().info('Restart requested via Web UI');
    this.deps.restartBridge().catch((err) => {
      getLogger().error(`Bridge restart failed: ${err}`);
    });
  }

  private getBridgeStatus() {
    const uptimeMs = Date.now() - this.startTime.getTime();
    const devices = this.deps.getDevices();
    let exposedCount = 0;
    for (const [, d] of devices) {
      if (d.exposed) exposedCount++;
    }
    return {
      version: appVersion(),
      ccuRegistered: this.deps.isCcuRegistered(),
      deviceCount: devices.size,
      exposedCount,
      hmPort: this.deps.getHmPort(),
      interfaceName: this.deps.getInterfaceName(),
      uptime: Math.floor(uptimeMs / 1000),
    };
  }

  private getDevices() {
    const { exposed, defaultExposed } = this.readExposureConfig();
    const devices: ShellyDevice[] = [];
    for (const [, device] of this.deps.getDevices()) {
      const explicit = Object.prototype.hasOwnProperty.call(exposed, device.address);
      devices.push({
        ...device,
        exposed: explicit ? !!exposed[device.address] : defaultExposed,
      });
    }
    return { devices, count: devices.length, defaultExposed };
  }

  private readExposureConfig(): { exposed: Record<string, boolean>; defaultExposed: boolean } {
    try {
      const config = JSON.parse(fs.readFileSync(this.deps.configPath, 'utf-8'));
      return {
        exposed: config.devices?.exposed || {},
        defaultExposed: config.devices?.defaultExposed ?? true,
      };
    } catch {
      return { exposed: {}, defaultExposed: true };
    }
  }

  private handleGetLog(req: http.IncomingMessage, res: http.ServerResponse): void {
    const file = this.deps.logFilePath;
    if (!file || !fs.existsSync(file)) {
      this.sendJson(res, 200, { lines: [], note: 'No log file configured (console logging only)' });
      return;
    }
    const query = url.parse(req.url || '', true).query;
    const wanted = Math.min(parseInt(String(query.lines || ''), 10) || 200, 1000);
    try {
      const stat = fs.statSync(file);
      const readBytes = Math.min(stat.size, 256 * 1024);
      const buf = Buffer.alloc(readBytes);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
      } finally {
        fs.closeSync(fd);
      }
      // eslint-disable-next-line no-control-regex
      const text = buf.toString('utf-8').replace(/\x1b\[[0-9;]*m/g, '');
      let lines = text.split('\n').filter((l) => l.trim() !== '');
      if (readBytes < stat.size && lines.length > 0) lines = lines.slice(1);
      this.sendJson(res, 200, { lines: lines.slice(-wanted), size: stat.size });
    } catch (err) {
      this.sendJson(res, 500, { error: `Failed to read log: ${err}` });
    }
  }

  private writeConfigPatch(patch: (cfg: Record<string, unknown>) => void): void {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(this.deps.configPath, 'utf-8'));
    } catch { /* start fresh */ }
    if (!config.devices) config.devices = {};
    patch(config);
    fs.writeFileSync(this.deps.configPath, JSON.stringify(config, null, 2));
  }

  private getConfig() {
    try {
      const content = fs.readFileSync(this.deps.configPath, 'utf-8');
      const config = JSON.parse(content);
      return {
        exposed: config.devices?.exposed || {},
        defaultExposed: config.devices?.defaultExposed ?? true,
      };
    } catch {
      return { exposed: {}, defaultExposed: true };
    }
  }

  private handleSetDeviceExposed(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { address, exposed } = payload || {};
      if (typeof address !== 'string' || typeof exposed !== 'boolean') {
        this.sendJson(res, 400, { error: 'Expected {address: string, exposed: boolean}' });
        return;
      }
      this.writeConfigPatch((config) => {
        const devices = config.devices as Record<string, unknown>;
        if (!devices.exposed) devices.exposed = {};
        (devices.exposed as Record<string, boolean>)[address] = exposed;
      });
      this.deps.setDeviceExposed(address, exposed)
        .then(() => {
          getLogger().info(`Device ${address} exposure set to ${exposed}`);
          this.sendJson(res, 200, { success: true });
        })
        .catch((err) => {
          getLogger().error(`setDeviceExposed failed: ${err}`);
          this.sendJson(res, 200, { success: true, message: 'Saved. Restart to apply.' });
        });
    });
  }

  private handleSetDefaultExposed(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { defaultExposed } = payload || {};
      if (typeof defaultExposed !== 'boolean') {
        this.sendJson(res, 400, { error: 'Expected {defaultExposed: boolean}' });
        return;
      }
      this.writeConfigPatch((config) => {
        (config.devices as Record<string, unknown>).defaultExposed = defaultExposed;
      });
      this.sendJson(res, 200, { success: true });
    });
  }

  private handleSetRelayState(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { address, channel, on } = payload || {};
      if (typeof address !== 'string' || typeof channel !== 'number' || typeof on !== 'boolean') {
        this.sendJson(res, 400, { error: 'Expected {address: string, channel: number, on: boolean}' });
        return;
      }
      this.deps.setRelayState(address, channel, on)
        .then(() => this.sendJson(res, 200, { success: true }))
        .catch((err) => this.sendJson(res, 500, { error: String(err) }));
    });
  }

  private handleSetLevel(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { address, channel, level } = payload || {};
      if (typeof address !== 'string' || typeof channel !== 'number' || typeof level !== 'number') {
        this.sendJson(res, 400, { error: 'Expected {address: string, channel: number, level: number}' });
        return;
      }
      this.deps.setLevel(address, channel, level)
        .then(() => this.sendJson(res, 200, { success: true }))
        .catch((err) => this.sendJson(res, 500, { error: String(err) }));
    });
  }

  private handleCoverCommand(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { address, channel, cmd } = payload || {};
      if (typeof address !== 'string' || typeof channel !== 'number' ||
          typeof cmd !== 'string' || !['open', 'close', 'stop'].includes(cmd)) {
        this.sendJson(res, 400, { error: 'Expected {address: string, channel: number, cmd: open|close|stop}' });
        return;
      }
      this.deps.coverCommand(address, channel, cmd as 'open' | 'close' | 'stop')
        .then(() => this.sendJson(res, 200, { success: true }))
        .catch((err) => this.sendJson(res, 500, { error: String(err) }));
    });
  }

  private readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (payload: Record<string, unknown>) => void
  ): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        handler(JSON.parse(body));
      } catch (err) {
        this.sendJson(res, 400, { error: `Invalid JSON: ${err}` });
      }
    });
  }

  private serveStatic(urlPath: string, res: http.ServerResponse): void {
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.resolve(this.staticDir, '.' + urlPath);
    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      // no-cache: browsers otherwise heuristically cache app.js/css and keep
      // serving stale UI logic long after a deploy (files are tiny, LAN-local)
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }
}
