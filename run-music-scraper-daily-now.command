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
  fail "Daily-Job fehlgeschlagen (Exit Code ${exit_code})."
  warn "Pruefe die letzte Fehlermeldung oben."
}
trap on_error ERR

echo -e "${BOLD}Music Scraper Daily Run${RESET} ${DIM}(Ingest + Daily Eval + Weekly Report)${RESET}"

if [ ! -d "node_modules" ]; then
  step "Installiere Abhaengigkeiten (einmalig)"
  npm install
  ok "Abhaengigkeiten installiert"
fi

step "Starte Daily-Job"
node src/cli.js daily-job --config config.yaml --make-report
ok "Daily-Job erfolgreich abgeschlossen"
warn "Reports liegen in: reports/"
