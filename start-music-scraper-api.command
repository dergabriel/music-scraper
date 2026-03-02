#!/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"

if [[ -t 1 ]]; then
  BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
  GREEN='\033[32m'; RED='\033[31m'; BLUE='\033[34m'; YELLOW='\033[33m'
else
  BOLD=''; DIM=''; RESET=''; GREEN=''; RED=''; BLUE=''; YELLOW=''
fi

step() { echo -e "${BLUE}${BOLD}==>${RESET} $1"; }
ok() { echo -e "${GREEN}${BOLD}[OK]${RESET} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[HINWEIS]${RESET} $1"; }
fail() { echo -e "${RED}${BOLD}[FEHLER]${RESET} $1"; }

on_error() {
  local exit_code=$?
  fail "API-Start fehlgeschlagen (Exit Code ${exit_code})."
  warn "Pruefe die letzte Fehlermeldung oben."
}
trap on_error ERR

echo -e "${BOLD}Music Scraper API Start${RESET} ${DIM}(Dashboard + Scheduler)${RESET}"

if [ ! -d "node_modules" ]; then
  step "Installiere Abhaengigkeiten (einmalig)"
  npm install
  ok "Abhaengigkeiten installiert"
fi

if ! node -e "require.resolve('express'); require.resolve('node-cron')" >/dev/null 2>&1; then
  step "Fehlende Pakete erkannt - installiere nach"
  npm install
  ok "Pakete nachinstalliert"
fi

echo
ok "API-Start wird vorbereitet"
echo -e "${DIM}URL:${RESET} http://localhost:8787"
echo -e "${DIM}Dashboard:${RESET} http://localhost:8787/dashboard"
echo -e "${DIM}Backpool:${RESET} http://localhost:8787/backpool"
echo -e "${DIM}Interner Cron:${RESET} stuendlich zur vollen Stunde (0 * * * *)"
echo
step "Starte Server (CTRL+C zum Beenden)"
node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8787
