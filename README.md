# Music Scraper

**Radio-Analyse-Tool für Sender, die wissen wollen, was gerade läuft.**

> Entstanden durch Vibecoding — entwickelt mit Claude als KI-Partner. Die Ideen und Anforderungen kamen von einem Radiosender, den Code hat Claude geschrieben.

---

## Was ist Music Scraper?

Music Scraper sammelt Playlisten von Radiosendern automatisch ein, normalisiert sie und wertet sie aus. Es richtet sich an **Radiosender**, **Musikredakteure** und alle, die verstehen wollen, was im Radio gerade gespielt wird.

| Anwendungsfall | Beschreibung |
|---|---|
| **Airplay-Analyse** | Wie oft läuft ein Song bei welchem Sender? Wann war der Peak? |
| **Trend-Erkennung** | Welche Songs gewinnen gerade an Rotation? Was verliert? |
| **Exklusiv-Tracks** | Welche Songs spielt nur dein Sender — und sonst niemand? |
| **Verpasste Songs** | Was läuft bei anderen Sendern oft, aber bei dir noch gar nicht? |
| **Mein Sender** | Vergleich deines eigenen Senders mit dem gesamten Markt |
| **Neue Titel** | Welche Songs sind diese Woche neu ins Radio gekommen? |
| **Wochenberichte** | Automatisch generierte Berichte mit Top-Tracks und Bewegungen |

---

## Screenshots

### Dashboard — Track-Katalog

Durchsuchbare, sortierbare Liste aller Tracks mit Plays, Plays/Tag und Last-Seen. Die Kennzahlen (Gefundene Titel, Einsätze, Künstler) stehen direkt über der Tabelle. Per Klick auf „Öffnen" gelangt man zur Song-Detail-Seite. Winner/Loser-Buttons für schnelles Track-Merging direkt in der Tabelle.

![Dashboard Light](docs/screenshots/dashboard.png)

![Dashboard Dark](docs/screenshots/dashboard-dark.png)

---

### Song-Detail — Performance & Analyse

Jeder Track hat eine eigene Seite mit Score (0–100), Momentum, Sender-Breite und allen Plays-Metriken.

![Song-Detail Light](docs/screenshots/track-detail.png)

![Song-Detail Dark](docs/screenshots/track-detail-dark.png)

Weiter unten: Kumulierter Verlauf, Plays pro Zeitraum und Sender-Vergleich als Balkendiagramme.

![Song-Detail Charts](docs/screenshots/track-detail-charts.png)

---

### Neue Titel

Alle Songs, die in einem bestimmten Zeitraum zum ersten Mal gespielt wurden — filterbar nach Sender, Release-Datum, Einsatzhäufigkeit und Qualitäts-Score.

![Neue Titel](docs/screenshots/new-titles.png)

---

### Mein Sender

Wähle deinen Sender aus und vergleiche ihn mit dem Rest des Markts. Zeigt verpasste Tracks, Geheimtipps und Sender-spezifische Rotation.

![Mein Sender](docs/screenshots/my-station.png)

---

### Wochenberichte

Automatisch generierte Übersichten mit Top-Tracks, Neueinsteigern, Absteigern und Sender-Vergleich — für jede abgelaufene Woche abrufbar.

![Wochenberichte Light](docs/screenshots/weekly-reports.png)

![Wochenberichte Dark](docs/screenshots/weekly-reports-dark.png)

---

## Schnellstart

### Voraussetzungen

- Node.js 20+
- npm

```bash
node -v   # sollte 20+ zeigen
npm -v
```

### Installation

```bash
git clone https://github.com/dergabriel/music-scraper.git
cd music-scraper
npm install
```

### Konfiguration

Kopiere die Beispielkonfiguration und passe sie an:

```bash
cp config.yaml.example config.yaml
```

Mindestens einen Sender in `config.yaml` eintragen — siehe [Sender hinzufügen](docs/add-station.md).

Optionale Umgebungsvariablen (`.env` oder Shell-Export):

| Variable | Beschreibung | Standard |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify API Client-ID | — |
| `SPOTIFY_CLIENT_SECRET` | Spotify API Client-Secret | — |
| `YRPA_VERIFY_ALL_TRACKS` | Alle Tracks gegen iTunes/Spotify prüfen (statt nur verdächtige) | `0` |
| `YRPA_TRACK_VERIFY` | Track-Verifikation aktivieren (`0` = aus) | `1` |
| `YRPA_DEDUP_COOLDOWN_SECONDS` | Cooldown-Fenster für Dedup in Sekunden | `900` |
| `LOG_LEVEL` | Pino Log-Level (`info`, `debug`, …) | `info` |

### Starten

```bash
node src/cli.js api --config config.yaml --db music-scraper.sqlite --port 8787
```

Der Server startet auf Port `8787`. Beim ersten Start werden automatisch die Playlisten der konfigurierten Sender eingesammelt.

### Seiten

| Seite | Pfad |
|---|---|
| Dashboard | `/dashboard` |
| Neue Titel | `/new-titles` |
| Mein Sender | `/my-station` |
| Wochenberichte | `/weekly-reports` |
| API Docs | `/api/docs` |

> Der interne Cron läuft stündlich automatisch — kein externer Cronjob nötig.

---

## CLI-Befehle

Alle Befehle laufen über `node src/cli.js <befehl> [optionen]`.

### `api` — Webserver starten

```bash
node src/cli.js api --config config.yaml --db music-scraper.sqlite --port 8787
```

Startet den Express-Server inklusive automatischem Startup-Ingest und Wartung.

| Option | Beschreibung | Standard |
|---|---|---|
| `--config` | Pfad zur `config.yaml` | — (Pflicht) |
| `--db` | Pfad zur SQLite-Datenbankdatei | `yrpa.sqlite` |
| `--port` | HTTP-Port | `8787` |
| `--no-startup-report` | Kein automatischer Ingest beim Start | — |

---

### `ingest` — Playlisten einlesen

```bash
node src/cli.js ingest --config config.yaml --db music-scraper.sqlite
```

Ruft alle konfigurierten Sender ab und schreibt neue Plays in die Datenbank.

---

### `daily-job` — Tagesroutine

```bash
node src/cli.js daily-job --config config.yaml --db music-scraper.sqlite --make-report
```

Führt Ingest, Wartung, Tagesauswertung und optional Wochenbericht in einem Schritt aus. Geeignet für einen täglichen Cronjob.

| Option | Beschreibung |
|---|---|
| `--make-report` | Wochenbericht für die aktuelle Woche erstellen |
| `--audit-coverage` | Coverage-Audit für gestern durchführen |

---

### `maintain-db` — Datenbank-Wartung

```bash
node src/cli.js maintain-db --db music-scraper.sqlite [--dry-run]
```

Führt alle Wartungsroutinen aus: Noise-Bereinigung, Duplikat-Merge, Canonical-Map-Refresh, Orientierungs-Korrektur (Artist/Title-Dreher), Release-Datum-Backfill.

| Option | Beschreibung | Standard |
|---|---|---|
| `--dry-run` | Nur Vorschau, keine Schreibvorgänge | — |
| `--max-pairs` | Maximale Merge-Paare pro Lauf | `5000` |

---

### `backfill-deezer` — Deezer-Backfill für Altdaten

Gleicht alle bestehenden Tracks gegen die öffentliche Deezer-API ab und korrigiert dabei Interpreten-Dreher, Sender-Zusätze im Titelnamen und Schreibfehler-Varianten. Der Lauf ist **wiederaufnehmbar** — bereits geprüfte Tracks werden übersprungen.

```bash
# Erst Dry-Run zur Sichtung:
node src/cli.js backfill-deezer --db music-scraper.sqlite --dry-run --limit 200

# Echter Lauf (in Chargen empfohlen wegen Rate-Limiting):
node src/cli.js backfill-deezer --db music-scraper.sqlite --no-dry-run --limit 500
```

| Option | Beschreibung | Standard |
|---|---|---|
| `--dry-run` | Nur Vorschau — kein versehentliches Schreiben | `true` |
| `--no-dry-run` | Änderungen tatsächlich in die DB schreiben | — |
| `--limit N` | Maximale Anzahl Tracks pro Lauf | alle |
| `--cache-days N` | Tracks jünger als N Tage überspringen | `30` |

Bei HTTP 429 pausiert das Skript automatisch mit exponentiellem Backoff.

---

### `report` / `report-station` — Wochenbericht generieren

```bash
node src/cli.js report --config config.yaml --db music-scraper.sqlite --week-start 2025-05-19 --csv
node src/cli.js report-station --config config.yaml --db music-scraper.sqlite --station-id dlf_nova --week-start 2025-05-19
```

---

### `cleanup-station` — Sender-Duplikate bereinigen

```bash
node src/cli.js cleanup-station --station-id dlf_nova --db music-scraper.sqlite --min-gap-seconds 150
```

---

## Datenqualität & Normalisierung

Die Kernkomponente `src/normalize.js` bereinigt Rohdaten aus verschiedenen Quellen in ein einheitliches Format. Folgende Probleme werden automatisch behandelt:

| Problem | Beispiel roh | Ergebnis |
|---|---|---|
| Groß-/Kleinschreibung & Whitespace | `"  The WEEKND "` | `the weeknd` |
| Feature-Guests im Titel | `"Song ft. Guest"` | `song` |
| Remix-/Edit-Klammern | `"Track (Radio Edit)"` | `track` |
| Promo-Marker | `"*NEU* Song"` | `song` |
| Chart-Platzierungen im Titel | `"TOP 799 SIMPLE LIFE"` | `simple life` |
| Jahreszahlen in Klammern | `"No Scrubs (1999)"` | `no scrubs` |
| Apostroph-Jahreszahlen | `"Wonderful Life '25"` | `wonderful life` |
| Slash in Künstlernamen | `"huntr/x"`, `"AC/DC"` | bleibt ein Name (`huntr-x`, `ac-dc`) |
| Slash als Trennzeichen | `"Artist A / Artist B"` | zwei Artists |
| Abkürzungen mit Leerzeichen | `"T L C"` | `tlc` |
| Trailing-Dash-Artefakte | `"leony -"` | `leony` |
| Remix-Prefix im Artistfeld | `"Notion Remix - Chrystal x Notion"` | `chrystal & notion` |
| Joiner-Varianten | `&`, `,`, `;`, ` x `, ` and ` | einheitlicher Artist-Key |
| Tippfehler-Varianten | `"dj jose"` vs `"dj josa"` | Levenshtein-1-Toleranz beim Matching |
| Interpreten-Dreher | Artist/Title vertauscht | Korrektur via Deezer/iTunes |

Der `canonicalTrackKey` (SHA-1-Hash aus normalisiertem Artist + Title) ist die stabile Identität eines Tracks in der Datenbank — unabhängig davon, wie verschiedene Sender denselben Song benennen.

---

## Deezer-Integration

Jeder neu ingested Track wird gegen die **öffentliche Deezer-API** abgeglichen (kein API-Key nötig). Bei einem sicheren Treffer (Confidence ≥ 0.8) wird die saubere Deezer-Schreibweise als kanonische Identität übernommen.

- **Throttling**: max. 45 Requests / 5 Sekunden (unter dem öffentlichen Limit von 50/5s)
- **Caching**: geprüfte Tracks werden 6 Stunden lang nicht erneut abgefragt
- **Swap-Erkennung**: bei keinem Treffer wird automatisch Artist/Title vertauscht probiert
- **Backfill**: `backfill-deezer`-Befehl korrigiert vorhandene Altdaten

Die Confidence-Gewichtung: Titel 45 %, Primary-Artist 25 %, Artist-Overlap 20 %, Dauer 10 %.

---

## Datenbankschema (Übersicht)

| Tabelle | Inhalt |
|---|---|
| `plays` | Jeder einzelne Airplay-Eintrag (Station, Zeitpunkt, Artist, Title, TrackKey) |
| `track_metadata` | Metadaten pro Track: ISRC, Deezer-ID, Spotify-ID, Release-Datum, Genre, Confidence |
| `canonical_map` | Mapping von normalisierten Varianten auf den kanonischen TrackKey |
| `daily_track_stats` | Tagesaggregat pro Track und Sender |
| `daily_overall_track_stats` | Tagesaggregat pro Track über alle Sender |
| `daily_station_stats` | Tagesaggregat pro Sender (Plays, Unique Tracks) |
| `blocked_tracks` | Dauerhaft gesperrte Tracks (werden beim Ingest übersprungen) |
| `stations` | Senderliste mit Name, URL, Timezone |

---

## Dokumentation

- [Setup & Installation](docs/setup.md) — Schritt-für-Schritt-Einrichtung
- [Neuen Sender hinzufügen](docs/add-station.md) — Sender konfigurieren

---

## Technologie

| Schicht | Stack |
|---|---|
| **Runtime** | Node.js 20, ES Modules |
| **Web-Framework** | Express 4 |
| **Datenbank** | SQLite via better-sqlite3 |
| **Frontend** | Vanilla JS, React (CDN), Chakra UI |
| **HTTP-Fetcher** | undici, Playwright (für JS-gerenderte Seiten) |
| **HTML-Parsing** | cheerio |
| **Logging** | pino |
| **Tests** | Vitest (98 Tests, alle grün) |
| **Externe APIs** | Deezer (öffentlich, kein Key), Spotify (optional), iTunes Search |

### Unterstützte Parser

| Parser-ID | Sender-Typ |
|---|---|
| `onlineradiobox` | Die meisten DE/AT/UK-Sender über onlineradiobox.com |
| `dlf_nova` | Deutschlandfunk Nova |
| `nrwlokalradios_json` | NRW Lokalradios (JSON-API) |
| `lautfm_json` | laut.fm-Sender |
| `radiomenu` | radio.menu-Sender (z.B. Capital FM) |
| `generic_html` | Generisches HTML-Parsing |
| `generic_html_or_onlineradiobox` | Automatische Erkennung |

---

## Lizenz

MIT
