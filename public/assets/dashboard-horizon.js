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
import { renderLineChart, renderSeriesByStationChart } from './charts.line.js';
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
  useDebouncedValue,
  AppShell,
  PanelCard,
  useUiColors
} from './horizon-lib.js';

const EXTRA_CHARTS_ENABLED = new URLSearchParams(window.location.search).get('extraCharts') === '1';

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

const CHART_COLOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#f97316',
  '#0ea5e9'
];

function toFixedLocale(value, digits = 2) {
  const num = Number(value || 0);
  return num.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function buildDailyTrackTrendRows(seriesByStation, panelActiveSeries) {
  const stationRows = Array.isArray(seriesByStation?.stations) ? seriesByStation.stations : [];
  const panelRows = Array.isArray(panelActiveSeries) ? panelActiveSeries : [];
  const allPeriods = new Set();

  stationRows.forEach((station) => {
    (station.series || []).forEach((row) => {
      if (row?.period) allPeriods.add(row.period);
    });
  });
  panelRows.forEach((row) => {
    if (row?.period) allPeriods.add(row.period);
  });

  const periods = Array.from(allPeriods).sort((a, b) => a.localeCompare(b));
  const activeByPeriod = new Map(panelRows.map((row) => [row.period, Number(row.active_senders || 0)]));

  return periods.map((period) => {
    let rawPlays = 0;
    stationRows.forEach((station) => {
      const point = (station.series || []).find((row) => row.period === period);
      rawPlays += Number(point?.plays || 0);
    });
    const activeSenders = Number(activeByPeriod.get(period) || 0);
    const normalizedPlays = activeSenders > 0 ? rawPlays / activeSenders : 0;
    return {
      period,
      rawPlays,
      activeSenders,
      normalizedPlays
    };
  });
}

function pickTopStationIds(stations, limit = 5) {
  return (Array.isArray(stations) ? stations : [])
    .slice(0, Math.max(1, limit))
    .map((row) => row.stationId)
    .filter(Boolean);
}

function buildDayStationMatrix(seriesByStation) {
  const periods = Array.isArray(seriesByStation?.periods) ? [...seriesByStation.periods].sort() : [];
  const stations = Array.isArray(seriesByStation?.stations) ? [...seriesByStation.stations] : [];
  const topStations = stations
    .sort((a, b) => Number(b.totalPlays || 0) - Number(a.totalPlays || 0))
    .slice(0, 8);

  const byPeriod = new Map(periods.map((period) => [
    period,
    {
      period,
      total: 0,
      activeStations: 0,
      byStation: topStations.map((station) => ({
        stationId: station.stationId,
        stationName: station.stationName,
        plays: 0
      }))
    }
  ]));

  topStations.forEach((station, stationIndex) => {
    (station.series || []).forEach((row) => {
      const bucket = byPeriod.get(row.period);
      if (!bucket) return;
      const plays = Number(row.plays || 0);
      bucket.byStation[stationIndex].plays = plays;
      bucket.total += plays;
      if (plays > 0) bucket.activeStations += 1;
    });
  });

  const allRows = Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
  const rows = allRows.slice(-21).sort((a, b) => b.period.localeCompare(a.period));
  const maxValue = rows.reduce((max, row) => {
    row.byStation.forEach((s) => {
      if (s.plays > max) max = s.plays;
    });
    return max;
  }, 0);

  const stationTotals = topStations.map((station) => {
    const total = rows.reduce((sum, row) => {
      const found = row.byStation.find((item) => item.stationId === station.stationId);
      return sum + Number(found?.plays || 0);
    }, 0);
    return {
      stationId: station.stationId,
      stationName: station.stationName,
      total
    };
  }).sort((a, b) => b.total - a.total);

  return {
    rows,
    stations: topStations,
    maxValue: Math.max(1, maxValue),
    stationTotals
  };
}

function computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays }) {
  if (!selectedTrack) {
    return {
      score: 0,
      label: 'Kein Track',
      popularityPct: 0,
      momentumPct: 0,
      spreadPct: 0,
      dailyStrengthPct: 0
    };
  }

  const popularityPct = clamp((Number(selectedTrack.total_plays || 0) / Math.max(1, Number(maxTrackPlays || 1))) * 100, 0, 100);
  const growth = Number(trend?.growth_percent || 0);
  const momentumPct = clamp((growth + 100) / 2, 0, 100);

  const activeStations = matrix.stationTotals.filter((row) => row.total > 0).length;
  const spreadPct = clamp((activeStations / Math.max(1, matrix.stations.length || 1)) * 100, 0, 100);

  const avgPerDay = Number(totals?.totals?.allTime || 0) / Math.max(1, rangeDays);
  const dailyStrengthPct = clamp((avgPerDay / 8) * 100, 0, 100);

  const score = Math.round(
    popularityPct * 0.4 +
    momentumPct * 0.3 +
    spreadPct * 0.2 +
    dailyStrengthPct * 0.1
  );

  let label = 'Schwach';
  if (score >= 75) label = 'Sehr stark';
  else if (score >= 55) label = 'Gut';
  else if (score >= 35) label = 'Mittel';

  return {
    score,
    label,
    popularityPct,
    momentumPct,
    spreadPct,
    dailyStrengthPct
  };
}

function SongPerformanceCard({ selectedTrack, trend, totals, matrix, maxTrackPlays, from, to }) {
  const ui = useUiColors();
  if (!selectedTrack) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Bitte zuerst einen Track auswählen.<//>`;
  }

  const rangeDays = dayCount(from, to);
  const score = computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays });

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.HStack} justify="space-between">
        <${Chakra.HStack} spacing="4" align="end">
          <${Chakra.Text} fontSize="5xl" lineHeight="1" fontWeight="800" color=${ui.textPrimary}>${score.score}<//>
          <${Chakra.Text} fontSize="md" color=${ui.textMuted} pb="2">/ 100<//>
        <//>
        <${Chakra.Badge} colorScheme=${score.score >= 55 ? 'green' : score.score >= 35 ? 'orange' : 'red'} px="3" py="1" borderRadius="999px">
          ${score.label}
        <//>
      <//>

      <${Chakra.Progress} value=${score.score} colorScheme="blue" borderRadius="999px" size="md" />

      <${Chakra.HStack} spacing="3" flexWrap="wrap">
        <${Chakra.Tag} colorScheme="gray" borderRadius="999px">Release: ${fmtDateOnly(selectedTrack.release_date_utc)}<//>
        <${PreviewControl} previewUrl=${selectedTrack.preview_url} externalUrl=${selectedTrack.external_url} />
      <//>

      <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="3">
        <${MetricLine} label="Beliebtheit im Panel" value=${score.popularityPct.toFixed(0)} colorScheme="blue" />
        <${MetricLine} label="Momentum" value=${score.momentumPct.toFixed(0)} colorScheme="green" />
        <${MetricLine} label="Sender-Breite" value=${score.spreadPct.toFixed(0)} colorScheme="purple" />
        <${MetricLine} label="Durchschnitt Plays/Tag" value=${score.dailyStrengthPct.toFixed(0)} colorScheme="orange" />
      <//>

      <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="2">
        <${MiniKpi} label="Plays gesamt" value=${formatNumber(totals?.totals?.allTime || 0)} />
        <${MiniKpi} label="Heute" value=${formatNumber(totals?.totals?.today || 0)} />
        <${MiniKpi} label="Woche" value=${formatNumber(totals?.totals?.thisWeek || 0)} />
        <${MiniKpi} label="Trend 48h" value=${formatNumber(trend?.plays_last_48h || 0)} />
      <//>
    <//>
  `;
}

function MetricLine({ label, value, colorScheme }) {
  const ui = useUiColors();
  return html`
    <${Chakra.Box}>
      <${Chakra.HStack} justify="space-between" mb="1">
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${label}<//>
        <${Chakra.Text} fontSize="sm" fontWeight="700" color=${ui.textPrimary}>${value}%<//>
      <//>
      <${Chakra.Progress} value=${Number(value || 0)} colorScheme=${colorScheme} size="sm" borderRadius="999px" />
    <//>
  `;
}

function MiniKpi({ label, value }) {
  const ui = useUiColors();
  return html`
    <${Chakra.Box} border="1px solid" borderColor=${ui.lineColor} borderRadius="12px" px="3" py="2">
      <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${label}<//>
      <${Chakra.Text} fontSize="lg" fontWeight="700" color=${ui.textPrimary}>${value}<//>
    <//>
  `;
}

function PreviewControl({ previewUrl, externalUrl, compact = false }) {
  if (previewUrl) {
    return html`
      <${Chakra.HStack} spacing="2" align="center">
        <audio controls preload="none" src=${previewUrl} style=${{ height: '30px', width: compact ? '180px' : '220px' }} />
        ${externalUrl
          ? html`<${Chakra.Link} href=${externalUrl} target="_blank" rel="noreferrer" color="teal.500">iTunes<//>`
          : null}
      <//>
    `;
  }

  if (externalUrl) {
    return html`<${Chakra.Link} href=${externalUrl} target="_blank" rel="noreferrer" color="teal.500">Titelseite<//>`;
  }

  return html`<${Chakra.Tag} colorScheme="orange" borderRadius="999px">Kein Preview<//>`;
}

function SenderDayHeatmap({ matrix }) {
  const ui = useUiColors();
  const cellText = Chakra.useColorModeValue('#1f3154', '#e2e8f0');
  const cellBorder = Chakra.useColorModeValue('rgba(17, 31, 54, 0.06)', 'rgba(226, 232, 240, 0.18)');
  if (!matrix?.rows?.length) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Keine Tagesdaten im gewählten Zeitraum.<//>`;
  }

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.TableContainer}
        border="1px solid"
        borderColor=${ui.lineColor}
        borderRadius="14px"
        maxH="420px"
        overflowY="auto"
        className="horizon-scroll"
      >
        <${Chakra.Table} size="sm" variant="unstyled">
          <${Chakra.Thead} position="sticky" top="0" bg="cardBg" zIndex="1">
            <${Chakra.Tr} borderBottom="1px solid" borderColor=${ui.lineColor}>
              <${Chakra.Th} py="3" color=${ui.textMuted}>Tag<//>
              ${matrix.stations.map((station) => html`
                <${Chakra.Th} key=${station.stationId} py="3" color=${ui.textMuted} textAlign="center">${station.stationName}<//>
              `)}
              <${Chakra.Th} py="3" color=${ui.textMuted} textAlign="center">Gesamt<//>
            <//>
          <//>
          <${Chakra.Tbody}>
            ${matrix.rows.map((row) => html`
              <${Chakra.Tr} key=${row.period} borderBottom="1px solid" borderColor=${ui.lineColor}>
                <${Chakra.Td} py="2" fontWeight="600" color=${ui.textPrimary}>${dayLabel(row.period)}<//>
                ${row.byStation.map((stationRow) => {
                  const value = Number(stationRow.plays || 0);
                  const ratio = value / matrix.maxValue;
                  const alpha = value > 0 ? 0.10 + (0.55 * ratio) : 0.02;
                  const bg = `rgba(54, 127, 245, ${alpha.toFixed(3)})`;
                  const fg = ratio > 0.55 ? 'white' : cellText;
                  return html`
                    <${Chakra.Td} key=${`${row.period}-${stationRow.stationId}`} py="2" textAlign="center">
                      <${Chakra.Box}
                        mx="auto"
                        maxW="64px"
                        borderRadius="10px"
                        bg=${bg}
                        color=${fg}
                        fontWeight="700"
                        fontSize="sm"
                        py="1"
                        border="1px solid"
                        borderColor=${cellBorder}
                      >
                        ${formatNumber(value)}
                      <//>
                    <//>
                  `;
                })}
                <${Chakra.Td} py="2" textAlign="center" fontWeight="700" color=${ui.textPrimary}>${formatNumber(row.total)}<//>
              <//>
            `)}
          <//>
        <//>
      <//>

      <${Chakra.Box}>
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted} mb="2">Senderanteil im Zeitraum<//>
        <${Chakra.VStack} align="stretch" spacing="2">
          ${matrix.stationTotals.map((row) => {
            const maxTotal = Math.max(1, matrix.stationTotals[0]?.total || 1);
            const pct = Math.round((row.total / maxTotal) * 100);
            return html`
              <${Chakra.Box} key=${row.stationId}>
                <${Chakra.HStack} justify="space-between" mb="1">
                  <${Chakra.Text} fontSize="sm" color=${ui.textPrimary}>${row.stationName}<//>
                  <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${formatNumber(row.total)}<//>
                <//>
                <${Chakra.Progress} value=${pct} colorScheme="blue" borderRadius="999px" size="sm" />
              <//>
            `;
          })}
        <//>
      <//>
    <//>
  `;
}

function GroupedDayStationBars({ periods, stations, selectedStationIds }) {
  const ui = useUiColors();
  const selectedStations = (Array.isArray(stations) ? stations : []).filter((row) => selectedStationIds.includes(row.stationId));
  const visiblePeriods = (Array.isArray(periods) ? periods : []).slice(-45);

  if (!visiblePeriods.length || !selectedStations.length) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Keine Balkendaten für die aktuelle Auswahl.<//>`;
  }

  const seriesMap = new Map(selectedStations.map((station) => {
    const map = new Map((station.series || []).map((row) => [row.period, Number(row.plays || 0)]));
    return [station.stationId, map];
  }));

  const values = [];
  visiblePeriods.forEach((period) => {
    selectedStations.forEach((station) => {
      values.push(Number(seriesMap.get(station.stationId)?.get(period) || 0));
    });
  });

  const maxValue = Math.max(1, ...values);
  const width = Math.max(760, visiblePeriods.length * Math.max(28, (selectedStations.length * 11) + 10));
  const height = 320;
  const margin = { top: 20, right: 18, bottom: 54, left: 46 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const groupWidth = plotWidth / visiblePeriods.length;
  const barGap = 2;
  const rawBarWidth = (groupWidth - 6 - ((selectedStations.length - 1) * barGap)) / selectedStations.length;
  const barWidth = Math.max(3, Math.min(16, rawBarWidth));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));
  const xStep = Math.max(1, Math.floor(visiblePeriods.length / 8));

  return html`
    <${Chakra.VStack} align="stretch" spacing="3">
      <${Chakra.Box} overflowX="auto">
        <svg viewBox=${`0 0 ${width} ${height}`} style=${{ width: '100%', minWidth: `${Math.min(width, 1300)}px`, height: 'auto' }}>
          <line x1=${margin.left} y1=${margin.top + plotHeight} x2=${margin.left + plotWidth} y2=${margin.top + plotHeight} stroke=${ui.lineColor} stroke-width="1.2"></line>
          <line x1=${margin.left} y1=${margin.top} x2=${margin.left} y2=${margin.top + plotHeight} stroke=${ui.lineColor} stroke-width="1.2"></line>

          ${yTicks.map((tick) => {
            const y = margin.top + plotHeight - ((tick / maxValue) * plotHeight);
            return html`
              <g key=${`y-${tick}`}>
                <line x1=${margin.left} y1=${y} x2=${margin.left + plotWidth} y2=${y} stroke=${ui.lineColor} stroke-dasharray="4 4" stroke-width="1"></line>
                <text x=${margin.left - 8} y=${y + 4} text-anchor="end" font-size="11" fill=${ui.textMuted}>${formatNumber(tick)}</text>
              </g>
            `;
          })}

          ${visiblePeriods.map((period, periodIndex) => {
            const groupX = margin.left + (periodIndex * groupWidth) + 3;
            const showLabel = periodIndex % xStep === 0 || periodIndex === visiblePeriods.length - 1;
            return html`
              <g key=${`group-${period}`}>
                ${selectedStations.map((station, stationIndex) => {
                  const value = Number(seriesMap.get(station.stationId)?.get(period) || 0);
                  const barHeight = value > 0 ? (value / maxValue) * plotHeight : 0;
                  const x = groupX + (stationIndex * (barWidth + barGap));
                  const y = margin.top + plotHeight - barHeight;
                  const fill = CHART_COLOR_PALETTE[stationIndex % CHART_COLOR_PALETTE.length];
                  return html`
                    <rect
                      key=${`${period}-${station.stationId}`}
                      x=${x}
                      y=${y}
                      width=${barWidth}
                      height=${Math.max(0, barHeight)}
                      fill=${fill}
                      rx="2"
                      ry="2"
                    >
                      <title>${`${station.stationName} | ${dayLabel(period)} | ${formatNumber(value)} Plays`}</title>
                    </rect>
                  `;
                })}
                ${showLabel
                  ? html`<text x=${groupX + ((selectedStations.length * (barWidth + barGap)) / 2)} y=${margin.top + plotHeight + 16} text-anchor="middle" font-size="10" fill=${ui.textMuted}>${dayLabel(period)}</text>`
                  : null}
              </g>
            `;
          })}

          <text x=${margin.left + (plotWidth / 2)} y=${height - 8} text-anchor="middle" font-size="11" fill=${ui.textMuted}>Tag</text>
          <text x="14" y=${margin.top + (plotHeight / 2)} transform=${`rotate(-90 14 ${margin.top + (plotHeight / 2)})`} text-anchor="middle" font-size="11" fill=${ui.textMuted}>Plays</text>
        </svg>
      <//>

      <${Chakra.Wrap} spacing="2">
        ${selectedStations.map((station, index) => html`
          <${Chakra.Tag} key=${station.stationId} size="sm" borderRadius="999px" variant="subtle">
            <${Chakra.TagLeftIcon} boxSize="10px" color=${CHART_COLOR_PALETTE[index % CHART_COLOR_PALETTE.length]} as=${Icons.StarIcon} />
            <${Chakra.TagLabel}>${station.stationName}<//>
          <//>
        `)}
      <//>
    <//>
  `;
}

function TrackTrendLineChart({ rows, mode = 'raw' }) {
  const ui = useUiColors();
  const points = Array.isArray(rows) ? rows : [];
  if (!points.length) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Keine Trenddaten im gewählten Zeitraum.<//>`;
  }

  const axisColor = 'var(--chart-axis)';
  const gridColor = 'var(--chart-grid)';
  const textColor = 'var(--chart-text)';
  const values = points.map((row) => (mode === 'normalized' ? Number(row.normalizedPlays || 0) : Number(row.rawPlays || 0)));
  const maxValue = Math.max(1, ...values);
  const width = Math.max(760, points.length * 30);
  const height = 260;
  const margin = { top: 16, right: 16, bottom: 44, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;
  const xStep = Math.max(1, Math.floor(points.length / 8));

  const path = points.map((row, index) => {
    const value = mode === 'normalized' ? Number(row.normalizedPlays || 0) : Number(row.rawPlays || 0);
    const x = margin.left + (index * stepX);
    const y = margin.top + plotHeight - ((value / maxValue) * plotHeight);
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => maxValue * ratio);
  const lineColor = mode === 'normalized' ? 'var(--chart-series-secondary)' : 'var(--chart-series-primary)';

  return html`
    <${Chakra.VStack} align="stretch" spacing="2">
      <${Chakra.Box} overflowX="auto">
        <svg viewBox=${`0 0 ${width} ${height}`} style=${{ width: '100%', minWidth: `${Math.min(width, 1300)}px`, height: 'auto' }}>
          <line x1=${margin.left} y1=${margin.top + plotHeight} x2=${margin.left + plotWidth} y2=${margin.top + plotHeight} stroke=${axisColor} stroke-width="1.2"></line>
          <line x1=${margin.left} y1=${margin.top} x2=${margin.left} y2=${margin.top + plotHeight} stroke=${axisColor} stroke-width="1.2"></line>

          ${yTicks.map((tick, index) => {
            const y = margin.top + plotHeight - ((tick / maxValue) * plotHeight);
            const label = mode === 'normalized' ? toFixedLocale(tick, 2) : formatNumber(Math.round(tick));
            return html`
              <g key=${`trend-y-${index}`}>
                <line x1=${margin.left} y1=${y} x2=${margin.left + plotWidth} y2=${y} stroke=${gridColor} stroke-dasharray="4 4" stroke-width="1"></line>
                <text x=${margin.left - 8} y=${y + 4} text-anchor="end" font-size="11" fill=${textColor}>${label}</text>
              </g>
            `;
          })}

          <path d=${path} fill="none" stroke=${lineColor} stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>
          ${points.map((row, index) => {
            const value = mode === 'normalized' ? Number(row.normalizedPlays || 0) : Number(row.rawPlays || 0);
            const x = margin.left + (index * stepX);
            const y = margin.top + plotHeight - ((value / maxValue) * plotHeight);
            const showLabel = index % xStep === 0 || index === points.length - 1;
            return html`
              <g key=${`trend-${row.period}`}>
                <circle cx=${x} cy=${y} r="3.4" fill=${lineColor}>
                  <title>${`${dayLabel(row.period)} | Roh: ${formatNumber(row.rawPlays)} | Panel: ${toFixedLocale(row.normalizedPlays, 2)} | Aktive Sender: ${formatNumber(row.activeSenders)}`}</title>
                </circle>
                ${showLabel
                  ? html`<text x=${x} y=${margin.top + plotHeight + 16} text-anchor="middle" font-size="10" fill=${textColor}>${dayLabel(row.period)}</text>`
                  : null}
              </g>
            `;
          })}

          <text x=${margin.left + (plotWidth / 2)} y=${height - 8} text-anchor="middle" font-size="11" fill=${textColor}>Tag</text>
          <text x="14" y=${margin.top + (plotHeight / 2)} transform=${`rotate(-90 14 ${margin.top + (plotHeight / 2)})`} text-anchor="middle" font-size="11" fill=${textColor}>
            ${mode === 'normalized' ? 'Plays je aktivem Sender' : 'Roh-Plays'}
          </text>
        </svg>
      <//>
    <//>
  `;
}

function BucketTrendCompact({ rows }) {
  const ui = useUiColors();
  if (!rows.length) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Keine Bucket-Daten verfügbar.<//>`;
  }
  const visible = rows.slice(-10);
  const max = Math.max(1, ...visible.map((row) => Number(row.plays || 0)));
  return html`
    <${Chakra.VStack} align="stretch" spacing="2">
      ${visible.map((row) => html`
        <${Chakra.Box} key=${row.period}>
          <${Chakra.HStack} justify="space-between" mb="1">
            <${Chakra.Text} fontSize="sm" color=${ui.textPrimary}>${row.period}<//>
            <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${formatNumber(row.plays)}<//>
          <//>
          <${Chakra.Progress} value=${Math.round((Number(row.plays || 0) / max) * 100)} colorScheme="purple" size="sm" borderRadius="999px" />
        <//>
      `)}
    <//>
  `;
}

function LegacyStatsCharts({
  selectedTrack,
  from,
  to,
  bucket,
  cumulativeSeries,
  bucketSeries,
  stationsByPlays,
  stationsSeries
}) {
  const ui = useUiColors();
  const cumulativeRef = React.useRef(null);
  const periodRef = React.useRef(null);
  const stationBarRef = React.useRef(null);
  const stationSeriesRef = React.useRef(null);

  const renderAllCharts = React.useCallback(() => {
    const cumulativeNode = cumulativeRef.current;
    const periodNode = periodRef.current;
    const stationBarNode = stationBarRef.current;
    const stationSeriesNode = stationSeriesRef.current;
    if (!cumulativeNode || !periodNode || !stationBarNode || !stationSeriesNode) return;

    const cumulativeRows = toCumulativeSeries(Array.isArray(cumulativeSeries) ? cumulativeSeries : []);
    const cumulativeStart = Number(cumulativeRows[0]?.plays || 0);
    const cumulativeEnd = Number(cumulativeRows[cumulativeRows.length - 1]?.plays || 0);
    renderLineChart(cumulativeNode, cumulativeRows, bucket, {
      showArea: true,
      stats: [
        { label: 'Stand', value: `${formatPlays(cumulativeEnd)} Einsätze` },
        { label: 'Zuwachs', value: `+${formatPlays(Math.max(0, cumulativeEnd - cumulativeStart))}` },
        { label: 'Punkte', value: formatPlays(cumulativeRows.length) }
      ]
    });

    const rawPeriodRows = Array.isArray(bucketSeries) ? bucketSeries : [];
    const normalizedPeriodRows = bucket === 'day'
      ? fillDailySeriesRange(rawPeriodRows, from, to)
      : rawPeriodRows;
    const totalInRange = normalizedPeriodRows.reduce((sum, row) => sum + Number(row.plays || 0), 0);
    const avgInRange = normalizedPeriodRows.length ? totalInRange / normalizedPeriodRows.length : 0;
    const peakPeriod = normalizedPeriodRows.reduce((best, row) => {
      const plays = Number(row.plays || 0);
      if (!best || plays > best.plays) return { period: row.period, plays };
      return best;
    }, null);
    renderDailyBarChart(periodNode, normalizedPeriodRows, bucket, {
      stats: [
        { label: 'Zeiträume', value: formatPlays(normalizedPeriodRows.length) },
        {
          label: bucket === 'day' ? 'Ø Einsätze/Tag' : 'Ø Einsätze/Zeitraum',
          value: avgInRange.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        },
        {
          label: 'Spitze',
          value: peakPeriod ? `${formatSeriesPeriod(peakPeriod.period, bucket, true)} (${formatPlays(peakPeriod.plays)})` : '-'
        }
      ]
    });

    renderBarChart(stationBarNode, Array.isArray(stationsByPlays) ? stationsByPlays : []);
    renderSeriesByStationChart(stationSeriesNode, Array.isArray(stationsSeries) ? stationsSeries : [], 'day');
  }, [bucket, bucketSeries, cumulativeSeries, from, stationsByPlays, stationsSeries, to]);

  React.useEffect(() => {
    renderAllCharts();
  }, [renderAllCharts]);

  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(renderAllCharts);
    });
    [cumulativeRef.current, periodRef.current, stationBarRef.current, stationSeriesRef.current]
      .filter(Boolean)
      .forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [renderAllCharts]);

  if (!selectedTrack) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Bitte einen Track auswählen, um die Statistik zu sehen.<//>`;
  }

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.Box}>
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted} mb="2">Gesamt-Plays (kumuliert)<//>
        <div className="legacy-chart" ref=${cumulativeRef}></div>
      <//>
      <${Chakra.Box}>
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted} mb="2">Plays pro Zeitraum<//>
        <div className="legacy-chart" ref=${periodRef}></div>
      <//>
      <${Chakra.Box}>
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted} mb="2">Plays je Sender<//>
        <div className="legacy-chart legacy-chart-tall" ref=${stationBarRef}></div>
      <//>
      <${Chakra.Box}>
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted} mb="2">Verlauf pro Sender<//>
        <div className="legacy-chart legacy-chart-tall" ref=${stationSeriesRef}></div>
      <//>
    <//>
  `;
}

function DashboardApp() {
  const ui = useUiColors();
  const requestedTrackKey = React.useMemo(() => new URLSearchParams(window.location.search).get('trackKey'), []);

  const [search, setSearch] = React.useState('');
  const [stationId, setStationId] = React.useState('');
  const [stations, setStations] = React.useState([]);
  const [tracks, setTracks] = React.useState([]);
  const [selectedTrackKey, setSelectedTrackKey] = React.useState(requestedTrackKey || '');

  const defaultTo = berlinYesterdayIsoDate();
  const defaultFrom = shiftBerlinIsoDate(defaultTo, -29);
  const [from, setFrom] = React.useState(defaultFrom);
  const [to, setTo] = React.useState(defaultTo);
  const [bucket, setBucket] = React.useState('day');
  const [includeToday, setIncludeToday] = React.useState(false);

  const [loadingTracks, setLoadingTracks] = React.useState(false);
  const [loadingDetails, setLoadingDetails] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const [totals, setTotals] = React.useState(null);
  const [trend, setTrend] = React.useState(null);
  const [seriesByStation, setSeriesByStation] = React.useState(null);
  const [stationsByPlays, setStationsByPlays] = React.useState([]);
  const [cumulativeSeries, setCumulativeSeries] = React.useState([]);
  const [activeSenderSeries, setActiveSenderSeries] = React.useState([]);
  const [bucketSeries, setBucketSeries] = React.useState([]);

  const debouncedSearch = useDebouncedValue(search, 250);

  const selectedTrack = React.useMemo(
    () => tracks.find((row) => row.track_key === selectedTrackKey) || null,
    [tracks, selectedTrackKey]
  );

  const maxTrackPlays = React.useMemo(
    () => Math.max(1, ...tracks.map((row) => Number(row.total_plays || 0))),
    [tracks]
  );

  const effectiveTo = includeToday ? berlinTodayIsoDate() : to;
  const matrix = React.useMemo(() => buildDayStationMatrix(seriesByStation), [seriesByStation]);
  const dailyTrendRows = React.useMemo(
    () => buildDailyTrackTrendRows(seriesByStation, activeSenderSeries),
    [seriesByStation, activeSenderSeries]
  );

  const trackSummary = React.useMemo(() => {
    const totalPlays = tracks.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
    const uniqueArtists = new Set(tracks.map((row) => String(row.artist || '').toLowerCase()).filter(Boolean)).size;
    return {
      tracks: tracks.length,
      plays: totalPlays,
      artists: uniqueArtists
    };
  }, [tracks]);

  const loadStations = React.useCallback(async () => {
    const rows = await apiFetch('/api/stations');
    setStations(Array.isArray(rows) ? rows : []);
  }, []);

  const loadTrackDetails = React.useCallback(async (trackKey) => {
    if (!trackKey) {
      setTotals(null);
      setTrend(null);
      setSeriesByStation(null);
      setStationsByPlays([]);
      setCumulativeSeries([]);
      setActiveSenderSeries([]);
      setBucketSeries([]);
      return;
    }

    setLoadingDetails(true);
    setErrorText('');
    try {
      const detailParams = new URLSearchParams({ from, to: effectiveTo });
      const stationParams = new URLSearchParams({ from, to: effectiveTo, bucket: 'day', limit: '12' });
      const stationsByPlaysParams = new URLSearchParams({ from, to: effectiveTo });
      const bucketParams = new URLSearchParams({ from, to: effectiveTo, bucket });
      const cumulativeParams = new URLSearchParams({ from: '2000-01-01', to: effectiveTo, bucket });
      const panelParams = new URLSearchParams({ from, to: effectiveTo, minPlays: '50' });

      const [totalsRes, trendRes, stationRes, stationsByPlaysRes, bucketRes, cumulativeRes, panelRes] = await Promise.all([
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/totals?${detailParams.toString()}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/trend`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series-by-station?${stationParams.toString()}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/stations?${stationsByPlaysParams.toString()}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${bucketParams.toString()}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${cumulativeParams.toString()}`),
        apiFetch(`/api/panel/active-senders?${panelParams.toString()}`)
      ]);

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
      setLoadingDetails(false);
    }
  }, [from, effectiveTo, bucket]);

  const loadTracks = React.useCallback(async () => {
    setLoadingTracks(true);
    setErrorText('');
    try {
      const params = new URLSearchParams({
        q: debouncedSearch,
        stationId,
        limit: '1000'
      });
      const includeTrackKey = selectedTrackKey || requestedTrackKey || '';
      if (!stationId) params.delete('stationId');
      if (!debouncedSearch) params.delete('q');
      if (includeTrackKey) params.set('includeTrackKey', includeTrackKey);

      const rows = await apiFetch(`/api/tracks?${params.toString()}`);
      const safeRows = Array.isArray(rows) ? rows : [];
      setTracks(safeRows);

      let nextTrackKey = selectedTrackKey;
      if (!nextTrackKey && requestedTrackKey) nextTrackKey = requestedTrackKey;
      if (!safeRows.find((row) => row.track_key === nextTrackKey)) {
        nextTrackKey = safeRows[0]?.track_key || '';
      }
      setSelectedTrackKey(nextTrackKey);
    } catch (error) {
      setTracks([]);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTracks(false);
    }
  }, [debouncedSearch, stationId, selectedTrackKey, requestedTrackKey]);

  React.useEffect(() => {
    loadStations().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
    });
  }, [loadStations]);

  React.useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  React.useEffect(() => {
    if (!selectedTrackKey) return;
    loadTrackDetails(selectedTrackKey);
  }, [selectedTrackKey, loadTrackDetails]);

  const applyQuickRange = (rangeKey) => {
    const end = includeToday ? berlinTodayIsoDate() : berlinYesterdayIsoDate();
    let start = end;
    if (rangeKey === '7') start = shiftBerlinIsoDate(end, -6);
    if (rangeKey === '30') start = shiftBerlinIsoDate(end, -29);
    if (rangeKey === '90') start = shiftBerlinIsoDate(end, -89);
    if (rangeKey === 'ytd') {
      const year = Number(end.slice(0, 4));
      start = `${year}-01-01`;
    }
    setFrom(start);
    setTo(end);
  };

  return html`
    <${AppShell}
      activeKey="dashboard"
      title="Dashboard"
      subtitle="Klarer Song-Überblick: Performance und Plays pro Sender/Tag"
      controls=${html`
        <${Chakra.Button}
          size="sm"
          leftIcon=${React.createElement(Icons.RepeatIcon)}
          onClick=${() => loadTracks()}
          isLoading=${loadingTracks}
          colorScheme="blue"
        >Neu laden<//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">
        ${errorText ? html`
          <${Chakra.Alert} status="error" borderRadius="14px">
            <${Chakra.AlertIcon} />
            <${Chakra.Text}>${errorText}<//>
          <//>
        ` : null}

        <${PanelCard}
          title="So liest du das Dashboard"
          subtitle="1) Track wählen · 2) Zeitraum setzen · 3) Klassische Statistik-Charts lesen"
          right=${html`<${Chakra.Badge} colorScheme="blue" borderRadius="999px" px="3" py="1">Einheitliche Ansicht<//>`}
        >
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 3 }} spacing="3">
            <${MiniKpi} label="Score" value="Wie stark der Song im Panel performt" />
            <${MiniKpi} label="Klassische Charts" value="Kumuliert, Zeitraum, Sender, Senderverlauf" />
            <${MiniKpi} label="Sofort lesbar" value="Neue Optik mit den alten Statistikansichten" />
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 1, lg: 2 }} spacing="4">
          <${PanelCard} title="1) Track auswählen">
            <${Chakra.VStack} align="stretch" spacing="3">
              <${Chakra.FormControl}>
                <${Chakra.FormLabel}>Suche<//>
                <${Chakra.Input}
                  placeholder="Interpret oder Titel"
                  value=${search}
                  onChange=${(event) => setSearch(event.target.value)}
                />
              <//>
              <${Chakra.FormControl}>
                <${Chakra.FormLabel}>Sender<//>
                <${Chakra.Select}
                  value=${stationId}
                  onChange=${(event) => setStationId(event.target.value)}
                >
                  <option value="">Alle Sender</option>
                  ${stations.map((station) => html`<option key=${station.id} value=${station.id}>${station.name || station.id}</option>`)}
                <//>
              <//>
              <${Chakra.Button}
                leftIcon=${React.createElement(Icons.SearchIcon)}
                colorScheme="blue"
                onClick=${() => loadTracks()}
                isLoading=${loadingTracks}
              >Treffer laden<//>
            <//>
          <//>

          <${PanelCard} title="2) Zeitraum einstellen" subtitle="Standard bis gestern für stabile Tageswerte">
            <${Chakra.VStack} align="stretch" spacing="3">
              <${Chakra.FormControl}>
                <${Chakra.FormLabel}>Aggregation<//>
                <${Chakra.Select} value=${bucket} onChange=${(event) => setBucket(event.target.value)}>
                  <option value="day">Tag</option>
                  <option value="week">Woche</option>
                  <option value="month">Monat</option>
                  <option value="year">Jahr</option>
                <//>
              <//>
              <${Chakra.HStack} align="end" spacing="3">
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Von<//>
                  <${Chakra.Input} type="date" value=${from} onChange=${(event) => setFrom(event.target.value)} />
                <//>
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Bis<//>
                  <${Chakra.Input} type="date" value=${to} onChange=${(event) => setTo(event.target.value)} />
                <//>
              <//>
              <${Chakra.HStack} spacing="2" flexWrap="wrap">
                ${['7', '30', '90', 'ytd'].map((range) => html`
                  <${Chakra.Button}
                    key=${range}
                    size="sm"
                    variant="outline"
                    onClick=${() => applyQuickRange(range)}
                  >${range === 'ytd' ? 'YTD' : `${range} Tage`}<//>
                `)}
              <//>
              <${Chakra.Checkbox}
                isChecked=${includeToday}
                onChange=${(event) => setIncludeToday(event.target.checked)}
              >Laufenden Tag einbeziehen<//>
              <${Chakra.Button}
                variant="solid"
                colorScheme="blue"
                onClick=${() => loadTrackDetails(selectedTrackKey)}
                isLoading=${loadingDetails}
                isDisabled=${!selectedTrackKey}
              >Statistik aktualisieren<//>
            <//>
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 2, lg: 4 }} spacing="3">
          <${StatCard} label="Gefundene Titel" value=${formatNumber(trackSummary.tracks)} />
          <${StatCard} label="Einsätze (Trefferliste)" value=${formatNumber(trackSummary.plays)} />
          <${StatCard} label="Künstler" value=${formatNumber(trackSummary.artists)} />
          <${StatCard}
            label="Ausgewählter Track"
            value=${selectedTrack ? `${selectedTrack.artist} - ${selectedTrack.title}` : '-'}
            compact=${true}
          />
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 4 }} spacing="4">
          <${PanelCard} title="Tracks" subtitle=${loadingTracks ? 'Lade Treffer...' : `${formatNumber(tracks.length)} Einträge`} p="4">
            <${Chakra.VStack} align="stretch" spacing="2" maxH="620px" overflowY="auto" className="horizon-scroll">
              ${tracks.slice(0, 260).map((row) => html`
                <${Chakra.Button}
                  key=${row.track_key}
                  variant=${row.track_key === selectedTrackKey ? 'solid' : 'ghost'}
                  colorScheme=${row.track_key === selectedTrackKey ? 'blue' : 'gray'}
                  justifyContent="start"
                  whiteSpace="normal"
                  textAlign="left"
                  h="auto"
                  py="2"
                  onClick=${() => setSelectedTrackKey(row.track_key)}
                >
                  <${Chakra.Box}>
                    <${Chakra.Text} fontSize="sm" fontWeight="700">${row.artist}<//>
                    <${Chakra.Text} fontSize="xs" color=${row.track_key === selectedTrackKey ? 'whiteAlpha.900' : ui.textMuted}>${row.title}<//>
                    <${Chakra.Text} fontSize="xs" color=${row.track_key === selectedTrackKey ? 'whiteAlpha.900' : ui.textMuted}>${formatNumber(row.total_plays)} Plays<//>
                  <//>
                <//>
              `)}
              ${tracks.length === 0 && !loadingTracks ? html`
                <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Keine Treffer. Filter anpassen oder Ingest laufen lassen.<//>
              ` : null}
            <//>
          <//>

          <${Chakra.VStack} gridColumn=${{ base: 'span 1', xl: 'span 3' }} align="stretch" spacing="4">
            <${PanelCard}
              title=${selectedTrack ? `3) Wie gut kommt „${selectedTrack.title}“ an?` : '3) Song-Performance'}
              subtitle=${selectedTrack ? `${selectedTrack.artist} | ${from} bis ${effectiveTo}` : 'Bitte Track wählen'}
            >
              <${SongPerformanceCard}
                selectedTrack=${selectedTrack}
                trend=${trend}
                totals=${totals}
                matrix=${matrix}
                maxTrackPlays=${maxTrackPlays}
                from=${from}
                to=${effectiveTo}
              />
            <//>

            <${PanelCard}
              title="Klassische Statistikansichten"
              subtitle="Die gewohnten Charts mit klaren Sender-Play-Zahlen im neuen Design"
            >
              <${LegacyStatsCharts}
                selectedTrack=${selectedTrack}
                from=${from}
                to=${effectiveTo}
                bucket=${bucket}
                cumulativeSeries=${cumulativeSeries}
                bucketSeries=${bucketSeries}
                stationsByPlays=${stationsByPlays}
                stationsSeries=${seriesByStation?.stations || []}
              />
            <//>

            <${PanelCard}
              title="Trend Rohsumme vs. panelbereinigt"
              subtitle="Zusatzinfo: Roh = absolute Plays | Bereinigt = Plays pro aktivem Sender je Tag"
            >
              <${Chakra.Tabs} variant="soft-rounded" colorScheme="blue" size="sm">
                <${Chakra.TabList}>
                  <${Chakra.Tab}>Rohsumme<//>
                  <${Chakra.Tab}>Panelbereinigt<//>
                <//>
                <${Chakra.TabPanels}>
                  <${Chakra.TabPanel} px="0" pb="0">
                    <${TrackTrendLineChart} rows=${dailyTrendRows} mode="raw" />
                  <//>
                  <${Chakra.TabPanel} px="0" pb="0">
                    <${TrackTrendLineChart} rows=${dailyTrendRows} mode="normalized" />
                  <//>
                <//>
              <//>
            <//>

            ${EXTRA_CHARTS_ENABLED ? html`
              <${PanelCard}
                title="Zusatzansicht: Bucket-Verlauf"
                subtitle=${`Bucket = ${bucket}`}
              >
                <${BucketTrendCompact} rows=${bucketSeries} />
              <//>
            ` : null}
          <//>
        <//>
      <//>
    <//>
  `;
}

function StatCard({ label, value, compact = false }) {
  const ui = useUiColors();
  return html`
    <${PanelCard} p="4">
      <${Chakra.Text} fontSize="xs" color=${ui.textMuted} mb="1">${label}<//>
      <${Chakra.Text} fontSize=${compact ? 'sm' : '2xl'} fontWeight="800" color=${ui.textPrimary} noOfLines=${compact ? 2 : undefined}>
        ${value}
      <//>
    <//>
  `;
}

function Root() {
  return html`
    <${Chakra.ChakraProvider} theme=${horizonTheme}>
      <${DashboardApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
