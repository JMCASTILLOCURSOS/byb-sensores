'use strict';
/* ============================================================
   INFORMES  (PDF con graficos vectoriales  +  Word)
   Los graficos usan la serie de TODA la sesion (state.series), no solo
   los ultimos 30 puntos de la pantalla.
   ============================================================ */

/* ---------- utilidades ---------- */
function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  if (h >= 24) return Math.floor(h / 24) + ' d ' + (h % 24) + ' h ' + (m % 60) + ' min';
  return h ? h + ' h ' + (m % 60) + ' min' : (m < 1 ? Math.round(ms / 1000) + ' s' : m + ' min');
}
const fmtDT = d => d ? d.toLocaleString('es-CL', { hour12: false }) : '—';
function slug(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SinDato';
}
function axisLabel(t, spanMs) {
  const d = new Date(t);
  if (spanMs > 20 * 3600e3) return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (spanMs < 10 * 60e3) return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fileBase() {
  const d = new Date();
  return 'Informe_' + slug($('metaEmpresa').value) + '_' + slug($('metaOT').value) + '_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + (isDemo() ? '_DEMO' : '');
}

let logoCache = null;
async function getLogoDataUrl() {
  if (logoCache) return logoCache;
  try {
    const blob = await (await fetch('img/logo.png')).blob();
    logoCache = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  } catch (e) {
    try {   // plan B (sin servidor): dibuja el <img> de la cabecera
      const im = document.querySelector('.brand img'), c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0);
      logoCache = c.toDataURL('image/png');
    } catch (e2) { logoCache = null; }
  }
  return logoCache;
}

/* En celular abre la hoja "Compartir" (guardar en Archivos, WhatsApp, correo...); en PC descarga. */
async function saveBlob(blob, filename) {
  if (matchMedia('(pointer:coarse)').matches && navigator.canShare) {
    try {
      const f = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: filename }); return 'compartido'; }
    } catch (e) { if (e.name === 'AbortError') return 'cancelado'; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'descargado';
}

/* ---------- modelo de datos del informe ---------- */
function reportModel() {
  const val = id => ($(id).value || '').trim() || '—';
  const start = state.sessionStart ? new Date(state.sessionStart) : null;
  const end = state.lastReadingTime;
  const sensors = SENSOR_IDS.map(id => {
    const s = state.sensors[id];
    return { id, name: s.name, enabled: s.enabled, avg: s.sessN ? s.sessSum / s.sessN : null, min: s.sessMin, max: s.sessMax,
      yellow: s.yellow, red: s.red, alerts: s.alertEvents, crits: s.critEvents, n: s.sessN };
  });
  const cols = allLogCols();
  return {
    empresa: val('metaEmpresa'), ot: val('metaOT'), operador: val('metaOperador'), armador: val('metaArmador'), equipo: val('metaEquipo'), grasa: val('metaGrasa'),
    demo: isDemo(), mode: isDemo() ? 'DEMO — DATOS SIMULADOS' : (state.mode === 'ble' ? 'Receptor NRF24 por Bluetooth (datos reales)' : 'Receptor NRF24 por USB (datos reales)'),
    start, end, durMs: start && end ? end - start : 0, generated: new Date(),
    nominal: state.rpm.nominal, rpmAvg: rpmAvgRunning(), rpmMax: state.rpm.sessMax || null,
    readings: state.readingsCount, intervalMin: state.intervalMin,
    sensors, alerts: state.alerts.slice(), series: state.series.slice(),
    logs: state.logs.slice(), logCols: cols, logNames: cols.map(colName)
  };
}
const num1 = v => (v === null || v === undefined) ? '—' : v.toFixed(1);

/* ============================================================
   PDF
   ============================================================ */
const PDF = { W: 215.9, H: 279.4, M: 14, NAVY: [22, 35, 61], BLUE: [47, 95, 168] };
const hexRGB = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/* Grafico de lineas vectorial. series=[{name,color,vals[]}], times[] (ms), hlines=[{v,color,name}] */
function pdfChart(doc, x, y, w, h, title, series, times, hlines) {
  const padL = 11, padR = 3, padT = title ? 6 : 2, legendH = 7, padB = 7;
  const px = x + padL, py = y + padT, pw = w - padL - padR, ph = h - padT - padB - legendH;
  doc.setDrawColor(190, 198, 214); doc.setLineWidth(0.2); doc.rect(x, y, w, h);
  if (title) { doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...PDF.NAVY); doc.text(title, x + 2, y + 4.2); }

  const vals = [];
  series.forEach(s => s.vals.forEach(v => { if (v !== null && v !== undefined) vals.push(v); }));
  if (vals.length < 1 || times.length < 1) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(130, 140, 160);
    doc.text('Sin datos en la sesión', x + w / 2, y + h / 2, { align: 'center' });
    return;
  }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  (hlines || []).forEach(l => { if (l.v >= lo - 8 && l.v <= hi + 8) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); } });
  if (hi - lo < 2) { lo -= 1; hi += 1; }
  const step = niceStep((hi - lo) / 4);
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
  const t0 = times[0], t1 = times[times.length - 1], span = Math.max(1, t1 - t0);
  const X = t => px + (times.length === 1 ? pw / 2 : ((t - t0) / span) * pw);
  const Y = v => py + ph - ((v - yMin) / (yMax - yMin)) * ph;

  // cuadricula + eje Y
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(110, 122, 145);
  for (let v = yMin; v <= yMax + step / 1000; v += step) {
    doc.setDrawColor(232, 236, 244); doc.setLineWidth(0.15); doc.line(px, Y(v), px + pw, Y(v));
    doc.text(String(Math.round(v * 100) / 100), px - 1.5, Y(v) + 0.8, { align: 'right' });
  }
  // eje X
  const nT = Math.min(6, times.length);
  for (let i = 0; i < nT; i++) {
    const idx = nT === 1 ? 0 : Math.round(i * (times.length - 1) / (nT - 1));
    const tx = X(times[idx]);
    doc.setDrawColor(232, 236, 244); doc.line(tx, py, tx, py + ph);
    doc.text(axisLabel(times[idx], span), tx, py + ph + 3.5, { align: i === 0 ? 'left' : i === nT - 1 ? 'right' : 'center' });
  }
  doc.setDrawColor(150, 160, 180); doc.setLineWidth(0.25); doc.rect(px, py, pw, ph);

  // umbrales
  (hlines || []).forEach(l => {
    if (l.v < yMin || l.v > yMax) return;
    doc.setDrawColor(...hexRGB(l.color)); doc.setLineWidth(0.3); doc.setLineDashPattern([1.6, 1.2], 0);
    doc.line(px, Y(l.v), px + pw, Y(l.v)); doc.setLineDashPattern([], 0);
  });
  // series (se corta la linea donde hay huecos)
  series.forEach(s => {
    doc.setDrawColor(...hexRGB(s.color)); doc.setLineWidth(0.4);
    let prev = null;
    s.vals.forEach((v, i) => {
      if (v === null || v === undefined) { prev = null; return; }
      const cx = X(times[i]), cy = Y(v);
      if (prev) doc.line(prev[0], prev[1], cx, cy); else doc.circle(cx, cy, 0.15, 'F');
      prev = [cx, cy];
    });
  });
  // leyenda
  let lx = x + 2; const ly = y + h - 2.4;
  doc.setFontSize(6.5);
  const legend = series.map(s => ({ name: s.name, color: s.color, dash: false })).concat((hlines || []).filter(l => l.v >= yMin && l.v <= yMax).map(l => ({ name: l.name, color: l.color, dash: true })));
  legend.forEach(it => {
    const tw = doc.getTextWidth(it.name);
    if (lx + tw + 9 > x + w - 1) return;
    doc.setDrawColor(...hexRGB(it.color)); doc.setLineWidth(0.5);
    if (it.dash) doc.setLineDashPattern([1, 0.8], 0);
    doc.line(lx, ly - 0.9, lx + 4.5, ly - 0.9); doc.setLineDashPattern([], 0);
    doc.setTextColor(60, 72, 95); doc.text(it.name, lx + 5.5, ly);
    lx += tw + 9.5;
  });
}

/* Evita informes con datos de ejemplo/vacios: avisa si falta empresa u OT. */
function metaOk() {
  const falta = [['metaEmpresa', 'Empresa'], ['metaOT', 'N° OT / Faena']].filter(f => !$(f[0]).value.trim()).map(f => f[1]);
  if (!falta.length) return true;
  $('metaDetails').open = true;
  return confirm('Falta completar: ' + falta.join(' y ') + '.\n\n¿Generar el informe igual (saldrá con "—")?');
}

async function exportPdfReport() {
  if (!metaOk()) return;
  if (!window.jspdf) { alert('No se cargó el generador de PDF. Recarga la app.'); return; }
  const m = reportModel(), logo = await getLogoDataUrl();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait' });
  const { W, H, M, NAVY, BLUE } = PDF, CW = W - 2 * M;
  let y = M;

  // --- cabecera ---
  doc.setFillColor(245, 248, 253); doc.setDrawColor(...BLUE); doc.setLineWidth(0.6);
  doc.roundedRect(M, y, CW, 24, 1.5, 1.5, 'FD');
  if (logo) doc.addImage(logo, 'PNG', M + 4, y + 3.5, 37, 17);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(29, 63, 120);
  doc.text('Informe de Monitoreo de Temperatura Industrial', M + 46, y + 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(91, 107, 133);
  doc.text('BYB-NORTE · PT100 x4 (MAX31865) + RPM (TCRT5000) · NRF24L01', M + 46, y + 16.5);
  doc.text('Generado: ' + fmtDT(m.generated), M + 46, y + 20.5);
  y += 29;

  if (m.demo) {
    doc.setFillColor(255, 244, 214); doc.setDrawColor(217, 150, 20); doc.setLineWidth(0.4);
    doc.rect(M, y, CW, 9, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(138, 75, 5);
    doc.text('ATENCIÓN: DATOS SIMULADOS (MODO DEMO). Este informe NO corresponde a mediciones reales.', M + 3, y + 5.8);
    y += 13;
  }

  const section = (t, need) => {   // need = alto (mm) del contenido que sigue: el titulo nunca queda solo al pie
    if (y + 9 + (need || 30) > H - M) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(29, 63, 120);
    doc.text(t, M, y + 4);
    doc.setDrawColor(...BLUE); doc.setLineWidth(0.7); doc.line(M, y + 6, M + CW, y + 6);
    y += 9;
  };
  const afterTable = () => { y = doc.lastAutoTable.finalY + 6; };
  const baseTable = { theme: 'grid', margin: { left: M, right: M }, styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.6, lineColor: [185, 194, 212], lineWidth: 0.2, textColor: NAVY }, headStyles: { fillColor: BLUE, textColor: 255, fontStyle: 'bold' } };

  // --- datos generales ---
  section('Datos generales');
  doc.autoTable({ ...baseTable, startY: y, body: [
    ['Empresa', m.empresa], ['N° OT / Faena', m.ot], ['Operador', m.operador], ['Armador', m.armador], ['Equipo / Activo', m.equipo], ['Grasa aplicada (tipo)', m.grasa],
    ['Inicio de la medición', fmtDT(m.start)], ['Fin de la medición', fmtDT(m.end)], ['Duración', fmtDur(m.durMs)],
    ['RPM nominal', m.nominal + ' rpm'],
    ['RPM registrada (promedio en marcha)', m.rpmAvg === null ? '—' : Math.round(m.rpmAvg) + ' rpm' + (m.nominal ? '  (' + (m.rpmAvg >= m.nominal ? '+' : '') + (((m.rpmAvg - m.nominal) / m.nominal) * 100).toFixed(1) + ' % vs nominal)' : '')],
    ['RPM máxima registrada', m.rpmMax === null ? '—' : Math.round(m.rpmMax) + ' rpm'],
    ['Total de lecturas', String(m.readings)], ['Filas registradas en tabla', String(m.logs.length)],
    ['Intervalo de registro', m.intervalMin + ' minutos'], ['Origen de los datos', m.mode]
  ], columnStyles: { 0: { fontStyle: 'bold', fillColor: [219, 230, 245], textColor: [29, 63, 120], cellWidth: 62 } } });
  afterTable();

  // --- resumen por sensor ---
  section('Resumen por sensor');
  doc.autoTable({ ...baseTable, startY: y,
    head: [['Sensor', 'Estado', 'Prom. (°C)', 'Mín (°C)', 'Máx (°C)', 'Amarilla', 'Roja', 'N° alertas', 'N° críticos']],
    body: m.sensors.map(s => [s.name + ' (' + s.id.toUpperCase() + ')', s.enabled ? 'Habilitado' : 'Deshabilitado', s.avg === null ? '—' : s.avg.toFixed(1), num1(s.min), num1(s.max), s.yellow + ' °C', s.red + ' °C', s.alerts, s.crits]),
    columnStyles: { 0: { cellWidth: 48 }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 7: { halign: 'center' }, 8: { halign: 'center' } },
    didParseCell: d => { if (d.section === 'body' && d.column.index === 8 && Number(d.cell.raw) > 0) { d.cell.styles.fillColor = [252, 165, 165]; d.cell.styles.fontStyle = 'bold'; } if (d.section === 'body' && d.column.index === 7 && Number(d.cell.raw) > 0) d.cell.styles.fillColor = [253, 230, 138]; } });
  afterTable();

  // --- alertas ---
  section('Registro de alertas');
  if (!m.alerts.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...NAVY);
    doc.text('Sin alertas amarillas ni críticas durante la sesión.', M, y + 3); y += 9;
  } else {
    doc.autoTable({ ...baseTable, startY: y, head: [['Fecha y hora', 'Sensor', 'Tipo', 'Valor (°C)', 'Umbral (°C)']],
      body: m.alerts.map(a => [fmtDT(new Date(a.t)), a.name, a.type, a.value.toFixed(1), a.limit]),
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' } },
      didParseCell: d => { if (d.section === 'body' && d.column.index === 2) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = d.cell.raw === 'CRÍTICO' ? [252, 165, 165] : [253, 230, 138]; } } });
    afterTable();
  }

  // --- graficos ---
  const times = m.series.map(p => p.t);
  const colSeries = i => m.sensors[i].enabled ? m.series.map(p => p.v[i]) : m.series.map(() => null);
  const combH = 68;
  section('Gráfico combinado — 4 sensores', combH);
  if (y + combH > H - M) { doc.addPage(); y = M; }
  pdfChart(doc, M, y, CW, combH, '', m.sensors.filter(s => s.enabled).map(s => ({ name: s.name, color: SENSOR_COLOR[s.id], vals: colSeries(SENSOR_IDS.indexOf(s.id)) })), times, []);
  y += combH + 7;

  const gw = (CW - 5) / 2, gh = 56;
  section('Gráficos individuales por sensor', gh * 2 + 5);   // los 4 juntos (2 + 2) en la misma hoja
  for (let r = 0; r < 2; r++) {
    if (y + gh > H - M) { doc.addPage(); y = M; }
    for (let c = 0; c < 2; c++) {
      const i = r * 2 + c, s = m.sensors[i];
      const dmax = Math.max(...colSeries(i).filter(v => v !== null), -Infinity);
      const lines = [{ v: s.yellow, color: '#f59e0b', name: 'Alerta amarilla ' + s.yellow + ' °C' }];
      if (dmax >= s.yellow - 3) lines.push({ v: s.red, color: '#dc2626', name: 'Alerta roja ' + s.red + ' °C' });
      pdfChart(doc, M + c * (gw + 5), y, gw, gh, s.name + ' (' + s.id.toUpperCase() + ')' + (s.enabled ? '' : ' — deshabilitado'),
        s.enabled ? [{ name: s.id.toUpperCase() + ' (°C)', color: SENSOR_COLOR[s.id], vals: colSeries(i) }] : [], times, lines);
    }
    y += gh + 5;
  }
  y += 2;

  // --- RPM ---
  const hasRpm = m.series.some(p => p.r !== null && p.r !== undefined);
  if (hasRpm) {
    const rh = 50;
    section('RPM — nominal vs. registrada', rh);
    if (y + rh > H - M) { doc.addPage(); y = M; }
    pdfChart(doc, M, y, CW, rh, '', [{ name: 'RPM medida', color: '#7c3aed', vals: m.series.map(p => (p.r === undefined ? null : p.r)) }], times, [{ v: m.nominal, color: '#16233d', name: 'RPM nominal ' + m.nominal }]);
    y += rh + 7;
  }

  // --- tabla completa ---
  section('Tabla completa de registros', 40);
  if (!m.logs.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...NAVY);
    doc.text('Sin registros guardados. Usa INICIAR REGISTRO para guardar filas en el intervalo elegido.', M, y + 3);
  } else {
    const head = [['Fecha / hora'].concat(m.logNames).concat(['RPM'])];
    const body = m.logs.map(row => [new Date(row.ts || Date.now()).toLocaleString('es-CL', { hour12: false })]
      .concat(m.logCols.map(id => (row.cols || []).includes(id) ? (row.values[id] === null || row.values[id] === undefined ? '--' : row.values[id].toFixed(1)) : '—'))
      .concat([row.rpm === null || row.rpm === undefined ? '--' : String(Math.round(row.rpm))]));
    doc.autoTable({ ...baseTable, startY: y, head, body, showHead: 'everyPage',
      styles: { ...baseTable.styles, fontSize: 7.5, cellPadding: 1.3, halign: 'right' },
      columnStyles: { 0: { halign: 'left', cellWidth: 36 } }, headStyles: { ...baseTable.headStyles, halign: 'center' },
      didParseCell: d => {
        if (d.section !== 'body' || d.column.index === 0 || d.column.index > m.logCols.length) return;
        const id = m.logCols[d.column.index - 1], v = parseFloat(d.cell.raw), s = state.sensors[id];
        if (isFinite(v) && s) { if (v >= s.red) { d.cell.styles.fillColor = [252, 165, 165]; d.cell.styles.fontStyle = 'bold'; } else if (v >= s.yellow) d.cell.styles.fillColor = [253, 230, 138]; }
      } });
  }

  // --- pie de pagina ---
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); if (logo && p > 1) doc.addImage(logo, 'PNG', W - M - 17, 3.5, 17, 7.8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(132, 148, 176);
    doc.setDrawColor(221, 227, 238); doc.setLineWidth(0.2); doc.line(M, H - 10, W - M, H - 10);
    doc.text('BYB-NORTE · ' + m.empresa + ' · ' + m.ot + (m.demo ? ' · DATOS SIMULADOS' : ''), M, H - 6.5);
    doc.text('Página ' + p + ' de ' + n, W - M, H - 6.5, { align: 'right' });
  }

  const r = await saveBlob(doc.output('blob'), fileBase() + '.pdf');
  if (r !== 'cancelado') addEvent('Informe PDF ' + r + '.');
}

/* ============================================================
   WORD (.docx real, generado en el navegador)
   ============================================================ */
function chartPNG(cfg, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  cfg.options = Object.assign({ responsive: false, animation: false, devicePixelRatio: 1 }, cfg.options);
  cfg.plugins = (cfg.plugins || []).concat([{ id: 'bg', beforeDraw(ch) { const x = ch.ctx; x.save(); x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#fff'; x.fillRect(0, 0, ch.width, ch.height); x.restore(); } }]);
  const ch = new Chart(c, cfg);
  const url = c.toDataURL('image/png');
  ch.destroy();
  return url;
}
function wordChart(m, indices, hlines, w, h, showLegend) {
  const times = m.series.map(p => p.t), span = times.length ? times[times.length - 1] - times[0] : 0;
  const datasets = indices.map(i => ({ label: m.sensors[i].name, data: m.series.map(p => p.v[i]), borderColor: SENSOR_COLOR[SENSOR_IDS[i]], backgroundColor: SENSOR_COLOR[SENSOR_IDS[i]], borderWidth: 2, pointRadius: 0, tension: 0 }));
  (hlines || []).forEach(l => datasets.push({ label: l.name, data: times.map(() => l.v), borderColor: l.color, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false }));
  return chartPNG({ type: 'line', data: { labels: times.map(t => axisLabel(t, span)), datasets },
    options: { plugins: { legend: { display: showLegend, position: 'bottom', labels: { boxWidth: 18, font: { size: 13 } } } },
      scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 12 }, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { font: { size: 12 } }, grid: { color: '#e8ecf4' } } } } }, w, h);
}

/* ============================================================
   Generador minimo de .docx (sin librerias): ZIP sin compresion + XML de Word.
   Es un Word real: abre en Word (PC y celular), LibreOffice y Google Docs, con el logo y los graficos.
   ============================================================ */
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files, mime) {
  const enc = new TextEncoder(), chunks = [], central = []; let off = 0;
  files.forEach(f => {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nm, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + sz;
  });
  const csize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: mime });
}
const X = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function dxP(text, o = {}) {
  const rpr = (o.bold ? '<w:b/>' : '') + (o.color ? `<w:color w:val="${o.color}"/>` : '') + `<w:sz w:val="${o.size || 20}"/>`;
  const ppr = (o.keepNext ? '<w:keepNext/>' : '') + (o.border ? '<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="2" w:color="2F5FA8"/></w:pBdr>' : '') +
    (o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : '') + `<w:spacing w:before="${o.before || 0}" w:after="${o.after == null ? 60 : o.after}"/>` + (o.align ? `<w:jc w:val="${o.align}"/>` : '');
  return `<w:p><w:pPr>${ppr}</w:pPr><w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${X(text)}</w:t></w:r></w:p>`;
}
function dxCell(content, w, o = {}) {
  const body = o.raw ? content : dxP(content, { size: o.size || 18, bold: o.bold, color: o.color, align: o.align, after: 0, keepNext: o.keep });
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${body}</w:tc>`;
}
function dxTable(widths, rows, o = {}) {
  const bd = o.noBorder ? '' : '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="B9C2D4"/>`).join('') + '</w:tblBorders>';
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${bd}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    rows.map(r => `<w:tr><w:trPr><w:cantSplit/>${r.header ? '<w:tblHeader/>' : ''}</w:trPr>${r.cells.join('')}</w:tr>`).join('') + '</w:tbl>' + dxP('', { size: 8, after: 60 });
}
function dxImg(rid, id, wpx, hpx, align, keep) {
  const cx = Math.round(wpx * 9525), cy = Math.round(hpx * 9525);
  return `<w:p><w:pPr>${keep ? '<w:keepNext/>' : ''}<w:spacing w:after="60"/>${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Imagen ${id}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="img${id}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function exportWordReport() {
  if (!metaOk()) return;
  const m = reportModel(), logo = await getLogoDataUrl();
  const e = escHtml;
  const has = m.series.length > 0;
  const COMB = { w: 1200, h: 480, dw: 620 }, IND = { w: 800, h: 360, dw: 300 };
  const combImg = has ? wordChart(m, m.sensors.map((s, i) => i).filter(i => m.sensors[i].enabled), [], COMB.w, COMB.h, true) : null;
  const indImg = m.sensors.map((s, i) => {
    if (!has || !s.enabled) return null;
    const dmax = Math.max(...m.series.map(p => p.v[i]).filter(v => v !== null), -Infinity);
    const lines = [{ v: s.yellow, color: '#f59e0b', name: 'Alerta amarilla ' + s.yellow + ' °C' }];
    if (dmax >= s.yellow - 3) lines.push({ v: s.red, color: '#dc2626', name: 'Alerta roja ' + s.red + ' °C' });
    return wordChart(m, [i], lines, IND.w, IND.h, true);
  });
  let rpmImg = null;
  if (m.series.some(p => p.r !== null && p.r !== undefined)) {
    const times = m.series.map(p => p.t), span = times[times.length - 1] - times[0];
    rpmImg = chartPNG({ type: 'line', data: { labels: times.map(t => axisLabel(t, span)), datasets: [
      { label: 'RPM medida', data: m.series.map(p => p.r === undefined ? null : p.r), borderColor: '#7c3aed', borderWidth: 2, pointRadius: 0, tension: 0 },
      { label: 'RPM nominal ' + m.nominal, data: times.map(() => m.nominal), borderColor: '#16233d', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }] },
      options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 18, font: { size: 13 } } } }, scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 12 }, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { font: { size: 12 } } } } } }, COMB.w, 400);
  }

  const imgs = []; let iid = 0;
  const rid = d => { imgs.push(d); return 'rIdImg' + imgs.length; };
  const B = [];
  const sec = t => B.push(dxP(t, { bold: true, size: 28, color: '1D3F78', border: true, keepNext: true, before: 280, after: 120 }));
  const YEL = 'FDE68A', RED = 'FCA5A5';
  const hdr = (arr, ws) => ({ header: true, cells: arr.map((t, i) => dxCell(t, ws[i], { bold: true, color: 'FFFFFF', fill: '2F5FA8' })) });

  // cabecera con logo
  const logoCell = dxCell(logo ? dxImg(rid(logo), ++iid, 130, Math.round(130 * 322 / 700)) : dxP('BYB-NORTE', { bold: true, size: 24 }), 2400, { raw: true, fill: 'F5F8FD' });
  const titleCell = dxCell(dxP('Informe de Monitoreo de Temperatura Industrial', { bold: true, size: 34, color: '1D3F78', after: 40 }) +
    dxP('BYB-NORTE · PT100 x4 (MAX31865) + RPM (TCRT5000) · NRF24L01', { size: 18, color: '5B6B85', after: 20 }) +
    dxP('Generado: ' + fmtDT(m.generated), { size: 18, color: '5B6B85', after: 0 }), 7800, { raw: true, fill: 'F5F8FD' });
  B.push(dxTable([2400, 7800], [{ cells: [logoCell, titleCell] }]));
  if (m.demo) B.push(dxP('ATENCIÓN: DATOS SIMULADOS (MODO DEMO). Este informe NO corresponde a mediciones reales.', { bold: true, color: '8A4B05', fill: 'FFF4D6', before: 80, after: 120 }));

  const rpmTxt = m.rpmAvg === null ? '—' : Math.round(m.rpmAvg) + ' rpm' + (m.nominal ? ' (' + (m.rpmAvg >= m.nominal ? '+' : '') + (((m.rpmAvg - m.nominal) / m.nominal) * 100).toFixed(1) + ' % vs nominal)' : '');
  const info = [['Empresa', m.empresa], ['N° OT / Faena', m.ot], ['Operador', m.operador], ['Armador', m.armador], ['Equipo / Activo', m.equipo], ['Grasa aplicada (tipo)', m.grasa],
    ['Inicio de la medición', fmtDT(m.start)], ['Fin de la medición', fmtDT(m.end)], ['Duración', fmtDur(m.durMs)], ['RPM nominal', m.nominal + ' rpm'],
    ['RPM registrada (promedio en marcha)', rpmTxt], ['RPM máxima registrada', m.rpmMax === null ? '—' : Math.round(m.rpmMax) + ' rpm'],
    ['Total de lecturas', m.readings], ['Filas registradas en tabla', m.logs.length], ['Intervalo de registro', m.intervalMin + ' minutos'], ['Origen de los datos', m.mode]];
  sec('Datos generales');
  B.push(dxTable([3800, 6400], info.map(r => ({ cells: [dxCell(r[0], 3800, { bold: true, color: '1D3F78', fill: 'DBE6F5' }), dxCell(String(r[1]), 6400)] }))));

  sec('Resumen por sensor');
  const sw = [2600, 1150, 950, 900, 900, 1000, 900, 900, 900];
  B.push(dxTable(sw, [hdr(['Sensor', 'Estado', 'Prom. (°C)', 'Mín (°C)', 'Máx (°C)', 'Amarilla', 'Roja', 'N° alertas', 'N° críticos'], sw)].concat(m.sensors.map(s => ({ cells: [
    dxCell(s.name + ' (' + s.id.toUpperCase() + ')', sw[0]), dxCell(s.enabled ? 'Habilitado' : 'Deshabilitado', sw[1]),
    dxCell(s.avg === null ? '—' : s.avg.toFixed(1), sw[2], { align: 'right' }), dxCell(num1(s.min), sw[3], { align: 'right' }), dxCell(num1(s.max), sw[4], { align: 'right' }),
    dxCell(s.yellow + ' °C', sw[5], { align: 'right' }), dxCell(s.red + ' °C', sw[6], { align: 'right' }),
    dxCell(String(s.alerts), sw[7], { align: 'center', fill: s.alerts ? YEL : '' }), dxCell(String(s.crits), sw[8], { align: 'center', bold: !!s.crits, fill: s.crits ? RED : '' })] })))));

  sec('Registro de alertas');
  if (!m.alerts.length) B.push(dxP('Sin alertas amarillas ni críticas durante la sesión.'));
  else {
    const aw = [2800, 3000, 1400, 1500, 1500];
    B.push(dxTable(aw, [hdr(['Fecha y hora', 'Sensor', 'Tipo', 'Valor (°C)', 'Umbral (°C)'], aw)].concat(m.alerts.map(a => ({ cells: [
      dxCell(fmtDT(new Date(a.t)), aw[0]), dxCell(a.name, aw[1]), dxCell(a.type, aw[2], { bold: true, fill: a.type === 'CRÍTICO' ? RED : YEL }),
      dxCell(a.value.toFixed(1), aw[3], { align: 'right' }), dxCell(String(a.limit), aw[4], { align: 'right' })] })))));
  }

  sec('Gráfico combinado — 4 sensores');
  B.push(combImg ? dxImg(rid(combImg), ++iid, 620, 248, 'center') : dxP('Sin datos en la sesión.'));

  sec('Gráficos individuales por sensor');
  const ic = (i, keep) => dxCell(dxP(m.sensors[i].name + ' (' + m.sensors[i].id.toUpperCase() + ')', { bold: true, size: 18, color: '16233D', align: 'center', after: 20, keepNext: keep }) +
    (indImg[i] ? dxImg(rid(indImg[i]), ++iid, 320, 144, 'center', keep) : dxP('Sin datos / deshabilitado', { size: 18, color: '8494B0', align: 'center', keepNext: keep })), 5100, { raw: true });
  B.push(dxTable([5100, 5100], [{ cells: [ic(0, true), ic(1, true)] }, { cells: [ic(2, false), ic(3, false)] }], { noBorder: true }));   // 2 + 2

  if (rpmImg) { sec('RPM — nominal vs. registrada'); B.push(dxImg(rid(rpmImg), ++iid, 620, 207, 'center')); }

  sec('Tabla completa de registros');
  if (!m.logs.length) B.push(dxP('Sin registros guardados.'));
  else {
    const n = m.logCols.length + 1, first = 2300, rest = Math.floor((10200 - first) / n), lw = [first].concat(Array(n).fill(rest));
    B.push(dxTable(lw, [hdr(['Fecha / hora'].concat(m.logNames).concat(['RPM']), lw)].concat(m.logs.map(row => {
      const cells = [dxCell(new Date(row.ts || Date.now()).toLocaleString('es-CL', { hour12: false }), lw[0])];
      m.logCols.forEach((id, k) => {
        if (!(row.cols || []).includes(id)) { cells.push(dxCell('—', lw[k + 1], { align: 'right' })); return; }
        const v = row.values[id], s = state.sensors[id]; let fill = '', bold = false;
        if (v !== null && v !== undefined) { if (v >= s.red) { fill = RED; bold = true; } else if (v >= s.yellow) { fill = YEL; bold = true; } }
        cells.push(dxCell(v === null || v === undefined ? '--' : v.toFixed(1), lw[k + 1], { align: 'right', fill, bold }));
      });
      cells.push(dxCell(row.rpm === null || row.rpm === undefined ? '--' : String(Math.round(row.rpm)), lw[n], { align: 'right' }));
      return { cells };
    }))));
  }
  B.push(dxP('Informe generado automáticamente por el Sistema de Monitoreo de Temperatura Industrial BYB-NORTE.', { size: 16, color: '8494B0', before: 300 }));

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + `<w:document ${NS}><w:body>${B.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1020" w:right="1020" w:bottom="1020" w:left="1020" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const enc = new TextEncoder(), u8 = s => enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + s);
  const b64u8 = d => { const bin = atob(d.split(',')[1]); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  const files = [
    { name: '[Content_Types].xml', data: u8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: u8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/_rels/document.xml.rels', data: u8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + imgs.map((d, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img${i + 1}.png"/>`).join('') + '</Relationships>') },
    { name: 'word/document.xml', data: enc.encode(docXml) }
  ].concat(imgs.map((d, i) => ({ name: 'word/media/img' + (i + 1) + '.png', data: b64u8(d) })));
  const blob = zipStore(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const r = await saveBlob(blob, fileBase() + '.docx');
  if (r !== 'cancelado') addEvent('Informe Word ' + r + '.');
}
