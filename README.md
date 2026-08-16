# Candado LAN

An interactive local-network room for teaching Bitcoin's **P2PKH** live, peer to peer. Every attendee joins
from their own phone, generates a BIP39 identity, publishes their public key and creates locks addressed to
someone else in the room. The recipient opens them by signing; anyone who tries without the right key watches
the script die at `OP_EQUALVERIFY`, opcode by opcode.

It is the multiplayer version of the single-page guide, which is still bundled at `/guia.html`.

No accounts, no build step, no runtime dependencies, and — once set up — **no internet**. Just Node and a
Wi-Fi network everyone can reach.

> **Heads-up on language:** the app itself, its code comments and the test output are all in Spanish, which is
> the language it is taught in. This README is the English entry point; you do not need Spanish to run it, but
> you will need some to read the source comfortably.

## Requirements

- **Node.js 18 or newer** (uses the built-in `fetch`; no other runtime dependency).
- A one-time internet connection to fetch the browser libraries and fonts.

## Quick start

```bash
git clone <this-repo> && cd candado-lan
npm run vendor     # once, with internet: downloads and bundles libs + fonts into public/vendor/
npm start          # equivalent to: node server.js
```

`npm run vendor` is the only step that touches the network. It runs `build-vendor.sh` through `bash`, so it
works whether or not the execute bit survived your checkout, and it needs `bash`, `curl`, `npm` and `npx` (it
bundles `bip39` with esbuild). Everything lands in `public/vendor/`, which is **not** checked into the repo.
After that the room runs fully offline — if the libraries are missing, the server refuses to start and tells
you so.

The terminal prints a join URL for each network interface, the room code and your facilitator token:

```
  Que se unan desde su teléfono a:
    http://192.168.1.42:8080      [wlan0]

  Tu panel de facilitador (controla las rondas):
    http://192.168.1.42:8080/?admin=a1b2c3d4
```

Open your own `?admin=…` URL — that is the tab you project — hit **Compartir** to show the QR code, and let
the audience scan it. Useful environment variables: `PORT`, `ROOM`, `ADMIN_TOKEN`, `HOST`.

## How a session runs

The facilitator opens one round at a time from their control bar; between rounds the board is free.

1. **Introduce yourself** — everyone shows up in the participant list with their `hash160`. That is their
   "address".
2. **Create a lock** — you pick someone: their `hash160` is engraved into the `scriptPubKey`.
3. **Open it** — sign with your private key and step through the script.
4. **Try to steal** — open someone else's lock and watch exactly where the script dies.
5. **Free play** — including the *open with a corrupted signature* button, which fails at `OP_CHECKSIG`.

Scoring: +10 for opening a lock addressed to you, +5 for the person who created it. A failed theft costs
nothing, but it shows up in the feed for everyone to see.

### How many people fit

As many as you like: the room is a list of participants, not a pair. Tested with 25 identities at the protocol
level and 13 real browsers at once. Verifying 25 signatures in the browser costs ~55 ms, so the bottleneck is
the Wi-Fi, not the cryptography.

Past a certain size the interface adapts on its own: above 8 people the participant list grows a search box,
above 4 locks the filters appear (**Todos · Para mí · Los creé · Abiertos**), and the board always sorts what
is addressed to you first. The scoreboard shows the top 10 and, if you are not in it, appends your row with
your real position.

## Who verifies what

The server **does no cryptography**. It keeps an ordered event log per room and rebroadcasts it; nothing else.
Every browser recomputes `hash160(pubkey)` and verifies the ECDSA signature on its own before considering a
lock opened, so each person's board is their own conclusion, not a referee's. State is a pure `fold` over the
log: latecomers receive every event and converge on the same board.

The private key never leaves the device — only the public key, the signature and the hash are published.

## Deliberate simplifications

The parts that carry the lesson are the real thing: the BIP39 wordlist, its checksum and PBKDF2-HMAC-SHA512,
secp256k1 with compressed public keys, `RIPEMD160(SHA256(pubkey))`, the P2PKH script and ECDSA verification.
Two layers around them are cut on purpose, and it is worth saying out loud during the session — otherwise the
room walks away with a slightly wrong model of a wallet.

**No BIP32: the seed is never used as a master key.** The private key here is literally the first 32 bytes of
the BIP39 seed, read as a secp256k1 scalar (`keys.js`). A real wallet feeds those 64 bytes into
`HMAC-SHA512("Bitcoin seed", seed)` to obtain a master key *and* a chain code, and derives one key pair per
path (`m/44'/0'/0'/0/0` and friends). What this costs:

- One key per person for the whole session, so every lock you touch is trivially linkable. Address rotation —
  a fresh key per payment — is exactly the privacy property real wallets buy with BIP32, and it is absent here.
- No xpub, so no watch-only wallets and no deriving public keys without the secret.
- **A mnemonic from this demo is not a wallet backup.** Restoring it into a real wallet yields completely
  different keys, because that wallet will run BIP32 on the seed and this one does not.

**The `hash160` is shown raw: it is not an address.** What the room calls your *"dirección"* is the 20-byte
`RIPEMD160(SHA256(pubkey))`, printed as 40 hex characters. A real P2PKH address wraps that same hash in
Base58Check: prepend a version byte, append the first 4 bytes of `SHA256(SHA256(…))` as a checksum, encode in
Base58 → `1A1zP1…`. None of that happens here. What this costs:

- **No version byte** (`0x00` mainnet, `0x6F` testnet), so nothing in an identity says which network it
  belongs to — the same string would be equally meaningless on any of them.
- **No checksum**, so a mistyped identifier is undetectable. In a real wallet a typo fails to decode instead of
  sending coins into the void. The room gets away with it because nobody types one: you pick people from a list.
- **No Base58 alphabet**, hence none of the protection it buys against look-alike characters (`0`/`O`, `l`/`I`).

The upside is that the hash is on screen in the same form the script compares in `OP_EQUALVERIFY`, which makes
the point that an address is packaging around this number — a network label and an error-detecting code — and
not the thing Bitcoin actually locks to.

`public/guia.html` covers the same ground for the single-player walkthrough.

## Layout

| File | What it does |
|---|---|
| `server.js` | HTTP + SSE + event relay. No dependencies. |
| `public/js/keys.js` | BIP39 → seed → secp256k1 key → `hash160`. Signing, verification and self-test. |
| `public/js/script-vm.js` | Builds the P2PKH scripts and the stack machine (step-by-step and silent). |
| `public/js/net.js` | SSE, publishing, and folding the log into state. |
| `public/js/ui.js` | Rendering, forms and the execution modal. |
| `public/guia.html` | The original single-page guide, now CDN-free. |
| `build-vendor.sh` | Downloads and bundles the libraries and fonts. Only needed to regenerate them. |

## Tests

```bash
npm test          # server protocol + real cryptography and fold, no dependencies
```

There is also a test driving two real browsers (it creates locks, opens them, tries to steal them and checks
that not a single request escapes to the internet). It is optional because it needs puppeteer, which is not a
dependency of this project:

```bash
mkdir -p /tmp/cl-e2e && cd /tmp/cl-e2e && npm i puppeteer   # once
cd -                                                        # back to the project
npm run test:e2e
```

Without puppeteer installed the script skips itself and does not fail. If it complains about
`Could not find Chrome`, the download stopped halfway; unzip it by hand and retry:

```bash
cd ~/.cache/puppeteer/chrome && unzip -oq *-chrome-linux64.zip -d linux-*/ \
  && chmod +x linux-*/chrome-linux64/chrome
```

## Presentation day

- Everyone on the **same network**. Many public access points isolate clients from each other; if the QR code
  loads but nobody shows up in the list, start a hotspot from your laptop and move on.
- Behind a firewall: `sudo ufw allow 8080/tcp`.
- It works **without internet**: fonts and libraries are served from `public/vendor/`.
- Ask people to hit **Autodiagnóstico** when they join (inside "Tu identidad"): it runs known SHA-256, BIP39
  and `hash160` vectors on their own phone.
- If things get tangled mid-session, **Reiniciar sala** wipes locks and scores without restarting the server.

## Contributing

Issues and pull requests are welcome — especially bug reports from real sessions with real audiences.

- Run `npm test` before opening a PR. It is fast, needs no install, and covers both the cryptography and the
  server protocol.
- **No runtime dependencies.** The room has to boot on a laptop with no internet in front of an audience;
  anything shipped to the browser lives pre-bundled in `public/vendor/`, generated by `build-vendor.sh`.
- **Keep the verification in the browser.** The server is deliberately a dumb relay: if a check looks like it
  belongs on the server, resisting that urge is precisely what the demo teaches.
- Match the surrounding style: 2-space indent, no transpiler, no framework, and Spanish for code comments and
  anything the audience reads.

## License

[MIT](LICENSE) © JordyPirata

> Educational demo. Plain HTTP on a local network, no authentication beyond the room code, keys generated in
> the browser and kept in `localStorage`. Do not use it with real funds.
