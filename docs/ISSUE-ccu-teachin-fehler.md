# Issue: Shelly devices reach CCU Posteingang but teach-in shows "Fehler"

Status: **RESOLVED** (2026-06-11). See "Resolution" at the end. Devices appeared
in the CCU Posteingang (inbox) with correct native types and icons, but every one
showed **"Fehler"** in the *Fertig* column and could not be fully taught in.

This file summarizes a long debugging session: what was fixed, what still fails,
and the current hypothesis. Reference implementations used throughout:
- thkl **Homematic-Virtual-Interface** (HVI) — `github.com/thkl/Homematic-Virtual-Interface` (open-source Node virtual XML-RPC interface, our closest analog)
- **CUxD** — `github.com/jens-maus/cuxd` (packaging only; daemon is closed)
- **eQ-3 occu** — `github.com/eq-3/occu` (device defs in `firmware/rftypes/*.xml`)

## Environment / how to poke at it
- CCU at `CCU_HOST` (see `.env.local`), SSH via `sshpass`. RaspberryMatic/CCU3.
- Our interface: `ShellyHM` ipc `xmlrpc://127.0.0.1:2121`. Web UI `:8081`.
- ReGa logic layer = interfaceId `11430` (callback `xmlrpc://127.0.0.1:31999`);
  Java HMServer = `ShellyHM_java` (callback `http://127.0.0.1:39292/bidcos`).
- Bridge log: `/usr/local/etc/config/addons/shelly-homematic/shelly-homematic.log`
  (set `logging.level` to `debug` in that dir's `config.json`, restart, to see RPC).
- ReGa errors: `grep 2121 /var/log/messages | grep -iE 'ERROR|WARNING'`.
- Query ReGa devices: `tclsh` + `load tclrega.so; rega_script {... dom.GetObject(ID_DEVICES).EnumUsedIDs() ...}`.
- CCU's own device defs: `/firmware/rftypes/*.xml` (e.g. `rf_es_pmsw.xml`, `rf_s.xml`, `rf_bl.xml`, `rf_dim_1t_644.xml`).
- Deploy: `scripts/deploy.sh` (bundle only) / `--first` (full). rc.d is pushed separately when changed.

## What was fixed this session (all deployed)
1. **Callback self-restore** (`HmVirtualInterface`): the CCU only calls `init()` at
   ReGa/HMServer startup and never pings/re-inits our ipc interface, so every addon
   restart orphaned us. We now persist callbacks to `ccu-callbacks.json` and restore
   them (TCP-probed) on start.
2. **Boot-survivable registration** (`addon/rc.d/shelly-homematic`, `update_script`,
   `deploy.sh`): the CCU regenerates `InterfacesList.xml` at boot; our entry was only
   in the live file (and under the wrong name `InterfacesList`). rc.d now re-adds the
   `<ipc>` entry to the live file **and** the template `/etc/config_templates/InterfacesList.xml`
   and starts the daemon at **S55** (before ReGa at S70) via an `init` case.
3. **Re-announce on registration** (`ShellyBridge.onCcuRegistered` + per-session
   `sessionAnnounced`): the Posteingang is filled by `newDevices`, not `listDevices`.
   We now re-announce every exposed device on each CCU registration (even devices
   discovered after registration), without the persisted `announcedSig` gate. No
   delete first (so configured devices keep room/program assignments).
4. **Self-closing XML-RPC tags** (`HmVirtualInterface.fixSelfClosing`): the CCU's C++
   parser parses `<struct/>`/`<string/>`/`<array/>`… as **nil**. An empty MASTER
   paramset serialized to `<struct/>` → `getParamsetDescription` "failed" → device
   "Fehler". Now all empty container tags are expanded to explicit pairs. **This was
   the first cause of "Fehler" and is fixed** (`SetObjectMasterDescAsMeta` errors gone).
5. **Missing RPC method handlers** (`HmVirtualInterface` dispatch): `getLinks`,
   `getLinkPeers`, `reportValueUsage` now return `[]`; `getParamsetId` returns a
   string; `getInstallMode`→0; `getMetadata`/`getAllMetadata`→`{}`. Previously the
   `default: ''` returned a string where ReGa expects an array → type mismatch.
6. **Descriptor fields to match HVI** (`HmDeviceModel`): added device `RX_MODE: 1`,
   fixed `INTERFACE` to the interface id (`ShellyHM`, was the Shelly model), added
   channel `VERSION`/`RF_ADDRESS`/`UPDATABLE`, set real per-type `VERSION`
   (Sw1-Pl=26, Dim1T-Pl=17, Bl1-FM=13, ES-PMSw1-Pl=16). `DESCRIPTOR_VERSION` bumped to 5.

After all of the above: devices appear in the Posteingang with correct types
(`HM-ES-PMSw1-Pl`, `HM-LC-Sw1-Pl`, `HM-LC-Bl1-FM`, `HM-LC-Dim1T-Pl`) and **ReGa logs
NO XML-RPC errors for interface 2121** — i.e. every `getDeviceDescription` /
`getParamsetDescription` / `getParamset` / `getValue` / `getLinks` call succeeds.
**But teach-in still shows "Fehler".**

## The remaining problem
ReGa accepts all our RPC responses (no faults, no nil) yet still marks the device
"Fehler" in the Posteingang *Fertig* column — a **semantic/content validation
failure inside ReGa**, not a transport error. We have not yet found where ReGa
reports *why*.

## Current hypothesis (most → least likely)
1. **Incomplete paramset descriptions.** We serve a minimal hand-built `VALUES`
   paramset (e.g. SWITCH = STATE + WORKING) and an **empty `MASTER`**. HVI serves the
   *complete real* definitions: device `MASTER` has `INTERNAL_KEYS_VISIBLE`, channel
   `MASTER` has `AES_ACTIVE`, `VALUES` has the full set (STATE, ON_TIME, INHIBIT,
   WORKING, INSTALL_TEST), plus a whole `LINK` paramset — see
   `/tmp/hvi-ref/devices/HM-LC-Sw1-Pl.json`. ReGa, knowing the type from its own
   `rftypes` DB, may require the paramsets/params to match before it considers the
   device "complete". **This is the leading suspect.** Next step: capture the FULL
   debug RPC trace during a teach-in attempt (set bridge log to `debug`, watch which
   call/paramset ReGa fetches last before giving up), and/or compare our
   `getParamsetDescription` output param-by-param against `rf_es_pmsw.xml` /
   `HM-LC-Sw1-Pl.json`.
2. **`getParamset(MASTER)` returns empty.** HVI returns actual MASTER values
   (e.g. `INTERNAL_KEYS_VISIBLE: 0`). We return `{}`. ReGa may need the master
   values to finish config.
3. **`putParamset` not handled.** During teach-in ReGa may `putParamset` (MASTER/AES)
   to configure the device; we return `''` via default. HVI implements `putParamset`
   (`lib/HomematicLogicLayer.js` ~line 445). Check whether ReGa calls it and what it expects back.
4. **AES.** The real `HM-ES-PMSw1-Pl` rftypes is `supports_aes="true"`. If ReGa
   expects an AES handshake we don't do, config stays pending. HVI sets `AES_ACTIVE: 0`
   in the channel description (we do too) — may or may not be enough.

Ruled out: VERSION value mismatch (HVI uses 41 for Sw1-Pl while the CCU DB says 26,
and HVI still works). Self-closing tags (fixed). Missing array-returning methods (fixed).

## Suggested next steps
1. Reproduce cleanly: wipe ReGa's Shelly objects (`rega_script
   "dom.DeleteObject(dom.GetObject(<id>))"` per id under `ID_DEVICES` whose Address
   contains `SHELLY`; then `system.Save()`), reboot, let exactly one device appear.
2. Set bridge `logging.level=debug`, restart, and capture the **complete** RPC
   sequence ReGa makes during a teach-in attempt — find the last call before "Fehler"
   and what it returns. That should pinpoint hypothesis 1 vs 2 vs 3.
3. Most promising fix: **serve fuller, real paramsets** for the impersonated types,
   modeled on HVI's `devices/*.json` and the CCU's `rftypes/*.xml` — at minimum
   non-empty `MASTER` (device: INTERNAL_KEYS_VISIBLE; channel: AES_ACTIVE) and the
   full real `VALUES` param list. Consider generating `HmDeviceModel` paramsets from
   the rftypes rather than hand-maintaining them.
4. Watch for `putParamset` in the trace; implement it (ack like HVI) if called.

## Relevant code
- `src/hm/HmVirtualInterface.ts` — XML-RPC server, dispatch, `fixSelfClosing`, callback persistence.
- `src/hm/HmDeviceModel.ts` — `getParamsetDescription`, `buildParamset`,
  `buildChannelDescription`, `buildDeviceDescription`, `versionFor`, `CHANNEL_*` paramsets.
- `src/bridge/ShellyBridge.ts` — `onCcuRegistered`, `announceIfChanged`,
  `sessionAnnounced`, `DESCRIPTOR_VERSION` (currently 5).
- `addon/rc.d/shelly-homematic`, `addon/update_script`, `scripts/deploy.sh` — registration.

## Resolution (2026-06-11)

All hypotheses above were wrong — the paramsets were fine. Two real bugs:

### What "Fehler" actually means (found in CCU WebUI source)
The Posteingang *Fertig* column is driven by `allChannelsAvailable()` in
`/www/webui/webui.js` (~line 32456): it polls the JSON-API `Device.get` once per
second (max 60×) and succeeds as soon as `device.channels.length` is **non-zero
and stable for two polls**. On timeout it sets
`sessionStorage["teachInFailure_<id>"]` → `showDeviceError()` → "Fehler".
Querying ReGa (`oDev.Channels().Count()` via tclrega) showed every SHELLY device
existed with **0 channels** — ReGa had created the device objects but dropped
every channel object.

### Bug 1: outbound newDevices contained self-closing tags
The same `<string/>`-as-nil parser bug as issue item 4, but on the **client**
side: `fixSelfClosing` was only applied to our XML-RPC *server responses*. The
outbound callbacks (`newDevices`, `event`, …) went through the stock `xmlrpc`
client, whose serializer emits `<string/>` for empty strings and `<data/>` for
empty arrays. Our **channel** descriptions contain five empty strings
(`LINK_SOURCE_ROLES`, `LINK_TARGET_ROLES`, `GROUP`, `TEAM`, `TEAM_TAG`) and two
empty arrays — so ReGa parsed every channel struct in `newDevices` as nil and
created only the device rows (which happen to contain no empty strings). HVI is
unaffected because it bundles a patched `homematic-xmlrpc` whose serializer
never emits self-closing tags (verified by serializing identical payloads with
both libs).

**Fix:** `HmVirtualInterface.createCcuClient` — hand-rolled XML-RPC client
(mirroring the hand-rolled server) that serializes via the same lib, applies
`fixSelfClosing`, and POSTs with explicit `Content-Length`.

### Bug 2: deleteDevices/newDevices race during layout settling
After the fix, single-channel devices healed but the `HM-ES-PMSw1-Pl` ones
*vanished* from ReGa: on (re)connect the layout signature evolves event-by-event
(`0:SWITCH:-` → `0:SWITCH:M` → `…,1:SWITCH:M`), each step triggering a
`deleteDevices`+`newDevices` cycle. The calls were independent fire-and-forget
HTTP requests with **no ordering guarantee**, so a stale `deleteDevices` could
arrive after the final `newDevices` and delete the device again.

**Fix:** (a) `createCcuClient` FIFO-serializes all calls per CCU client;
(b) `ShellyBridge.syncDeviceRegistration` debounces announcements until the
layout signature has been stable for 2 s (`ANNOUNCE_SETTLE_MS`) — registry
registration stays immediate, only the CCU announcement waits.

### Verified
After deploy, ReGa shows all four devices with full channel sets
(Sw1-Pl/Bl1-FM: 2 channels, ES-PMSw1-Pl: 3 channels incl. POWERMETER), no
XML-RPC errors for port 2121 in `/var/log/messages`. The WebUI channel poll now
succeeds, so the Posteingang shows the *Fertig* button instead of "Fehler".
Regression test: `test/HmVirtualInterface.test.ts` pins the outbound wire format
(no self-closing tags, channel structs present).

No `DESCRIPTOR_VERSION` bump was needed — the served descriptions are unchanged;
only the wire encoding of outbound calls changed.
