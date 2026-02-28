import { fetch } from 'undici';
import { isoUtcNow } from './time.js';
import { getTrackMetadata, upsertTrackMetadata } from './db.js';

const CHART_FEED_CACHE_MS = 30 * 60 * 1000;
const CHART_FEED_BACKOFF_MS = 15 * 60 * 1000;
const ITUNES_BACKOFF_SOFT_MS = 10 * 60 * 1000;
const ITUNES_BACKOFF_HARD_MS = 30 * 60 * 1000;
const ITUNES_ERROR_RETRY_MS = 12 * 60 * 60 * 1000;
const METADATA_RECENT_CACHE_MS = 6 * 60 * 60 * 1000;
const chartFeedStateByCountry = new Map();
const itunesState = {
  retryAfterMs: 0,
  reason: null
};

function parseTimeMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function isRecentCache(cached, maxAgeMs) {
  const checkedAtMs = parseTimeMs(cached?.last_checked_utc);
  if (!checkedAtMs) return false;
  return (Date.now() - checkedAtMs) < maxAgeMs;
}

function shouldSkipRetryAfterError(cached) {
  return cached?.verification_source === 'itunes_error' && isRecentCache(cached, ITUNES_ERROR_RETRY_MS);
}

function tokenize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter((x) => x.length >= 2);
}

function overlapScore(a, b) {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const t of aa) if (bb.has(t)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

function toDbRow(track, result) {
  return {
    track_key: track.trackKey,
    artist: track.artist,
    title: track.title,
    verified_exists: result.verifiedExists === null ? null : result.verifiedExists ? 1 : 0,
    verification_source: result.source ?? null,
    verification_confidence: Number.isFinite(result.confidence) ? result.confidence : null,
    external_track_id: result.externalTrackId ?? null,
    external_url: result.externalUrl ?? null,
    artwork_url: result.artworkUrl ?? null,
    release_date_utc: result.releaseDateUtc ?? null,
    genre: result.genre ?? null,
    album: result.album ?? null,
    label: result.label ?? null,
    duration_ms: Number.isFinite(result.durationMs) ? Math.round(result.durationMs) : null,
    preview_url: result.previewUrl ?? null,
    isrc: result.isrc ?? null,
    popularity_score: Number.isFinite(result.popularityScore) ? result.popularityScore : null,
    chart_airplay_rank: result.chartAirplayRank ?? null,
    chart_single_rank: result.chartSingleRank ?? null,
    chart_country: result.chartCountry ?? null,
    social_viral_score: Number.isFinite(result.socialViralScore) ? result.socialViralScore : null,
    payload_json: result.payloadJson ?? null,
    last_checked_utc: isoUtcNow()
  };
}

async function verifyWithItunes(track) {
  const now = Date.now();
  if (itunesState.retryAfterMs > now) {
    throw new Error(
      `iTunes verify temporarily unavailable until ${new Date(itunesState.retryAfterMs).toISOString()} (${itunesState.reason ?? 'backoff'})`
    );
  }

  const term = encodeURIComponent(`${track.artist} ${track.title}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=5&country=DE`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'yrpa/1.0 (+track-verifier)' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      const backoffMs = res.status === 403 ? ITUNES_BACKOFF_HARD_MS : ITUNES_BACKOFF_SOFT_MS;
      itunesState.retryAfterMs = now + backoffMs;
      itunesState.reason = `HTTP ${res.status}`;
      throw new Error(`iTunes verify failed: HTTP ${res.status} (backoff ${Math.round(backoffMs / 60000)}m)`);
    }
    throw new Error(`iTunes verify failed: HTTP ${res.status}`);
  }
  itunesState.retryAfterMs = 0;
  itunesState.reason = null;

  const json = await res.json();
  const results = Array.isArray(json?.results) ? json.results : [];
  if (!results.length) {
    return { verifiedExists: false, confidence: 0, source: 'itunes' };
  }

  let best = null;
  for (const row of results) {
    const artistScore = overlapScore(track.artist, row.artistName);
    const titleScore = overlapScore(track.title, row.trackName);
    const confidence = (artistScore * 0.55) + (titleScore * 0.45);
    if (!best || confidence > best.confidence) {
      best = { row, confidence };
    }
  }

  if (!best) return { verifiedExists: false, confidence: 0, source: 'itunes' };
  return {
    verifiedExists: best.confidence >= 0.55,
    confidence: best.confidence,
    source: 'itunes',
    externalTrackId: best.row.trackId ? String(best.row.trackId) : null,
    externalUrl: best.row.trackViewUrl ?? null,
    artworkUrl: best.row.artworkUrl100 ?? null,
    releaseDateUtc: best.row.releaseDate ?? null,
    genre: best.row.primaryGenreName ?? null,
    album: best.row.collectionName ?? null,
    label: best.row.copyright ? String(best.row.copyright).split('©').pop()?.trim() || null : null,
    durationMs: Number.isFinite(best.row.trackTimeMillis) ? best.row.trackTimeMillis : null,
    previewUrl: best.row.previewUrl ?? null,
    isrc: best.row.isrc ?? null,
    // no stable free airplay/single/social source included yet; keep nullable for later providers
    chartAirplayRank: null,
    chartSingleRank: null,
    chartCountry: null,
    socialViralScore: null,
    popularityScore: Number.isFinite(best.confidence) ? Math.round(best.confidence * 100) : null,
    payloadJson: JSON.stringify({
      provider: 'itunes',
      resultCount: results.length,
      topArtist: best.row.artistName,
      topTitle: best.row.trackName
    })
  };
}

async function getAppleMusicChartFeed(country = 'de') {
  const key = String(country || 'de').toLowerCase();
  const now = Date.now();
  let state = chartFeedStateByCountry.get(key);
  if (!state) {
    state = {
      songs: null,
      expiresAtMs: 0,
      retryAfterMs: 0,
      errorMessage: null,
      lastWarnAtMs: 0
    };
    chartFeedStateByCountry.set(key, state);
  }

  if (state.songs && state.expiresAtMs > now) {
    return { songs: state.songs, feedIssue: null, shouldWarn: false };
  }

  if (state.retryAfterMs > now) {
    const shouldWarn = now - state.lastWarnAtMs > CHART_FEED_BACKOFF_MS;
    if (shouldWarn) state.lastWarnAtMs = now;
    return {
      songs: null,
      feedIssue: state.errorMessage || `apple chart feed temporarily disabled until ${new Date(state.retryAfterMs).toISOString()}`,
      shouldWarn
    };
  }

  const url = `https://rss.applemarketingtools.com/api/v2/${country}/music/most-played/100/songs.json`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'yrpa/1.0 (+track-metadata)' },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errorMessage = `apple chart feed failed: HTTP ${res.status}`;
    state.songs = null;
    state.errorMessage = errorMessage;
    state.retryAfterMs = now + CHART_FEED_BACKOFF_MS;
    state.lastWarnAtMs = now;
    return { songs: null, feedIssue: errorMessage, shouldWarn: true };
  }

  const json = await res.json();
  const songs = Array.isArray(json?.feed?.results) ? json.feed.results : [];
  state.songs = songs;
  state.expiresAtMs = now + CHART_FEED_CACHE_MS;
  state.retryAfterMs = 0;
  state.errorMessage = null;
  return { songs, feedIssue: null, shouldWarn: false };
}

async function fetchAppleMusicChartRank(track, country = 'de') {
  const feed = await getAppleMusicChartFeed(country);
  const songs = Array.isArray(feed.songs) ? feed.songs : [];
  if (!songs.length) {
    return { chart: null, feedIssue: feed.feedIssue, shouldWarn: feed.shouldWarn };
  }

  let best = null;
  songs.forEach((song, idx) => {
    const artistScore = overlapScore(track.artist, song.artistName);
    const titleScore = overlapScore(track.title, song.name);
    const confidence = (artistScore * 0.5) + (titleScore * 0.5);
    if (!best || confidence > best.confidence) {
      best = {
        confidence,
        rank: idx + 1,
        title: song.name,
        artist: song.artistName
      };
    }
  });

  if (!best || best.confidence < 0.55) {
    return { chart: null, feedIssue: null, shouldWarn: false };
  }
  return {
    chart: {
      chartSingleRank: best.rank,
      chartCountry: country.toUpperCase(),
      chartMatchConfidence: best.confidence,
      chartTitle: best.title,
      chartArtist: best.artist
    },
    feedIssue: null,
    shouldWarn: false
  };
}

function mergeMetadataResult(base, chart, provider = 'itunes') {
  const payload = {
    provider,
    chartProvider: chart ? 'apple_music_top_songs' : null,
    chartCountry: chart?.chartCountry ?? null,
    chartSingleRank: chart?.chartSingleRank ?? null
  };

  if (base.payloadJson) {
    try {
      const parsed = JSON.parse(base.payloadJson);
      Object.assign(payload, parsed);
    } catch {
      payload.rawPayload = base.payloadJson;
    }
  }

  if (chart) {
    payload.chartMatchConfidence = chart.chartMatchConfidence;
    payload.chartMatchedTitle = chart.chartTitle;
    payload.chartMatchedArtist = chart.chartArtist;
  }

  return {
    ...base,
    chartSingleRank: chart?.chartSingleRank ?? base.chartSingleRank ?? null,
    chartCountry: chart?.chartCountry ?? base.chartCountry ?? null,
    payloadJson: JSON.stringify(payload)
  };
}

export class TrackVerifier {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
  }

  async verifyTrack(track) {
    const cached = getTrackMetadata(this.db, track.trackKey);
    if (cached && cached.verified_exists !== null) {
      return {
        verifiedExists: Boolean(cached.verified_exists),
        confidence: cached.verification_confidence ?? null,
        source: cached.verification_source ?? 'cache',
        fromCache: true
      };
    }
    if (cached && shouldSkipRetryAfterError(cached)) {
      return {
        verifiedExists: null,
        confidence: cached.verification_confidence ?? null,
        source: cached.verification_source ?? 'cache',
        fromCache: true
      };
    }
    if (cached && cached.verified_exists === null && isRecentCache(cached, METADATA_RECENT_CACHE_MS)) {
      return {
        verifiedExists: null,
        confidence: cached.verification_confidence ?? null,
        source: cached.verification_source ?? 'cache',
        fromCache: true
      };
    }

    try {
      const result = await verifyWithItunes(track);
      upsertTrackMetadata(this.db, toDbRow(track, result));
      return { ...result, fromCache: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ trackKey: track.trackKey, artist: track.artist, title: track.title, error: message }, 'track verification failed; accepting track as unknown');
      upsertTrackMetadata(this.db, toDbRow(track, {
        verifiedExists: null,
        confidence: null,
        source: 'itunes_error',
        payloadJson: JSON.stringify({ error: message })
      }));
      return { verifiedExists: null, confidence: null, source: 'itunes_error', fromCache: false };
    }
  }

  async enrichMetadata(track, { forceRefresh = false, includeChart = true, quietErrors = false } = {}) {
    const cached = getTrackMetadata(this.db, track.trackKey);
    const hasUsefulCachedMetadata = Boolean(
      cached?.release_date_utc || cached?.external_track_id || cached?.genre || cached?.album || cached?.artwork_url
    );
    if (!forceRefresh && cached && hasUsefulCachedMetadata && isRecentCache(cached, METADATA_RECENT_CACHE_MS)) {
      return { metadata: cached, fromCache: true };
    }
    if (!forceRefresh && cached && shouldSkipRetryAfterError(cached)) {
      return { metadata: cached, fromCache: true };
    }

    let result;
    try {
      result = await verifyWithItunes(track);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!quietErrors) {
        this.logger?.warn({ trackKey: track.trackKey, artist: track.artist, title: track.title, error: message }, 'metadata refresh failed');
      }
      upsertTrackMetadata(this.db, toDbRow(track, {
        verifiedExists: cached?.verified_exists === null || cached?.verified_exists === undefined
          ? null
          : Boolean(cached.verified_exists),
        confidence: cached?.verification_confidence ?? null,
        source: 'itunes_error',
        externalTrackId: cached?.external_track_id ?? null,
        externalUrl: cached?.external_url ?? null,
        artworkUrl: cached?.artwork_url ?? null,
        releaseDateUtc: cached?.release_date_utc ?? null,
        genre: cached?.genre ?? null,
        album: cached?.album ?? null,
        payloadJson: JSON.stringify({ error: message })
      }));
      return { metadata: getTrackMetadata(this.db, track.trackKey), fromCache: false };
    }

    let chart = null;
    if (includeChart) {
      try {
        const chartResult = await fetchAppleMusicChartRank(track, 'de');
        chart = chartResult.chart;
        if (chartResult.feedIssue && chartResult.shouldWarn) {
          this.logger?.warn({ country: 'DE', error: chartResult.feedIssue }, 'chart feed unavailable; skipping chart rank enrichment temporarily');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!quietErrors) {
          this.logger?.warn({ error: message }, 'chart rank lookup failed');
        }
      }
    }

    const merged = mergeMetadataResult(result, chart, 'itunes');
    upsertTrackMetadata(this.db, toDbRow(track, merged));
    return { metadata: getTrackMetadata(this.db, track.trackKey), fromCache: false };
  }
}
