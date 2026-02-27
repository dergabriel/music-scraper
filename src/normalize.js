import crypto from 'node:crypto';

const FEAT_PATTERN = /\s*(?:\(|\[)?\b(?:feat\.?|ft\.?|featuring)\b[^\)\]]*(?:\)|\])?\s*/gi;
const BRACKET_SUFFIX_PATTERN = /\s*[\[(](?:radio\s*edit|extended\s*mix|remix|mix|version|remaster(?:ed)?)\b[^\])]*[\])]/gi;
const NOISE_PATTERN =
  /(https?:\/\/|www\.|freestar|window\.|function\(|oauth|xmlhttprequest|onlineradiobox|cookie|benutzer vereinbarung|privatsphäre|serververbindung|installieren sie|android|ios|contentgraph|coverimageurl|streams?\s*[:=])/i;
const JINGLE_PATTERN =
  /\b(jingle|station voice|show opener|morningshow|morning show|good morning show|verkehr|wetter|news|nachrichten|promo|claim|werbung|commercial|spot|ident|soundlogo|im werbeblock|werbeblock)\b/i;
const STATION_PROMO_PATTERN =
  /\b(deutschlands?\s+bigg?ste|radio|sender|station|berlin|baden[-\s]?württemberg|nrw|hamburg|sachsen|bayern|beats|hits)\b/i;
const UNKNOWN_TRACK_PATTERN = /^(unknown|unbekannt|n\/a|na)$/i;

function clean(input) {
  return (input ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function stripFeat(input) {
  return input.replace(FEAT_PATTERN, ' ');
}

function stripBracketSuffix(input) {
  return input.replace(BRACKET_SUFFIX_PATTERN, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stationTerms(stationName, stationId) {
  const terms = new Set();
  if (stationName) terms.add(clean(stationName));
  if (stationId) {
    terms.add(clean(stationId));
    terms.add(clean(String(stationId).replaceAll('_', ' ')));
  }
  return Array.from(terms).filter((x) => x.length >= 3);
}

function containsAnyStationTerm(input, stationName, stationId) {
  const value = clean(input);
  if (!value) return false;
  for (const term of stationTerms(stationName, stationId)) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    if (re.test(value)) return true;
  }
  return false;
}

function stripStationTerms(input, stationName, stationId) {
  let out = input;
  const terms = new Set();
  if (stationName) terms.add(stationName.toLowerCase());
  if (stationId) {
    terms.add(stationId.toLowerCase());
    terms.add(stationId.toLowerCase().replaceAll('_', ' '));
  }

  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'gi');
    out = out.replace(re, ' ');
  }

  return out;
}

export function isLikelyNoiseTrack(artistRaw, titleRaw, { stationName = '', stationId = '' } = {}) {
  const artist = String(artistRaw ?? '');
  const title = String(titleRaw ?? '');
  const combined = `${artist} ${title}`.toLowerCase();

  if (!artist.trim() || !title.trim()) return true;
  if (UNKNOWN_TRACK_PATTERN.test(artist.trim()) || UNKNOWN_TRACK_PATTERN.test(title.trim())) return true;
  if (combined.length > 240) return true;
  if (NOISE_PATTERN.test(combined)) return true;
  const stationArtist = containsAnyStationTerm(artist, stationName, stationId);
  const stationTitle = containsAnyStationTerm(title, stationName, stationId);
  if ((stationArtist || stationTitle) && STATION_PROMO_PATTERN.test(combined)) return true;
  if (stationArtist && title.trim().length < 48) return true;
  return false;
}

export function isLikelyJingleLike(artistRaw, titleRaw, { stationName = '', stationId = '' } = {}) {
  const artist = String(artistRaw ?? '').trim().toLowerCase();
  const title = String(titleRaw ?? '').trim().toLowerCase();
  const combined = `${artist} ${title}`;
  if (!artist || !title) return false;

  if (JINGLE_PATTERN.test(combined)) return true;
  if (containsAnyStationTerm(artist, stationName, stationId)) return true;
  if (containsAnyStationTerm(title, stationName, stationId) && STATION_PROMO_PATTERN.test(title)) return true;

  const showArtist = /\b(show|morning|radio|station)\b/.test(artist);
  const showTitle = /\b(feel good|show|morning|friday|traffic|wetter|news|nachrichten)\b/.test(title);
  if (showArtist && showTitle) return true;

  return false;
}

export function normalizeArtistTitle(artistRaw, titleRaw, { stationName = '', stationId = '' } = {}) {
  const artistBase = clean(stripStationTerms(stripBracketSuffix(stripFeat(artistRaw ?? '')), stationName, stationId));
  const titleBase = clean(stripStationTerms(stripBracketSuffix(stripFeat(titleRaw ?? '')), stationName, stationId));

  const artist = artistBase.replace(/\*neu\*/gi, ' ').replace(/\s+/g, ' ').trim();
  const title = titleBase.replace(/\*neu\*/gi, ' ').replace(/\s+/g, ' ').trim();

  const trackKey = crypto
    .createHash('sha1')
    .update(`${artist}||${title}`, 'utf8')
    .digest('hex');

  return { artist, title, trackKey };
}
