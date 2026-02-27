import { DateTime } from 'luxon';
import { BERLIN_TZ } from './time.js';

function bucketLabel(dt, bucket) {
  if (bucket === 'day') return dt.toISODate();
  if (bucket === 'week') return dt.startOf('week').toISODate();
  if (bucket === 'month') return dt.toFormat('yyyy-LL');
  if (bucket === 'year') return dt.toFormat('yyyy');
  throw new Error(`Unsupported bucket: ${bucket}`);
}

export function buildTrackSeries(rows, bucket = 'day') {
  const byKey = new Map();

  for (const row of rows) {
    const dt = DateTime.fromISO(row.played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ);
    const key = bucketLabel(dt, bucket);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }

  return Array.from(byKey.entries())
    .map(([period, plays]) => ({ period, plays }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}

export function buildTrackTotals(rows) {
  const now = DateTime.now().setZone(BERLIN_TZ);
  const startDay = now.startOf('day');
  const startWeek = now.startOf('week');
  const startYear = now.startOf('year');

  let day = 0;
  let week = 0;
  let year = 0;

  for (const row of rows) {
    const dt = DateTime.fromISO(row.played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ);
    if (dt >= startDay) day += 1;
    if (dt >= startWeek) week += 1;
    if (dt >= startYear) year += 1;
  }

  return {
    today: day,
    thisWeek: week,
    thisYear: year,
    allTime: rows.length
  };
}
