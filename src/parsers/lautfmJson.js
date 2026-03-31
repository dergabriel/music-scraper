import { DateTime } from 'luxon';
import { BaseParser } from './base.js';

function parseStartedAt(raw) {
  if (!raw) return null;
  // laut.fm format: "2026-03-31 10:51:53 +0200"
  const dt = DateTime.fromFormat(String(raw).trim(), 'yyyy-MM-dd HH:mm:ss ZZZ', { setZone: true });
  if (dt.isValid) return dt.toUTC().toJSDate();
  // fallback: ISO
  const iso = DateTime.fromISO(String(raw).trim(), { setZone: true });
  if (iso.isValid) return iso.toUTC().toJSDate();
  return null;
}

function parseRows(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) return payload;
  } catch {
    return [];
  }
  return [];
}

export class LautfmJsonParser extends BaseParser {
  parse(raw, sourceUrl) {
    const rows = parseRows(raw);
    const plays = [];
    const seen = new Set();

    for (const row of rows) {
      if (row?.type !== 'song') continue;

      const artistRaw = String(row?.artist?.name ?? '').replace(/\s+/g, ' ').trim();
      const titleRaw = String(row?.title ?? '').replace(/\s+/g, ' ').trim();
      if (!artistRaw || !titleRaw) continue;

      const playedAt = parseStartedAt(row?.started_at);
      if (!playedAt) continue;

      const key = `${playedAt.toISOString()}|${artistRaw}|${titleRaw}`;
      if (seen.has(key)) continue;
      seen.add(key);

      plays.push({ playedAt, artistRaw, titleRaw, sourceUrl });
    }

    return plays;
  }
}
