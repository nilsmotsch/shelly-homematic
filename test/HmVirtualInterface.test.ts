import * as http from 'http';
import { AddressInfo } from 'net';
import { HmVirtualInterface, DeviceInfo } from '../src/hm/HmVirtualInterface';
import { initLogger } from '../src/utils/Logger';

// The CCU's C++ XML-RPC parser reads self-closing tags (<string/>, <data/>)
// as nil. Channel descriptions contain empty strings (LINK_*_ROLES, GROUP,
// TEAM, ...) and empty arrays, so an unfixed client serializer silently
// destroys every channel struct in newDevices — ReGa then creates the device
// with zero channels and the Posteingang shows "Fehler". These tests pin the
// raw bytes our outbound client puts on the wire.

initLogger({ level: 'error' });

function makeIface(devices: DeviceInfo[] = []): HmVirtualInterface {
  return new HmVirtualInterface({
    port: 0,
    bindHost: '127.0.0.1',
    interfaceId: 'ShellyHM',
    getDevices: () => devices,
    onSetValue: async () => undefined,
    dataDir: '/tmp',
  });
}

function captureServer(): Promise<{
  server: http.Server;
  url: URL;
  bodies: string[];
}> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        bodies.push(body);
        const xml =
          '<?xml version="1.0"?><methodResponse><params><param><value><string>ok</string></value></param></params></methodResponse>';
        res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) });
        res.end(xml);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: new URL(`http://127.0.0.1:${port}/`), bodies });
    });
  });
}

function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('outbound CCU client serialization', () => {
  test('newDevices payload contains channel structs and no self-closing tags', async () => {
    const { server, url, bodies } = await captureServer();
    const device: DeviceInfo = {
      hmAddress: 'SHELLY0003',
      mac: 'aabbccddeeff',
      model: 'Shelly Plug S',
      channels: [
        { kind: 'SWITCH', channelIdx: 1 },
        { kind: 'POWERMETER', channelIdx: 2 },
      ],
      getState: () => ({}),
    };
    const iface = makeIface([device]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (iface as any).createCcuClient(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (iface as any).ccuCallbacks.set('ReGa', { client, interfaceId: 'ReGa', url: url.href });

    iface.notifyNewDevices([device]);
    await waitFor(() => bodies.length === 1);
    server.close();

    const xml = bodies[0];
    // The fatal pattern: any self-closing tag is parsed as nil by the CCU.
    expect(xml).not.toMatch(/<\w+\/>/);
    // Device row and every channel row must be present.
    expect(xml).toContain('SHELLY0003:0');
    expect(xml).toContain('SHELLY0003:1');
    expect(xml).toContain('SHELLY0003:2');
    // Empty strings must survive as explicit pairs.
    expect(xml).toContain('<string></string>');
  });

  test('integral FLOAT values go out as <double>, not <int>', async () => {
    const { server, url, bodies } = await captureServer();
    const device: DeviceInfo = {
      hmAddress: 'SHELLY0006',
      mac: 'c049ef863de8',
      model: 'Plus2PM',
      channels: [
        { kind: 'SWITCH', channelIdx: 1 },
        { kind: 'POWERMETER', channelIdx: 2 },
      ],
      getState: () => ({}),
    };
    const iface = makeIface([device]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (iface as any).createCcuClient(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (iface as any).ccuCallbacks.set('ReGa', { client, interfaceId: 'ReGa', url: url.href });

    iface.pushEvent('SHELLY0006', 2, 'CURRENT', 24); // FLOAT param, integral value
    iface.pushEvent('SHELLY0006', 1, 'STATE', true); // BOOL stays boolean
    await waitFor(() => bodies.length === 2);
    server.close();

    expect(bodies[0]).toContain('<double>24</double>');
    expect(bodies[0]).not.toContain('<int>24</int>');
    expect(bodies[1]).toContain('<boolean>1</boolean>');
  });

  test('getParamsetDescription serves FLOAT MIN/MAX/DEFAULT as <double>', async () => {
    const device: DeviceInfo = {
      hmAddress: 'SHELLY0005',
      mac: 'c049ef863dcc',
      model: 'Plus2PM',
      channels: [{ kind: 'BLIND', channelIdx: 1 }],
      getState: () => ({}),
    };
    const iface = makeIface([device]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const desc = await (iface as any).dispatchSingle('getParamsetDescription', ['SHELLY0005:1', 'VALUES']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ser = require('xmlrpc/lib/serializer');
    const xml: string = ser.serializeMethodResponse(desc);
    // BLIND LEVEL is FLOAT 0.0–1.0 — whole numbers must not degrade to <int>
    expect(xml).toContain('<double>0</double>');
    expect(xml).toContain('<double>1</double>');
  });

  test('deleteDevice unexposes via callback, confirms with deleteDevices, returns array', async () => {
    const { server, url, bodies } = await captureServer();
    const device: DeviceInfo = {
      hmAddress: 'SHELLY0003',
      mac: '543204645154',
      model: 'Mini1G3',
      channels: [{ kind: 'SWITCH', channelIdx: 1 }],
      getState: () => ({}),
    };
    const unlearned: string[] = [];
    const iface = new HmVirtualInterface({
      port: 0,
      bindHost: '127.0.0.1',
      interfaceId: 'ShellyHM',
      getDevices: () => [device],
      onSetValue: async () => undefined,
      onCcuDeleteDevice: (addr) => unlearned.push(addr),
      dataDir: '/tmp',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (iface as any).createCcuClient(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (iface as any).ccuCallbacks.set('ReGa', { client, interfaceId: 'ReGa', url: url.href });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (iface as any).dispatchSingle('deleteDevice', ['SHELLY0003', 0]);
    await waitFor(() => bodies.length === 1);
    server.close();

    expect(result).toEqual([]);
    expect(unlearned).toEqual(['SHELLY0003']);
    expect(bodies[0]).toContain('<methodName>deleteDevices</methodName>');
    expect(bodies[0]).toContain('SHELLY0003');
  });

  test('putParamset VALUES routes each entry through onSetValue, MASTER is ack-only', async () => {
    const calls: Array<[string, number, string, unknown]> = [];
    const device: DeviceInfo = {
      hmAddress: 'SHELLY0006',
      mac: 'c049ef863de8',
      model: 'Plus2PM',
      channels: [{ kind: 'SWITCH', channelIdx: 1 }],
      getState: () => ({}),
    };
    const iface = new HmVirtualInterface({
      port: 0,
      bindHost: '127.0.0.1',
      interfaceId: 'ShellyHM',
      getDevices: () => [device],
      onSetValue: async (addr, ch, key, value) => { calls.push([addr, ch, key, value]); },
      dataDir: '/tmp',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (iface as any).dispatchSingle.bind(iface);
    expect(await d('putParamset', ['SHELLY0006:1', 'VALUES', { STATE: true, ON_TIME: 30 }])).toBe('');
    expect(calls).toEqual([
      ['SHELLY0006', 1, 'STATE', true],
      ['SHELLY0006', 1, 'ON_TIME', 30],
    ]);
    expect(await d('putParamset', ['SHELLY0006', 'MASTER', { INTERNAL_KEYS_VISIBLE: false }])).toBe('');
    expect(calls).toHaveLength(2); // MASTER must not trigger commands
  });

  test('event callback delivers err-free with Content-Length', async () => {
    const { server, url, bodies } = await captureServer();
    const iface = makeIface();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (iface as any).createCcuClient(url);

    const result = await new Promise<unknown>((resolve, reject) => {
      client.methodCall('event', ['ShellyHM', 'SHELLY0003:1', 'STATE', true], (err: Error | null, value: unknown) =>
        err ? reject(err) : resolve(value)
      );
    });
    server.close();

    expect(result).toBe('ok');
    expect(bodies[0]).toContain('<methodName>event</methodName>');
  });
});
