# Setup Guide

## Ziel

Nach diesem Setup kannst du:

1. Senderdaten einsammeln
2. Reports erzeugen
3. das Dashboard lokal nutzen

## Voraussetzungen

- macOS, Linux oder Windows
- Node.js 20+
- npm

Prüfen:

```bash
node -v
npm -v
```

## Installation

Im Projektordner:

```bash
npm install
npm test
```

## Erster Lauf

### 1. Ingest starten

```bash
node src/cli.js ingest --config config.yaml --db yrpa.sqlite
```

Ergebnis: neue Plays landen in `yrpa.sqlite`.

### 2. Wochenreport erzeugen

```bash
node src/cli.js report --config config.yaml --week-start 2026-02-24 --csv
```

Ergebnis:

- `reports/2026-02-24_weekly.md`
- `reports/csv/*.csv`

### 3. API + Dashboard starten

```bash
node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8787
```

Im Browser:

- `http://localhost:8787/dashboard`
- `http://localhost:8787/tracks`
- `http://localhost:8787/api/docs`

## macOS ohne Terminal (Doppelklick)

1. `setup-music-scraper.command` (einmalig)
2. `start-music-scraper-api.command`
3. Dashboard öffnen

Manuell Tageslauf:

1. `run-music-scraper-daily-now.command`
2. Ergebnisse in `reports/` prüfen

## Wichtige Commands

```bash
# tägliche Auswertung (empfohlen: gestern)
node src/cli.js evaluate-daily --config config.yaml --date 2026-02-27

# Coverage-Audit
node src/cli.js audit-coverage --config config.yaml --date 2026-02-27

# Backpool-Analyse
node src/cli.js analyze-backpool --config config.yaml

# kombinierter Job
node src/cli.js daily-job --config config.yaml --make-report --audit-coverage

# Datenpflege (Dublettten/Noise)
node src/cli.js maintain-db --db yrpa.sqlite
```

## Sender konfigurieren

Datei: `config.yaml`

Wichtige Felder:

- `id`, `name`, `playlist_url`
- `fallback_urls` (optional)
- `parser`: `onlineradiobox`, `dlf_nova`, `fluxfm`, `generic_html`, `generic_html_or_onlineradiobox`
- `fetcher`: `http` oder `playwright`
- `timezone` (meist `Europe/Berlin`)

## Typische Probleme

### Keine Daten bei einem Sender

- `playlist_url` prüfen
- `fallback_urls` ergänzen
- Parser prüfen (z. B. `generic_html_or_onlineradiobox`)

### Viele Junk-Titel/Jingles

- `maintain-db` ausführen
- station-spezifische Filter/Parser anpassen

### API-Port belegt

- anderen Port nehmen, z. B. `--port 8788`

## Nächste Schritte

1. Cron/Task Scheduler für regelmäßigen Ingest setzen
2. Coverage täglich prüfen
3. Backpool regelmäßig neu berechnen
