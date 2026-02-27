import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';
import { GenericHtmlParser } from './genericHtml.js';

function splitArtistTitle(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/(.+?)\s+-\s+(.+)/);
  if (!match) return null;
  return { artistRaw: match[1].trim(), titleRaw: match[2].trim() };
}

export class FluxFmParser extends BaseParser {
  parse(html, sourceUrl) {
    const $ = cheerio.load(html);
    const plays = [];

    const rows = $('.playlist-item, .track-item, li, tr, article').toArray();
    for (const row of rows) {
      const el = $(row);
      const timeRaw =
        el.find('time').first().attr('datetime') ||
        el.find('time').first().text().trim() ||
        el.find('.time, .timestamp').first().text().trim();

      const playedAt = parsePlayedAt(timeRaw, this.timezone);
      if (!playedAt) continue;

      const artistRaw = el.find('.artist').first().text().trim();
      const titleRaw = el.find('.title').first().text().trim();
      const combo = el.find('.track, .song, .entry-title').first().text().trim();

      let item;
      if (artistRaw && titleRaw) {
        item = { artistRaw, titleRaw };
      } else if (combo) {
        item = splitArtistTitle(combo);
      } else {
        item = splitArtistTitle(el.text().replace(timeRaw || '', '').trim());
      }

      if (!item) continue;
      plays.push({ playedAt, artistRaw: item.artistRaw, titleRaw: item.titleRaw, sourceUrl });
    }

    if (!plays.length) {
      return new GenericHtmlParser({ timezone: this.timezone }).parse(html, sourceUrl);
    }

    return plays;
  }
}
