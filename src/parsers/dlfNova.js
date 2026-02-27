import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';
import { GenericHtmlParser } from './genericHtml.js';

function parseLine(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/(.+?)\s+-\s+(.+)/);
  if (!match) return null;
  return { artistRaw: match[1].trim(), titleRaw: match[2].trim() };
}

export class DlfNovaParser extends BaseParser {
  parse(html, sourceUrl) {
    const $ = cheerio.load(html);
    const plays = [];

    const rows = $('[data-playlist-item], .playlist-item, article, li, tr').toArray();
    for (const row of rows) {
      const el = $(row);
      const timeRaw =
        el.find('time').first().attr('datetime') ||
        el.find('time').first().text().trim() ||
        el.find('.time, .uhrzeit').first().text().trim();

      const playedAt = parsePlayedAt(timeRaw, this.timezone);
      if (!playedAt) continue;

      const artistRaw = el.find('.artist, [data-artist]').first().text().trim() || el.attr('data-artist');
      const titleRaw = el.find('.title, [data-title]').first().text().trim() || el.attr('data-title');

      let item;
      if (artistRaw && titleRaw) {
        item = { artistRaw, titleRaw };
      } else {
        const text = el.text();
        item = parseLine(text.replace(timeRaw || '', ''));
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
