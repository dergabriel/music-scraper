import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDb, upsertStation, insertPlayIgnore, upsertTrackMetadata } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';
import { createApiApp, createApiHandlers } from '../src/api.js';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-api-test-'));
}

function mkRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function addPlay(db, { stationId, playedAtUtcIso, artistRaw, titleRaw }) {
  const normalized = normalizeArtistTitle(artistRaw, titleRaw);
  return insertPlayIgnore(db, {
    station_id: stationId,
    played_at_utc: playedAtUtcIso,
    artist_raw: artistRaw,
    title_raw: titleRaw,
    artist: normalized.artist,
    title: normalized.title,
    track_key: normalized.trackKey,
    source_url: 'https://example.test',
    ingested_at_utc: '2026-02-25T10:00:00.000Z'
  });
}

describe('api handlers', () => {
  it('serves all core endpoints and daily evaluation', async () => {
    const tmp = mkTmp();
    const dbPath = path.join(tmp, 'api.sqlite');
    const configPath = path.join(tmp, 'config.yaml');

    fs.writeFileSync(
      configPath,
      [
        'stations:',
        '  - id: "planet_radio"',
        '    name: "Planet Radio"',
        '    playlist_url: "https://example.test"',
        '    parser: "generic_html"',
        '    fetcher: "http"',
        '    timezone: "Europe/Berlin"',
        ''
      ].join('\n'),
      'utf8'
    );

    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'planet_radio',
      name: 'Planet Radio',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-23T08:00:00.000Z',
      artistRaw: 'Bruno Mars',
      titleRaw: 'I Just Might'
    });
    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-23T09:00:00.000Z',
      artistRaw: 'Bruno Mars',
      titleRaw: 'I Just Might'
    });
    addPlay(db, {
      stationId: 'planet_radio',
      playedAtUtcIso: '2026-02-24T09:00:00.000Z',
      artistRaw: 'The Newcomer',
      titleRaw: 'Fresh Wave'
    });

    const oldKey = normalizeArtistTitle('Bruno Mars', 'I Just Might').trackKey;
    const freshKey = normalizeArtistTitle('The Newcomer', 'Fresh Wave').trackKey;
    upsertTrackMetadata(db, {
      track_key: oldKey,
      artist: 'bruno mars',
      title: 'i just might',
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.99,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2020-01-01T00:00:00.000Z',
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
      last_checked_utc: '2026-02-25T10:00:00.000Z'
    });
    upsertTrackMetadata(db, {
      track_key: freshKey,
      artist: 'the newcomer',
      title: 'fresh wave',
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.99,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2026-01-15T00:00:00.000Z',
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
      last_checked_utc: '2026-02-25T10:00:00.000Z'
    });
    db.close();

    const logger = pino({ level: 'silent' });
    const h = createApiHandlers({ configPath, dbPath, logger });
    const app = createApiApp({ configPath, dbPath, logger });
    const routePaths = app._router.stack
      .filter((layer) => layer.route?.path)
      .map((layer) => layer.route.path);
    expect(routePaths).toContain('/dashboard');
    expect(routePaths).toContain('/backpool');
    expect(routePaths).toContain('/tracks');
    expect(routePaths).toContain('/new-titles');
    expect(routePaths).toContain('/api/tracks');

    const healthRes = mkRes();
    h.health({}, healthRes);
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.body.ok).toBe(true);

    const docsRes = mkRes();
    h.docs({}, docsRes);
    expect(docsRes.statusCode).toBe(200);
    expect(Array.isArray(docsRes.body.endpoints)).toBe(true);
    expect(docsRes.body.endpoints.some((x) => x.includes('/api/tracks?'))).toBe(true);

    const stationsRes = mkRes();
    h.stations({}, stationsRes);
    expect(stationsRes.statusCode).toBe(200);
    expect(stationsRes.body.length).toBe(1);

    const newWeekRes = mkRes();
    h.newThisWeek({ query: { weekStart: '2026-02-23', stationId: 'planet_radio', limit: '20', releaseYear: '2026' } }, newWeekRes);
    expect(newWeekRes.statusCode).toBe(200);
    expect(Array.isArray(newWeekRes.body.rows)).toBe(true);
    expect(newWeekRes.body.rows.some((row) => row.track_key === oldKey)).toBe(false);
    expect(newWeekRes.body.rows.some((row) => row.track_key === freshKey)).toBe(true);

    const searchBadRes = mkRes();
    h.search({ query: {} }, searchBadRes);
    expect(searchBadRes.statusCode).toBe(400);

    const searchRes = mkRes();
    h.search({ query: { q: 'bruno' } }, searchRes);
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.body.length).toBe(1);

    const trackKey = searchRes.body[0].track_key;

    const tracksRes = mkRes();
    h.tracks({ query: { limit: '50' } }, tracksRes);
    expect(tracksRes.statusCode).toBe(200);
    expect(tracksRes.body.length).toBe(2);
    expect(tracksRes.body[0].track_key).toBe(trackKey);

    const seriesRes = mkRes();
    h.trackSeries(
      {
        params: { trackKey },
        query: { bucket: 'day', from: '2026-02-22', to: '2026-02-24' }
      },
      seriesRes
    );
    expect(seriesRes.statusCode).toBe(200);
    expect(seriesRes.body.series.length).toBeGreaterThan(0);

    const seriesByStationRes = mkRes();
    h.trackSeriesByStation(
      {
        params: { trackKey },
        query: { bucket: 'day', from: '2026-02-22', to: '2026-02-24', limit: '10' }
      },
      seriesByStationRes
    );
    expect(seriesByStationRes.statusCode).toBe(200);
    expect(Array.isArray(seriesByStationRes.body.stations)).toBe(true);
    expect(seriesByStationRes.body.stations.length).toBeGreaterThan(0);

    const totalsRes = mkRes();
    h.trackTotals({ params: { trackKey }, query: { from: '2026-01-01', to: '2026-12-31' } }, totalsRes);
    expect(totalsRes.statusCode).toBe(200);
    expect(totalsRes.body.totals.allTime).toBe(2);

    const stationsBreakdownRes = mkRes();
    h.trackStations({ params: { trackKey }, query: { from: '2026-01-01', to: '2026-12-31' } }, stationsBreakdownRes);
    expect(stationsBreakdownRes.statusCode).toBe(200);
    expect(stationsBreakdownRes.body.stations.length).toBe(1);
    expect(stationsBreakdownRes.body.stations[0].plays).toBe(2);

    const metaRes = mkRes();
    h.trackMeta({ params: { trackKey } }, metaRes);
    expect(metaRes.statusCode).toBe(200);
    expect(metaRes.body.trackKey).toBe(trackKey);

    const stationReportRes = mkRes();
    h.stationReport({ params: { stationId: 'planet_radio' }, query: { weekStart: '2026-02-23' } }, stationReportRes);
    expect(stationReportRes.statusCode).toBe(200);
    expect(stationReportRes.body.report.station.id).toBe('planet_radio');

    const backpoolRes = mkRes();
    await h.backpool(
      {
        query: {
          stationId: 'planet_radio',
          from: '2026-01-01',
          to: '2026-02-24',
          years: '1',
          minPlays: '1',
          top: '5'
        }
      },
      backpoolRes
    );
    expect(backpoolRes.statusCode).toBe(200);
    expect(Array.isArray(backpoolRes.body.rows)).toBe(true);
    expect(backpoolRes.body.rows.length).toBe(1);
    expect(backpoolRes.body.rows[0].stationId).toBe('planet_radio');

    const evalRes = mkRes();
    await h.evaluateDaily({ body: { date: '2026-02-23' } }, evalRes);
    expect(evalRes.statusCode).toBe(200);
    expect(evalRes.body.ok).toBe(true);

    const verifyDb = openDb(dbPath);
    const dailyRows = verifyDb.prepare('select count(*) as c from daily_station_stats where date_berlin = ?').get('2026-02-23');
    verifyDb.close();
    expect(dailyRows.c).toBe(1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
