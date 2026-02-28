import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';

const INVALID_TRACK_FRAGMENT =
  /(coverimageurl|contentgraph|streams?\s*[:=]|window\.|function\(|https?:\/\/|xmlhttprequest|@context|oauth|cookie|freestar|placementname|slotid|benutzer vereinbarung|privatsphäre|serververbindung verloren|onlineradio deutschland|installieren sie gratis)/i;
const MAX_ARTIST_LEN = 90;
const MAX_TITLE_LEN = 160;

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
    .replace(/^platz\s+\d+\s*:\s*/i, '');
}

function split(text) {
  const cleaned = cleanContent(text);
  if (!cleaned) return null;

  const byPattern = cleaned.match(/^(.+?)\s+(?:von|by)\s+(.+)$/i);
  if (byPattern) {
    const titleRaw = byPattern[1].trim();
    const artistRaw = byPattern[2].trim();
    return validateParts(artistRaw, titleRaw);
  }

  const separators = [' - ', ' – ', ' — '];
  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const [artistRaw, ...rest] = cleaned.split(sep);
      const titleRaw = rest.join(sep).trim();
      return validateParts(artistRaw, titleRaw);
    }
  }
  return null;
}

function looksLikeNoise(text) {
  return /^(live|aktuell)\s*\|/i.test(text) ||
    /^(du h[öo]rst|show by|install|nažalost|andere optionen|recommended|empfohlen|zuletzt gespielte titel)/i.test(text) ||
    INVALID_TRACK_FRAGMENT.test(text);
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
    const plays = [];

    const rows = $('.history-item, .playlist__row, tr, li').toArray();
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
