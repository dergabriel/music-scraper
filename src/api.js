import path from 'node:path';
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
  getNewTracksInWeek
} from './db.js';
import { BERLIN_TZ, buildDayRangeBerlin, buildWeekRanges } from './time.js';
import { buildTrackSeries, buildTrackTotals } from './trends.js';
import { runDailyEvaluation, runIngest, nextBerlinTime } from './services.js';
import { loadConfig } from './config.js';
import { buildStationAnalytics } from './analytics.js';

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

export function createApiHandlers({ configPath, dbPath, logger }) {
  return {
    health: (_req, res) => {
      res.json({ ok: true, time: new Date().toISOString() });
    },

    docs: (_req, res) => {
      res.json({
        name: 'JUKA Radio Playlist Analyzer API',
        pages: ['GET /dashboard', 'GET /tracks'],
        endpoints: [
          'GET /api/health',
          'GET /api/docs',
          'GET /api/stations',
          'GET /api/tracks?limit=100&q=QUERY&stationId=ID',
          'GET /api/tracks/search?q=QUERY&limit=30',
          'GET /api/tracks/:trackKey/series?bucket=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/totals?from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/stations?from=YYYY-MM-DD&to=YYYY-MM-DD',
          'GET /api/tracks/:trackKey/meta',
          'GET /api/reports/station/:stationId?weekStart=YYYY-MM-DD',
          'GET /api/insights/new-this-week?weekStart=YYYY-MM-DD&stationId=ID&limit=20',
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
      const rawLimit = Number(safeQueryValue(req.query.limit) ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;

      const db = openDb(dbPath);
      try {
        const rows = listTracks(db, { query: q, stationId, limit });
        res.json(rows);
      } finally {
        db.close();
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

    newThisWeek: (req, res) => {
      try {
        const stationId = req.query.stationId ? String(safeQueryValue(req.query.stationId)) : undefined;
        const rawLimit = Number(safeQueryValue(req.query.limit) ?? 20);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
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
            limit
          });
          return res.json({ weekStart, stationId: stationId ?? null, rows });
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
  app.get('/tracks', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tracks.html')));

  app.get('/api/health', handlers.health);
  app.get('/api/docs', handlers.docs);
  app.get('/api/stations', handlers.stations);
  app.get('/api/tracks', handlers.tracks);
  app.get('/api/tracks/search', handlers.search);
  app.get('/api/tracks/:trackKey/series', handlers.trackSeries);
  app.get('/api/tracks/:trackKey/totals', handlers.trackTotals);
  app.get('/api/tracks/:trackKey/stations', handlers.trackStations);
  app.get('/api/tracks/:trackKey/meta', handlers.trackMeta);
  app.get('/api/reports/station/:stationId', handlers.stationReport);
  app.get('/api/insights/new-this-week', handlers.newThisWeek);
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

export async function startApiServer({ configPath, dbPath, port = 8787, scheduleDaily = false, dailyHour = 23 }) {
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

  if (scheduleDaily) {
    const scheduleNext = () => {
      const next = nextBerlinTime(dailyHour, 0);
      const waitMs = Math.max(1000, next.toMillis() - Date.now());
      logger.info({ runAtBerlin: next.toISO() }, 'scheduled next daily ingest/evaluation');
      setTimeout(async () => {
        try {
          await runIngest({ configPath, dbPath, logger });
          const date = buildDayRangeBerlin(DateTime.now().setZone(BERLIN_TZ).toISODate()).startBerlin.toISODate();
          runDailyEvaluation({ configPath, dbPath, date, logger });
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'daily scheduled job failed');
        } finally {
          scheduleNext();
        }
      }, waitMs);
    };
    scheduleNext();
  }

  return server;
}
