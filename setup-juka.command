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
  fail "Setup abgebrochen (Exit Code ${exit_code})."
  warn "Pruefe die letzte Fehlermeldung oben und fuehre das Setup erneut aus."
}
trap on_error ERR

echo -e "${BOLD}JUKA Setup${RESET} ${DIM}(Dependencies + Tests)${RESET}"
step "Installiere Abhaengigkeiten"
npm install
ok "Abhaengigkeiten installiert"

step "Starte Testlauf"
npm test
ok "Tests erfolgreich"

echo
ok "Setup erfolgreich abgeschlossen"
warn "Als naechstes: start-juka-api.command ausfuehren."
