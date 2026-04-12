import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';

const INVALID_TRACK_FRAGMENT =
  /(coverimageurl|contentgraph|streams?\s*[:=]|window\.|function\(|https?:\/\/|xmlhttprequest|@context|oauth|cookie|freestar|placementname|slotid|benutzer vereinbarung|privatsphäre|serververbindung verloren|onlineradio deutschland|installieren sie gratis)/i;
const MAX_ARTIST_LEN = 90;
const MAX_TITLE_LEN = 160;
const DASH_SEPARATORS = [' - ', ' – ', ' — ', ' / '];
const ARTIST_CUE_PATTERN = /(?:\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b|\bvs\.?\b|[&,;])/i;
const QUOTED_PATTERN = /^["'“”„].+["'“”„]$/;

function validateParts(artistRaw, titleRaw) {
  const artist = cleanContent(artistRaw);
  const title = cleanContent(titleRaw);
  if (!artist || !title) return null;
  if (artist.length > MAX_ARTIST_LEN || title.length > MAX_TITLE_LEN) return null;
  if (INVALID_TRACK_FRAGMENT.test(`${artist} ${title}`)) return null;
  return { artistRaw: artist, titleRaw: title };
}

function cleanContent(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^aktuell\s*/i, '')
    .replace(/^live\s*\|\s*/i, '')
    .replace(/^uhr\s*[-|]\s*/i, '')
    .replace(/^[|-]\s*/, '')
    .replace(/^platz\s+\d+\s*:\s*/i, '')
    .replace(/\s*\(platz\s+\d+\)\s*$/i, '')
    .trim();
}

function artistCueScore(text) {
  const value = cleanContent(text);
  if (!value) return -10;
  let score = 0;
  if (ARTIST_CUE_PATTERN.test(value)) score += 2;
  if (QUOTED_PATTERN.test(value)) score -= 1.2;
  if (/[!?]/.test(value)) score -= 0.4;
  if (value.split(/\s+/).length > 6) score -= 0.4;
  return score;
}

function detectDashOrientation(lines) {
  let artistTitleVotes = 0;
  let titleArtistVotes = 0;

  for (const raw of lines) {
    // "TITLE (Platz N) - ARTIST" format: left side is the title
    if (/\(platz\s+\d+\)/i.test(raw)) {
      titleArtistVotes += 2;
      continue;
    }

    const cleaned = cleanContent(raw);
    if (!cleaned) continue;

    for (const sep of DASH_SEPARATORS) {
      if (!cleaned.includes(sep)) continue;
      const [left, ...rest] = cleaned.split(sep);
      const right = rest.join(sep).trim();
      if (!left || !right) break;

      const leftScore = artistCueScore(left);
      const rightScore = artistCueScore(right);
      if (rightScore - leftScore >= 0.9) {
        titleArtistVotes += 1;
      } else if (leftScore - rightScore >= 0.9) {
        artistTitleVotes += 1;
      }
      break;
    }
  }

  if (titleArtistVotes >= 2 && titleArtistVotes >= artistTitleVotes * 1.35) {
    return 'title_artist';
  }
  return 'artist_title';
}

function split(text, { dashOrientation = 'artist_title', allowColon = false } = {}) {
  const cleaned = cleanContent(text);
  if (!cleaned) return null;

  const byPattern = cleaned.match(/^(.+?)\s+(?:von|by)\s+(.+)$/i);
  if (byPattern) {
    const titleRaw = byPattern[1].trim();
    const artistRaw = byPattern[2].trim();
    return validateParts(artistRaw, titleRaw);
  }

  if (allowColon) {
    const colonPattern = cleaned.match(/^([^:]{2,90})\s*:\s*(.+)$/);
    if (colonPattern) {
      const colonArtist = colonPattern[1].trim();
      const colonTitle = colonPattern[2].trim();
      const colonCandidate = validateParts(colonArtist, colonTitle);
      if (colonCandidate) return colonCandidate;
    }
  }

  for (const sep of DASH_SEPARATORS) {
    if (cleaned.includes(sep)) {
      const [first, ...rest] = cleaned.split(sep);
      const second = rest.join(sep).trim();
      if (!first || !second) return null;

      if (sep === ' / ') {
        return validateParts(second, first) ?? validateParts(first, second);
      }

      if (dashOrientation === 'title_artist') {
        return validateParts(second, first) ?? validateParts(first, second);
      }
      return validateParts(first, second) ?? validateParts(second, first);
    }
  }
  return null;
}

function looksLikeNoise(text) {
  return /^(live|aktuell)\s*\|/i.test(text) ||
    /^(du h[öo]rst|show by|install|nažalost|andere optionen|recommended|empfohlen|zuletzt gespielte titel)/i.test(text) ||
    /\b(besucht uns auf|facebook|instagram|vom ndr)\b/i.test(text) ||
    INVALID_TRACK_FRAGMENT.test(text);
}

function parseStructuredRows($, timezone, sourceUrl) {
  const rows = $('table.tablelist-schedule tr, table[role="log"] tr').toArray();
  if (!rows.length) return [];

  const sampleTrackTexts = rows
    .map((row) => $(row).find('.track_history_item, td.track_history_item, td:nth-child(2)').first().text())
    .map((x) => cleanContent(x))
    .filter(Boolean);

  const dashOrientation = detectDashOrientation(sampleTrackTexts);
  const colonLike = sampleTrackTexts.filter((x) => /^[^:]{2,90}\s*:\s*.+$/.test(x)).length;
  const dashLike = sampleTrackTexts.filter((x) => DASH_SEPARATORS.some((sep) => x.includes(sep))).length;
  const allowColon = colonLike >= 2 && colonLike >= dashLike;

  const plays = [];
  const seen = new Set();

  for (const row of rows) {
    const el = $(row);
    const timeRaw =
      el.find('.tablelist-schedule__time .time--schedule').first().text().trim() ||
      el.find('.time--schedule, .time, .history-item-time, td.time').first().text().trim() ||
      el.find('time').first().attr('datetime') ||
      el.find('time').first().text().trim();

    const playedAt = parsePlayedAt(timeRaw, timezone);
    if (!playedAt) continue;

    const artistRaw = el.find('.artist, .song-artist').first().text().trim();
    const titleRaw = el.find('.title, .song-title, .track-title').first().text().trim();

    let item;
    if (artistRaw && titleRaw) {
      item = validateParts(artistRaw, titleRaw);
    } else {
      const rawTrackText =
        el.find('.track_history_item, td.track_history_item, td:nth-child(2), .playlist__item').first().text().trim() ||
        el.text().replace(/\s+/g, ' ').trim();
      if (!rawTrackText || looksLikeNoise(rawTrackText)) continue;
      item = split(cleanContent(rawTrackText), { dashOrientation, allowColon });
    }
    if (!item) continue;

    const key = `${playedAt.toISOString()}|${item.artistRaw}|${item.titleRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plays.push({ playedAt, artistRaw: item.artistRaw, titleRaw: item.titleRaw, sourceUrl });
  }

  return plays;
}

function parseFromBodyText($, timezone, sourceUrl) {
  const text = $('body').text();
  const lines = text
    .split('\n')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const plays = [];
  const seen = new Set();

  for (const line of lines) {
    if (looksLikeNoise(line)) continue;

    const timed =
      line.match(/^(\d{1,2}:\d{2})\s*\|\s*(.+)$/) ||
      line.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
    if (!timed) continue;

    const timeRaw = timed[1];
    const content = cleanContent(timed[2]);

    const song = split(content);
    if (!song) continue;

    const playedAt = parsePlayedAt(timeRaw, timezone);
    if (!playedAt) continue;

    const key = `${playedAt.toISOString()}|${song.artistRaw}|${song.titleRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    plays.push({ playedAt, artistRaw: song.artistRaw, titleRaw: song.titleRaw, sourceUrl });
  }

  if (plays.length) return plays;

  const blob = text.replace(/\s+/g, ' ').trim();
  const re = /(\d{1,2}:\d{2})\s+(.+?)(?=\s+\d{1,2}:\d{2}\s+|$)/g;
  let match;
  while ((match = re.exec(blob)) !== null) {
    const timeRaw = match[1];
    let content = cleanContent(match[2]);
    if (!content || looksLikeNoise(content)) continue;

    const song = split(content);
    if (!song) continue;

    const playedAt = parsePlayedAt(timeRaw, timezone);
    if (!playedAt) continue;

    const key = `${playedAt.toISOString()}|${song.artistRaw}|${song.titleRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    plays.push({ playedAt, artistRaw: song.artistRaw, titleRaw: song.titleRaw, sourceUrl });
  }

  return plays;
}

export class OnlineradioboxParser extends BaseParser {
  parse(html, sourceUrl) {
    const $ = cheerio.load(html);
    const structuredPlays = parseStructuredRows($, this.timezone, sourceUrl);
    if (structuredPlays.length) {
      return structuredPlays;
    }

    const plays = [];
    const rows = $('.history-item, .playlist__row, tr').toArray();
    for (const row of rows) {
      const el = $(row);
      const timeRaw =
        el.find('.time, .history-item-time, td.time').first().text().trim() ||
        el.find('time').first().attr('datetime') ||
        el.find('time').first().text().trim();

      const playedAt = parsePlayedAt(timeRaw, this.timezone);
      if (!playedAt) continue;

      const artistRaw = el.find('.artist, .song-artist').first().text().trim();
      const titleRaw = el.find('.title, .song-title, .track-title').first().text().trim();

      let item;
      if (artistRaw && titleRaw) {
        item = validateParts(artistRaw, titleRaw);
      } else {
        const text = el.text().replace(/\s+/g, ' ').trim();
        item = split(cleanContent(text.replace(timeRaw, '')));
      }

      if (!item) continue;
      plays.push({ playedAt, artistRaw: item.artistRaw, titleRaw: item.titleRaw, sourceUrl });
    }

    if (!plays.length) {
      return parseFromBodyText($, this.timezone, sourceUrl);
    }

    return plays;
  }
}
