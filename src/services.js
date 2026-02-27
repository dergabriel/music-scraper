import path from 'node:path';
import fs from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from './config.js';
import { isLikelyNoiseTrack, isLikelyJingleLike, normalizeArtistTitle } from './normalize.js';
import {
  openDb,
  upsertStation,
  insertPlayIgnore,
  getStationTrackCounts,
  getStationTotalPlays,
  getStationPlayedAtUtc,
  getOverallTrackCounts,
  clearDailyStatsForDate,
  upsertDailyStationStat,
  upsertDailyTrackStat,
  upsertDailyOverallTrackStat
} from './db.js';
import { BERLIN_TZ, buildWeekRanges, buildDayRangeBerlin, berlinTodayIso, isoUtcNow } from './time.js';
import { buildStationAnalytics, buildCrossStationAnalytics } from './analytics.js';
import { writeMarkdownReport, writeCsvExports, writeStationMarkdownReport, gzipFile } from './report.js';
import { HttpFetcher } from './fetchers/httpFetcher.js';
import { PlaywrightFetcher } from './fetchers/playwrightFetcher.js';
import { GenericHtmlParser } from './parsers/genericHtml.js';
import { OnlineradioboxParser } from './parsers/onlineradiobox.js';
import { DlfNovaParser } from './parsers/dlfNova.js';
import { FluxFmParser } from './parsers/fluxfm.js';
import { TrackVerifier } from './trackVerifier.js';

export function parserForStation(station) {
  switch (station.parser) {
    case 'dlf_nova':
      return new DlfNovaParser({ timezone: station.timezone });
    case 'fluxfm':
      return new FluxFmParser({ timezone: station.timezone });
    case 'onlineradiobox':
      return new OnlineradioboxParser({ timezone: station.timezone });
    case 'generic_html':
      return new GenericHtmlParser({ timezone: station.timezone });
    case 'generic_html_or_onlineradiobox':
      return {
        parse(html, sourceUrl) {
          const onlineradiobox = new OnlineradioboxParser({ timezone: station.timezone });
          const generic = new GenericHtmlParser({ timezone: station.timezone });
          const first = onlineradiobox.parse(html, sourceUrl);
          return first.length ? first : generic.parse(html, sourceUrl);
        }
      };
    default:
      throw new Error(`Unsupported parser: ${station.parser}`);
  }
}

export function fetcherForStation(station) {
  if (station.fetcher === 'playwright') return new PlaywrightFetcher();
  return new HttpFetcher();
}

function coveredBerlinHours(plays, timezone) {
  const hours = new Set();
  for (const play of plays) {
    const dt = DateTime.fromJSDate(play.playedAt, { zone: 'utc' }).setZone(timezone || BERLIN_TZ);
    hours.add(dt.toFormat('yyyy-LL-dd HH'));
  }
  return hours.size;
}

export async function runIngest({ configPath, dbPath, logger }) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);

  let totalInserted = 0;
  const scrapeErrors = [];
  const verifyAllTracks = process.env.YRPA_VERIFY_ALL_TRACKS === '1';
  const verificationEnabled = process.env.YRPA_TRACK_VERIFY !== '0' && process.env.NODE_ENV !== 'test';
  const verifier = verificationEnabled ? new TrackVerifier({ db, logger }) : null;

  for (const station of config.stations) {
    upsertStation(db, station);

    try {
      const fetcher = fetcherForStation(station);
      const parser = parserForStation(station);
      const urlsToTry = [station.playlist_url, ...(station.fallback_urls ?? [])];
      let plays = [];
      let usedUrl = station.playlist_url;

      for (const url of urlsToTry) {
        try {
          const html = await fetcher.fetchHtml(url);
          const parsed = parser.parse(html, url);
          if (parsed.length > 0) {
            plays = parsed;
            usedUrl = url;
            break;
          }
          logger.warn({ station: station.id, url }, 'source fetched but parser found no plays');
        } catch (sourceError) {
          const sourceMessage = sourceError instanceof Error ? sourceError.message : String(sourceError);
          logger.warn({ station: station.id, url, error: sourceMessage }, 'source fetch/parse failed, trying fallback');
        }
      }

      if (plays.length === 0) {
        throw new Error(`No plays parsed from any configured source (${urlsToTry.length} url(s))`);
      }

      const payloadCoveredHours = coveredBerlinHours(plays, station.timezone);
      if (payloadCoveredHours < 12) {
        logger.warn(
          { station: station.id, sourceUrl: usedUrl, playsFound: plays.length, coveredHours: payloadCoveredHours },
          'low hourly coverage in fetched payload (possible incomplete source window)'
        );
      }

      let dedupedByMinute = 0;
      if (station.enforce_one_play_per_minute) {
        const minuteSeen = new Set();
        const filtered = [];
        for (const play of plays) {
          const minuteKey = play.playedAt.toISOString().slice(0, 16);
          if (minuteSeen.has(minuteKey)) {
            dedupedByMinute += 1;
            continue;
          }
          minuteSeen.add(minuteKey);
          filtered.push(play);
        }
        plays = filtered;
      }

      let inserted = 0;
      let skippedNoise = 0;
      let skippedJingle = 0;
      const ingestedAt = isoUtcNow();
      const verifiedByTrackKey = new Map();

      for (const play of plays) {
        const normalized = normalizeArtistTitle(play.artistRaw, play.titleRaw, {
          stationName: station.name,
          stationId: station.id
        });
        if (
          isLikelyNoiseTrack(play.artistRaw, play.titleRaw) ||
          normalized.artist.length < 2 ||
          normalized.title.length < 2
        ) {
          skippedNoise += 1;
          continue;
        }

        const suspicious = isLikelyJingleLike(play.artistRaw, play.titleRaw);
        if (verifier && (verifyAllTracks || suspicious)) {
          let verified = verifiedByTrackKey.get(normalized.trackKey);
          if (!verified) {
            verified = await verifier.verifyTrack({
              trackKey: normalized.trackKey,
              artist: normalized.artist,
              title: normalized.title
            });
            verifiedByTrackKey.set(normalized.trackKey, verified);
          }

          if (verified.verifiedExists === false) {
            skippedJingle += 1;
            continue;
          }
        }

        inserted += insertPlayIgnore(db, {
          station_id: station.id,
          played_at_utc: play.playedAt.toISOString(),
          artist_raw: play.artistRaw,
          title_raw: play.titleRaw,
          artist: normalized.artist,
          title: normalized.title,
          track_key: normalized.trackKey,
          source_url: play.sourceUrl || usedUrl,
          ingested_at_utc: ingestedAt
        });
      }

      totalInserted += inserted;
      logger.info(
        {
          station: station.id,
          sourceUrl: usedUrl,
          playsFound: plays.length,
          playsInserted: inserted,
          skippedNoise,
          skippedJingle,
          dedupedByMinute,
          verificationEnabled,
          verifyAllTracks
        },
        'ingest complete'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scrapeErrors.push({ station: station.id, error: message });
      logger.error({ station: station.id, url: station.playlist_url, fetcher: station.fetcher, error: message }, 'station ingest failed');
    }
  }

  logger.info({ stations: config.stations.length, totalInserted, scrapeErrors: scrapeErrors.length }, 'ingest finished');
  db.close();

  if (scrapeErrors.length === config.stations.length) {
    throw new Error('All stations failed during ingest. Check network access, URLs, and parser settings.');
  }

  return { totalInserted, scrapeErrors };
}

export function runReport({ configPath, dbPath, weekStart, csv, gzip = false, gzipOnly = false, logger }) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);
  const ranges = buildWeekRanges(weekStart);

  const stationAnalytics = [];
  for (const station of config.stations) {
    upsertStation(db, station);

    const currentRows = getStationTrackCounts(db, station.id, ranges.current.startUtcIso, ranges.current.endUtcIso);
    const previousRows = getStationTrackCounts(db, station.id, ranges.previous.startUtcIso, ranges.previous.endUtcIso);
    const totalPlays = getStationTotalPlays(db, station.id, ranges.current.startUtcIso, ranges.current.endUtcIso);

    stationAnalytics.push(
      buildStationAnalytics({ station, currentRows, previousRows, currentTotalPlays: totalPlays })
    );
  }

  const overallRows = getOverallTrackCounts(db, ranges.current.startUtcIso, ranges.current.endUtcIso);
  const crossAnalytics = buildCrossStationAnalytics(stationAnalytics, overallRows);

  const reportPath = path.resolve(`reports/${weekStart}_weekly.md`);
  const filesWritten = [];
  filesWritten.push(writeMarkdownReport({
    weekStart,
    outputPath: reportPath,
    stationAnalytics,
    crossAnalytics,
    dataQuality: {
      scrapeErrors: 0,
      stationPlays: stationAnalytics.map((s) => ({ stationName: s.station.name, totalPlays: s.totalPlays }))
    }
  }));

  if (csv) {
    filesWritten.push(...writeCsvExports({ csvDir: path.resolve('reports/csv'), stationAnalytics, crossAnalytics }));
  }

  const gzFiles = [];
  if (gzip) {
    for (const file of filesWritten) {
      gzFiles.push(gzipFile(file, { removeOriginal: gzipOnly }));
    }
  }

  db.close();
  logger.info({ reportPath, csv: Boolean(csv), gzip: Boolean(gzip), gzipOnly: Boolean(gzipOnly), gzFiles: gzFiles.length }, 'report generated');
  return { reportPath, gzFiles };
}

export function runStationReport({ configPath, dbPath, stationId, weekStart, gzip = false, gzipOnly = false, logger }) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);
  const ranges = buildWeekRanges(weekStart);
  const station = config.stations.find((s) => s.id === stationId);
  if (!station) {
    db.close();
    throw new Error(`Unknown station id: ${stationId}`);
  }

  upsertStation(db, station);
  const currentRows = getStationTrackCounts(db, station.id, ranges.current.startUtcIso, ranges.current.endUtcIso);
  const previousRows = getStationTrackCounts(db, station.id, ranges.previous.startUtcIso, ranges.previous.endUtcIso);
  const totalPlays = getStationTotalPlays(db, station.id, ranges.current.startUtcIso, ranges.current.endUtcIso);

  const stationResult = buildStationAnalytics({
    station,
    currentRows,
    previousRows,
    currentTotalPlays: totalPlays
  });

  const outPath = path.resolve(`reports/stations/${weekStart}_${stationId}.md`);
  const filePath = writeStationMarkdownReport({
    stationResult,
    weekStart,
    outputPath: outPath
  });

  let gzPath = null;
  if (gzip) {
    gzPath = gzipFile(filePath, { removeOriginal: gzipOnly });
  }

  db.close();
  logger.info({ stationId, weekStart, outPath, gzPath }, 'station report generated');
  return { outPath, gzPath, stationResult };
}

export function runDailyEvaluation({ configPath, dbPath, date, logger }) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);
  const day = date || berlinTodayIso();
  const range = buildDayRangeBerlin(day);

  clearDailyStatsForDate(db, day);

  for (const station of config.stations) {
    upsertStation(db, station);

    const trackRows = getStationTrackCounts(db, station.id, range.startUtcIso, range.endUtcIso);
    const totalPlays = getStationTotalPlays(db, station.id, range.startUtcIso, range.endUtcIso);

    upsertDailyStationStat(db, {
      date_berlin: day,
      station_id: station.id,
      total_plays: totalPlays,
      unique_tracks: trackRows.length
    });

    for (const row of trackRows) {
      upsertDailyTrackStat(db, {
        date_berlin: day,
        station_id: station.id,
        track_key: row.track_key,
        artist: row.artist,
        title: row.title,
        plays: row.count
      });
    }
  }

  const overall = getOverallTrackCounts(db, range.startUtcIso, range.endUtcIso);
  for (const row of overall) {
    upsertDailyOverallTrackStat(db, {
      date_berlin: day,
      track_key: row.track_key,
      artist: row.artist,
      title: row.title,
      plays: row.count
    });
  }

  db.close();
  logger.info({ dateBerlin: day, tracks: overall.length }, 'daily evaluation completed');
  return { dateBerlin: day, tracks: overall.length };
}

export function nextBerlinTime(hour = 23, minute = 0) {
  const now = DateTime.now().setZone(BERLIN_TZ);
  let next = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (next <= now) next = next.plus({ days: 1 });
  return next;
}

export function runCoverageAudit({ configPath, dbPath, date, logger }) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);
  const day = date || DateTime.now().setZone(BERLIN_TZ).minus({ days: 1 }).toISODate();
  const range = buildDayRangeBerlin(day);

  const rows = [];
  for (const station of config.stations) {
    upsertStation(db, station);
    const played = getStationPlayedAtUtc(db, station.id, range.startUtcIso, range.endUtcIso);
    const hourSet = new Set();
    for (const row of played) {
      const key = DateTime.fromISO(row.played_at_utc, { zone: 'utc' })
        .setZone(station.timezone || BERLIN_TZ)
        .toFormat('HH');
      hourSet.add(key);
    }
    const coveredHours = hourSet.size;
    const totalPlays = played.length;
    const okHours = coveredHours >= (station.min_daily_hours ?? 20);
    const okPlays = totalPlays >= (station.min_daily_plays ?? 24);
    const status = okHours && okPlays ? 'ok' : 'warn';
    rows.push({
      stationId: station.id,
      stationName: station.name,
      totalPlays,
      coveredHours,
      minDailyHours: station.min_daily_hours ?? 20,
      minDailyPlays: station.min_daily_plays ?? 24,
      status
    });
  }

  const mdPath = path.resolve(`reports/coverage/${day}_coverage.md`);
  const lines = [
    `# JUKA Coverage Audit ${day}`,
    '',
    '| Station | Plays | Covered Hours | Threshold Hours | Threshold Plays | Status |',
    '| --- | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.stationName} | ${row.totalPlays} | ${row.coveredHours} | ${row.minDailyHours} | ${row.minDailyPlays} | ${row.status} |`
    );
  }
  const warnings = rows.filter((r) => r.status !== 'ok').length;
  lines.push('');
  lines.push(`- Stations checked: **${rows.length}**`);
  lines.push(`- Warnings: **${warnings}**`);

  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');

  db.close();
  logger.info({ dateBerlin: day, stations: rows.length, warnings, mdPath }, 'coverage audit completed');
  return { dateBerlin: day, rows, warnings, mdPath };
}
