# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Shelly-Homematic is a bridge that exposes **Shelly** smart-home devices **to** a Homematic CCU3/RaspberryMatic, where they appear as native virtual HM devices (`SHELLYnnnn`). It is the mirror image of the sister project `matter-homematic` (which bridges *Homematic → Matter*). Here the data flows the other way: Shelly is the source of truth, and the bridge presents an XML-RPC **interface** that the CCU connects to like any other (BidCos, HmIP).

Direction of control:
- **Shelly → CCU:** device state changes (relay on/off, cover position, sensor readings) are pushed to the CCU as HM `event` callbacks.
- **CCU → Shelly:** `setValue` calls from the CCU (or its programs/UI) are translated into Shelly HTTP/WebSocket RPC commands.

## Commands

- **Build:** `npm run build` (TypeScript → `dist/`)
- **Dev mode:** `npm run dev` (ts-node, reads `./config.json`)
- **Dev w/ test config:** `npm run dev:test` (uses `config.test.json`)
- **Start:** `npm start` (compiled JS from `dist/`)
- **Tests:** `npm test` (Jest + ts-jest)
- **Single test file:** `npx jest test/DeviceMapper.test.ts`
- **Single test by name:** `npx jest -t "substring of test name"`
- **Lint:** `npm run lint`
- **Watch:** `npm run watch`
- **Build addon tarball:** `npm run build:addon`

CLI flags (see `main()` in `src/index.ts`): `--config=PATH`, `--hmport=PORT`, `--webport=PORT`, `--help`.
Env vars: `SHELLY_USER` / `SHELLY_PASSWORD` (Shelly digest auth), `CONFIG_PATH`, `SHELLY_HOMEMATIC_DATA_DIR` (set by the addon rc.d).

## Architecture

```
src/
  index.ts                  — entry: config load/merge, signal handling, in-process restart
  bridge/ShellyBridge.ts    — orchestrator: wires ShellyConnector ↔ HmVirtualInterface
  hm/HmVirtualInterface.ts  — XML-RPC server the CCU connects to; pushes events back to CCU
  hm/HmDeviceModel.ts       — builds HM device/channel/paramset descriptions per ChannelKind
  hm/RegaClient.ts          — ReGa script client (tclrega.exe): names announced devices in ReGa
  devices/DeviceMapper.ts   — Shelly↔HM value conversion + AddressRegistry (devices.json)
  shelly/ShellyConnector.ts — owns all devices, normalizes updates, fans out commands
  shelly/ShellyDiscovery.ts — mDNS (bonjour) + manual-IP + CoIoT-probe discovery
  shelly/Gen1Client.ts      — Gen1 HTTP polling (/status, /relay, /roller, …)
  shelly/Gen2Client.ts      — Gen2 WebSocket (NotifyStatus) + HTTP RPC, digest auth
  shelly/CoIoTListener.ts   — UDP/CoAP multicast listener for Gen1 battery sensor push
  web/WebServer.ts          — config/control Web UI + JSON API (default port 8081)
  utils/Logger.ts           — winston wrapper (initLogger/getLogger)
```

The bridge is a pipeline with **ShellyBridge** in the middle. It holds an `AddressRegistry`, listens to `deviceFound`/`deviceEvent` from the connector, and on each event maps the Shelly value to HM and calls `hmInterface.pushEvent(...)`. In the reverse direction, `HmVirtualInterface`'s `onSetValue` callback flows into `ShellyBridge.onCcuSetValue`, which maps HM→Shelly and drives the connector.

`index.ts` keeps the bridge in a mutable `{ bridge }` holder and passes **getters** into `WebServer` (`WebServerDeps`) so the Web UI survives an in-process `restartBridge()` (rebuild bridge from fresh config without restarting the process).

## How the CCU sees us (the virtual interface model)

The CCU does **not** discover us; the installer registers an `<ipc>` interface entry (`ShellyHM`, `xmlrpc://127.0.0.1:2121`) in `/usr/local/etc/config/InterfacesList`. On startup the CCU calls `init(callbackUrl, interfaceId)` on our XML-RPC server. We store that callback client and from then on:

- The CCU pulls the device tree via `listDevices` / `getDeviceDescription` / `getParamsetDescription` / `getParamset` / `getValue`.
- We push live state via `event(interfaceId, address, KEY, value)` and topology changes via `newDevices` / `deleteDevices` on the callback client.
- `init` with an **empty URL** means that consumer is unregistering — drop only *its* callback (multiple consumers register with us: ReGa, HMServer, matter-homematic; clearing all would orphan the others). An empty URL with no interfaceId clears everything.
- The CCU may send `xmlrpc_bin://` (binary protocol) callback URLs; we normalize them to `xmlrpc://` (`HmVirtualInterface.init`).
- Events that arrive before the CCU registers are queued in `pendingEvents` (capped at 1000) and flushed on `init`.

### XML-RPC CCU compatibility (do not regress)

`HmVirtualInterface` hand-rolls the HTTP server (`http.createServer` + `xmlrpc/lib/{deserializer,serializer}`) rather than using `xmlrpc.createServer`, because real CCU firmware's C++ XML-RPC parser is picky:

- **Responses must send `Content-Length`** (no chunked transfer encoding).
- **`<string/>` self-closing tags are rejected** — `sendResponse`/`sendFault` rewrite `<string/>` → `<string></string>`.
- **Every method must get a valid response.** Unknown methods return `''` (see the `default:` case in `dispatchSingle`). `system.listMethods` advertises the full set; `system.multicall` is handled by recursing into `dispatchSingle`.
- **Exact result types matter per method**: `reportValueUsage` → boolean (an array makes ReGa log "invalid result type" and aborts device deletes/settings pages), `getLinks`/`getLinkPeers`/`system.methodHelp` → array, `getParamsetId` → string, `deleteDevice` → array (and must confirm via a `deleteDevices` callback or the WebUI delete never completes), `putParamset` → '' (the settings save and "Werte übertragen" go through it).
- **Device descriptions must include `PARENT: ''`** — the WebUI settings CGI (`ic_deviceparameters.cgi`) reads `dev_descr(PARENT)` unguarded; a missing TCL array element crashes the page into the generic "internal error" banner. Same class of bug: any field a `/www/config/*.cgi` reads without `catch`/`info exists` must exist.
- **Outbound callbacks (`event`/`newDevices`/`deleteDevices`) are hand-rolled too** (`createCcuClient`), for the same reason: the stock `xmlrpc` client serializes empty strings/arrays as self-closing tags, which made ReGa drop every channel struct in `newDevices` (device created with 0 channels → Posteingang "Fehler"). The client also **FIFO-serializes calls per CCU consumer** — without ordering, a raced `deleteDevices` arriving after the final `newDevices` silently removes the device from ReGa. `ShellyBridge` additionally debounces announcements (`ANNOUNCE_SETTLE_MS`) until the channel-layout signature stops evolving. Regression tests: `test/HmVirtualInterface.test.ts`.

## Device & channel model

Each **Shelly channel becomes its own HM device** `SHELLYnnnn` (not one HM device with many channels). HM devices **impersonate real classic BidCos devices** (the CUxD trick) so the CCU renders native icons/controls instead of treating them as unknown:

| Primary kind | Device TYPE | Channel TYPE (ch 1) |
|---|---|---|
| SWITCH | `HM-LC-Sw1-Pl` | `SWITCH` |
| SWITCH + meter | `HM-ES-PMSw1-Pl` | `SWITCH` + ch 2 `POWERMETER` |
| DIMMER | `HM-LC-Dim1T-Pl` | `DIMMER` |
| BLIND | `HM-LC-Bl1-FM` | `BLIND` |
| WEATHER | `HM-WDS10-TH-O` | `WEATHER` |
| CONTACT | `HM-Sec-SC-2` | `SHUTTER_CONTACT` |
| MOTION | `HM-Sec-MDIR` | `MOTION_DETECTOR` |
| WATER | `HM-Sec-WDS` | `WATERDETECTIONSENSOR` |
| POWERMETER (standalone) | `HM-ES-TX-WM` | `POWERMETER` |

Channel layout per HM device:

- **Channel 0 = `MAINTENANCE`** (UNREACH, STICKY_UNREACH, CONFIG_PENDING, LOWBAT, OPERATING_VOLTAGE, RSSI_DEVICE) — always present. Classic names: **`LOWBAT`, not HmIP's `LOW_BAT`** (the mapper accepts both inbound).
- **Channel 1 = the functional channel.**
- **Channel 2 = `POWERMETER`** (POWER, ENERGY_COUNTER, VOLTAGE, CURRENT) — only on actuator+meter combos (Plug S, 1PM, …), mirroring the real HM-ES-PMSw1-Pl layout. `ShellyBridge.hmChannelFor` routes power-family datapoints there; MAINTENANCE datapoints go to channel 0; everything else to channel 1.

Multi-channel Shellys (Plus2PM, SHSW-25) produce **one `SHELLYnnnn` per component index**; the Web UI labels them `… (Ch N)`.

`ChannelKind` and the per-kind HM paramset/description shapes live entirely in `hm/HmDeviceModel.ts` (`getParamsetDescription`, `kindToType`, `deviceTypeFor`, `buildChannelDescription`, `buildDeviceDescription`). `OPERATIONS` is a bitmask: `7`=read+write+event (actuator), `5`=read+event (sensor). **Don't invent TYPE strings** — they must stay names the CCU's device database knows.

### Registration & re-announcement (descriptor versioning)

Gen2 channels can only be inferred once the first status arrives — **after** `deviceFound`. `ShellyBridge.syncDeviceRegistration(mac)` is therefore called on `deviceFound` *and* on every `deviceEvent`; an in-memory per-mac layout signature (`channelSigs`) makes that cheap, and on change it registers channels in the registry and calls `announceIfChanged`.

Device/channel **names** exist only in ReGa's DOM (not in the XML-RPC protocol). After announcing, `ShellyBridge.scheduleCcuRename` POSTs a ReGa script (`hm/RegaClient.ts`, HVI's RegaRequest pattern; endpoint `hm.regaUrl`, default `http://127.0.0.1:8181/tclrega.exe`, body ISO-8859-1) that renames the device + channels to the Shelly name (multi-channel: same `… (Ch N)` suffix as the Web UI). The script only renames while the current ReGa name still contains the `SHELLYnnnn` address — user renames are never overwritten; unnamed Shellys (name == mac) are skipped.

`announceIfChanged` compares against the **persisted** `announcedSig` in `devices.json` (not the in-memory one) before sending `deleteDevices`/`newDevices` — the signature evolves event-by-event on every startup (`0:SWITCH:-` → `0:SWITCH:M` → …), and without the persisted gate each restart would re-announce and wipe the device's CCU room/program assignments. It also no-ops while no CCU is registered; `onCcuRegistered` (called from `init`) catches up on layout changes that happened in the meantime.

`DESCRIPTOR_VERSION` (in `HmDeviceModel.ts`) is persisted in `devices.json` under `_meta` and also **salts the `getParamsetId` cache key** (ReGa caches paramset descriptions under that id and would otherwise serve stale ones forever). **Bump it whenever the served HM descriptions change shape** — on the next CCU `init` the bridge sends `deleteDevices` for all persisted addresses, clears all `announcedSig`s, and re-announces, forcing the CCU to drop cached descriptions and relearn (this loses room/program assignments on the CCU, so don't bump casually).

Controllable datapoints must carry a **`CONTROL`** string in their VALUES paramset description (e.g. `SWITCH.STATE`, `DIMMER.LEVEL`, `BLIND.LEVEL`/`BLIND.STOP`, `DOOR_SENSOR.STATE`, `POWERMETER.*`) — the WebUI keys its native channel controls on it; without it ReGa renders a generic `[=FALSE]` value box. The strings must match the CCU's own `/firmware/rftypes/*.xml`; each param also carries `ID` (its own name).

Param **`FLAGS` need the visible bit (1)** on every user-facing datapoint (service params use 9, sticky 24, WORKING 3): ReGa hides datapoints without it, and a channel whose datapoints are all hidden disappears from *Status und Bedienung* entirely (`DPs().EnumEnabledVisibleIDs()` gate in `hdevichannels.htm`) — this made the POWERMETER channel invisible.

### inferChannelKinds (the heart of mapping)

`DeviceMapper.inferChannelKinds(gen, model, state)` derives channels primarily from **live state keys** (`component:idx`, e.g. `switch:0`, `cover:0`, `pm1:0`, `temperature:0`). If no state is available yet and it's Gen1, it falls back to **model-name heuristics**. Notes:

- A `switch`/`relay` channel that also reports `POWER`/`ENERGY_COUNTER` additionally yields a `POWERMETER` channel at the same idx. `ShellyBridge.getChannelRows` (the **single** place for this logic) folds it into the actuator row as its `meter` companion → HM channel 2.
- `temperature`/`sensor` disambiguate to WEATHER vs MOTION vs (WATER|CONTACT) by which keys are present, with a model-name heuristic for flood vs contact.

## Value conversions (CHANNEL_VALUE_MAPS)

Conversion is centralized in `DeviceMapper.CHANNEL_VALUE_MAPS[kind].{toHomematic, toShelly}`. Non-obvious bits:

- **Cover/blind LEVEL follows HM convention: `0.0`=closed … `1.0`=open** — numerically the same as Shelly `current_pos/100` (Shelly `0`=closed…`100`=open), normalized in the Gen1/Gen2 clients, not the mapper. `toShelly` for BLIND: `shellyPos = hmLevel * 100`, sent via real `Cover.GoToPosition` / `roller?go=to_pos`.
- **Dimmer LEVEL is HM `0.0–1.0` float** both ways. Shelly brightness is `0–100`, divided by 100 in the clients; `toShelly` multiplies back to a percent.
- **WATER STATE is the HM-Sec-WDS enum** (`0`=DRY, `2`=WATER), not a bool. **MOTION brightness** maps lux → `BRIGHTNESS` clamped 0–255 (HM-Sec-MDIR scale). **CURRENT converts A → mA.** Sensor kinds (`WEATHER/CONTACT/MOTION/WATER/POWERMETER/MAINTENANCE`) are read-only — their `toShelly` returns `null`.
- `buildChannelDeviceInfo.getState` runs raw component state through `toHomematic` so `getParamset`/`getValue` serve HM semantics too, and synthesizes `UNREACH` from `dev.online` on channel 0.

## Write echoes are forwarded (no suppression — do not reintroduce)

When the bridge writes to a Shelly, the Shelly reports the change back and that report **must** be pushed to the CCU: a real BidCos interface sends an `event` after the device ACKs a command, and the CCU WebUI only updates its controls from that event. An earlier `pendingWrites` echo-suppression left the WebUI stuck on the old state after every CCU-initiated switch. There is no loop risk — the CCU does not turn incoming events back into `setValue` calls, and `ShellyConnector.onUpdate` already drops no-op state reports (value unchanged).

## Gen1 vs Gen2 clients

- **Gen2** (`gen===2||3`): persistent **outbound WebSocket** to `ws://<ip>/rpc`, parses `NotifyStatus`/`NotifyFullStatus` pushes; commands go over **HTTP RPC** (`/rpc/<Method>?...`) with on-demand **MD5 digest auth** (challenge parsed from the 401). Exponential reconnect backoff to 60 s.
- **Gen1**: HTTP **polling** of `/status` on `pollInterval` (default 5 s), diffing against `lastStatus` to emit only changes; commands are simple `GET /relay/N`, `/roller/0`, `/light/0`. Basic auth via `opts.auth`.
- **CoIoT** (`CoIoTListener`): UDP/CoAP multicast on `224.0.1.187:5683` — hand-parses the CoAP header/options to pull the device MAC (custom option `3332`) and the `cit/s` JSON `G` array. Used for **battery-powered Gen1 sensors** that aren't reachable for polling; IDs map via `COIOT_ID_MAP`. A first-seen device triggers an HTTP `probe()` of its IP.

`ShellyConnector.onUpdate` is the single funnel: it stores `state[component:idx][KEY]`, suppresses no-op writes, and emits `deviceEvent`. `applyGen1Status`/`applyGen2Status` re-synthesize update events from a full status response (used by the 5-minute resync `refreshAllStatuses` + `pushAllStatesToCcu`).

## AddressRegistry & devices.json

`AddressRegistry` (in `DeviceMapper.ts`) persists the `(mac, channelIdx) ↔ SHELLYnnnn` mapping plus device metadata to `devices.json` (in `SHELLY_HOMEMATIC_DATA_DIR`, else cwd). `getOrCreateChannel` allocates the next `SHELLYnnnn` (zero-padded, monotonic via `nextIdx`) and saves immediately.

`load()` carries **migration logic** for two older on-disk formats (bare `mac→hmAddress` string, and `mac→{hmAddress, channels[]}`) into the current `mac→{name,model,gen,ip,channels:{idx→{hmAddress,kind}}}` shape. The committed `devices.json` in the repo root is still in an **older format** — expect migration on load; don't assume the in-memory shape matches the file verbatim. The reserved top-level `_meta` key holds `{descriptorVersion}` and is skipped by the device-parsing loop. Migrated entries may carry a wrong `kind` (e.g. SWITCH for a dimmer) — `syncDeviceRegistration` corrects it from live state while keeping the allocated `SHELLYnnnn` address.

## Exposure model

Opt-in by default (`devices.defaultExposed: false`). Per-channel overrides in `config.devices.exposed[address]` where `address = "${mac}:${channelIdx}"`. `setDeviceExposed` toggling immediately calls `notifyNewDevices` / `notifyDeleteDevices` so the CCU sees the change without a restart. The Web UI (`web/WebServer.ts`, `html/`) reads/writes these via `/api/?method=...` (getDevices, setDeviceExposed, setDefaultExposed, setRelayState, setLevel, coverCommand, discoverNow, restartBridge, getLog, getBridgeStatus).

## Config

Copy `config.example.json` to `config.json`. Config is **shallow-merged** over `DEFAULT_CONFIG` (one level deep — see `mergeConfig`); a partial `config.json` (like the repo's, which only sets `devices`) inherits all other defaults. Under the addon, `seedAddonConfigIfMissing` writes a seed from `config.example.json` on first run. **Shelly credentials never go in config files** — they come from `SHELLY_USER`/`SHELLY_PASSWORD` env vars (the addon loads them from `${ADDONCFG_DIR}/shelly.env`).

## CCU addon packaging & deploy

This shares the hard-won CCU3 constraints with the sister project. The CCU runs an **old glibc with no stock Node ≥ 20** — the addon bundles the unofficial **Node 18 armv6l** binary, and the app is **esbuild-bundled to a single CJS `dist/index.js`** (Node 18 can't `require()` ESM) so there are no runtime `node_modules`.

- **`npm run build:addon`** (`scripts/build-addon.sh`): tsc → esbuild bundle → stages `node/bin/node` (sha256-verified, cached in `build-cache/`), `html/`, `config.example.json`, rc.d, www installer → `dist-addon/shelly-homematic-<VERSION>.tar.gz` for the WebUI installer.
- **`scripts/deploy.sh`** (fast inner loop): rebuilds only the bundle and pushes `dist/index.js` over SSH, then `rc.d restart` + log tail. Credentials in **`.env.local`** (gitignored): `CCU_HOST`, `CCU_SSH_USER`, `CCU_SSH_PASSWORD`; needs `sshpass`. Flags: no-arg = build+push+restart; `--first` = full install (uploads html/rc.d, **installs the bundled Node runtime** — same sha256-verified binary as the tarball, cached in `build-cache/`, skipped when the remote already has the right version; never symlinks to other addons so the install works standalone — and registers the `ShellyHM` `<ipc>` in `InterfacesList`); `--no-build`; `--logs` (tail only).
- **`addon/update_script`** registers the addon in `hm_addons.cfg` **and** appends the `ShellyHM` `<ipc>` to `InterfacesList` (this is what makes the CCU treat Shellys as a native interface). `addon/rc.d/shelly-homematic` runs the bundled node (falling back to system `node`), sets `SHELLY_HOMEMATIC_DATA_DIR`, and uses busybox `start-stop-daemon` with a manual kill-wait loop (no `--retry`). `uninstall` deregisters from both files via `tclsh`.

## Conventions

- Logging goes through `getLogger()` from `utils/Logger`; call `initLogger(config.logging)` before use (index.ts inits twice: once with defaults, once after config load).
- The HM interface port is **2121** by default (the `ShellyHM` interface), distinct from the real CCU interfaces (2001/2010/9292). The Web UI defaults to **8081**.
