#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "[JUKA] Fuehre Ingest + Daily-Auswertung + Weekly-Report aus..."
if [ ! -d "node_modules" ]; then
  echo "[JUKA] Installiere Abhaengigkeiten (einmalig)..."
  npm install
fi

node src/cli.js daily-job --config config.yaml --make-report
echo "[JUKA] Fertig. Reports liegen im Ordner reports/."
