import {
  appendChartStats,
  bindChartTooltip,
  buildNiceYAxis,
  chartWidth,
  drawAxes,
  drawAxisLabels,
  drawXAxisTicks,
  drawYAxisGrid,
  formatPlays,
  formatSeriesPeriod,
  getChartColors,
  makeSvg,
  makeSvgEl,
  renderChartEmpty
} from './charts.base.js';

export function renderDailyBarChart(container, series, bucket = 'day', options = {}) {
  container.innerHTML = '';
  const rows = Array.isArray(series) ? series : [];
  if (!rows.length) {
    renderChartEmpty(container, 'Keine Tagesdaten im Zeitraum.');
    return;
  }

  appendChartStats(container, options.stats);

  const height = 260;
  const pad = { t: 16, r: 24, b: 52, l: 60 };
  const width = chartWidth(container, rows.length * 24 + pad.l + pad.r, 420);
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...rows.map((row) => Number(row.plays || 0)), 1);
  const yAxis = buildNiceYAxis(maxY, 4);
  const step = rows.length > 1 ? w / (rows.length - 1) : 0;
  const barWidth = rows.length > 1 ? Math.max(4, Math.min(step * 0.7, 22)) : 28;
  const colors = getChartColors(container);
  const svg = makeSvg(width, height);

  drawAxes(svg, pad, w, h, colors);
  drawYAxisGrid(svg, pad, w, h, yAxis, colors);
  drawXAxisTicks(svg, pad, w, h, rows, bucket, 7, colors);

  rows.forEach((row, i) => {
    const xCenter = rows.length > 1 ? pad.l + i * step : pad.l + w / 2;
    const val = Number(row.plays || 0);
    const barH = (val / yAxis.maxTick) * h;
    const y = pad.t + h - barH;
    const rect = makeSvgEl('rect', {
      x: xCenter - barWidth / 2,
      y,
      width: barWidth,
      height: Math.max(1, barH),
      rx: 3,
      fill: colors.accent
    });
    svg.appendChild(rect);
    bindChartTooltip(container, rect, () => `${formatSeriesPeriod(row.period, bucket)}: ${formatPlays(val)} Einsätze`);
  });

  drawAxisLabels(
    svg,
    pad,
    w,
    h,
    width,
    height,
    'Zeitraum',
    bucket === 'day' ? 'Einsätze / Tag' : 'Einsätze / Zeitraum'
  );
  container.appendChild(svg);
}

export function renderBarChart(container, rows) {
  container.innerHTML = '';
  const prepared = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      stationId: row.station_id || row.stationId || '',
      stationName: row.station_name || row.stationName || row.station_id || row.stationId || 'Unbekannt',
      plays: Number(row.plays || 0)
    }))
    .filter((row) => row.plays > 0)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 15);

  if (!prepared.length) {
    renderChartEmpty(container, 'Keine Senderdaten im Zeitraum.');
    return;
  }

  const totalPlays = prepared.reduce((sum, row) => sum + row.plays, 0);
  const topStation = prepared[0];
  const topThree = prepared.slice(0, 3).reduce((sum, row) => sum + row.plays, 0);
  appendChartStats(container, [
    { label: 'Sender', value: formatPlays(prepared.length) },
    { label: 'Spitzen-Sender', value: `${topStation.stationName} (${formatPlays(topStation.plays)})` },
    { label: 'Anteil der drei stärksten Sender', value: `${totalPlays ? ((topThree / totalPlays) * 100).toFixed(1) : '0.0'}%` }
  ]);

  const height = Math.max(340, prepared.length * 30 + 70);
  const longestLabel = prepared.reduce((maxLen, row) => Math.max(maxLen, row.stationName.length), 0);
  const padLeft = Math.min(280, Math.max(170, longestLabel * 7 + 24));
  const pad = { t: 18, r: 132, b: 30, l: padLeft };
  const width = chartWidth(container, 900, 520);
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...prepared.map((r) => r.plays), 1);
  const xAxis = buildNiceYAxis(max, 4);
  const bar = h / prepared.length;
  const svg = makeSvg(width, height);
  const colors = getChartColors(container);

  svg.appendChild(makeSvgEl('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + h, stroke: colors.axis, 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, x2: pad.l + w, y1: pad.t + h, y2: pad.t + h, stroke: colors.axis, 'stroke-width': 1 }));

  xAxis.ticks.forEach((val) => {
    const x = pad.l + (val / xAxis.maxTick) * w;
    svg.appendChild(makeSvgEl('line', { x1: x, x2: x, y1: pad.t, y2: pad.t + h, stroke: colors.grid, 'stroke-width': 1 }));
    svg.appendChild(makeSvgEl('line', { x1: x, x2: x, y1: pad.t + h, y2: pad.t + h + 4, stroke: colors.axis }));
    const label = makeSvgEl('text', { x, y: pad.t + h + 16, 'font-size': 11, 'text-anchor': 'middle' });
    label.textContent = formatPlays(val);
    svg.appendChild(label);
  });

  drawAxisLabels(svg, pad, w, h, width, height, 'Anzahl Einsätze', 'Sender');

  prepared.forEach((row, i) => {
    const y = pad.t + i * bar + 4;
    const bw = (Number(row.plays || 0) / xAxis.maxTick) * (w - 8);
    const playsValue = formatPlays(row.plays);
    const pct = totalPlays ? ((row.plays / totalPlays) * 100).toFixed(1) : '0.0';

    const label = makeSvgEl('text', { x: 6, y: y + bar / 2 + 4, 'font-size': 12 });
    label.textContent = row.stationName;

    const rect = makeSvgEl('rect', {
      x: pad.l,
      y,
      width: Math.max(2, bw),
      height: Math.max(12, bar - 8),
      rx: 4,
      fill: colors.accent
    });

    const val = makeSvgEl('text', {
      x: pad.l + Math.max(2, bw) + 6,
      y: y + Math.max(10, bar - 8) / 2 + 4,
      'font-size': 11
    });
    val.textContent = `${playsValue} (${pct}%)`;

    svg.appendChild(label);
    svg.appendChild(rect);
    svg.appendChild(val);
    bindChartTooltip(container, rect, () => `${row.stationName}: ${playsValue} Einsätze (${pct}%)`);
  });

  container.appendChild(svg);
}

export function renderStationCompareChart(container, totalRows, yesterdayRows) {
  container.innerHTML = '';
  const totals = Array.isArray(totalRows) ? totalRows : [];
  const yRows = Array.isArray(yesterdayRows) ? yesterdayRows : [];
  if (!totals.length && !yRows.length) {
    renderChartEmpty(container, 'Keine Senderdaten im Zeitraum.');
    return;
  }

  const totalMap = new Map(totals.map((row) => [
    row.station_id,
    { stationId: row.station_id, stationName: row.station_name || row.station_id, totalPlays: Number(row.plays || 0) }
  ]));
  const yMap = new Map(yRows.map((row) => [row.station_id, Number(row.plays || 0)]));
  const ids = new Set([...totalMap.keys(), ...yMap.keys()]);
  const rows = Array.from(ids).map((stationId) => ({
    stationId,
    stationName: totalMap.get(stationId)?.stationName || stationId,
    totalPlays: Number(totalMap.get(stationId)?.totalPlays || 0),
    yesterdayPlays: Number(yMap.get(stationId) || 0)
  }))
    .sort((a, b) => b.totalPlays - a.totalPlays || b.yesterdayPlays - a.yesterdayPlays)
    .slice(0, 12);

  if (!rows.length) {
    renderChartEmpty(container, 'Keine Senderdaten im Zeitraum.');
    return;
  }

  const height = Math.max(320, rows.length * 32 + 72);
  const pad = { t: 18, r: 120, b: 30, l: 200 };
  const width = chartWidth(container, 920, 560);
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(1, ...rows.map((row) => Math.max(row.totalPlays, row.yesterdayPlays)));
  const bar = h / rows.length;
  const svg = makeSvg(width, height);
  const colors = getChartColors(container);

  svg.appendChild(makeSvgEl('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + h, stroke: colors.axis, 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, x2: pad.l + w, y1: pad.t + h, y2: pad.t + h, stroke: colors.axis, 'stroke-width': 1 }));

  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const val = Math.round((max * i) / ticks);
    const x = pad.l + (w * i) / ticks;
    svg.appendChild(makeSvgEl('line', { x1: x, x2: x, y1: pad.t + h, y2: pad.t + h + 4, stroke: colors.axis }));
    const label = makeSvgEl('text', { x, y: pad.t + h + 16, 'font-size': 11, 'text-anchor': 'middle' });
    label.textContent = val.toLocaleString('de-DE');
    svg.appendChild(label);
  }

  rows.forEach((row, index) => {
    const y = pad.t + index * bar + 5;
    const totalW = (row.totalPlays / max) * (w - 8);
    const yW = (row.yesterdayPlays / max) * (w - 8);
    const barH = Math.max(14, bar - 10);

    const label = makeSvgEl('text', { x: 8, y: y + barH / 2 + 4, 'font-size': 12 });
    label.textContent = row.stationName;
    svg.appendChild(label);

    const totalRect = makeSvgEl('rect', {
      x: pad.l,
      y,
      width: Math.max(1, totalW),
      height: barH,
      rx: 4,
      fill: colors.accent
    });
    svg.appendChild(totalRect);
    bindChartTooltip(container, totalRect, () => `${row.stationName}: Gesamt ${row.totalPlays.toLocaleString('de-DE')} Einsätze`);

    if (row.yesterdayPlays > 0) {
      const yRect = makeSvgEl('rect', {
        x: pad.l,
        y: y + Math.max(2, Math.floor(barH * 0.35)),
        width: Math.max(1, yW),
        height: Math.max(4, Math.floor(barH * 0.35)),
        rx: 3,
        fill: colors.secondary
      });
      svg.appendChild(yRect);
      bindChartTooltip(container, yRect, () => `${row.stationName}: Gestern ${row.yesterdayPlays.toLocaleString('de-DE')} Einsätze`);
    }

    const val = makeSvgEl('text', { x: pad.l + Math.max(2, totalW) + 6, y: y + barH / 2 + 4, 'font-size': 11 });
    val.textContent = `${row.totalPlays.toLocaleString('de-DE')} | G ${row.yesterdayPlays.toLocaleString('de-DE')}`;
    svg.appendChild(val);
  });

  drawAxisLabels(svg, pad, w, h, width, height, 'Anzahl Einsätze', 'Sender');
  container.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'text-secondary mt-2';
  legend.textContent = 'Orange = Gesamt im gewählten Zeitraum, Türkis = gestriger Tag';
  container.appendChild(legend);
}
