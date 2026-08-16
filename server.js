#!/usr/bin/env node
'use strict';
/*
 * Candado LAN — relé de eventos para la sala P2PKH.
 *
 * El servidor NO verifica criptografía. Guarda un log ordenado de eventos por sala
 * y lo reemite; cada navegador recalcula hash160 y verifica las firmas por su cuenta.
 * Eso es a la vez la lección de la demo y la razón de que aquí no haya dependencias.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_ROOM = (process.env.ROOM || 'SATOSHI').toUpperCase();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(4).toString('hex');

const MAX_EVENTS = 2000;          // techo por sala, evita crecer sin límite en una sesión larga
const MAX_BODY = 64 * 1024;       // una firma DER + pubkey no llega ni a 1 KB
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 20000;

/** @type {Map<string, {events:any[], clients:Set<any>, seq:number, touched:number}>} */
const rooms = new Map();

function getRoom(code) {
  const key = String(code || '').toUpperCase().slice(0, 24) || DEFAULT_ROOM;
  if (!/^[A-Z0-9_-]+$/.test(key)) return null;
  let room = rooms.get(key);
  if (!room) {
    room = { events: [], clients: new Set(), seq: 0, touched: Date.now() };
    rooms.set(key, room);
    log(`sala creada: ${key}`);
  }
  room.touched = Date.now();
  return room;
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// --- difusión ------------------------------------------------------------

function broadcast(room, payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of room.clients) {
    try { res.write(frame); } catch { room.clients.delete(res); }
  }
}

/**
 * Poda una sala larga sin tirar nunca un `join`: el log es lo único que reconstruye
 * el tablero, y sin las presentaciones quien llegue tarde vería candados sin dueño.
 */
function prune(room) {
  let porTirar = room.events.length - MAX_EVENTS;
  if (porTirar <= 0) return;
  room.events = room.events.filter((e) => {
    if (porTirar === 0 || e.type === 'join') return true;
    porTirar--;
    return false;
  });
}

function append(room, event) {
  // Una persona que recarga vuelve a presentarse: nos quedamos solo con su último join.
  if (event.type === 'join' && event.pid) {
    room.events = room.events.filter((e) => !(e.type === 'join' && e.pid === event.pid));
  }

  room.seq += 1;
  const stored = { ...event, seq: room.seq, at: Date.now() };
  room.events.push(stored);
  prune(room);
  broadcast(room, { type: 'event', event: stored });
  return stored;
}

// --- rutas ---------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'No encontrado: ' + rel);
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // Las fuentes sí se cachean; el resto no, para que recargar durante la charla traiga lo último.
    headers['Cache-Control'] = ext === '.woff2' ? 'public, max-age=604800' : 'no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJSON(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function handleEvents(req, res, url) {
  const room = getRoom(url.searchParams.get('room'));
  if (!room) return send(res, 400, 'text/plain', 'Código de sala inválido');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`retry: 2000\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'replay', seq: room.seq, events: room.events })}\n\n`);
  room.clients.add(res);

  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* la limpieza la hace 'close' */ }
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(beat);
    room.clients.delete(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handlePublish(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: 'JSON inválido' });
  }

  const room = getRoom(parsed.room);
  if (!room) return sendJSON(res, 400, { error: 'Código de sala inválido' });

  const event = parsed.event;
  if (!event || typeof event.type !== 'string') {
    return sendJSON(res, 400, { error: 'Falta event.type' });
  }

  const ADMIN_ONLY = new Set(['round', 'reset']);
  if (ADMIN_ONLY.has(event.type) && parsed.adminToken !== ADMIN_TOKEN) {
    return sendJSON(res, 403, { error: 'Se requiere token de facilitador' });
  }

  if (event.type === 'reset') {
    room.events = [];
    room.seq = 0;
    broadcast(room, { type: 'replay', seq: 0, events: [] });
    log(`sala ${String(parsed.room || DEFAULT_ROOM).toUpperCase()} reiniciada`);
    return sendJSON(res, 200, { ok: true, seq: 0 });
  }

  const stored = append(room, event);
  return sendJSON(res, 200, { ok: true, seq: stored.seq });
}

/* Cada dispositivo que aparece se anuncia una vez en la terminal. Sirve para saber
   quién ha llegado durante la sesión y, sobre todo, para diagnosticar: si un teléfono
   dice que no puede abrir la página y aquí no sale nada, sus paquetes no están llegando. */
const vistos = new Set();
function anunciarDispositivo(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip || vistos.has(ip)) return;
  vistos.add(ip);
  const propio = ip === '127.0.0.1' || ip === '::1';
  log(`nuevo dispositivo: ${ip}${propio ? ' (tú)' : ''} — ${vistos.size} en total`);
}

const server = http.createServer((req, res) => {
  anunciarDispositivo(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res, url);
  if (req.method === 'POST' && url.pathname === '/pub') return void handlePublish(req, res);
  if (req.method === 'GET' && url.pathname === '/config') {
    return sendJSON(res, 200, { defaultRoom: DEFAULT_ROOM });
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);

  send(res, 405, 'text/plain', 'Método no permitido');
});

// Recolecta salas ociosas para que una sesión larga no acumule basura.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.touched > ROOM_TTL_MS) {
      rooms.delete(code);
      log(`sala ${code} recolectada por inactividad`);
    }
  }
}, 10 * 60 * 1000).unref();

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/* public/vendor/ no se versiona. Sin él la página carga a medias y el error solo se ve
   en la consola del teléfono, así que lo detectamos aquí y decimos qué hacer. */
function comprobarVendor() {
  const necesarios = ['elliptic.min.js', 'crypto-js.min.js', 'bip39.bundle.js', 'qrcode.min.js', 'fonts/fonts.css'];
  const faltan = necesarios.filter((f) => !fs.existsSync(path.join(PUBLIC, 'vendor', f)));
  if (faltan.length === 0) return;

  console.error('\n  Faltan las librerías del navegador en public/vendor/:');
  for (const f of faltan) console.error(`    · vendor/${f}`);
  console.error('\n  Genéralas una sola vez, con conexión a internet:');
  console.error('    npm run vendor        (o: bash build-vendor.sh)\n');
  console.error('  Después la sala funciona sin internet.\n');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  El puerto ${PORT} ya está ocupado (¿tienes otra sala abierta?).`);
    console.error(`  Ciérrala, o arranca en otro puerto:  PORT=8081 node server.js\n`);
    process.exit(1);
  }
  throw err;
});

comprobarVendor();

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  CANDADO LAN — sala P2PKH lista');
  console.log(line);
  console.log(`  Sala por defecto : ${DEFAULT_ROOM}`);
  console.log(`  Token facilitador: ${ADMIN_TOKEN}`);
  console.log('\n  Que se unan desde su teléfono a:');
  const addrs = lanAddresses();
  if (addrs.length === 0) {
    console.log('    (sin interfaces de red — solo http://localhost:' + PORT + ')');
  }
  for (const { name, address } of addrs) {
    console.log(`    http://${address}:${PORT}      [${name}]`);
  }
  console.log(`\n  Tu panel de facilitador (controla las rondas):`);
  const primary = addrs[0]?.address || 'localhost';
  console.log(`    http://${primary}:${PORT}/?admin=${ADMIN_TOKEN}`);
  console.log(`\n  Si hay firewall:  sudo ufw allow ${PORT}/tcp`);
  console.log(`${line}\n`);
});
