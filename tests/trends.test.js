import { describe, expect, it } from 'vitest';
import { buildTrackSeries, buildTrackTotals } from '../src/trends.js';

describe('trends', () => {
  const rows = [
    { played_at_utc: '2026-02-23T08:00:00.000Z' },
    { played_at_utc: '2026-02-23T12:00:00.000Z' },
    { played_at_utc: '2026-02-24T10:00:00.000Z' },
    { played_at_utc: '2026-02-26T10:00:00.000Z' }
  ];

  it('builds day series', () => {
    const series = buildTrackSeries(rows, 'day');
    expect(series.length).toBeGreaterThan(1);
    expect(series[0]).toHaveProperty('period');
    expect(series[0]).toHaveProperty('plays');
  });

  it('builds week series', () => {
    const series = buildTrackSeries(rows, 'week');
    expect(series.length).toBe(1);
    expect(series[0].plays).toBe(4);
  });

  it('builds totals object', () => {
    const totals = buildTrackTotals(rows);
    expect(totals).toHaveProperty('today');
    expect(totals).toHaveProperty('thisWeek');
    expect(totals).toHaveProperty('thisYear');
    expect(totals.allTime).toBe(4);
  });
});
