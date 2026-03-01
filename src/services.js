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
  upsertTrackMetadata,
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

function textLooksLikeArtist(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return /(?:\s(?:x|vs)\s|&|,| feat\.?| ft\.?| dj\s|mc\s)/i.test(text);
}

function textLooksLikeSongTitle(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return /[!?]|(?:\b(love|heart|night|day|dream|dance|baby|sorry|home|body|fire|song)\b)/i.test(text);
}

function metadataQuality(row) {
  if (!row) return -1;
  let score = 0;
  if (row.verified_exists === 1) score += 5;
  if (row.verified_exists === 0) score -= 2;
  const conf = Number(row.verification_confidence);
  if (Number.isFinite(conf)) score += conf * 3;
  if (row.release_date_utc) score += 1;
  if (row.genre) score += 0.3;
  if (row.chart_single_rank) score += 0.4;
  return score;
}

function orientationQuality(row, metadataRow) {
  let score = Math.log1p(Number(row.plays || 0));
  score += metadataQuality(metadataRow);

  if (textLooksLikeArtist(row.artist)) score += 0.7;
  if (textLooksLikeArtist(row.title)) score -= 0.7;
  if (textLooksLikeSongTitle(row.title)) score += 0.4;
  if (textLooksLikeSongTitle(row.artist)) score -= 0.4;

  const artistWords = String(row.artist || '').trim().split(/\s+/).filter(Boolean).length;
  if (artistWords > 7) score -= 0.3;
  return score;
}

function preferredMetadataRow(a, b) {
  if (!a && !b) return null;
  if (a && !b) return a;
  if (!a && b) return b;
  return metadataQuality(a) >= metadataQuality(b) ? a : b;
}

export function runTrackOrientationMaintenance({
  dbPath,
  dryRun = false,
  minScoreGap = 0.35,
  minPlayRatio = 1.2,
  maxPairs = 5000,
  logger
}) {
  const db = openDb(dbPath);
  const trackRows = db.prepare(`
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as plays
    from plays
    group by track_key
  `).all();
  const metadataRows = db.prepare('select * from track_metadata').all();
  const metadataByTrackKey = new Map(metadataRows.map((row) => [row.track_key, row]));

  const byOrientation = new Map();
  for (const row of trackRows) {
    byOrientation.set(`${row.artist}||${row.title}`, row);
  }

  const candidates = [];
  for (const row of trackRows) {
    const reverse = byOrientation.get(`${row.title}||${row.artist}`);
    if (!reverse) continue;
    if (String(row.track_key) >= String(reverse.track_key)) continue;

    const metaA = metadataByTrackKey.get(row.track_key) ?? null;
    const metaB = metadataByTrackKey.get(reverse.track_key) ?? null;
    const scoreA = orientationQuality(row, metaA);
    const scoreB = orientationQuality(reverse, metaB);
    const gap = Math.abs(scoreA - scoreB);
    const maxPlays = Math.max(Number(row.plays || 0), Number(reverse.plays || 0));
    const minPlays = Math.max(1, Math.min(Number(row.plays || 0), Number(reverse.plays || 0)));
    const playRatio = maxPlays / minPlays;
    if (gap < minScoreGap && playRatio < minPlayRatio) {
      continue;
    }

    const winner = scoreA >= scoreB ? row : reverse;
    const loser = winner.track_key === row.track_key ? reverse : row;
    candidates.push({
      winnerKey: winner.track_key,
      loserKey: loser.track_key,
      winnerArtist: winner.artist,
      winnerTitle: winner.title,
      scoreGap: gap,
      playRatio,
      winnerPlays: Number(winner.plays || 0),
      loserPlays: Number(loser.plays || 0)
    });
  }

  candidates.sort((a, b) => (b.winnerPlays + b.loserPlays) - (a.winnerPlays + a.loserPlays));
  const selected = candidates.slice(0, Math.max(1, Number(maxPairs) || 5000));

  let merged = 0;
  let playsUpdated = 0;
  let metadataUpdated = 0;
  let dailyRowsRebuilt = 0;

  if (!dryRun && selected.length > 0) {
    const tx = db.transaction(() => {
      for (const pair of selected) {
        const winnerMeta = metadataByTrackKey.get(pair.winnerKey) ?? null;
        const loserMeta = metadataByTrackKey.get(pair.loserKey) ?? null;

        const playChanges = db.prepare(`
          update plays
          set track_key = ?, artist = ?, title = ?
          where track_key = ?
        `).run(pair.winnerKey, pair.winnerArtist, pair.winnerTitle, pair.loserKey).changes;
        playsUpdated += playChanges;

        const dailyByStation = db.prepare(`
          select date_berlin, station_id, sum(plays) as plays
          from daily_track_stats
          where track_key in (?, ?)
          group by date_berlin, station_id
        `).all(pair.winnerKey, pair.loserKey);
        if (dailyByStation.length) {
          db.prepare('delete from daily_track_stats where track_key in (?, ?)').run(pair.winnerKey, pair.loserKey);
          const insertDaily = db.prepare(`
            insert into daily_track_stats(date_berlin, station_id, track_key, artist, title, plays)
            values (?, ?, ?, ?, ?, ?)
          `);
          for (const row of dailyByStation) {
            insertDaily.run(row.date_berlin, row.station_id, pair.winnerKey, pair.winnerArtist, pair.winnerTitle, Number(row.plays || 0));
            dailyRowsRebuilt += 1;
          }
        }

        const dailyOverall = db.prepare(`
          select date_berlin, sum(plays) as plays
          from daily_overall_track_stats
          where track_key in (?, ?)
          group by date_berlin
        `).all(pair.winnerKey, pair.loserKey);
        if (dailyOverall.length) {
          db.prepare('delete from daily_overall_track_stats where track_key in (?, ?)').run(pair.winnerKey, pair.loserKey);
          const insertOverall = db.prepare(`
            insert into daily_overall_track_stats(date_berlin, track_key, artist, title, plays)
            values (?, ?, ?, ?, ?)
          `);
          for (const row of dailyOverall) {
            insertOverall.run(row.date_berlin, pair.winnerKey, pair.winnerArtist, pair.winnerTitle, Number(row.plays || 0));
          }
        }

        db.prepare('delete from backpool_track_catalog where track_key = ?').run(pair.loserKey);

        const chosenMeta = preferredMetadataRow(winnerMeta, loserMeta);
        if (chosenMeta) {
          const mergedMeta = {
            ...chosenMeta,
            track_key: pair.winnerKey,
            artist: pair.winnerArtist,
            title: pair.winnerTitle
          };
          upsertTrackMetadata(db, mergedMeta);
          metadataByTrackKey.set(pair.winnerKey, mergedMeta);
          metadataUpdated += 1;
        }
        if (loserMeta) {
          db.prepare('delete from track_metadata where track_key = ?').run(pair.loserKey);
          metadataByTrackKey.delete(pair.loserKey);
        }

        merged += 1;
      }
    });
    tx();
  }

  db.close();
  const result = {
    scannedTracks: trackRows.length,
    candidatePairs: candidates.length,
    selectedPairs: selected.length,
    merged,
    playsUpdated,
    metadataUpdated,
    dailyRowsRebuilt,
    dryRun
  };
  logger?.info(result, 'track orientation maintenance completed');
  return result;
}

export function runNoisePlayCleanup({ dbPath, dryRun = false, logger }) {
  const db = openDb(dbPath);
  const whereClause = `
    length(title_raw) > 220
    or length(artist_raw) > 140
    or length(title) > 180
    or length(artist) > 120
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%freestar%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%xmlhttprequest%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%window.trackserver%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%benutzer vereinbarung%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%cookie-verwaltung%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%serververbindung verloren%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%installieren sie gratis%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%onlineradio deutschland%'
    or lower(artist_raw || ' ' || title_raw || ' ' || artist || ' ' || title) like '%am mikrofon%'
  `;

  const found = db.prepare(`select count(*) as c from plays where ${whereClause}`).get()?.c ?? 0;
  let removed = 0;
  if (!dryRun && found > 0) {
    removed = db.prepare(`delete from plays where ${whereClause}`).run().changes;
  }
  db.close();

  const result = { found, removed, dryRun };
  logger?.info(result, 'noise play cleanup completed');
  return result;
}

export function runPromoMarkerMaintenance({ dbPath, dryRun = false, maxPairs = 5000, logger }) {
  const db = openDb(dbPath);
  const candidateRows = db.prepare(`
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as plays
    from plays
    where instr(lower(artist), '*neu*') > 0
      or instr(lower(title), '*neu*') > 0
      or instr(lower(artist), '[neu]') > 0
      or instr(lower(title), '[neu]') > 0
      or instr(lower(artist), '(neu)') > 0
      or instr(lower(title), '(neu)') > 0
      or lower(artist) like 'neu - %'
      or lower(title) like 'neu - %'
      or instr(artist, '"') > 0
      or instr(title, '"') > 0
      or instr(artist, '“') > 0
      or instr(title, '“') > 0
      or instr(artist, '”') > 0
      or instr(title, '”') > 0
      or instr(artist, '„') > 0
      or instr(title, '„') > 0
    group by track_key
  `).all();

  const metadataRows = db.prepare('select * from track_metadata').all();
  const metadataByTrackKey = new Map(metadataRows.map((row) => [row.track_key, row]));

  const mappings = [];
  for (const row of candidateRows) {
    const normalized = normalizeArtistTitle(row.artist, row.title);
    if (!normalized.artist || !normalized.title) continue;
    if (normalized.trackKey === row.track_key) continue;
    mappings.push({
      oldKey: row.track_key,
      newKey: normalized.trackKey,
      artist: normalized.artist,
      title: normalized.title,
      plays: Number(row.plays || 0)
    });
  }

  mappings.sort((a, b) => b.plays - a.plays);
  const selected = mappings.slice(0, Math.max(1, Number(maxPairs) || 5000));

  let merged = 0;
  let playsUpdated = 0;
  let metadataUpdated = 0;
  let dailyRowsRebuilt = 0;

  if (!dryRun && selected.length > 0) {
    const tx = db.transaction(() => {
      for (const map of selected) {
        const winnerMeta = metadataByTrackKey.get(map.newKey) ?? null;
        const loserMeta = metadataByTrackKey.get(map.oldKey) ?? null;

        const changes = db.prepare(`
          update plays
          set track_key = ?, artist = ?, title = ?
          where track_key = ?
        `).run(map.newKey, map.artist, map.title, map.oldKey).changes;
        playsUpdated += changes;

        const dailyByStation = db.prepare(`
          select date_berlin, station_id, sum(plays) as plays
          from daily_track_stats
          where track_key in (?, ?)
          group by date_berlin, station_id
        `).all(map.newKey, map.oldKey);
        if (dailyByStation.length) {
          db.prepare('delete from daily_track_stats where track_key in (?, ?)').run(map.newKey, map.oldKey);
          const insertDaily = db.prepare(`
            insert into daily_track_stats(date_berlin, station_id, track_key, artist, title, plays)
            values (?, ?, ?, ?, ?, ?)
          `);
          for (const row of dailyByStation) {
            insertDaily.run(row.date_berlin, row.station_id, map.newKey, map.artist, map.title, Number(row.plays || 0));
            dailyRowsRebuilt += 1;
          }
        }

        const dailyOverall = db.prepare(`
          select date_berlin, sum(plays) as plays
          from daily_overall_track_stats
          where track_key in (?, ?)
          group by date_berlin
        `).all(map.newKey, map.oldKey);
        if (dailyOverall.length) {
          db.prepare('delete from daily_overall_track_stats where track_key in (?, ?)').run(map.newKey, map.oldKey);
          const insertOverall = db.prepare(`
            insert into daily_overall_track_stats(date_berlin, track_key, artist, title, plays)
            values (?, ?, ?, ?, ?)
          `);
          for (const row of dailyOverall) {
            insertOverall.run(row.date_berlin, map.newKey, map.artist, map.title, Number(row.plays || 0));
          }
        }

        db.prepare('delete from backpool_track_catalog where track_key = ?').run(map.oldKey);

        const chosenMeta = preferredMetadataRow(winnerMeta, loserMeta);
        if (chosenMeta) {
          const mergedMeta = {
            ...chosenMeta,
            track_key: map.newKey,
            artist: map.artist,
            title: map.title
          };
          upsertTrackMetadata(db, mergedMeta);
          metadataByTrackKey.set(map.newKey, mergedMeta);
          metadataUpdated += 1;
        }
        if (loserMeta) {
          db.prepare('delete from track_metadata where track_key = ?').run(map.oldKey);
          metadataByTrackKey.delete(map.oldKey);
        }

        merged += 1;
      }
    });
    tx();
  }

  db.close();
  const result = {
    candidates: mappings.length,
    selectedPairs: selected.length,
    merged,
    playsUpdated,
    metadataUpdated,
    dailyRowsRebuilt,
    dryRun
  };
  logger?.info(result, 'promo/quote marker maintenance completed');
  return result;
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
  minTrackAgeDays = 30,
  rotationMinReleaseAgeDays = 1095,
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
  const trackAgeMin = Math.max(1, Math.floor(Number(minTrackAgeDays) || 30));
  const releaseAgeMin = Math.max(0, Math.floor(Number(rotationMinReleaseAgeDays) || 1095));
  const adaptiveRotation = rotationAdaptive !== false;
  const rangeDays = Math.max(1, Math.floor(toBerlin.diff(fromBerlin, 'days').days) + 1);

  const selectedStations = stationId
    ? config.stations.filter((station) => station.id === stationId)
    : config.stations;
  if (stationId && selectedStations.length === 0) {
    db.close();
    throw new Error(`Unknown station id: ${stationId}`);
  }
  const selectedStationIds = selectedStations.map((station) => station.id);
  const crossStationTrendSignals = new Map();
  const crossStationTrendStationShareMin = 0.3;
  const crossStationRecentWindowDays = Math.max(7, Math.min(30, rangeDays));
  const crossStationRecentStartUtcIso = toBerlin
    .plus({ days: 1 })
    .minus({ days: crossStationRecentWindowDays })
    .toUTC()
    .toISO();

  if (selectedStationIds.length > 1) {
    const stationPlaceholders = selectedStationIds.map(() => '?').join(', ');
    const globalRows = db.prepare(`
      select p.track_key as track_key
      , count(*) as plays
      , sum(case when p.played_at_utc >= ? then 1 else 0 end) as recent_plays
      , count(distinct p.station_id) as station_count
      from plays p
      where p.station_id in (${stationPlaceholders})
        and p.played_at_utc >= ?
        and p.played_at_utc < ?
      group by p.track_key
    `).all(
      crossStationRecentStartUtcIso,
      ...selectedStationIds,
      rangeStartUtcIso,
      rangeEndUtcIso
    );

    const minStationsForTrend = Math.max(2, Math.ceil(selectedStationIds.length * crossStationTrendStationShareMin));
    const crossStationRecentDailyFloor = Math.max(0.45, rotationMinDaily * 1.2);
    const crossStationMomentumFactor = 1.35;
    for (const row of globalRows) {
      const plays = Number(row.plays || 0);
      const recentPlays = Number(row.recent_plays || 0);
      const stationCount = Number(row.station_count || 0);
      const stationShare = selectedStationIds.length > 0 ? stationCount / selectedStationIds.length : 0;
      const playsPerDay = plays / rangeDays;
      const recentPlaysPerDay = recentPlays / crossStationRecentWindowDays;
      const recentShare = plays > 0 ? recentPlays / plays : 0;

      const isCrossStationTrend =
        plays >= Math.max(4, Number(minTrackPlays || 1)) &&
        stationCount >= minStationsForTrend &&
        stationShare >= crossStationTrendStationShareMin &&
        recentPlays >= 4 &&
        recentShare >= 0.55 &&
        recentPlaysPerDay >= crossStationRecentDailyFloor &&
        recentPlaysPerDay >= (playsPerDay * crossStationMomentumFactor);

      if (isCrossStationTrend) {
        crossStationTrendSignals.set(row.track_key, {
          stationCount,
          stationShare,
          recentPlays,
          recentShare,
          recentPlaysPerDay
        });
      }
    }
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
    const effectiveTrackAgeMin = adaptiveRotation
      ? Math.max(1, Math.min(trackAgeMin, Math.floor(Math.max(1, rateBasisDays * 0.5))))
      : trackAgeMin;
    const effectiveReleaseAgeMin = releaseAgeMin;
    const recentWindowDays = Math.max(7, Math.min(30, rateBasisDays));
    const recentStartUtcIso = toBerlin.plus({ days: 1 }).minus({ days: recentWindowDays }).toUTC().toISO();
    const recentPlaysByTrack = new Map(
      db.prepare(`
        select track_key, count(*) as recent_plays
        from plays
        where station_id = ?
          and played_at_utc >= ?
          and played_at_utc < ?
        group by track_key
      `).all(station.id, recentStartUtcIso, rangeEndUtcIso).map((row) => [row.track_key, Number(row.recent_plays || 0)])
    );
    const resurgenceMinRecentDaily = Math.max(0.6, rotationMinDaily * 2);
    const resurgenceFactor = 1.8;
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
      const stationAgeDays =
        firstPlayed && firstPlayed.isValid
          ? Math.max(1, Math.floor(toBerlin.startOf('day').diff(firstPlayed.startOf('day'), 'days').days) + 1)
          : 0;
      const releaseAgeDays =
        release && release.isValid
          ? Math.max(0, Math.floor(toBerlin.startOf('day').diff(release.startOf('day'), 'days').days))
          : null;
      const recentPlays = Number(recentPlaysByTrack.get(row.track_key) || 0);
      const recentPlaysPerDay = recentPlays / recentWindowDays;
      const isStationResurgence =
        recentPlays >= 4 &&
        recentPlaysPerDay >= resurgenceMinRecentDaily &&
        recentPlaysPerDay >= (playsPerDay * resurgenceFactor);
      const crossStationSignal = crossStationTrendSignals.get(row.track_key) ?? null;
      const isRecentResurgence = isStationResurgence || Boolean(crossStationSignal);

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
        stationAgeDays,
        releaseAgeDays,
        recentPlays,
        recentPlaysPerDay,
        crossStationTrendStationCount: Number(crossStationSignal?.stationCount || 0),
        crossStationTrendStationShare: Number(crossStationSignal?.stationShare || 0),
        crossStationTrendRecentShare: Number(crossStationSignal?.recentShare || 0),
        crossStationTrendRecentPlays: Number(crossStationSignal?.recentPlays || 0),
        crossStationTrendRecentPlaysPerDay: Number(crossStationSignal?.recentPlaysPerDay || 0),
        isRecentResurgence,
        spanDays,
        cadenceDays
      };
    });

    const withRelease = classifiedRows.filter((row) => row.hasValidatedRelease);
    const rotationBackpoolTracks = classifiedRows
      .filter((row) => (
        row.hasValidatedRelease &&
        row.plays >= Number(minTrackPlays || 1) &&
        row.playsPerDay >= rotationMinDaily &&
        row.playsPerDay <= lowRotationMax &&
        row.stationAgeDays >= effectiveTrackAgeMin &&
        row.releaseAgeDays !== null &&
        row.releaseAgeDays >= effectiveReleaseAgeMin &&
        !row.isRecentResurgence &&
        row.activeDays >= effectiveRotationActiveMin &&
        row.spanDays >= effectiveRotationSpanMin
      ))
      .sort((a, b) => {
        if (a.playsPerDay < b.playsPerDay) return -1;
        if (a.playsPerDay > b.playsPerDay) return 1;
        return Number(b.plays || 0) - Number(a.plays || 0);
      });
    const hotRotationTracks = classifiedRows
      .filter((row) => !row.isRecentResurgence && row.playsPerDay > lowRotationMax)
      .sort((a, b) => Number(b.plays || 0) - Number(a.plays || 0));
    const sparseRotationTracks = classifiedRows
      .filter((row) => (
        !row.isRecentResurgence &&
        (
          row.plays < Number(minTrackPlays || 1) ||
          row.playsPerDay < rotationMinDaily ||
          row.activeDays < effectiveRotationActiveMin ||
          row.spanDays < effectiveRotationSpanMin
        )
      ))
      .sort((a, b) => Number(b.plays || 0) - Number(a.plays || 0));
    const resurgenceTracks = classifiedRows
      .filter((row) => row.isRecentResurgence)
      .sort((a, b) => Number(b.recentPlaysPerDay || 0) - Number(a.recentPlaysPerDay || 0));
    const recentTracks = classifiedRows
      .filter((row) => (
        (row.stationAgeDays > 0 && row.stationAgeDays < effectiveTrackAgeMin) ||
        row.releaseAgeDays === null ||
        (row.releaseAgeDays !== null && row.releaseAgeDays < effectiveReleaseAgeMin)
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
      stationAgeDays: Number(row.stationAgeDays || 0),
      releaseAgeDays: Number.isFinite(row.releaseAgeDays) ? Number(row.releaseAgeDays) : null,
      recentPlays: Number(row.recentPlays || 0),
      recentPlaysPerDay: Number(row.recentPlaysPerDay || 0),
      globalTrendStationCount: Number(row.crossStationTrendStationCount || 0),
      globalTrendStationShare: Number(row.crossStationTrendStationShare || 0),
      globalTrendRecentShare: Number(row.crossStationTrendRecentShare || 0),
      globalTrendRecentPlays: Number(row.crossStationTrendRecentPlays || 0),
      globalTrendRecentPlaysPerDay: Number(row.crossStationTrendRecentPlaysPerDay || 0),
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
      rotationMinReleaseAgeDays: releaseAgeMin,
      minTrackAgeDays: trackAgeMin,
      rotationAdaptive: adaptiveRotation,
      rotationWarmupMode: warmupMode,
      rotationEffectiveMinActiveDays: effectiveRotationActiveMin,
      rotationEffectiveMinSpanDays: effectiveRotationSpanMin,
      rotationEffectiveMinTrackAgeDays: effectiveTrackAgeMin,
      rotationEffectiveMinReleaseAgeDays: effectiveReleaseAgeMin,
      rotationRateBasisDays: rateBasisDays,
      rotationRecentWindowDays: recentWindowDays,
      rangeDays,
      observedCoverageDays,
      observedSpanDays,
      hasRotationHistory: observedSpanDays >= rotationSpanMin,
      rotationBackpoolTrackCount: rotationBackpoolTracks.length,
      rotationBackpoolPlays,
      rotationBackpoolShare,
      resurgenceTrackCount: resurgenceTracks.length,
      rotationPattern,
      backpoolTrackCount: backpoolTracks.length,
      lowRotationBackpoolTrackCount: lowRotationBackpoolTracks.length,
      backpoolPlays,
      backpoolShare: share,
      avgBackpoolAgeYears: avgAgeYears,
      rotationBackpoolTracks: rotationBackpoolTracks.slice(0, topLimit).map(mapRotationTrack),
      hotRotationTracks: hotRotationTracks.slice(0, topLimit).map(mapRotationTrack),
      sparseRotationTracks: sparseRotationTracks.slice(0, topLimit).map(mapRotationTrack),
      resurgenceTracks: resurgenceTracks.slice(0, topLimit).map(mapRotationTrack),
      recentTracks: recentTracks.slice(0, topLimit).map(mapRotationTrack),
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
      `- Neu-Filter: Titel muessen mind. **${trackAgeMin} Tage** im Senderverlauf vorhanden sein (adaptive Absenkung bei kurzer Historie moeglich).`,
      `- Release-Filter (Rotation): validiertes Release-Alter **>= ${releaseAgeMin} Tage** (ohne Release kein Rotation-Backpool).`,
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
      rotationMinReleaseAgeDays: releaseAgeMin,
      minTrackAgeDays: trackAgeMin,
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
    rotationMinReleaseAgeDays: releaseAgeMin,
    minTrackAgeDays: trackAgeMin,
    rotationAdaptive: adaptiveRotation,
    rangeDays,
    rows,
    mdPath
  };
}
