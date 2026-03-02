import { DateTime } from 'luxon';
import { BERLIN_TZ } from './time.js';

function bucketLabel(dt, bucket) {
  if (bucket === 'day') return dt.toISODate();
  if (bucket === 'week') return dt.startOf('week').toISODate();
  if (bucket === 'month') return dt.toFormat('yyyy-LL');
  if (bucket === 'year') return dt.toFormat('yyyy');
  throw new Error(`Unsupported bucket: ${bucket}`);
}

function sortByPeriod(a, b) {
  if (a.period < b.period) return -1;
  if (a.period > b.period) return 1;
  return 0;
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
    .sort(sortByPeriod);
}

export function buildTrackSeriesByStation(rows, stationsById = new Map(), bucket = 'day') {
  const byStation = new Map();
  const allPeriods = new Set();

  for (const row of rows) {
    const stationId = String(row.station_id || '');
    if (!stationId) continue;
    const dt = DateTime.fromISO(row.played_at_utc, { zone: 'utc' }).setZone(BERLIN_TZ);
    const period = bucketLabel(dt, bucket);
    allPeriods.add(period);
    if (!byStation.has(stationId)) byStation.set(stationId, new Map());
    const stationMap = byStation.get(stationId);
    stationMap.set(period, (stationMap.get(period) ?? 0) + 1);
  }

  const periods = Array.from(allPeriods).sort();
  const stations = Array.from(byStation.entries())
    .map(([stationId, values]) => {
      const series = periods.map((period) => ({ period, plays: Number(values.get(period) || 0) }));
      return {
        stationId,
        stationName: stationsById.get(stationId) || stationId,
        totalPlays: series.reduce((sum, row) => sum + Number(row.plays || 0), 0),
        series
      };
    })
    .sort((a, b) => {
      if (b.totalPlays !== a.totalPlays) return b.totalPlays - a.totalPlays;
      return String(a.stationName).localeCompare(String(b.stationName), 'de', { sensitivity: 'base' });
    });

  return {
    periods,
    stations
  };
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
