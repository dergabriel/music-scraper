import { canonicalTitleKey, canonicalizeArtist } from './normalize.js';
import { createDbQueries } from './db.js';

export const DEFAULT_DEDUP_COOLDOWN_SECONDS = 15 * 60;

function sanitizeSongPart(value) {
  return canonicalTitleKey(String(value ?? ''));
}

export function buildFallbackSongKey(artist, title, version = '') {
  const canonicalArtist = canonicalizeArtist(artist);
  const artistPart = sanitizeSongPart(canonicalArtist);
  const titlePart = sanitizeSongPart(title);
  const versionPart = sanitizeSongPart(version);
  if (!artistPart || !titlePart) return '';
  return versionPart
    ? `norm:${artistPart}||${titlePart}||${versionPart}`
    : `norm:${artistPart}||${titlePart}`;
}

export function songKeyFromMetadataOrFallback({ metadata = null, artist, title, version = '' }) {
  const rawIsrc = String(metadata?.isrc ?? '').trim();
  if (rawIsrc) return `isrc:${rawIsrc.toLowerCase()}`;

  const canonicalId = String(metadata?.canonical_id ?? '').trim().toLowerCase();
  if (canonicalId.startsWith('isrc:') && canonicalId.length > 5) return canonicalId;

  return buildFallbackSongKey(artist, title, version);
}

export function shouldDedupByCooldown({
  db,
  stationId,
  songKey,
  eventPlayedAtUtcIso,
  cooldownSeconds = DEFAULT_DEDUP_COOLDOWN_SECONDS
}) {
  if (!db || !stationId || !songKey || !eventPlayedAtUtcIso) {
    return { deduped: false, lastCountedAtUtc: null, deltaSeconds: null };
  }

  const row = createDbQueries(db).prepare('shouldDedupByCooldown', `
    select max(played_at_utc) as last_counted_at_utc
    from plays
    where station_id = ?
      and dedup_song_key = ?
  `).get(stationId, songKey);
  const lastCountedAtUtc = row?.last_counted_at_utc ?? null;
  if (!lastCountedAtUtc) {
    return { deduped: false, lastCountedAtUtc: null, deltaSeconds: null };
  }

  const eventMs = Date.parse(String(eventPlayedAtUtcIso));
  const lastMs = Date.parse(String(lastCountedAtUtc));
  if (!Number.isFinite(eventMs) || !Number.isFinite(lastMs)) {
    return { deduped: false, lastCountedAtUtc, deltaSeconds: null };
  }
  const deltaSeconds = Math.max(0, Math.round((eventMs - lastMs) / 1000));
  return {
    deduped: deltaSeconds < Math.max(1, Number(cooldownSeconds) || DEFAULT_DEDUP_COOLDOWN_SECONDS),
    lastCountedAtUtc,
    deltaSeconds
  };
}

