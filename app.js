'use strict';
/* ============================================================
   BYB-NORTE — DASHBOARD DE MONITOREO v4
   El receptor envia una linea JSON por lectura, por USB (Web Serial)
   o por Bluetooth BLE (Web Bluetooth). Mismo formato en ambos:
     {"s1":54.7,"s2":null,"s3":32.5,"s4":57.4,"rpm":1442.0}
     {"status":"SIN SENAL DEL TRANSMISOR"}
   La hora de cada lectura es la del equipo donde corre la app.
   ============================================================ */

const SENSOR_IDS = ['s1', 's2', 's3', 's4'];
const SENSOR_COLOR = { s1: '#2563eb', s2: '#f59e0b', s3: '#dc2626', s4: '#16a34a' };
const STATUS_LABEL = { NORMAL: 'NORMAL', ALERTA: 'ALERTA', CRITICO: 'CRÍTICO', DESACTIVADO: 'DESACTIVADO', SINDATOS: 'SIN DATOS', FALLA: 'FALLA SENSOR', SINSENAL: 'SIN SEÑAL' };
const LIVE_STATUS = ['NORMAL', 'ALERTA', 'CRITICO'];
const STALE_TIMEOUT_MS = 15000;   // sin lectura por este tiempo => SIN SEÑAL
const HYST = 1.0;                 // histeresis de alertas (°C)
const MAX_POINTS = 30;            // puntos de los graficos en vivo
const SERIES_MAX = 2400;          // puntos maximos de la serie de toda la sesion (se diezma sola)
const RPM_RUN_MIN = 5;            // rpm bajo esto = equipo detenido (no entra al promedio)
const STORE_KEY = 'byb-norte-v4';
const DEFAULT_NAMES = { s1: 'Lado Carga', s2: 'Lado Libre', s3: 'Estator', s4: 'Auxiliar' };   // nombres por defecto (editables)
const OLD_DEFAULT_NAMES = ['Rod. Lado Acople (AC)', 'Rod. Lado Ventilador (FV)', 'Bobinado Fase A (WA)', 'Carcasa Motor (MC)'];
const DEFAULT_YELLOW = 45;       // alerta amarilla por defecto (°C)
const DEFAULT_RED = 50;          // alerta roja por defecto (°C)

const $ = id => document.getElementById(id);
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pad2 = n => String(n).padStart(2, '0');
const hhmmss = d => d.toLocaleTimeString('es-CL', { hour12: false });

function mkSensor(name) {
  return { name, enabled: true, value: null, yellow: DEFAULT_YELLOW, red: DEFAULT_RED, history: [], status: 'SINDATOS', level: 0,
    alertEvents: 0, critEvents: 0, sessMin: null, sessMax: null, sessSum: 0, sessN: 0, lastOk: null };
}

const state = {
  mode: 'demo',                 // demo | usb | ble | idle (desconectado, conserva datos reales)
  recording: false, intervalMin: 10, lastLogTime: null,
  readingsCount: 0, lastReadingTime: null, sessionStart: null,
  logs: [], alerts: [], series: [], seriesStep: 4000, lastSeriesT: 0, labels: [],
  sensors: {
    s1: mkSensor(DEFAULT_NAMES.s1),
    s2: mkSensor(DEFAULT_NAMES.s2),
    s3: mkSensor(DEFAULT_NAMES.s3),
    s4: mkSensor(DEFAULT_NAMES.s4)
  },
  rpm: { value: null, nominal: 1450, history: [], sessSum: 0, sessN: 0, sessMax: 0, lastOk: null }
};

const isLive = () => state.mode === 'usb' || state.mode === 'ble';
const isDemo = () => state.mode === 'demo';
const hasData = () => state.readingsCount > 0 || state.logs.length > 0;

let combinedChart, sensorCharts = {}, simTimer;

/* ---------------- INIT ---------------- */
function init() {
  if (window.matchMedia('(max-width:980px)').matches) $('metaDetails').open = false;   // en celular parte plegado
  loadConfig();
  buildSensorCards();
  buildCombinedChart();
  buildSensorCharts();
  const restored = loadSession();
  rebuildTableHead(); renderTable(); updateSummary(); updateClock(); setModeUI(); refreshRecUI();
  setInterval(updateClock, 1000);
  setInterval(checkStale, 2000);
  setInterval(tickLog, 1000);
  setInterval(() => { if (hasData() && !isDemo()) saveSession(); }, 20000);
  $('footDate').textContent = new Date().toLocaleDateString('es-CL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  $('intervalSelect').value = String(state.intervalMin);
  $('intervalSelect').addEventListener('change', e => { state.intervalMin = parseInt(e.target.value, 10); addEvent('Intervalo de registro cambiado a ' + state.intervalMin + ' min.'); saveConfig(); });
  ['metaEmpresa', 'metaOT', 'metaOperador', 'metaArmador', 'metaEquipo', 'metaGrasa'].forEach(id => $(id).addEventListener('input', saveConfig));
  $('rpmNominal').addEventListener('input', onRpmNominalChange);

  $('recBtn').addEventListener('click', toggleRecording);
  $('mbRec').addEventListener('click', toggleRecording);
  $('btnManual').addEventListener('click', manualLog);
  $('btnNewSession').addEventListener('click', newSession);
  ['btnPdf', 'btnPdfTop', 'mbPdf'].forEach(id => $(id).addEventListener('click', exportPdfReport));
  ['btnWord', 'btnWordTop', 'mbWord'].forEach(id => $(id).addEventListener('click', exportWordReport));
  window.addEventListener('pagehide', () => { if (hasData() && !isDemo()) saveSession(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && hasData() && !isDemo()) saveSession(); });

  initConnectMenu();
  initInstallAndUpdate();
  startSimulation();

  if (restored) {
    addEvent('Sesión anterior recuperada: ' + state.readingsCount + ' lecturas, ' + state.logs.length + ' filas de registro.', 'ev-alert');
    if (restored.wasRecording) addEvent('El registro estaba activo al cerrarse la app. Reconecta el receptor y presiona INICIAR REGISTRO para continuar.', 'ev-alert');
  } else {
    addEvent('Modo demo activo. Conecta el receptor (USB o Bluetooth) para datos reales.');
  }
  tryAutoUsb();   // link.js: reconecta solo el receptor USB ya autorizado
}

/* En demo, 1 "minuto" de intervalo = 1 segundo real. Con receptor real: minutos reales. */
function effectiveIntervalMs() { return isDemo() ? state.intervalMin * 1000 : state.intervalMin * 60000; }

/* ---------------- CONFIG / PERSISTENCIA ---------------- */
let cfgTimer = null;
function saveConfig() { clearTimeout(cfgTimer); cfgTimer = setTimeout(saveConfigNow, 400); }
function saveConfigNow() {
  try {
    const cfg = {
      meta: { empresa: $('metaEmpresa').value, ot: $('metaOT').value, operador: $('metaOperador').value, armador: $('metaArmador').value, equipo: $('metaEquipo').value, grasa: $('metaGrasa').value },
      intervalMin: state.intervalMin, rpmNominal: state.rpm.nominal, sensors: {}
    };
    SENSOR_IDS.forEach(id => { const s = state.sensors[id]; cfg.sensors[id] = { name: s.name, enabled: s.enabled, yellow: s.yellow, red: s.red }; });
    localStorage.setItem(STORE_KEY + ':cfg', JSON.stringify(cfg));
  } catch (e) { /* almacenamiento no disponible: la app sigue funcionando */ }
}
function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(STORE_KEY + ':cfg') || 'null');
    if (!cfg) return;
    if (cfg.meta) { $('metaEmpresa').value = cfg.meta.empresa || ''; $('metaOT').value = cfg.meta.ot || ''; $('metaOperador').value = cfg.meta.operador || ''; $('metaArmador').value = cfg.meta.armador || ''; $('metaEquipo').value = cfg.meta.equipo || ''; $('metaGrasa').value = cfg.meta.grasa || ''; }
    if ([5, 10, 20, 30].includes(cfg.intervalMin)) state.intervalMin = cfg.intervalMin;
    if (isFinite(cfg.rpmNominal)) { state.rpm.nominal = cfg.rpmNominal; $('rpmNominal').value = cfg.rpmNominal; }
    SENSOR_IDS.forEach(id => {
      const c = cfg.sensors && cfg.sensors[id]; if (!c) return;
      const s = state.sensors[id];
      if (c.name && !OLD_DEFAULT_NAMES.includes(c.name)) s.name = c.name;   // nombres viejos por defecto se reemplazan por los nuevos
      s.enabled = c.enabled !== false;
      if (isFinite(c.yellow)) s.yellow = c.yellow;
      if (isFinite(c.red)) s.red = c.red;
      if (!s.enabled) s.status = 'DESACTIVADO';
    });
  } catch (e) { /* config corrupta: se ignora */ }
}
function saveSession() {
  try {
    const ses = {
      logs: state.logs, alerts: state.alerts, series: state.series, seriesStep: state.seriesStep,
      readingsCount: state.readingsCount, sessionStart: state.sessionStart,
      lastReadingTime: state.lastReadingTime ? state.lastReadingTime.getTime() : null,
      wasRecording: state.recording, rpm: { sessSum: state.rpm.sessSum, sessN: state.rpm.sessN, sessMax: state.rpm.sessMax }, sensors: {}
    };
    SENSOR_IDS.forEach(id => { const s = state.sensors[id]; ses.sensors[id] = { alertEvents: s.alertEvents, critEvents: s.critEvents, level: s.level, sessMin: s.sessMin, sessMax: s.sessMax, sessSum: s.sessSum, sessN: s.sessN }; });
    localStorage.setItem(STORE_KEY + ':ses', JSON.stringify(ses));
  } catch (e) { /* cuota llena u otro: no interrumpe */ }
}
function loadSession() {
  try {
    const ses = JSON.parse(localStorage.getItem(STORE_KEY + ':ses') || 'null');
    if (!ses || (!ses.readingsCount && !(ses.logs && ses.logs.length))) return null;
    state.logs = ses.logs || []; state.alerts = ses.alerts || []; state.series = ses.series || [];
    state.seriesStep = ses.seriesStep || 4000; state.readingsCount = ses.readingsCount || 0;
    state.sessionStart = ses.sessionStart || null;
    state.lastReadingTime = ses.lastReadingTime ? new Date(ses.lastReadingTime) : null;
    if (ses.rpm) Object.assign(state.rpm, ses.rpm);
    SENSOR_IDS.forEach(id => { if (ses.sensors && ses.sensors[id]) Object.assign(state.sensors[id], ses.sensors[id]); });
    state.mode = 'idle';
    if (state.lastReadingTime) $('stripLastReading').textContent = hhmmss(state.lastReadingTime);
    $('stripReadingsCount').textContent = state.readingsCount;
    $('stripLogCount').textContent = state.logs.length;
    refreshRpmStats();
    return ses;
  } catch (e) { return null; }
}
function clearSavedSession() { try { localStorage.removeItem(STORE_KEY + ':ses'); } catch (e) {} }

/* ---------------- TARJETAS DE SENSOR ---------------- */
function buildSensorCards() {
  $('sensorGrid').innerHTML = SENSOR_IDS.map(id => {
    const s = state.sensors[id], tag = id.toUpperCase(), color = SENSOR_COLOR[id];
    return `
    <div class="card sensor-card${s.enabled ? '' : ' off'}" id="card-${id}" style="border-left-color:${color}">
      <div class="s-head">
        <span class="s-tag" style="background:${color}">${tag}</span>
        <div class="s-name-wrap"><input class="s-name-input" type="text" id="name-${id}" data-id="${id}" value="${escHtml(s.name)}" maxlength="40" autocomplete="off" spellcheck="false" enterkeyhint="done" title="Toca para cambiar el nombre" aria-label="Nombre del sensor ${tag} (editable)"></div>
        <label class="switch s-toggle">
          <input type="checkbox" id="toggle-${id}" data-id="${id}" ${s.enabled ? 'checked' : ''} aria-label="Habilitar sensor ${tag}">
          <span class="slider"></span>
        </label>
      </div>
      <div class="s-status-row">
        <div class="s-value"><span id="val-${id}">--</span><span class="unit">°C</span></div>
        <span class="s-badge ${s.status}" id="badge-${id}">${STATUS_LABEL[s.status]}</span>
      </div>
      <div class="s-chart-wrap"><canvas id="chart-${id}"></canvas></div>
      <div class="s-alerts-head"><span>ALERTAS POR TEMPERATURA (editable)</span><button type="button" class="thr-reset" id="reset-${id}" title="Volver a 45 / 50 °C">↺ 45 / 50</button></div>
      <div class="s-alerts">
        <div class="alert-field yellow"><span class="ico">⚠</span><label for="yellow-${id}">AMARILLA</label>
          <input type="number" inputmode="decimal" step="0.5" id="yellow-${id}" data-id="${id}" data-type="yellow" value="${s.yellow}"></div>
        <div class="alert-field red"><span class="ico">✖</span><label for="red-${id}">ROJA</label>
          <input type="number" inputmode="decimal" step="0.5" id="red-${id}" data-id="${id}" data-type="red" value="${s.red}"></div>
      </div>
      <div class="thr-warn" id="thr-${id}" hidden>El umbral amarillo debe ser menor que el rojo.</div>
    </div>`;
  }).join('');
  SENSOR_IDS.forEach(id => {
    $('name-' + id).addEventListener('input', e => updateSensorName(id, e.target.value));
    $('toggle-' + id).addEventListener('change', () => toggleSensorEnabled(id));
    ['yellow', 'red'].forEach(t => { const inp = $(t + '-' + id); inp.addEventListener('input', e => updateThreshold(id, t, e.target.value)); inp.addEventListener('focus', () => inp.select()); });
    $('reset-' + id).addEventListener('click', () => { $('yellow-' + id).value = DEFAULT_YELLOW; $('red-' + id).value = DEFAULT_RED; updateThreshold(id, 'yellow', DEFAULT_YELLOW); updateThreshold(id, 'red', DEFAULT_RED); }); 
    $('legS' + id.slice(1)).textContent = state.sensors[id].name;
  });
}

function updateSensorName(id, value) {
  state.sensors[id].name = value || id.toUpperCase();
  $('leg' + id.toUpperCase()).textContent = state.sensors[id].name;
  combinedChart.data.datasets[SENSOR_IDS.indexOf(id)].label = state.sensors[id].name;
  combinedChart.update('none');
  updateSummary(); rebuildTableHead(); renderTable(); saveConfig();
}
function updateThreshold(id, type, value) {
  const v = parseFloat(value);
  if (isFinite(v)) { state.sensors[id][type] = v; saveConfig(); }
  const s = state.sensors[id], bad = s.yellow >= s.red;
  $('thr-' + id).hidden = !bad;
  ['yellow', 'red'].forEach(t => $(t + '-' + id).closest('.alert-field').classList.toggle('bad', bad));
  renderTable(); updateSummary();   // la tabla se recolorea con los umbrales nuevos
}
function toggleSensorEnabled(id) {
  const s = state.sensors[id];
  s.enabled = $('toggle-' + id).checked;
  $('card-' + id).classList.toggle('off', !s.enabled);
  combinedChart.data.datasets[SENSOR_IDS.indexOf(id)].hidden = !s.enabled;
  combinedChart.update('none');
  s.status = s.enabled ? (s.lastOk !== null ? 'SINSENAL' : 'SINDATOS') : 'DESACTIVADO';   // si se rehabilita, espera lectura nueva
  renderSensor(id);
  addEvent((s.enabled ? 'Sensor habilitado: ' : 'Sensor deshabilitado: ') + s.name);
  updateSummary(); rebuildTableHead(); saveConfig();
}

function renderSensor(id) {
  const s = state.sensors[id];
  const badge = $('badge-' + id);
  badge.className = 's-badge ' + s.status;
  badge.textContent = STATUS_LABEL[s.status];
  $('val-' + id).textContent = (LIVE_STATUS.includes(s.status) && s.value !== null) ? s.value.toFixed(1) : '--';
  const live = s.enabled && (s.status === 'ALERTA' || s.status === 'CRITICO');
  $('card-' + id).classList.toggle('lv-1', live && s.status === 'ALERTA');
  $('card-' + id).classList.toggle('lv-2', live && s.status === 'CRITICO');
  $('card-' + id).style.borderLeftColor = !s.enabled ? 'var(--off)' : s.status === 'CRITICO' ? 'var(--crit)' : s.status === 'ALERTA' ? 'var(--warn)' : SENSOR_COLOR[id];
}

/* ---------------- GRAFICOS EN VIVO ---------------- */
function baseAxisOpts() {
  return {
    x: { ticks: { font: { size: 9 }, maxTicksLimit: 6, color: '#8494b0' }, grid: { display: false } },
    y: { ticks: { font: { size: 9 }, color: '#8494b0' }, grid: { color: '#eef1f7' } }
  };
}
function buildSensorCharts() {
  SENSOR_IDS.forEach(id => {
    sensorCharts[id] = new Chart($('chart-' + id), {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: SENSOR_COLOR[id], backgroundColor: SENSOR_COLOR[id] + '22', fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: true } }, scales: baseAxisOpts() }
    });
  });
}
function buildCombinedChart() {
  combinedChart = new Chart($('combinedChart'), {
    type: 'line',
    data: { labels: [], datasets: SENSOR_IDS.map(id => ({ label: state.sensors[id].name, data: [], borderColor: SENSOR_COLOR[id], backgroundColor: SENSOR_COLOR[id], fill: false, tension: 0.35, pointRadius: 0, borderWidth: 2, hidden: !state.sensors[id].enabled })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } }, scales: baseAxisOpts() }
  });
}

/* Limpia lecturas, historiales, tabla y estadisticas. */
function resetData() {
  state.labels = []; state.logs = []; state.alerts = []; state.series = []; state.seriesStep = 4000; state.lastSeriesT = 0;
  state.readingsCount = 0; state.lastReadingTime = null; state.lastLogTime = null; state.sessionStart = null;
  SENSOR_IDS.forEach(id => {
    const s = state.sensors[id];
    s.value = null; s.history = []; s.level = 0; s.alertEvents = 0; s.critEvents = 0;
    s.sessMin = null; s.sessMax = null; s.sessSum = 0; s.sessN = 0; s.lastOk = null;
    s.status = s.enabled ? 'SINDATOS' : 'DESACTIVADO';
    renderSensor(id);
    sensorCharts[id].data.labels = []; sensorCharts[id].data.datasets[0].data = []; sensorCharts[id].update('none');
  });
  combinedChart.data.labels = []; combinedChart.data.datasets.forEach(ds => { ds.data = []; }); combinedChart.update('none');
  Object.assign(state.rpm, { value: null, history: [], sessSum: 0, sessN: 0, sessMax: 0, lastOk: null });
  $('rpmValue').textContent = '--'; $('rpmAvg').textContent = '--'; $('rpmDelta').textContent = '--'; $('rpmDelta').className = 'v';
  $('stripReadingsCount').textContent = '0'; $('stripLogCount').textContent = '0'; $('stripLastReading').textContent = '--:--:--';
  clearSavedSession();
  rebuildTableHead(); renderTable(); updateSummary();
}

function newSession() {
  if (hasData() && !confirm('¿Borrar todas las lecturas, la tabla y las alertas de esta sesión?\n\nSi aún no descargas el informe, hazlo antes.')) return;
  if (state.recording) toggleRecording();
  resetData();
  addEvent('Nueva sesión iniciada. Datos anteriores borrados.');
}

/* ---------------- ESTADO SIN SEÑAL ---------------- */
function markNoSignal() {
  SENSOR_IDS.forEach(id => {
    const s = state.sensors[id];
    if (s.enabled && s.lastOk !== null && s.status !== 'SINSENAL') { s.status = 'SINSENAL'; renderSensor(id); }
  });
  if (state.rpm.lastOk !== null) { $('rpmValue').textContent = '--'; $('rpmDelta').textContent = '--'; }
  updateSummary();
}
function checkStale() {
  if (isDemo() && state.readingsCount === 0) return;
  const nowMs = Date.now();
  let changed = false;
  SENSOR_IDS.forEach(id => {
    const s = state.sensors[id];
    if (s.enabled && s.lastOk !== null && nowMs - s.lastOk > STALE_TIMEOUT_MS && s.status !== 'SINSENAL') { s.status = 'SINSENAL'; renderSensor(id); changed = true; }
  });
  if (state.rpm.lastOk !== null && nowMs - state.rpm.lastOk > STALE_TIMEOUT_MS && $('rpmValue').textContent !== '--') {
    $('rpmValue').textContent = '--'; $('rpmDelta').textContent = '--'; changed = true;
  }
  if (changed) updateSummary();
}

/* ---------------- PROCESAR LECTURA ---------------- */
function toNum(x) { return (x === null || x === undefined || x === '' || !isFinite(Number(x))) ? null : Number(x); }

function processReading(data) {
  const now = new Date(), nowMs = now.getTime();
  if (!state.sessionStart) state.sessionStart = nowMs;
  state.labels.push(hhmmss(now));
  if (state.labels.length > MAX_POINTS) state.labels.shift();

  const pointVals = [];
  SENSOR_IDS.forEach((id, i) => {
    const s = state.sensors[id];
    const raw = toNum(data[id]);
    let plotted = null;

    if (!s.enabled) {
      s.status = 'DESACTIVADO';
    } else if (raw === null) {
      s.status = 'FALLA';                       // el TX no pudo leer la PT100 (cable abierto, MAX31865, etc.)
    } else {
      s.value = raw; s.lastOk = nowMs; plotted = raw;
      if (s.sessMin === null || raw < s.sessMin) s.sessMin = raw;
      if (s.sessMax === null || raw > s.sessMax) s.sessMax = raw;
      s.sessSum += raw; s.sessN++;
      // Histeresis real: sube de nivel al cruzar el umbral y solo baja cuando
      // el valor cae HYST °C por debajo. Evita contar 20 alertas si oscila en 45.0.
      let lvl = 0;
      if (raw >= s.red || (s.level === 2 && raw >= s.red - HYST)) lvl = 2;
      else if (raw >= s.yellow || (s.level >= 1 && raw >= s.yellow - HYST)) lvl = 1;
      if (lvl > s.level) {
        if (lvl === 2) { s.critEvents++; logAlert(id, 'CRÍTICO', raw, s.red); addEvent('CRÍTICO: ' + s.name + ' → ' + raw.toFixed(1) + '°C (umbral ' + s.red + '°C)', 'ev-crit'); }
        else { s.alertEvents++; logAlert(id, 'ALERTA', raw, s.yellow); addEvent('ALERTA: ' + s.name + ' → ' + raw.toFixed(1) + '°C (umbral ' + s.yellow + '°C)', 'ev-alert'); }
      }
      s.level = lvl;
      s.status = lvl === 2 ? 'CRITICO' : lvl === 1 ? 'ALERTA' : 'NORMAL';
    }

    s.history.push(plotted);                    // null = hueco en el grafico (mantiene alineado con las horas)
    if (s.history.length > MAX_POINTS) s.history.shift();
    pointVals.push(plotted);
    renderSensor(id);
    sensorCharts[id].data.labels = state.labels;
    sensorCharts[id].data.datasets[0].data = s.history;
    sensorCharts[id].update('none');
    combinedChart.data.datasets[i].data = s.history;
  });
  combinedChart.data.labels = state.labels;
  combinedChart.update('none');

  const rpmRaw = toNum(data.rpm);
  if (rpmRaw !== null) {
    state.rpm.value = rpmRaw; state.rpm.lastOk = nowMs;
    if (rpmRaw >= RPM_RUN_MIN) { state.rpm.sessSum += rpmRaw; state.rpm.sessN++; if (rpmRaw > state.rpm.sessMax) state.rpm.sessMax = rpmRaw; }
    $('rpmValue').textContent = Math.round(rpmRaw);
    refreshRpmStats();
  }

  pushSeries(nowMs, pointVals, rpmRaw);
  state.readingsCount++;
  state.lastReadingTime = now;
  $('stripLastReading').textContent = hhmmss(now);
  $('stripReadingsCount').textContent = state.readingsCount;
  updateSummary();
}

/* Serie de TODA la sesion para el informe (se diezma sola al llenarse). */
function pushSeries(t, vals, rpm) {
  if (t - state.lastSeriesT < state.seriesStep) return;
  state.lastSeriesT = t;
  state.series.push({ t, v: vals, r: rpm });
  if (state.series.length > SERIES_MAX) { state.series = state.series.filter((_, i) => i % 2 === 0); state.seriesStep *= 2; }
}

function logAlert(id, type, value, limit) {
  state.alerts.push({ t: Date.now(), id, name: state.sensors[id].name, type, value, limit });
  if (state.alerts.length > 500) state.alerts.shift();
}

function rpmAvgRunning() { return state.rpm.sessN ? state.rpm.sessSum / state.rpm.sessN : null; }
function refreshRpmStats() {
  const avg = rpmAvgRunning();
  $('rpmAvg').textContent = avg === null ? '--' : Math.round(avg) + ' rpm';
  const el = $('rpmDelta');
  if (avg === null || !state.rpm.nominal) { el.textContent = '--'; el.className = 'v'; return; }
  const delta = avg - state.rpm.nominal, pct = (delta / state.rpm.nominal) * 100;
  el.textContent = (delta >= 0 ? '+' : '') + Math.round(delta) + ' rpm (' + (delta >= 0 ? '+' : '') + pct.toFixed(1) + '%)';
  el.className = 'v ' + (Math.abs(pct) > 8 ? 'delta-up' : 'delta-ok');
}
function onRpmNominalChange() {
  const v = parseFloat($('rpmNominal').value);
  if (isFinite(v) && v > 0) { state.rpm.nominal = v; refreshRpmStats(); saveConfig(); }
}

/* ---------------- RESUMEN / EVENTOS ---------------- */
function updateAlertBanner() {
  const el = $('alertBanner');
  const part = id => { const s = state.sensors[id]; return s.name + ': ' + s.value.toFixed(1) + ' °C'; };
  const act = SENSOR_IDS.filter(id => { const s = state.sensors[id]; return s.enabled && s.value !== null && (s.status === 'ALERTA' || s.status === 'CRITICO'); });
  const reds = act.filter(id => state.sensors[id].status === 'CRITICO'), yels = act.filter(id => state.sensors[id].status === 'ALERTA');
  if (!act.length) { el.hidden = true; return; }
  el.className = 'alertbanner ' + (reds.length ? 'crit' : 'warn');
  el.textContent = (reds.length ? '✖ ALERTA ROJA — ' + reds.map(part).join(' · ') : '') +
    (reds.length && yels.length ? '   |   ' : '') +
    (yels.length ? '⚠ ALERTA AMARILLA — ' + yels.map(part).join(' · ') : '');
  el.hidden = false;
}

function updateSummary() {
  updateAlertBanner();
  $('summaryList').innerHTML = SENSOR_IDS.map(id => {
    const s = state.sensors[id];
    const live = LIVE_STATUS.includes(s.status) && s.value !== null;
    const dot = !s.enabled ? '#94a3b8' : s.status === 'CRITICO' ? 'var(--crit)' : s.status === 'ALERTA' ? 'var(--warn)' : live ? 'var(--ok)' : s.status === 'FALLA' ? 'var(--crit)' : '#94a3b8';
    return `<div class="summary-row"><div class="summary-left"><span class="dot" style="background:${dot}"></span><span class="nm">${escHtml(s.name)}</span></div>
      <span class="summary-val">${live ? s.value.toFixed(1) + '°C' : '--'}</span></div>`;
  }).join('') + `<div class="summary-row"><div class="summary-left"><span class="dot" style="background:var(--rpm)"></span><span class="nm">RPM</span></div>
      <span class="summary-val">${$('rpmValue').textContent}</span></div>`;
}

function addEvent(text, cls) {
  const log = $('eventLog');
  const div = document.createElement('div');
  div.className = 'ev-line' + (cls ? ' ' + cls : '');
  div.textContent = '[' + hhmmss(new Date()) + '] ' + text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

/* ---------------- REGISTRO EN TABLA ---------------- */
function rebuildTableHead() {
  let html = '<th>Hora</th>';
  SENSOR_IDS.forEach(id => { if (state.sensors[id].enabled) html += `<th>${escHtml(state.sensors[id].name)}</th>`; });
  $('tableHeadRow').innerHTML = html + '<th>RPM</th>';
}

function refreshRecUI() {
  const on = state.recording;
  $('recBtn').textContent = on ? '■ DETENER REGISTRO' : '▶ INICIAR REGISTRO';
  $('recBtn').className = 'rec-btn ' + (on ? 'stop' : 'start');
  $('mbRec').textContent = on ? '■ DETENER' : '▶ REGISTRO';
  $('mbRec').className = 'mb-rec' + (on ? ' stop' : '');
  $('stripRecDot').className = 'dot ' + (on ? 'dot-rec-on' : 'dot-rec-off');
  $('stripRecText').textContent = on ? 'REGISTRANDO' : 'REGISTRO DETENIDO';
}

function toggleRecording() {
  state.recording = !state.recording;
  refreshRecUI();
  if (state.recording) {
    addEvent('Registro iniciado (cada ' + state.intervalMin + ' min' + (isDemo() ? ', acelerado en demo: cada ' + state.intervalMin + ' seg' : '') + ').');
    state.lastLogTime = null;
    manualLog();
  } else {
    addEvent('Registro detenido.');
  }
  if (!isDemo() && hasData()) saveSession();
}

/* Guarda filas por reloj (no depende de que lleguen lecturas): si se pierde la senal
   la fila queda con "--" y el informe muestra el hueco en vez de ocultarlo. */
function tickLog() {
  if (!state.recording) return;
  const now = Date.now();
  if (state.lastLogTime === null || now - state.lastLogTime >= effectiveIntervalMs()) { logRow(new Date(now)); state.lastLogTime = now; }
}
function manualLog() { const d = new Date(); logRow(d); state.lastLogTime = d.getTime(); }

function liveValue(id) {   // solo valores vigentes; nunca repite un dato viejo como si fuera actual
  const s = state.sensors[id];
  return (LIVE_STATUS.includes(s.status) && s.value !== null) ? s.value : null;
}
function logRow(d) {
  const cols = SENSOR_IDS.filter(id => state.sensors[id].enabled);
  const row = { time: hhmmss(d), ts: d.getTime(), cols, names: {}, values: {}, rpm: ($('rpmValue').textContent === '--') ? null : state.rpm.value };
  cols.forEach(id => { row.names[id] = state.sensors[id].name; row.values[id] = liveValue(id); });
  state.logs.push(row);
  renderTable();
  $('stripLogCount').textContent = state.logs.length;
}

function allLogCols() {
  const all = [];
  state.logs.forEach(row => (row.cols || []).forEach(id => { if (!all.includes(id)) all.push(id); }));
  return all;
}
function colName(id) {
  for (let i = state.logs.length - 1; i >= 0; i--) { const n = state.logs[i].names && state.logs[i].names[id]; if (n) return n; }
  return state.sensors[id].name;
}
function renderTable() {
  const body = $('tableBody'), empty = $('tableEmpty');
  if (state.logs.length === 0) { empty.style.display = 'block'; body.innerHTML = ''; rebuildTableHead(); return; }
  empty.style.display = 'none';
  const cols = allLogCols();
  $('tableHeadRow').innerHTML = '<th>Hora</th>' + cols.map(id => `<th>${escHtml(colName(id))}</th>`).join('') + '<th>RPM</th>';
  body.innerHTML = state.logs.slice(-300).reverse().map(row => {
    let html = `<td>${row.time}</td>`;
    cols.forEach(id => {
      if (!(row.cols || []).includes(id)) { html += '<td>—</td>'; return; }
      const s = state.sensors[id], v = row.values[id];
      let cls = '';
      let tip = '';
      if (v !== null && v !== undefined) { if (v >= s.red) { cls = 'cell-crit'; tip = 'ALERTA ROJA (≥ ' + s.red + ' °C)'; } else if (v >= s.yellow) { cls = 'cell-warn'; tip = 'ALERTA AMARILLA (≥ ' + s.yellow + ' °C)'; } }
      html += `<td class="${cls}" title="${tip}">${v !== null && v !== undefined ? v.toFixed(1) : '--'}</td>`;
    });
    html += `<td>${row.rpm !== null && row.rpm !== undefined ? Math.round(row.rpm) : '--'}</td>`;
    return '<tr>' + html + '</tr>';
  }).join('');
}

function updateClock() { $('clock').textContent = hhmmss(new Date()); }

/* ---------------- MODO / UI DE CONEXION ---------------- */
function setModeUI() {
  const badge = $('modeBadge'), txt = $('modeBadgeText'), dot = $('stripModeDot'), st = $('stripModeText');
  const M = {
    demo: ['badge sim', 'DEMO', 'dot dot-sim', 'MODO DEMO — DATOS SIMULADOS'],
    usb:  ['badge real', 'USB · DATOS REALES', 'dot dot-rec-off', 'MODO REAL — RECEPTOR POR USB'],
    ble:  ['badge ble', 'BLUETOOTH · DATOS REALES', 'dot dot-rec-off', 'MODO REAL — RECEPTOR POR BLUETOOTH'],
    idle: ['badge idle', 'DESCONECTADO', 'dot dot-rec-off', 'DESCONECTADO — DATOS CONSERVADOS']
  }[state.mode];
  badge.className = M[0]; txt.textContent = M[1];
  dot.className = M[2]; st.textContent = M[3];
  const on = isLive();
  $('btnConnect').textContent = on ? '⬤ DESCONECTAR' : '⏻ CONECTAR RECEPTOR';
  $('btnConnect').classList.toggle('on', on);
  $('simWarn').hidden = !isDemo();
  if (on) $('connMenu').hidden = true;
}

function initConnectMenu() {
  const menu = $('connMenu'), btn = $('btnConnect');
  const usbOk = 'serial' in navigator, bleOk = 'bluetooth' in navigator;
  if (!usbOk) { $('menuUsb').disabled = true; $('usbHint').textContent = 'No disponible en este navegador. Usa Chrome o Edge en el computador.'; }
  if (!bleOk) { $('menuBle').disabled = true; $('bleHint').textContent = 'No disponible en este navegador. En Android usa Chrome; en iPhone se requiere un navegador con Bluetooth web (ej. Bluefy).'; }
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (isLive()) { disconnectLink(); return; }
    menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.hidden = true; });
  $('menuUsb').addEventListener('click', () => { menu.hidden = true; connectUsb(); });
  $('menuBle').addEventListener('click', () => { menu.hidden = true; connectBle(); });
  $('menuDemo').addEventListener('click', () => { menu.hidden = true; switchToDemo(); });
}

function switchToDemo() {
  if (isLive()) return;
  if (!isDemo() && hasData() && !confirm('Pasar a DEMO borra los datos reales guardados (lecturas, tabla y alertas).\n\n¿Continuar?')) return;
  if (state.recording) toggleRecording();
  resetData();
  state.mode = 'demo';
  setModeUI();
  addEvent('Modo demo activado.');
}

/* Lo llama link.js cuando el enlace queda establecido / se pierde. */
function onLinkConnected(kind) {
  if (isDemo()) { if (state.recording) toggleRecording(); resetData(); }   // descarta datos simulados
  const resumed = hasData();
  state.mode = kind;
  state.lastLogTime = null;
  setModeUI();
  addEvent((kind === 'usb' ? 'Receptor conectado por USB. ' : 'Receptor conectado por Bluetooth. ') + (resumed ? 'Se continúa la sesión guardada.' : 'Esperando datos reales...'));
}
function onLinkLost(why, isError) {
  if (!isLive()) return;
  state.mode = 'idle';
  setModeUI();
  markNoSignal();
  addEvent(why, isError ? 'ev-crit' : '');
  if (hasData()) saveSession();
}

function handleLine(line) {
  let data;
  try { data = JSON.parse(line); } catch (e) { return; }   // basura / mensajes de arranque: se ignoran
  if (!data || typeof data !== 'object') return;
  if (data.status) { handleStatus(String(data.status)); return; }
  processReading(data);
}
function handleStatus(msg) {
  const up = msg.toUpperCase();
  const lost = /SIN SE[NÑ]AL/.test(up), err = up.includes('ERROR');
  addEvent('RECEPTOR: ' + msg, err ? 'ev-crit' : lost ? 'ev-alert' : '');
  if (lost) markNoSignal();
}

/* ---------------- SIMULACION (solo en modo demo) ---------------- */
function startSimulation() {
  const drift = { s1: 0, s2: 0, s3: 0, s4: 0 };
  simTimer = setInterval(() => {
    if (!isDemo()) return;
    const data = {}, base = { s1: 38, s2: 40, s3: 33, s4: 42 };
    SENSOR_IDS.forEach(id => {
      drift[id] += (Math.random() - 0.5) * 1.1;
      drift[id] = Math.max(-5, Math.min(13, drift[id]));
      data[id] = +(base[id] + drift[id] + Math.sin(Date.now() / 9000 + id.charCodeAt(1)) * 2.5).toFixed(1);
    });
    data.rpm = Math.round(1450 + Math.sin(Date.now() / 15000) * 25 + (Math.random() - 0.5) * 8);
    processReading(data);
  }, 2000);
}

/* ---------------- INSTALAR APP / ACTUALIZAR ---------------- */
let deferredInstall = null, swReg = null, reloadingForUpdate = false;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstallHelp() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const android = /android/i.test(navigator.userAgent);
  let h;
  if (!window.isSecureContext || location.protocol === 'file:') {
    h = '<p>Esta app se está abriendo como <b>archivo local</b>. Para instalarla (y para usar Bluetooth en el celular) debe abrirse desde una dirección <b>https://</b>.</p><p>Sube la carpeta a Netlify Drop (ver LEEME.txt) y abre esa dirección en el celular.</p>';
  } else if (ios) {
    h = '<p>En iPhone/iPad:</p><ul><li>Abre esta página en <b>Safari</b>.</li><li>Toca <b>Compartir</b> (cuadro con flecha) → <b>Agregar a pantalla de inicio</b>.</li></ul><p>Ojo: Safari no tiene Bluetooth web. Para conectar el receptor por Bluetooth usa el navegador <b>Bluefy</b>.</p>';
  } else if (android) {
    h = '<p>En Android (Chrome):</p><ul><li>Toca el menú <b>⋮</b> arriba a la derecha.</li><li>Elige <b>Instalar aplicación</b> (o <b>Agregar a la pantalla principal</b>).</li></ul><p>Si no aparece: usa Chrome (no otro navegador) y espera unos segundos a que termine de cargar.</p>';
  } else {
    h = '<p>En el computador (Chrome o Edge):</p><ul><li>Busca el ícono de <b>instalar</b> al final de la barra de direcciones, o menú ⋮ → <b>Instalar BYB-NORTE</b>.</li></ul><p>Si ya está instalada, ábrela desde el escritorio o el menú de inicio.</p>';
  }
  $('installBody').innerHTML = h;
  $('installModal').hidden = false;
}
function initInstallAndUpdate() {
  if (isStandalone()) $('btnInstall').hidden = true;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
  $('btnInstall').addEventListener('click', async () => {
    if (!deferredInstall) { showInstallHelp(); return; }
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
  });
  $('installClose').addEventListener('click', () => { $('installModal').hidden = true; });
  $('installModal').addEventListener('click', e => { if (e.target === $('installModal')) $('installModal').hidden = true; });
  window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; addEvent('App instalada correctamente.'); });

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (ios && !standalone) addEvent('Para instalar en iPhone/iPad: botón Compartir → "Agregar a pantalla de inicio".');

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(); });
      });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloadingForUpdate) return; location.reload(); });
  }
  $('toastBtn').addEventListener('click', () => {
    if (hasData() && !isDemo()) saveSession();
    reloadingForUpdate = true;
    if (swReg && swReg.waiting) swReg.waiting.postMessage('SKIP_WAITING'); else location.reload();
  });
}
function showUpdateToast() { $('toastText').textContent = 'Hay una versión nueva de la app.'; $('toast').hidden = false; }

window.addEventListener('load', init);
