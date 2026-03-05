import { DateTime } from 'luxon';
import { BaseParser } from './base.js';

function parsePlayedAtUtc(row, timezone) {
  const candidates = [
    row?.timeslot_iso,
    row?.timeslot,
    row?.timeend_iso,
    row?.timeend,
    row?.played_at_utc,
    row?.played_at
  ];

  for (const value of candidates) {
    if (!value) continue;
    const raw = String(value).trim();
    if (!raw) continue;

    let dt = DateTime.fromISO(raw, { setZone: true });
    if (!dt.isValid) {
      dt = DateTime.fromFormat(raw, 'yyyy-LL-dd HH:mm:ss', { zone: timezone });
    }
    if (!dt.isValid) {
      dt = DateTime.fromFormat(raw, 'yyyy-LL-dd HH:mm', { zone: timezone });
    }
    if (!dt.isValid) continue;
    return dt.toUTC().toJSDate();
  }

  return null;
}

function parseRows(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.rows)) return payload.rows;
  } catch {
    return [];
  }

  return [];
}

export class NrwLokalradiosJsonParser extends BaseParser {
  parse(raw, sourceUrl) {
    const rows = parseRows(raw);
    const plays = [];
    const seen = new Set();

    for (const row of rows) {
      const artistRaw = String(row?.artist ?? '').replace(/\s+/g, ' ').trim();
      const titleRaw = String(row?.title ?? '').replace(/\s+/g, ' ').trim();
      if (!artistRaw || !titleRaw) continue;

      const playedAt = parsePlayedAtUtc(row, this.timezone);
      if (!playedAt) continue;

      const key = `${playedAt.toISOString()}|${artistRaw}|${titleRaw}`;
      if (seen.has(key)) continue;
      seen.add(key);

      plays.push({
        playedAt,
        artistRaw,
        titleRaw,
        sourceUrl
      });
    }

    return plays;
  }
}
