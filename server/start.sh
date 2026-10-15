#!/usr/bin/env bash
# Avvia (o riavvia) il bridge AulaNano in background.
# Legge la configurazione da server/.env se presente (vedi .env.example).
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DATA="${GN_BASE:-$(cd .. && pwd)/data}"
mkdir -p "$DATA"
pkill -f '^node bridge.mjs' || true
pkill -f "[c]hrome.*--user-data-dir=$DATA/profile" || true
sleep 1
setsid nohup node bridge.mjs > "$DATA/bridge.log" 2>&1 < /dev/null &
echo "bridge avviato su http://127.0.0.1:${GN_PORT:-8787} - log: $DATA/bridge.log"
