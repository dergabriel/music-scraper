import { fetch } from 'undici';
import {
  normalizeArtistTitle,
  primaryArtist,
  artistOverlapRatioLoose
} from '../normalize.js';

// Deezer public API: ~50 requests / 5 seconds
const SEARCH_ENDPOINT = 'https://api.deezer.com/search';
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT_PER_WINDOW = 45; // stay under the 50/5s cap with margin

const requestTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleDeezer() {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length && (now - requestTimestamps[0]) >= RATE_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_PER_WINDOW) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = Math.max(1, RATE_WINDOW_MS - (now - requestTimestamps[0]));
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

export async function searchTrackOnDeezer(artist, title, { durationMs = null } = {}) {
  const normalizedInput = normalizeArtistTitle(artist, title);
  if (!normalizedInput.artist || !normalizedInput.title) return null;
  const inputPrimary = primaryArtist(normalizedInput.artist);
  if (!inputPrimary) return null;

  const query = `artist:"${artist}" track:"${title}"`;
  const params = new URLSearchParams({ q: query, limit: '5' });

  await throttleDeezer();
  let res;
  try {
    res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
      headers: { 'user-agent': 'music-scraper/1.0 (+deezer)' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw new Error(`Deezer search network error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!res.ok) {
    throw new Error(`Deezer search failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  const items = Array.isArray(body?.data) ? body.data : [];
  if (!items.length) return null;

  let best = null;
  for (const item of items) {
    const itemTitle = String(item?.title || '').trim();
    const itemArtistName = String(item?.artist?.name || '').trim();
    if (!itemTitle || !itemArtistName) continue;

    const normalizedItem = normalizeArtistTitle(itemArtistName, itemTitle);
    if (!normalizedItem.artist || !normalizedItem.title) continue;

    const titleScore = normalizedItem.title === normalizedInput.title ? 1 : 0;
    const itemPrimary = primaryArtist(normalizedItem.artist);
    const primaryArtistScore = itemPrimary === inputPrimary ? 1 : 0;
    const artistOverlap = artistOverlapRatioLoose(normalizedInput.artist, normalizedItem.artist);
    const itemDurationMs = Number(item?.duration) > 0 ? Number(item.duration) * 1000 : null;
    const durationScore = durationMatchScore(durationMs, itemDurationMs);

    const confidence = calculateConfidence({ titleScore, primaryArtistScore, artistOverlap, durationScore });

    const durationDiff = Number.isFinite(durationMs) && Number.isFinite(itemDurationMs)
      ? Math.abs(durationMs - itemDurationMs)
      : 0;
    const durationAllowed =
      !Number.isFinite(durationMs) || !Number.isFinite(itemDurationMs) || durationDiff <= 5000;

    if (!durationAllowed) continue;
    if (titleScore < 1) continue;
    if (primaryArtistScore < 1) continue;
    if (artistOverlap < 0.6) continue;

    const candidate = {
      deezerId: String(item?.id || '').trim() || null,
      isrc: String(item?.isrc || '').trim() || null,
      confidence,
      durationMs: Number.isFinite(itemDurationMs) ? itemDurationMs : null,
      artist: itemArtistName,
      title: itemTitle
    };
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  }

  if (!best) return null;
  if (best.confidence < 0.8) return null;
  return best;
}
