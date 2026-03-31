# Neuen Sender hinzufügen

Sender werden in `config.yaml` konfiguriert. Jeder Eintrag beschreibt wie die Playlist-Daten geholt und geparst werden.

---

## Grundstruktur

```yaml
stations:
  - id: "mein_sender"
    name: "Mein Sender"
    playlist_url: "https://..."
    parser: "onlineradiobox"
    fetcher: "http"
    timezone: "Europe/Berlin"
```

### Pflichtfelder

| Feld | Beschreibung |
|---|---|
| `id` | Eindeutiger Bezeichner (nur Kleinbuchstaben, Unterstrich) |
| `name` | Anzeigename im Dashboard |
| `playlist_url` | URL der Playlist-Seite |
| `parser` | Welcher Parser wird verwendet (siehe unten) |
| `fetcher` | `http` für normale Seiten, `playwright` für JS-gerenderte Seiten |
| `timezone` | Zeitzone des Senders (meist `Europe/Berlin`) |

### Optionale Felder

| Feld | Standard | Beschreibung |
|---|---|---|
| `fallback_urls` | `[]` | Alternative URLs wenn Haupt-URL nicht erreichbar |
| `min_play_gap_seconds` | `0` | Mindestabstand zwischen zwei Plays desselben Tracks |
| `enforce_one_play_per_minute` | `false` | Maximal ein Play pro Minute erlauben |
| `my_station` | `false` | Markiert diesen Sender als "Mein Sender" für den Vergleich |

---

## Verfügbare Parser

| Parser | Wofür |
|---|---|
| `onlineradiobox` | Sender auf onlineradiobox.com |
| `generic_html_or_onlineradiobox` | Versucht onlineradiobox, fällt auf generisches HTML zurück |
| `generic_html` | Beliebige HTML-Playlist-Seiten |
| `dlf_nova` | Deutschlandfunk Nova |
| `fluxfm` | FluxFM |
| `nrwlokalradios_json` | NRW Lokalradios JSON-API |
| `lautfm_json` | laut.fm JSON-API |

---

## Beispiele

### Sender von onlineradiobox.com

Die meisten deutschen Sender sind dort verfügbar. URL-Schema:

```
https://onlineradiobox.com/de/SENDERNAME/playlist/
```

```yaml
- id: "energy_berlin"
  name: "Energy Berlin"
  playlist_url: "https://onlineradiobox.com/de/energy1034/playlist/"
  parser: "onlineradiobox"
  fetcher: "http"
  timezone: "Europe/Berlin"
```

### Sender mit Fallback-URL

Falls die Haupt-URL manchmal nicht erreichbar ist:

```yaml
- id: "radio_ffn"
  name: "radio ffn"
  playlist_url: "https://onlineradiobox.com/de/radioffn/playlist/"
  fallback_urls:
    - "https://onlineradiobox.com/de/ffn/playlist/"
    - "https://www.phonostar.de/radio/radio-ffn/titel"
  parser: "generic_html_or_onlineradiobox"
  fetcher: "http"
  timezone: "Europe/Berlin"
```

### Sender von laut.fm

```yaml
- id: "mein_lautfm_sender"
  name: "Mein Sender"
  playlist_url: "https://api.laut.fm/station/SENDERNAME/last_songs"
  parser: "lautfm_json"
  fetcher: "http"
  timezone: "Europe/Berlin"
```

Die Stream-URL (`https://stream.laut.fm/SENDERNAME`) funktioniert **nicht** — immer die API-URL verwenden.

### "Mein Sender" für den Vergleich

Einen Sender als eigenen Sender markieren (wird auf der "Mein Sender"-Seite verwendet):

```yaml
- id: "mein_sender"
  name: "Mein Sender"
  playlist_url: "https://onlineradiobox.com/de/meinsender/playlist/"
  parser: "onlineradiobox"
  fetcher: "http"
  timezone: "Europe/Berlin"
  my_station: true
```

Nur ein Sender sollte `my_station: true` haben. Die Auswahl kann auch direkt im Browser auf der "Mein Sender"-Seite getroffen werden (wird als Cookie gespeichert).

---

## Sender-URL finden

Wenn du nicht weißt welche URL funktioniert:

1. **onlineradiobox.com** durchsuchen — die meisten deutschen Sender sind dort gelistet
2. Playlist-URL im Browser öffnen und prüfen ob Titel sichtbar sind
3. Mit `parser: "generic_html_or_onlineradiobox"` starten — funktioniert für die meisten Seiten

---

## Nach dem Hinzufügen

1. Ingest starten um erste Daten zu sammeln:

```bash
node src/cli.js ingest --config config.yaml --db yrpa.sqlite
```

2. Im Dashboard unter **Statistik** den neuen Sender auswählen und prüfen ob Plays ankommen.

3. Falls keine Plays — `playlist_url` im Browser prüfen und ggf. `fallback_urls` oder anderen Parser testen.
