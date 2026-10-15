#!/usr/bin/env bash
# Scarica Google Chrome stabile dal sito ufficiale di Google e lo estrae nella cartella dati,
# senza installarlo nel sistema (non servono permessi di root). Solo Linux x86_64 (Debian/Ubuntu).
# Usando Chrome accetti i Termini di servizio di Google Chrome: https://www.google.com/chrome/terms
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DATA="${GN_BASE:-$(cd .. && pwd)/data}"
mkdir -p "$DATA/dl" "$DATA/chrome"
DEB="$DATA/dl/google-chrome-stable_current_amd64.deb"
echo "Scarico Google Chrome da dl.google.com…"
curl -fL -o "$DEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
dpkg-deb -x "$DEB" "$DATA/chrome"
"$DATA/chrome/opt/google/chrome/google-chrome" --version
