import { fetch } from 'undici';
import {
  normalizeArtistTitle,
  primaryArtist,
  artistOverlapRatioLoose
} from '../normalize.js';

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const SEARCH_ENDPOINT = 'https://api.spotify.com/v1/search';
const RATE_LIMIT_PER_SECOND = 5;

const tokenState = {
  accessToken: null,
  expiresAtMs: 0
};

const requestTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleSpotify() {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length && (now - requestTimestamps[0]) >= 1000) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_PER_SECOND) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = Math.max(1, 1000 - (now - requestTimestamps[0]));
    await sleep(waitMs);
  }
}

function durationMatchScore(expectedMs, actualMs) {
  if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs) || expectedMs <= 0 || actualMs <= 0) {
    return 1;
  }
  const diff = Math.abs(expectedMs - actualMs);
  if (diff > 5000) return 0;
  return Math.max(0, 1 - (diff / 5000));
}

export function calculateConfidence(match) {
  const titleScore = Number(match?.titleScore ?? 0);
  const primaryScore = Number(match?.primaryArtistScore ?? 0);
  const overlapScore = Number(match?.artistOverlap ?? 0);
  const durationScore = Number(match?.durationScore ?? 1);
  return (titleScore * 0.45) + (primaryScore * 0.25) + (overlapScore * 0.2) + (durationScore * 0.1);
}

export async function getSpotifyAccessToken() {
  const now = Date.now();
  if (tokenState.accessToken && tokenState.expiresAtMs > now + 30000) {
    return tokenState.accessToken;
  }

  const clientId = String(process.env.SPOTIFY_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Spotify credentials missing (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).');
  }

  await throttleSpotify();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    throw new Error(`Spotify token request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const accessToken = String(body?.access_token || '').trim();
  const expiresInSec = Number(body?.expires_in || 3600);
  if (!accessToken) {
    throw new Error('Spotify token request failed: missing access_token');
  }

  tokenState.accessToken = accessToken;
  tokenState.expiresAtMs = Date.now() + Math.max(60, expiresInSec) * 1000;
  return accessToken;
}

export async function searchTrackOnSpotify(artist, title, { durationMs = null } = {}) {
  const normalizedInput = normalizeArtistTitle(artist, title);
  if (!normalizedInput.artist || !normalizedInput.title) return null;
  const inputPrimary = primaryArtist(normalizedInput.artist);
  if (!inputPrimary) return null;

  const token = await getSpotifyAccessToken();
  const query = `track:${title} artist:${artist}`;
  const params = new URLSearchParams({
    q: query,
    type: 'track',
    limit: '5'
  });

  await throttleSpotify();
  const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'music-scraper/1.0 (+spotify)'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    throw new Error(`Spotify search failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  const items = Array.isArray(body?.tracks?.items) ? body.tracks.items : [];
  if (!items.length) return null;

  let best = null;
  for (const item of items) {
    const itemTitle = String(item?.name || '').trim();
    const itemArtists = Array.isArray(item?.artists)
      ? item.artists.map((a) => String(a?.name || '').trim()).filter(Boolean)
      : [];
    if (!itemTitle || !itemArtists.length) continue;

    const itemArtist = itemArtists.join(' & ');
    const normalizedItem = normalizeArtistTitle(itemArtist, itemTitle);
    if (!normalizedItem.artist || !normalizedItem.title) continue;

    const titleScore = normalizedItem.title === normalizedInput.title ? 1 : 0;
    const itemPrimary = primaryArtist(normalizedItem.artist);
    const primaryArtistScore = itemPrimary === inputPrimary ? 1 : 0;
    const artistOverlap = artistOverlapRatioLoose(normalizedInput.artist, normalizedItem.artist);
    const durationScore = durationMatchScore(durationMs, Number(item?.duration_ms));
    const confidence = calculateConfidence({
      titleScore,
      primaryArtistScore,
      artistOverlap,
      durationScore
    });

    const durationDiff = Number.isFinite(durationMs) && Number.isFinite(Number(item?.duration_ms))
      ? Math.abs(durationMs - Number(item.duration_ms))
      : 0;
    const durationAllowed = !Number.isFinite(durationMs) || !Number.isFinite(Number(item?.duration_ms)) || durationDiff <= 5000;

    if (!durationAllowed) continue;
    if (titleScore < 1) continue;
    if (primaryArtistScore < 1) continue;
    if (artistOverlap < 0.6) continue;

    const candidate = {
      spotifyTrackId: String(item?.id || '').trim() || null,
      isrc: String(item?.external_ids?.isrc || '').trim() || null,
      confidence,
      canonicalSource: 'spotify',
      canonicalId: String(item?.external_ids?.isrc || '').trim() || null,
      durationMs: Number(item?.duration_ms),
      artist: normalizedItem.artist,
      title: normalizedItem.title
    };
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  }

  if (!best) return null;
  if (best.confidence < 0.8) return null;
  return best;
}
