import { berlinTodayIsoDate } from './date-berlin.js';

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/["'`´’“”]/g, '')
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalTrackToken(artist, title) {
  return `${normalizeText(artist)}::${normalizeText(title)}`;
}

const ARTIST_SPLIT_PATTERN = /\s*(?:,|;|\/|&|\+|\bx\b|\bund\b|\band\b|\bwith\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b)\s*/gi;
const TITLE_SUFFIX_BLOCK_PATTERN = /\s*[\(\[]([a-zA-Z ]{1,25})[\)\]]\s*$/;
const TITLE_SUFFIX_KEYWORD_PATTERN = /\b(remix|edit|mix|extended|live|acoustic|version|remaster)\b/i;
const TRAILING_YEAR_EDITION_PATTERN = /\s['’]2[0-9]$/;

export function canonicalTitleToken(title) {
  let raw = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  const trailing = raw.match(TITLE_SUFFIX_BLOCK_PATTERN);
  if (trailing) {
    const inner = String(trailing[1] || '').trim();
    const hasDigits = /\d/.test(inner);
    const hasKeywords = TITLE_SUFFIX_KEYWORD_PATTERN.test(inner);
    if (!hasDigits && !hasKeywords) {
      raw = raw.replace(TITLE_SUFFIX_BLOCK_PATTERN, '').trim();
    }
  }
  raw = raw.replace(TRAILING_YEAR_EDITION_PATTERN, '').trim();
  return normalizeText(raw);
}

function normalizeArtistPart(part) {
  const text = normalizeText(part);
  if (!text) return '';
  const tokens = text.split(' ').filter(Boolean);
  if (tokens.length === 2 && tokens[1] === 'beats') return tokens[0];
  return tokens.join(' ');
}

export function splitArtistParts(artist) {
  const raw = String(artist || '').trim();
  if (!raw) return [];
  const replaced = raw.replace(ARTIST_SPLIT_PATTERN, '|');
  const parts = replaced
    .split('|')
    .map((part) => normalizeArtistPart(part))
    .filter(Boolean);
  return Array.from(new Set(parts)).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
}

export function primaryArtistToken(artist) {
  const parts = splitArtistParts(artist);
  if (parts.length) return parts[0];
  return normalizeText(artist);
}

export function displayTrackIdentity(track) {
  const primary = primaryArtistToken(track?.artist);
  const title = canonicalTitleToken(track?.title);
  if (!primary && !title) return trackIdentity(track);
  return `display:${primary}::${title}`;
}

export function trackIdentity(track) {
  const key = String(track?.trackKey || track?.track_key || '').trim();
  if (key) return `key:${key}`;
  return `name:${canonicalTrackToken(track?.artist, track?.title)}`;
}

const PHONE_PATTERN = /(\+?\d[\d\s\-/]{6,}\d)/;
const NOISE_TERMS = [
  'anrufen',
  'jetzt anrufen',
  'rufen sie an',
  'ruf an',
  'whatsapp',
  'hotline',
  'gewinnspiel',
  'studio',
  'leitung',
  'verkehrszentrum',
  'kontakt',
  'nachrichten',
  'news',
  'werbung',
  'sponsor',
  'wetter',
  'verkehr',
  'mehr musik',
  'mehr abwechslung',
  'podcast',
  'moderation',
  'am mikrofon',
  'live aus dem',
  'haus in',
  'ard',
  'sendung',
  'abendshow',
  'morgenshow',
  'news update',
  'break',
  'freestar',
  'installieren sie gratis',
  'online radio box',
  'serververbindung verloren'
];

export function looksLikeNonMusicTitle(artist, title) {
  const a = normalizeText(artist);
  const t = normalizeText(title);
  const combined = `${a} ${t}`.trim();
  if (!combined) return true;
  if (PHONE_PATTERN.test(combined)) return true;
  if (combined.length > 180) return true;
  if (combined.split(' ').length > 24) return true;

  for (const term of NOISE_TERMS) {
    if (combined.includes(term)) return true;
  }

  if (a === t && (a.includes('radio') || a.includes('fm'))) return true;
  return false;
}

export function releaseAgeDays(releaseDateIso, refBerlinIso = berlinTodayIsoDate()) {
  if (!releaseDateIso) return null;
  const release = Date.parse(String(releaseDateIso));
  const ref = Date.parse(`${refBerlinIso}T12:00:00.000Z`);
  if (!Number.isFinite(release) || !Number.isFinite(ref)) return null;
  return Math.max(0, Math.floor((ref - release) / 86400000));
}

export function matchesSearch(track, query) {
  const q = normalizeText(query);
  if (!q) return true;
  const stationNames = Array.isArray(track?.stations) ? track.stations.join(' ') : `${track?.stationName || ''} ${track?.stationId || ''}`;
  const haystack = normalizeText(`${track?.artist || ''} ${track?.title || ''} ${stationNames}`);
  return haystack.includes(q);
}

export function dedupeTracksByIdentity(rows, { identityFn = trackIdentity } = {}) {
  const map = new Map();
  for (const row of rows || []) {
    const id = identityFn(row);
    if (!map.has(id)) {
      map.set(id, { ...row });
      continue;
    }
    const existing = map.get(id);
    existing.plays = Number(existing.plays || existing.total_plays || 0) + Number(row.plays || row.total_plays || 0);
    existing.total_plays = Number(existing.total_plays || 0) + Number(row.total_plays || row.plays || 0);
    existing.activeDays = Math.max(Number(existing.activeDays || 0), Number(row.activeDays || 0));
    existing.spanDays = Math.max(Number(existing.spanDays || 0), Number(row.spanDays || 0));
    existing.stationNames = Array.from(new Set([
      ...(existing.stationNames || []),
      ...(existing.stations || []),
      ...(row.stationNames || []),
      ...(row.stations || [])
    ]));
    existing.stationIds = Array.from(new Set([...(existing.stationIds || []), ...(row.stationIds || [])]));
    existing.station_count = existing.stationNames.length || Math.max(
      Number(existing.station_count || 0),
      Number(row.station_count || 0)
    );
    const existingScore = Number(existing.total_plays || existing.plays || 0);
    const rowScore = Number(row.total_plays || row.plays || 0);
    if ((row.track_key || row.trackKey) && rowScore >= existingScore) {
      if (row.track_key) existing.track_key = row.track_key;
      if (row.trackKey) existing.trackKey = row.trackKey;
    }
    if (!existing.release_date_utc && row.release_date_utc) existing.release_date_utc = row.release_date_utc;
    if (String(row.artist || '').length > String(existing.artist || '').length) existing.artist = row.artist;
    if (String(row.title || '').length > String(existing.title || '').length) existing.title = row.title;
    const existingFirst = String(existing.first_played_at_utc || existing.firstPlayedDate || '');
    const rowFirst = String(row.first_played_at_utc || row.firstPlayedDate || '');
    if (!existingFirst || (rowFirst && rowFirst < existingFirst)) {
      existing.first_played_at_utc = row.first_played_at_utc || row.firstPlayedDate || null;
      existing.firstPlayedDate = row.firstPlayedDate || row.first_played_at_utc || null;
    }
    const existingLast = String(existing.last_played_at_utc || existing.lastPlayedDate || '');
    const rowLast = String(row.last_played_at_utc || row.lastPlayedDate || '');
    if (!existingLast || (rowLast && rowLast > existingLast)) {
      existing.last_played_at_utc = row.last_played_at_utc || row.lastPlayedDate || null;
      existing.lastPlayedDate = row.lastPlayedDate || row.last_played_at_utc || null;
    }
  }
  return Array.from(map.values());
}
