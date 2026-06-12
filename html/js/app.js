/**
 * Shelly-Homematic Bridge — Dashboard App
 * Vanilla JS, no build step
 */

// --- API helper ---
async function fetchApi(method, options = {}) {
  const url = `/api/?method=${method}`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`API ${method}: ${res.status}`);
  return res.json();
}

// --- Tab switching ---
function switchTab(tabId, el) {
  document.querySelectorAll('.tab-content-pane').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.sidebar-nav .nav-link').forEach(a => a.classList.remove('active'));
  const pane = document.getElementById('tab-' + tabId);
  if (pane) pane.style.display = '';
  if (el) el.classList.add('active');
  if (tabId === 'dashboard') loadDashboard();
  if (tabId === 'devices') loadDevicesTab();
  if (tabId === 'log') loadLog();
  if (tabId !== 'log') stopLogAutoRefresh();
}

// --- Dashboard ---
let dashboardTimer = null;

async function loadDashboard() {
  clearInterval(dashboardTimer);
  await refreshDashboard();
  dashboardTimer = setInterval(refreshDashboard, 5000);
}

async function refreshDashboard() {
  try {
    const data = await fetchApi('getBridgeStatus');
    const dot = document.querySelector('#ccu-status .status-dot');
    const txt = document.getElementById('ccu-status-text');
    if (data.ccuRegistered) {
      dot.className = 'status-dot online';
      txt.textContent = 'Registered';
    } else {
      dot.className = 'status-dot offline';
      txt.textContent = 'Not registered';
    }
    document.getElementById('ccu-interface').textContent = data.interfaceName || '--';
    document.getElementById('device-count').textContent = data.deviceCount ?? '--';
    document.getElementById('exposed-count').textContent = data.exposedCount ?? '--';
    document.getElementById('hm-port').textContent = data.hmPort ?? '--';
    document.getElementById('uptime').textContent = formatUptime(data.uptime || 0);
    document.getElementById('interface-name').textContent = data.interfaceName || '--';
    document.getElementById('sidebar-version').textContent = data.version ? 'v' + data.version : '';
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Dashboard refresh failed:', err);
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// --- Devices ---
let allDevices = [];
let devicesTimer = null;

async function loadDevicesTab() {
  clearInterval(devicesTimer);
  await loadDevices();
  devicesTimer = setInterval(loadDevices, 5000);
}

async function loadDevices() {
  try {
    const data = await fetchApi('getDevices');
    allDevices = data.devices || [];
    document.getElementById('devices-total').textContent = `${allDevices.length} device${allDevices.length !== 1 ? 's' : ''}`;
    const defToggle = document.getElementById('default-exposed');
    if (defToggle) defToggle.checked = data.defaultExposed !== false;
    filterDeviceTable();
  } catch (err) {
    console.error('Failed to load devices:', err);
    document.getElementById('device-tbody').innerHTML =
      '<tr><td colspan="7" class="text-center text-body-secondary py-4">Failed to load devices</td></tr>';
  }
}

function renderDeviceTable(devices) {
  const tbody = document.getElementById('device-tbody');
  if (!devices.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-body-secondary py-4">No Shelly devices discovered yet</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map(d => {
    const addr = esc(d.address);
    const checked = d.exposed ? 'checked' : '';
    const onlineBadge = d.online
      ? '<span class="badge badge-online">online</span>'
      : '<span class="badge badge-offline">offline</span>';
    return `
    <tr>
      <td>
        <div class="form-check form-switch expose-switch">
          <input class="form-check-input" type="checkbox" ${checked}
                 data-address="${addr}"
                 onchange="toggleExposed('${addr}', this.checked)">
        </div>
      </td>
      <td>
        <div class="fw-medium">${esc(d.name || d.address)}</div>
        <div class="text-body-secondary" style="font-size:0.78rem">${esc(d.model || '')}</div>
      </td>
      <td class="mono">${esc(d.ip || '--')}</td>
      <td><span class="badge badge-gen">Gen ${d.gen || '?'}</span></td>
      <td>${onlineBadge}</td>
      <td class="mono">${esc(d.hmAddress || '--')}</td>
      <td>${renderDeviceControl(d)}</td>
    </tr>
  `;
  }).join('');
}

function renderDeviceControl(d) {
  const channels = d.channels || [];
  if (!channels.length) return '<span class="text-body-secondary">--</span>';

  return channels.map(ch => {
    const addr = esc(d.address);
    const idx = ch.idx;
    const state = ch.state || {};

    switch (ch.kind) {
      case 'SWITCH': {
        const isOn = !!state.STATE;
        return `
          <div class="channel-control">
            <span class="badge-hm-kind">SW</span>
            <div class="form-check form-switch d-inline-block ms-2">
              <input class="form-check-input" type="checkbox" ${isOn ? 'checked' : ''}
                     onchange="setRelay('${addr}', ${idx}, this.checked)">
            </div>
            <span class="state-pill ${isOn ? 'on' : 'off'}" style="font-size:0.75rem">
              <span class="dot"></span>${isOn ? 'On' : 'Off'}
            </span>
          </div>`;
      }
      case 'DIMMER': {
        const level = typeof state.LEVEL === 'number' ? Math.round(state.LEVEL * 100) : 0;
        const isOn = level > 0;
        return `
          <div class="channel-control">
            <span class="badge-hm-kind">DIM</span>
            <span class="state-pill ${isOn ? 'on' : 'off'}" style="font-size:0.75rem">
              <span class="dot"></span>${level}%
            </span>
            <input type="range" min="0" max="100" value="${level}" class="dim-slider"
                   data-address="${addr}" data-idx="${idx}"
                   oninput="this.nextElementSibling.textContent=this.value+'%'"
                   onchange="setLevel('${addr}', ${idx}, parseInt(this.value))">
            <span class="dim-label">${level}%</span>
          </div>`;
      }
      case 'BLIND': {
        const pos = typeof state.LEVEL === 'number' ? Math.round(state.LEVEL * 100) : '--';
        return `
          <div class="channel-control">
            <span class="badge-hm-kind">BLD</span>
            <div class="cover-btns">
              <button class="btn btn-xs btn-outline-secondary" onclick="coverCmd('${addr}', ${idx}, 'open')">▲</button>
              <button class="btn btn-xs btn-outline-secondary" onclick="coverCmd('${addr}', ${idx}, 'stop')">■</button>
              <button class="btn btn-xs btn-outline-secondary" onclick="coverCmd('${addr}', ${idx}, 'close')">▼</button>
            </div>
            <span class="state-detail">${pos}% open</span>
          </div>`;
      }
      case 'WEATHER': {
        const temp = state.TEMPERATURE != null ? `${Number(state.TEMPERATURE).toFixed(1)} °C` : '--';
        const hum = state.HUMIDITY != null ? ` / ${Number(state.HUMIDITY).toFixed(0)}%` : '';
        return `<div class="channel-control"><span class="badge-hm-kind">WTH</span> <span class="state-temp">${temp}${hum}</span></div>`;
      }
      case 'CONTACT': {
        const open = !!state.STATE;
        return `<div class="channel-control"><span class="badge-hm-kind">CNT</span> <span class="state-pill ${open ? 'on' : 'off'}"><span class="dot"></span>${open ? 'Open' : 'Closed'}</span></div>`;
      }
      case 'MOTION': {
        const motion = !!state.MOTION;
        return `<div class="channel-control"><span class="badge-hm-kind">MOT</span> <span class="state-pill ${motion ? 'on' : 'off'}"><span class="dot"></span>${motion ? 'Motion' : 'Clear'}</span></div>`;
      }
      case 'WATER': {
        const flood = !!state.STATE;
        return `<div class="channel-control"><span class="badge-hm-kind">FLD</span> <span class="state-pill ${flood ? 'on' : 'off'}"><span class="dot"></span>${flood ? 'FLOOD' : 'OK'}</span></div>`;
      }
      case 'POWERMETER': {
        const power = state.POWER != null ? `${Number(state.POWER).toFixed(1)} W` : '--';
        const energy = state.ENERGY_COUNTER != null ? ` / ${Number(state.ENERGY_COUNTER).toFixed(0)} Wh` : '';
        return `<div class="channel-control"><span class="badge-hm-kind">PM</span> <span class="state-temp">${power}${energy}</span></div>`;
      }
      default:
        return `<span class="text-body-secondary" style="font-size:0.8rem">${esc(ch.kind)}</span>`;
    }
  }).join('');
}

async function setRelay(address, channel, on) {
  try {
    await fetchApi('setRelayState', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, channel, on }),
    });
  } catch (err) {
    console.error('setRelay failed:', err);
    alert('Failed to set relay state. Check bridge logs.');
  }
}

async function setLevel(address, channel, pct) {
  try {
    await fetchApi('setLevel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, channel, level: pct }),
    });
  } catch (err) {
    console.error('setLevel failed:', err);
    alert('Failed to set level. Check bridge logs.');
  }
}

async function coverCmd(address, channel, cmd) {
  try {
    await fetchApi('coverCommand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, channel, cmd }),
    });
  } catch (err) {
    console.error('coverCommand failed:', err);
    alert('Failed to send cover command. Check bridge logs.');
  }
}

async function toggleExposed(address, exposed) {
  try {
    await fetchApi('setDeviceExposed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, exposed }),
    });
    const dev = allDevices.find(d => d.address === address);
    if (dev) dev.exposed = exposed;
    document.getElementById('expose-alert').style.display = '';
  } catch (err) {
    console.error('Failed to toggle exposure:', err);
    alert('Failed to save. Check bridge logs.');
  }
}

async function toggleDefaultExposed() {
  const checked = document.getElementById('default-exposed').checked;
  try {
    await fetchApi('setDefaultExposed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultExposed: checked }),
    });
  } catch (err) {
    console.error('Failed to save default exposure:', err);
    alert('Failed to save. Check bridge logs.');
  }
}

function filterDeviceTable() {
  const query = document.getElementById('device-search').value.toLowerCase().trim();
  let list = allDevices;
  if (query) {
    list = list.filter(d =>
      (d.name || '').toLowerCase().includes(query) ||
      (d.address || '').toLowerCase().includes(query) ||
      (d.model || '').toLowerCase().includes(query) ||
      (d.ip || '').toLowerCase().includes(query)
    );
  }
  renderDeviceTable(list);
  const total = allDevices.length;
  const badge = document.getElementById('devices-total');
  if (badge) {
    badge.textContent = list.length === total
      ? `${total} device${total !== 1 ? 's' : ''}`
      : `${list.length} of ${total} devices`;
  }
}

// --- Log viewer ---
let logTimer = null;

async function refreshLog() {
  try {
    const data = await fetchApi('getLog&lines=300');
    const view = document.getElementById('log-view');
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    view.textContent = (data.lines && data.lines.length) ? data.lines.join('\n') : (data.note || 'Log is empty');
    if (atBottom) view.scrollTop = view.scrollHeight;
  } catch (err) {
    console.error('Failed to load log:', err);
  }
}

function setLogAutoRefresh(enabled) {
  clearInterval(logTimer);
  logTimer = null;
  if (enabled) logTimer = setInterval(refreshLog, 3000);
}

function stopLogAutoRefresh() {
  clearInterval(logTimer);
  logTimer = null;
}

async function loadLog() {
  await refreshLog();
  const view = document.getElementById('log-view');
  view.scrollTop = view.scrollHeight;
  setLogAutoRefresh(document.getElementById('log-autorefresh').checked);
}

async function discoverNow() {
  try {
    await fetchApi('discoverNow', { method: 'POST' });
    setTimeout(loadDevices, 2000);
  } catch (err) {
    console.error('discoverNow failed:', err);
  }
}

async function factoryReset() {
  const warning =
    'Factory reset deletes ALL stored data:\n\n' +
    '• device address mapping (devices.json)\n' +
    '• exposure configuration (config.json)\n' +
    '• CCU callback registrations\n\n' +
    'Devices already learned by the CCU become orphans and must be ' +
    're-exposed and re-taught. Use this to start over or before ' +
    'uninstalling the addon for good.\n\nContinue?';
  if (!confirm(warning)) return;
  try {
    const result = await fetchApi('factoryReset', { method: 'POST' });
    alert(result.message || 'Stored data deleted. Bridge restarting.');
    setTimeout(() => window.location.reload(), 3000);
  } catch (err) {
    console.error('factoryReset failed:', err);
    alert('Factory reset failed. Check the log.');
  }
}

async function restartBridge() {
  const btn = document.getElementById('restart-btn');
  if (!confirm('Restart the bridge now?')) return;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Restarting...';
  try {
    await fetchApi('restartBridge', { method: 'POST' });
    const startedAt = Date.now();
    const waitForUp = async () => {
      while (Date.now() - startedAt < 60000) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const status = await fetchApi('getBridgeStatus');
          if (status && status.uptime < (Date.now() - startedAt) / 1000) return true;
        } catch { /* briefly unreachable */ }
      }
      return false;
    };
    const ok = await waitForUp();
    if (ok) {
      refreshDashboard();
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    } else {
      btn.innerHTML = 'Timed out';
      setTimeout(() => { btn.innerHTML = originalHtml; btn.disabled = false; }, 3000);
    }
  } catch (err) {
    console.error('Restart failed:', err);
    alert('Failed to trigger restart. Check bridge logs.');
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

// --- Utility ---
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
});
