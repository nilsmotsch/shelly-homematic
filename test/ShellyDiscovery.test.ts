import { initLogger } from '../src/utils/Logger';

initLogger({ level: 'error' });

// Fake bonjour-service: count how many Browser instances get created (find())
// vs how many times an existing browser is re-queried (update()). The whole
// point of the leak fix is that find() is called a FIXED number of times for
// the lifetime of discovery, while update() scales with rescans.
const findCalls: Array<{ type: string }> = [];
const browsers: Array<{ update: jest.Mock; stop: jest.Mock }> = [];
const destroy = jest.fn();

jest.mock('bonjour-service', () => ({
  Bonjour: jest.fn().mockImplementation(() => ({
    find: (opts: { type: string }) => {
      findCalls.push(opts);
      const b = { update: jest.fn(), stop: jest.fn() };
      browsers.push(b);
      return b;
    },
    destroy,
  })),
  Service: class {},
  Browser: class {},
}));

import { ShellyDiscovery } from '../src/shelly/ShellyDiscovery';

describe('ShellyDiscovery mDNS browser lifecycle', () => {
  beforeEach(() => {
    findCalls.length = 0;
    browsers.length = 0;
    destroy.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('creates browsers once and re-queries (not re-finds) on rescan', () => {
    const d = new ShellyDiscovery({ rescanInterval: 60, manualDevices: [] });
    d.start();

    // Two browsers created up front (shelly + http), none re-created later.
    expect(findCalls.length).toBe(2);
    expect(browsers.length).toBe(2);

    // Three rescan intervals → update() per browser per rescan, no new finds.
    jest.advanceTimersByTime(60_000 * 3);
    expect(findCalls.length).toBe(2);
    for (const b of browsers) expect(b.update).toHaveBeenCalledTimes(3);

    d.stop();
  });

  test('manual rediscovery (start again) re-queries instead of leaking a browser', () => {
    const d = new ShellyDiscovery({ rescanInterval: 0, manualDevices: [] });
    d.start();
    expect(findCalls.length).toBe(2);

    // discoverNow() calls start() again — must not create more browsers.
    d.start();
    expect(findCalls.length).toBe(2);
    for (const b of browsers) expect(b.update).toHaveBeenCalledTimes(1);

    d.stop();
  });

  test('stop() tears down browsers and the bonjour instance', () => {
    const d = new ShellyDiscovery({ rescanInterval: 60, manualDevices: [] });
    d.start();
    d.stop();
    for (const b of browsers) expect(b.stop).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
