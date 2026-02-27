#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "[JUKA] Starte JUKA Radio Analyzer API..."
if [ ! -d "node_modules" ]; then
  echo "[JUKA] Installiere Abhaengigkeiten (einmalig)..."
  npm install
fi

if ! node -e "require.resolve('express')" >/dev/null 2>&1; then
  echo "[JUKA] Fehlende Pakete erkannt. Installiere nach..."
  npm install
fi

echo "[JUKA] API startet auf http://localhost:8787"
echo "[JUKA] Täglicher Lauf: 23:00 Europe/Berlin"
node src/cli.js api --config config.yaml --port 8787 --schedule-daily --daily-hour 23
