/* Máquina de Script P2PKH.
   Dos modos sobre el mismo motor: paso a paso (para proyectar) y silencioso
   (para que cada navegador valide por su cuenta lo que hacen los demás). */
(function (global) {
  'use strict';

  const CL = (global.CL = global.CL || {});

  /** El candado: OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG */
  CL.lockScriptHtml = (pkh) =>
    '<span class="op">OP_DUP</span> <span class="op">OP_HASH160</span> ' +
    `<span class="data">&lt;${CL.short(pkh)}&gt;</span> ` +
    '<span class="op">OP_EQUALVERIFY</span> <span class="op">OP_CHECKSIG</span>';

  /** La llave: <sig> <pubkey> */
  CL.unlockScriptHtml = (sigDer, pubHex) =>
    `<span class="data">&lt;sig: ${CL.short(sigDer)}&gt;</span> ` +
    `<span class="data">&lt;pubkey: ${CL.short(pubHex)}&gt;</span>`;

  /**
   * Construye la cinta de opcodes para un intento concreto.
   * @param {{sigDer:string, pubHex:string, pkh:string, msgHash:string}} attempt
   *        pkh es el del candado (a quién iba dirigido), no el de quien intenta.
   */
  CL.buildOps = function (attempt) {
    const { sigDer, pubHex, pkh, msgHash } = attempt;
    const attemptPkh = CL.hash160(pubHex);

    return [
      {
        name: 'PUSH <sig>',
        desc: 'Se apila la firma',
        run: (stack) => { stack.push({ label: 'sig:' + CL.short(sigDer, 6) }); },
      },
      {
        name: 'PUSH <pubkey>',
        desc: 'Se apila la llave pública',
        run: (stack) => { stack.push({ label: 'pub:' + CL.short(pubHex, 6) }); },
      },
      {
        name: 'OP_DUP',
        desc: 'Duplica el tope (la pubkey)',
        run: (stack) => { stack.push({ ...stack[stack.length - 1] }); },
      },
      {
        name: 'OP_HASH160',
        desc: 'RIPEMD160(SHA256(pubkey))',
        run: (stack) => {
          stack.pop();
          stack.push({ label: 'hash160(pub):' + CL.short(attemptPkh, 6) });
        },
      },
      {
        name: 'PUSH <pubKeyHash>',
        desc: 'El hash grabado en el candado',
        run: (stack) => { stack.push({ label: 'candado:' + CL.short(pkh, 6) }); },
      },
      {
        name: 'OP_EQUALVERIFY',
        desc: '¿Es la llave del destinatario?',
        run: (stack) => {
          stack.pop();
          stack.pop();
          if (attemptPkh !== pkh) {
            stack.push({ label: 'los hashes NO coinciden', bad: true });
            return { failed: true, reason: 'wrong-key' };
          }
        },
      },
      {
        name: 'OP_CHECKSIG',
        desc: 'Verifica la firma contra la pubkey',
        run: (stack) => {
          stack.pop(); // pubkey
          stack.pop(); // sig
          const ok = CL.verifySignature(pubHex, msgHash, sigDer);
          stack.push({ label: ok ? 'TRUE' : 'FALSE', good: ok, bad: !ok });
          return ok ? undefined : { failed: true, reason: 'bad-sig' };
        },
      },
    ];
  };

  /**
   * Ejecuta la cinta entera sin animación. Es lo que corre cada navegador para
   * decidir por sí mismo si un candado quedó abierto — nadie confía en un "ok" ajeno.
   * @returns {{ok:boolean, reason:string|null, failedAt:number}}
   */
  CL.runScript = function (attempt) {
    const ops = CL.buildOps(attempt);
    const stack = [];
    for (let i = 0; i < ops.length; i++) {
      const verdict = ops[i].run(stack);
      if (verdict && verdict.failed) return { ok: false, reason: verdict.reason, failedAt: i };
    }
    const top = stack[stack.length - 1];
    const ok = !!(top && top.label === 'TRUE');
    return { ok, reason: ok ? null : 'bad-sig', failedAt: ops.length - 1 };
  };

  CL.reasonText = function (reason) {
    switch (reason) {
      case 'wrong-key':
        return 'Falla en OP_EQUALVERIFY: esa llave no corresponde al hash del candado.';
      case 'bad-sig':
        return 'Falla en OP_CHECKSIG: la firma no valida contra esa llave pública.';
      case 'already-open':
        return 'El candado ya estaba abierto: llegaste tarde.';
      default:
        return 'Script inválido.';
    }
  };

  /**
   * Ejecutor paso a paso para el modal. Mantiene su propia pila y avanza de uno en uno.
   */
  CL.createRunner = function (attempt) {
    const ops = CL.buildOps(attempt);
    let index = 0;
    let stack = [];
    let finished = false;
    let result = null;

    return {
      ops,
      get index() { return index; },
      get stack() { return stack; },
      get finished() { return finished; },
      get result() { return result; },
      reset() { index = 0; stack = []; finished = false; result = null; },
      step() {
        if (finished) return result;
        const verdict = ops[index].run(stack);
        index += 1;
        if (verdict && verdict.failed) {
          finished = true;
          result = { ok: false, reason: verdict.reason };
        } else if (index >= ops.length) {
          finished = true;
          const top = stack[stack.length - 1];
          const ok = !!(top && top.label === 'TRUE');
          result = { ok, reason: ok ? null : 'bad-sig' };
        }
        return result;
      },
    };
  };
})(window);
