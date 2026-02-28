# JUKA Radio Playlist Analyzer (`yrpa`)

Ein Tool, das Radio-Playlisten automatisch sammelt, in einer Datenbank speichert und als Reports + Dashboard auswertet.

Ziel: schnell sehen, **welche Songs wirklich laufen**, wie gut die Daten je Sender sind und wie sich Rotationen/Backpool entwickeln.

## Was du sofort bekommst

- automatisches Playlist-Ingest für mehrere Sender
- saubere Historie in SQLite (`yrpa.sqlite`)
- Web-Dashboard mit Track-Ansicht und Backpool-Analysen
- tägliche Qualitätschecks (Coverage Audit)
- Reports als Markdown/CSV

## Schnellstart (2 Minuten)

```bash
npm install
node src/cli.js api --config config.yaml --port 8787
```

Dann öffnen:

- `http://localhost:8787/dashboard`
- `http://localhost:8787/tracks`
- `http://localhost:8787/api/docs`

## Setup-Anleitung

Die komplette Schritt-für-Schritt-Einrichtung ist hier:

- [Setup Guide](/Users/gabrielbecker/Documents/Codex/Music%20Scraper/docs/setup.md)

Enthalten:

- Installation (Node, npm)
- erster Ingest + erster Report
- API/Dashboard starten
- macOS-Doppelklick-Variante (`*.command`)
- typische Fehlerbehebung

## Häufige Befehle

```bash
# Playlist-Daten holen
node src/cli.js ingest --config config.yaml

# Wochenreport erzeugen
node src/cli.js report --config config.yaml --week-start 2026-02-24 --csv

# Tagesauswertung (gestern)
node src/cli.js evaluate-daily --config config.yaml --date 2026-02-27

# Coverage-Audit (gestern)
node src/cli.js audit-coverage --config config.yaml --date 2026-02-27

# Backpool-Analyse
node src/cli.js analyze-backpool --config config.yaml
```

## Projektstruktur (kurz)

- `src/` Kernlogik (CLI, API, Parser, Services)
- `config.yaml` Sender-Konfiguration
- `reports/` erzeugte Reports
- `tests/` Parser/Logik-Tests

## Für Entwickler

- Tests: `npm test`
- Konfigurierbare Parser/Fetcher pro Sender
- Datenpflege über `maintain-db`

Details zu Commands, Cron und Sender-Erweiterungen stehen im Setup Guide.
