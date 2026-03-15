import path from 'node:path';
import fs from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from './config.js';
import {
  isLikelyNoiseTrack,
  isLikelyJingleLike,
  normalizeArtistTitle,
  canonicalTitleKey,
  primaryArtist,
  artistSet,
  artistOverlapRatioLoose
} from './normalize.js';
import {
  openDb,
  upsertStation,
  insertPlayIgnore,
  insertDedupEvent,
  getStationTrackCounts,
  getStationTrackCountsWithMetadata,
  getStationTotalPlays,
  getStationPlayedAtUtc,
  getOverallTrackCounts,
  upsertTrackMetadata,
  upsertCanonicalMap,
  listCanonicalMap,
  clearDailyStatsForDate,
  upsertDailyStationStat,
  upsertDailyTrackStat,
  upsertDailyOverallTrackStat
} from './db.js';
import {
  BERLIN_TZ,
  buildWeekRanges,
  buildDayRangeBerlin,
  berlinTodayIso,
  isoUtcNow,
  isWithinLocalHourWindow
} from './time.js';
import { buildStationAnalytics, buildCrossStationAnalytics } from './analytics.js';
import { writeMarkdownReport, writeCsvExports, writeStationMarkdownReport, gzipFile } from './report.js';
import { HttpFetcher } from './fetchers/httpFetcher.js';
import { PlaywrightFetcher } from './fetchers/playwrightFetcher.js';
import { GenericHtmlParser } from './parsers/genericHtml.js';
import { OnlineradioboxParser } from './parsers/onlineradiobox.js';
import { DlfNovaParser } from './parsers/dlfNova.js';
import { FluxFmParser } from './parsers/fluxfm.js';
import { NrwLokalradiosJsonParser } from './parsers/nrwlokalradiosJson.js';
import { RadioMenuParser } from './parsers/radioMenu.js';
import { GenericHtmlOrOnlineradioboxParser } from './parsers/genericHtmlOrOnlineradiobox.js';
import { TrackVerifier } from './trackVerifier.js';
import {
  DEFAULT_DEDUP_COOLDOWN_SECONDS,
  shouldDedupByCooldown,
  songKeyFromMetadataOrFallback
} from './dedup.js';

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
      return new GenericHtmlOrOnlineradioboxParser({ timezone: station.timezone });
    case 'nrwlokalradios_json':
      return new NrwLokalradiosJsonParser({ timezone: station.timezone });
    case 'radiomenu':
      return new RadioMenuParser({ timezone: station.timezone });
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

function isPhonostarTitleUrl(url) {
  return /https?:\/\/(?:www\.)?phonostar\.de\/radio\/[^/]+\/titel(?:\?.*)?$/i.test(String(url || ''));
}

function withPageParam(url, page) {
  if (!Number.isFinite(page) || page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('page', String(page));
  return parsed.toString();
}

function minuteOfDayInTimezone(date, timezone) {
  const dt = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(timezone || BERLIN_TZ);
  return dt.hour * 60 + dt.minute;
}

async function fetchPhonostarPaginatedPlays({ fetcher, parser, url, timezone, maxPages = 6 }) {
  const collected = [];
  const seen = new Set();
  let lastMinuteOfDay = null;
  let crossedDayBoundary = false;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = withPageParam(url, page);
    const html = await fetcher.fetchHtml(pageUrl);
    const parsed = parser.parse(html, pageUrl);
    pagesFetched += 1;
    if (!parsed.length) break;

    for (const play of parsed) {
      const minute = minuteOfDayInTimezone(play.playedAt, timezone);
      if (lastMinuteOfDay !== null && minute > lastMinuteOfDay) {
        crossedDayBoundary = true;
        break;
      }

      lastMinuteOfDay = minute;
      const key = `${play.playedAt.toISOString()}|${play.artistRaw}|${play.titleRaw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(play);
    }

    if (crossedDayBoundary) break;
  }

  return { plays: collected, pagesFetched, crossedDayBoundary };
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

function parsePayloadJsonSafe(payloadJson) {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractItunesCanonicalName(metaRow, minConfidence = 0.72) {
  if (!metaRow) return null;
  const verified = Number(metaRow.verified_exists);
  if (!Number.isFinite(verified) || verified !== 1) return null;
  const confidence = Number(metaRow.verification_confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return null;

  const payload = parsePayloadJsonSafe(metaRow.payload_json);
  const topArtist = String(payload?.topArtist ?? '').trim();
  const topTitle = String(payload?.topTitle ?? '').trim();
  if (!topArtist || !topTitle) return null;

  return {
    artist: topArtist,
    title: topTitle,
    confidence
  };
}

function artistTokenSet(value) {
  const stop = new Set(['feat', 'ft', 'featuring', 'and', 'und', 'x', 'vs', 'with']);
  return new Set(
    String(value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2 && !stop.has(x))
  );
}

function artistOverlapRatio(a, b) {
  const aa = artistTokenSet(a);
  const bb = artistTokenSet(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) {
    if (bb.has(token)) common += 1;
  }
  return common / Math.max(1, Math.min(aa.size, bb.size));
}

function normalizeTitleForMatch(value) {
  const normalized = normalizeArtistTitle('', value).title;
  return canonicalTitleKey(normalized);
}

function canonicalMapKey(canonicalTitle, canonicalPrimaryArtist) {
  return `${canonicalTitle}||${canonicalPrimaryArtist}`;
}

function trackCanonicalId(metaRow) {
  const canonicalId = String(metaRow?.canonical_id ?? '').trim().toLowerCase();
  if (canonicalId) return canonicalId;
  const isrc = String(metaRow?.isrc ?? '').trim().toLowerCase();
  if (isrc) return `isrc:${isrc}`;
  const external = String(metaRow?.external_track_id ?? '').trim().toLowerCase();
  if (external) return `external:${external}`;
  return null;
}

function isProperTokenSubset(subset, superset) {
  if (!subset.size || !superset.size) return false;
  if (subset.size >= superset.size) return false;
  for (const token of subset) {
    if (!superset.has(token)) return false;
  }
  return true;
}

function trackStableIdentity(metaRow) {
  const isrc = String(metaRow?.isrc ?? '').trim().toLowerCase();
  if (isrc) return { kind: 'isrc', key: `isrc:${isrc}` };
  const external = String(metaRow?.external_track_id ?? '').trim().toLowerCase();
  if (external) return { kind: 'external', key: `external:${external}` };
  return { kind: 'none', key: null };
}

/**
 * Performs a single track-key remap inside an existing db.transaction():
 * moves all plays, rebuilds daily stats, cleans up metadata.
 * Returns { playsUpdated, dailyRowsRebuilt, metadataUpdated }.
 */
function mergeTrackPair(db, { winnerKey, loserKey, artist, title }, metadataByTrackKey) {
  const winnerMeta = metadataByTrackKey.get(winnerKey) ?? null;
  const loserMeta = metadataByTrackKey.get(loserKey) ?? null;

  const playsUpdated = db.prepare(`
    update plays
    set track_key = ?, artist = ?, title = ?
    where track_key = ?
  `).run(winnerKey, artist, title, loserKey).changes;

  let dailyRowsRebuilt = 0;

  const dailyByStation = db.prepare(`
    select date_berlin, station_id, sum(plays) as plays
    from daily_track_stats
    where track_key in (?, ?)
    group by date_berlin, station_id
  `).all(winnerKey, loserKey);
  if (dailyByStation.length) {
    db.prepare('delete from daily_track_stats where track_key in (?, ?)').run(winnerKey, loserKey);
    const insertDaily = db.prepare(`
      insert into daily_track_stats(date_berlin, station_id, track_key, artist, title, plays)
      values (?, ?, ?, ?, ?, ?)
    `);
    for (const row of dailyByStation) {
      insertDaily.run(row.date_berlin, row.station_id, winnerKey, artist, title, Number(row.plays || 0));
      dailyRowsRebuilt += 1;
    }
  }

  const dailyOverall = db.prepare(`
    select date_berlin, sum(plays) as plays
    from daily_overall_track_stats
    where track_key in (?, ?)
    group by date_berlin
  `).all(winnerKey, loserKey);
  if (dailyOverall.length) {
    db.prepare('delete from daily_overall_track_stats where track_key in (?, ?)').run(winnerKey, loserKey);
    const insertOverall = db.prepare(`
      insert into daily_overall_track_stats(date_berlin, track_key, artist, title, plays)
      values (?, ?, ?, ?, ?)
    `);
    for (const row of dailyOverall) {
      insertOverall.run(row.date_berlin, winnerKey, artist, title, Number(row.plays || 0));
    }
  }

  let metadataUpdated = 0;
  const chosenMeta = preferredMetadataRow(winnerMeta, loserMeta);
  if (chosenMeta) {
    const mergedMeta = { ...chosenMeta, track_key: winnerKey, artist, title };
    upsertTrackMetadata(db, mergedMeta);
    metadataByTrackKey.set(winnerKey, mergedMeta);
    metadataUpdated = 1;
  }
  if (loserMeta) {
    db.prepare('delete from track_metadata where track_key = ?').run(loserKey);
    metadataByTrackKey.delete(loserKey);
  }

  return { playsUpdated, dailyRowsRebuilt, metadataUpdated };
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
        const r = mergeTrackPair(
          db,
          { winnerKey: pair.winnerKey, loserKey: pair.loserKey, artist: pair.winnerArtist, title: pair.winnerTitle },
          metadataByTrackKey
        );
        playsUpdated += r.playsUpdated;
        dailyRowsRebuilt += r.dailyRowsRebuilt;
        metadataUpdated += r.metadataUpdated;
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
  const combinedExpr = "lower(coalesce(p.artist_raw, '') || ' ' || coalesce(p.title_raw, '') || ' ' || coalesce(p.artist, '') || ' ' || coalesce(p.title, ''))";
  const candidates = db.prepare(`
    select
      p.id,
      p.station_id,
      p.played_at_utc,
      p.artist_raw,
      p.title_raw,
      p.artist,
      p.title,
      s.name as station_name
    from plays p
    left join stations s on s.id = p.station_id
    where
      length(p.title_raw) > 220
      or length(p.artist_raw) > 140
      or length(p.title) > 180
      or length(p.artist) > 120
      or ${combinedExpr} like '%freestar%'
      or ${combinedExpr} like '%xmlhttprequest%'
      or ${combinedExpr} like '%window.trackserver%'
      or ${combinedExpr} like '%benutzer vereinbarung%'
      or ${combinedExpr} like '%cookie-verwaltung%'
      or ${combinedExpr} like '%serververbindung verloren%'
      or ${combinedExpr} like '%installieren sie gratis%'
      or ${combinedExpr} like '%onlineradio deutschland%'
      or ${combinedExpr} like '%am mikrofon%'
      or ${combinedExpr} like '%anruf im verkehrszentrum%'
      or ${combinedExpr} like '%jetzt anrufen%'
      or ${combinedExpr} like '%rufen sie an%'
      or ${combinedExpr} like '%ruf an%'
      or ${combinedExpr} like '%anrufen%'
      or ${combinedExpr} like '%hotline%'
      or ${combinedExpr} like '%kontakt zur%'
      or ${combinedExpr} like '%whatsapp%'
      or ${combinedExpr} like '%studio%'
      or ${combinedExpr} like '%leitung%'
      or ${combinedExpr} like '%gewinnspiel%'
      or ${combinedExpr} like '%wochenkracher%'
      or ${combinedExpr} like '%marken-discount%'
      or ${combinedExpr} like '%die abendshow%'
      or ${combinedExpr} like '%nachrichten%'
      or ${combinedExpr} like '%junge nacht%'
      or ${combinedExpr} like '%ard%'
      or ${combinedExpr} like '%aus dem%'
      or ${combinedExpr} like '%haus in%'
      or ${combinedExpr} like '%live aus dem%'
      or (${combinedExpr} like '%/%' and ${combinedExpr} like '%angriff%')
      or ${combinedExpr} like '%gegenseitige angriffe%'
      or ${combinedExpr} like '%werbeblock%'
      or ${combinedExpr} like '%commercial%'
      or ${combinedExpr} like '%promo%'
      or ${combinedExpr} like '%spot%'
      or ${combinedExpr} like '% sec%'
      or ${combinedExpr} like '% sek%'
      or ${combinedExpr} like '%kw %'
      or ${combinedExpr} like '%mehr musik%'
      or ${combinedExpr} like '%mehr abwechslung%'
      or ${combinedExpr} like '%niedersachs%'
      or ${combinedExpr} like '%bigfm%'
      or ${combinedExpr} like '%deutschlands biggste%'
      or ${combinedExpr} like '%baden württemberg%'
      or ${combinedExpr} like '%baden-württemberg%'
      or ${combinedExpr} like '%berlin%'
      or ${combinedExpr} glob '*[0-9]*'
  `).all();

  const toDelete = [];
  const affectedDates = new Set();
  for (const row of candidates) {
    const artist = row.artist_raw || row.artist || '';
    const title = row.title_raw || row.title || '';
    const isNoise = isLikelyNoiseTrack(artist, title, {
      stationName: row.station_name || '',
      stationId: row.station_id || ''
    });
    const isJingle = isLikelyJingleLike(artist, title, {
      stationName: row.station_name || '',
      stationId: row.station_id || ''
    });
    if (!isNoise && !isJingle) continue;
    toDelete.push(Number(row.id));
    const dateBerlin = DateTime.fromISO(row.played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ).toISODate();
    if (dateBerlin) affectedDates.add(dateBerlin);
  }

  const found = toDelete.length;
  let removed = 0;
  let dailyRowsRebuilt = 0;
  if (!dryRun && found > 0) {
    const tx = db.transaction(() => {
      const deleteChunk = db.prepare(`delete from plays where id in (${Array.from({ length: 200 }, () => '?').join(', ')})`);
      for (let i = 0; i < toDelete.length; i += 200) {
        const chunk = toDelete.slice(i, i + 200);
        const stmt = chunk.length === 200
          ? deleteChunk
          : db.prepare(`delete from plays where id in (${Array.from({ length: chunk.length }, () => '?').join(', ')})`);
        removed += stmt.run(...chunk).changes;
      }

      for (const dateBerlin of affectedDates) {
        const range = buildDayRangeBerlin(dateBerlin);
        db.prepare('delete from daily_station_stats where date_berlin = ?').run(dateBerlin);
        db.prepare('delete from daily_track_stats where date_berlin = ?').run(dateBerlin);
        db.prepare('delete from daily_overall_track_stats where date_berlin = ?').run(dateBerlin);

        const stationRows = db.prepare(`
          select station_id, count(*) as total_plays, count(distinct track_key) as unique_tracks
          from plays
          where played_at_utc >= ? and played_at_utc < ?
          group by station_id
        `).all(range.startUtcIso, range.endUtcIso);
        for (const row of stationRows) {
          upsertDailyStationStat(db, {
            date_berlin: dateBerlin,
            station_id: row.station_id,
            total_plays: Number(row.total_plays || 0),
            unique_tracks: Number(row.unique_tracks || 0)
          });
          dailyRowsRebuilt += 1;
        }

        const dailyTrackRows = db.prepare(`
          select
            station_id,
            track_key,
            min(artist) as artist,
            min(title) as title,
            count(*) as plays
          from plays
          where played_at_utc >= ? and played_at_utc < ?
          group by station_id, track_key
        `).all(range.startUtcIso, range.endUtcIso);
        for (const row of dailyTrackRows) {
          upsertDailyTrackStat(db, {
            date_berlin: dateBerlin,
            station_id: row.station_id,
            track_key: row.track_key,
            artist: row.artist,
            title: row.title,
            plays: Number(row.plays || 0)
          });
          dailyRowsRebuilt += 1;
        }

        const dailyOverallRows = db.prepare(`
          select
            track_key,
            min(artist) as artist,
            min(title) as title,
            count(*) as plays
          from plays
          where played_at_utc >= ? and played_at_utc < ?
          group by track_key
        `).all(range.startUtcIso, range.endUtcIso);
        for (const row of dailyOverallRows) {
          upsertDailyOverallTrackStat(db, {
            date_berlin: dateBerlin,
            track_key: row.track_key,
            artist: row.artist,
            title: row.title,
            plays: Number(row.plays || 0)
          });
          dailyRowsRebuilt += 1;
        }
      }
    });
    tx();
  }
  db.close();

  const result = {
    candidates: candidates.length,
    found,
    removed,
    affectedDays: affectedDates.size,
    dailyRowsRebuilt,
    dryRun
  };
  logger?.info(result, 'noise play cleanup completed');
  return result;
}

export function runMergeDuplicateTracksMaintenance({
  dbPath,
  dryRun = false,
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

  const grouped = new Map();
  const rowsByTrackKey = new Map();
  for (const row of trackRows) {
    const normalized = normalizeArtistTitle(row.artist, row.title);
    if (!normalized.artist || !normalized.title) continue;
    const titleMatch = normalizeTitleForMatch(row.title) || normalized.title;
    const primary = primaryArtist(normalized.artist);
    if (!titleMatch || !primary) continue;

    const meta = metadataByTrackKey.get(row.track_key) ?? null;
    const canonicalId = trackCanonicalId(meta);
    const enriched = {
      ...row,
      plays: Number(row.plays || 0),
      normalized,
      titleMatch,
      primaryArtist: primary,
      artistSet: artistSet(normalized.artist),
      canonicalId
    };
    rowsByTrackKey.set(row.track_key, enriched);
    const groupKey = canonicalMapKey(titleMatch, primary);
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(enriched);
  }

  const candidates = [];
  let groupsScanned = 0;
  const canonicalGroups = new Map();
  for (const row of rowsByTrackKey.values()) {
    if (!row.canonicalId) continue;
    if (!canonicalGroups.has(row.canonicalId)) canonicalGroups.set(row.canonicalId, []);
    canonicalGroups.get(row.canonicalId).push(row);
  }

  for (const rows of canonicalGroups.values()) {
    if (rows.length < 2) continue;
    const winner = [...rows].sort((a, b) => {
      if (a.plays !== b.plays) return b.plays - a.plays;
      const aLen = String(a.artist || '').length;
      const bLen = String(b.artist || '').length;
      if (aLen !== bLen) return bLen - aLen;
      return String(a.track_key).localeCompare(String(b.track_key));
    })[0];
    if (!winner) continue;
    const winnerCanonical = normalizeArtistTitle(winner.artist, winner.title);
    if (!winnerCanonical.artist || !winnerCanonical.title) continue;
    const canonicalTitle = normalizeTitleForMatch(winnerCanonical.title);
    const canonicalPrimaryArtist = primaryArtist(winnerCanonical.artist);
    if (!canonicalTitle || !canonicalPrimaryArtist) continue;

    if (winner.track_key !== winnerCanonical.trackKey) {
      candidates.push({
        oldKey: winner.track_key,
        newKey: winnerCanonical.trackKey,
        artist: winnerCanonical.artist,
        title: winnerCanonical.title,
        plays: winner.plays,
        score: 90,
        canonical_title: canonicalTitle,
        canonical_primary_artist: canonicalPrimaryArtist
      });
    }

    for (const loser of rows) {
      if (loser.track_key === winner.track_key) continue;
      if (loser.track_key === winnerCanonical.trackKey) continue;
      candidates.push({
        oldKey: loser.track_key,
        newKey: winnerCanonical.trackKey,
        artist: winnerCanonical.artist,
        title: winnerCanonical.title,
        plays: loser.plays,
        score: 80,
        canonical_title: canonicalTitle,
        canonical_primary_artist: canonicalPrimaryArtist
      });
    }
  }

  for (const [groupKey, rows] of grouped.entries()) {
    if (!rows.length) continue;
    groupsScanned += 1;
    const [canonicalTitle, canonicalPrimaryArtist] = groupKey.split('||');

    const winner = [...rows].sort((a, b) => {
      const aHasCanonical = a.canonicalId ? 1 : 0;
      const bHasCanonical = b.canonicalId ? 1 : 0;
      if (aHasCanonical !== bHasCanonical) return bHasCanonical - aHasCanonical;
      if (a.plays !== b.plays) return b.plays - a.plays;
      const aLen = String(a.artist || '').length;
      const bLen = String(b.artist || '').length;
      if (aLen !== bLen) return bLen - aLen;
      return String(a.track_key).localeCompare(String(b.track_key));
    })[0];
    if (!winner) continue;

    const winnerCanonical = normalizeArtistTitle(winner.artist, winner.title);
    if (!winnerCanonical.artist || !winnerCanonical.title) continue;

    if (winner.track_key !== winnerCanonical.trackKey) {
      candidates.push({
        oldKey: winner.track_key,
        newKey: winnerCanonical.trackKey,
        artist: winnerCanonical.artist,
        title: winnerCanonical.title,
        plays: winner.plays,
        score: 50,
        canonical_title: canonicalTitle,
        canonical_primary_artist: canonicalPrimaryArtist
      });
    }

    for (const loser of rows) {
      if (loser.track_key === winner.track_key) continue;
      if (loser.track_key === winnerCanonical.trackKey) continue;

      let allowed = false;
      let score = 0;
      if (winner.canonicalId && loser.canonicalId) {
        if (winner.canonicalId === loser.canonicalId) {
          allowed = true;
          score = 40;
        } else {
          continue;
        }
      }

      if (!allowed && loser.normalized.trackKey === winnerCanonical.trackKey) {
        allowed = true;
        score = 35;
      }

      if (!allowed) {
        const loserSet = loser.artistSet;
        const winnerSet = winner.artistSet;
        const subsetMatch = isProperTokenSubset(loserSet, winnerSet) || isProperTokenSubset(winnerSet, loserSet);
        if (subsetMatch && loser.titleMatch === winner.titleMatch && loser.primaryArtist === winner.primaryArtist) {
          allowed = true;
          score = 20;
        }
      }

      if (!allowed) {
        const loserSet = loser.artistSet;
        const winnerSet = winner.artistSet;
        const sameArtistSet =
          loserSet.size === winnerSet.size &&
          Array.from(loserSet).every((token) => winnerSet.has(token));
        if (sameArtistSet && loser.titleMatch === winner.titleMatch && loser.primaryArtist === winner.primaryArtist) {
          allowed = true;
          score = 25;
        }
      }

      if (!allowed) continue;

      candidates.push({
        oldKey: loser.track_key,
        newKey: winnerCanonical.trackKey,
        artist: winnerCanonical.artist,
        title: winnerCanonical.title,
        plays: loser.plays,
        score,
        canonical_title: canonicalTitle,
        canonical_primary_artist: canonicalPrimaryArtist
      });
    }
  }

  const bestByOldKey = new Map();
  for (const row of candidates) {
    if (!row.oldKey || !row.newKey) continue;
    if (row.oldKey === row.newKey) continue;
    const current = bestByOldKey.get(row.oldKey);
    if (!current || row.score > current.score || (row.score === current.score && row.plays > current.plays)) {
      bestByOldKey.set(row.oldKey, row);
    }
  }

  const mappings = Array.from(bestByOldKey.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, Math.max(1, Number(maxPairs) || 5000));

  let merged = 0;
  let playsUpdated = 0;
  let metadataUpdated = 0;
  let dailyRowsRebuilt = 0;
  const nowIso = isoUtcNow();

  if (!dryRun && mappings.length > 0) {
    const tx = db.transaction(() => {
      for (const map of mappings) {
        const r = mergeTrackPair(
          db,
          { winnerKey: map.newKey, loserKey: map.oldKey, artist: map.artist, title: map.title },
          metadataByTrackKey
        );
        playsUpdated += r.playsUpdated;
        dailyRowsRebuilt += r.dailyRowsRebuilt;
        metadataUpdated += r.metadataUpdated;
        upsertCanonicalMap(db, {
          canonical_title: map.canonical_title,
          canonical_primary_artist: map.canonical_primary_artist,
          canonical_track_key: map.newKey,
          updated_at_utc: nowIso
        });
        merged += 1;
      }
    });
    tx();
  }

  db.close();
  const result = {
    scannedTracks: trackRows.length,
    groupsScanned,
    candidates: candidates.length,
    selectedPairs: mappings.length,
    merged,
    playsUpdated,
    metadataUpdated,
    dailyRowsRebuilt,
    dryRun
  };
  logger?.info(result, 'duplicate track merge maintenance completed');
  return result;
}

export function runTitleVariantMergeMaintenance(opts) {
  return runMergeDuplicateTracksMaintenance(opts);
}

export function runCanonicalMapRefreshMaintenance({ dbPath, logger }) {
  const db = openDb(dbPath);
  const rows = db.prepare(`
    select track_key, min(artist) as artist, min(title) as title
    from plays
    group by track_key
  `).all();
  const nowIso = isoUtcNow();
  let updated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeArtistTitle(row.artist, row.title);
      if (!normalized.artist || !normalized.title) continue;
      const canonicalTitle = normalizeTitleForMatch(normalized.title);
      const canonicalPrimaryArtist = primaryArtist(normalized.artist);
      if (!canonicalTitle || !canonicalPrimaryArtist) continue;
      upsertCanonicalMap(db, {
        canonical_title: canonicalTitle,
        canonical_primary_artist: canonicalPrimaryArtist,
        canonical_track_key: row.track_key,
        updated_at_utc: nowIso
      });
      updated += 1;
    }
  });
  tx();
  db.close();
  const result = { scanned: rows.length, updated };
  logger?.info(result, 'canonical map refresh maintenance completed');
  return result;
}

export async function runReleaseDateBackfillMaintenance({
  dbPath,
  dryRun = false,
  maxLookups = 80,
  minPlays = 1,
  minConfidence = 0.55,
  staleHours = 12,
  includeChart = false,
  logger
}) {
  const db = openDb(dbPath);
  const maxLookupsSafe = Math.max(1, Math.min(Number(maxLookups) || 80, 5000));
  const minPlaysSafe = Math.max(1, Math.min(Number(minPlays) || 1, 100000));
  const minConfidenceSafe = Math.max(0, Math.min(Number(minConfidence) || 0.55, 1));
  const staleHoursSafe = Math.max(1, Math.min(Number(staleHours) || 12, 168));
  const staleCutoffMs = Date.now() - (staleHoursSafe * 60 * 60 * 1000);
  const candidateWindow = Math.max(maxLookupsSafe, Math.min(50000, maxLookupsSafe * 12));

  const rows = db.prepare(`
    select
      t.track_key,
      t.artist,
      t.title,
      t.plays,
      t.last_played_at_utc,
      m.release_date_utc,
      m.verification_confidence,
      m.last_checked_utc
    from (
      select
        track_key,
        min(artist) as artist,
        min(title) as title,
        count(*) as plays,
        max(played_at_utc) as last_played_at_utc
      from plays
      group by track_key
    ) t
    left join track_metadata m on m.track_key = t.track_key
    where t.plays >= ?
    order by datetime(t.last_played_at_utc) desc, t.plays desc
    limit ?
  `).all(minPlaysSafe, candidateWindow);

  const candidates = [];
  for (const row of rows) {
    const conf = Number(row.verification_confidence);
    const lowConfidence = !Number.isFinite(conf) || conf < minConfidenceSafe;
    const missingRelease = !row.release_date_utc;
    if (!missingRelease && !lowConfidence) continue;

    const lastCheckedMs = Date.parse(String(row.last_checked_utc || ''));
    if (Number.isFinite(lastCheckedMs) && lastCheckedMs >= staleCutoffMs) continue;
    candidates.push(row);
  }

  const selected = candidates.slice(0, maxLookupsSafe);

  let attempted = 0;
  let updatedWithRelease = 0;
  let stillMissingRelease = 0;
  let stillLowConfidence = 0;
  let failed = 0;
  let lastError = null;

  if (!dryRun && selected.length > 0 && process.env.NODE_ENV !== 'test') {
    const verifier = new TrackVerifier({ db, logger });
    for (const row of selected) {
      attempted += 1;
      try {
        const result = await verifier.enrichMetadata(
          {
            trackKey: row.track_key,
            artist: row.artist,
            title: row.title
          },
          {
            forceRefresh: true,
            includeChart,
            quietErrors: true
          }
        );
        const metadata = result?.metadata ?? null;
        const hasRelease = Boolean(metadata?.release_date_utc);
        const conf = Number(metadata?.verification_confidence);
        const lowConfidence = !Number.isFinite(conf) || conf < minConfidenceSafe;

        if (hasRelease) updatedWithRelease += 1;
        if (!hasRelease) stillMissingRelease += 1;
        if (lowConfidence) stillLowConfidence += 1;
      } catch (error) {
        failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  db.close();
  const result = {
    scanned: rows.length,
    candidates: candidates.length,
    selected: selected.length,
    attempted,
    updatedWithRelease,
    stillMissingRelease,
    stillLowConfidence,
    failed,
    dryRun,
    minConfidence: minConfidenceSafe,
    staleHours: staleHoursSafe,
    maxLookups: maxLookupsSafe,
    lastError
  };
  logger?.info(result, 'release metadata backfill completed');
  return result;
}

export function runManualTrackMerge({
  dbPath,
  winnerTrackKey,
  loserTrackKey,
  logger
}) {
  const winnerKey = String(winnerTrackKey || '').trim();
  const loserKey = String(loserTrackKey || '').trim();
  if (!winnerKey || !loserKey) {
    throw new Error('winnerTrackKey and loserTrackKey are required');
  }
  if (winnerKey === loserKey) {
    throw new Error('winnerTrackKey and loserTrackKey must be different');
  }

  const db = openDb(dbPath);
  const winnerRow = db.prepare(`
    select track_key, min(artist) as artist, min(title) as title, count(*) as plays
    from plays
    where track_key = ?
    group by track_key
  `).get(winnerKey);
  const loserRow = db.prepare(`
    select track_key, min(artist) as artist, min(title) as title, count(*) as plays
    from plays
    where track_key = ?
    group by track_key
  `).get(loserKey);

  if (!winnerRow) {
    db.close();
    throw new Error(`winnerTrackKey not found: ${winnerKey}`);
  }
  if (!loserRow) {
    db.close();
    throw new Error(`loserTrackKey not found: ${loserKey}`);
  }

  const winnerMeta = db.prepare('select * from track_metadata where track_key = ?').get(winnerKey) ?? null;
  const loserMeta = db.prepare('select * from track_metadata where track_key = ?').get(loserKey) ?? null;
  const winnerCanonical = normalizeArtistTitle(winnerRow.artist, winnerRow.title);
  const finalArtist = winnerCanonical.artist || winnerRow.artist;
  const finalTitle = winnerCanonical.title || winnerRow.title;
  const canonicalTitle = normalizeTitleForMatch(finalTitle);
  const canonicalPrimary = primaryArtist(finalArtist);

  let playsUpdated = 0;
  let dailyRowsRebuilt = 0;
  let metadataUpdated = 0;
  const nowIso = isoUtcNow();

  const metadataByTrackKey = new Map();
  if (winnerMeta) metadataByTrackKey.set(winnerKey, winnerMeta);
  if (loserMeta) metadataByTrackKey.set(loserKey, loserMeta);

  const tx = db.transaction(() => {
    const r = mergeTrackPair(
      db,
      { winnerKey, loserKey, artist: finalArtist, title: finalTitle },
      metadataByTrackKey
    );
    playsUpdated = r.playsUpdated;
    dailyRowsRebuilt = r.dailyRowsRebuilt;
    metadataUpdated = r.metadataUpdated;
    if (canonicalTitle && canonicalPrimary) {
      upsertCanonicalMap(db, {
        canonical_title: canonicalTitle,
        canonical_primary_artist: canonicalPrimary,
        canonical_track_key: winnerKey,
        updated_at_utc: nowIso
      });
    }
  });
  tx();
  db.close();

  const result = {
    winnerTrackKey: winnerKey,
    loserTrackKey: loserKey,
    playsUpdated,
    dailyRowsRebuilt,
    metadataUpdated
  };
  logger?.info(result, 'manual track merge completed');
  return result;
}

export function runCanonicalArtistMaintenance({ dbPath, dryRun = false, maxPairs = 5000, logger }) {
  const db = openDb(dbPath);
  const candidateRows = db.prepare(`
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as plays
    from plays
    where artist like '%&%' or artist like '%;%' or artist like '%,%' or artist like '%/%'
      or lower(artist) like '% x %' or lower(artist) like '% und %' or lower(artist) like '% and %'
      or lower(artist) like '% vs %' or lower(artist) like '% with %'
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
        const r = mergeTrackPair(
          db,
          { winnerKey: map.newKey, loserKey: map.oldKey, artist: map.artist, title: map.title },
          metadataByTrackKey
        );
        playsUpdated += r.playsUpdated;
        dailyRowsRebuilt += r.dailyRowsRebuilt;
        metadataUpdated += r.metadataUpdated;
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
  logger?.info(result, 'canonical artist maintenance completed');
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
      or lower(title) like '%big weekend%'
      or lower(title) like '%radio % big weekend%'
      or (lower(title) like '%&%' and lower(title) like '%radio%' and lower(title) like '%big weekend%')
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
        const r = mergeTrackPair(
          db,
          { winnerKey: map.newKey, loserKey: map.oldKey, artist: map.artist, title: map.title },
          metadataByTrackKey
        );
        playsUpdated += r.playsUpdated;
        dailyRowsRebuilt += r.dailyRowsRebuilt;
        metadataUpdated += r.metadataUpdated;
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

export function runItunesCanonicalMaintenance({
  dbPath,
  dryRun = false,
  maxPairs = 5000,
  minConfidence = 0.72,
  minArtistOverlap = 0.45,
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

  const canonicalByTitle = new Map();
  for (const row of trackRows) {
    const meta = metadataByTrackKey.get(row.track_key) ?? null;
    const itunes = extractItunesCanonicalName(meta, minConfidence);
    if (!itunes) continue;

    const normalizedCanonical = normalizeArtistTitle(itunes.artist, itunes.title);
    if (!normalizedCanonical.artist || !normalizedCanonical.title) continue;
    const titleKey = normalizedCanonical.title;
    const seed = {
      trackKey: normalizedCanonical.trackKey,
      artist: normalizedCanonical.artist,
      title: normalizedCanonical.title,
      itunesArtist: itunes.artist,
      confidence: itunes.confidence,
      plays: Number(row.plays || 0)
    };
    const existing = canonicalByTitle.get(titleKey);
    if (!existing ||
      seed.confidence > existing.confidence ||
      (seed.confidence === existing.confidence && seed.plays > existing.plays)
    ) {
      canonicalByTitle.set(titleKey, seed);
    }
  }

  const bestByOldKey = new Map();
  for (const row of trackRows) {
    const normalizedRow = normalizeArtistTitle(row.artist, row.title);
    if (!normalizedRow.artist || !normalizedRow.title) continue;
    const candidate = canonicalByTitle.get(normalizedRow.title);
    if (!candidate) continue;

    const overlap = artistOverlapRatio(row.artist, candidate.itunesArtist);
    if (overlap < minArtistOverlap) continue;
    if (candidate.trackKey === row.track_key) continue;

    const plays = Number(row.plays || 0);
    const score = (candidate.confidence * 2) + overlap + (Math.log1p(plays) / 10);
    const current = bestByOldKey.get(row.track_key);
    if (!current || score > current.score) {
      bestByOldKey.set(row.track_key, {
        oldKey: row.track_key,
        newKey: candidate.trackKey,
        artist: candidate.artist,
        title: candidate.title,
        plays,
        score
      });
    }
  }

  const mappings = Array.from(bestByOldKey.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, Math.max(1, Number(maxPairs) || 5000));

  let merged = 0;
  let playsUpdated = 0;
  let metadataUpdated = 0;
  let dailyRowsRebuilt = 0;

  if (!dryRun && mappings.length > 0) {
    const tx = db.transaction(() => {
      for (const map of mappings) {
        const r = mergeTrackPair(
          db,
          { winnerKey: map.newKey, loserKey: map.oldKey, artist: map.artist, title: map.title },
          metadataByTrackKey
        );
        playsUpdated += r.playsUpdated;
        dailyRowsRebuilt += r.dailyRowsRebuilt;
        metadataUpdated += r.metadataUpdated;
        merged += 1;
      }
    });
    tx();
  }

  db.close();
  const result = {
    candidates: bestByOldKey.size,
    selectedPairs: mappings.length,
    merged,
    playsUpdated,
    metadataUpdated,
    dailyRowsRebuilt,
    dryRun,
    minConfidence,
    minArtistOverlap
  };
  logger?.info(result, 'itunes canonical maintenance completed');
  return result;
}


export async function runIngest({ configPath, dbPath, logger }) {
  const config = loadConfig(configPath);
  const db = openDb(dbPath);
  const trackHourStart = Number(process.env.YRPA_TRACK_HOUR_START ?? 6);
  const trackHourEnd = Number(process.env.YRPA_TRACK_HOUR_END ?? 20);

  let totalInserted = 0;
  const scrapeErrors = [];
  const verifyAllTracks = process.env.YRPA_VERIFY_ALL_TRACKS === '1';
  const verificationEnabled = process.env.YRPA_TRACK_VERIFY !== '0' && process.env.NODE_ENV !== 'test';
  const dedupCooldownSeconds = Math.max(1, Number(process.env.YRPA_DEDUP_COOLDOWN_SECONDS) || DEFAULT_DEDUP_COOLDOWN_SECONDS);
  const storeDedupedEvents = process.env.YRPA_STORE_DEDUPED_EVENTS === '1';
  const verifier = verificationEnabled ? new TrackVerifier({ db, logger }) : null;
  const canonicalLookup = new Map();
  for (const row of listCanonicalMap(db)) {
    const key = canonicalMapKey(row.canonical_title, row.canonical_primary_artist);
    canonicalLookup.set(key, row.canonical_track_key);
  }
  const canonicalIdentityByTrackKey = new Map();
  const resolveCanonicalIdentity = (trackKey) => {
    if (canonicalIdentityByTrackKey.has(trackKey)) {
      return canonicalIdentityByTrackKey.get(trackKey) || null;
    }

    const metaIdentity = db.prepare(`
      select artist, title
      from track_metadata
      where track_key = ?
    `).get(trackKey);
    let sourceArtist = String(metaIdentity?.artist ?? '').trim();
    let sourceTitle = String(metaIdentity?.title ?? '').trim();

    if (!sourceArtist || !sourceTitle) {
      const playIdentity = db.prepare(`
        select min(artist) as artist, min(title) as title
        from plays
        where track_key = ?
      `).get(trackKey);
      sourceArtist = String(playIdentity?.artist ?? '').trim();
      sourceTitle = String(playIdentity?.title ?? '').trim();
    }

    if (!sourceArtist || !sourceTitle) {
      canonicalIdentityByTrackKey.set(trackKey, null);
      return null;
    }
    const normalized = normalizeArtistTitle(sourceArtist, sourceTitle);
    if (!normalized.artist || !normalized.title) {
      canonicalIdentityByTrackKey.set(trackKey, null);
      return null;
    }

    const identity = { artist: normalized.artist, title: normalized.title, trackKey };
    canonicalIdentityByTrackKey.set(trackKey, identity);
    return identity;
  };

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
          let parsed = [];
          if (isPhonostarTitleUrl(url)) {
            const maxPages = Math.max(1, Math.min(Number(process.env.YRPA_PHONOSTAR_MAX_PAGES) || 6, 20));
            const paged = await fetchPhonostarPaginatedPlays({
              fetcher,
              parser,
              url,
              timezone: station.timezone,
              maxPages
            });
            parsed = paged.plays;
            if (parsed.length) {
              logger.info(
                {
                  station: station.id,
                  url,
                  pagesFetched: paged.pagesFetched,
                  crossedDayBoundary: paged.crossedDayBoundary,
                  maxPages
                },
                'phonostar pagination parsed'
              );
            }
          } else {
            const html = await fetcher.fetchHtml(url);
            parsed = parser.parse(html, url);
          }

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
      let dedupedByMinGap = 0;
      const minPlayGapSeconds = Math.max(0, Number(station.min_play_gap_seconds) || 0);
      if (minPlayGapSeconds > 0 && plays.length > 1) {
        const minGapMs = minPlayGapSeconds * 1000;
        const sorted = [...plays].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());
        const filtered = [];
        let lastAcceptedAtMs = Number.NEGATIVE_INFINITY;
        for (const play of sorted) {
          const playedAtMs = play.playedAt.getTime();
          if (!Number.isFinite(playedAtMs)) continue;
          if (playedAtMs - lastAcceptedAtMs < minGapMs) {
            dedupedByMinGap += 1;
            continue;
          }
          filtered.push(play);
          lastAcceptedAtMs = playedAtMs;
        }
        plays = filtered;
      }
      let skippedOutsideHours = 0;
      plays = plays.filter((play) => {
        const keep = isWithinLocalHourWindow(play.playedAt, station.timezone, trackHourStart, trackHourEnd);
        if (!keep) skippedOutsideHours += 1;
        return keep;
      });

      let inserted = 0;
      let skippedNoise = 0;
      let skippedJingle = 0;
      let dedupedCooldown = 0;
      const dedupSamples = [];
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

        let canonicalTrackKey = normalized.trackKey;
        let canonicalArtist = normalized.artist;
        let canonicalTitle = normalized.title;
        const canonicalTitleKey = normalizeTitleForMatch(canonicalTitle);
        const canonicalPrimaryArtist = primaryArtist(canonicalArtist);
        const mapKey = canonicalMapKey(canonicalTitleKey, canonicalPrimaryArtist);
        const mappedTrackKey = canonicalLookup.get(mapKey);
        if (mappedTrackKey) {
          canonicalTrackKey = mappedTrackKey;
          const mappedIdentity = resolveCanonicalIdentity(mappedTrackKey);
          if (mappedIdentity?.artist && mappedIdentity?.title) {
            canonicalArtist = mappedIdentity.artist;
            canonicalTitle = mappedIdentity.title;
          }
        }

        const suspicious = isLikelyJingleLike(play.artistRaw, play.titleRaw, {
          stationName: station.name,
          stationId: station.id
        });
        if (verifier && (verifyAllTracks || suspicious)) {
          let verified = verifiedByTrackKey.get(canonicalTrackKey);
          if (!verified) {
            verified = await verifier.verifyTrack({
              trackKey: canonicalTrackKey,
              artist: canonicalArtist,
              title: canonicalTitle
            });
            verifiedByTrackKey.set(canonicalTrackKey, verified);
          }

          if (verified.verifiedExists === false) {
            skippedJingle += 1;
            continue;
          }
        }

        const metadataForDedup = db.prepare(`
          select isrc, canonical_id
          from track_metadata
          where track_key = ?
        `).get(canonicalTrackKey) ?? null;
        const dedupSongKey = songKeyFromMetadataOrFallback({
          metadata: metadataForDedup,
          artist: canonicalArtist,
          title: canonicalTitle
        });
        const eventPlayedAtUtc = play.playedAt.toISOString();
        const dedupDecision = shouldDedupByCooldown({
          db,
          stationId: station.id,
          songKey: dedupSongKey,
          eventPlayedAtUtcIso: eventPlayedAtUtc,
          cooldownSeconds: dedupCooldownSeconds
        });
        if (dedupDecision.deduped) {
          dedupedCooldown += 1;
          const dedupPayload = {
            sender_id: station.id,
            song_key: dedupSongKey,
            event_time: eventPlayedAtUtc,
            last_counted_time: dedupDecision.lastCountedAtUtc,
            delta_seconds: dedupDecision.deltaSeconds
          };
          if (dedupSamples.length < 5) dedupSamples.push(dedupPayload);
          if (process.env.YRPA_LOG_DEDUP_EACH === '1') {
            logger?.info?.(dedupPayload, 'play deduped by cooldown');
          } else {
            logger?.debug?.(dedupPayload, 'play deduped by cooldown');
          }
          if (storeDedupedEvents) {
            insertDedupEvent(db, {
              station_id: station.id,
              played_at_utc: eventPlayedAtUtc,
              artist_raw: play.artistRaw,
              title_raw: play.titleRaw,
              artist: canonicalArtist,
              title: canonicalTitle,
              track_key: canonicalTrackKey,
              dedup_song_key: dedupSongKey,
              deduped: 1,
              last_counted_at_utc: dedupDecision.lastCountedAtUtc,
              delta_seconds: dedupDecision.deltaSeconds,
              source_url: play.sourceUrl || usedUrl,
              ingested_at_utc: ingestedAt
            });
          }
          continue;
        }

        inserted += insertPlayIgnore(db, {
          station_id: station.id,
          played_at_utc: eventPlayedAtUtc,
          artist_raw: play.artistRaw,
          title_raw: play.titleRaw,
          artist: canonicalArtist,
          title: canonicalTitle,
          track_key: canonicalTrackKey,
          dedup_song_key: dedupSongKey,
          source_url: play.sourceUrl || usedUrl,
          ingested_at_utc: ingestedAt
        });

        if (canonicalTitleKey && canonicalPrimaryArtist) {
          upsertCanonicalMap(db, {
            canonical_title: canonicalTitleKey,
            canonical_primary_artist: canonicalPrimaryArtist,
            canonical_track_key: canonicalTrackKey,
            updated_at_utc: ingestedAt
          });
          canonicalLookup.set(mapKey, canonicalTrackKey);
        }
      }

      totalInserted += inserted;
      if (dedupedCooldown > 0) {
        logger.info(
          {
            station: station.id,
            dedupedCooldown,
            dedupCooldownSeconds,
            samples: dedupSamples
          },
          'dedup cooldown summary'
        );
      }
      logger.info(
        {
          station: station.id,
          sourceUrl: usedUrl,
          playsFound: plays.length,
          playsInserted: inserted,
          skippedNoise,
          skippedJingle,
          dedupedCooldown,
          dedupedByMinute,
          dedupedByMinGap,
          minPlayGapSeconds,
          skippedOutsideHours,
          trackHourStart,
          trackHourEnd,
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
    `# Music Scraper Coverage Audit ${day}`,
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


/**
 * Runs the full standard maintenance sequence in the correct order.
 * Used by daily-job and api startup to avoid copy-pasting the sequence.
 */
export async function runAllMaintenance({ dbPath, releaseMaxLookups, logger }) {
  runNoisePlayCleanup({ dbPath, logger });
  runPromoMarkerMaintenance({ dbPath, logger });
  runItunesCanonicalMaintenance({ dbPath, logger });
  runCanonicalArtistMaintenance({ dbPath, logger });
  runMergeDuplicateTracksMaintenance({ dbPath, logger });
  runCanonicalMapRefreshMaintenance({ dbPath, logger });
  runTrackOrientationMaintenance({ dbPath, logger });
  await runReleaseDateBackfillMaintenance({
    dbPath,
    maxLookups: releaseMaxLookups,
    minPlays: Number(process.env.YRPA_RELEASE_BACKFILL_MIN_PLAYS || 1),
    minConfidence: Number(process.env.YRPA_RELEASE_BACKFILL_MIN_CONFIDENCE || 0.55),
    staleHours: Number(process.env.YRPA_RELEASE_BACKFILL_STALE_HOURS || 12),
    includeChart: false,
    logger
  });
}
