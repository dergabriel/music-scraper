import crypto from 'node:crypto';

const FEAT_PATTERN = /\s*(?:\(|\[)?\b(?:feat\.?|ft\.?|featuring)\b[^\)\]]*(?:\)|\])?\s*/gi;
const BRACKET_SUFFIX_PATTERN = /\s*[\[(](?:radio\s*edit|extended\s*mix|remix|mix|version|remaster(?:ed)?)\b[^\])]*[\])]/gi;
const PROMO_MARKER_PATTERN = /(?:\*+\s*neu\s*\*+|\[\s*neu\s*\]|\(\s*neu\s*\))/gi;
const PROMO_PREFIX_PATTERN = /^\s*neu\s*[-|:]\s*/i;
const PROMO_SUFFIX_PATTERN = /\s*[-|:]\s*neu\s*$/i;
const ARTIST_JOINER_PATTERN = /\s*(?:&|,|;|\/|\\|\+|×|\band\b|\bund\b|\bx\b|\bvs\.?\b|\bwith\b|\bplus\b)\s*/giu;
const NOISE_PATTERN =
  /(https?:\/\/|www\.|freestar|window\.|function\(|oauth|xmlhttprequest|onlineradiobox|cookie|benutzer vereinbarung|privatsphäre|serververbindung|installieren sie|\bandroid\b|\bios\b|contentgraph|coverimageurl|streams?\s*[:=])/i;
const JINGLE_PATTERN =
  /\b(jingle|station voice|show opener|morningshow|morning show|good morning show|verkehr|wetter|news|nachrichten|promo|claim|werbung|commercial|spot|ident|soundlogo|im werbeblock|werbeblock|am mikrofon|junge nacht|ard|live aus dem|im studio)\b/i;
const STATION_PROMO_PATTERN =
  /\b(deutschlands?\s+bigg?ste|radio|sender|station|berlin|baden[-\s]?württemberg|nrw|hamburg|sachsen|bayern|beats|hits)\b/i;
const UNKNOWN_TRACK_PATTERN = /^(unknown|unbekannt|n\/a|na)$/i;
const SERVICE_ANNOUNCEMENT_PATTERN =
  /\b(anruf(?:en)?\s+im\s+verkehrszentrum|jetzt\s+anrufen|rufen\s+sie\s+an|ruf\s+an|anrufen|hotline|kontakt\s+zur|verkehrszentrum|staumelder|verkehrsservice|blitzer[-\s]?hotline|whatsapp|studio|leitung|gewinnspiel)\b/i;
const PHONE_NUMBER_PATTERN =
  /\b(?:\+?\d{2,3}[\s\-]?)?(?:0\d{2,5}[\s\-]?\d{3,}(?:[\s\-]?\d{1,})*)\b/;
const AD_BRAND_PATTERN =
  /\b(wochenkracher|rabatt|discount|angebot|kampagne|spot|commercial|sponsored|sponsor|marken[-\s]?discount)\b/i;
const BROADCAST_BULLETIN_PATTERN =
  /\b(abendshow|morning show|nachrichten|news|ticker|sondersendung|magazin|interview|kommentar|junge nacht|ard|aus dem|haus in|live aus dem|im studio)\b/i;
const CONFLICT_HEADLINE_PATTERN =
  /\b(angriff|angriffe|eskalation|konflikt|gegenschlag|gegenschläge)\b/i;
const AD_DURATION_PATTERN =
  /\b(?:\d{1,3}\s*(?:sec|sek|sekunden)|kw\s*\d{1,2})\b/i;
const NON_MUSIC_CONTEXT_PATTERN =
  /\((handel|retail|werbung|promo)\)/i;
const STATION_SLOGAN_PATTERN =
  /\bmehr\s+musik\b.*\bmehr\s+abwechslung\b|\bmehr\s+\w+\b.*\bmehr\s+\w+\b.*\bmehr\s+\w+\b|\bniedersachs(?:en|e)\b/i;
const DATE_AMPERSAND_PREFIX_PATTERN =
  /^(?:\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{4})\s*&\s+/i;
const EVENT_SCHEDULE_PATTERN =
  /\b(radio\s*1(?:['’]s|\s+s)?\s+big\s+weekend|big\s+weekend|lineup|setlist|festival|live\s+from|live\s+at|bbc\s+radio)\b/i;
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
const SHORT_SUBTITLE_BLOCK_PATTERN = /\s*[\[(]\s*([^\]\)]{1,64})\s*[\])]\s*$/u;
const SHORT_SUBTITLE_DISALLOWED_PATTERN = /\b(radio|edit|remix|mix|version|remaster(?:ed)?|extended|live|acoustic)\b/i;
const EXPLICIT_EDITION_PATTERN =
  /^(?:taylor'?s?\s+version|taylor\s+version|tv|original\s+version|album\s+version)$/i;
const GENERIC_EDITION_BLOCK_PATTERN = /\s*[\[(]\s*([^\]\)]{1,64})\s*[\])]\s*$/u;
const GENERIC_EDITION_DISALLOWED_PATTERN = /\b(remix|edit|mix|extended|live|acoustic)\b/i;
const EVENT_TRAILING_BLOCK_PATTERN = /\s*[\[(]\s*([^\]\)]{1,140})\s*[\])]\s*$/u;
const EVENT_TAG_PATTERN =
  /\b(radio\s*\d+|bbc|big\s+weekend|festival|live\s+lounge|special|session)\b/i;
const EVENT_DATE_PATTERN =
  /\b(?:\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{4}|\d{4})\b/i;
const DATE_EVENT_PREFIX_CLEAN_PATTERN =
  /^\s*(?:\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{4})\s*&\s+/i;
const RADIO_EVENT_SUFFIX_CLEAN_PATTERN =
  /\s*(?:[-–—,:]\s*)?(?:radio\s*\d+(?:['’]s|\s+s)?\s+big\s+weekend(?:\s*\d{4})?)\s*$/i;

function clean(input) {
  return (input ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeUnicode(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function canonicalTitleKey(input) {
  return normalizeUnicode(String(input ?? ''))
    .toLowerCase()
    .replace(/['`´’]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function stripShortParentheticalSubtitle(input) {
  const source = String(input ?? '');
  const match = source.match(SHORT_SUBTITLE_BLOCK_PATTERN);
  if (!match) return source;

  const content = normalizeUnicode(match[1])
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!content) return source;
  if (content.length < 1 || content.length > 16) return source;
  if (!/^[\p{L}\s]+$/u.test(content)) return source;
  if (SHORT_SUBTITLE_DISALLOWED_PATTERN.test(content)) return source;

  const words = content.split(' ').filter(Boolean);
  if (!words.some((word) => word.length >= 4)) return source;

  return source.replace(SHORT_SUBTITLE_BLOCK_PATTERN, '').trim();
}

function stripEditionParentheses(input) {
  const source = String(input ?? '');
  const match = source.match(GENERIC_EDITION_BLOCK_PATTERN);
  if (!match) return source;

  const contentRaw = String(match[1] ?? '').trim();
  if (!contentRaw) return source;
  const contentNormalized = normalizeUnicode(contentRaw)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (EXPLICIT_EDITION_PATTERN.test(contentNormalized)) {
    return source.replace(GENERIC_EDITION_BLOCK_PATTERN, '').trim();
  }

  if (contentRaw.length > 25) return source;
  if (/\d/.test(contentRaw)) return source;
  if (GENERIC_EDITION_DISALLOWED_PATTERN.test(contentNormalized)) return source;
  if (!/^[\p{L}\s'’]+$/u.test(contentRaw)) return source;

  const words = contentNormalized.split(' ').filter(Boolean);
  if (!words.some((word) => word.length >= 4)) return source;

  return source.replace(GENERIC_EDITION_BLOCK_PATTERN, '').trim();
}

function stripTrailingYearEditionTag(input) {
  return String(input ?? '').replace(/\s'2[0-9]\s*$/u, '').trim();
}

function stripEventParentheticalSuffix(input) {
  const source = String(input ?? '');
  const match = source.match(EVENT_TRAILING_BLOCK_PATTERN);
  if (!match) return source;

  const content = String(match[1] ?? '').trim();
  if (!content) return source;
  if (!EVENT_TAG_PATTERN.test(content)) return source;
  if (!EVENT_DATE_PATTERN.test(content)) return source;

  return source.replace(EVENT_TRAILING_BLOCK_PATTERN, '').trim();
}

function stripDateEventSyntax(input) {
  let out = String(input ?? '');
  out = out.replace(DATE_EVENT_PREFIX_CLEAN_PATTERN, '').trim();
  out = out.replace(RADIO_EVENT_SUFFIX_CLEAN_PATTERN, '').trim();
  return out;
}

function stripTrailingTitlePunctuation(input) {
  let out = String(input ?? '')
    .replace(/^[\s!?:,;…]+/gu, '')
    .replace(/[\s!?:,;…]+$/gu, '')
    .trim();

  if (out.endsWith('.')) {
    const body = out.slice(0, -1);
    if (!body.includes('.')) out = body;
  }
  return out.trim();
}

function canonicalizeArtistPart(input) {
  let part = normalizeUnicode(input)
    .toLowerCase()
    .replace(/["'`´’“”„]/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!part) return '';

  const tokens = part.split(' ').filter(Boolean);
  if (tokens.length === 2 && tokens[1] === 'beats') {
    part = tokens[0];
  }
  return part.trim();
}

export function canonicalizeArtist(artistInput) {
  const splitInput = normalizeUnicode(artistInput)
    .replace(ARTIST_JOINER_PATTERN, '|');
  const parts = splitInput
    .split('|')
    .map((x) => canonicalizeArtistPart(x))
    .filter(Boolean);
  const unique = Array.from(new Set(parts));
  unique.sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  return unique.join(' & ');
}

export function getArtistParts(artistInput) {
  const canonical = canonicalizeArtist(artistInput);
  if (!canonical) return [];
  return canonical
    .split(/\s*&\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function primaryArtist(artistInput) {
  return getArtistParts(artistInput)[0] ?? '';
}

export function artistSet(artistInput) {
  return new Set(getArtistParts(artistInput));
}

function artistTokensLooseMatch(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export function artistOverlapRatioLoose(a, b) {
  const aa = Array.from(artistSet(a));
  const bb = Array.from(artistSet(b));
  if (!aa.length || !bb.length) return 0;

  const used = new Set();
  let common = 0;
  for (const tokenA of aa) {
    let matchedIndex = -1;
    for (let i = 0; i < bb.length; i += 1) {
      if (used.has(i)) continue;
      if (artistTokensLooseMatch(tokenA, bb[i])) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex >= 0) {
      used.add(matchedIndex);
      common += 1;
    }
  }
  return common / Math.max(1, Math.min(aa.length, bb.length));
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
  const hasSlashHeadline = /\b[\p{L}]{2,}\/[\p{L}]{2,}\b/u.test(raw);
  if (hasSlashHeadline && CONFLICT_HEADLINE_PATTERN.test(raw)) return true;
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

function looksLikeEventScheduleLine(artistRaw, titleRaw) {
  const artist = String(artistRaw ?? '').trim();
  const title = String(titleRaw ?? '').trim();
  const combined = `${artist} ${title}`.toLowerCase();
  if (!combined) return false;

  if (EVENT_SCHEDULE_PATTERN.test(combined) && DATE_AMPERSAND_PREFIX_PATTERN.test(title)) return true;
  if (/\bradio\s*1(?:['’]s|\s+s)?\s+big\s+weekend\b/i.test(combined) && DATE_AMPERSAND_PREFIX_PATTERN.test(title)) return true;
  return false;
}

export function isLikelyNoiseTrack(artistRaw, titleRaw, { stationName = '', stationId = '' } = {}) {
  const artist = String(artistRaw ?? '');
  const title = String(titleRaw ?? '');
  const combined = `${artist} ${title}`.toLowerCase();

  if (!artist.trim() || !title.trim()) return true;
  if (UNKNOWN_TRACK_PATTERN.test(artist.trim()) || UNKNOWN_TRACK_PATTERN.test(title.trim())) return true;
  if (combined.length > 240) return true;
  if (PHONE_NUMBER_PATTERN.test(combined)) return true;
  if (NOISE_PATTERN.test(combined)) return true;
  if (SERVICE_ANNOUNCEMENT_PATTERN.test(combined)) return true;
  if (NON_MUSIC_CONTEXT_PATTERN.test(combined)) return true;
  if (STATION_SLOGAN_PATTERN.test(combined)) return true;
  if (BROADCAST_BULLETIN_PATTERN.test(combined)) return true;
  if (AD_BRAND_PATTERN.test(combined)) return true;
  if (AD_DURATION_PATTERN.test(combined) && AD_BRAND_PATTERN.test(combined)) return true;
  if (looksLikeEventScheduleLine(artist, title)) return true;
  if (looksLikeEditorialOrBulletin(combined)) return true;
  if (containsAnyStationTerm(combined, stationName, stationId) && /(?:show|nacht|studio|live|haus|sendung|ard|nachrichten|news)/i.test(combined)) return true;
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

  const artistBase = stripStationTerms(stripPromoMarkers(stripBracketSuffix(stripFeat(artistSanitized))), stationName, stationId);
  const titlePrepared = stripStationTerms(
    stripPromoMarkers(
      stripBracketSuffix(
        stripFeat(titleWithoutDuplicateArtist)
      )
    ),
    stationName,
    stationId
  );
  const titleBase = clean(
    stripTrailingTitlePunctuation(
      stripTrailingYearEditionTag(
        stripEditionParentheses(
          stripEventParentheticalSuffix(
            stripDateEventSyntax(
              stripShortParentheticalSubtitle(titlePrepared)
            )
          )
        )
      )
    )
  );

  const artist = canonicalizeArtist(artistBase);
  const title = titleBase.replace(/\s+/g, ' ').trim();

  const trackKey = crypto
    .createHash('sha1')
    .update(`${artist}||${title}`, 'utf8')
    .digest('hex');

  return { artist, title, trackKey };
}
