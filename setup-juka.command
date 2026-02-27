#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "[JUKA] Setup startet..."
npm install
npm test
echo "[JUKA] Setup erfolgreich."
echo "[JUKA] Danach API per Doppelklick auf start-juka-api.command starten."
