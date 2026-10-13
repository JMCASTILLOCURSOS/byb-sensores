'use strict';
/* ============================================================
   ENLACE CON EL RECEPTOR: USB (Web Serial) y Bluetooth BLE (Web Bluetooth)
   Ambos entregan lineas JSON a handleLine() (app.js).
   ============================================================ */

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- pantalla encendida mientras se monitorea (celular/tablet) ---- */
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* no soportado o denegado */ }
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && isLive()) acquireWakeLock(); });

/* ================= USB ================= */
let serialPort = null, serialReader = null, serialPipe = null, usbUserClosing = false;

async function connectUsb() {
  if (!('serial' in navigator)) return;
  try {
    const port = await navigator.serial.requestPort();
    await openUsb(port);
  } catch (e) {
    if (e.name !== 'NotFoundError') addEvent('No se pudo conectar por USB: ' + e.message, 'ev-crit');
  }
}

async function openUsb(port) {
  await port.open({ baudRate: 115200 });
  serialPort = port; usbUserClosing = false;
  onLinkConnected('usb');
  acquireWakeLock();
  readUsbLoop();
}

/* Al abrir la app, reconecta solo el receptor ya autorizado (sin ventana de seleccion). */
async function tryAutoUsb() {
  if (!('serial' in navigator)) return;
  try {
    navigator.serial.addEventListener('connect', async e => { if (!isLive()) { try { await openUsb(e.target); } catch (err) {} } });
    const ports = await navigator.serial.getPorts();
    if (ports.length === 1 && !isLive()) await openUsb(ports[0]);
  } catch (e) { /* sin permiso previo: se conecta a mano */ }
}

async function readUsbLoop() {
  const port = serialPort;
  const decoder = new TextDecoderStream();
  serialPipe = port.readable.pipeTo(decoder.writable).catch(() => {});
  serialReader = decoder.readable.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await serialReader.read();
      if (done) break;
      buffer += value;
      if (buffer.length > 4096) buffer = buffer.slice(-1024);   // proteccion ante datos sin saltos de linea
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    }
  } catch (e) { /* cable desenchufado: cae al bloque finally */ }
  finally {
    serialReader = null;
    try { await serialPipe; } catch (e) {}
    await sleep(150);   // deja que el pipe libere el puerto
    try { await port.close(); } catch (e) {}
    serialPort = null;
    releaseWakeLock();
    if (usbUserClosing) onLinkLost('Receptor desconectado. Los datos se conservan.', false);
    else onLinkLost('Conexión USB interrumpida (¿cable desenchufado?). Los datos se conservan; al reconectar el cable continúa solo.', true);
  }
}

/* ================= BLUETOOTH BLE ================= */
let bleDevice = null, bleChar = null, bleBuf = '', bleUserClosing = false;
const bleDecoder = new TextDecoder();

async function connectBle() {
  if (!('bluetooth' in navigator)) return;
  try {
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'BYB' }, { services: [NUS_SERVICE] }], optionalServices: [NUS_SERVICE] });
    bleDevice = dev; bleUserClosing = false;
    dev.removeEventListener('gattserverdisconnected', onBleDisconnected);
    dev.addEventListener('gattserverdisconnected', onBleDisconnected);
    addEvent('Conectando por Bluetooth a ' + (dev.name || 'receptor') + '...');
    let lastErr;
    for (let i = 0; i < 3; i++) {   // en Android la 1a conexion GATT suele fallar: reintenta
      try { await bleOpen(); lastErr = null; break; } catch (e) { lastErr = e; await sleep(900); }
    }
    if (lastErr) throw lastErr;
    onLinkConnected('ble');
    acquireWakeLock();
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      const tip = e.name === 'SecurityError' ? ' (la app debe abrirse desde https://)' : ' Revisa que el Bluetooth y la Ubicación del celular estén activados y que el receptor esté encendido.';
      addEvent('No se pudo conectar por Bluetooth: ' + e.message + tip, 'ev-crit');
    }
    try { bleDevice && bleDevice.gatt.connected && bleDevice.gatt.disconnect(); } catch (err) {}
  }
}

async function bleOpen() {
  const server = await bleDevice.gatt.connect();
  const svc = await server.getPrimaryService(NUS_SERVICE);
  bleChar = await svc.getCharacteristic(NUS_TX_CHAR);
  bleChar.removeEventListener('characteristicvaluechanged', onBleData);
  bleChar.addEventListener('characteristicvaluechanged', onBleData);
  await bleChar.startNotifications();
  bleBuf = '';
}

/* Las lineas llegan partidas en trozos de ~20 bytes: se rearman hasta el salto de linea. */
function onBleData(ev) {
  bleBuf += bleDecoder.decode(ev.target.value, { stream: true });
  if (bleBuf.length > 4096) bleBuf = bleBuf.slice(-1024);
  let idx;
  while ((idx = bleBuf.indexOf('\n')) >= 0) {
    const line = bleBuf.slice(0, idx).trim();
    bleBuf = bleBuf.slice(idx + 1);
    if (line) handleLine(line);
  }
}

async function onBleDisconnected() {
  if (bleUserClosing || state.mode !== 'ble') return;
  addEvent('Bluetooth perdido. Reintentando conexión...', 'ev-alert');
  markNoSignal();
  for (let i = 1; i <= 10 && !bleUserClosing; i++) {
    await sleep(1500 * Math.min(i, 4));
    if (bleUserClosing) return;
    try { await bleOpen(); addEvent('Bluetooth reconectado.'); return; } catch (e) { /* sigue intentando */ }
  }
  if (!bleUserClosing) {
    releaseWakeLock();
    onLinkLost('No se pudo reconectar por Bluetooth. Acerca el equipo al receptor y conecta de nuevo. Los datos se conservan.', true);
  }
}

/* ================= DESCONECTAR ================= */
async function disconnectLink() {
  if (state.mode === 'usb') {
    usbUserClosing = true;
    try { if (serialReader) await serialReader.cancel(); } catch (e) {}
  } else if (state.mode === 'ble') {
    bleUserClosing = true;
    try { if (bleChar) await bleChar.stopNotifications(); } catch (e) {}
    try { bleDevice && bleDevice.gatt.connected && bleDevice.gatt.disconnect(); } catch (e) {}
    releaseWakeLock();
    onLinkLost('Receptor desconectado. Los datos se conservan.', false);
  }
}
