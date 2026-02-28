import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb, upsertStation, insertPlayIgnore, upsertTrackMetadata } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import { runTrackOrientationMaintenance, runNoisePlayCleanup, runPromoMarkerMaintenance } from '../src/services.js';

function addPlay(db, { stationId, playedAtUtcIso, artistRaw, titleRaw }) {
  const normalized = normalizeArtistTitle(artistRaw, titleRaw);
  insertPlayIgnore(db, {
    station_id: stationId,
    played_at_utc: playedAtUtcIso,
    artist_raw: artistRaw,
    title_raw: titleRaw,
    artist: normalized.artist,
    title: normalized.title,
    track_key: normalized.trackKey,
    source_url: 'https://example.test',
    ingested_at_utc: '2026-02-28T10:00:00.000Z'
  });
  return normalized.trackKey;
}

describe('database maintenance', () => {
  it('merges swapped artist-title track keys automatically', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yrpa-maintain-'));
    const dbPath = path.join(tmp, 'maint.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const correctKey = addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T08:00:00.000Z',
      artistRaw: 'Bruno Mars',
      titleRaw: 'I Just Might'
    });
    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T09:00:00.000Z',
      artistRaw: 'Bruno Mars',
      titleRaw: 'I Just Might'
    });
    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T10:00:00.000Z',
      artistRaw: 'Bruno Mars',
      titleRaw: 'I Just Might'
    });
    const swappedKey = addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T11:00:00.000Z',
      artistRaw: 'I Just Might',
      titleRaw: 'Bruno Mars'
    });

    upsertTrackMetadata(db, {
      track_key: correctKey,
      artist: 'bruno mars',
      title: 'i just might',
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.99,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2025-01-01T00:00:00.000Z',
      genre: 'Pop',
      album: null,
      label: null,
      duration_ms: null,
      preview_url: null,
      isrc: null,
      popularity_score: null,
      chart_airplay_rank: null,
      chart_single_rank: null,
      chart_country: 'DE',
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-02-28T10:00:00.000Z'
    });
    upsertTrackMetadata(db, {
      track_key: swappedKey,
      artist: 'i just might',
      title: 'bruno mars',
      verified_exists: 0,
      verification_source: 'test',
      verification_confidence: 0.1,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: null,
      genre: null,
      album: null,
      label: null,
      duration_ms: null,
      preview_url: null,
      isrc: null,
      popularity_score: null,
      chart_airplay_rank: null,
      chart_single_rank: null,
      chart_country: 'DE',
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-02-28T10:00:00.000Z'
    });
    db.close();

    const result = runTrackOrientationMaintenance({ dbPath });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      group by track_key
      order by plays desc
    `).all();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(correctKey);
    expect(rows[0].artist).toBe('bruno mars');
    expect(rows[0].title).toBe('i just might');
    expect(rows[0].plays).toBe(4);

    const loserMeta = check.prepare('select track_key from track_metadata where track_key = ?').get(swappedKey);
    expect(loserMeta).toBeUndefined();
    check.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('removes garbage playlist rows with embedded website/script text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yrpa-cleanup-'));
    const dbPath = path.join(tmp, 'cleanup.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T08:00:00.000Z',
      artistRaw: 'Tate McRae',
      titleRaw: 'Just Keep Watching'
    });
    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T09:00:00.000Z',
      artistRaw: 'Tate McRae',
      titleRaw: 'Just Keep Watching freestar.config.enabled_slots.push({ placementName: "x", slotId: "x" });'
    });
    db.close();

    const dry = runNoisePlayCleanup({ dbPath, dryRun: true });
    expect(dry.found).toBe(1);
    expect(dry.removed).toBe(0);

    const live = runNoisePlayCleanup({ dbPath, dryRun: false });
    expect(live.removed).toBe(1);

    const check = openDb(dbPath);
    const remaining = check.prepare('select count(*) as c from plays').get()?.c ?? 0;
    check.close();
    expect(remaining).toBe(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merges promo-marker variants like *neu* into canonical track key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yrpa-promo-'));
    const dbPath = path.join(tmp, 'promo.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonicalKey = addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-27T08:00:00.000Z',
      artistRaw: 'Robin Schulz',
      titleRaw: 'Embers'
    });
    const legacyPromoKey = crypto
      .createHash('sha1')
      .update('robin schulz||*neu* embers', 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'planet_radio',
      '2026-02-27T09:00:00.000Z',
      'Robin Schulz',
      '*NEU* Embers',
      'robin schulz',
      '*neu* embers',
      legacyPromoKey,
      'https://example.test',
      '2026-02-28T10:00:00.000Z'
    );
    db.close();

    const dry = runPromoMarkerMaintenance({ dbPath, dryRun: true });
    expect(dry.candidates).toBe(1);

    const live = runPromoMarkerMaintenance({ dbPath, dryRun: false });
    expect(live.merged).toBe(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonicalKey);
    expect(rows[0].title).toBe('embers');
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
