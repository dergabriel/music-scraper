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
  getStationTrackCountsWithMetadata,
  getStationTotalPlays,
  getStationPlayedAtUtc,
  getOverallTrackCounts,
  upsertBackpoolStationSummary,
  clearBackpoolTrackCatalogForStation,
  upsertBackpoolTrackCatalogRow,
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

function parseIsoDate(value, label) {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: BERLIN_TZ }).startOf('day');
  if (!dt.isValid) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return dt;
}

function releaseAgeYears(releaseDate, endDate) {
  const diff = endDate.diff(releaseDate, 'years').years;
  return Number.isFinite(diff) ? Math.max(0, diff) : null;
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
          isLikelyNoiseTrack(play.artistRaw, play.titleRaw, { stationName: station.name, stationId: station.id }) ||
          normalized.artist.length < 2 ||
          normalized.title.length < 2
        ) {
          skippedNoise += 1;
          continue;
        }

        const suspicious = isLikelyJingleLike(play.artistRaw, play.titleRaw, {
          stationName: station.name,
          stationId: station.id
        });
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
  const isCurrentBerlinDay = day === berlinTodayIso();
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
  if (isCurrentBerlinDay) {
    lines.push('- Note: This is the current Berlin day and may be incomplete. Prefer auditing yesterday.');
    logger.warn({ dateBerlin: day }, 'coverage audit is running for current Berlin day (incomplete window possible)');
  }

  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');

  db.close();
  logger.info({ dateBerlin: day, stations: rows.length, warnings, mdPath }, 'coverage audit completed');
  return { dateBerlin: day, rows, warnings, mdPath };
}

export async function runBackpoolAnalysis({
  configPath,
  dbPath,
  from,
  to,
  years = 5,
  minTrackPlays = 3,
  top = 20,
  stationId,
  writeReport = true,
  autoEnrichMissingRelease = false,
  maxMetadataLookups = 80,
  minReleaseConfidence = 0.72,
  rotationMinDailyPlays = 0.35,
  lowRotationMaxDailyPlays = 2,
  rotationMinActiveDays = 5,
  rotationMinSpanDays = 28,
  rotationAdaptive = true,
  persistToDb = true,
  logger
}) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);

  const toBerlin = parseIsoDate(to, 'to') || DateTime.now().setZone(BERLIN_TZ).startOf('day');
  const fromBerlin = parseIsoDate(from, 'from') || toBerlin.minus({ days: 365 }).startOf('day');
  if (fromBerlin > toBerlin) {
    db.close();
    throw new Error(`Invalid range: from (${fromBerlin.toISODate()}) must be <= to (${toBerlin.toISODate()})`);
  }

  const rangeStartUtcIso = fromBerlin.toUTC().toISO();
  const rangeEndUtcIso = toBerlin.plus({ days: 1 }).toUTC().toISO();
  const backpoolCutoff = toBerlin.minus({ years: Number(years) || 5 }).startOf('day');
  const topLimit = Math.max(1, Number(top) || 20);
  const confidenceFloor = Math.max(0, Math.min(Number(minReleaseConfidence) || 0, 1));
  const rotationMinDaily = Math.max(0.01, Number(rotationMinDailyPlays) || 0.35);
  const lowRotationMax = Math.max(0.1, Number(lowRotationMaxDailyPlays) || 2);
  const rotationMinDays = Math.max(1, Math.floor(Number(rotationMinActiveDays) || 5));
  const rotationSpanMin = Math.max(1, Math.floor(Number(rotationMinSpanDays) || 28));
  const adaptiveRotation = rotationAdaptive !== false;
  const rangeDays = Math.max(1, Math.floor(toBerlin.diff(fromBerlin, 'days').days) + 1);

  const selectedStations = stationId
    ? config.stations.filter((station) => station.id === stationId)
    : config.stations;
  if (stationId && selectedStations.length === 0) {
    db.close();
    throw new Error(`Unknown station id: ${stationId}`);
  }

  const enrichEnabled = Boolean(autoEnrichMissingRelease) && process.env.NODE_ENV !== 'test';
  const verifier = enrichEnabled ? new TrackVerifier({ db, logger }) : null;
  let enrichBudgetRemaining = Math.max(0, Number(maxMetadataLookups) || 0);

  const rows = [];
  for (let stationIndex = 0; stationIndex < selectedStations.length; stationIndex += 1) {
    const station = selectedStations[stationIndex];
    upsertStation(db, station);
    let trackRows = getStationTrackCountsWithMetadata(db, station.id, rangeStartUtcIso, rangeEndUtcIso)
      .filter((row) =>
        !isLikelyNoiseTrack(row.artist, row.title, { stationName: station.name, stationId: station.id }) &&
        !isLikelyJingleLike(row.artist, row.title, { stationName: station.name, stationId: station.id })
      );

    if (verifier && enrichBudgetRemaining > 0) {
      const stationsRemaining = Math.max(1, selectedStations.length - stationIndex);
      const stationEnrichBudget = Math.max(1, Math.floor(enrichBudgetRemaining / stationsRemaining));
      const enrichCandidates = trackRows
        .filter((row) => !row.release_date_utc && Number(row.count || 0) >= Number(minTrackPlays || 1))
        .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
        .slice(0, stationEnrichBudget);
      let enrichFailures = 0;
      let lastEnrichFailure = null;
      let enrichAttempts = 0;
      let providerBackoffHit = false;

      for (const candidate of enrichCandidates) {
        try {
          enrichAttempts += 1;
          const enrichResult = await verifier.enrichMetadata({
            trackKey: candidate.track_key,
            artist: candidate.artist,
            title: candidate.title
          }, { includeChart: false, quietErrors: true });

          if (enrichResult?.metadata?.verification_source === 'itunes_error') {
            enrichFailures += 1;
            const payload = String(enrichResult.metadata.payload_json ?? '');
            const transientBackoff = /temporarily unavailable|backoff/i.test(payload);
            if (transientBackoff) {
              providerBackoffHit = true;
              lastEnrichFailure = 'iTunes backoff active';
              break;
            }
          }
        } catch (error) {
          enrichFailures += 1;
          lastEnrichFailure = error instanceof Error ? error.message : String(error);
        }
      }

      if (enrichFailures > 0) {
        logger?.warn(
          {
            station: station.id,
            attempted: enrichAttempts,
            failed: enrichFailures,
            providerBackoffHit,
            lastError: lastEnrichFailure
          },
          'backpool metadata enrichment had failures'
        );
      }

      enrichBudgetRemaining = Math.max(0, enrichBudgetRemaining - enrichAttempts);
      if (enrichAttempts > 0) {
        trackRows = getStationTrackCountsWithMetadata(db, station.id, rangeStartUtcIso, rangeEndUtcIso)
          .filter((row) =>
            !isLikelyNoiseTrack(row.artist, row.title, { stationName: station.name, stationId: station.id }) &&
            !isLikelyJingleLike(row.artist, row.title, { stationName: station.name, stationId: station.id })
          );
      }
    }

    const totalPlays = getStationTotalPlays(db, station.id, rangeStartUtcIso, rangeEndUtcIso);
    const observedWindow = db.prepare(`
      select count(distinct substr(played_at_utc, 1, 10)) as c
      , min(played_at_utc) as min_played_at_utc
      , max(played_at_utc) as max_played_at_utc
      from plays
      where station_id = ?
        and played_at_utc >= ?
        and played_at_utc < ?
    `).get(station.id, rangeStartUtcIso, rangeEndUtcIso) ?? { c: 0, min_played_at_utc: null, max_played_at_utc: null };
    const observedCoverageDays = Number(observedWindow.c || 0);
    const observedMin = observedWindow.min_played_at_utc
      ? DateTime.fromISO(observedWindow.min_played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ)
      : null;
    const observedMax = observedWindow.max_played_at_utc
      ? DateTime.fromISO(observedWindow.max_played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ)
      : null;
    const observedSpanDays =
      observedMin && observedMin.isValid && observedMax && observedMax.isValid
        ? Math.max(1, Math.floor(observedMax.startOf('day').diff(observedMin.startOf('day'), 'days').days) + 1)
        : 0;
    const warmupMode = adaptiveRotation && observedSpanDays > 0 && observedSpanDays < rotationSpanMin;
    const rateBasisDays = warmupMode
      ? Math.max(observedSpanDays, 2)
      : (observedSpanDays > 0 ? observedSpanDays : rangeDays);
    const effectiveRotationSpanMin = warmupMode
      ? Math.min(observedSpanDays, 2)
      : adaptiveRotation
        ? Math.min(rotationSpanMin, Math.max(1, observedSpanDays || observedCoverageDays || 1))
        : rotationSpanMin;
    const minActiveFromCadence = Math.max(1, Math.ceil(effectiveRotationSpanMin * rotationMinDaily));
    const effectiveRotationActiveMin = adaptiveRotation
      ? Math.min(rotationMinDays, minActiveFromCadence)
      : rotationMinDays;

    const classifiedRows = trackRows.map((row) => {
      const release = row.release_date_utc ? DateTime.fromISO(row.release_date_utc, { zone: 'utc' }).setZone(BERLIN_TZ) : null;
      const firstPlayed = row.first_played_at_utc ? DateTime.fromISO(row.first_played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ) : null;
      const lastPlayed = row.last_played_at_utc ? DateTime.fromISO(row.last_played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ) : null;
      const parsedConfidence = Number(row.verification_confidence);
      const confidence = Number.isFinite(parsedConfidence) ? parsedConfidence : null;
      const verifiedExists = row.verified_exists === null || row.verified_exists === undefined ? null : Number(row.verified_exists);
      const plays = Number(row.count || 0);
      const activeDays = Math.max(0, Number(row.active_days || 0));
      const playsPerDay = plays / rateBasisDays;
      const spanDays =
        firstPlayed && firstPlayed.isValid && lastPlayed && lastPlayed.isValid
          ? Math.max(1, Math.floor(lastPlayed.startOf('day').diff(firstPlayed.startOf('day'), 'days').days) + 1)
          : 0;
      const cadenceDays = plays > 0 ? rateBasisDays / plays : null;

      let metadataIssue = null;
      if (!row.release_date_utc) {
        metadataIssue = 'missing_release';
      } else if (!release || !release.isValid) {
        metadataIssue = 'invalid_release';
      } else if (verifiedExists === 0) {
        metadataIssue = 'rejected_match';
      } else if (confidence === null) {
        metadataIssue = 'missing_confidence';
      } else if (confidence < confidenceFloor) {
        metadataIssue = 'low_confidence';
      }

      return {
        ...row,
        release,
        firstPlayed,
        lastPlayed,
        verification_confidence: confidence,
        verified_exists: verifiedExists,
        metadataIssue,
        hasValidatedRelease: Boolean(release && release.isValid && metadataIssue === null),
        plays,
        activeDays,
        playsPerDay,
        spanDays,
        cadenceDays
      };
    });

    const withRelease = classifiedRows.filter((row) => row.hasValidatedRelease);
    const rotationBackpoolTracks = classifiedRows
      .filter((row) => (
        row.plays >= Number(minTrackPlays || 1) &&
        row.playsPerDay >= rotationMinDaily &&
        row.playsPerDay <= lowRotationMax &&
        row.activeDays >= effectiveRotationActiveMin &&
        row.spanDays >= effectiveRotationSpanMin
      ))
      .sort((a, b) => {
        if (a.playsPerDay < b.playsPerDay) return -1;
        if (a.playsPerDay > b.playsPerDay) return 1;
        return Number(b.plays || 0) - Number(a.plays || 0);
      });
    const hotRotationTracks = classifiedRows
      .filter((row) => row.playsPerDay > lowRotationMax)
      .sort((a, b) => Number(b.plays || 0) - Number(a.plays || 0));
    const sparseRotationTracks = classifiedRows
      .filter((row) => (
        row.plays < Number(minTrackPlays || 1) ||
        row.playsPerDay < rotationMinDaily ||
        row.activeDays < rotationMinDays ||
        row.spanDays < rotationSpanMin
      ))
      .sort((a, b) => Number(b.plays || 0) - Number(a.plays || 0));

    const backpoolTracks = withRelease
      .filter((row) => row.release <= backpoolCutoff && Number(row.plays || 0) >= Number(minTrackPlays || 1))
      .sort((a, b) => Number(b.plays || 0) - Number(a.plays || 0));
    const lowRotationBackpoolTracks = backpoolTracks
      .filter((row) => (Number(row.plays || 0) / rangeDays) <= lowRotationMax)
      .sort((a, b) => {
        const aPpd = Number(a.plays || 0) / rangeDays;
        const bPpd = Number(b.plays || 0) / rangeDays;
        if (aPpd < bPpd) return -1;
        if (aPpd > bPpd) return 1;
        return Number(b.plays || 0) - Number(a.plays || 0);
      });
    const oldestTracks = withRelease
      .slice()
      .sort((a, b) => {
        if (a.release < b.release) return -1;
        if (a.release > b.release) return 1;
        return Number(b.plays || 0) - Number(a.plays || 0);
      });

    const backpoolPlays = backpoolTracks.reduce((sum, row) => sum + Number(row.plays || 0), 0);
    const share = totalPlays > 0 ? backpoolPlays / totalPlays : 0;
    const avgAgeYears =
      backpoolTracks.length > 0
        ? backpoolTracks.reduce((sum, row) => sum + (releaseAgeYears(row.release, toBerlin) ?? 0), 0) / backpoolTracks.length
        : 0;

    const mapTrack = (row) => ({
      trackKey: row.track_key,
      artist: row.artist,
      title: row.title,
      plays: Number(row.plays || 0),
      playsPerDay: Number(row.plays || 0) / rangeDays,
      releaseDate: row.release.toISODate(),
      ageYears: releaseAgeYears(row.release, toBerlin),
      verificationConfidence: row.verification_confidence,
      genre: row.genre ?? null,
      album: row.album ?? null
    });
    const mapRotationTrack = (row) => ({
      trackKey: row.track_key,
      artist: row.artist,
      title: row.title,
      plays: Number(row.plays || 0),
      playsPerDay: Number(row.playsPerDay || 0),
      activeDays: Number(row.activeDays || 0),
      spanDays: Number(row.spanDays || 0),
      cadenceDays: Number.isFinite(row.cadenceDays) ? row.cadenceDays : null,
      firstPlayedDate: row.firstPlayed?.isValid ? row.firstPlayed.toISODate() : null,
      lastPlayedDate: row.lastPlayed?.isValid ? row.lastPlayed.toISODate() : null,
      releaseDate: row.release?.isValid ? row.release.toISODate() : null,
      verificationConfidence: row.verification_confidence,
      genre: row.genre ?? null,
      album: row.album ?? null
    });
    const unknownReleaseTracks = classifiedRows
      .filter((row) => !row.hasValidatedRelease && Number(row.plays || 0) >= Number(minTrackPlays || 1))
      .sort((a, b) => Number(b.plays || 0) - Number(a.plays || 0))
      .slice(0, topLimit)
      .map((row) => ({
        trackKey: row.track_key,
        artist: row.artist,
        title: row.title,
        plays: Number(row.plays || 0),
        playsPerDay: Number(row.playsPerDay || 0),
        activeDays: Number(row.activeDays || 0),
        spanDays: Number(row.spanDays || 0),
        cadenceDays: Number.isFinite(row.cadenceDays) ? row.cadenceDays : null,
        firstPlayedDate: row.firstPlayed?.isValid ? row.firstPlayed.toISODate() : null,
        lastPlayedDate: row.lastPlayed?.isValid ? row.lastPlayed.toISODate() : null,
        releaseDate: row.release && row.release.isValid ? row.release.toISODate() : null,
        ageYears: null,
        verificationConfidence: row.verification_confidence,
        metadataIssue: row.metadataIssue,
        genre: row.genre ?? null,
        album: row.album ?? null
      }));

    const unvalidatedReleaseCount = classifiedRows.filter((row) => !row.hasValidatedRelease).length;
    const rotationBackpoolPlays = rotationBackpoolTracks.reduce((sum, row) => sum + Number(row.plays || 0), 0);
    const rotationBackpoolShare = totalPlays > 0 ? rotationBackpoolPlays / totalPlays : 0;
    const cadenceSamples = rotationBackpoolTracks
      .map((row) => Number(row.cadenceDays))
      .filter((value) => Number.isFinite(value) && value > 0);
    const rotationPattern = {
      sampleDays: Math.max(1, observedSpanDays || rateBasisDays || rangeDays),
      activeHourPresencePct: 0,
      activeHoursPerDayAvg: 0,
      repeatsShare: 0,
      repeatsPerTrackAvg: 0,
      tracksWithSameDayRepeatCount: 0,
      tracksWithSameDayRepeatPct: 0,
      averageCadenceDays: cadenceSamples.length
        ? cadenceSamples.reduce((sum, value) => sum + value, 0) / cadenceSamples.length
        : null,
      topHours: []
    };

    if (rotationBackpoolTracks.length > 0 && rotationBackpoolPlays > 0) {
      const rotationSet = new Set(rotationBackpoolTracks.map((row) => row.track_key));
      const rotationPlayRows = db.prepare(`
        select track_key, played_at_utc
        from plays
        where station_id = ?
          and played_at_utc >= ?
          and played_at_utc < ?
      `).all(station.id, rangeStartUtcIso, rangeEndUtcIso).filter((row) => rotationSet.has(row.track_key));

      const hourlyPlays = Array.from({ length: 24 }, () => 0);
      const activeHourSlots = new Set();
      const dailyPlaysByTrack = new Map();

      for (const play of rotationPlayRows) {
        const dt = DateTime.fromISO(play.played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ);
        if (!dt.isValid) continue;
        hourlyPlays[dt.hour] += 1;
        activeHourSlots.add(dt.toFormat('yyyy-LL-dd HH'));
        const day = dt.toISODate();
        const currentByDay = dailyPlaysByTrack.get(play.track_key) ?? new Map();
        currentByDay.set(day, Number(currentByDay.get(day) || 0) + 1);
        dailyPlaysByTrack.set(play.track_key, currentByDay);
      }

      let tracksWithSameDayRepeatCount = 0;
      for (const byDay of dailyPlaysByTrack.values()) {
        const hasSameDayRepeat = Array.from(byDay.values()).some((count) => count >= 2);
        if (hasSameDayRepeat) tracksWithSameDayRepeatCount += 1;
      }

      const sampleDays = Math.max(1, observedSpanDays || rateBasisDays || rangeDays);
      const activeHourPresencePct = (activeHourSlots.size / (sampleDays * 24)) * 100;
      const activeHoursPerDayAvg = activeHourSlots.size / sampleDays;
      const repeats = Math.max(0, rotationBackpoolPlays - rotationBackpoolTracks.length);
      const repeatsShare = rotationBackpoolPlays > 0 ? repeats / rotationBackpoolPlays : 0;
      const tracksWithSameDayRepeatPct =
        rotationBackpoolTracks.length > 0 ? tracksWithSameDayRepeatCount / rotationBackpoolTracks.length : 0;
      const topHours = hourlyPlays
        .map((plays, hour) => ({
          hour,
          plays,
          share: rotationBackpoolPlays > 0 ? plays / rotationBackpoolPlays : 0
        }))
        .filter((row) => row.plays > 0)
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 4);

      rotationPattern.sampleDays = sampleDays;
      rotationPattern.activeHourPresencePct = activeHourPresencePct;
      rotationPattern.activeHoursPerDayAvg = activeHoursPerDayAvg;
      rotationPattern.repeatsShare = repeatsShare;
      rotationPattern.repeatsPerTrackAvg = rotationBackpoolPlays / rotationBackpoolTracks.length;
      rotationPattern.tracksWithSameDayRepeatCount = tracksWithSameDayRepeatCount;
      rotationPattern.tracksWithSameDayRepeatPct = tracksWithSameDayRepeatPct;
      rotationPattern.topHours = topHours;
    }

    if (persistToDb) {
      const analyzedAtUtc = isoUtcNow();
      const rotationSet = new Set(rotationBackpoolTracks.map((row) => row.track_key));
      const hotSet = new Set(hotRotationTracks.map((row) => row.track_key));
      const lowReleaseSet = new Set(lowRotationBackpoolTracks.map((row) => row.track_key));
      const releaseSet = new Set(backpoolTracks.map((row) => row.track_key));

      const tx = db.transaction(() => {
        clearBackpoolTrackCatalogForStation(db, station.id);

        for (const row of classifiedRows) {
          let classification = 'sparse_rotation';
          if (rotationSet.has(row.track_key)) classification = 'rotation_backpool';
          else if (hotSet.has(row.track_key)) classification = 'hot_rotation';

          upsertBackpoolTrackCatalogRow(db, {
            station_id: station.id,
            track_key: row.track_key,
            station_name: station.name,
            artist: row.artist,
            title: row.title,
            classification,
            analysis_from_berlin: fromBerlin.toISODate(),
            analysis_to_berlin: toBerlin.toISODate(),
            analyzed_at_utc: analyzedAtUtc,
            range_days: rangeDays,
            plays: Number(row.plays || 0),
            plays_per_day: Number(row.playsPerDay || 0),
            active_days: Number(row.activeDays || 0),
            span_days: Number(row.spanDays || 0),
            cadence_days: Number.isFinite(row.cadenceDays) ? row.cadenceDays : null,
            first_played_at_utc: row.first_played_at_utc ?? null,
            last_played_at_utc: row.last_played_at_utc ?? null,
            release_date_utc: row.release_date_utc ?? null,
            verified_exists: row.verified_exists,
            verification_confidence: row.verification_confidence,
            metadata_issue: row.metadataIssue,
            is_rotation_backpool: rotationSet.has(row.track_key) ? 1 : 0,
            is_release_backpool: releaseSet.has(row.track_key) ? 1 : 0,
            is_low_rotation_release_backpool: lowReleaseSet.has(row.track_key) ? 1 : 0
          });
        }

        upsertBackpoolStationSummary(db, {
          station_id: station.id,
          station_name: station.name,
          analysis_from_berlin: fromBerlin.toISODate(),
          analysis_to_berlin: toBerlin.toISODate(),
          analyzed_at_utc: analyzedAtUtc,
          range_days: rangeDays,
          observed_coverage_days: observedCoverageDays,
          observed_span_days: observedSpanDays,
          total_plays: totalPlays,
          total_tracks: classifiedRows.length,
          tracks_with_release: withRelease.length,
          unvalidated_release_count: unvalidatedReleaseCount,
          rotation_min_daily_plays: rotationMinDaily,
          rotation_max_daily_plays: lowRotationMax,
          rotation_min_active_days: rotationMinDays,
          rotation_min_span_days: rotationSpanMin,
          rotation_backpool_track_count: rotationBackpoolTracks.length,
          rotation_backpool_plays: rotationBackpoolPlays,
          rotation_backpool_share: rotationBackpoolShare,
          hot_rotation_track_count: hotRotationTracks.length,
          sparse_rotation_track_count: sparseRotationTracks.length,
          release_backpool_track_count: backpoolTracks.length,
          release_backpool_plays: backpoolPlays,
          release_backpool_share: share
        });
      });
      tx();
    }

    rows.push({
      stationId: station.id,
      stationName: station.name,
      totalPlays,
      totalTracks: classifiedRows.length,
      tracksWithRelease: withRelease.length,
      unvalidatedReleaseCount,
      minReleaseConfidence: confidenceFloor,
      rotationMinDailyPlays: rotationMinDaily,
      lowRotationMaxDailyPlays: lowRotationMax,
      rotationMinActiveDays: rotationMinDays,
      rotationMinSpanDays: rotationSpanMin,
      rotationAdaptive: adaptiveRotation,
      rotationWarmupMode: warmupMode,
      rotationEffectiveMinActiveDays: effectiveRotationActiveMin,
      rotationEffectiveMinSpanDays: effectiveRotationSpanMin,
      rotationRateBasisDays: rateBasisDays,
      rangeDays,
      observedCoverageDays,
      observedSpanDays,
      hasRotationHistory: observedSpanDays >= rotationSpanMin,
      rotationBackpoolTrackCount: rotationBackpoolTracks.length,
      rotationBackpoolPlays,
      rotationBackpoolShare,
      rotationPattern,
      backpoolTrackCount: backpoolTracks.length,
      lowRotationBackpoolTrackCount: lowRotationBackpoolTracks.length,
      backpoolPlays,
      backpoolShare: share,
      avgBackpoolAgeYears: avgAgeYears,
      rotationBackpoolTracks: rotationBackpoolTracks.slice(0, topLimit).map(mapRotationTrack),
      hotRotationTracks: hotRotationTracks.slice(0, topLimit).map(mapRotationTrack),
      sparseRotationTracks: sparseRotationTracks.slice(0, topLimit).map(mapRotationTrack),
      topBackpoolTracks: backpoolTracks.slice(0, topLimit).map(mapTrack),
      lowRotationBackpoolTracks: lowRotationBackpoolTracks.slice(0, topLimit).map(mapTrack),
      oldestTracks: oldestTracks.slice(0, topLimit).map(mapTrack),
      unknownReleaseTracks
    });
  }

  let mdPath = null;
  if (writeReport) {
    mdPath = path.resolve(`reports/backpool/${fromBerlin.toISODate()}_${toBerlin.toISODate()}_backpool.md`);
    const lines = [
      `# JUKA Backpool Analysis ${fromBerlin.toISODate()} bis ${toBerlin.toISODate()}`,
      '',
      `- Primäre Definition (Rotation): Ø Plays/Tag **${rotationMinDaily.toFixed(2)} bis ${lowRotationMax.toFixed(2)}**, aktive Tage **>= ${rotationMinDays}**, Spannweite **>= ${rotationSpanMin} Tage**`,
      adaptiveRotation
        ? '- Adaptive Auswertung aktiv: Bei kurzer Historie werden Mindestwerte pro Sender auf die verfügbare Datenbasis skaliert (Warmup-Modus).'
        : '- Adaptive Auswertung deaktiviert: Es gelten die festen Mindestwerte für alle Sender.',
      `- Zusatzsicht (Release-basiert): Release **<= ${backpoolCutoff.toISODate()}**, Confidence **>= ${confidenceFloor.toFixed(2)}**`,
      '',
      '| Station | Plays gesamt | Rotation-Backpool Plays | Rotation-Backpool Anteil | Rotation-Backpool Tracks | Datenabdeckung (Release) | Ø Alter Release-Backpool (Jahre) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
    ];

    rows.forEach((row) => {
      lines.push(
        `| ${row.stationName} | ${row.totalPlays} | ${row.rotationBackpoolPlays} | ${(row.rotationBackpoolShare * 100).toFixed(1)}% | ${row.rotationBackpoolTrackCount} | ${row.totalTracks ? ((row.tracksWithRelease / row.totalTracks) * 100).toFixed(1) : '0.0'}% | ${row.avgBackpoolAgeYears.toFixed(1)} |`
      );
    });

    lines.push('');
    lines.push('## Rotation Backpool Tracks je Sender');
    lines.push('');
    rows.forEach((row) => {
      lines.push(`### ${row.stationName}`);
      if (!row.rotationBackpoolTracks.length) {
        lines.push('- Keine Rotation-Backpool-Titel im gewählten Zeitraum.');
        lines.push('');
        return;
      }
      row.rotationBackpoolTracks.forEach((track, index) => {
        lines.push(
          `${index + 1}. ${track.artist} - ${track.title} | ${track.plays} Plays | Ø/Tag: ${track.playsPerDay.toFixed(2)} | aktive Tage: ${track.activeDays} | Spannweite: ${track.spanDays} Tage | Ø Abstand: ${track.cadenceDays ? track.cadenceDays.toFixed(2) : '-'} Tage`
        );
      });
      lines.push('');
    });

    lines.push('## Release-basierter Backpool (Legacy)');
    lines.push('');
    rows.forEach((row) => {
      lines.push(`### ${row.stationName}`);
      if (!row.lowRotationBackpoolTracks.length) {
        lines.push(`- Keine Low-Rotation-Backpool-Titel (Schwelle: <= ${lowRotationMax.toFixed(2)} Plays/Tag).`);
        lines.push('');
        return;
      }
      row.lowRotationBackpoolTracks.forEach((track, index) => {
        lines.push(
          `${index + 1}. ${track.artist} - ${track.title} | ${track.plays} Plays | Ø/Tag: ${track.playsPerDay.toFixed(2)} | Release: ${track.releaseDate}`
        );
      });
      lines.push('');
    });

    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  }

  db.close();
  logger?.info(
    {
      from: fromBerlin.toISODate(),
      to: toBerlin.toISODate(),
      cutoff: backpoolCutoff.toISODate(),
      minReleaseConfidence: confidenceFloor,
      rotationMinDailyPlays: rotationMinDaily,
      lowRotationMaxDailyPlays: lowRotationMax,
      rotationMinActiveDays: rotationMinDays,
      rotationMinSpanDays: rotationSpanMin,
      rotationAdaptive: adaptiveRotation,
      rangeDays,
      stations: rows.length,
      mdPath,
      stationId: stationId ?? null,
      writeReport,
      autoEnrichMissingRelease: enrichEnabled
    },
    'backpool analysis completed'
  );
  return {
    from: fromBerlin.toISODate(),
    to: toBerlin.toISODate(),
    cutoff: backpoolCutoff.toISODate(),
    minReleaseConfidence: confidenceFloor,
    rotationMinDailyPlays: rotationMinDaily,
    lowRotationMaxDailyPlays: lowRotationMax,
    rotationMinActiveDays: rotationMinDays,
    rotationMinSpanDays: rotationSpanMin,
    rotationAdaptive: adaptiveRotation,
    rangeDays,
    rows,
    mdPath
  };
}
