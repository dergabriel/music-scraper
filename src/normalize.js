import crypto from 'node:crypto';

const FEAT_PATTERN = /\s*(?:\(|\[)?\b(?:feat\.?|ft\.?|featuring)\b[^\)\]]*(?:\)|\])?\s*/gi;
const BRACKET_SUFFIX_PATTERN = /\s*[\[(](?:radio\s*edit|extended\s*mix|remix|mix|version|remaster(?:ed)?)\b[^\])]*[\])]/gi;
const PROMO_MARKER_PATTERN = /(?:\*+\s*neu\s*\*+|\[\s*neu\s*\]|\(\s*neu\s*\))/gi;
const PROMO_PREFIX_PATTERN = /^\s*neu\s*[-|:]\s*/i;
const PROMO_SUFFIX_PATTERN = /\s*[-|:]\s*neu\s*$/i;
const NOISE_PATTERN =
  /(https?:\/\/|www\.|freestar|window\.|function\(|oauth|xmlhttprequest|onlineradiobox|cookie|benutzer vereinbarung|privatsphäre|serververbindung|installieren sie|\bandroid\b|\bios\b|contentgraph|coverimageurl|streams?\s*[:=])/i;
const JINGLE_PATTERN =
  /\b(jingle|station voice|show opener|morningshow|morning show|good morning show|verkehr|wetter|news|nachrichten|promo|claim|werbung|commercial|spot|ident|soundlogo|im werbeblock|werbeblock|am mikrofon)\b/i;
const STATION_PROMO_PATTERN =
  /\b(deutschlands?\s+bigg?ste|radio|sender|station|berlin|baden[-\s]?württemberg|nrw|hamburg|sachsen|bayern|beats|hits)\b/i;
const UNKNOWN_TRACK_PATTERN = /^(unknown|unbekannt|n\/a|na)$/i;
const SERVICE_ANNOUNCEMENT_PATTERN =
  /\b(anruf(?:en)?\s+im\s+verkehrszentrum|hotline|kontakt\s+zur|verkehrszentrum|staumelder|verkehrsservice|blitzer[-\s]?hotline)\b/i;
const PHONE_NUMBER_PATTERN =
  /\b(?:\+?\d{2,3}[\s\-]?)?(?:0\d{2,5}[\s\-]?\d{3,}(?:[\s\-]?\d{1,})*)\b/;
const AD_BRAND_PATTERN =
  /\b(wochenkracher|rabatt|discount|angebot|kampagne|spot|commercial|sponsored|sponsor|marken[-\s]?discount)\b/i;
const BROADCAST_BULLETIN_PATTERN =
  /\b(abendshow|morning show|nachrichten|news|ticker|sondersendung|magazin|interview|kommentar)\b/i;
const AD_DURATION_PATTERN =
  /\b(?:\d{1,3}\s*(?:sec|sek|sekunden)|kw\s*\d{1,2})\b/i;
const NON_MUSIC_CONTEXT_PATTERN =
  /\((handel|retail|werbung|promo)\)/i;
const STATION_SLOGAN_PATTERN =
  /\bmehr\s+musik\b.*\bmehr\s+abwechslung\b|\bmehr\s+\w+\b.*\bmehr\s+\w+\b.*\bmehr\s+\w+\b|\bniedersachs(?:en|e)\b/i;
const GENERIC_STATION_TOKENS = new Set([
  'radio',
  'sender',
  'station',
  'livestream',
  'stream',
  'hitradio',
  'live'
]);
const GERMAN_STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem',
  'und', 'oder', 'aber', 'im', 'in', 'am', 'an', 'auf', 'mit', 'von', 'zu',
  'für', 'fuer', 'bei', 'nach', 'vor', 'als', 'ist', 'sind', 'war', 'werden',
  'weiter', 'geht', 'gehen'
]);

function clean(input) {
  return (input ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeTerm(input) {
  return clean(input)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFeat(input) {
  return input.replace(FEAT_PATTERN, ' ');
}

function stripBracketSuffix(input) {
  return input.replace(BRACKET_SUFFIX_PATTERN, ' ');
}

function stripPromoMarkers(input) {
  return String(input ?? '')
    .replace(PROMO_MARKER_PATTERN, ' ')
    .replace(PROMO_PREFIX_PATTERN, ' ')
    .replace(PROMO_SUFFIX_PATTERN, ' ');
}

function stripOuterQuotes(input) {
  return String(input ?? '')
    .replace(/^\s*["'“”„`]+\s*/g, '')
    .replace(/\s*["'“”„`]+\s*$/g, '');
}

function stripTracklistPrefix(input) {
  return String(input ?? '')
    .replace(/^\s*(?:#\s*)?\d{1,3}\s*[\.\)\-:]\s*/i, '')
    .replace(/^\s*track\s*\d{1,3}\s*[\.\)\-:]\s*/i, '');
}

function stripDuplicatedArtistPrefix(title, artist) {
  const cleanTitle = clean(title);
  const cleanArtist = clean(artist);
  if (!cleanTitle || !cleanArtist) return title;

  const artistWords = cleanArtist
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!artistWords.length) return cleanTitle;

  const artistLoose = artistWords.map((w) => escapeRegExp(w)).join('[\\s\\-_.]*');
  const re = new RegExp(`^${artistLoose}\\s*[-–—:]\\s*`, 'iu');
  return cleanTitle.replace(re, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stationTerms(stationName, stationId) {
  const terms = new Set();
  const add = (raw) => {
    const term = normalizeTerm(raw);
    if (!term) return;
    if (term.length >= 3) terms.add(term);
    const tokens = term.split(' ');
    for (const token of tokens) {
      if (token.length < 4) continue;
      if (GENERIC_STATION_TOKENS.has(token)) continue;
      terms.add(token);
    }
  };

  add(stationName);
  if (stationId) {
    add(stationId);
    add(String(stationId).replaceAll('_', ' '));
  }

  return Array.from(terms);
}

function containsAnyStationTerm(input, stationName, stationId) {
  const value = normalizeTerm(input);
  if (!value) return false;
  for (const term of stationTerms(stationName, stationId)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}([^\\p{L}\\p{N}]|$)`, 'iu');
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

function looksLikeEditorialOrBulletin(text) {
  const raw = String(text ?? '').toLowerCase();
  const words = raw
    .replace(/[^\p{L}\p{N}\s/:-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 8) return false;
  const stopwordHits = words.reduce((acc, w) => acc + (GERMAN_STOPWORDS.has(w) ? 1 : 0), 0);
  const hasClauseSeparators = /[-:/*]{1,3}/.test(raw);
  const hasMusicJoiners = /\b(feat\.?|ft\.?|featuring| x | vs\.?|&)\b/i.test(raw);
  return !hasMusicJoiners && hasClauseSeparators && stopwordHits >= 3;
}

export function isLikelyNoiseTrack(artistRaw, titleRaw, { stationName = '', stationId = '' } = {}) {
  const artist = String(artistRaw ?? '');
  const title = String(titleRaw ?? '');
  const combined = `${artist} ${title}`.toLowerCase();

  if (!artist.trim() || !title.trim()) return true;
  if (UNKNOWN_TRACK_PATTERN.test(artist.trim()) || UNKNOWN_TRACK_PATTERN.test(title.trim())) return true;
  if (combined.length > 240) return true;
  if (NOISE_PATTERN.test(combined)) return true;
  if (SERVICE_ANNOUNCEMENT_PATTERN.test(combined)) return true;
  if (PHONE_NUMBER_PATTERN.test(combined) && SERVICE_ANNOUNCEMENT_PATTERN.test(combined)) return true;
  if (NON_MUSIC_CONTEXT_PATTERN.test(combined)) return true;
  if (STATION_SLOGAN_PATTERN.test(combined)) return true;
  if (BROADCAST_BULLETIN_PATTERN.test(combined)) return true;
  if (AD_BRAND_PATTERN.test(combined)) return true;
  if (AD_DURATION_PATTERN.test(combined) && AD_BRAND_PATTERN.test(combined)) return true;
  if (looksLikeEditorialOrBulletin(combined)) return true;
  const stationArtist = containsAnyStationTerm(artist, stationName, stationId);
  const stationTitle = containsAnyStationTerm(title, stationName, stationId);
  if ((stationArtist || stationTitle) && STATION_PROMO_PATTERN.test(combined)) return true;
  if (stationArtist && title.trim().length < 48) return true;
  if (stationTitle && artist.trim().split(/\s+/).filter(Boolean).length >= 4) return true;
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
  if (containsAnyStationTerm(title, stationName, stationId) && artist.split(/\s+/).filter(Boolean).length >= 4) return true;

  const showArtist = /\b(show|morning|radio|station)\b/.test(artist);
  const showTitle = /\b(feel good|show|morning|friday|traffic|wetter|news|nachrichten)\b/.test(title);
  if (showArtist && showTitle) return true;

  return false;
}

export function normalizeArtistTitle(artistRaw, titleRaw, { stationName = '', stationId = '' } = {}) {
  const artistSanitized = stripTracklistPrefix(stripOuterQuotes(artistRaw ?? ''));
  const titleSanitized = stripTracklistPrefix(stripOuterQuotes(titleRaw ?? ''));
  const titleWithoutDuplicateArtist = stripDuplicatedArtistPrefix(titleSanitized, artistSanitized);

  const artistBase = clean(stripStationTerms(stripPromoMarkers(stripBracketSuffix(stripFeat(artistSanitized))), stationName, stationId));
  const titleBase = clean(stripStationTerms(stripPromoMarkers(stripBracketSuffix(stripFeat(titleWithoutDuplicateArtist))), stationName, stationId));

  const artist = artistBase.replace(/\s+/g, ' ').trim();
  const title = titleBase.replace(/\s+/g, ' ').trim();

  const trackKey = crypto
    .createHash('sha1')
    .update(`${artist}||${title}`, 'utf8')
    .digest('hex');

  return { artist, title, trackKey };
}
