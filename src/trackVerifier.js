import { fetch } from 'undici';
import { isoUtcNow } from './time.js';
import { getTrackMetadata, upsertTrackMetadata } from './db.js';

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
    popularity_score: Number.isFinite(result.popularityScore) ? result.popularityScore : null,
    chart_airplay_rank: result.chartAirplayRank ?? null,
    chart_single_rank: result.chartSingleRank ?? null,
    social_viral_score: Number.isFinite(result.socialViralScore) ? result.socialViralScore : null,
    payload_json: result.payloadJson ?? null,
    last_checked_utc: isoUtcNow()
  };
}

async function verifyWithItunes(track) {
  const term = encodeURIComponent(`${track.artist} ${track.title}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=5&country=DE`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'yrpa/1.0 (+track-verifier)' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`iTunes verify failed: HTTP ${res.status}`);

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
    // no stable free airplay/single/social source included yet; keep nullable for later providers
    chartAirplayRank: null,
    chartSingleRank: null,
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
}
