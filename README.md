# JUKA Radio Playlist Analyzer (`yrpa`)

Robustes Node.js-Tool zum Scrapen von Radio-Playlisten, historischer Speicherung in SQLite und Auswertung über CLI + API + Web-Dashboard.

## Highlights

- Multi-Station Ingest mit Parser-/Fetcher-Adaptern
- Idempotente Speicherung (`insert or ignore`) in SQLite
- Weekly Report (Markdown + optional CSV, optional `.gz`)
- Daily Evaluation + Coverage Audit (Datenqualität)
- API + Dashboard + Tracks-UI
- Jingle-/Noise-Filter mit optionaler externer Song-Verifizierung

## Tech Stack

- Node.js 20+
- ESM, `undici`, `cheerio`, `better-sqlite3`
- `commander`, `zod`, `pino`, `luxon`
- Optional: `playwright`
- Tests: `vitest`

## Quickstart

```bash
npm install
npm test
node src/cli.js ingest --config config.yaml
node src/cli.js report --config config.yaml --week-start 2026-02-24 --csv
node src/cli.js api --config config.yaml --port 8787
```

Open:

- `http://localhost:8787/dashboard`
- `http://localhost:8787/tracks`
- `http://localhost:8787/api/docs`

## Für Nicht-Programmierer (macOS)

Per Doppelklick:

1. `setup-juka.command` (einmalig)
2. `start-juka-api.command`
3. Browser: `http://localhost:8787/dashboard`

Manueller Tageslauf:

1. `run-juka-daily-now.command`
2. Ergebnisse in `reports/` ansehen

## Konfiguration

Datei: `config.yaml`

Wichtige Felder je Station:

- `id`, `name`, `playlist_url`
- `parser`: `onlineradiobox`, `dlf_nova`, `fluxfm`, `generic_html`, `generic_html_or_onlineradiobox`
- `fetcher`: `http` oder `playwright`
- `timezone`: i. d. R. `Europe/Berlin`
- optional `fallback_urls`
- optional Qualitätsschwellen: `min_daily_hours`, `min_daily_plays`

## CLI Commands

### Ingest

```bash
node src/cli.js ingest --config config.yaml --db yrpa.sqlite
```

### Weekly Report

```bash
node src/cli.js report --config config.yaml --week-start 2026-02-24
node src/cli.js report --config config.yaml --week-start 2026-02-24 --csv
node src/cli.js report --config config.yaml --week-start 2026-02-24 --csv --gzip
node src/cli.js report --config config.yaml --week-start 2026-02-24 --csv --gzip --gzip-only
```

Outputs:

- `reports/YYYY-MM-DD_weekly.md` (oder `.md.gz`)
- optional `reports/csv/*.csv` (oder `.csv.gz`)

### Daily Evaluation

```bash
node src/cli.js evaluate-daily --config config.yaml
node src/cli.js evaluate-daily --config config.yaml --date 2026-02-26
```

### Coverage Audit

```bash
node src/cli.js audit-coverage --config config.yaml
node src/cli.js audit-coverage --config config.yaml --date 2026-02-26
```

Output:

- `reports/coverage/YYYY-MM-DD_coverage.md`

### Backpool Analyse (Goldtitel)

Analysiert ältere Songs je Sender im gewählten Zeitraum.

```bash
node src/cli.js analyze-backpool --config config.yaml
node src/cli.js analyze-backpool --config config.yaml --from 2025-01-01 --to 2026-02-27 --years 5 --min-plays 3 --top 15
```

Output:

- `reports/backpool/YYYY-MM-DD_YYYY-MM-DD_backpool.md`

### Daily Job (kombiniert)

```bash
node src/cli.js daily-job --config config.yaml --make-report --audit-coverage
```

Hinweis: `daily-job` wertet den **gestrigen** Berlin-Tag aus (stabile, abgeschlossene Tagesdaten).

### API

```bash
node src/cli.js api --config config.yaml --port 8787
node src/cli.js api --config config.yaml --port 8787 --no-startup-report
node src/cli.js api --config config.yaml --port 8787 --schedule-daily --daily-hour 23
```

Hinweis: Der geplante Tageslauf über `--schedule-daily` wertet ebenfalls den **gestrigen** Berlin-Tag aus.

Hinweis: Bei belegtem Port wird automatisch auf den nächsten freien Port gewechselt.

## API Endpoints (Auszug)

- `GET /api/health`
- `GET /api/docs`
- `GET /api/stations`
- `GET /api/tracks`
- `GET /api/tracks/search?q=...`
- `GET /api/tracks/:trackKey/series`
- `GET /api/tracks/:trackKey/totals`
- `GET /api/tracks/:trackKey/stations`
- `GET /api/tracks/:trackKey/meta`
- `GET /api/reports/station/:stationId?weekStart=YYYY-MM-DD`
- `GET /api/insights/new-this-week`
- `POST /api/jobs/evaluate-daily`

## Datenqualität & Bereinigung

### Station-Dedupe (z. B. zu viele Plays pro Minute)

```bash
node src/cli.js cleanup-station --station-id dlf_nova --db yrpa.sqlite
```

### Song-Verifizierung / Jingle-Filter

Es gibt einen API-Abgleich (iTunes Search), um verdächtige Nicht-Songs (Jingles/Show-Claims) zu filtern.

- Standard: aktiv (außer in Tests)
- Standard-Strategie: nur für verdächtige Tracks
- Bei API-Fehlern: kein harter Abbruch, Status `unknown`

Env-Steuerung:

- `YRPA_TRACK_VERIFY=0` deaktiviert Verifizierung
- `YRPA_VERIFY_ALL_TRACKS=1` prüft alle Tracks (langsamer)

Metadaten landen in `track_metadata` und sind über `/api/tracks/:trackKey/meta` verfügbar.

## Cron Beispiele

Zuverlässiger Ingest alle 15 Minuten:

```cron
*/15 * * * * cd /path/to/juka-radio-playlist-analyzer && /usr/bin/node src/cli.js ingest --config config.yaml
```

Weekly Report montags 06:00:

```cron
0 6 * * 1 cd /path/to/juka-radio-playlist-analyzer && WEEK_START=$(date -v-7d +\%Y-\%m-\%d) && /usr/bin/node src/cli.js report --config config.yaml --week-start "$WEEK_START" --csv
```

Daily Job 23:00:

```cron
0 23 * * * cd /path/to/juka-radio-playlist-analyzer && /usr/bin/node src/cli.js daily-job --config config.yaml --make-report --audit-coverage
```

## Neue Sender hinzufügen

### Option A: Konfiguration + Generic Parser

1. Station in `config.yaml` ergänzen
2. Parser auf `generic_html_or_onlineradiobox` oder `generic_html`
3. Ingest laufen lassen und Ergebnis prüfen

### Option B: Eigener Parser

1. Parser in `src/parsers/` erstellen
2. In `parserForStation` registrieren
3. Fixture + Tests unter `tests/fixtures` / `tests/parsers.test.js`

## Playwright Verhalten

Wenn `fetcher: playwright` gesetzt ist und Playwright fehlt, scheitert nur diese Station. Andere laufen weiter.

## Credits

Dieses Projekt wurde gemeinsam mit **Codex (GPT-5)** umgesetzt und iterativ verbessert (Architektur, CLI, API, Tests, Dashboard/UX).
