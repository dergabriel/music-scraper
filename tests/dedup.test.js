import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, upsertStation, insertPlayIgnore } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import {
  buildFallbackSongKey,
  shouldDedupByCooldown,
  DEFAULT_DEDUP_COOLDOWN_SECONDS
} from '../src/dedup.js';

function addCountedPlay(db, {
  stationId,
  playedAtUtcIso,
  artistRaw,
  titleRaw
}) {
  const normalized = normalizeArtistTitle(artistRaw, titleRaw);
  const songKey = buildFallbackSongKey(normalized.artist, normalized.title);
  insertPlayIgnore(db, {
    station_id: stationId,
    played_at_utc: playedAtUtcIso,
    artist_raw: artistRaw,
    title_raw: titleRaw,
    artist: normalized.artist,
    title: normalized.title,
    track_key: normalized.trackKey,
    dedup_song_key: songKey,
    source_url: 'https://example.test',
    ingested_at_utc: '2026-03-04T10:00:00.000Z'
  });
  return { normalized, songKey };
}

describe('cooldown dedup', () => {
  it('dedups same station and same song within 15 minutes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-dedup-1-'));
    const dbPath = path.join(tmp, 'dedup.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'station_a',
      name: 'Station A',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const { songKey } = addCountedPlay(db, {
      stationId: 'station_a',
      playedAtUtcIso: '2026-03-04T10:00:00.000Z',
      artistRaw: 'RAYE',
      titleRaw: "Don't Leave"
    });

    const decision = shouldDedupByCooldown({
      db,
      stationId: 'station_a',
      songKey,
      eventPlayedAtUtcIso: '2026-03-04T10:02:00.000Z',
      cooldownSeconds: DEFAULT_DEDUP_COOLDOWN_SECONDS
    });
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(decision.deduped).toBe(true);
    expect(decision.deltaSeconds).toBe(120);
  });

  it('does not dedup same station and same song after 16 minutes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-dedup-2-'));
    const dbPath = path.join(tmp, 'dedup.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'station_a',
      name: 'Station A',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const { songKey } = addCountedPlay(db, {
      stationId: 'station_a',
      playedAtUtcIso: '2026-03-04T10:00:00.000Z',
      artistRaw: 'RAYE',
      titleRaw: 'Escapism'
    });

    const decision = shouldDedupByCooldown({
      db,
      stationId: 'station_a',
      songKey,
      eventPlayedAtUtcIso: '2026-03-04T10:16:00.000Z',
      cooldownSeconds: DEFAULT_DEDUP_COOLDOWN_SECONDS
    });
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(decision.deduped).toBe(false);
    expect(decision.deltaSeconds).toBe(960);
  });

  it('does not dedup across two different stations', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-dedup-3-'));
    const dbPath = path.join(tmp, 'dedup.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'station_a',
      name: 'Station A',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });
    upsertStation(db, {
      id: 'station_b',
      name: 'Station B',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const { songKey } = addCountedPlay(db, {
      stationId: 'station_a',
      playedAtUtcIso: '2026-03-04T10:00:00.000Z',
      artistRaw: 'A7S & Topic',
      titleRaw: 'Kernkraft 400'
    });

    const decision = shouldDedupByCooldown({
      db,
      stationId: 'station_b',
      songKey,
      eventPlayedAtUtcIso: '2026-03-04T10:00:00.000Z',
      cooldownSeconds: DEFAULT_DEDUP_COOLDOWN_SECONDS
    });
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(decision.deduped).toBe(false);
    expect(decision.lastCountedAtUtc).toBe(null);
  });

  it('normalizes writing variants robustly for fallback song key', () => {
    const a = buildFallbackSongKey('Raye', "Where  Is   My Husband!");
    const b = buildFallbackSongKey('RAYE', 'where is my husband');
    const c = buildFallbackSongKey('raye', 'where is my husband?!');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

