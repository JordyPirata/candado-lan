/* Transporte (SSE + POST) y reducción del log de eventos a estado.
   El estado es un fold puro sobre eventos ordenados por seq: todos los
   navegadores parten del mismo log y llegan al mismo tablero. */
(function (global) {
  'use strict';

  const CL = (global.CL = global.CL || {});

  CL.ROUNDS = [
    { kind: 'espera',      title: 'Sala abierta',      hint: 'Ponte un nombre y comparte tu llave pública. Aún no hay ronda activa.' },
    { kind: 'presentarse', title: '1 · Preséntate',    hint: 'Todos deben aparecer en la lista de participantes con su hash160. Esa es tu "dirección".' },
    { kind: 'bloquear',    title: '2 · Crea un candado', hint: 'Elige a otra persona y créale un candado. Estás grabando SU hash160 en el script.' },
    { kind: 'abrir',       title: '3 · Ábrelo',        hint: 'Abre los candados dirigidos a ti firmando con tu llave privada.' },
    { kind: 'robar',       title: '4 · Intenta robar', hint: 'Intenta abrir un candado ajeno. Mira dónde falla el script.' },
    { kind: 'libre',       title: '5 · Tablero libre', hint: 'Experimenta: candados, firmas corruptas, robos. Todo se verifica en tu propio navegador.' },
  ];

  CL.newId = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** El mensaje que se firma. Determinista a partir del candado: todos calculan el mismo hash. */
  CL.lockMessage = (lock) => `candado:${lock.id}|para:${lock.toPkh}|${lock.label}`;

  CL.emptyState = () => ({
    players: new Map(),   // pid -> {pid, nick, pubHex, pkh}
    locks: new Map(),     // id  -> {..., openedBy, attempts:[]}
    feed: [],             // más reciente primero
    scores: new Map(),    // pid -> puntos
    round: CL.ROUNDS[0],
    lastSeq: 0,
  });

  function addScore(state, pid, points) {
    if (!pid) return;
    state.scores.set(pid, (state.scores.get(pid) || 0) + points);
  }

  function pushFeed(state, entry) {
    state.feed.unshift(entry);
    if (state.feed.length > 60) state.feed.pop();
  }

  /** Aplica un evento al estado. Aquí es donde este navegador verifica la criptografía. */
  CL.applyEvent = function (state, ev) {
    state.lastSeq = Math.max(state.lastSeq, ev.seq || 0);

    if (ev.type === 'join') {
      const known = state.players.get(ev.pid);
      state.players.set(ev.pid, { pid: ev.pid, nick: ev.nick, pubHex: ev.pubHex, pkh: ev.pkh });
      if (!known) {
        pushFeed(state, { seq: ev.seq, at: ev.at, kind: 'join', text: `${ev.nick} entró a la sala` });
      }
      return;
    }

    if (ev.type === 'lock') {
      const lock = {
        id: ev.id,
        fromPid: ev.fromPid,
        fromNick: ev.fromNick,
        toPkh: ev.toPkh,
        toNick: ev.toNick,
        label: ev.label,
        at: ev.at,
        openedBy: null,
        openedNick: null,
        attempts: [],
      };
      lock.msg = CL.lockMessage(lock);
      lock.msgHash = CL.sha256utf8(lock.msg);
      state.locks.set(lock.id, lock);
      pushFeed(state, {
        seq: ev.seq, at: ev.at, kind: 'lock',
        text: `${ev.fromNick} bloqueó un candado con la llave pública de ${ev.toNick}`,
      });
      return;
    }

    if (ev.type === 'spend') {
      const lock = state.locks.get(ev.lockId);
      if (!lock) return;

      let verdict;
      if (lock.openedBy) {
        verdict = { ok: false, reason: 'already-open' };
      } else {
        // Verificación local e independiente: ni el servidor ni el emisor deciden esto.
        verdict = CL.runScript({
          sigDer: ev.sigDer,
          pubHex: ev.pubHex,
          pkh: lock.toPkh,
          msgHash: lock.msgHash,
        });
      }

      const attempt = {
        id: ev.id,
        seq: ev.seq,
        at: ev.at,
        byPid: ev.byPid,
        byNick: ev.byNick,
        sigDer: ev.sigDer,
        pubHex: ev.pubHex,
        ok: verdict.ok,
        reason: verdict.reason,
      };
      lock.attempts.push(attempt);

      if (verdict.ok) {
        lock.openedBy = ev.byPid;
        lock.openedNick = ev.byNick;
        addScore(state, ev.byPid, 10);
        addScore(state, lock.fromPid, 5);
        pushFeed(state, {
          seq: ev.seq, at: ev.at, kind: 'open', ok: true,
          text: `${ev.byNick} abrió su candado ✔`,
        });
      } else {
        pushFeed(state, {
          seq: ev.seq, at: ev.at, kind: 'fail', ok: false,
          text: `${ev.byNick} falló al abrir el candado de ${lock.toNick} — ${CL.reasonText(verdict.reason)}`,
        });
      }
      return;
    }

    if (ev.type === 'round') {
      const round = CL.ROUNDS.find((r) => r.kind === ev.kind) || CL.ROUNDS[0];
      state.round = round;
      pushFeed(state, { seq: ev.seq, at: ev.at, kind: 'round', text: `Ronda: ${round.title}` });
    }
  };

  CL.foldEvents = function (events) {
    const state = CL.emptyState();
    for (const ev of events) CL.applyEvent(state, ev);
    return state;
  };

  /**
   * Conexión a la sala. `onState` se llama tras cada cambio; `onStatus` con
   * 'conectando' | 'en línea' | 'sin conexión'.
   */
  CL.connect = function ({ room, onState, onStatus }) {
    let state = CL.emptyState();
    let source = null;

    function open() {
      onStatus && onStatus('conectando');
      source = new EventSource(`/events?room=${encodeURIComponent(room)}`);

      source.onopen = () => onStatus && onStatus('en línea');

      source.onmessage = (msg) => {
        let payload;
        try { payload = JSON.parse(msg.data); } catch { return; }

        if (payload.type === 'replay') {
          state = CL.foldEvents(payload.events || []);
        } else if (payload.type === 'event') {
          if (payload.event.seq <= state.lastSeq) return; // duplicado tras reconectar
          CL.applyEvent(state, payload.event);
        }
        onState && onState(state);
      };

      // EventSource reconecta solo; solo hay que reflejarlo en la UI.
      source.onerror = () => onStatus && onStatus('sin conexión');
    }

    open();

    return {
      get state() { return state; },
      close() { source && source.close(); },
      async publish(event, adminToken) {
        const res = await fetch('/pub', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room, event, adminToken }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Error ${res.status}`);
        }
        return res.json();
      },
    };
  };
})(window);
