import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb, upsertStation, insertPlayIgnore, upsertTrackMetadata } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import {
  runTrackOrientationMaintenance,
  runNoisePlayCleanup,
  runPromoMarkerMaintenance,
  runCanonicalArtistMaintenance,
  runMergeDuplicateTracksMaintenance,
  runTitleVariantMergeMaintenance
} from '../src/services.js';

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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-maintain-'));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-cleanup-'));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-promo-'));
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

  it('merges quoted title variants into canonical track key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-quotes-'));
    const dbPath = path.join(tmp, 'quotes.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'fritz_rbb',
      name: 'Fritz (RBB)',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonicalKey = addPlay(db, {
      stationId: 'fritz_rbb',
      playedAtUtcIso: '2026-02-27T08:00:00.000Z',
      artistRaw: 'Dermot Kennedy',
      titleRaw: 'Funeral'
    });
    const quotedLegacyKey = crypto
      .createHash('sha1')
      .update('dermot kennedy||"funeral"', 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'fritz_rbb',
      '2026-02-27T09:00:00.000Z',
      'Dermot Kennedy',
      '"Funeral"',
      'dermot kennedy',
      '"funeral"',
      quotedLegacyKey,
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
    expect(rows[0].title).toBe('funeral');
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merges event suffix title variants (radio 1 big weekend) into canonical track key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-event-suffix-'));
    const dbPath = path.join(tmp, 'event-suffix.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'bbc_radio_1',
      name: 'BBC Radio 1',
      playlist_url: 'https://example.test',
      timezone: 'Europe/London'
    });

    const canonicalKey = addPlay(db, {
      stationId: 'bbc_radio_1',
      playedAtUtcIso: '2026-02-27T08:00:00.000Z',
      artistRaw: 'James Hype',
      titleRaw: 'Ferrari'
    });
    const legacyTitle = "ferrari (radio 1's big weekend, 23 may 2025)";
    const legacyEventKey = crypto
      .createHash('sha1')
      .update(`james hype||${legacyTitle}`, 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'bbc_radio_1',
      '2026-02-27T09:00:00.000Z',
      'James Hype',
      "Ferrari (Radio 1's Big Weekend, 23 May 2025)",
      'james hype',
      legacyTitle,
      legacyEventKey,
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
    expect(rows[0].title).toBe('ferrari');
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merges legacy artist-joiner variants into canonical artist track key and rebuilds daily rows', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-canonical-artist-'));
    const dbPath = path.join(tmp, 'canonical.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('milleniumkid & jbs', 'vielleicht vielleicht');
    const legacyArtist = 'milleniumkid x jbs';
    const legacyTitle = 'vielleicht vielleicht';
    const legacyKey = crypto.createHash('sha1').update(`${legacyArtist}||${legacyTitle}`, 'utf8').digest('hex');

    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'planet_radio',
      '2026-03-01T08:00:00.000Z',
      'milleniumkid & jbs',
      'vielleicht vielleicht',
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-01T09:00:00.000Z'
    );
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'planet_radio',
      '2026-03-01T10:00:00.000Z',
      legacyArtist,
      legacyTitle,
      legacyArtist,
      legacyTitle,
      legacyKey,
      'https://example.test',
      '2026-03-01T11:00:00.000Z'
    );

    db.prepare(`
      insert into daily_track_stats(date_berlin, station_id, track_key, artist, title, plays)
      values (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
    `).run(
      '2026-03-01', 'planet_radio', canonical.trackKey, canonical.artist, canonical.title, 1,
      '2026-03-01', 'planet_radio', legacyKey, legacyArtist, legacyTitle, 1
    );
    db.prepare(`
      insert into daily_overall_track_stats(date_berlin, track_key, artist, title, plays)
      values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
    `).run(
      '2026-03-01', canonical.trackKey, canonical.artist, canonical.title, 1,
      '2026-03-01', legacyKey, legacyArtist, legacyTitle, 1
    );
    db.prepare(`
      insert into backpool_track_catalog(
        station_id, track_key, station_name, artist, title, classification,
        analysis_from_berlin, analysis_to_berlin, analyzed_at_utc, range_days,
        plays, plays_per_day, active_days, span_days, cadence_days,
        first_played_at_utc, last_played_at_utc, release_date_utc,
        verified_exists, verification_confidence, metadata_issue,
        is_rotation_backpool, is_release_backpool, is_low_rotation_release_backpool
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'planet_radio', legacyKey, 'Planet Radio', legacyArtist, legacyTitle, 'sparse_rotation',
      '2026-02-24', '2026-03-01', '2026-03-01T12:00:00.000Z', 7,
      1, 0.14, 1, 1, null,
      '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z', null,
      null, null, null,
      0, 0, 0
    );
    upsertTrackMetadata(db, {
      track_key: canonical.trackKey,
      artist: canonical.artist,
      title: canonical.title,
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.9,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2024-01-01T00:00:00.000Z',
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
      last_checked_utc: '2026-03-01T12:00:00.000Z'
    });
    upsertTrackMetadata(db, {
      track_key: legacyKey,
      artist: legacyArtist,
      title: legacyTitle,
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
      last_checked_utc: '2026-03-01T12:00:00.000Z'
    });
    db.close();

    const dry = runCanonicalArtistMaintenance({ dbPath, dryRun: true });
    expect(dry.candidates).toBeGreaterThanOrEqual(1);

    const live = runCanonicalArtistMaintenance({ dbPath, dryRun: false });
    expect(live.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const playRows = check.prepare(`
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      group by track_key
    `).all();
    expect(playRows.length).toBe(1);
    expect(playRows[0].track_key).toBe(canonical.trackKey);
    expect(playRows[0].artist).toBe(canonical.artist);
    expect(playRows[0].title).toBe(canonical.title);
    expect(playRows[0].plays).toBe(2);

    const dailyRow = check.prepare(`
      select track_key, artist, title, plays
      from daily_track_stats
      where date_berlin = '2026-03-01' and station_id = 'planet_radio'
    `).get();
    expect(dailyRow.track_key).toBe(canonical.trackKey);
    expect(dailyRow.artist).toBe(canonical.artist);
    expect(dailyRow.title).toBe(canonical.title);
    expect(dailyRow.plays).toBe(2);

    const overallDailyRow = check.prepare(`
      select track_key, artist, title, plays
      from daily_overall_track_stats
      where date_berlin = '2026-03-01'
    `).get();
    expect(overallDailyRow.track_key).toBe(canonical.trackKey);
    expect(overallDailyRow.artist).toBe(canonical.artist);
    expect(overallDailyRow.title).toBe(canonical.title);
    expect(overallDailyRow.plays).toBe(2);

    const loserMeta = check.prepare('select track_key from track_metadata where track_key = ?').get(legacyKey);
    expect(loserMeta).toBeUndefined();
    const loserBackpool = check.prepare('select track_key from backpool_track_catalog where track_key = ?').get(legacyKey);
    expect(loserBackpool).toBeUndefined();
    check.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merges title variants with subset artist lists for no broke boys', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-title-variant-subset-'));
    const dbPath = path.join(tmp, 'subset.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('disco lines & tinashe', 'no broke boys');
    const legacyKey = crypto
      .createHash('sha1')
      .update('disco lines||no broke boys', 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'planet_radio',
      '2026-03-01T08:00:00.000Z',
      'Disco Lines & Tinashe',
      'No Broke Boys',
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-01T09:00:00.000Z',
      'planet_radio',
      '2026-03-01T10:00:00.000Z',
      'Disco Lines',
      'No Broke Boys',
      'disco lines',
      'no broke boys',
      legacyKey,
      'https://example.test',
      '2026-03-01T11:00:00.000Z'
    );
    db.close();

    const result = runTitleVariantMergeMaintenance({ dbPath, dryRun: false, minOverlap: 0.6 });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      where title = 'no broke boys'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonical.trackKey);
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("merges i'm good and i'm good (blue) into one track key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-title-variant-blue-'));
    const dbPath = path.join(tmp, 'blue.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'energy_berlin',
      name: 'Energy Berlin',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('bebe rexha & david guetta', "i'm good");
    const legacyKey = crypto
      .createHash('sha1')
      .update("bebe rexha & david guetta||i'm good (blue)", 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'energy_berlin',
      '2026-03-01T08:00:00.000Z',
      'Bebe Rexha & David Guetta',
      "I'm Good",
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-01T09:00:00.000Z',
      'energy_berlin',
      '2026-03-01T10:00:00.000Z',
      'Bebe Rexha & David Guetta',
      "I'm Good (Blue)",
      'bebe rexha & david guetta',
      "i'm good (blue)",
      legacyKey,
      'https://example.test',
      '2026-03-01T11:00:00.000Z'
    );
    db.close();

    const result = runTitleVariantMergeMaintenance({ dbPath, dryRun: false, minOverlap: 0.6 });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(title) as title, count(*) as plays
      from plays
      where artist like 'bebe rexha%'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonical.trackKey);
    expect(rows[0].title).toBe("i'm good");
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merges kernkraft 400 with a better day suffix into one track key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-title-variant-kernkraft-'));
    const dbPath = path.join(tmp, 'kernkraft.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'rtl_89_0',
      name: '89.0 RTL',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('a7s & topic', 'kernkraft 400');
    const legacyKey = crypto
      .createHash('sha1')
      .update('a7s & topic||kernkraft 400 (a better day)', 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rtl_89_0',
      '2026-03-01T08:00:00.000Z',
      'A7S & Topic',
      'Kernkraft 400',
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-01T09:00:00.000Z',
      'rtl_89_0',
      '2026-03-01T10:00:00.000Z',
      'A7S & Topic',
      'Kernkraft 400 (A Better Day)',
      'a7s & topic',
      'kernkraft 400 (a better day)',
      legacyKey,
      'https://example.test',
      '2026-03-01T11:00:00.000Z'
    );
    db.close();

    const result = runTitleVariantMergeMaintenance({ dbPath, dryRun: false, minOverlap: 0.6 });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(title) as title, count(*) as plays
      from plays
      where artist = 'a7s & topic'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonical.trackKey);
    expect(rows[0].title).toBe('kernkraft 400');
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merges punctuation-only title variants like where is my husband!', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-title-variant-punctuation-'));
    const dbPath = path.join(tmp, 'punct.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: '1live',
      name: '1Live',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('raye', 'where is my husband');
    const legacyKey = crypto
      .createHash('sha1')
      .update('raye||where is my husband!', 'utf8')
      .digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '1live',
      '2026-03-01T08:00:00.000Z',
      'RAYE',
      'Where Is My Husband',
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-01T09:00:00.000Z',
      '1live',
      '2026-03-01T10:00:00.000Z',
      'RAYE',
      'Where Is My Husband!',
      'raye',
      'where is my husband!',
      legacyKey,
      'https://example.test',
      '2026-03-01T11:00:00.000Z'
    );
    db.close();

    const result = runTitleVariantMergeMaintenance({ dbPath, dryRun: false, minOverlap: 0.6 });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      where artist = 'raye'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonical.trackKey);
    expect(rows[0].title).toBe('where is my husband');
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merge duplicate maintenance merges disco lines subset artist variants', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-merge-dup-subset-'));
    const dbPath = path.join(tmp, 'subset.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('disco lines & tinashe', 'no broke boys');
    const legacyKey = crypto.createHash('sha1').update('disco lines||no broke boys', 'utf8').digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'planet_radio',
      '2026-03-02T08:00:00.000Z',
      'Disco Lines & Tinashe',
      'No Broke Boys',
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-02T09:00:00.000Z',
      'planet_radio',
      '2026-03-02T10:00:00.000Z',
      'Disco Lines',
      'No Broke Boys',
      'disco lines',
      'no broke boys',
      legacyKey,
      'https://example.test',
      '2026-03-02T11:00:00.000Z'
    );
    db.close();

    const result = runMergeDuplicateTracksMaintenance({ dbPath, dryRun: false });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, count(*) as plays
      from plays
      where title = 'no broke boys'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonical.trackKey);
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("merge duplicate maintenance merges love story + taylor's version legacy key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-merge-dup-love-story-'));
    const dbPath = path.join(tmp, 'love-story.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'swr3',
      name: 'SWR3',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('taylor swift', 'love story');
    const legacyKey = crypto
      .createHash('sha1')
      .update("taylor swift||love story (taylor's version)", 'utf8')
      .digest('hex');

    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'swr3',
      '2026-03-02T08:00:00.000Z',
      'Taylor Swift',
      'Love Story',
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-02T09:00:00.000Z',
      'swr3',
      '2026-03-02T10:00:00.000Z',
      'Taylor Swift',
      "Love Story (Taylor's Version)",
      'taylor swift',
      "love story (taylor's version)",
      legacyKey,
      'https://example.test',
      '2026-03-02T11:00:00.000Z'
    );
    db.close();

    const result = runMergeDuplicateTracksMaintenance({ dbPath, dryRun: false });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(title) as title, count(*) as plays
      from plays
      where artist = 'taylor swift'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].track_key).toBe(canonical.trackKey);
    expect(rows[0].title).toBe('love story');
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merge duplicate maintenance does not merge adele hello with lionel richie hello', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-merge-dup-no-false-positive-'));
    const dbPath = path.join(tmp, 'hello.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'radio_hamburg',
      name: 'Radio Hamburg',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    addPlay(db, {
      stationId: 'radio_hamburg',
      playedAtUtcIso: '2026-03-02T08:00:00.000Z',
      artistRaw: 'Adele',
      titleRaw: 'Hello'
    });
    addPlay(db, {
      stationId: 'radio_hamburg',
      playedAtUtcIso: '2026-03-02T10:00:00.000Z',
      artistRaw: 'Lionel Richie',
      titleRaw: 'Hello'
    });
    db.close();

    const result = runMergeDuplicateTracksMaintenance({ dbPath, dryRun: false });
    expect(result.merged).toBe(0);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      where title = 'hello'
      group by track_key
      order by artist asc
    `).all();
    check.close();
    expect(rows.length).toBe(2);
    expect(rows[0].artist).toBe('adele');
    expect(rows[1].artist).toBe('lionel richie');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('merge duplicate maintenance merges when canonical_id matches', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-merge-dup-canonical-id-'));
    const dbPath = path.join(tmp, 'canonical-id.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'energy_berlin',
      name: 'Energy Berlin',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const a = normalizeArtistTitle('disco lines & tinashe', 'no broke boys');
    const b = normalizeArtistTitle('disco lines & djsomeone', 'no broke boys');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'energy_berlin',
      '2026-03-02T08:00:00.000Z',
      'Disco Lines & Tinashe',
      'No Broke Boys',
      a.artist,
      a.title,
      a.trackKey,
      'https://example.test',
      '2026-03-02T09:00:00.000Z',
      'energy_berlin',
      '2026-03-02T10:00:00.000Z',
      'Disco Lines & DJSomeone',
      'No Broke Boys',
      b.artist,
      b.title,
      b.trackKey,
      'https://example.test',
      '2026-03-02T11:00:00.000Z'
    );

    upsertTrackMetadata(db, {
      track_key: a.trackKey,
      artist: a.artist,
      title: a.title,
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.8,
      external_track_id: 'itunes:12345',
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
      chart_country: null,
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-03-02T12:00:00.000Z'
    });
    upsertTrackMetadata(db, {
      track_key: b.trackKey,
      artist: b.artist,
      title: b.title,
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.7,
      external_track_id: 'itunes:12345',
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
      chart_country: null,
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-03-02T12:00:00.000Z'
    });
    db.close();

    const result = runMergeDuplicateTracksMaintenance({ dbPath, dryRun: false });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, count(*) as plays
      from plays
      where title = 'no broke boys'
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("merge duplicate maintenance merges apostrophe variants (don't vs dont)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-merge-dup-apostrophe-'));
    const dbPath = path.join(tmp, 'apostrophe.sqlite');
    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'youfm',
      name: 'YOU FM',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const canonical = normalizeArtistTitle('raye', "don't leave");
    const legacyKey = crypto.createHash('sha1').update('raye||dont leave', 'utf8').digest('hex');
    db.prepare(`
      insert into plays(
        station_id, played_at_utc, artist_raw, title_raw, artist, title, track_key, source_url, ingested_at_utc
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'youfm',
      '2026-03-03T08:00:00.000Z',
      'RAYE',
      "Don't Leave",
      canonical.artist,
      canonical.title,
      canonical.trackKey,
      'https://example.test',
      '2026-03-03T09:00:00.000Z',
      'youfm',
      '2026-03-03T10:00:00.000Z',
      'RAYE',
      'Dont Leave',
      'raye',
      'dont leave',
      legacyKey,
      'https://example.test',
      '2026-03-03T11:00:00.000Z'
    );
    db.close();

    const result = runMergeDuplicateTracksMaintenance({ dbPath, dryRun: false });
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const check = openDb(dbPath);
    const rows = check.prepare(`
      select track_key, count(*) as plays
      from plays
      group by track_key
    `).all();
    check.close();
    expect(rows.length).toBe(1);
    expect(rows[0].plays).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
