import * as cheerio from 'cheerio';
import { BaseParser } from './base.js';
import { parsePlayedAt } from '../time.js';

const INVALID_TRACK_FRAGMENT =
  /(coverimageurl|contentgraph|streams?\s*[:=]|window\.|function\(|https?:\/\/|xmlhttprequest|@context|oauth|cookie|freestar|placementname|slotid|benutzer vereinbarung|privatsphäre|serververbindung verloren|onlineradio deutschland|installieren sie gratis|popular radio stations|other channels|radio stations)/i;

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[-|]\s*/, '')
    .replace(/\s*[-|]$/, '')
    .trim();
}

function unquote(value) {
  return String(value ?? '').replace(/^["'“”„]+|["'“”„]+$/g, '').trim();
}

function artistCueScore(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return -10;

  let score = 0;
  if (/[&,;]|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b|\bvs\.?\b|\bwith\b/.test(text)) score += 2;
  if (/^["'“”„].+["'“”„]$/.test(value)) score -= 1.5;
  if (/\d/.test(text) && !/\bpt\.?\b/.test(text)) score -= 0.2;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 6) score -= 0.5;
  return score;
}

function detectOrientation(rows) {
  let artistTitleVotes = 0;
  let titleArtistVotes = 0;

  for (const row of rows) {
    const content = row.replace(/^\d{1,2}:\d{2}\s+/, '').trim();
    const parts = content.split(/\s+-\s+/);
    if (parts.length < 2) continue;

    const left = cleanText(parts[0]);
    const right = cleanText(parts.slice(1).join(' - '));
    if (!left || !right) continue;

    if (/^["'“”„].+["'“”„]$/.test(left)) titleArtistVotes += 2;
    if (/^["'“”„].+["'“”„]$/.test(right)) artistTitleVotes += 2;

    const leftScore = artistCueScore(left);
    const rightScore = artistCueScore(right);

    if (leftScore - rightScore >= 1) {
      artistTitleVotes += 1;
    } else if (rightScore - leftScore >= 1) {
      titleArtistVotes += 1;
    }
  }

  return titleArtistVotes > artistTitleVotes ? 'title_artist' : 'artist_title';
}

function parseContent(content, orientation) {
  const parts = content.split(/\s+-\s+/);
  if (parts.length < 2) return null;

  const left = cleanText(parts[0]);
  const right = cleanText(parts.slice(1).join(' - '));
  if (!left || !right) return null;

  let artistRaw;
  let titleRaw;

  if (/^["'“”„].+["'“”„]$/.test(left)) {
    titleRaw = unquote(left);
    artistRaw = unquote(right);
  } else if (/^["'“”„].+["'“”„]$/.test(right)) {
    artistRaw = unquote(left);
    titleRaw = unquote(right);
  } else {
    const leftScore = artistCueScore(left);
    const rightScore = artistCueScore(right);
    const shouldUseTitleArtist = rightScore - leftScore >= 1 || (orientation === 'title_artist' && rightScore > leftScore);

    if (shouldUseTitleArtist) {
      titleRaw = unquote(left);
      artistRaw = unquote(right);
    } else {
      artistRaw = unquote(left);
      titleRaw = unquote(right);
    }
  }

  if (!artistRaw || !titleRaw) return null;
  if (artistRaw.length > 120 || titleRaw.length > 180) return null;
  if (INVALID_TRACK_FRAGMENT.test(`${artistRaw} ${titleRaw}`)) return null;

  return { artistRaw, titleRaw };
}

function extractRowsFromText(bodyText) {
  return bodyText
    .split('\n')
    .map((line) => cleanText(line))
    .filter((line) => /^\d{1,2}:\d{2}\s+.+/.test(line));
}

export class RadioMenuParser extends BaseParser {
  parse(html, sourceUrl) {
    const $ = cheerio.load(html);

    // ── Strategy 1: radio.menu structured HTML ────────────────────────────
    // Format: <time datetime="2026-04-04T15:37"> + <span class="artist font-bold"> + <span class="name">
    const structured = this._parseStructured($, sourceUrl);
    if (structured.length) return structured;

    // ── Strategy 2: text-based fallback (HH:MM Artist - Title per line) ──
    return this._parseTextBased($, sourceUrl);
  }

  _parseStructured($, sourceUrl) {
    const seen = new Set();
    const plays = [];

    $('li').each((_, el) => {
      const timeEl = $(el).find('time[datetime]');
      if (!timeEl.length) return;

      const datetime = timeEl.attr('datetime'); // e.g. "2026-04-04T15:37"
      const artistEl = $(el).find('.artist, [class*="artist"]').first();
      const titleEl  = $(el).find('.name, [class*="name"]').first();

      if (!artistEl.length || !titleEl.length) return;

      const artistRaw = cleanText(artistEl.text());
      const titleRaw  = cleanText(titleEl.text());
      if (!artistRaw || !titleRaw) return;
      if (INVALID_TRACK_FRAGMENT.test(`${artistRaw} ${titleRaw}`)) return;
      if (artistRaw.length > 120 || titleRaw.length > 180) return;

      // Parse ISO datetime directly
      const d = new Date(datetime);
      if (isNaN(d.getTime())) return;

      const key = `${d.toISOString()}|${artistRaw}|${titleRaw}`;
      if (seen.has(key)) return;
      seen.add(key);

      plays.push({ playedAt: d, artistRaw, titleRaw, sourceUrl });
    });

    return plays;
  }

  _parseTextBased($, sourceUrl) {
    const rows = extractRowsFromText($('body').text());
    if (!rows.length) return [];

    const orientation = detectOrientation(rows);
    const seen = new Set();
    const plays = [];

    for (const row of rows) {
      const match = row.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
      if (!match) continue;

      const playedAt = parsePlayedAt(match[1], this.timezone);
      if (!playedAt) continue;

      const parsed = parseContent(match[2], orientation);
      if (!parsed) continue;

      const key = `${playedAt.toISOString()}|${parsed.artistRaw}|${parsed.titleRaw}`;
      if (seen.has(key)) continue;
      seen.add(key);

      plays.push({ playedAt, artistRaw: parsed.artistRaw, titleRaw: parsed.titleRaw, sourceUrl });
    }

    return plays;
  }
}
