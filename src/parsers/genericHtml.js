import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';

const INVALID_TRACK_FRAGMENT =
  /(coverimageurl|contentgraph|streams?\s*[:=]|window\.|function\(|https?:\/\/|xmlhttprequest|@context|oauth|cookie|freestar|placementname|slotid|benutzer vereinbarung|privatsphäre|serververbindung verloren|onlineradio deutschland|installieren sie gratis)/i;
const MAX_ARTIST_LEN = 90;
const MAX_TITLE_LEN = 160;

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

function splitArtistTitle(line) {
  const cleaned = cleanContent(line);
  if (!cleaned) return null;

  const byPattern = cleaned.match(/^(.+?)\s+(?:von|by)\s+(.+)$/i);
  if (byPattern) {
    const titleRaw = byPattern[1].trim();
    const artistRaw = byPattern[2].trim();
    if (artistRaw && titleRaw && !INVALID_TRACK_FRAGMENT.test(`${artistRaw} ${titleRaw}`) && artistRaw.length <= MAX_ARTIST_LEN && titleRaw.length <= MAX_TITLE_LEN) {
      return { artistRaw, titleRaw };
    }
  }

  const separators = [' - ', ' – ', ' — ', ' | '];
  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const [artistRaw, ...rest] = cleaned.split(sep);
      const titleRaw = rest.join(sep).trim();
      if (artistRaw && titleRaw && !INVALID_TRACK_FRAGMENT.test(`${artistRaw} ${titleRaw}`) && artistRaw.length <= MAX_ARTIST_LEN && titleRaw.length <= MAX_TITLE_LEN) {
        return { artistRaw: artistRaw.trim(), titleRaw };
      }
    }
  }
  return null;
}

function extractTime(text) {
  const match = text.match(/\b(?:\d{1,2}:\d{2}|\d{2}\.\d{2}\.\d{2,4}\s+\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})\b/);
  return match ? match[0] : null;
}

function parseFromBodyText($, timezone, sourceUrl) {
  const bodyText = $('body').text();
  const lines = bodyText
    .split('\n')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const plays = [];
  const seen = new Set();
  for (const line of lines) {
    const timed =
      line.match(/^(\d{1,2}:\d{2})\s*\|\s*(.+)$/) ||
      line.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
    if (!timed) continue;

    const playedAt = parsePlayedAt(timed[1], timezone);
    if (!playedAt) continue;

    const song = splitArtistTitle(cleanContent(timed[2]));
    if (!song) continue;

    const key = `${playedAt.toISOString()}|${song.artistRaw}|${song.titleRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    plays.push({ playedAt, artistRaw: song.artistRaw, titleRaw: song.titleRaw, sourceUrl });
  }

  if (plays.length) return plays;

  const blob = bodyText.replace(/\s+/g, ' ').trim();
  const re = /(\d{1,2}:\d{2})\s+(.+?)(?=\s+\d{1,2}:\d{2}\s+|$)/g;
  let match;
  while ((match = re.exec(blob)) !== null) {
    const playedAt = parsePlayedAt(match[1], timezone);
    if (!playedAt) continue;

    const content = cleanContent(match[2]);
    const song = splitArtistTitle(content);
    if (!song) continue;

    const key = `${playedAt.toISOString()}|${song.artistRaw}|${song.titleRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    plays.push({ playedAt, artistRaw: song.artistRaw, titleRaw: song.titleRaw, sourceUrl });
  }

  return plays;
}

export class GenericHtmlParser extends BaseParser {
  parse(html, sourceUrl) {
    const $ = cheerio.load(html);
    const plays = [];
    const seen = new Set();

    const candidates = $('tr, li, article, .playlist-item, .track, .song, .entry, .item').toArray();
    for (const node of candidates) {
      const element = $(node);
      const text = element.text().replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const timeText =
        element.find('time').first().attr('datetime') ||
        element.find('time').first().text().trim() ||
        element.find('.time, .timestamp, .playlist-time, .uhrzeit').first().text().trim() ||
        extractTime(text);

      const explicitArtist = element.find('.artist').first().text().trim();
      const explicitTitle = element.find('.title, .song-title, .track-title').first().text().trim();
      const tableCells = element
        .find('td')
        .toArray()
        .map((cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const tableTime = tableCells.length >= 1 ? parsePlayedAt(tableCells[0], this.timezone) : null;
      const parsedTime = tableTime || parsePlayedAt(timeText, this.timezone);
      if (!parsedTime) continue;

      let artistTitle = null;
      if (explicitArtist && explicitTitle) {
        if (
          explicitArtist.length <= MAX_ARTIST_LEN &&
          explicitTitle.length <= MAX_TITLE_LEN &&
          !INVALID_TRACK_FRAGMENT.test(`${explicitArtist} ${explicitTitle}`)
        ) {
          artistTitle = { artistRaw: explicitArtist, titleRaw: explicitTitle };
        }
      } else if (tableCells.length >= 3) {
        // Common "Zeit | Artist | Titel" playlist tables.
        artistTitle = {
          artistRaw: cleanContent(tableCells[1]),
          titleRaw: cleanContent(tableCells.slice(2).join(' - '))
        };
        if (
          !artistTitle.artistRaw ||
          !artistTitle.titleRaw ||
          artistTitle.artistRaw.length > MAX_ARTIST_LEN ||
          artistTitle.titleRaw.length > MAX_TITLE_LEN ||
          INVALID_TRACK_FRAGMENT.test(`${artistTitle.artistRaw} ${artistTitle.titleRaw}`)
        ) {
          artistTitle = null;
        }
      } else {
        artistTitle = splitArtistTitle(cleanContent(text.replace(timeText || '', '').trim()));
      }

      if (!artistTitle) continue;

      const key = `${parsedTime.toISOString()}|${artistTitle.artistRaw}|${artistTitle.titleRaw}`;
      if (seen.has(key)) continue;
      seen.add(key);

      plays.push({
        playedAt: parsedTime,
        artistRaw: artistTitle.artistRaw,
        titleRaw: artistTitle.titleRaw,
        sourceUrl
      });
    }

    if (!plays.length) {
      return parseFromBodyText($, this.timezone, sourceUrl);
    }

    return plays;
  }
}
