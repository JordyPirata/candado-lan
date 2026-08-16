# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Demo educativa de **P2PKH** para una sala presencial en red local: cada asistente entra desde su teléfono,
genera identidad BIP39, publica su llave pública y crea/abre candados. Lee `README.md` para la dinámica de
las rondas y las notas del día de la presentación.

**El código está en español** (comentarios, UI, salida de los tests, buena parte de los identificadores) y el
`README.md` en inglés, que es la puerta de entrada del proyecto en abierto. Mantén cada cosa en su idioma:
código nuevo y textos que ve el público, en español; documentación de nivel repo, en inglés.

## Comandos

```bash
npm start          # node server.js — arranca la sala (PORT, HOST, ROOM, ADMIN_TOKEN)
npm run vendor     # ./build-vendor.sh — genera public/vendor/ (lo único que toca la red)
npm test           # node test/smoke.mjs — suite obligatoria: cripto + fold + protocolo HTTP/SSE
npm run test:e2e   # opcional: dos navegadores reales (necesita puppeteer)
```

`package.json` existe solo para declarar esos scripts, la licencia y `engines: node >=18`: **no hay ni una
dependencia**, ni de runtime ni de desarrollo, y no hay linter. No añadas ninguna — la ausencia de build es
parte del diseño (la sala tiene que arrancar sin internet delante del público).

`public/vendor/` **no está versionado**: lo genera `build-vendor.sh` y hace falta red la primera vez. Si
falta, `comprobarVendor()` aborta el arranque con el comando exacto que hay que correr; en un clon nuevo ese
es siempre el primer paso antes de poder probar nada.

`smoke.mjs` no tiene filtro de tests: para correr solo una parte, comenta las llamadas a `testFold` /
`testNaming` / `testEscala` / `testServer` al final del archivo. Levanta su propio servidor en el 8199
(el e2e usa el 8299), así que no puede correr con esos puertos ocupados.

Para instalar puppeteer para el e2e:
```bash
mkdir -p /tmp/cl-e2e && cd /tmp/cl-e2e && npm i puppeteer
```

## Arquitectura

**El servidor no hace criptografía.** `server.js` es un relé: guarda un log ordenado de eventos por sala
(`rooms: Map<code, {events, clients, seq}>`) y lo reemite por SSE. Toda verificación ocurre en el navegador.
Si te tienta mover una comprobación al servidor, esa tentación es justo lo que la demo enseña a resistir.

Flujo de un evento:

1. El navegador hace `POST /pub` con `{room, event, adminToken?}`.
2. El servidor le pone `seq` y `at`, lo añade al log y hace broadcast a los `GET /events?room=` (SSE).
3. Cada cliente aplica el evento con `CL.applyEvent` y re-renderiza.

Tipos de evento: `join`, `lock`, `spend`, `round`, `reset`. `round` y `reset` exigen `adminToken ===
ADMIN_TOKEN` (el facilitador abre la página con `?admin=<token>`, que el server imprime al arrancar).

**El estado es un fold puro sobre el log** (`CL.foldEvents` en `public/js/net.js`). Quien llega tarde recibe
un `replay` con todos los eventos y converge al mismo tablero. Dos consecuencias que hay que respetar al
tocar `applyEvent`: debe ser determinista y sin efectos secundarios, y los puntajes/feed se derivan del log,
nunca se guardan aparte.

**Verificación local**: al aplicar un `spend`, cada cliente corre `CL.runScript` (la máquina de pila P2PKH)
contra la firma y la pubkey del evento. Nadie confía en un "ok" ajeno; el tablero de cada quien es su propia
conclusión.

Invariantes del log en el servidor:
- `prune()` respeta el tope `MAX_EVENTS` pero **nunca descarta un `join`**: sin las presentaciones, quien
  llegue tarde vería candados sin dueño.
- `append()` deduplica `join` por `pid`: al recargar, una persona se vuelve a presentar y solo sobrevive su
  último `join`.

### Cliente (`public/js/`, todo en el namespace global `CL`, sin módulos ES)

Los archivos se cargan como `<script>` en orden desde `index.html` y cada uno cuelga funciones de `window.CL`.
Ese orden (`vendor/*` → `keys.js` → `script-vm.js` → `net.js` → `ui.js`) es una dependencia real; el mismo
orden lo replica `loadClient()` en `smoke.mjs` con `require`.

| Archivo | Responsabilidad |
|---|---|
| `keys.js` | BIP39 → seed → llave secp256k1 → `hash160`. Firma, verificación, `selfTest()` con vectores conocidos. |
| `script-vm.js` | `buildOps()` define la cinta de opcodes; `runScript()` la corre en silencio, `createRunner()` paso a paso para el modal. Un solo motor, dos consumidores. |
| `net.js` | SSE, `publish()`, `ROUNDS`, y el reductor `applyEvent`/`foldEvents`. |
| `ui.js` | Render, formularios, modal de ejecución, controles de facilitador. |

Detalles con consecuencias:
- **`pid` es el `hash160` de la llave pública** — la identidad *es* la dirección, no hay id aparte.
- **Dos simplificaciones son deliberadas, no deudas técnicas**: no se deriva llave maestra BIP32 (la privada
  son los primeros 32 bytes de la seed BIP39) y el `hash160` se muestra en crudo, sin Base58Check, sin byte de
  versión de red y sin checksum. Están documentadas en la cabecera de `keys.js` y en el README; si "arreglas"
  cualquiera de las dos, cambias lo que la demo enseña y rompes todas las firmas del log.
- **El mensaje firmado es determinista**: `CL.lockMessage(lock)` = `candado:<id>|para:<toPkh>|<label>`.
  Todos lo recalculan; si cambias el formato, invalidas todas las firmas del log.
- La llave privada nunca sale del dispositivo. El mnemónico vive en `localStorage`
  (`candado-lan/mnemonic`); solo se publican pubkey, firma y hash.
- El feed **no debe filtrar el `label`** de un candado (un candado se nombra por la llave que lo abre, no por
  lo que guarda). `testNaming` en `smoke.mjs` es la regresión que lo protege.

`public/guia.html` es la guía original de una sola página, independiente del servidor y del namespace `CL`;
comparte solo `public/vendor/`.
