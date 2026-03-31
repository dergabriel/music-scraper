# Music Scraper

**Radio-Analyse-Tool für Sender, die wissen wollen, was gerade läuft.**

> Dieses Tool ist durch Vibecoding entstanden — entwickelt mit Claude als KI-Partner, der den Code größtenteils geschrieben hat, während die Ideen und Anforderungen von einem Radiosender kamen.

---

## Was ist Music Scraper?

Music Scraper ist ein Open-Source-Tool, das Playlisten von Radiosendern automatisch einsammelt, normalisiert und auswertet. Es richtet sich an **Radiosender**, **Musikredakteure** und alle, die verstehen wollen, was im Radio gerade gespielt wird.

### Wofür ist das gut?

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

```
Dashboard → Statistik → Neue Titel → Mein Sender → Wochenberichte
```

Alle Seiten sind über das Dashboard erreichbar unter `http://localhost:8787`.

---

## Schnellstart

### Voraussetzungen

- Node.js 20+
- npm

```bash
node -v  # sollte 20+ zeigen
npm -v
```

### Installation

```bash
git clone https://github.com/dergabriel/music-scraper.git
cd music-scraper
npm install
```

### Starten

```bash
node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8787
```

Browser öffnen:

- **Dashboard** → `http://localhost:8787/dashboard`
- **Statistik** → `http://localhost:8787/tracks`
- **Neue Titel** → `http://localhost:8787/new-titles`
- **Mein Sender** → `http://localhost:8787/my-station`
- **Wochenberichte** → `http://localhost:8787/weekly-reports`
- **API Docs** → `http://localhost:8787/api/docs`

> Der interne Cron läuft stündlich automatisch — kein externer Cronjob nötig.

---

## Dokumentation

- [Setup & Installation](docs/setup.md) — Schritt-für-Schritt-Einrichtung
- [Neuen Sender hinzufügen](docs/add-station.md) — Sender konfigurieren
- [API-Endpunkte](http://localhost:8787/api/docs) — alle REST-Endpoints

---

## Funktionsübersicht

### Dashboard
Überblick über alle Sender: Top-Tracks, tägliche Plays, Trends, Song-Performance. Jeder Track ist klickbar — zeigt Verlauf, Sender-Vergleich und Metadaten.

### Statistik
Durchsuchbares Track-Archiv mit Filterung nach Sender, Zeitraum und Genre.

### Neue Titel
Alle Songs, die in einem bestimmten Zeitraum zum ersten Mal gespielt wurden — gefiltert nach Release-Datum, Sender und Relevanz.

### Mein Sender
Das Kernstück für Redakteure: Wähle deinen eigenen Sender und vergleiche ihn direkt mit dem Rest.

- **Verpasste Tracks** — Songs die andere Sender oft spielen, dein Sender aber nicht
- **Geheimtipps** — Songs die nur dein Sender (oder kaum jemand sonst) spielt
- Sender-Auswahl wird im Browser gespeichert

### Wochenberichte
Automatisch generierte Markdown/CSV-Berichte mit Top-Tracks, Neueinsteigern und Absteigern.

---

## Technologie

- **Backend**: Node.js, Express, SQLite (better-sqlite3)
- **Frontend**: Vanilla JS, Chakra UI, Plotly
- **Datensammlung**: HTTP-Fetcher + Playwright für JS-gerenderte Seiten
- **Parser**: onlineradiobox, DLF Nova, laut.fm JSON, NRW Lokalradios, generisches HTML

---

## Lizenz

MIT
