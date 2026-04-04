import {
  berlinTodayIsoDate,
  berlinYesterdayIsoDate,
  shiftBerlinIsoDate
} from './date-berlin.js';
import {
  fillDailySeriesRange,
  formatPlays,
  formatSeriesPeriod,
  toCumulativeSeries
} from './charts.base.js';
import { renderLineChart } from './charts.line.js';
import { renderBarChart, renderDailyBarChart } from './charts.bar.js';
import {
  React,
  createRoot,
  Chakra,
  Icons,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  formatDateTime,
  useDebouncedValue,
  AppShell,
  PanelCard,
  useUiColors
} from './horizon-lib.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'plays_per_day_desc', label: 'Plays/Tag ↓' },
  { value: 'plays_per_day_asc', label: 'Plays/Tag ↑' },
  { value: 'total_plays_desc', label: 'Plays gesamt ↓' },
  { value: 'total_plays_asc', label: 'Plays gesamt ↑' },
  { value: 'last_played_desc', label: 'Letztes Play neueste' },
  { value: 'artist_asc', label: 'Interpret A-Z' }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortTracks(rows, sortMode) {
  const data = [...(Array.isArray(rows) ? rows : [])];
  const byDate = (a, b) => (new Date(a).getTime() || 0) - (new Date(b).getTime() || 0);
  data.sort((a, b) => {
    if (sortMode === 'plays_per_day_desc') return Number(b.plays_per_day || 0) - Number(a.plays_per_day || 0);
    if (sortMode === 'plays_per_day_asc') return Number(a.plays_per_day || 0) - Number(b.plays_per_day || 0);
    if (sortMode === 'total_plays_desc') return Number(b.total_plays || 0) - Number(a.total_plays || 0);
    if (sortMode === 'total_plays_asc') return Number(a.total_plays || 0) - Number(b.total_plays || 0);
    if (sortMode === 'last_played_desc') return byDate(b.last_played_at_utc, a.last_played_at_utc);
    return String(a.artist || '').localeCompare(String(b.artist || ''), 'de', { sensitivity: 'base' });
  });
  return data;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dayLabel(period) {
  if (!period) return '-';
  const date = new Date(`${period}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(period);
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function fmtDateOnly(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('de-DE');
}

function dayCount(fromIso, toIso) {
  const start = Date.parse(`${fromIso}T12:00:00.000Z`);
  const end = Date.parse(`${toIso}T12:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

function toFixedLocale(value, digits = 2) {
  const num = Number(value || 0);
  return num.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function openTrackPage(trackKey) {
  window.location.href = `/dashboard?trackKey=${encodeURIComponent(trackKey)}`;
}

// ── Track detail data helpers ─────────────────────────────────────────────────

function buildDailyTrackTrendRows(seriesByStation, panelActiveSeries) {
  const stationRows = Array.isArray(seriesByStation?.stations) ? seriesByStation.stations : [];
  const panelRows = Array.isArray(panelActiveSeries) ? panelActiveSeries : [];
  const allPeriods = new Set();
  stationRows.forEach((s) => (s.series || []).forEach((r) => { if (r?.period) allPeriods.add(r.period); }));
  panelRows.forEach((r) => { if (r?.period) allPeriods.add(r.period); });
  const periods = Array.from(allPeriods).sort((a, b) => a.localeCompare(b));
  const activeByPeriod = new Map(panelRows.map((r) => [r.period, Number(r.active_senders || 0)]));
  return periods.map((period) => {
    let rawPlays = 0;
    stationRows.forEach((s) => {
      const pt = (s.series || []).find((r) => r.period === period);
      rawPlays += Number(pt?.plays || 0);
    });
    const activeSenders = Number(activeByPeriod.get(period) || 0);
    return { period, rawPlays, activeSenders, normalizedPlays: activeSenders > 0 ? rawPlays / activeSenders : 0 };
  });
}

function buildDayStationMatrix(seriesByStation) {
  const stations = Array.isArray(seriesByStation?.stations) ? [...seriesByStation.stations] : [];
  const topStations = stations.sort((a, b) => Number(b.totalPlays || 0) - Number(a.totalPlays || 0)).slice(0, 8);
  const periods = Array.isArray(seriesByStation?.periods) ? [...seriesByStation.periods].sort() : [];
  const byPeriod = new Map(periods.map((p) => [p, {
    period: p, total: 0, activeStations: 0,
    byStation: topStations.map((s) => ({ stationId: s.stationId, stationName: s.stationName, plays: 0 }))
  }]));
  topStations.forEach((station, idx) => {
    (station.series || []).forEach((row) => {
      const bucket = byPeriod.get(row.period);
      if (!bucket) return;
      const plays = Number(row.plays || 0);
      bucket.byStation[idx].plays = plays;
      bucket.total += plays;
      if (plays > 0) bucket.activeStations += 1;
    });
  });
  const rows = Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period)).slice(-21).sort((a, b) => b.period.localeCompare(a.period));
  const maxValue = rows.reduce((m, row) => { row.byStation.forEach((s) => { if (s.plays > m) m = s.plays; }); return m; }, 0);
  const stationTotals = topStations.map((s) => ({
    stationId: s.stationId, stationName: s.stationName,
    total: rows.reduce((sum, r) => sum + Number(r.byStation.find((x) => x.stationId === s.stationId)?.plays || 0), 0)
  })).sort((a, b) => b.total - a.total);
  return { rows, stations: topStations, maxValue: Math.max(1, maxValue), stationTotals };
}

function computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays }) {
  if (!selectedTrack) return { score: 0, label: 'Kein Track', popularityPct: 0, momentumPct: 0, spreadPct: 0, dailyStrengthPct: 0 };
  const popularityPct = clamp((Number(selectedTrack.total_plays || 0) / Math.max(1, Number(maxTrackPlays || 1))) * 100, 0, 100);
  const momentumPct = clamp((Number(trend?.growth_percent || 0) + 100) / 2, 0, 100);
  const spreadPct = clamp((matrix.stationTotals.filter((r) => r.total > 0).length / Math.max(1, matrix.stations.length)) * 100, 0, 100);
  const dailyStrengthPct = clamp((Number(totals?.totals?.allTime || 0) / Math.max(1, rangeDays) / 8) * 100, 0, 100);
  const score = Math.round(popularityPct * 0.4 + momentumPct * 0.3 + spreadPct * 0.2 + dailyStrengthPct * 0.1);
  let label = 'Schwach';
  if (score >= 75) label = 'Sehr stark';
  else if (score >= 55) label = 'Gut';
  else if (score >= 35) label = 'Mittel';
  return { score, label, popularityPct, momentumPct, spreadPct, dailyStrengthPct };
}

// ── Small components ──────────────────────────────────────────────────────────

function StatCard({ label, value, compact }) {
  const ui = useUiColors();
  return React.createElement(
    PanelCard, { p: '4' },
    React.createElement(Chakra.Text, { fontSize: 'xs', color: ui.textMuted, mb: '1' }, label),
    React.createElement(Chakra.Text, { fontSize: compact ? 'sm' : '2xl', fontWeight: '800', color: ui.textPrimary, noOfLines: compact ? 2 : undefined }, value)
  );
}

function MiniKpi({ label, value }) {
  const ui = useUiColors();
  return React.createElement(
    Chakra.Box, { border: '1px solid', borderColor: ui.lineColor, borderRadius: '12px', px: '3', py: '2' },
    React.createElement(Chakra.Text, { fontSize: 'xs', color: ui.textMuted }, label),
    React.createElement(Chakra.Text, { fontSize: 'lg', fontWeight: '700', color: ui.textPrimary }, value)
  );
}

function MetricLine({ label, value, colorScheme }) {
  const ui = useUiColors();
  return React.createElement(
    Chakra.Box, null,
    React.createElement(Chakra.HStack, { justify: 'space-between', mb: '1' },
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted }, label),
      React.createElement(Chakra.Text, { fontSize: 'sm', fontWeight: '700', color: ui.textPrimary }, `${value}%`)
    ),
    React.createElement(Chakra.Progress, { value: Number(value || 0), colorScheme, size: 'sm', borderRadius: '999px' })
  );
}

function PreviewControl({ previewUrl, externalUrl, compact }) {
  if (previewUrl) {
    return React.createElement(
      Chakra.HStack, { spacing: '2', align: 'center' },
      React.createElement('audio', { controls: true, preload: 'none', src: previewUrl, style: { height: '30px', width: compact ? '180px' : '220px' } }),
      externalUrl ? React.createElement(Chakra.Link, { href: externalUrl, target: '_blank', rel: 'noreferrer', color: 'teal.500' }, 'iTunes') : null
    );
  }
  if (externalUrl) return React.createElement(Chakra.Link, { href: externalUrl, target: '_blank', rel: 'noreferrer', color: 'teal.500' }, 'Titelseite');
  return React.createElement(Chakra.Tag, { colorScheme: 'orange', borderRadius: '999px' }, 'Kein Preview');
}

// ── SongPerformanceCard ───────────────────────────────────────────────────────

function SongPerformanceCard({ selectedTrack, trend, totals, matrix, maxTrackPlays, from, to }) {
  const ui = useUiColors();
  if (!selectedTrack) return React.createElement(Chakra.Text, { color: ui.textMuted }, 'Kein Track geladen.');
  const rangeDays = dayCount(from, to);
  const score = computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays });
  return React.createElement(
    Chakra.VStack, { align: 'stretch', spacing: '4' },
    React.createElement(Chakra.HStack, { justify: 'space-between' },
      React.createElement(Chakra.HStack, { spacing: '4', align: 'end' },
        React.createElement(Chakra.Text, { fontSize: '5xl', lineHeight: '1', fontWeight: '800', color: ui.textPrimary }, score.score),
        React.createElement(Chakra.Text, { fontSize: 'md', color: ui.textMuted, pb: '2' }, '/ 100')
      ),
      React.createElement(Chakra.Badge, { colorScheme: score.score >= 55 ? 'green' : score.score >= 35 ? 'orange' : 'red', px: '3', py: '1', borderRadius: '999px' }, score.label)
    ),
    React.createElement(Chakra.Progress, { value: score.score, colorScheme: 'blue', borderRadius: '999px', size: 'md' }),
    React.createElement(Chakra.HStack, { spacing: '3', flexWrap: 'wrap' },
      React.createElement(Chakra.Tag, { colorScheme: 'gray', borderRadius: '999px' }, `Release: ${fmtDateOnly(selectedTrack.release_date_utc)}`),
      React.createElement(PreviewControl, { previewUrl: selectedTrack.preview_url, externalUrl: selectedTrack.external_url })
    ),
    React.createElement(Chakra.SimpleGrid, { columns: { base: 1, md: 2 }, spacing: '3' },
      React.createElement(MetricLine, { label: 'Beliebtheit im Panel', value: score.popularityPct.toFixed(0), colorScheme: 'blue' }),
      React.createElement(MetricLine, { label: 'Momentum', value: score.momentumPct.toFixed(0), colorScheme: 'green' }),
      React.createElement(MetricLine, { label: 'Sender-Breite', value: score.spreadPct.toFixed(0), colorScheme: 'purple' }),
      React.createElement(MetricLine, { label: 'Durchschnitt Plays/Tag', value: score.dailyStrengthPct.toFixed(0), colorScheme: 'orange' })
    ),
    React.createElement(Chakra.SimpleGrid, { columns: { base: 2, md: 4 }, spacing: '2' },
      React.createElement(MiniKpi, { label: 'Plays gesamt', value: formatNumber(totals?.totals?.allTime || 0) }),
      React.createElement(MiniKpi, { label: 'Heute', value: formatNumber(totals?.totals?.today || 0) }),
      React.createElement(MiniKpi, { label: 'Woche', value: formatNumber(totals?.totals?.thisWeek || 0) }),
      React.createElement(MiniKpi, { label: 'Trend 48h', value: formatNumber(trend?.plays_last_48h || 0) })
    )
  );
}

// ── TrackTrendLineChart ───────────────────────────────────────────────────────

function TrackTrendLineChart({ rows, mode }) {
  const ui = useUiColors();
  const points = Array.isArray(rows) ? rows : [];
  if (!points.length) return React.createElement(Chakra.Text, { color: ui.textMuted }, 'Keine Trenddaten im gewählten Zeitraum.');
  const values = points.map((r) => (mode === 'normalized' ? Number(r.normalizedPlays || 0) : Number(r.rawPlays || 0)));
  const maxValue = Math.max(1, ...values);
  const width = Math.max(760, points.length * 30);
  const height = 260;
  const margin = { top: 16, right: 16, bottom: 44, left: 48 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const stepX = points.length > 1 ? plotW / (points.length - 1) : plotW;
  const xStep = Math.max(1, Math.floor(points.length / 8));
  const axisColor = 'var(--chart-axis)';
  const gridColor = 'var(--chart-grid)';
  const textColor = 'var(--chart-text)';
  const lineColor = mode === 'normalized' ? 'var(--chart-series-secondary)' : 'var(--chart-series-primary)';
  const path = points.map((r, i) => {
    const v = mode === 'normalized' ? Number(r.normalizedPlays || 0) : Number(r.rawPlays || 0);
    return `${i === 0 ? 'M' : 'L'} ${margin.left + i * stepX} ${margin.top + plotH - (v / maxValue) * plotH}`;
  }).join(' ');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => maxValue * r);
  return React.createElement(
    Chakra.Box, { overflowX: 'auto' },
    React.createElement('svg', { viewBox: `0 0 ${width} ${height}`, style: { width: '100%', minWidth: `${Math.min(width, 1300)}px`, height: 'auto' } },
      React.createElement('line', { x1: margin.left, y1: margin.top + plotH, x2: margin.left + plotW, y2: margin.top + plotH, stroke: axisColor, strokeWidth: '1.2' }),
      React.createElement('line', { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotH, stroke: axisColor, strokeWidth: '1.2' }),
      ...yTicks.map((tick, i) => {
        const y = margin.top + plotH - (tick / maxValue) * plotH;
        return React.createElement('g', { key: `y-${i}` },
          React.createElement('line', { x1: margin.left, y1: y, x2: margin.left + plotW, y2: y, stroke: gridColor, strokeDasharray: '4 4', strokeWidth: '1' }),
          React.createElement('text', { x: margin.left - 8, y: y + 4, textAnchor: 'end', fontSize: '11', fill: textColor },
            mode === 'normalized' ? toFixedLocale(tick, 2) : formatNumber(Math.round(tick)))
        );
      }),
      React.createElement('path', { d: path, fill: 'none', stroke: lineColor, strokeWidth: '2.5', strokeLinejoin: 'round', strokeLinecap: 'round' }),
      ...points.map((r, i) => {
        const v = mode === 'normalized' ? Number(r.normalizedPlays || 0) : Number(r.rawPlays || 0);
        const x = margin.left + i * stepX;
        const y = margin.top + plotH - (v / maxValue) * plotH;
        return React.createElement('g', { key: `pt-${r.period}` },
          React.createElement('circle', { cx: x, cy: y, r: '3.4', fill: lineColor },
            React.createElement('title', null, `${dayLabel(r.period)} | Roh: ${formatNumber(r.rawPlays)} | Panel: ${toFixedLocale(r.normalizedPlays, 2)}`)),
          (i % xStep === 0 || i === points.length - 1)
            ? React.createElement('text', { x, y: margin.top + plotH + 16, textAnchor: 'middle', fontSize: '10', fill: textColor }, dayLabel(r.period))
            : null
        );
      }),
      React.createElement('text', { x: margin.left + plotW / 2, y: height - 8, textAnchor: 'middle', fontSize: '11', fill: textColor }, 'Tag'),
      React.createElement('text', { x: '14', y: margin.top + plotH / 2, transform: `rotate(-90 14 ${margin.top + plotH / 2})`, textAnchor: 'middle', fontSize: '11', fill: textColor },
        mode === 'normalized' ? 'Plays je aktivem Sender' : 'Roh-Plays')
    )
  );
}

// ── LegacyStatsCharts ─────────────────────────────────────────────────────────

function LegacyStatsCharts({ selectedTrack, from, to, bucket, cumulativeSeries, bucketSeries, stationsByPlays, seriesByStation }) {
  const ui = useUiColors();
  const cumulativeRef = React.useRef(null);
  const periodRef = React.useRef(null);
  const stationBarRef = React.useRef(null);
  const perDayRef = React.useRef(null);

  const availablePeriods = React.useMemo(() => {
    const periods = Array.isArray(seriesByStation?.periods) ? [...seriesByStation.periods] : [];
    return periods.sort((a, b) => b.localeCompare(a));
  }, [seriesByStation]);

  const [selectedPeriod, setSelectedPeriod] = React.useState('');
  React.useEffect(() => { if (availablePeriods.length > 0) setSelectedPeriod(availablePeriods[0]); }, [availablePeriods]);

  const perDayStationRows = React.useMemo(() => {
    if (!selectedPeriod || !Array.isArray(seriesByStation?.stations)) return [];
    return seriesByStation.stations
      .map((s) => {
        const pt = (s.series || []).find((r) => r.period === selectedPeriod);
        return { station_id: s.stationId, station_name: s.stationName, plays: Number(pt?.plays || 0) };
      })
      .filter((r) => r.plays > 0)
      .sort((a, b) => b.plays - a.plays);
  }, [seriesByStation, selectedPeriod]);

  const renderMainCharts = React.useCallback(() => {
    const cN = cumulativeRef.current, pN = periodRef.current, sN = stationBarRef.current;
    if (!cN || !pN || !sN) return;
    const cumRows = toCumulativeSeries(Array.isArray(cumulativeSeries) ? cumulativeSeries : []);
    const cumStart = Number(cumRows[0]?.plays || 0);
    const cumEnd = Number(cumRows[cumRows.length - 1]?.plays || 0);
    renderLineChart(cN, cumRows, bucket, {
      showArea: true,
      stats: [
        { label: 'Stand', value: `${formatPlays(cumEnd)} Einsätze` },
        { label: 'Zuwachs', value: `+${formatPlays(Math.max(0, cumEnd - cumStart))}` },
        { label: 'Punkte', value: formatPlays(cumRows.length) }
      ]
    });
    const raw = Array.isArray(bucketSeries) ? bucketSeries : [];
    const norm = bucket === 'day' ? fillDailySeriesRange(raw, from, to) : raw;
    const total = norm.reduce((s, r) => s + Number(r.plays || 0), 0);
    const avg = norm.length ? total / norm.length : 0;
    const peak = norm.reduce((b, r) => { const p = Number(r.plays || 0); return (!b || p > b.plays) ? { period: r.period, plays: p } : b; }, null);
    renderDailyBarChart(pN, norm, bucket, {
      stats: [
        { label: 'Zeiträume', value: formatPlays(norm.length) },
        { label: bucket === 'day' ? 'Ø Einsätze/Tag' : 'Ø Einsätze/Zeitraum', value: avg.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) },
        { label: 'Spitze', value: peak ? `${formatSeriesPeriod(peak.period, bucket, true)} (${formatPlays(peak.plays)})` : '-' }
      ]
    });
    renderBarChart(sN, Array.isArray(stationsByPlays) ? stationsByPlays : []);
  }, [bucket, bucketSeries, cumulativeSeries, from, selectedTrack, stationsByPlays, to]);

  React.useEffect(() => { const n = perDayRef.current; if (!n) return; renderBarChart(n, perDayStationRows); }, [perDayStationRows]);
  React.useEffect(() => { renderMainCharts(); }, [renderMainCharts]);
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const nodes = [cumulativeRef.current, periodRef.current, stationBarRef.current, perDayRef.current].filter(Boolean);
    const obs = new ResizeObserver(() => window.requestAnimationFrame(renderMainCharts));
    nodes.forEach((n) => obs.observe(n));
    return () => obs.disconnect();
  }, [renderMainCharts]);

  if (!selectedTrack) return React.createElement(Chakra.Text, { color: ui.textMuted }, 'Kein Track ausgewählt.');

  return React.createElement(Chakra.VStack, { align: 'stretch', spacing: '4' },
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted, mb: '2' }, 'Gesamt-Plays (kumuliert)'),
      React.createElement('div', { className: 'legacy-chart', ref: cumulativeRef })
    ),
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted, mb: '2' }, 'Plays pro Zeitraum'),
      React.createElement('div', { className: 'legacy-chart', ref: periodRef })
    ),
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted, mb: '2' }, 'Plays je Sender'),
      React.createElement('div', { className: 'legacy-chart legacy-chart-tall', ref: stationBarRef })
    ),
    React.createElement(Chakra.Box, null,
      React.createElement(Chakra.HStack, { justify: 'space-between', align: 'center', mb: '2' },
        React.createElement(Chakra.Text, { fontSize: 'sm', color: ui.textMuted }, 'Plays je Sender pro Tag'),
        React.createElement(Chakra.Select, { size: 'sm', w: '160px', value: selectedPeriod, onChange: (e) => setSelectedPeriod(e.target.value) },
          ...availablePeriods.map((p) => React.createElement('option', { key: p, value: p }, dayLabel(p)))
        )
      ),
      React.createElement('div', { className: 'legacy-chart legacy-chart-tall', ref: perDayRef })
    )
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DashboardApp — Track list only ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function DashboardApp() {
  const ui = useUiColors();
  const toast = Chakra.useToast();

  const [search, setSearch] = React.useState('');
  const [stationId, setStationId] = React.useState('');
  const [trackLimit, setTrackLimit] = React.useState('250');
  const [sortMode, setSortMode] = React.useState('plays_per_day_desc');
  const [stations, setStations] = React.useState([]);
  const [tracks, setTracks] = React.useState([]);
  const [loadingTracks, setLoadingTracks] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const [winnerTrackKey, setWinnerTrackKey] = React.useState('');
  const [loserTrackKey, setLoserTrackKey] = React.useState('');
  const [mergeState, setMergeState] = React.useState('');

  const debouncedSearch = useDebouncedValue(search, 250);
  const sortedTracks = React.useMemo(() => sortTracks(tracks, sortMode), [tracks, sortMode]);

  const trackSummary = React.useMemo(() => {
    const totalPlays = tracks.reduce((s, r) => s + Number(r.total_plays || 0), 0);
    const uniqueArtists = new Set(tracks.map((r) => String(r.artist || '').toLowerCase()).filter(Boolean)).size;
    return { tracks: tracks.length, plays: totalPlays, artists: uniqueArtists };
  }, [tracks]);

  const loadStations = React.useCallback(async () => {
    const rows = await apiFetch('/api/stations');
    setStations(Array.isArray(rows) ? rows : []);
  }, []);

  const loadTracks = React.useCallback(async () => {
    setLoadingTracks(true);
    setErrorText('');
    try {
      const params = new URLSearchParams({ q: debouncedSearch, stationId, limit: trackLimit });
      if (!stationId) params.delete('stationId');
      if (!debouncedSearch) params.delete('q');
      if (trackLimit === 'all') params.delete('limit');
      const rows = await apiFetch(`/api/tracks?${params}`);
      setTracks(Array.isArray(rows) ? rows : []);
    } catch (error) {
      setTracks([]);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTracks(false);
    }
  }, [debouncedSearch, stationId, trackLimit]);

  const runMerge = async () => {
    if (!winnerTrackKey.trim() || !loserTrackKey.trim()) {
      setMergeState('Bitte beide Track Keys ausfüllen.');
      return;
    }
    try {
      const result = await apiFetch('/api/admin/merge-tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winnerTrackKey: winnerTrackKey.trim(), loserTrackKey: loserTrackKey.trim() })
      });
      setMergeState(`Merge abgeschlossen: ${formatNumber(result?.updatedPlays || 0)} Plays aktualisiert.`);
      toast({ status: 'success', title: 'Merge abgeschlossen' });
      setWinnerTrackKey('');
      setLoserTrackKey('');
      await loadTracks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setMergeState(`Merge fehlgeschlagen: ${msg}`);
      toast({ status: 'error', title: 'Merge fehlgeschlagen', description: msg });
    }
  };

  React.useEffect(() => { loadStations().catch(() => {}); }, [loadStations]);
  React.useEffect(() => { loadTracks(); }, [loadTracks]);

  return React.createElement(
    AppShell,
    {
      activeKey: 'dashboard',
      title: 'Dashboard',
      subtitle: 'Track-Katalog',
      controls: React.createElement(Chakra.Button, { size: 'sm', leftIcon: React.createElement(Icons.RepeatIcon), onClick: () => loadTracks(), isLoading: loadingTracks, colorScheme: 'blue' }, 'Neu laden')
    },
    React.createElement(Chakra.VStack, { align: 'stretch', spacing: '5' },

      // Error
      errorText ? React.createElement(Chakra.Alert, { status: 'error', borderRadius: '14px' },
        React.createElement(Chakra.AlertIcon),
        React.createElement(Chakra.Text, null, errorText)
      ) : null,

      // Filter
      React.createElement(PanelCard, { title: 'Filter' },
        React.createElement(Chakra.SimpleGrid, { columns: { base: 1, md: 2, xl: 5 }, spacing: '3' },
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, null, 'Suche'),
            React.createElement(Chakra.Input, { placeholder: 'Interpret oder Titel', value: search, onChange: (e) => setSearch(e.target.value) })
          ),
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, null, 'Sender'),
            React.createElement(Chakra.Select, { value: stationId, onChange: (e) => setStationId(e.target.value) },
              React.createElement('option', { value: '' }, 'Alle Sender'),
              ...stations.map((s) => React.createElement('option', { key: s.id, value: s.id }, s.name || s.id))
            )
          ),
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, null, 'Limit'),
            React.createElement(Chakra.Select, { value: trackLimit, onChange: (e) => setTrackLimit(e.target.value) },
              ...['100', '250', '500', '1000', 'all'].map((v) => React.createElement('option', { key: v, value: v }, v === 'all' ? 'Alle' : v))
            )
          ),
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, null, 'Sortierung'),
            React.createElement(Chakra.Select, { value: sortMode, onChange: (e) => setSortMode(e.target.value) },
              ...SORT_OPTIONS.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))
            )
          ),
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, { visibility: 'hidden' }, 'Laden'),
            React.createElement(Chakra.Button, { colorScheme: 'blue', onClick: () => loadTracks(), isLoading: loadingTracks, w: '100%' }, 'Laden')
          )
        )
      ),

      // Stats
      React.createElement(Chakra.SimpleGrid, { columns: { base: 2, lg: 3 }, spacing: '3' },
        React.createElement(StatCard, { label: 'Gefundene Titel', value: formatNumber(trackSummary.tracks) }),
        React.createElement(StatCard, { label: 'Einsätze gesamt', value: formatNumber(trackSummary.plays) }),
        React.createElement(StatCard, { label: 'Künstler', value: formatNumber(trackSummary.artists) })
      ),

      // Track list
      React.createElement(PanelCard, { title: 'Track-Liste', subtitle: loadingTracks ? 'Lade...' : `${formatNumber(sortedTracks.length)} geladen`, p: '0' },
        React.createElement(Chakra.TableContainer, { className: 'horizon-scroll' },
          React.createElement(Chakra.Table, { size: 'sm' },
            React.createElement(Chakra.Thead, { position: 'sticky', top: '0', bg: 'cardBg', zIndex: '1' },
              React.createElement(Chakra.Tr, null,
                React.createElement(Chakra.Th, { py: '3' }, 'Track'),
                React.createElement(Chakra.Th, { py: '3', isNumeric: true }, 'Plays'),
                React.createElement(Chakra.Th, { py: '3', isNumeric: true }, 'P/Tag'),
                React.createElement(Chakra.Th, { py: '3' }, 'Letztes Play'),
                React.createElement(Chakra.Th, { py: '3' }, 'Winner'),
                React.createElement(Chakra.Th, { py: '3' }, 'Loser'),
                React.createElement(Chakra.Th, { py: '3' }, '')
              )
            ),
            React.createElement(Chakra.Tbody, null,
              ...sortedTracks.map((row) => React.createElement(
                Chakra.Tr, { key: row.track_key, _hover: { bg: ui.subtleBg } },
                React.createElement(Chakra.Td, { py: '2' },
                  React.createElement(Chakra.Text, { fontWeight: '700', fontSize: 'sm', color: ui.textPrimary }, row.artist),
                  React.createElement(Chakra.Text, { fontSize: 'xs', color: ui.textMuted }, row.title)
                ),
                React.createElement(Chakra.Td, { py: '2', isNumeric: true, fontSize: 'sm' }, formatNumber(row.total_plays)),
                React.createElement(Chakra.Td, { py: '2', isNumeric: true, fontSize: 'sm' }, Number(row.plays_per_day || 0).toLocaleString('de-DE', { maximumFractionDigits: 1 })),
                React.createElement(Chakra.Td, { py: '2', fontSize: 'xs', color: ui.textMuted }, formatDateTime(row.last_played_at_utc)),
                React.createElement(Chakra.Td, { py: '2' },
                  React.createElement(Chakra.Button, {
                    size: 'xs', variant: winnerTrackKey === row.track_key ? 'solid' : 'outline',
                    colorScheme: winnerTrackKey === row.track_key ? 'green' : 'gray',
                    onClick: () => setWinnerTrackKey(winnerTrackKey === row.track_key ? '' : row.track_key)
                  }, 'W')
                ),
                React.createElement(Chakra.Td, { py: '2' },
                  React.createElement(Chakra.Button, {
                    size: 'xs', variant: loserTrackKey === row.track_key ? 'solid' : 'outline',
                    colorScheme: loserTrackKey === row.track_key ? 'red' : 'gray',
                    onClick: () => setLoserTrackKey(loserTrackKey === row.track_key ? '' : row.track_key)
                  }, 'L')
                ),
                React.createElement(Chakra.Td, { py: '2' },
                  React.createElement(Chakra.Button, {
                    size: 'xs', colorScheme: 'blue', variant: 'ghost',
                    rightIcon: React.createElement(Icons.ExternalLinkIcon),
                    onClick: () => openTrackPage(row.track_key)
                  }, 'Öffnen')
                )
              )),
              sortedTracks.length === 0 && !loadingTracks
                ? React.createElement(Chakra.Tr, null, React.createElement(Chakra.Td, { colSpan: 7, color: ui.textMuted, py: '6', textAlign: 'center' }, 'Keine Treffer. Filter anpassen.'))
                : null
            )
          )
        )
      ),

      // Admin Merge
      React.createElement(PanelCard, { title: 'Admin: Track-Merge' },
        React.createElement(Chakra.SimpleGrid, { columns: { base: 1, md: 3 }, spacing: '3', alignItems: 'end' },
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, null, 'Winner Track Key'),
            React.createElement(Chakra.Input, { value: winnerTrackKey, onChange: (e) => setWinnerTrackKey(e.target.value), placeholder: 'winner-key', fontFamily: 'mono', fontSize: 'sm' })
          ),
          React.createElement(Chakra.FormControl, null,
            React.createElement(Chakra.FormLabel, null, 'Loser Track Key'),
            React.createElement(Chakra.Input, { value: loserTrackKey, onChange: (e) => setLoserTrackKey(e.target.value), placeholder: 'loser-key', fontFamily: 'mono', fontSize: 'sm' })
          ),
          React.createElement(Chakra.Button, { colorScheme: 'red', variant: 'outline', onClick: runMerge, isDisabled: !winnerTrackKey || !loserTrackKey }, 'Merge ausführen')
        ),
        mergeState ? React.createElement(Chakra.Text, { mt: '3', fontSize: 'sm', color: ui.textMuted }, mergeState) : null,
        React.createElement(Chakra.Text, { mt: '2', fontSize: 'xs', color: ui.textMuted }, 'Tipp: W/L-Buttons in der Tabelle klicken um Keys zu übernehmen.')
      )
    )
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── TrackDetailApp — Song page ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function TrackDetailApp({ trackKey }) {
  const ui = useUiColors();

  const defaultTo = berlinYesterdayIsoDate();
  const defaultFrom = shiftBerlinIsoDate(defaultTo, -29);
  const [from, setFrom] = React.useState(defaultFrom);
  const [to, setTo] = React.useState(defaultTo);
  const [bucket, setBucket] = React.useState('day');
  const [includeToday, setIncludeToday] = React.useState(false);

  const [track, setTrack] = React.useState(null);
  const [totals, setTotals] = React.useState(null);
  const [trend, setTrend] = React.useState(null);
  const [seriesByStation, setSeriesByStation] = React.useState(null);
  const [stationsByPlays, setStationsByPlays] = React.useState([]);
  const [cumulativeSeries, setCumulativeSeries] = React.useState([]);
  const [activeSenderSeries, setActiveSenderSeries] = React.useState([]);
  const [bucketSeries, setBucketSeries] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [errorText, setErrorText] = React.useState('');

  const effectiveTo = includeToday ? berlinTodayIsoDate() : to;
  const matrix = React.useMemo(() => buildDayStationMatrix(seriesByStation), [seriesByStation]);
  const dailyTrendRows = React.useMemo(() => buildDailyTrackTrendRows(seriesByStation, activeSenderSeries), [seriesByStation, activeSenderSeries]);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setErrorText('');
    try {
      const detailParams = new URLSearchParams({ from, to: effectiveTo });
      const stationParams = new URLSearchParams({ from, to: effectiveTo, bucket: 'day', limit: '12' });
      const stationsByPlaysParams = new URLSearchParams({ from, to: effectiveTo });
      const bucketParams = new URLSearchParams({ from, to: effectiveTo, bucket });
      const cumulativeParams = new URLSearchParams({ from: '2000-01-01', to: effectiveTo, bucket });
      const panelParams = new URLSearchParams({ from, to: effectiveTo, minPlays: '50' });

      const [trackRes, totalsRes, trendRes, stationRes, stationsByPlaysRes, bucketRes, cumulativeRes, panelRes] = await Promise.all([
        apiFetch(`/api/tracks?${new URLSearchParams({ includeTrackKey: trackKey, limit: '1' })}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/totals?${detailParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/trend`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series-by-station?${stationParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/stations?${stationsByPlaysParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${bucketParams}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${cumulativeParams}`),
        apiFetch(`/api/panel/active-senders?${panelParams}`)
      ]);

      const trackRow = Array.isArray(trackRes) ? trackRes.find((r) => r.track_key === trackKey) || trackRes[0] : null;
      setTrack(trackRow || null);
      setTotals(totalsRes || null);
      setTrend(trendRes || null);
      setSeriesByStation(stationRes || null);
      setStationsByPlays(Array.isArray(stationsByPlaysRes?.stations) ? stationsByPlaysRes.stations : []);
      setCumulativeSeries(Array.isArray(cumulativeRes?.series) ? cumulativeRes.series : []);
      setActiveSenderSeries(Array.isArray(panelRes?.series) ? panelRes.series : []);
      setBucketSeries(Array.isArray(bucketRes?.series) ? bucketRes.series : []);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [trackKey, from, effectiveTo, bucket]);

  React.useEffect(() => { loadData(); }, [loadData]);

  const applyQuickRange = (rangeKey) => {
    const end = includeToday ? berlinTodayIsoDate() : berlinYesterdayIsoDate();
    let start = end;
    if (rangeKey === '7') start = shiftBerlinIsoDate(end, -6);
    if (rangeKey === '30') start = shiftBerlinIsoDate(end, -29);
    if (rangeKey === '90') start = shiftBerlinIsoDate(end, -89);
    if (rangeKey === 'ytd') start = `${Number(end.slice(0, 4))}-01-01`;
    setFrom(start);
    setTo(end);
  };

  const trackTitle = track ? `${track.artist} – ${track.title}` : trackKey;
  const maxTrackPlays = Number(track?.total_plays || 0);

  return React.createElement(
    AppShell,
    {
      activeKey: 'dashboard',
      title: trackTitle,
      subtitle: track ? `Track-Detail · ${from} bis ${effectiveTo}` : 'Lade...',
      controls: React.createElement(Chakra.HStack, { spacing: '2' },
        React.createElement(Chakra.Button, { size: 'sm', variant: 'ghost', leftIcon: React.createElement(Icons.ArrowBackIcon), onClick: () => window.history.back() }, 'Zurück'),
        React.createElement(Chakra.Button, { size: 'sm', leftIcon: React.createElement(Icons.RepeatIcon), onClick: () => loadData(), isLoading: loading, colorScheme: 'blue' }, 'Aktualisieren')
      )
    },
    React.createElement(Chakra.VStack, { align: 'stretch', spacing: '5' },

      // Error
      errorText ? React.createElement(Chakra.Alert, { status: 'error', borderRadius: '14px' },
        React.createElement(Chakra.AlertIcon),
        React.createElement(Chakra.Text, null, errorText)
      ) : null,

      // Date controls
      React.createElement(PanelCard, { title: 'Zeitraum' },
        React.createElement(Chakra.Wrap, { spacing: '3', align: 'end' },
          React.createElement(Chakra.FormControl, { w: 'auto', minW: '120px' },
            React.createElement(Chakra.FormLabel, { fontSize: 'sm' }, 'Aggregation'),
            React.createElement(Chakra.Select, { size: 'sm', value: bucket, onChange: (e) => setBucket(e.target.value) },
              React.createElement('option', { value: 'day' }, 'Tag'),
              React.createElement('option', { value: 'week' }, 'Woche'),
              React.createElement('option', { value: 'month' }, 'Monat'),
              React.createElement('option', { value: 'year' }, 'Jahr')
            )
          ),
          React.createElement(Chakra.FormControl, { w: 'auto' },
            React.createElement(Chakra.FormLabel, { fontSize: 'sm' }, 'Von'),
            React.createElement(Chakra.Input, { size: 'sm', type: 'date', value: from, onChange: (e) => setFrom(e.target.value) })
          ),
          React.createElement(Chakra.FormControl, { w: 'auto' },
            React.createElement(Chakra.FormLabel, { fontSize: 'sm' }, 'Bis'),
            React.createElement(Chakra.Input, { size: 'sm', type: 'date', value: to, onChange: (e) => setTo(e.target.value) })
          ),
          ...['7', '30', '90', 'ytd'].map((r) =>
            React.createElement(Chakra.Button, { key: r, size: 'sm', variant: 'outline', onClick: () => applyQuickRange(r) }, r === 'ytd' ? 'YTD' : `${r}d`)
          ),
          React.createElement(Chakra.Checkbox, { isChecked: includeToday, onChange: (e) => setIncludeToday(e.target.checked), fontSize: 'sm' }, 'Heute'),
          React.createElement(Chakra.Button, { colorScheme: 'blue', size: 'sm', onClick: () => loadData(), isLoading: loading }, 'Aktualisieren')
        )
      ),

      // Song-Performance
      React.createElement(PanelCard, { title: 'Song-Performance' },
        React.createElement(SongPerformanceCard, { selectedTrack: track, trend, totals, matrix, maxTrackPlays, from, to: effectiveTo })
      ),

      // Statistiken
      React.createElement(PanelCard, { title: 'Statistikansichten', subtitle: 'Kumuliert · Zeitraum · Plays je Sender · Plays je Sender pro Tag' },
        React.createElement(LegacyStatsCharts, { selectedTrack: track, from, to: effectiveTo, bucket, cumulativeSeries, bucketSeries, stationsByPlays, seriesByStation })
      ),

      // Trend
      React.createElement(PanelCard, { title: 'Trend Rohsumme vs. panelbereinigt', subtitle: 'Roh = absolute Plays · Bereinigt = Plays pro aktivem Sender je Tag' },
        React.createElement(Chakra.Tabs, { variant: 'soft-rounded', colorScheme: 'blue', size: 'sm' },
          React.createElement(Chakra.TabList, null,
            React.createElement(Chakra.Tab, null, 'Rohsumme'),
            React.createElement(Chakra.Tab, null, 'Panelbereinigt')
          ),
          React.createElement(Chakra.TabPanels, null,
            React.createElement(Chakra.TabPanel, { px: '0', pb: '0' }, React.createElement(TrackTrendLineChart, { rows: dailyTrendRows, mode: 'raw' })),
            React.createElement(Chakra.TabPanel, { px: '0', pb: '0' }, React.createElement(TrackTrendLineChart, { rows: dailyTrendRows, mode: 'normalized' }))
          )
        )
      )
    )
  );
}

// ── Root — router ─────────────────────────────────────────────────────────────

function Root() {
  const trackKey = new URLSearchParams(window.location.search).get('trackKey');
  return React.createElement(
    Chakra.ChakraProvider, { theme: horizonTheme },
    trackKey
      ? React.createElement(TrackDetailApp, { trackKey })
      : React.createElement(DashboardApp)
  );
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
