# Setup & Installation

## Voraussetzungen

- Node.js 20+
- npm

```bash
node -v  # sollte v20 oder höher zeigen
npm -v
```

---

## 1. Installation

```bash
git clone https://github.com/dergabriel/music-scraper.git
cd music-scraper
npm install
```

Tests prüfen ob alles korrekt installiert ist:

```bash
npm test
```

---

## 2. Ersten Ingest starten

Playlist-Daten von allen konfigurierten Sendern einlesen:

```bash
node src/cli.js ingest --config config.yaml --db yrpa.sqlite
```

Die Daten landen in `yrpa.sqlite`. Beim ersten Lauf dauert das je nach Sender-Anzahl 1–3 Minuten.

---

## 3. Tagesauswertung

Damit die Charts im Dashboard Daten zeigen, muss einmal `evaluate-daily` laufen:

```bash
node src/cli.js evaluate-daily --db yrpa.sqlite --date 2026-03-31
```

Für mehrere vergangene Tage auf einmal (Linux/macOS):

```bash
for i in $(seq 0 13); do
  date=$(date -d "$i days ago" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d)
  node src/cli.js evaluate-daily --db yrpa.sqlite --date $date
done
```

---

## 4. Dashboard starten

```bash
node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8787
```

Browser öffnen:

| Seite | URL |
|---|---|
| Dashboard | `http://localhost:8787/dashboard` |
| Statistik | `http://localhost:8787/tracks` |
| Neue Titel | `http://localhost:8787/new-titles` |
| Mein Sender | `http://localhost:8787/my-station` |
| Wochenberichte | `http://localhost:8787/weekly-reports` |
| API Docs | `http://localhost:8787/api/docs` |

> Der Server startet einen internen Cron der stündlich automatisch neue Daten einliest. Kein externer Cronjob nötig.

---

## macOS: Doppelklick-Start

Für den täglichen Betrieb ohne Terminal:

1. **`setup-music-scraper.command`** — einmalig ausführen (installiert Abhängigkeiten)
2. **`start-music-scraper-api.command`** — startet Server + Dashboard

---

## Server-Betrieb (Linux/PM2)

Für dauerhaften Betrieb auf einem Server:

```bash
npm install -g pm2
pm2 start "node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8787" --name music-scraper
pm2 save
pm2 startup
```

Updates einspielen:

```bash
git pull && pm2 restart music-scraper
```

---

## Alle CLI-Befehle

```bash
# Playlist-Daten einlesen
node src/cli.js ingest --config config.yaml --db yrpa.sqlite

# Tagesauswertung (Charts befüllen)
node src/cli.js evaluate-daily --db yrpa.sqlite --date YYYY-MM-DD

# Wochenreport erzeugen
node src/cli.js report --config config.yaml --week-start YYYY-MM-DD --csv

# Datenpflege (Dubletten, Noise, Jingles entfernen)
node src/cli.js maintain-db --db yrpa.sqlite

# Kombinierter Tagesjob
node src/cli.js daily-job --config config.yaml --db yrpa.sqlite --make-report

# Coverage prüfen
node src/cli.js audit-coverage --config config.yaml --date YYYY-MM-DD
```

---

## Typische Probleme

### Charts zeigen "Keine Daten im Zeitraum"

`evaluate-daily` wurde noch nicht ausgeführt. Siehe Schritt 3.

### Keine Plays bei einem Sender

- `playlist_url` im Browser aufrufen und prüfen ob sie erreichbar ist
- `fallback_urls` ergänzen (siehe [Sender hinzufügen](add-station.md))
- Parser wechseln zu `generic_html_or_onlineradiobox`

### Port bereits belegt

```bash
node src/cli.js api --config config.yaml --db yrpa.sqlite --port 8788
```

### Viele Junk-Titel oder Jingles

```bash
node src/cli.js maintain-db --db yrpa.sqlite
```

---

## Nächste Schritte

- [Neuen Sender hinzufügen](add-station.md)
- [API-Endpunkte erkunden](http://localhost:8787/api/docs)
