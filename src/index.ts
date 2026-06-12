import { ShellyBridge } from './bridge/ShellyBridge';
import { WebServer } from './web/WebServer';
import { initLogger, getLogger } from './utils/Logger';
import { appVersion } from './utils/Version';
import * as fs from 'fs';
import * as path from 'path';

// When running as a CCU/RaspberryMatic addon, the rc.d script sets
// SHELLY_HOMEMATIC_DATA_DIR to a path that survives firmware/addon
// updates (e.g. /usr/local/etc/config/addons/shelly-homematic).
const DATA_DIR = process.env.SHELLY_HOMEMATIC_DATA_DIR;

function buildDefaultConfig() {
  return {
    shelly: {
      discovery: { mdns: true, rescanInterval: 300 },
      manualDevices: [] as string[],
      pollInterval: 5000,
    },
    hm: {
      interfaceName: 'ShellyHM',
      port: 2121,
      bindHost: '0.0.0.0',
      // ReGa script endpoint for naming announced devices (we run on the CCU)
      regaUrl: 'http://127.0.0.1:8181/tclrega.exe',
    },
    devices: {
      defaultExposed: false,
      exposed: {} as Record<string, boolean>,
    },
    web: {
      enabled: true,
      port: 8081,
    },
    logging: {
      level: 'info',
      file: DATA_DIR ? path.join(DATA_DIR, 'shelly-homematic.log') : '',
    },
  };
}

const DEFAULT_CONFIG = buildDefaultConfig();

function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  if (DATA_DIR) return path.join(DATA_DIR, 'config.json');
  return './config.json';
}

function seedAddonConfigIfMissing(configPath: string): void {
  if (!DATA_DIR || fs.existsSync(configPath)) return;
  const example = path.resolve(__dirname, '..', 'config.example.json');
  if (!fs.existsSync(example)) return;
  try {
    const seed = JSON.parse(fs.readFileSync(example, 'utf-8'));
    if (seed.logging) delete seed.logging.file;
    seed.web = { ...(seed.web || {}), enabled: true };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(seed, null, 2));
    getLogger().info(`Seeded config at ${configPath}`);
  } catch (err) {
    getLogger().error(`Failed to seed config at ${configPath}: ${err}`);
  }
}

function mergeConfig(
  defaults: typeof DEFAULT_CONFIG,
  override: Partial<typeof DEFAULT_CONFIG>
): typeof DEFAULT_CONFIG {
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(override) as (keyof typeof DEFAULT_CONFIG)[]) {
    const a = (defaults as Record<string, unknown>)[key];
    const b = (override as Record<string, unknown>)[key];
    if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
      merged[key] = { ...(a as object), ...(b as object) };
    } else if (b !== undefined) {
      merged[key] = b;
    }
  }
  return merged as typeof DEFAULT_CONFIG;
}

function loadConfig(): typeof DEFAULT_CONFIG & { configPath: string } {
  const log = getLogger();
  const configPath = resolveConfigPath();
  seedAddonConfigIfMissing(configPath);

  let config = DEFAULT_CONFIG;
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      log.info(`Loaded configuration from ${configPath}`);
      config = mergeConfig(DEFAULT_CONFIG, fileConfig);
    } catch (err) {
      log.error(`Failed to load config from ${configPath}: ${err}`);
    }
  } else {
    log.info('Using default configuration');
  }
  // The bridge persists CCU-initiated exposure changes (deleteDevice) here
  return { ...config, configPath };
}

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      args[key] = value || 'true';
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    console.log('Usage: shelly-homematic [options]');
    console.log('');
    console.log('Options:');
    console.log('  --config=PATH     Path to configuration file');
    console.log('  --hmport=PORT     HM XML-RPC interface port (default: 2121)');
    console.log('  --webport=PORT    Web UI port (default: 8080)');
    console.log('  --help            Show this help');
    console.log('');
    console.log('Environment:');
    console.log('  SHELLY_USER       Shelly device username (digest auth)');
    console.log('  SHELLY_PASSWORD   Shelly device password (digest auth)');
    process.exit(0);
  }

  if (args.config) process.env.CONFIG_PATH = args.config;

  initLogger(DEFAULT_CONFIG.logging);
  const config = loadConfig();
  initLogger(config.logging);
  const log = getLogger();

  log.info('╔═══════════════════════════════════════════╗');
  log.info(`║  Shelly-Homematic Bridge v${appVersion()}`.padEnd(44) + '║');
  log.info('║  Expose Shelly devices via Homematic HM   ║');
  log.info('╚═══════════════════════════════════════════╝');

  if (args.hmport) config.hm.port = parseInt(args.hmport, 10);
  if (args.webport) config.web.port = parseInt(args.webport, 10);

  const bridgeRef: { bridge: ShellyBridge } = {
    bridge: new ShellyBridge(config),
  };
  let webServer: WebServer | undefined;

  const shutdown = async () => {
    log.info('Shutting down...');
    if (webServer) await webServer.stop();
    await bridgeRef.bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || '');
  });
  process.on('unhandledRejection', (reason) => {
    const stack = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    log.error(`Unhandled rejection: ${stack}`);
  });

  const restartBridge = async (): Promise<void> => {
    log.info('Restarting bridge in-process...');
    try {
      await bridgeRef.bridge.stop();
    } catch (err) {
      log.error(`Error stopping bridge: ${err}`);
    }
    const freshConfig = loadConfig();
    if (args.hmport) freshConfig.hm.port = parseInt(args.hmport, 10);
    bridgeRef.bridge = new ShellyBridge(freshConfig);
    await bridgeRef.bridge.start();
    log.info('Bridge restarted.');
  };

  if (config.web?.enabled) {
    const configPath = resolveConfigPath();
    webServer = new WebServer(config.web.port || 8080, {
      getDevices: () => bridgeRef.bridge.getDevices(),
      isCcuRegistered: () => bridgeRef.bridge.isCcuRegistered(),
      getHmPort: () => bridgeRef.bridge.getHmPort(),
      getInterfaceName: () => bridgeRef.bridge.getInterfaceName(),
      configPath,
      dataDir: DATA_DIR || '.',
      restartBridge,
      setDeviceExposed: (address, exposed) => bridgeRef.bridge.setDeviceExposed(address, exposed),
      setRelayState: (address, channel, on) => bridgeRef.bridge.setRelayState(address, channel, on),
      setLevel: (address, channel, level) => bridgeRef.bridge.setLevel(address, channel, level),
      coverCommand: (address, channel, cmd) => bridgeRef.bridge.coverCommand(address, channel, cmd),
      discoverNow: () => bridgeRef.bridge.discoverNow(),
      logFilePath: config.logging?.file || '',
    });
    try {
      await webServer.start();
    } catch (err) {
      log.error(`Failed to start web server: ${err}`);
    }
  }

  try {
    await bridgeRef.bridge.start();
  } catch (err) {
    log.error(`Failed to start bridge: ${err}`);
    process.exit(1);
  }
}

main().catch(err => {
  const log = getLogger();
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
