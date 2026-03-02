import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, upsertStation, insertPlayIgnore, getStationTrackCounts, getStationTotalPlays, getOverallTrackCounts } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import { buildWeekRanges } from '../src/time.js';
import { buildStationAnalytics, buildCrossStationAnalytics } from '../src/analytics.js';
import { writeMarkdownReport, writeCsvExports } from '../src/report.js';

function addPlay(db, { stationId, playedAtUtcIso, artistRaw, titleRaw, sourceUrl = 'https://example.test' }) {
  const normalized = normalizeArtistTitle(artistRaw, titleRaw);
  return insertPlayIgnore(db, {
    station_id: stationId,
    played_at_utc: playedAtUtcIso,
    artist_raw: artistRaw,
    title_raw: titleRaw,
    artist: normalized.artist,
    title: normalized.title,
    track_key: normalized.trackKey,
    source_url: sourceUrl,
    ingested_at_utc: '2026-02-23T10:00:00.000Z'
  });
}

describe('e2e pipeline', () => {
  it('builds weekly analytics, report files, csv exports and preserves ingest idempotency', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-e2e-'));
    const dbPath = path.join(tmp, 'music-scraper.sqlite');
    const reportsDir = path.join(tmp, 'reports');
    const csvDir = path.join(reportsDir, 'csv');

    const stations = [
      {
        id: 'dlf_nova',
        name: 'Deutschlandfunk Nova',
        playlist_url: 'https://www.deutschlandfunknova.de/playlist',
        timezone: 'Europe/Berlin'
      },
      {
        id: 'fluxfm',
        name: 'FluxFM',
        playlist_url: 'https://www.fluxfm.de/playlist',
        timezone: 'Europe/Berlin'
      }
    ];

    const db = openDb(dbPath);
    for (const station of stations) upsertStation(db, station);

    // Previous week (2026-02-09 .. 2026-02-16 Europe/Berlin)
    addPlay(db, {
      stationId: 'dlf_nova',
      playedAtUtcIso: '2026-02-10T09:00:00.000Z',
      artistRaw: 'Moderat',
      titleRaw: 'Bad Kingdom'
    });
    addPlay(db, {
      stationId: 'dlf_nova',
      playedAtUtcIso: '2026-02-10T10:00:00.000Z',
      artistRaw: 'Bonobo',
      titleRaw: 'Cirrus'
    });
    addPlay(db, {
      stationId: 'fluxfm',
      playedAtUtcIso: '2026-02-11T09:30:00.000Z',
      artistRaw: 'Roosevelt',
      titleRaw: 'Fever'
    });

    // Current week (2026-02-16 .. 2026-02-23 Europe/Berlin)
    addPlay(db, {
      stationId: 'dlf_nova',
      playedAtUtcIso: '2026-02-17T09:00:00.000Z',
      artistRaw: 'Moderat',
      titleRaw: 'Bad Kingdom'
    });
    addPlay(db, {
      stationId: 'dlf_nova',
      playedAtUtcIso: '2026-02-17T09:15:00.000Z',
      artistRaw: 'Moderat',
      titleRaw: 'Bad Kingdom'
    });
    addPlay(db, {
      stationId: 'dlf_nova',
      playedAtUtcIso: '2026-02-17T09:30:00.000Z',
      artistRaw: 'Fontaines D.C.',
      titleRaw: 'Starburster'
    });
    addPlay(db, {
      stationId: 'fluxfm',
      playedAtUtcIso: '2026-02-18T07:00:00.000Z',
      artistRaw: 'Roosevelt',
      titleRaw: 'Fever'
    });
    addPlay(db, {
      stationId: 'fluxfm',
      playedAtUtcIso: '2026-02-18T07:15:00.000Z',
      artistRaw: 'Fontaines D.C.',
      titleRaw: 'Starburster'
    });

    // Idempotency check: same play inserted twice -> second insert ignored
    const firstInsert = addPlay(db, {
      stationId: 'fluxfm',
      playedAtUtcIso: '2026-02-18T07:30:00.000Z',
      artistRaw: 'Pixies',
      titleRaw: 'Here Comes Your Man'
    });
    const secondInsert = addPlay(db, {
      stationId: 'fluxfm',
      playedAtUtcIso: '2026-02-18T07:30:00.000Z',
      artistRaw: 'Pixies',
      titleRaw: 'Here Comes Your Man'
    });

    expect(firstInsert).toBe(1);
    expect(secondInsert).toBe(0);

    const ranges = buildWeekRanges('2026-02-16');
    const stationAnalytics = stations.map((station) => {
      const currentRows = getStationTrackCounts(db, station.id, ranges.current.startUtcIso, ranges.current.endUtcIso);
      const previousRows = getStationTrackCounts(db, station.id, ranges.previous.startUtcIso, ranges.previous.endUtcIso);
      const totalPlays = getStationTotalPlays(db, station.id, ranges.current.startUtcIso, ranges.current.endUtcIso);
      return buildStationAnalytics({ station, currentRows, previousRows, currentTotalPlays: totalPlays });
    });

    const overallTopRows = getOverallTrackCounts(db, ranges.current.startUtcIso, ranges.current.endUtcIso);
    const crossAnalytics = buildCrossStationAnalytics(stationAnalytics, overallTopRows);

    const reportPath = path.join(reportsDir, '2026-02-16_weekly.md');
    writeMarkdownReport({
      weekStart: '2026-02-16',
      outputPath: reportPath,
      stationAnalytics,
      crossAnalytics,
      dataQuality: {
        scrapeErrors: 0,
        stationPlays: stationAnalytics.map((s) => ({ stationName: s.station.name, totalPlays: s.totalPlays }))
      }
    });

    writeCsvExports({ csvDir, stationAnalytics, crossAnalytics });

    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(path.join(csvDir, 'dlf_nova_top_tracks.csv'))).toBe(true);
    expect(fs.existsSync(path.join(csvDir, 'fluxfm_top_tracks.csv'))).toBe(true);
    expect(fs.existsSync(path.join(csvDir, 'overall_top_50.csv'))).toBe(true);

    const report = fs.readFileSync(reportPath, 'utf8');
    expect(report).toContain('Music Scraper, Woche ab 2026-02-16');
    expect(report).toContain('## Deutschlandfunk Nova');
    expect(report).toContain('## FluxFM');
    expect(report).toContain('## Cross Station Trends');

    const expectedNewTrack = normalizeArtistTitle('Fontaines D.C.', 'Starburster');
    const dlf = stationAnalytics.find((s) => s.station.id === 'dlf_nova');
    expect(dlf.totalPlays).toBe(3);
    expect(dlf.newTracks.some((t) => t.artist === expectedNewTrack.artist && t.title === expectedNewTrack.title)).toBe(true);

    const sharedNew = crossAnalytics.newInMultipleStations.find(
      (t) => t.artist === expectedNewTrack.artist && t.title === expectedNewTrack.title
    );
    expect(sharedNew).toBeTruthy();
    expect(sharedNew.stationCount).toBe(2);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
