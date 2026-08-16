/* Prueba de humo: protocolo del servidor + reducción de eventos con criptografía real.
   Uso: node test/smoke.mjs          (no necesita navegador ni npm install) */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8199;
const ADMIN = 'token-de-prueba';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✔ ${name}`); } else { failures++; console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- Parte 1: el motor del cliente, cargado en Node -------------------------

function loadClient() {
  globalThis.window = globalThis;
  globalThis.elliptic = require(path.join(ROOT, 'public/vendor/elliptic.min.js'));
  globalThis.CryptoJS = require(path.join(ROOT, 'public/vendor/crypto-js.min.js'));
  require(path.join(ROOT, 'public/vendor/bip39.bundle.js'));   // define window.bip39lib
  require(path.join(ROOT, 'public/js/keys.js'));
  require(path.join(ROOT, 'public/js/script-vm.js'));
  require(path.join(ROOT, 'public/js/net.js'));
  return globalThis.CL;
}

function testFold() {
  console.log('\nMotor del cliente (criptografía y fold):');
  const { checks, ok } = CL.selfTest();
  for (const c of checks) check(c.name, c.ok);
  check('autodiagnóstico completo', ok);

  const alice = CL.identityFromMnemonic(CL.randomMnemonic());
  const bob = CL.identityFromMnemonic(CL.randomMnemonic());
  let seq = 0;
  const ev = (o) => ({ ...o, seq: ++seq, at: Date.now() });

  const events = [
    ev({ type: 'join', pid: alice.pkh, nick: 'alice', pubHex: alice.pubHex, pkh: alice.pkh }),
    ev({ type: 'join', pid: bob.pkh, nick: 'bob', pubHex: bob.pubHex, pkh: bob.pkh }),
    ev({ type: 'lock', id: 'L1', fromPid: alice.pkh, fromNick: 'alice', toPkh: bob.pkh, toNick: 'bob', label: 'un café' }),
  ];

  let state = CL.foldEvents(events);
  const lock = state.locks.get('L1');
  check('el candado entra al tablero', !!lock);

  // Alice intenta robar su propio candado dirigido a Bob: debe fallar en OP_EQUALVERIFY.
  const robo = CL.signMessage(alice, lock.msg);
  events.push(ev({
    type: 'spend', id: 'A1', lockId: 'L1', byPid: alice.pkh, byNick: 'alice',
    sigDer: robo.sigDer, pubHex: alice.pubHex,
  }));
  state = CL.foldEvents(events);
  check('llave equivocada falla en OP_EQUALVERIFY',
    state.locks.get('L1').attempts[0].reason === 'wrong-key');
  check('el candado sigue cerrado tras el robo', !state.locks.get('L1').openedBy);

  // Bob con firma corrupta: debe fallar en OP_CHECKSIG.
  const bobSig = CL.signMessage(bob, lock.msg);
  events.push(ev({
    type: 'spend', id: 'A2', lockId: 'L1', byPid: bob.pkh, byNick: 'bob',
    sigDer: CL.tamperSignature(bobSig.sigDer), pubHex: bob.pubHex,
  }));
  state = CL.foldEvents(events);
  check('firma corrupta falla en OP_CHECKSIG',
    state.locks.get('L1').attempts[1].reason === 'bad-sig');

  // Bob con su firma buena: abre.
  events.push(ev({
    type: 'spend', id: 'A3', lockId: 'L1', byPid: bob.pkh, byNick: 'bob',
    sigDer: bobSig.sigDer, pubHex: bob.pubHex,
  }));
  state = CL.foldEvents(events);
  check('la llave correcta abre el candado', state.locks.get('L1').openedBy === bob.pkh);
  check('puntaje: +10 a quien abre', state.scores.get(bob.pkh) === 10);
  check('puntaje: +5 a quien lo creó', state.scores.get(alice.pkh) === 5);

  // Un segundo navegador que replica el mismo log llega al mismo tablero.
  const otro = CL.foldEvents(events);
  check('el fold es determinista entre clientes',
    otro.locks.get('L1').openedBy === state.locks.get('L1').openedBy &&
    otro.scores.get(bob.pkh) === state.scores.get(bob.pkh));
}

/* Regresión: un candado se nombra por la llave que lo abre, nunca por lo que guarda.
   Del scriptPubKey real tampoco se deduce el contenido, así que el feed no debe filtrarlo. */
function testNaming(CL) {
  console.log('\nCómo se nombra un candado:');
  const ana = CL.identityFromMnemonic(CL.randomMnemonic());
  const beto = CL.identityFromMnemonic(CL.randomMnemonic());
  const SECRETO = '5.000 sats para el café';
  let seq = 0;
  const ev = (o) => ({ ...o, seq: ++seq, at: Date.now() });

  const events = [
    ev({ type: 'join', pid: ana.pkh, nick: 'ana', pubHex: ana.pubHex, pkh: ana.pkh }),
    ev({ type: 'join', pid: beto.pkh, nick: 'beto', pubHex: beto.pubHex, pkh: beto.pkh }),
    ev({ type: 'lock', id: 'L1', fromPid: ana.pkh, fromNick: 'ana', toPkh: beto.pkh, toNick: 'beto', label: SECRETO }),
  ];
  let state = CL.foldEvents(events);
  const feedLock = state.feed.find((f) => f.kind === 'lock');
  check('el feed nombra el candado por la llave pública del destinatario',
    feedLock.text === 'ana bloqueó un candado con la llave pública de beto', feedLock.text);
  check('el feed no filtra el contenido al crearlo', !feedLock.text.includes(SECRETO));
  check('la nota se conserva aparte', state.locks.get('L1').label === SECRETO);

  // Robo fallido: se nombra por el destinatario, sin mencionar el contenido.
  const robo = CL.signMessage(ana, state.locks.get('L1').msg);
  events.push(ev({ type: 'spend', id: 'A1', lockId: 'L1', byPid: ana.pkh, byNick: 'ana', sigDer: robo.sigDer, pubHex: ana.pubHex }));
  state = CL.foldEvents(events);
  const feedFail = state.feed.find((f) => f.kind === 'fail');
  check('el fallo se nombra por el destinatario', feedFail.text.startsWith('ana falló al abrir el candado de beto'), feedFail.text);
  check('el fallo no filtra el contenido', !feedFail.text.includes(SECRETO));

  // Apertura correcta.
  const bueno = CL.signMessage(beto, state.locks.get('L1').msg);
  events.push(ev({ type: 'spend', id: 'A2', lockId: 'L1', byPid: beto.pkh, byNick: 'beto', sigDer: bueno.sigDer, pubHex: beto.pubHex }));
  state = CL.foldEvents(events);
  const feedOpen = state.feed.find((f) => f.kind === 'open');
  check('la apertura no filtra el contenido', !feedOpen.text.includes(SECRETO), feedOpen.text);

  // Un candado sin nota sigue siendo válido y firmable.
  const sinNota = [
    events[0], events[1],
    ev({ type: 'lock', id: 'L2', fromPid: ana.pkh, fromNick: 'ana', toPkh: beto.pkh, toNick: 'beto', label: '' }),
  ];
  const estado2 = CL.foldEvents(sinNota);
  const l2 = estado2.locks.get('L2');
  check('sin nota no aparecen textos de relleno', l2.label === '' && !l2.msg.includes('undefined'), l2.msg);
  const firma2 = CL.signMessage(beto, l2.msg);
  sinNota.push(ev({ type: 'spend', id: 'A3', lockId: 'L2', byPid: beto.pkh, byNick: 'beto', sigDer: firma2.sigDer, pubHex: beto.pubHex }));
  check('un candado sin nota se abre igual',
    CL.foldEvents(sinNota).locks.get('L2').openedBy === beto.pkh);
}

/* La sala no es de dos: aguanta N personas. 25 identidades, 25 candados en círculo
   y 25 aperturas, todo verificado con criptografía real. */
function testEscala(CL) {
  console.log('\nSala llena (25 personas):');
  const N = 25;
  const gente = Array.from({ length: N }, (_, i) => ({
    nick: 'p' + i, id: CL.identityFromMnemonic(CL.randomMnemonic()),
  }));
  let seq = 0;
  const ev = (o) => ({ ...o, seq: ++seq, at: Date.now() });

  const events = gente.map((g) =>
    ev({ type: 'join', pid: g.id.pkh, nick: g.nick, pubHex: g.id.pubHex, pkh: g.id.pkh }));
  gente.forEach((g, i) => {
    const dest = gente[(i + 1) % N];
    events.push(ev({
      type: 'lock', id: 'L' + i, fromPid: g.id.pkh, fromNick: g.nick,
      toPkh: dest.id.pkh, toNick: dest.nick, label: '',
    }));
  });

  let state = CL.foldEvents(events);
  check(`las ${N} personas entran en el tablero`, state.players.size === N, String(state.players.size));
  check(`los ${N} candados conviven`, state.locks.size === N, String(state.locks.size));

  // Cada quien abre el que le dirigieron.
  gente.forEach((g, i) => {
    const lock = state.locks.get('L' + ((i - 1 + N) % N));
    const { sigDer } = CL.signMessage(g.id, lock.msg);
    events.push(ev({
      type: 'spend', id: 'S' + i, lockId: lock.id, byPid: g.id.pkh, byNick: g.nick,
      sigDer, pubHex: g.id.pubHex,
    }));
  });

  const t0 = Date.now();
  state = CL.foldEvents(events);
  const ms = Date.now() - t0;
  const abiertos = [...state.locks.values()].filter((l) => l.openedBy).length;
  check(`los ${N} abren el suyo`, abiertos === N, String(abiertos));
  check('cada quien abrió el que le tocaba',
    gente.every((g, i) => state.locks.get('L' + ((i - 1 + N) % N)).openedBy === g.id.pkh));
  check(`verificar ${N} firmas es instantáneo (${ms} ms)`, ms < 2000);
  check('el feed se mantiene acotado', state.feed.length <= 60, String(state.feed.length));
  check('todos suman 15 puntos (10 por abrir + 5 por crear)',
    gente.every((g) => state.scores.get(g.id.pkh) === 15));
}

// ---- Parte 2: el protocolo del servidor -------------------------------------

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, ROOM: 'PRUEBA' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Que no quede un servidor huérfano si esto muere a mitad (p. ej. con la salida cortada).
  const stop = () => { try { child.kill(); } catch { /* ya terminó */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGPIPE', () => { stop(); process.exit(0); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el servidor no arrancó a tiempo')), 8000);
    child.stdout.on('data', (buf) => {
      if (buf.toString().includes('Si hay firewall')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => reject(new Error('el servidor terminó con código ' + code)));
  });
}

/** Cliente SSE mínimo: acumula los payloads que llegan. */
async function sseClient(room) {
  const res = await fetch(`${BASE}/events?room=${room}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const client = { messages: [], closed: false, close: () => { client.closed = true; reader.cancel().catch(() => {}); } };
  let buffer = '';

  (async () => {
    while (!client.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try { client.messages.push(JSON.parse(line.slice(6))); } catch { /* ignorar */ }
          }
        }
      }
    }
  })().catch(() => {});

  return client;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function publish(room, event, adminToken) {
  const res = await fetch(`${BASE}/pub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, event, adminToken }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function testServer() {
  console.log('\nProtocolo del servidor:');
  const a = await sseClient('PRUEBA');
  await wait(150);
  check('el primer cliente recibe replay vacío',
    a.messages[0]?.type === 'replay' && a.messages[0].events.length === 0);

  await publish('PRUEBA', { type: 'join', pid: 'p1', nick: 'ana', pubHex: 'aa', pkh: 'p1' });
  await publish('PRUEBA', { type: 'lock', id: 'L1', fromPid: 'p1', fromNick: 'ana', toPkh: 'p2', toNick: 'beto', label: 'x' });
  await wait(200);

  const live = a.messages.filter((m) => m.type === 'event').map((m) => m.event);
  check('los eventos llegan en vivo', live.length === 2);
  check('el seq es monotónico', live[0]?.seq === 1 && live[1]?.seq === 2);
  check('el servidor sella la hora', typeof live[0]?.at === 'number');

  const b = await sseClient('PRUEBA');
  await wait(200);
  const replayB = b.messages[0];
  check('quien llega tarde recibe el log completo',
    replayB?.type === 'replay' && replayB.events.length === 2 && replayB.seq === 2);

  const otraSala = await sseClient('OTRA');
  await wait(150);
  check('las salas están aisladas', otraSala.messages[0]?.events.length === 0);

  const sinToken = await publish('PRUEBA', { type: 'round', kind: 'abrir' });
  check('ronda sin token → 403', sinToken.status === 403);
  const conToken = await publish('PRUEBA', { type: 'round', kind: 'abrir' }, ADMIN);
  check('ronda con token → 200', conToken.status === 200);

  const resetSinToken = await publish('PRUEBA', { type: 'reset' });
  check('reset sin token → 403', resetSinToken.status === 403);
  await publish('PRUEBA', { type: 'reset' }, ADMIN);
  await wait(200);
  const ultimo = b.messages[b.messages.length - 1];
  check('el reset reemite un replay vacío', ultimo?.type === 'replay' && ultimo.events.length === 0);

  // Regresión: una sesión larga poda el log, pero jamás las presentaciones.
  await publish('PODA', { type: 'join', pid: 'a', nick: 'ana', pubHex: 'aa', pkh: 'a' });
  await publish('PODA', { type: 'join', pid: 'b', nick: 'beto', pubHex: 'bb', pkh: 'b' });
  for (let i = 0; i < 2100; i++) {
    await publish('PODA', { type: 'lock', id: 'L' + i, fromPid: 'a', fromNick: 'ana', toPkh: 'b', toNick: 'beto', label: '' });
  }
  const tarde = await sseClient('PODA');
  await wait(250);
  const podado = tarde.messages[0];
  check('la poda respeta el tope de eventos', podado.events.length <= 2000, String(podado.events.length));
  check('quien llega tarde sigue viendo a todo el mundo',
    podado.events.filter((e) => e.type === 'join').length === 2,
    String(podado.events.filter((e) => e.type === 'join').length));

  // Quien recarga se vuelve a presentar: guardamos solo su último join.
  await publish('PODA', { type: 'join', pid: 'a', nick: 'ana2', pubHex: 'aa', pkh: 'a' });
  const tarde2 = await sseClient('PODA');
  await wait(250);
  const joins = tarde2.messages[0].events.filter((e) => e.type === 'join');
  check('recargar no duplica a nadie en el log', joins.length === 2, String(joins.length));
  check('se conserva el último nombre', joins.some((e) => e.nick === 'ana2'));
  tarde.close(); tarde2.close();

  const malJson = await fetch(`${BASE}/pub`, { method: 'POST', body: 'no soy json' });
  check('cuerpo inválido → 400', malJson.status === 400);

  const index = await fetch(`${BASE}/`);
  check('sirve index.html', index.status === 200 && (await index.text()).includes('Candado LAN'));

  const fuera = await fetch(`${BASE}/../server.js`);
  check('no sirve archivos fuera de public/', fuera.status === 404);

  a.close(); b.close(); otraSala.close();
}

// ---- ejecución --------------------------------------------------------------

const CL = loadClient();
testFold(CL);
testNaming(CL);
testEscala(CL);

const server = await startServer();
try {
  await testServer();
} finally {
  server.kill();
}

console.log(failures === 0 ? '\nTodo en orden.\n' : `\n${failures} comprobación(es) fallaron.\n`);
process.exit(failures === 0 ? 0 : 1);
