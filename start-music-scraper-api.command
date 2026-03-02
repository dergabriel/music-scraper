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

  local level msg station err plays inserted warnings scrapeErrors dateBerlin mdPath
  level="$(extract_json_number "$line" "level")"
  msg="$(extract_json_field "$line" "msg")"
  station="$(extract_json_field "$line" "station")"
  err="$(extract_json_field "$line" "err")"
  plays="$(extract_json_number "$line" "playsInserted")"
  inserted="$(extract_json_number "$line" "totalInserted")"
  warnings="$(extract_json_number "$line" "warnings")"
  scrapeErrors="$(extract_json_number "$line" "scrapeErrors")"
  dateBerlin="$(extract_json_field "$line" "dateBerlin")"
  mdPath="$(extract_json_field "$line" "mdPath")"

  if [[ "$msg" == "API server started" ]]; then
    ok "Startup abgeschlossen. API ist bereit."
    info "Dashboard: http://localhost:8787/dashboard"
    info "Backpool:  http://localhost:8787/backpool"
    return
  fi

  if [[ "$msg" == "running startup ingest/evaluation/report before API boot" ]]; then
    step "Startup-Scan laeuft (Ingest, Maintenance, Evaluation, Backpool)"
    return
  fi

  if [[ "$msg" == "ingest complete" ]]; then
    echo -e "${GREEN}  •${RESET} Sender ${BOLD}${station:-?}${RESET}: ${plays:-0} neue Plays"
    return
  fi

  if [[ "$msg" == "station ingest failed" ]]; then
    echo -e "${RED}  ✗${RESET} Sender ${BOLD}${station:-?}${RESET}: ingest fehlgeschlagen ${DIM}${err}${RESET}"
    return
  fi

  if [[ "$msg" == "ingest finished" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Ingest fertig: ${inserted:-0} neue Plays, Fehler: ${scrapeErrors:-0}"
    return
  fi

  if [[ "$msg" == "daily evaluation completed" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Tagesauswertung fertig (${dateBerlin:-unbekannt})"
    return
  fi

  if [[ "$msg" == "coverage audit completed" ]]; then
    echo -e "${BLUE}${BOLD}==>${RESET} Coverage-Audit: Warnungen ${warnings:-0} ${DIM}${mdPath}${RESET}"
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
      fail "$msg ${err:+- $err}"
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
node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8787 | while IFS= read -r line; do
  format_log_line "$line"
done
