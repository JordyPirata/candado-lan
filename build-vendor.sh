#!/usr/bin/env bash
# Descarga y empaqueta TODO lo que la sala necesita para funcionar sin internet.
# Se corre una sola vez, con red. Después, `node server.js` basta.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/public/vendor"
FONTS="$VENDOR/fonts"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

mkdir -p "$VENDOR" "$FONTS"

echo "==> elliptic + crypto-js"
curl -fsSL -o "$VENDOR/elliptic.min.js" \
  https://cdnjs.cloudflare.com/ajax/libs/elliptic/6.5.4/elliptic.min.js
curl -fsSL -o "$VENDOR/crypto-js.min.js" \
  https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js

echo "==> bip39 (npm + esbuild)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null 2>&1
npm i --silent --no-audit --no-fund bip39@3.1.0 buffer@6.0.3 >/dev/null 2>&1
cat > shim.js <<'EOF'
import { Buffer } from 'buffer';
export { Buffer };
EOF
cat > entry.js <<'EOF'
import { Buffer } from 'buffer';
import * as bip39 from 'bip39';
window.Buffer = Buffer;
window.bip39lib = bip39;
EOF
npx --yes esbuild@0.23.1 entry.js \
  --bundle --format=iife --minify --target=es2020 \
  --inject:shim.js \
  --outfile="$VENDOR/bip39.bundle.js" >/dev/null
cd "$HERE"

echo "==> qrcode-generator"
curl -fsSL -o "$VENDOR/qrcode.min.js" \
  https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js

echo "==> fuentes (woff2 locales)"
: > "$FONTS/fonts.css"
fetch_family () {
  local family_query="$1" prefix="$2"
  local css
  css="$(curl -fsSL -A "$UA" "https://fonts.googleapis.com/css2?family=${family_query}&display=swap")"
  local i=0
  while IFS= read -r url; do
    i=$((i+1))
    curl -fsSL -o "$FONTS/${prefix}-${i}.woff2" "$url"
    css="${css//$url/${prefix}-${i}.woff2}"
  done < <(printf '%s\n' "$css" | grep -o 'https://[^)]*\.woff2' | awk '!seen[$0]++')
  printf '%s\n' "$css" >> "$FONTS/fonts.css"
}
fetch_family 'Zilla+Slab:wght@600;700' zillaslab
fetch_family 'Inter:wght@400;500;600'  inter
fetch_family 'JetBrains+Mono:wght@400;500;600' jetbrainsmono

echo
echo "Listo. Contenido de public/vendor:"
ls -la "$VENDOR"
echo "Fuentes: $(ls "$FONTS" | wc -l) archivos"
