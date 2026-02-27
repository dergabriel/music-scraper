import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';

function split(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const separators = [' - ', ' – ', ' — '];
  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const [artistRaw, ...rest] = cleaned.split(sep);
      const titleRaw = rest.join(sep).trim();
      if (artistRaw && titleRaw) return { artistRaw: artistRaw.trim(), titleRaw };
    }
  }
  return null;
}

function looksLikeNoise(text) {
  return /^(live|aktuell)\s*\|/i.test(text) ||
    /^(du h[öo]rst|show by|install|nažalost|andere optionen|recommended|empfohlen)/i.test(text);
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
    let content = timed[2].trim();
    content = content.replace(/^platz\s+\d+\s*:\s*/i, '');

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
    let content = match[2].trim();
    if (!content || looksLikeNoise(content)) continue;

    content = content
      .replace(/^aktuell\s*/i, '')
      .replace(/^live\s*\|\s*/i, '')
      .replace(/^platz\s+\d+\s*:\s*/i, '');

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
        item = { artistRaw, titleRaw };
      } else {
        const text = el.text().replace(/\s+/g, ' ').trim();
        item = split(text.replace(timeRaw, '').trim());
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
