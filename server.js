/* ============================================================
   DINAMIC BYB — servidor local (sin dependencias, sólo Node)
   ------------------------------------------------------------
   Uso:
     node server.js            →  http://localhost:8080  (sólo este PC)
     node server.js --lan      →  también desde otros equipos de la red
     node server.js --puerto 8080
     node server.js --no-open  →  no abre el navegador

   ¿Por qué un servidor?  El navegador sólo permite INSTALAR la app
   (PWA) desde http://localhost o https.  Si abre el .html con
   doble clic (file://) el navegador no ofrece "Instalar app".
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const argv = process.argv.slice(2);
const LAN = argv.includes('--lan');
const NO_OPEN = argv.includes('--no-open');
const pPuerto = argv.indexOf('--puerto');
const PORT = pPuerto >= 0 && argv[pPuerto + 1] ? parseInt(argv[pPuerto + 1], 10) : 8080;
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';

const ROOT = __dirname;
const INDEX = 'balanceo_app_v2.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ino': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function responder(res, code, cuerpo, tipo) {
  res.writeHead(code, {
    'Content-Type': tipo || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(cuerpo);
}

const servidor = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return responder(res, 405, 'Método no permitido');
  }

  let ruta;
  try { ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { return responder(res, 400, 'URL inválida'); }

  if (ruta === '/' || ruta === '' || ruta === '/index.html') ruta = '/' + INDEX;

  /* anti path-traversal: resolver y exigir que quede dentro de ROOT */
  const completo = path.resolve(ROOT, '.' + ruta);
  const rel = path.relative(ROOT, completo);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return responder(res, 403, 'Acceso denegado');
  }

  fs.stat(completo, (err, st) => {
    if (err || !st.isFile()) {
      return responder(res, 404,
        'No se encontró ' + ruta + '\n\n' +
        '¿Está el servidor apuntando a la carpeta correcta?\n' +
        'Carpeta: ' + ROOT + '\n');
    }
    const ext = path.extname(completo).toLowerCase();
    const tipo = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': tipo,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(completo).pipe(res);
  });
});

servidor.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('\n  El servidor ya estaba encendido en el puerto ' + PORT + '.');
    console.log('  Abriendo la app...\n');
    if (!NO_OPEN && process.platform === 'win32') {
      exec('start "" "http://localhost:' + PORT + '/"');
    }
    setTimeout(() => process.exit(0), 1200);
  } else {
    console.error('\n  Error del servidor: ' + e.message + '\n');
    process.exit(1);
  }
});

servidor.listen(PORT, HOST, () => {
  const local = 'http://localhost:' + PORT + '/';
  console.log('');
  console.log('  ================================================');
  console.log('   DINAMIC BYB — servidor local');
  console.log('  ================================================');
  console.log('   Abrir la app:  ' + local);
  console.log('   Carpeta:       ' + ROOT);
  console.log('');
  console.log('   Para dejar un icono en el escritorio use');
  console.log('   INSTALAR.bat (o el instalador DINAMIC_BYB_Setup.exe).');
  console.log('');
  if (LAN) {
    const os = require('os');
    const ips = Object.values(os.networkInterfaces())
      .flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log('   Desde otros equipos de la red:');
    ips.forEach(ip => console.log('     http://' + ip + ':' + PORT + '/'));
    console.log('   (desde otro equipo se puede usar, pero la');
    console.log('    instalación PWA exige localhost o https)');
    console.log('');
  } else {
    console.log('   ¿Necesita verlo desde otro equipo?  node server.js --lan');
    console.log('');
  }
  console.log('   Cierre con Ctrl+C');
  console.log('  ================================================\n');

  if (!NO_OPEN && process.platform === 'win32') {
    exec('start "" "' + local + '"');
  }
});

process.on('SIGINT', () => { console.log('\n  Servidor detenido.'); process.exit(0); });
