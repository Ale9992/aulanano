#!/usr/bin/env bash
# Crea AulaNano.exe (Windows x64) come Node.js Single Executable Application.
# Si può eseguire su Linux o macOS. Richiede Node 22 e npx (per postject).
# L'eseguibile prodotto NON contiene Chrome né il modello: li scarica Google al primo avvio.
set -euo pipefail
cd "$(dirname "$0")"
NODE_VERSION="$(node -p 'process.versions.node')"
[[ "${NODE_VERSION%%.*}" -ge 22 ]] || { echo "Serve Node 22 o superiore (trovato $NODE_VERSION)"; exit 1; }
mkdir -p build
# 1. blob dell'applicazione (codice + pagine web)
node --experimental-sea-config sea-config.json
# 2. runtime Node per Windows della stessa versione, dal sito ufficiale nodejs.org
ZIP="build/node-v$NODE_VERSION-win-x64.zip"
[ -f "$ZIP" ] || curl -fL -o "$ZIP" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip"
unzip -o -j -q "$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" -d build
cp build/node.exe build/AulaNano.exe
# 3. inserisce il blob nell'eseguibile
npx --yes postject build/AulaNano.exe NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
echo "Creato desktop/build/AulaNano.exe"
