/* Prueba de extremo a extremo con dos navegadores reales.
   Opcional: necesita puppeteer, que no es dependencia del proyecto.

     mkdir -p /tmp/cl-e2e && cd /tmp/cl-e2e && npm i puppeteer
     cd ~/Code/candado-lan && node test/e2e-browser.mjs

   Lo busca solo en /tmp/cl-e2e y en el propio proyecto; si lo tienes en otro sitio,
   apúntalo con PUPPETEER_PATH=/ruta/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js
   Sin puppeteer instalado, el script se salta a sí mismo sin fallar. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8299;
const BASE = `http://127.0.0.1:${PORT}`;

const ENTRY = 'lib/esm/puppeteer/puppeteer.js';
const CANDIDATOS = [
  process.env.PUPPETEER_PATH,
  path.join(ROOT, 'node_modules/puppeteer', ENTRY),
  `/tmp/cl-e2e/node_modules/puppeteer/${ENTRY}`,
  'puppeteer',
].filter(Boolean);

let puppeteer;
for (const candidato of CANDIDATOS) {
  try {
    puppeteer = (await import(candidato)).default;
    break;
  } catch { /* probamos el siguiente */ }
}
if (!puppeteer) {
  console.log('puppeteer no está instalado — se omite la prueba de navegador.');
  console.log('  mkdir -p /tmp/cl-e2e && cd /tmp/cl-e2e && npm i puppeteer');
  process.exit(0);
}

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ROOM: 'E2E', ADMIN_TOKEN: 'e2e' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Que no quede un servidor huérfano si esto muere a mitad (p. ej. con la salida cortada).
  const stop = () => { try { child.kill(); } catch { /* ya terminó */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGPIPE', () => { stop(); process.exit(0); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el servidor no arrancó')), 8000);
    child.stdout.on('data', (b) => {
      if (b.toString().includes('Si hay firewall')) { clearTimeout(timer); resolve(child); }
    });
  });
}

/* La sala tiene que funcionar sin internet: apuntamos cualquier petición que
   salga del servidor local para verificarlo al final. */
const foreignRequests = [];
function watchRequests(page) {
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith('data:') && !url.startsWith(BASE) && !url.startsWith('http://localhost')) {
      foreignRequests.push(url);
    }
  });
}

/** Abre una pestaña con almacenamiento aislado y entra a la sala con ese nombre. */
async function join(browser, nick, errors, query = '') {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${nick}: ${m.text()}`); });
  watchRequests(page);

  await page.goto(`${BASE}/?room=E2E${query}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#joinOverlay.show');
  await page.type('#joinNick', nick);
  await page.click('#btnJoin');
  await page.waitForFunction(() => document.querySelector('#chipStatus').textContent === 'en línea');
  return page;
}

/* innerText devuelve el texto ya renderizado y varias etiquetas van en mayúsculas
   por CSS (text-transform), así que comparamos siempre en minúsculas. */
const text = (page, sel) => page.$eval(sel, (el) => el.innerText.toLowerCase());

const server = await startServer();
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const errors = [];

try {
  console.log('\nDos navegadores en la misma sala:');
  const ana = await join(browser, 'ana', errors);
  const beto = await join(browser, 'beto', errors);

  // Ambas pestañas deben ver a las dos personas.
  await ana.waitForFunction(() => document.querySelectorAll('#players .player').length === 2);
  await beto.waitForFunction(() => document.querySelectorAll('#players .player').length === 2);
  check('cada quien ve al otro en la lista', true);
  check('la identidad muestra hash160', (await text(ana, '#identityBox')).includes('hash160'));

  // Ana le crea un candado a Beto.
  await ana.click('#players [data-lock-to]');
  await ana.waitForSelector('#lockOverlay.show');
  await ana.type('#lockLabel', 'un café');
  await ana.click('#btnCreateLock');
  await ana.waitForFunction(() => !document.querySelector('#lockOverlay').classList.contains('show'));

  await beto.waitForFunction(() => document.querySelectorAll('#locks .lock-card').length === 1);
  check('el candado aparece en la otra pestaña', true);
  check('Beto ve que es para él', (await text(beto, '#locks')).includes('es para ti'));
  check('Ana NO ve "es para ti"', !(await text(ana, '#locks')).includes('es para ti'));

  // Regresión: el candado se nombra por la llave que lo abre, no por lo que guarda.
  const titulo = await beto.$eval('#locks .lock-title', (el) => el.textContent.toLowerCase());
  check('la tarjeta se nombra por la llave pública del destinatario',
    titulo.includes('candado bloqueado con la llave pública de beto'), titulo);
  check('el título no expone el contenido', !titulo.includes('un café'), titulo);
  check('la nota queda como línea secundaria',
    (await beto.$eval('#locks .lock-note', (el) => el.textContent.toLowerCase())).includes('un café'));
  check('el feed tampoco nombra el candado por su contenido',
    !(await text(beto, '#feed')).includes('un café'));
  check('el feed lo nombra por la llave pública',
    (await text(beto, '#feed')).includes('bloqueó un candado con la llave pública de beto'));

  // Beto lo abre con su llave.
  await beto.click('#locks [data-open]:not([data-tamper])');
  await beto.waitForSelector('#runOverlay.show');
  check('el modal se titula por el destinatario, no por el contenido',
    (await text(beto, '#runTitle')) === 'candado de beto', await text(beto, '#runTitle'));
  await beto.click('#btnRunAll');
  await beto.waitForSelector('#runResult.ok');
  check('Beto abre el candado y el script valida', true);
  check('el candado del modal se dibuja abierto',
    await beto.$eval('#runLockIcon', (el) => el.classList.contains('open')));
  await beto.click('#runOverlay .close');

  // Ana, en su propia pestaña, verifica la apertura por su cuenta.
  await ana.waitForFunction(() => document.querySelector('#locks').innerText.toLowerCase().includes('abierto por beto'));
  check('Ana verifica la apertura de forma independiente', true);
  await ana.waitForFunction(() => document.querySelector('#scores').innerText.includes('10 pts'));
  check('el marcador se actualiza en ambas', (await text(ana, '#scores')).includes('5 pts'));

  // Beto crea un candado para Ana y luego intenta robárselo él mismo.
  await beto.click('#players [data-lock-to]');
  await beto.waitForSelector('#lockOverlay.show');
  await beto.click('#btnCreateLock');          // esta vez sin nota
  await beto.waitForFunction(() => document.querySelectorAll('#locks .lock-card').length === 2);
  check('sin nota no se dibuja la línea de nota',
    await beto.$eval('#locks .lock-card', (el) => !el.querySelector('.lock-note')));

  const robo = await beto.$('#locks .lock-card [data-open]');
  check('sobre un candado ajeno solo ofrece robar',
    (await beto.$eval('#locks .lock-card [data-open]', (el) => el.textContent.toLowerCase())).includes('robar'));
  await robo.click();
  await beto.waitForSelector('#runOverlay.show');
  await beto.click('#btnRunAll');
  await beto.waitForSelector('#runResult.fail');
  check('el robo falla en OP_EQUALVERIFY',
    (await text(beto, '#runResult')).includes('op_equalverify'));
  await beto.click('#runOverlay .close');

  // Ana abre el suyo, pero con firma corrupta a propósito.
  await ana.waitForFunction(() => document.querySelectorAll('#locks .lock-card').length === 2);
  await ana.click('#locks [data-open][data-tamper]');
  await ana.waitForSelector('#runOverlay.show');
  await ana.click('#btnRunAll');
  await ana.waitForSelector('#runResult.fail');
  check('la firma corrupta falla en OP_CHECKSIG',
    (await text(ana, '#runResult')).includes('op_checksig'));
  await ana.click('#runOverlay .close');

  // Y ahora sí, con su firma buena.
  await ana.click('#locks [data-open]:not([data-tamper])');
  await ana.waitForSelector('#runOverlay.show');
  await ana.click('#btnRunAll');
  await ana.waitForSelector('#runResult.ok');
  check('con la llave correcta sí abre', true);
  await ana.click('#runOverlay .close');

  // Paso a paso: la pila crece opcode a opcode.
  await beto.click('#locks .attempt');
  await beto.waitForSelector('#runOverlay.show');
  await beto.click('#btnStep');
  await beto.click('#btnStep');
  check('el paso a paso apila dos elementos',
    (await beto.$$('#runStack .stack-item')).length === 2);
  await beto.click('#runOverlay .close');

  // Autodiagnóstico en el navegador real.
  await ana.click('#btnSelfTest');
  await ana.waitForSelector('#selfTestOut .test-row');
  check('autodiagnóstico sin fallas en el navegador',
    !(await text(ana, '#selfTestOut')).includes('falla'));

  // Recargar mantiene identidad y reconstruye el tablero.
  const pkhAntes = await text(ana, '#identityBox');
  await ana.reload({ waitUntil: 'networkidle2' });
  await ana.waitForFunction(() => document.querySelector('#chipStatus').textContent === 'en línea');
  await ana.waitForFunction(() => document.querySelectorAll('#locks .lock-card').length === 2);
  check('tras recargar conserva identidad y tablero', (await text(ana, '#identityBox')) === pkhAntes);

  // Compartir: QR y URL.
  await ana.click('#btnShare');
  await ana.waitForSelector('#shareOverlay.show');
  check('el QR de unión se genera', (await ana.$('#qrBox svg, #qrBox img')) !== null);
  check('la URL de unión lleva la sala', (await text(ana, '#shareUrl')).includes('room=e2e'));

  await ana.click('#shareOverlay .close');

  // El facilitador dirige las rondas y ambas pestañas las ven.
  console.log('\nFacilitador y guía:');
  const jefa = await join(browser, 'jefa', errors, '&admin=e2e');
  await jefa.waitForFunction(() => !document.querySelector('#roundControls').hidden);
  check('con token aparecen los controles de ronda', true);
  check('sin token no aparecen', await ana.$eval('#roundControls', (el) => el.hidden));

  await jefa.click('[data-round="abrir"]');
  await beto.waitForFunction(() => document.querySelector('#roundTitle').textContent.includes('Ábrelo'));
  check('la ronda se propaga a todas las pestañas', true);

  jefa.on('dialog', (d) => d.accept());
  await jefa.click('[data-reset]');
  await beto.waitForFunction(() => document.querySelectorAll('#locks .lock-card').length === 0);
  check('reiniciar la sala limpia el tablero', true);
  await beto.waitForFunction(() => document.querySelectorAll('#players .player').length >= 1);
  check('tras el reinicio la gente se vuelve a presentar sola', true);

  // La guía sigue funcionando sin CDNs.
  const guia = await browser.newPage();
  watchRequests(guia);
  guia.on('pageerror', (e) => errors.push(`guia: ${e.message}`));
  await guia.goto(`${BASE}/guia.html`, { waitUntil: 'networkidle2' });
  await guia.waitForFunction(() => document.querySelector('#phrase').value.split(' ').length === 12);
  await guia.click('button.secondary');
  await guia.waitForFunction(() => document.querySelector('#lockSection').style.display === 'block');
  check('la guía deriva llaves y muestra el candado',
    (await guia.$eval('#lockScript', (el) => el.textContent)).includes('OP_EQUALVERIFY'));

  // Sala llena: la dinámica no es de dos, y con mucha gente la UI tiene que ayudar.
  console.log('\nSala llena:');
  const N = 10;
  const sala = [];
  for (let i = 0; i < N; i++) sala.push(await join(browser, 'inv' + i, errors));
  const total = N + 3;  // ana, beto y jefa siguen dentro
  for (const p of sala) {
    await p.waitForFunction((n) => document.querySelectorAll('#players .player').length === n, {}, total);
  }
  check(`las ${total} personas se ven entre sí`, true);
  check('con la sala llena aparece el buscador',
    !(await sala[0].$eval('#playerFilter', (el) => el.hidden)));

  await sala[0].type('#playerFilter', 'inv7');
  await sala[0].waitForFunction(() => document.querySelectorAll('#players .player').length === 1);
  check('el buscador encuentra a una persona concreta', true);
  await sala[0].$eval('#playerFilter', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });

  /* Todos le crean un candado a la misma persona (el receptor), menos ella,
     que se lo crea a otro. Así el tablero del receptor tiene N-1 candados suyos
     y 1 ajeno, y se puede comprobar el orden y los filtros sin ambigüedad. */
  const receptor = sala[0];
  const pkhReceptor = await receptor.$eval('#identityBox', (el) =>
    el.querySelectorAll('.v')[2].textContent.trim());

  for (const p of sala.slice(1)) {
    await p.click(`#players [data-lock-to="${pkhReceptor}"]`);
    await p.waitForSelector('#lockOverlay.show');
    await p.click('#btnCreateLock');
    await p.waitForFunction(() => !document.querySelector('#lockOverlay').classList.contains('show'));
  }
  const otros = await receptor.$$('#players [data-lock-to]');
  await otros[0].click();                       // el receptor se lo crea a otra persona
  await receptor.waitForSelector('#lockOverlay.show');
  await receptor.click('#btnCreateLock');
  await receptor.waitForFunction(() => !document.querySelector('#lockOverlay').classList.contains('show'));

  await receptor.waitForFunction((n) => document.querySelectorAll('#locks .lock-card').length >= n, {}, N);
  check('los candados de todos conviven en el tablero', true);
  check('con muchos candados aparecen los filtros',
    !(await receptor.$eval('#lockFilters', (el) => el.hidden)));

  const primero = await receptor.$eval('#locks .lock-card', (el) => el.className);
  check('sin filtrar, lo dirigido a ti sale primero', primero.includes('mine'), primero);

  await receptor.click('[data-filter="parami"]');
  await receptor.waitForFunction((n) => {
    const cards = [...document.querySelectorAll('#locks .lock-card')];
    return cards.length === n && cards.every((el) => el.className.includes('mine'));
  }, {}, N - 1);
  check(`el filtro "Para mí" deja solo tus ${N - 1} candados`, true);

  await receptor.click('[data-filter="mios"]');
  await receptor.waitForFunction(() => document.querySelectorAll('#locks .lock-card').length === 1);
  check('el filtro "Los creé" deja solo el que creaste', true);
  await receptor.click('[data-filter="todos"]');

  check('sin errores de JavaScript', errors.length === 0, errors.join(' | '));
  check('ninguna petición sale a internet', foreignRequests.length === 0, foreignRequests.join(' | '));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? '\nTodo en orden.\n' : `\n${failures} comprobación(es) fallaron.\n`);
process.exit(failures === 0 ? 0 : 1);
