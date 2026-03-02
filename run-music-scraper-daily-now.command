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
info() { echo -e "${DIM}[INFO]${RESET} $1"; }

extract_json_field() {
  local line="$1"
  local key="$2"
  echo "$line" | sed -n "s/.*\"${key}\":\"\\([^\"]*\\)\".*/\\1/p"
}

extract_json_number() {
  local line="$1"
  local key="$2"
  echo "$line" | sed -n "s/.*\"${key}\":\\([0-9][0-9]*\\).*/\\1/p"
}

format_log_line() {
  local line="$1"
  if [[ ! "$line" =~ ^\{.*\"msg\" ]]; then
    echo "$line"
    return
  fi

  local level msg station err plays inserted warnings
  level="$(extract_json_number "$line" "level")"
  msg="$(extract_json_field "$line" "msg")"
  station="$(extract_json_field "$line" "station")"
  err="$(extract_json_field "$line" "error")"
  plays="$(extract_json_number "$line" "playsInserted")"
  inserted="$(extract_json_number "$line" "totalInserted")"
  warnings="$(extract_json_number "$line" "warnings")"

  if [[ "$msg" == "ingest complete" ]]; then
    echo -e "${GREEN}  •${RESET} Sender ${BOLD}${station:-?}${RESET}: ${plays:-0} neue Plays"
    return
  fi
  if [[ "$msg" == "station ingest failed" ]]; then
    echo -e "${RED}  ✗${RESET} Sender ${BOLD}${station:-?}${RESET}: ingest fehlgeschlagen ${DIM}${err}${RESET}"
    return
  fi
  if [[ "$msg" == "ingest finished" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Ingest fertig: ${inserted:-0} neue Plays"
    return
  fi
  if [[ "$msg" == "daily evaluation completed" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Tagesauswertung fertig"
    return
  fi
  if [[ "$msg" == "coverage audit completed" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Coverage-Audit fertig (Warnungen: ${warnings:-0})"
    return
  fi
  if [[ "$msg" == "report generated" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Wochenreport geschrieben"
    return
  fi
  if [[ "$msg" == "backpool analysis completed" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Backpool-Analyse fertig"
    return
  fi

  if [[ -n "$msg" ]]; then
    if [[ -n "$level" && "$level" -ge 50 ]]; then
      fail "$msg"
    elif [[ -n "$level" && "$level" -ge 40 ]]; then
      warn "$msg"
    else
      info "$msg"
    fi
    return
  fi

  echo "$line"
}

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
node src/cli.js daily-job --config config.yaml --make-report | while IFS= read -r line; do
  format_log_line "$line"
done
ok "Daily-Job erfolgreich abgeschlossen"
warn "Reports liegen in: reports/"
