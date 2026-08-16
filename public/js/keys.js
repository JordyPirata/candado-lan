/* Identidad: frase BIP39 -> par de llaves secp256k1 -> hash160 (la "dirección").
   Misma lógica que la guía: sin BIP32, una sola llave, para que el mecanismo se vea.

   Dos simplificaciones deliberadas, que conviene decir en voz alta durante la charla:

   1. La seed BIP39 nunca se usa como llave maestra. Aquí la privada son los primeros
      32 bytes de la seed leídos como escalar. Una wallet real hace
      HMAC-SHA512("Bitcoin seed", seed) para sacar llave maestra + chain code y deriva
      una llave por ruta (m/44'/0'/0'/0/0). Consecuencias: una sola llave por persona
      durante toda la sesión (sin rotación de direcciones, o sea sin la privacidad que
      da BIP32), sin xpub ni watch-only, y un mnemónico de esta demo NO sirve como
      respaldo: restaurarlo en una wallet real da llaves completamente distintas.

   2. El hash160 se muestra en crudo: no es una dirección. Una dirección P2PKH real es
      Base58Check sobre ese mismo hash — byte de versión (0x00 mainnet, 0x6F testnet) +
      4 bytes de SHA256d como checksum + Base58 -> 1A1zP1… Aquí no hay versión (nada ata
      la identidad a una red), ni checksum (un identificador mal copiado no se detecta;
      nos libramos porque nadie los teclea, se eligen de una lista), ni alfabeto Base58.
      A cambio se ve el hash tal y como lo compara OP_EQUALVERIFY, que es justo el punto:
      la dirección es envoltorio alrededor de este número. */
(function (global) {
  'use strict';

  const CL = (global.CL = global.CL || {});
  const ec = new global.elliptic.ec('secp256k1');
  const CJS = global.CryptoJS;
  const STORAGE_KEY = 'candado-lan/mnemonic';

  CL.ec = ec;

  CL.sha256hex = (hex) => CJS.SHA256(CJS.enc.Hex.parse(hex)).toString();
  CL.sha256utf8 = (str) => CJS.SHA256(CJS.enc.Utf8.parse(str)).toString();
  CL.ripemd160hex = (hex) => CJS.RIPEMD160(CJS.enc.Hex.parse(hex)).toString();
  CL.hash160 = (hex) => CL.ripemd160hex(CL.sha256hex(hex));

  /** Acorta un hex largo para que quepa en pantalla sin perder identificabilidad. */
  CL.short = (hex, n = 8) =>
    typeof hex === 'string' && hex.length > 2 * n ? hex.slice(0, n) + '…' + hex.slice(-n) : hex || '';

  CL.validateMnemonic = (phrase) => global.bip39lib.validateMnemonic(CL.normalize(phrase));
  CL.normalize = (phrase) => String(phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
  CL.randomMnemonic = () => global.bip39lib.generateMnemonic();

  /**
   * Deriva la identidad completa a partir de un mnemónico BIP39 válido.
   * La llave privada son los primeros 32 bytes de la seed PBKDF2 — a propósito
   * nos saltamos BIP32 para que haya un solo candado que seguir.
   */
  CL.identityFromMnemonic = function (phrase) {
    const mnemonic = CL.normalize(phrase);
    if (!global.bip39lib.validateMnemonic(mnemonic)) {
      throw new Error('El checksum BIP39 no es válido');
    }
    const entropyHex = global.bip39lib.mnemonicToEntropy(mnemonic);
    const seedHex = global.bip39lib.mnemonicToSeedSync(mnemonic).toString('hex');
    const privHex = seedHex.slice(0, 64);
    const key = ec.keyFromPrivate(privHex, 'hex');
    const pubHex = key.getPublic(true, 'hex');
    return { mnemonic, entropyHex, seedHex, privHex, pubHex, pkh: CL.hash160(pubHex), key };
  };

  CL.loadStoredMnemonic = function () {
    try {
      const stored = global.localStorage.getItem(STORAGE_KEY);
      return stored && CL.validateMnemonic(stored) ? stored : null;
    } catch { return null; }
  };

  CL.storeMnemonic = function (mnemonic) {
    try { global.localStorage.setItem(STORAGE_KEY, mnemonic); } catch { /* modo privado: da igual */ }
  };

  /** Firma un texto: sha256(utf8) y ECDSA canónica, devuelta en DER hex. */
  CL.signMessage = function (identity, message) {
    const msgHash = CL.sha256utf8(message);
    const sigDer = identity.key.sign(msgHash, { canonical: true }).toDER('hex');
    return { msgHash, sigDer };
  };

  /** Rompe una firma a propósito, para demostrar que OP_CHECKSIG lo detecta. */
  CL.tamperSignature = function (sigDer) {
    const tail = sigDer.slice(-4);
    return sigDer.slice(0, -4) + (tail === '0000' ? '1111' : '0000');
  };

  CL.verifySignature = function (pubHex, msgHash, sigDer) {
    try {
      return ec.keyFromPublic(pubHex, 'hex').verify(msgHash, sigDer);
    } catch {
      return false; // DER corrupta: para el script es exactamente lo mismo que una firma falsa
    }
  };

  /**
   * Vectores conocidos + roundtrip. Sirve para comprobar en vivo que el teléfono
   * de cada asistente hace la criptografía bien antes de empezar la dinámica.
   */
  CL.selfTest = function () {
    const checks = [];
    const push = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

    push('SHA-256 (vector vacío)',
      CL.sha256utf8('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    // Vector BIP39 oficial: 12 x "abandon" + "about"
    const known = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    push('BIP39 checksum', global.bip39lib.validateMnemonic(known));
    push('BIP39 seed (vector oficial)',
      global.bip39lib.mnemonicToSeedSync(known).toString('hex').startsWith('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1'));

    // hash160 de la pubkey del bloque génesis -> el hash160 de la dirección 1A1zP1...
    const genesisPub = '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb6' +
      '49f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f';
    push('HASH160 (pubkey del bloque génesis)',
      CL.hash160(genesisPub) === '62e907b15cbf27d5425399ebf6f0fb50ebb88f18');

    const id = CL.identityFromMnemonic(known);
    const { msgHash, sigDer } = CL.signMessage(id, 'prueba');
    push('Firma y verificación', CL.verifySignature(id.pubHex, msgHash, sigDer));
    push('Firma alterada se rechaza', !CL.verifySignature(id.pubHex, msgHash, CL.tamperSignature(sigDer)));

    const other = CL.identityFromMnemonic(CL.randomMnemonic());
    push('Otra llave no valida la firma', !CL.verifySignature(other.pubHex, msgHash, sigDer));

    return { checks, ok: checks.every((c) => c.ok) };
  };
})(window);
