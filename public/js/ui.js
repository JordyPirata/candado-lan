/* Interfaz de la sala: render, formularios y el modal de ejecución del script. */
(function (global) {
  'use strict';

  const CL = global.CL;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NICK_KEY = 'candado-lan/nick';

  const app = {
    identity: null,
    nick: '',
    room: '',
    adminToken: null,
    conn: null,
    state: CL.emptyState(),
    runner: null,
    pendingLockTarget: null,
    lockFilter: 'todos',
    rejoinAt: 0,
  };

  const ui = (CL.ui = {});

  // ---------------------------------------------------------------- utilidades

  function toast(msg, bad) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 2800);
  }

  ui.openOverlay = (id) => $(id).classList.add('show');
  ui.closeOverlay = (id) => $(id).classList.remove('show');

  const hhmm = (ts) => new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /** Color estable derivado del hash160: cada persona tiene su tono. */
  function avatarFor(pkh, nick) {
    const hue = parseInt((pkh || '0').slice(0, 4), 16) % 360;
    const letter = esc((nick || '?').trim().charAt(0).toUpperCase() || '?');
    return `<div class="avatar" style="background:hsl(${hue} 55% 62%)">${letter}</div>`;
  }

  const isMine = (lock) => app.identity && lock.toPkh === app.identity.pkh;

  // ---------------------------------------------------------------- identidad

  function loadIdentity() {
    const stored = CL.loadStoredMnemonic();
    const mnemonic = stored || CL.randomMnemonic();
    if (!stored) CL.storeMnemonic(mnemonic);
    app.identity = CL.identityFromMnemonic(mnemonic);
  }

  function renderIdentity() {
    const id = app.identity;
    $('identityBox').innerHTML =
      `<div class="k">nombre</div><div class="v">${esc(app.nick)}</div>` +
      `<div class="k">pública</div><div class="v pub">${esc(id.pubHex)}</div>` +
      `<div class="k">hash160</div><div class="v">${esc(id.pkh)}</div>`;
    $('identitySecret').innerHTML =
      `<div class="k">frase</div><div class="v seed">${esc(id.mnemonic)}</div>` +
      `<div class="k">seed</div><div class="v seed">${esc(id.seedHex)}</div>` +
      `<div class="k">privada</div><div class="v priv">${esc(id.privHex)}</div>`;
    $('chipYou').hidden = false;
    $('chipYou').textContent = `${app.nick} · ${CL.short(id.pkh, 6)}`;
  }

  // ---------------------------------------------------------------- render

  function render() {
    const state = app.state;
    renderRound(state);
    renderPlayers(state);
    renderLocks(state);
    renderScores(state);
    renderFeed(state);
  }

  function renderRound(state) {
    const r = state.round;
    $('roundKicker').textContent = r.kind === 'espera' ? 'Sala' : 'Ronda en curso';
    $('roundTitle').textContent = r.title;
    $('roundHint').textContent = r.hint;
  }

  function renderPlayers(state) {
    const todos = [...state.players.values()];
    $('playerCount').textContent = todos.length;
    const box = $('players');
    if (todos.length === 0) {
      box.innerHTML = '<div class="empty">Nadie se ha presentado todavía.</div>';
      return;
    }

    // Con la sala llena, buscar a alguien a ojo es inviable: aparece el buscador.
    const buscador = $('playerFilter');
    buscador.hidden = todos.length <= 8;
    const q = buscador.hidden ? '' : buscador.value.trim().toLowerCase();
    const players = q
      ? todos.filter((p) => p.nick.toLowerCase().includes(q) || p.pkh.includes(q))
      : todos;

    if (players.length === 0) {
      box.innerHTML = `<div class="empty">Nadie coincide con “${esc(q)}”.</div>`;
      return;
    }

    box.innerHTML = players.map((p) => {
      const you = app.identity && p.pkh === app.identity.pkh;
      return `<div class="player">
        ${avatarFor(p.pkh, p.nick)}
        <div class="who">
          <div class="nick">${esc(p.nick)}${you ? ' <span class="tag muted">tú</span>' : ''}</div>
          <div class="pkh">${esc(CL.short(p.pkh, 10))}</div>
        </div>
        ${you ? '' : `<button class="tiny secondary" data-lock-to="${esc(p.pkh)}">Crear candado</button>`}
      </div>`;
    }).join('');
  }

  /* Con muchos candados en la sala, lo que te toca a ti tiene que salir arriba:
     primero los cerrados dirigidos a ti, luego el resto de cerrados, al final los abiertos. */
  function lockRank(lock) {
    if (lock.openedBy) return 2;
    return isMine(lock) ? 0 : 1;
  }

  const LOCK_FILTERS = [
    { id: 'todos',  label: 'Todos',    test: () => true },
    { id: 'parami', label: 'Para mí',  test: (l) => isMine(l) && !l.openedBy },
    { id: 'mios',   label: 'Los creé', test: (l) => app.identity && l.fromPid === app.identity.pkh },
    { id: 'abiertos', label: 'Abiertos', test: (l) => !!l.openedBy },
  ];

  function renderLocks(state) {
    const todos = [...state.locks.values()]
      .sort((a, b) => lockRank(a) - lockRank(b) || b.at - a.at);
    $('lockCount').textContent = todos.length;
    const box = $('locks');

    // Los filtros solo estorban con pocos candados.
    const barra = $('lockFilters');
    barra.hidden = todos.length <= 4;
    if (!barra.hidden) {
      barra.innerHTML = LOCK_FILTERS.map((f) => {
        const n = todos.filter(f.test).length;
        const on = app.lockFilter === f.id ? ' on' : '';
        return `<button class="filter-chip${on}" data-filter="${f.id}">${f.label} <b>${n}</b></button>`;
      }).join('');
    }

    if (todos.length === 0) {
      box.innerHTML = '<div class="empty">Aún no hay candados. Crea uno desde la lista de participantes.</div>';
      return;
    }

    const filtro = LOCK_FILTERS.find((f) => f.id === app.lockFilter) || LOCK_FILTERS[0];
    const locks = barra.hidden ? todos : todos.filter(filtro.test);
    if (locks.length === 0) {
      box.innerHTML = `<div class="empty">Ningún candado en “${esc(filtro.label)}”.</div>`;
      return;
    }

    box.innerHTML = locks.map((lock) => {
      const mine = isMine(lock);
      const creador = app.identity && lock.fromPid === app.identity.pkh;
      const open = !!lock.openedBy;
      const cls = 'lock-card' + (open ? ' open' : mine ? ' mine' : '');

      const status = open
        ? `<span class="tag unlock">abierto por ${esc(lock.openedNick)}</span>`
        : mine
          ? '<span class="tag lock">es para ti</span>'
          : '<span class="tag muted">cerrado</span>';

      const actions = open ? '' : `<div class="lock-actions">
          ${mine
            ? `<button class="tiny" data-open="${lock.id}">Abrir con mi llave</button>
               <button class="tiny secondary" data-open="${lock.id}" data-tamper="1">Abrir con firma corrupta</button>`
            : `<button class="tiny secondary" data-open="${lock.id}">Intentar robar</button>`}
        </div>`;

      const attempts = lock.attempts.length ? `<div class="attempts">${lock.attempts.map((a) =>
        `<div class="attempt ${a.ok ? 'ok' : 'bad'}" data-attempt="${lock.id}:${a.id}">
           <span class="mark">${a.ok ? '✔' : '✘'}</span>
           <span>${esc(a.byNick)} ${a.ok ? 'abrió' : 'falló'} · ver ejecución</span>
         </div>`).join('')}</div>` : '';

      return `<div class="${cls}">
        <div class="lock-top">
          <svg class="lock-svg ${open ? 'open' : ''}" viewBox="0 0 56 56">
            <path class="shackle shackle-path" d="M16 24 V17 a12 12 0 0 1 24 0 v7"/>
            <rect class="lock-body" x="12" y="24" width="32" height="24" rx="4"/>
          </svg>
          <div class="lock-title">Candado bloqueado con la llave pública de ${esc(lock.toNick)}</div>
          ${status}
        </div>
        ${lock.label ? `<div class="lock-note">nota: ${esc(lock.label)}</div>` : ''}
        <div class="lock-meta">creado por ${esc(lock.fromNick)} · ${hhmm(lock.at)}
          ${creador && !mine ? '<br><b>Lo creaste tú, y ni aun así puedes abrirlo:</b> el candado guarda el hash de otra llave.' : ''}
        </div>
        <div class="script-line">${CL.lockScriptHtml(lock.toPkh)}</div>
        ${actions}
        ${attempts}
      </div>`;
    }).join('');
  }

  const TOP = 10;

  function renderScores(state) {
    const rows = [...state.players.values()]
      .map((p) => ({ ...p, pts: state.scores.get(p.pid) || 0 }))
      .sort((a, b) => b.pts - a.pts || a.nick.localeCompare(b.nick));
    const box = $('scores');
    if (rows.length === 0 || rows.every((r) => r.pts === 0)) {
      box.innerHTML = '<div class="empty">Sin puntos todavía.</div>';
      return;
    }

    // En una sala llena solo cabe el podio, pero tu fila nunca desaparece.
    const visibles = rows.slice(0, TOP);
    const miPuesto = app.identity ? rows.findIndex((r) => r.pkh === app.identity.pkh) : -1;
    if (miPuesto >= TOP) visibles.push(rows[miPuesto]);

    box.innerHTML = visibles.map((p, i) => {
      const puesto = p.pkh === (app.identity && app.identity.pkh) && miPuesto >= TOP ? miPuesto : i;
      const yo = app.identity && p.pkh === app.identity.pkh;
      return `<div class="player">
        <span class="rank">${puesto + 1}</span>
        ${avatarFor(p.pkh, p.nick)}
        <div class="who"><div class="nick">${esc(p.nick)}${yo ? ' <span class="tag muted">tú</span>' : ''}</div></div>
        <div class="pts">${p.pts} pts</div>
      </div>`;
    }).join('') + (rows.length > TOP ? `<div class="empty">y ${rows.length - TOP} más</div>` : '');
  }

  function renderFeed(state) {
    const box = $('feed');
    if (state.feed.length === 0) {
      box.innerHTML = '<div class="empty">Silencio absoluto.</div>';
      return;
    }
    box.innerHTML = state.feed.map((f) =>
      `<div class="feed-item ${esc(f.kind)}"><span class="t">${hhmm(f.at)}</span><span>${esc(f.text)}</span></div>`
    ).join('');
  }

  // ---------------------------------------------------------------- acciones

  async function publishJoin() {
    await app.conn.publish({
      type: 'join',
      pid: app.identity.pkh,     // la identidad ES el hash de la llave
      nick: app.nick,
      pubHex: app.identity.pubHex,
      pkh: app.identity.pkh,
    });
  }

  function openLockForm(toPkh) {
    const target = app.state.players.get(toPkh);
    if (!target) return;
    app.pendingLockTarget = target;
    $('lockTargetHint').innerHTML =
      `El candado quedará dirigido a <b>${esc(target.nick)}</b>. Su <span class="mono">hash160</span> ` +
      `queda grabado dentro: solo su llave privada podrá abrirlo.`;
    $('lockPreview').innerHTML = CL.lockScriptHtml(target.pkh);
    $('lockLabel').value = '';
    ui.openOverlay('lockOverlay');
    setTimeout(() => $('lockLabel').focus(), 50);
  }

  async function createLock() {
    const target = app.pendingLockTarget;
    if (!target) return;
    const label = $('lockLabel').value.trim();
    try {
      await app.conn.publish({
        type: 'lock',
        id: CL.newId(),
        fromPid: app.identity.pkh,
        fromNick: app.nick,
        toPkh: target.pkh,
        toNick: target.nick,
        label,
      });
      ui.closeOverlay('lockOverlay');
      toast('Candado cerrado y publicado');
    } catch (err) {
      toast(err.message, true);
    }
  }

  /** Firma el mensaje del candado, publica el intento y muestra la ejecución. */
  async function attemptOpen(lockId, tamper) {
    const lock = app.state.locks.get(lockId);
    if (!lock) return;

    const { msgHash, sigDer } = CL.signMessage(app.identity, lock.msg);
    const sent = tamper ? CL.tamperSignature(sigDer) : sigDer;

    try {
      await app.conn.publish({
        type: 'spend',
        id: CL.newId(),
        lockId: lock.id,
        byPid: app.identity.pkh,
        byNick: app.nick,
        sigDer: sent,
        pubHex: app.identity.pubHex,
      });
    } catch (err) {
      toast(err.message, true);
      return;
    }

    showRun({
      lock,
      sigDer: sent,
      pubHex: app.identity.pubHex,
      msgHash,
      byNick: app.nick,
      subtitle: tamper
        ? 'Enviaste una firma alterada a propósito. Veamos dónde lo nota el script.'
        : isMine(lock)
          ? 'Firmaste con tu llave privada. Ejecutemos el script.'
          : 'Estás intentando abrir un candado que no es tuyo.',
    });
  }

  function replayAttempt(lockId, attemptId) {
    const lock = app.state.locks.get(lockId);
    if (!lock) return;
    const attempt = lock.attempts.find((a) => a.id === attemptId);
    if (!attempt) return;
    showRun({
      lock,
      sigDer: attempt.sigDer,
      pubHex: attempt.pubHex,
      msgHash: lock.msgHash,
      byNick: attempt.byNick,
      subtitle: `Intento de ${attempt.byNick}, verificado en tu propio navegador.`,
    });
  }

  // ---------------------------------------------------------------- modal de ejecución

  function showRun({ lock, sigDer, pubHex, msgHash, byNick, subtitle }) {
    app.runner = CL.createRunner({ sigDer, pubHex, pkh: lock.toPkh, msgHash });
    $('runTitle').textContent = `Candado de ${lock.toNick}`;
    $('runSubtitle').textContent = subtitle || `Intento de ${byNick}`;
    $('runLockScript').innerHTML = CL.lockScriptHtml(lock.toPkh);
    $('runUnlockScript').innerHTML = CL.unlockScriptHtml(sigDer, pubHex);
    $('runResult').className = 'result';
    $('btnStep').disabled = false;
    $('btnRunAll').disabled = false;
    setLockIcon('locked');
    renderRunner();
    ui.openOverlay('runOverlay');
  }

  function setLockIcon(state) {
    const el = $('runLockIcon');
    el.classList.remove('open', 'failed');
    if (state !== 'locked') el.classList.add(state);
  }

  function renderRunner() {
    const r = app.runner;
    $('runTape').innerHTML = r.ops.map((op, i) => {
      const cls = i === r.index && !r.finished ? ' current' : i < r.index ? ' done' : '';
      return `<div class="op-row${cls}"><span class="name">${esc(op.name)}</span>
        <span class="desc">${esc(op.desc)}</span></div>`;
    }).join('');

    $('runStack').innerHTML = r.stack.map((item, i) => {
      const tone = item.good ? 'good' : item.bad ? 'bad' : '';
      const fresh = i === r.stack.length - 1 ? ' fresh' : '';
      return `<div class="stack-item ${tone}${fresh}">${esc(item.label)}</div>`;
    }).join('');

    if (r.finished) {
      const res = $('runResult');
      res.className = 'result show ' + (r.result.ok ? 'ok' : 'fail');
      res.textContent = r.result.ok
        ? '✔ Script válido — el candado se abre. La firma corresponde a la llave cuyo hash estaba grabado dentro.'
        : '✘ ' + CL.reasonText(r.result.reason);
      setLockIcon(r.result.ok ? 'open' : 'failed');
      $('btnStep').disabled = true;
      $('btnRunAll').disabled = true;
    }
  }

  function stepRunner() {
    if (!app.runner || app.runner.finished) return;
    app.runner.step();
    renderRunner();
  }

  // ---------------------------------------------------------------- compartir / QR

  function showShare() {
    const url = `${location.protocol}//${location.host}/?room=${encodeURIComponent(app.room)}`;
    $('shareUrl').textContent = url;
    $('shareRoom').textContent = app.room;

    const box = $('qrBox');
    try {
      const qr = global.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createSvgTag ? qr.createSvgTag({ cellSize: 6, margin: 2 }) : qr.createImgTag(6, 12);
    } catch {
      box.innerHTML = ''; // sin QR: la URL grande basta para proyectar
    }
    ui.openOverlay('shareOverlay');
  }

  // ---------------------------------------------------------------- facilitador

  function renderAdminControls() {
    if (!app.adminToken) return;
    const box = $('roundControls');
    box.hidden = false;
    box.innerHTML = CL.ROUNDS.map((r) =>
      `<button class="tiny secondary" data-round="${r.kind}">${esc(r.title)}</button>`
    ).join('') + '<button class="tiny danger" data-reset="1">Reiniciar sala</button>';
  }

  async function setRound(kind) {
    try {
      await app.conn.publish({ type: 'round', kind }, app.adminToken);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function resetRoom() {
    if (!confirm('¿Borrar todos los candados y puntajes de la sala?')) return;
    try {
      await app.conn.publish({ type: 'reset' }, app.adminToken);
      await publishJoin();
      toast('Sala reiniciada');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- autodiagnóstico

  function runSelfTest() {
    const { checks, ok } = CL.selfTest();
    $('selfTestOut').innerHTML = checks.map((c) =>
      `<div class="test-row ${c.ok ? 'ok' : 'bad'}"><span>${c.ok ? 'PASS' : 'FALLA'}</span><span>${esc(c.name)}</span></div>`
    ).join('') + `<div class="test-row ${ok ? 'ok' : 'bad'}" style="margin-top:6px">
        <span>${ok ? '✔' : '✘'}</span><span>${ok ? 'Este dispositivo hace la criptografía correctamente.' : 'Algo no cuadra en este dispositivo.'}</span></div>`;
  }

  // ---------------------------------------------------------------- arranque

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-lock-to],[data-open],[data-attempt],[data-round],[data-reset],[data-filter]');
      if (!t) return;
      if (t.dataset.filter) {
        app.lockFilter = t.dataset.filter;
        return render();
      }
      if (t.dataset.lockTo) return openLockForm(t.dataset.lockTo);
      if (t.dataset.open) return void attemptOpen(t.dataset.open, t.dataset.tamper === '1');
      if (t.dataset.attempt) {
        const [lockId, attemptId] = t.dataset.attempt.split(':');
        return replayAttempt(lockId, attemptId);
      }
      if (t.dataset.round) return void setRound(t.dataset.round);
      if (t.dataset.reset) return void resetRoom();
    });

    $('btnCreateLock').onclick = () => void createLock();
    $('btnShare').onclick = showShare;
    $('btnStep').onclick = stepRunner;
    $('btnRunAll').onclick = () => {
      while (app.runner && !app.runner.finished) app.runner.step();
      renderRunner();
    };
    $('btnRunReset').onclick = () => {
      if (!app.runner) return;
      app.runner.reset();
      $('runResult').className = 'result';
      $('btnStep').disabled = false;
      $('btnRunAll').disabled = false;
      setLockIcon('locked');
      renderRunner();
    };
    $('btnSelfTest').onclick = runSelfTest;
    $('playerFilter').addEventListener('input', () => renderPlayers(app.state));

    $('btnRegen').onclick = () => {
      if (!confirm('Se generará una identidad nueva. Perderás los candados dirigidos a la actual.')) return;
      CL.storeMnemonic(CL.randomMnemonic());
      location.reload();
    };
    $('btnRestore').onclick = () => {
      const phrase = prompt('Pega tu frase BIP39 (12 o 24 palabras):');
      if (!phrase) return;
      if (!CL.validateMnemonic(phrase)) return toast('Checksum BIP39 inválido', true);
      CL.storeMnemonic(CL.normalize(phrase));
      location.reload();
    };

    // Cerrar overlays haciendo clic fuera del modal.
    document.querySelectorAll('.overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov && ov.id !== 'joinOverlay') ov.classList.remove('show');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.overlay.show').forEach((ov) => {
          if (ov.id !== 'joinOverlay') ov.classList.remove('show');
        });
      }
    });
  }

  function start() {
    renderIdentity();
    renderAdminControls();

    app.conn = CL.connect({
      room: app.room,
      onState: (state) => {
        app.state = state;
        render();
        // Si el servidor se reinició, el log se vació: volvemos a presentarnos.
        if (!state.players.has(app.identity.pkh) && Date.now() - app.rejoinAt > 3000) {
          app.rejoinAt = Date.now();
          publishJoin().catch(() => {});
        }
      },
      onStatus: (status) => {
        const chip = $('chipStatus');
        chip.textContent = status;
        chip.className = 'chip ' + (status === 'en línea' ? 'live' : status === 'sin conexión' ? 'offline' : '');
      },
    });

    publishJoin().catch((err) => toast(err.message, true));
    $('chipRoom').textContent = 'sala ' + app.room;
  }

  async function boot() {
    bindEvents();
    loadIdentity();

    const params = new URLSearchParams(location.search);
    app.adminToken = params.get('admin');

    let defaultRoom = 'SATOSHI';
    try {
      const cfg = await fetch('/config').then((r) => r.json());
      defaultRoom = cfg.defaultRoom || defaultRoom;
    } catch { /* sin /config seguimos con el valor por defecto */ }

    app.room = (params.get('room') || defaultRoom).toUpperCase();
    app.nick = (global.localStorage.getItem(NICK_KEY) || '').trim();

    if (app.nick) return start();

    $('joinRoom').value = app.room;
    $('joinNick').value = '';
    ui.openOverlay('joinOverlay');
    setTimeout(() => $('joinNick').focus(), 60);

    const submit = () => {
      const nick = $('joinNick').value.trim();
      if (!nick) {
        $('joinError').style.display = 'block';
        $('joinError').textContent = 'Escribe un nombre para que te reconozcan.';
        return;
      }
      app.nick = nick.slice(0, 18);
      app.room = ($('joinRoom').value.trim() || defaultRoom).toUpperCase();
      global.localStorage.setItem(NICK_KEY, app.nick);
      ui.closeOverlay('joinOverlay');
      start();
    };
    $('btnJoin').onclick = submit;
    $('joinNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    $('joinRoom').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  boot();
})(window);
