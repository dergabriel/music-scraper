import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createRequire } from 'node:module';
import { DateTime } from 'luxon';
import {
  openDb,
  listStations,
  searchTracks,
  listTracks,
  getTrackPlays,
  getTrackIdentity,
  getTrackMetadata,
  getTrackStationCounts,
  listNewTitles,
  getNewTracksInWeek,
  listBackpoolTrackCatalog,
  listBackpoolStationSummary
} from './db.js';
import { BERLIN_TZ, buildWeekRanges } from './time.js';
import { buildTrackSeries, buildTrackSeriesByStation, buildTrackTotals } from './trends.js';
import { runDailyEvaluation, runBackpoolAnalysis, runManualTrackMerge } from './services.js';
import { loadConfig } from './config.js';
import { buildStationAnalytics } from './analytics.js';
import { TrackVerifier } from './trackVerifier.js';

const BUCKETS = new Set(['day', 'week', 'month', 'year']);
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function safeQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseRange(from, to) {
  const fromValue = safeQueryValue(from);
  const toValue = safeQueryValue(to);

  const end = toValue
    ? DateTime.fromISO(String(toValue), { zone: BERLIN_TZ }).plus({ days: 1 }).startOf('day')
    : DateTime.now().setZone(BERLIN_TZ).plus({ days: 1 }).startOf('day');
  const start = fromValue
    ? DateTime.fromISO(String(fromValue), { zone: BERLIN_TZ }).startOf('day')
    : end.minus({ days: 90 });

  if (!start.isValid || !end.isValid || end <= start) {
    throw new Error('Invalid from/to date range. Use YYYY-MM-DD.');
  }

  return {
    startUtcIso: start.toUTC().toISO(),
    endUtcIso: end.toUTC().toISO()
  };
}

function parseNumberInRange(rawValue, fallback, min, max) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function classifyGrowth(growthPercent) {
  if (growthPercent > 30) return 'hot';
  if (growthPercent < -30) return 'dropping';
  return 'stable';
}

function computeTrackTrend(db, trackKey, nowBerlin = DateTime.now().setZone(BERLIN_TZ)) {
  const nowUtcIso = nowBerlin.toUTC().toISO();
  const last48Start = nowBerlin.minus({ hours: 48 }).toUTC().toISO();
  const prev48Start = nowBerlin.minus({ hours: 96 }).toUTC().toISO();
  const prev48End = nowBerlin.minus({ hours: 48 }).toUTC().toISO();
  const last14Start = nowBerlin.minus({ days: 14 }).toUTC().toISO();

  const playsLast48h = db.prepare(`
    select count(*) as c
    from plays
    where track_key = ?
      and played_at_utc >= ?
      and played_at_utc < ?
  `).get(trackKey, last48Start, nowUtcIso)?.c ?? 0;
  const playsPrev48h = db.prepare(`
    select count(*) as c
    from plays
    where track_key = ?
      and played_at_utc >= ?
      and played_at_utc < ?
  `).get(trackKey, prev48Start, prev48End)?.c ?? 0;
  const playsLast14d = db.prepare(`
    select count(*) as c
    from plays
    where track_key = ?
      and played_at_utc >= ?
      and played_at_utc < ?
  `).get(trackKey, last14Start, nowUtcIso)?.c ?? 0;

  const avgPlaysLast14d = playsLast14d / 14;
  const currentDailyRate = playsLast48h / 2;
  const growthPercent = avgPlaysLast14d > 0
    ? ((currentDailyRate - avgPlaysLast14d) / avgPlaysLast14d) * 100
    : (currentDailyRate > 0 ? 100 : 0);

  return {
    plays_last_48h: Number(playsLast48h),
    avg_plays_last_14d: Number(avgPlaysLast14d.toFixed(3)),
    growth_percent: Number(growthPercent.toFixed(2)),
    previous_48h: Number(playsPrev48h),
    status: classifyGrowth(growthPercent)
  };
}

export function createApiHandlers({ configPath, dbPath, logger }) {
  const backpoolInFlight = new Map();
  const backpoolCache = new Map();
  const BACKPOOL_CACHE_TTL_MS = 20 * 1000;

  function toBackpoolKey(payload) {
    return JSON.stringify(payload);
  }

  return {
    health: (_req, res) => {
      res.json({ ok: true, time: new Date().toISOString() });
    },

    docs: (_req, res) => {
      res.json({
        name: 'Music Scraper API',
        pages: ['GET /dashboard', 'GET /backpool', 'GET /tracks', 'GET /new-titles'],
        endpoints: [
          'GET /api/health',
          'GET /api/docs',
          'GET /api/stations',
          'GET /api/tracks?limit=100&q=QUERY&stationId=ID&includeTrackKey=TRACK_KEY',
          'GET /api/new-titles?from=YYYY-MM-DD&to=YYYY-MM-DD&station=ID&limit=250&minPlays=1&q=QUERY&requireReleaseDate=1&maxReleaseAgeDays=730&minReleaseConfidence=0.55',
          'GET /api/tracks/search?q=QUERY&limit=30',
          'GET /api/tracks/:trackKey/series?bucket=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/series-by-station?bucket=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=10',
          'GET /api/tracks/:trackKey/totals?from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/stations?from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/trend',
          'GET /api/tracks/:trackKey/station-divergence',
          'GET /api/tracks/:trackKey/lifecycle',
          'GET /api/tracks/:trackKey/meta',
          'POST /api/tracks/:trackKey/meta/refresh',
          'GET /api/alerts/new-cross-station?days=2&minStations=3',
          'GET /api/artists/momentum?limit=50',
          'GET /api/outliers?days=30&threshold=2.5&limit=100',
          'GET /api/stations/:stationId/profile?days=90',
          'POST /api/admin/merge-tracks {"winnerTrackKey":"...","loserTrackKey":"..."}',
          'GET /api/reports/station/:stationId?weekStart=YYYY-MM-DD',
          'GET /api/insights/new-this-week?weekStart=YYYY-MM-DD&stationId=ID&limit=20&releaseYear=YYYY&maxReleaseAgeDays=730',
          'GET /api/insights/backpool?from=YYYY-MM-DD&to=YYYY-MM-DD&years=5&minPlays=1&top=20&rotationMinDailyPlays=0.35&lowRotationMaxDailyPlays=2&rotationMinActiveDays=5&rotationMinSpanDays=28&rotationMinReleaseAgeDays=1095&minTrackAgeDays=30&rotationAdaptive=1&minConfidence=0.72&stationId=ID&hydrate=0',
          'GET /api/insights/backpool/catalog?stationId=ID&classification=rotation_backpool|hot_rotation|sparse_rotation&limit=500',
          'GET /api/insights/backpool/summary?stationId=ID',
          'POST /api/jobs/evaluate-daily {"date":"YYYY-MM-DD"}'
        ]
      });
    },

    stations: (_req, res) => {
      const db = openDb(dbPath);
      try {
        const rows = listStations(db);
        res.json(rows);
      } finally {
        db.close();
      }
    },

    tracks: (req, res) => {
      const q = String(safeQueryValue(req.query.q) ?? '').trim();
      const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
      const includeTrackKey = req.query.includeTrackKey ? String(safeQueryValue(req.query.includeTrackKey)).trim() : undefined;
      const rawLimitParam = safeQueryValue(req.query.limit);
      const limitParam = rawLimitParam == null ? '' : String(rawLimitParam).trim().toLowerCase();
      let limit = 100;
      if (limitParam === 'all' || limitParam === '0' || limitParam === 'max') {
        limit = null;
      } else if (limitParam) {
        const rawLimit = Number(limitParam);
        limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5000)) : 100;
      }

      const db = openDb(dbPath);
      try {
        const rows = listTracks(db, { query: q, stationId, limit, includeTrackKey });
        res.json(rows);
      } finally {
        db.close();
      }
    },

    newTitles: (req, res) => {
      try {
        const from = req.query.from ? String(safeQueryValue(req.query.from)) : DateTime.now().setZone(BERLIN_TZ).minus({ days: 30 }).toISODate();
        const to = req.query.to ? String(safeQueryValue(req.query.to)) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const stationId = req.query.station ? String(safeQueryValue(req.query.station)) : undefined;
        const query = String(safeQueryValue(req.query.q) ?? '').trim();
        const rawLimit = Number(safeQueryValue(req.query.limit) ?? 250);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5000)) : 250;
        const rawMinPlays = Number(safeQueryValue(req.query.minPlays) ?? 1);
        const minPlays = Number.isFinite(rawMinPlays) ? Math.max(1, Math.min(rawMinPlays, 5000)) : 1;
        const requireReleaseDate = String(safeQueryValue(req.query.requireReleaseDate) ?? '1') !== '0';
        const rawMaxReleaseAgeDays = Number(safeQueryValue(req.query.maxReleaseAgeDays) ?? 730);
        const maxReleaseAgeDays = Number.isFinite(rawMaxReleaseAgeDays)
          ? Math.max(0, Math.min(rawMaxReleaseAgeDays, 36500))
          : 730;
        const rawMinReleaseConfidence = Number(safeQueryValue(req.query.minReleaseConfidence) ?? 0.55);
        const minReleaseConfidence = Number.isFinite(rawMinReleaseConfidence)
          ? Math.max(0, Math.min(rawMinReleaseConfidence, 1))
          : 0.55;
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const db = openDb(dbPath);
        try {
          const rows = listNewTitles(db, {
            startUtcIso,
            endUtcIso,
            referenceDateIso: to,
            stationId,
            query,
            minPlays,
            limit,
            requireReleaseDate,
            maxReleaseAgeDays,
            minReleaseConfidence
          });
          return res.json({
            from,
            to,
            station: stationId ?? null,
            limit,
            minPlays,
            requireReleaseDate,
            maxReleaseAgeDays,
            minReleaseConfidence,
            rows
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    search: (req, res) => {
      const q = String(safeQueryValue(req.query.q) ?? '').trim();
      const rawLimit = Number(safeQueryValue(req.query.limit) ?? 30);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 30;

      if (!q) return res.status(400).json({ error: 'Missing q' });

      const db = openDb(dbPath);
      try {
        const rows = searchTracks(db, q, limit);
        res.json(rows);
      } finally {
        db.close();
      }
    },

    trackSeries: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const bucket = String(safeQueryValue(req.query.bucket) ?? 'day');
        if (!BUCKETS.has(bucket)) {
          return res.status(400).json({ error: 'Invalid bucket. Use day|week|month|year.' });
        }

        const { startUtcIso, endUtcIso } = parseRange(req.query.from, req.query.to);

        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const rows = getTrackPlays(db, { trackKey, stationId, startUtcIso, endUtcIso });
          return res.json({
            trackKey,
            stationId: stationId ?? null,
            bucket,
            identity,
            series: buildTrackSeries(rows, bucket)
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackTotals: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const from = req.query.from ? String(safeQueryValue(req.query.from)) : '2000-01-01';
        const to = req.query.to ? String(safeQueryValue(req.query.to)) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const rows = getTrackPlays(db, { trackKey, stationId, startUtcIso, endUtcIso });
          return res.json({
            trackKey,
            stationId: stationId ?? null,
            identity,
            totals: buildTrackTotals(rows)
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackSeriesByStation: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const bucket = String(safeQueryValue(req.query.bucket) ?? 'day');
        if (!BUCKETS.has(bucket)) {
          return res.status(400).json({ error: 'Invalid bucket. Use day|week|month|year.' });
        }
        const rawLimit = Number(safeQueryValue(req.query.limit) ?? 10);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 20)) : 10;
        const { startUtcIso, endUtcIso } = parseRange(req.query.from, req.query.to);

        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const rows = getTrackPlays(db, { trackKey, startUtcIso, endUtcIso });
          const stationRows = listStations(db);
          const stationsById = new Map(stationRows.map((row) => [row.id, row.name || row.id]));
          const grouped = buildTrackSeriesByStation(rows, stationsById, bucket);
          return res.json({
            trackKey,
            bucket,
            identity,
            periods: grouped.periods,
            stations: grouped.stations.slice(0, limit)
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackStations: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const from = req.query.from ? String(safeQueryValue(req.query.from)) : '2000-01-01';
        const to = req.query.to ? String(safeQueryValue(req.query.to)) : DateTime.now().setZone(BERLIN_TZ).toISODate();
        const { startUtcIso, endUtcIso } = parseRange(from, to);

        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const rows = getTrackStationCounts(db, { trackKey, startUtcIso, endUtcIso });
          return res.json({
            trackKey,
            identity,
            stations: rows
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackTrend: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }
          const trend = computeTrackTrend(db, trackKey);
          return res.json({ trackKey, identity, ...trend });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackStationDivergence: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days: 7 }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();

        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const trackByStation = db.prepare(`
            select station_id, count(*) as plays
            from plays
            where track_key = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by station_id
          `).all(trackKey, startUtcIso, endUtcIso);
          const totalsByStation = db.prepare(`
            select station_id, count(*) as total_plays
            from plays
            where played_at_utc >= ?
              and played_at_utc < ?
            group by station_id
          `).all(startUtcIso, endUtcIso);
          const stations = listStations(db);
          const stationNameById = new Map(stations.map((row) => [row.id, row.name || row.id]));

          const totalTrackPlays = trackByStation.reduce((sum, row) => sum + Number(row.plays || 0), 0);
          const totalStationPlays = totalsByStation.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
          const overallShare = totalStationPlays > 0 ? totalTrackPlays / totalStationPlays : 0;
          const totalByStationMap = new Map(totalsByStation.map((row) => [row.station_id, Number(row.total_plays || 0)]));

          const rows = trackByStation.map((row) => {
            const stationTotal = Number(totalByStationMap.get(row.station_id) || 0);
            const stationShare = stationTotal > 0 ? Number(row.plays || 0) / stationTotal : 0;
            const deviationPercent = overallShare > 0
              ? ((stationShare - overallShare) / overallShare) * 100
              : 0;
            return {
              station_id: row.station_id,
              station_name: stationNameById.get(row.station_id) || row.station_id,
              track_plays: Number(row.plays || 0),
              station_total_plays: stationTotal,
              station_share: Number((stationShare * 100).toFixed(3)),
              deviation_percent: Number(deviationPercent.toFixed(2))
            };
          }).sort((a, b) => Math.abs(b.deviation_percent) - Math.abs(a.deviation_percent));

          return res.json({
            trackKey,
            identity,
            window_days: 7,
            overall_share_percent: Number((overallShare * 100).toFixed(3)),
            rows
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    alertsNewCrossStation: (req, res) => {
      try {
        const days = Math.floor(parseNumberInRange(safeQueryValue(req.query.days), 2, 1, 30));
        const minStations = Math.floor(parseNumberInRange(safeQueryValue(req.query.minStations), 3, 2, 20));
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).startOf('day').toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();

        const db = openDb(dbPath);
        try {
          const rows = db.prepare(`
            select
              p.track_key,
              min(p.artist) as artist,
              min(p.title) as title,
              min(p.played_at_utc) as first_seen_utc,
              max(p.played_at_utc) as last_seen_utc,
              count(*) as plays,
              count(distinct p.station_id) as station_count
            from plays p
            where p.played_at_utc >= ?
              and p.played_at_utc < ?
            group by p.track_key
            having count(distinct p.station_id) >= ?
            order by station_count desc, plays desc, first_seen_utc asc
            limit 200
          `).all(startUtcIso, endUtcIso, minStations);
          return res.json({ days, minStations, rows });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    artistsMomentum: (req, res) => {
      try {
        const limit = Math.floor(parseNumberInRange(safeQueryValue(req.query.limit), 50, 5, 200));
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const start30 = nowBerlin.minus({ days: 30 }).toUTC().toISO();
        const prev30 = nowBerlin.minus({ days: 60 }).toUTC().toISO();
        const end = nowBerlin.toUTC().toISO();

        const db = openDb(dbPath);
        try {
          const playsNow = db.prepare(`
            select artist, count(*) as plays
            from plays
            where played_at_utc >= ?
              and played_at_utc < ?
            group by artist
          `).all(start30, end);
          const playsPrev = db.prepare(`
            select artist, count(*) as plays
            from plays
            where played_at_utc >= ?
              and played_at_utc < ?
            group by artist
          `).all(prev30, start30);
          const newTracks = db.prepare(`
            select artist, count(*) as new_tracks
            from (
              select min(artist) as artist, track_key, min(played_at_utc) as first_play
              from plays
              group by track_key
              having first_play >= ? and first_play < ?
            ) t
            group by artist
          `).all(start30, end);

          const prevMap = new Map(playsPrev.map((row) => [row.artist, Number(row.plays || 0)]));
          const newMap = new Map(newTracks.map((row) => [row.artist, Number(row.new_tracks || 0)]));
          const artists = playsNow.map((row) => ({
            artist: row.artist,
            plays_now: Number(row.plays || 0),
            plays_prev: Number(prevMap.get(row.artist) || 0),
            new_tracks: Number(newMap.get(row.artist) || 0)
          }));

          const maxPlays = Math.max(1, ...artists.map((row) => row.plays_now));
          const maxNewTracks = Math.max(1, ...artists.map((row) => row.new_tracks));
          const rows = artists.map((row) => {
            const growthRate = row.plays_prev > 0
              ? ((row.plays_now - row.plays_prev) / row.plays_prev)
              : (row.plays_now > 0 ? 1 : 0);
            const normalizedGrowth = Math.max(0, Math.min(1, (growthRate + 1) / 2));
            const score = (
              (row.plays_now / maxPlays) * 0.5 +
              (row.new_tracks / maxNewTracks) * 0.25 +
              normalizedGrowth * 0.25
            ) * 100;
            return {
              ...row,
              growth_rate_percent: Number((growthRate * 100).toFixed(2)),
              score: Number(score.toFixed(2))
            };
          })
            .sort((a, b) => b.score - a.score || b.plays_now - a.plays_now)
            .slice(0, limit);

          return res.json({ window_days: 30, rows });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackLifecycle: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }
          const row = db.prepare(`
            select
              min(played_at_utc) as first_played_at_utc,
              max(played_at_utc) as last_played_at_utc,
              count(*) as total_plays
            from plays
            where track_key = ?
          `).get(trackKey);
          const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
          const first = DateTime.fromISO(String(row?.first_played_at_utc || ''), { zone: 'utc' });
          const last = DateTime.fromISO(String(row?.last_played_at_utc || ''), { zone: 'utc' });
          const ageDays = first.isValid ? Math.max(0, Math.floor(nowBerlin.diff(first.setZone(BERLIN_TZ), 'days').days)) : 0;
          const daysSinceLastPlay = last.isValid ? Math.max(0, Math.floor(nowBerlin.diff(last.setZone(BERLIN_TZ), 'days').days)) : null;
          const trend = computeTrackTrend(db, trackKey, nowBerlin);

          let status = 'catalog';
          if (ageDays < 14) status = 'new';
          else if (ageDays < 60) status = 'active';
          if (trend.growth_percent < -30) status = 'declining';

          return res.json({
            trackKey,
            identity,
            first_played_at_utc: row?.first_played_at_utc ?? null,
            last_played_at_utc: row?.last_played_at_utc ?? null,
            total_plays: Number(row?.total_plays || 0),
            age_days: ageDays,
            days_since_last_play: daysSinceLastPlay,
            trend,
            status
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    outliers: (req, res) => {
      try {
        const days = Math.floor(parseNumberInRange(safeQueryValue(req.query.days), 30, 7, 120));
        const threshold = parseNumberInRange(safeQueryValue(req.query.threshold), 2.5, 1, 8);
        const limit = Math.floor(parseNumberInRange(safeQueryValue(req.query.limit), 100, 10, 1000));
        const startDate = DateTime.now().setZone(BERLIN_TZ).minus({ days }).toISODate();

        const db = openDb(dbPath);
        try {
          const rows = db.prepare(`
            select date_berlin, track_key, artist, title, plays
            from daily_overall_track_stats
            where date_berlin >= ?
          `).all(startDate);
          const byTrack = new Map();
          for (const row of rows) {
            if (!byTrack.has(row.track_key)) byTrack.set(row.track_key, []);
            byTrack.get(row.track_key).push(row);
          }

          const outliers = [];
          for (const [trackKey, series] of byTrack.entries()) {
            if (series.length < 5) continue;
            const values = series.map((row) => Number(row.plays || 0));
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
            const std = Math.sqrt(variance);
            if (!Number.isFinite(std) || std <= 0) continue;
            for (const row of series) {
              const z = (Number(row.plays || 0) - mean) / std;
              if (z > threshold) {
                outliers.push({
                  date_berlin: row.date_berlin,
                  track_key: trackKey,
                  artist: row.artist,
                  title: row.title,
                  plays: Number(row.plays || 0),
                  z_score: Number(z.toFixed(3)),
                  mean: Number(mean.toFixed(3)),
                  std: Number(std.toFixed(3))
                });
              }
            }
          }

          outliers.sort((a, b) => b.z_score - a.z_score);
          return res.json({
            days,
            threshold,
            rows: outliers.slice(0, limit)
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    stationProfile: (req, res) => {
      try {
        const stationId = req.params.stationId;
        const days = Math.floor(parseNumberInRange(safeQueryValue(req.query.days), 90, 30, 365));
        const nowBerlin = DateTime.now().setZone(BERLIN_TZ);
        const startUtcIso = nowBerlin.minus({ days }).toUTC().toISO();
        const endUtcIso = nowBerlin.toUTC().toISO();
        const newCutoffUtc = nowBerlin.minus({ days: 30 }).toUTC().toISO();

        const db = openDb(dbPath);
        try {
          const station = listStations(db).find((row) => row.id === stationId);
          if (!station) return res.status(404).json({ error: 'Unknown stationId' });

          const totalPlays = db.prepare(`
            select count(*) as c
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
          `).get(stationId, startUtcIso, endUtcIso)?.c ?? 0;

          const trackRows = db.prepare(`
            select
              track_key,
              min(played_at_utc) as first_played_at_utc,
              max(played_at_utc) as last_played_at_utc,
              count(*) as plays
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by track_key
          `).all(stationId, startUtcIso, endUtcIso);

          const spans = trackRows.map((row) => {
            const first = DateTime.fromISO(row.first_played_at_utc, { zone: 'utc' });
            const last = DateTime.fromISO(row.last_played_at_utc, { zone: 'utc' });
            if (!first.isValid || !last.isValid) return 0;
            return Math.max(0, last.diff(first, 'days').days);
          });
          const avgRotationLifespanDays = spans.length
            ? spans.reduce((sum, value) => sum + value, 0) / spans.length
            : 0;

          const newTracksCount = db.prepare(`
            select count(*) as c
            from (
              select track_key, min(played_at_utc) as first_station_play
              from plays
              where station_id = ?
              group by track_key
              having first_station_play >= ?
            )
          `).get(stationId, newCutoffUtc)?.c ?? 0;
          const totalTracks = trackRows.length;
          const percentNewTracks = totalTracks > 0 ? (newTracksCount / totalTracks) * 100 : 0;

          const backpoolTrackKeys = db.prepare(`
            select distinct track_key
            from backpool_track_catalog
            where station_id = ?
          `).all(stationId).map((row) => row.track_key);
          let backpoolPlays = 0;
          if (backpoolTrackKeys.length) {
            const placeholders = backpoolTrackKeys.map(() => '?').join(', ');
            backpoolPlays = db.prepare(`
              select count(*) as c
              from plays
              where station_id = ?
                and played_at_utc >= ?
                and played_at_utc < ?
                and track_key in (${placeholders})
            `).get(stationId, startUtcIso, endUtcIso, ...backpoolTrackKeys)?.c ?? 0;
          }
          const percentBackpool = totalPlays > 0 ? (backpoolPlays / totalPlays) * 100 : 0;

          const genreRows = db.prepare(`
            select coalesce(m.genre, 'Unbekannt') as genre, count(*) as plays
            from plays p
            left join track_metadata m on m.track_key = p.track_key
            where p.station_id = ?
              and p.played_at_utc >= ?
              and p.played_at_utc < ?
            group by coalesce(m.genre, 'Unbekannt')
            order by plays desc
            limit 12
          `).all(stationId, startUtcIso, endUtcIso);
          const genreTotal = genreRows.reduce((sum, row) => sum + Number(row.plays || 0), 0);
          const genres = genreRows.map((row) => ({
            genre: row.genre,
            plays: Number(row.plays || 0),
            share_percent: genreTotal > 0 ? Number(((Number(row.plays || 0) / genreTotal) * 100).toFixed(2)) : 0
          }));

          return res.json({
            station_id: stationId,
            station_name: station.name || stationId,
            window_days: days,
            total_plays: Number(totalPlays),
            total_tracks: Number(totalTracks),
            average_rotation_lifespan_days: Number(avgRotationLifespanDays.toFixed(2)),
            percent_new_tracks: Number(percentNewTracks.toFixed(2)),
            percent_backpool: Number(percentBackpool.toFixed(2)),
            genre_distribution: genres
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    adminMergeTracks: (req, res) => {
      try {
        const winnerTrackKey = String(req.body?.winnerTrackKey || '').trim();
        const loserTrackKey = String(req.body?.loserTrackKey || '').trim();
        const result = runManualTrackMerge({
          dbPath,
          winnerTrackKey,
          loserTrackKey,
          logger
        });
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    trackMeta: (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }
          const metadata = getTrackMetadata(db, trackKey);
          return res.json({
            trackKey,
            identity,
            metadata: metadata ?? null
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    refreshTrackMeta: async (req, res) => {
      try {
        const trackKey = req.params.trackKey;
        const force = String(safeQueryValue(req.query.force) ?? '1') !== '0';
        const db = openDb(dbPath);
        try {
          const identity = getTrackIdentity(db, trackKey);
          if (!identity?.artist || !identity?.title) {
            return res.status(404).json({ error: 'Unknown trackKey' });
          }

          const verifier = new TrackVerifier({ db, logger });
          const result = await verifier.enrichMetadata(
            {
              trackKey,
              artist: identity.artist,
              title: identity.title
            },
            { forceRefresh: force }
          );

          return res.json({
            trackKey,
            identity,
            metadata: result.metadata ?? null,
            fromCache: Boolean(result.fromCache)
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    newThisWeek: (req, res) => {
      try {
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const rawLimit = Number(safeQueryValue(req.query.limit) ?? 20);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
        const rawMaxReleaseAgeDays = Number(safeQueryValue(req.query.maxReleaseAgeDays) ?? 730);
        const maxReleaseAgeDays = Number.isFinite(rawMaxReleaseAgeDays)
          ? Math.max(1, Math.min(rawMaxReleaseAgeDays, 3650))
          : 730;
        const rawReleaseYear = Number(safeQueryValue(req.query.releaseYear) ?? DateTime.now().setZone(BERLIN_TZ).year);
        const releaseYear = Number.isFinite(rawReleaseYear)
          ? Math.max(1970, Math.min(Math.floor(rawReleaseYear), 2100))
          : DateTime.now().setZone(BERLIN_TZ).year;
        const weekStart = req.query.weekStart
          ? String(safeQueryValue(req.query.weekStart))
          : DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();

        const ranges = buildWeekRanges(weekStart);
        const db = openDb(dbPath);
        try {
          const rows = getNewTracksInWeek(db, {
            startUtcIso: ranges.current.startUtcIso,
            endUtcIso: ranges.current.endUtcIso,
            prevStartUtcIso: ranges.previous.startUtcIso,
            prevEndUtcIso: ranges.previous.endUtcIso,
            stationId,
            limit,
            maxReleaseAgeDays,
            releaseYear
          });
          return res.json({ weekStart, stationId: stationId ?? null, maxReleaseAgeDays, releaseYear, rows });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    backpool: async (req, res) => {
      let currentKey = null;
      try {
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const from = req.query.from ? String(safeQueryValue(req.query.from)) : undefined;
        const to = req.query.to ? String(safeQueryValue(req.query.to)) : undefined;
        const rawYears = Number(safeQueryValue(req.query.years) ?? 5);
        const rawMinPlays = Number(safeQueryValue(req.query.minPlays) ?? 1);
        const rawTop = Number(safeQueryValue(req.query.top) ?? 20);
        const rawRotationMinDailyPlays = Number(safeQueryValue(req.query.rotationMinDailyPlays) ?? 0.35);
        const rawMinConfidence = Number(safeQueryValue(req.query.minConfidence) ?? 0.72);
        const rawLowRotationMaxDailyPlays = Number(safeQueryValue(req.query.lowRotationMaxDailyPlays) ?? 2);
        const rawRotationMinActiveDays = Number(safeQueryValue(req.query.rotationMinActiveDays) ?? 5);
        const rawRotationMinSpanDays = Number(safeQueryValue(req.query.rotationMinSpanDays) ?? 28);
        const rawRotationMinReleaseAgeDays = Number(safeQueryValue(req.query.rotationMinReleaseAgeDays) ?? 1095);
        const rawMinTrackAgeDays = Number(safeQueryValue(req.query.minTrackAgeDays) ?? 30);
        const rotationAdaptive = String(safeQueryValue(req.query.rotationAdaptive) ?? '1') !== '0';
        const hydrate = String(safeQueryValue(req.query.hydrate) ?? '0') !== '0';
        const rawMaxMetaLookups = Number(safeQueryValue(req.query.maxMetaLookups) ?? 80);
        const maxLookupsRequested = Number.isFinite(rawMaxMetaLookups) ? Math.max(0, Math.min(rawMaxMetaLookups, 400)) : 80;
        const effectiveMaxMetaLookups = hydrate
          ? stationId
            ? maxLookupsRequested
            : Math.min(maxLookupsRequested, 40)
          : 0;
        const payload = {
          from: from ?? null,
          to: to ?? null,
          years: Number.isFinite(rawYears) ? Math.max(1, Math.min(rawYears, 40)) : 5,
          minTrackPlays: Number.isFinite(rawMinPlays) ? Math.max(1, Math.min(rawMinPlays, 500)) : 1,
          top: Number.isFinite(rawTop) ? Math.max(1, Math.min(rawTop, 1000)) : 20,
          rotationMinDailyPlays: Number.isFinite(rawRotationMinDailyPlays)
            ? Math.max(0.01, Math.min(rawRotationMinDailyPlays, 24))
            : 0.35,
          minReleaseConfidence: Number.isFinite(rawMinConfidence) ? Math.max(0, Math.min(rawMinConfidence, 1)) : 0.72,
          lowRotationMaxDailyPlays: Number.isFinite(rawLowRotationMaxDailyPlays)
            ? Math.max(0.1, Math.min(rawLowRotationMaxDailyPlays, 24))
            : 2,
          rotationMinActiveDays: Number.isFinite(rawRotationMinActiveDays)
            ? Math.max(1, Math.min(rawRotationMinActiveDays, 366))
            : 5,
          rotationMinSpanDays: Number.isFinite(rawRotationMinSpanDays)
            ? Math.max(1, Math.min(rawRotationMinSpanDays, 366))
            : 28,
          rotationMinReleaseAgeDays: Number.isFinite(rawRotationMinReleaseAgeDays)
            ? Math.max(0, Math.min(rawRotationMinReleaseAgeDays, 3660))
            : 1095,
          minTrackAgeDays: Number.isFinite(rawMinTrackAgeDays)
            ? Math.max(1, Math.min(rawMinTrackAgeDays, 3660))
            : 30,
          rotationAdaptive,
          stationId: stationId ?? null,
          autoEnrichMissingRelease: hydrate,
          maxMetadataLookups: effectiveMaxMetaLookups
        };
        const key = toBackpoolKey(payload);
        currentKey = key;
        const now = Date.now();
        const cached = backpoolCache.get(key);
        if (cached && now < cached.expiresAtMs) {
          return res.json(cached.result);
        }
        if (backpoolInFlight.has(key)) {
          const result = await backpoolInFlight.get(key);
          return res.json(result);
        }

        const runPromise = runBackpoolAnalysis({
          configPath,
          dbPath,
          from,
          to,
          years: payload.years,
          minTrackPlays: payload.minTrackPlays,
          top: payload.top,
          rotationMinDailyPlays: payload.rotationMinDailyPlays,
          minReleaseConfidence: payload.minReleaseConfidence,
          lowRotationMaxDailyPlays: payload.lowRotationMaxDailyPlays,
          rotationMinActiveDays: payload.rotationMinActiveDays,
          rotationMinSpanDays: payload.rotationMinSpanDays,
          rotationMinReleaseAgeDays: payload.rotationMinReleaseAgeDays,
          minTrackAgeDays: payload.minTrackAgeDays,
          rotationAdaptive: payload.rotationAdaptive,
          stationId,
          writeReport: false,
          autoEnrichMissingRelease: hydrate,
          persistToDb: false,
          maxMetadataLookups: effectiveMaxMetaLookups,
          logger
        });
        backpoolInFlight.set(key, runPromise);
        const result = await runPromise;
        backpoolInFlight.delete(key);
        backpoolCache.set(key, { expiresAtMs: Date.now() + BACKPOOL_CACHE_TTL_MS, result });
        return res.json(result);
      } catch (error) {
        if (currentKey && backpoolInFlight.has(currentKey)) {
          backpoolInFlight.delete(currentKey);
        }
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    backpoolCatalog: (req, res) => {
      try {
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const classification = req.query.classification ? String(safeQueryValue(req.query.classification)) : undefined;
        const rawLimit = Number(safeQueryValue(req.query.limit) ?? 500);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 2000)) : 500;

        const db = openDb(dbPath);
        try {
          const rows = listBackpoolTrackCatalog(db, { stationId, classification, limit });
          return res.json({
            stationId: stationId ?? null,
            classification: classification ?? null,
            rows
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    backpoolSummary: (req, res) => {
      try {
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const db = openDb(dbPath);
        try {
          const data = listBackpoolStationSummary(db, { stationId });
          return res.json({
            stationId: stationId ?? null,
            rows: Array.isArray(data) ? data : data ? [data] : []
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    evaluateDaily: async (req, res) => {
      try {
        const date = req.body?.date ?? DateTime.now().setZone(BERLIN_TZ).toISODate();
        const result = runDailyEvaluation({ configPath, dbPath, date, logger });
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    stationReport: (req, res) => {
      try {
        const stationId = req.params.stationId;
        const weekStart = req.query.weekStart
          ? String(safeQueryValue(req.query.weekStart))
          : DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
        const ranges = buildWeekRanges(weekStart);
        const config = loadConfig(configPath);
        const station = config.stations.find((s) => s.id === stationId);
        if (!station) return res.status(404).json({ error: 'Unknown stationId' });

        const db = openDb(dbPath);
        try {
          const currentRows = listTracks(db, { stationId, limit: 1000 });
          const previousRowsRaw = db.prepare(`
            select
              track_key,
              min(artist) as artist,
              min(title) as title,
              count(*) as count
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by track_key
            order by count desc
          `).all(stationId, ranges.previous.startUtcIso, ranges.previous.endUtcIso);

          const currentRowsRange = db.prepare(`
            select
              track_key,
              min(artist) as artist,
              min(title) as title,
              count(*) as count
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
            group by track_key
            order by count desc
          `).all(stationId, ranges.current.startUtcIso, ranges.current.endUtcIso);

          const totalPlays = db.prepare(`
            select count(*) as total
            from plays
            where station_id = ?
              and played_at_utc >= ?
              and played_at_utc < ?
          `).get(stationId, ranges.current.startUtcIso, ranges.current.endUtcIso)?.total ?? 0;

          const report = buildStationAnalytics({
            station,
            currentRows: currentRowsRange,
            previousRows: previousRowsRaw,
            currentTotalPlays: totalPlays
          });

          return res.json({
            stationId,
            weekStart,
            report,
            catalogSize: currentRows.length
          });
        } finally {
          db.close();
        }
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}

export function createApiApp({ configPath, dbPath, logger }) {
  let express;
  try {
    express = require('express');
  } catch {
    throw new Error('API dependency missing: install packages with `npm install`.');
  }

  const app = express();
  app.use(express.json());
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

  const handlers = createApiHandlers({ configPath, dbPath, logger });

  app.get('/', (_req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
  app.get('/backpool', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'backpool.html')));
  app.get('/tracks', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tracks.html')));
  app.get('/new-titles', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'new-titles.html')));

  app.get('/api/health', handlers.health);
  app.get('/api/docs', handlers.docs);
  app.get('/api/stations', handlers.stations);
  app.get('/api/tracks', handlers.tracks);
  app.get('/api/new-titles', handlers.newTitles);
  app.get('/api/tracks/search', handlers.search);
  app.get('/api/tracks/:trackKey/series', handlers.trackSeries);
  app.get('/api/tracks/:trackKey/series-by-station', handlers.trackSeriesByStation);
  app.get('/api/tracks/:trackKey/totals', handlers.trackTotals);
  app.get('/api/tracks/:trackKey/stations', handlers.trackStations);
  app.get('/api/tracks/:trackKey/trend', handlers.trackTrend);
  app.get('/api/tracks/:trackKey/station-divergence', handlers.trackStationDivergence);
  app.get('/api/tracks/:trackKey/lifecycle', handlers.trackLifecycle);
  app.get('/api/tracks/:trackKey/meta', handlers.trackMeta);
  app.post('/api/tracks/:trackKey/meta/refresh', handlers.refreshTrackMeta);
  app.get('/api/alerts/new-cross-station', handlers.alertsNewCrossStation);
  app.get('/api/artists/momentum', handlers.artistsMomentum);
  app.get('/api/outliers', handlers.outliers);
  app.get('/api/stations/:stationId/profile', handlers.stationProfile);
  app.post('/api/admin/merge-tracks', handlers.adminMergeTracks);
  app.get('/api/reports/station/:stationId', handlers.stationReport);
  app.get('/api/insights/new-this-week', handlers.newThisWeek);
  app.get('/api/insights/backpool', handlers.backpool);
  app.get('/api/insights/backpool/catalog', handlers.backpoolCatalog);
  app.get('/api/insights/backpool/summary', handlers.backpoolSummary);
  app.post('/api/jobs/evaluate-daily', handlers.evaluateDaily);

  return app;
}

function listenOnPort(app, port, logger) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info({ port }, 'API server started');
      resolve(server);
    });
    server.once('error', (err) => reject(err));
  });
}

function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function runCliCommand(commandName, args) {
  const cliPath = path.resolve(__dirname, 'cli.js');
  const command = [quoteShellArg(process.execPath), quoteShellArg(cliPath), quoteShellArg(commandName), ...args.map(quoteShellArg)].join(' ');
  return new Promise((resolve, reject) => {
    exec(command, { cwd: path.resolve(__dirname, '..'), maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout?.trim()) console.log(`[cron] ${commandName} stdout\n${stdout.trim()}`);
      if (stderr?.trim()) console.error(`[cron] ${commandName} stderr\n${stderr.trim()}`);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function initHourlyCron({ configPath, dbPath }) {
  let cron;
  try {
    cron = require('node-cron');
  } catch (error) {
    console.error('[cron] node-cron nicht installiert. Bitte `npm install node-cron` ausführen.', error);
    return;
  }

  let isRunning = false;
  const runHourlyJobs = async () => {
    if (isRunning) {
      console.log('[cron] Lauf uebersprungen: vorheriger Job laeuft noch.');
      return;
    }

    isRunning = true;
    const startedAt = new Date().toISOString();
    console.log(`[cron] Start: ${startedAt}`);

    try {
      await runCliCommand('ingest', ['--config', configPath, '--db', dbPath]);
      await runCliCommand('maintain-db', ['--db', dbPath]);
      console.log(`[cron] Erfolg: ingest + maintain-db abgeschlossen (${new Date().toISOString()})`);
    } catch (error) {
      console.error(`[cron] Fehler: ${(error && error.message) || String(error)}`);
    } finally {
      isRunning = false;
      console.log(`[cron] Ende: ${new Date().toISOString()}`);
    }
  };

  cron.schedule('0 * * * *', () => {
    void runHourlyJobs();
  });

  console.log(`[cron] Initialisiert: 0 * * * * (db=${dbPath})`);
}

export async function startApiServer({ configPath, dbPath, port = 8787 }) {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  const app = createApiApp({ configPath, dbPath, logger });

  let server;
  let selectedPort = Number(port) || 8787;
  for (let i = 0; i < 20; i += 1) {
    try {
      server = await listenOnPort(app, selectedPort, logger);
      break;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        logger.warn({ portTried: selectedPort }, 'port already in use, trying next port');
        selectedPort += 1;
        continue;
      }
      throw err;
    }
  }
  if (!server) {
    throw new Error(`Could not start API server: no free port found from ${port} to ${selectedPort}`);
  }

  initHourlyCron({ configPath, dbPath });

  return server;
}
