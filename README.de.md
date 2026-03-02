# Music Scraper

Tool zum automatischen Einsammeln, Normalisieren und Auswerten von Radio-Playlisten.

Mit Music Scraper kannst du:

- Playlists mehrerer Sender regelmäßig einlesen
- Rotationen, neue Titel und Backpool analysieren
- Ergebnisse im Web-Dashboard und per API ansehen
- tägliche Reports/Checks automatisieren

## Schnellstart

```bash
npm install
node src/cli.js api --config config.yaml --port 8787
```

Danach im Browser:

- `http://localhost:8787/dashboard`
- `http://localhost:8787/backpool`
- `http://localhost:8787/new-titles`
- `http://localhost:8787/api/docs`

## Kernfunktionen

- Ingest pro Sender (Parser/Fallback-URLs je Station)
- Tages- und Wochenauswertung
- Backpool-Analyse mit Release-/Rotationslogik
- Track-Metadaten (Cover, Release, Genre, Chart-Infos)
- Datenpflege (`maintain-db`) gegen Noise/Jingles/Dubletten

## Wichtige Commands

```bash
# Playlist-Daten einlesen
node src/cli.js ingest --config config.yaml --db music-scraper.sqlite

# API + Dashboard starten
node src/cli.js api --config config.yaml --db music-scraper.sqlite --port 8787

# Tagesjob (Ingest + Eval + optional Report/Audit)
node src/cli.js daily-job --config config.yaml --db music-scraper.sqlite --make-report --audit-coverage

# Backpool auswerten
node src/cli.js analyze-backpool --config config.yaml --db music-scraper.sqlite

# Datenpflege
node src/cli.js maintain-db --db music-scraper.sqlite
```

## Dokumentation

- Setup: [docs/setup.md](docs/setup.md)
- API-Endpunkte: `GET /api/docs`

## Datenschutz & sichere Veröffentlichung

Vor dem Push auf GitHub:

- keine lokalen Datenbanken committen (`*.sqlite`, `*.db`, `data/` sind ignoriert)
- keine Tokens/Secrets in Dateien speichern (`.env*` ist ignoriert)
- Reports mit sensiblen Inhalten nicht committen (`reports/` ist ignoriert)

Wenn ein Token bereits geteilt wurde: sofort in GitHub widerrufen/rotieren.
