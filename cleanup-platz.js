/**
 * cleanup-platz.js
 *
 * Bereinigt fehlerhafte Einträge in der plays-Tabelle, die durch den Platz-Bug entstanden:
 *   1. "(Platz N)" im title_raw → entfernen
 *   2. "TITLE (Platz N)" im artist_raw + echter Artist im title_raw → tauschen + "(Platz N)" entfernen
 *
 * Nach dem Fix werden track_key, artist, title und dedup_song_key neu berechnet.
 *
 * Aufruf: node cleanup-platz.js [--dry-run] [--db /pfad/zur/db.sqlite]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { normalizeArtistTitle } from './src/normalize.js';
import { buildFallbackSongKey } from './src/dedup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : path.join(__dirname, 'music-scraper.sqlite');

console.log(`DB: ${dbPath}`);
console.log(`Mode: ${dryRun ? 'DRY RUN (keine Änderungen)' : 'LIVE'}\n`);

const db = openDb(dbPath);

function stripPlatzSuffix(text) {
  return String(text ?? '').replace(/\s*\(platz\s+\d+\)\s*$/i, '').trim();
}

// ── Fall 1: "(Platz N)" im title_raw ─────────────────────────────────────────
// artist_raw ist korrekt, title_raw hat das Suffix
const titlePlatzRows = db.prepare(`
  SELECT id, station_id, artist_raw, title_raw, track_key, dedup_song_key
  FROM plays
  WHERE title_raw LIKE '%(Platz %'
`).all();

console.log(`Fall 1 (Platz im Titel): ${titlePlatzRows.length} Einträge`);

let fixed1 = 0;
let deleted1 = 0;

for (const row of titlePlatzRows) {
  const cleanTitle = stripPlatzSuffix(row.title_raw);
  const { artist, title, trackKey } = normalizeArtistTitle(row.artist_raw, cleanTitle);
  const dedupSongKey = buildFallbackSongKey(artist, title);

  // Prüfe ob nach dem Fix bereits ein identischer Eintrag existiert
  const existing = db.prepare(`
    SELECT id FROM plays
    WHERE station_id = ? AND played_at_utc = (SELECT played_at_utc FROM plays WHERE id = ?)
      AND track_key = ? AND id != ?
  `).get(row.station_id, row.id, trackKey, row.id);

  if (existing) {
    // Duplikat → alten Eintrag löschen
    if (!dryRun) {
      db.prepare('DELETE FROM plays WHERE id = ?').run(row.id);
    }
    deleted1++;
  } else {
    if (!dryRun) {
      db.prepare(`
        UPDATE plays
        SET title_raw = ?, title = ?, track_key = ?, dedup_song_key = ?
        WHERE id = ?
      `).run(cleanTitle, title, trackKey, dedupSongKey, row.id);
    }
    fixed1++;
  }
}

console.log(`  → ${fixed1} korrigiert, ${deleted1} als Duplikat gelöscht\n`);

// ── Fall 2: "TITLE (Platz N)" im artist_raw, echter Artist im title_raw ──────
const artistPlatzRows = db.prepare(`
  SELECT id, station_id, artist_raw, title_raw, track_key, dedup_song_key
  FROM plays
  WHERE artist_raw LIKE '%(Platz %'
`).all();

console.log(`Fall 2 (Platz im Artist = vertauscht): ${artistPlatzRows.length} Einträge`);

let fixed2 = 0;
let deleted2 = 0;

for (const row of artistPlatzRows) {
  // artist_raw enthält eigentlich den Titel (+ Platz-Suffix), title_raw den Artist
  const realArtist = row.title_raw;
  const realTitle = stripPlatzSuffix(row.artist_raw);

  const { artist, title, trackKey } = normalizeArtistTitle(realArtist, realTitle);
  const dedupSongKey = buildFallbackSongKey(artist, title);

  const playedAtUtc = db.prepare('SELECT played_at_utc FROM plays WHERE id = ?').get(row.id)?.played_at_utc;

  const existing = db.prepare(`
    SELECT id FROM plays
    WHERE station_id = ? AND played_at_utc = ? AND track_key = ? AND id != ?
  `).get(row.station_id, playedAtUtc, trackKey, row.id);

  if (existing) {
    if (!dryRun) {
      db.prepare('DELETE FROM plays WHERE id = ?').run(row.id);
    }
    deleted2++;
  } else {
    if (!dryRun) {
      db.prepare(`
        UPDATE plays
        SET artist_raw = ?, title_raw = ?, artist = ?, title = ?, track_key = ?, dedup_song_key = ?
        WHERE id = ?
      `).run(realArtist, realTitle, artist, title, trackKey, dedupSongKey, row.id);
    }
    fixed2++;
  }
}

console.log(`  → ${fixed2} korrigiert, ${deleted2} als Duplikat gelöscht\n`);

// ── Zusammenfassung ────────────────────────────────────────────────────────────
console.log('='.repeat(50));
console.log(`Gesamt korrigiert: ${fixed1 + fixed2}`);
console.log(`Gesamt gelöscht:   ${deleted1 + deleted2}`);
if (dryRun) {
  console.log('\n⚠ DRY RUN — keine Änderungen gespeichert. Ohne --dry-run nochmal ausführen.');
}
