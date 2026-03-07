import {
  appendChartStats,
  bindChartTooltip,
  buildNiceYAxis,
  chartWidth,
  drawAxes,
  drawAxisLabels,
  drawXAxisTicks,
  drawYAxisGrid,
  downsampleSeries,
  formatPlays,
  formatSeriesPeriod,
  getChartColors,
  makeSvg,
  makeSvgEl,
  renderChartEmpty
} from './charts.base.js';

export function renderLineChart(container, series, bucket = 'day', options = {}) {
  container.innerHTML = '';
  const rows = downsampleSeries(series || [], options.maxPoints || 220);
  if (!rows.length) {
    renderChartEmpty(container, 'Keine Daten im Zeitraum.');
    return;
  }

  appendChartStats(container, options.stats);

  const height = 260;
  const pad = { t: 18, r: 36, b: 50, l: 60 };
  const width = chartWidth(container, rows.length * 26 + pad.l + pad.r, 420);
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...rows.map((s) => Number(s.plays || 0)), 1);
  const yAxis = buildNiceYAxis(maxY, 4);
  const step = rows.length > 1 ? w / (rows.length - 1) : 0;
  const svg = makeSvg(width, height);
  const colors = getChartColors(container);
  const pointColor = options.color || colors.primary;

  drawAxes(svg, pad, w, h, colors);
  drawYAxisGrid(svg, pad, w, h, yAxis, colors);
  drawXAxisTicks(svg, pad, w, h, rows, bucket, 6, colors);
  drawAxisLabels(svg, pad, w, h, width, height, 'Zeitraum', 'Einsätze');

  let d = '';
  const points = [];
  rows.forEach((p, i) => {
    const x = rows.length > 1 ? pad.l + i * step : pad.l + w / 2;
    const y = pad.t + h - (Number(p.plays || 0) / yAxis.maxTick) * h;
    points.push({ x, y, period: p.period, plays: Number(p.plays || 0) });
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  });

  if (options.showArea && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    svg.appendChild(makeSvgEl('path', {
      d: `${d.trim()} L ${last.x} ${pad.t + h} L ${first.x} ${pad.t + h} Z`,
      fill: colors.primaryFill,
      stroke: 'none'
    }));
  }

  svg.appendChild(makeSvgEl('path', {
    d: d.trim(),
    fill: 'none',
    stroke: pointColor,
    'stroke-width': 2.3
  }));

  points.forEach((p) => {
    const hit = makeSvgEl('circle', { cx: p.x, cy: p.y, r: 10, fill: 'transparent' });
    const dot = makeSvgEl('circle', { cx: p.x, cy: p.y, r: 3.8, fill: pointColor });
    svg.appendChild(hit);
    svg.appendChild(dot);
    bindChartTooltip(container, hit, () => `${formatSeriesPeriod(p.period, bucket)}: ${formatPlays(p.plays)} Einsätze`);
  });

  const last = points[points.length - 1];
  if (last) {
    const label = makeSvgEl('text', {
      x: Math.min(last.x + 8, pad.l + w - 8),
      y: Math.max(pad.t + 12, last.y - 8),
      'font-size': 11,
      'text-anchor': 'start'
    });
    label.textContent = formatPlays(last.plays);
    svg.appendChild(label);
  }

  container.appendChild(svg);

  if ((series || []).length > rows.length) {
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = `Angezeigt: ${rows.length} von ${series.length} Punkten (für bessere Lesbarkeit).`;
    container.appendChild(note);
  }
}

export function renderSeriesByStationChart(container, rows, bucket = 'day') {
  container.innerHTML = '';
  if (!Array.isArray(rows) || !rows.length) {
    container.textContent = 'Keine Senderdaten im Zeitraum.';
    return;
  }

  const prepared = rows
    .map((row) => ({
      stationId: row.stationId,
      stationName: row.stationName || row.stationId,
      totalPlays: Number(row.totalPlays || 0),
      series: Array.isArray(row.series) ? row.series : []
    }))
    .filter((row) => row.series.length > 0)
    .slice(0, 10);

  if (!prepared.length) {
    container.textContent = 'Keine Senderdaten im Zeitraum.';
    return;
  }

  const periods = Array.from(new Set(prepared.flatMap((row) => row.series.map((p) => p.period)))).sort();
  if (!periods.length) {
    container.textContent = 'Keine Senderdaten im Zeitraum.';
    return;
  }

  if (periods.length === 1) {
    const hint = document.createElement('p');
    hint.className = 'text-secondary mb-0';
    hint.textContent =
      `Nur ein Zeitraum vorhanden (${formatSeriesPeriod(periods[0], bucket)}). ` +
      'Für einen echten Verlauf bitte einen größeren Datumsbereich wählen.';
    container.appendChild(hint);
    return;
  }

  const height = 300;
  const pad = { t: 16, r: 16, b: 56, l: 54 };
  const width = chartWidth(container, periods.length * 38 + pad.l + pad.r, 520);
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(
    1,
    ...prepared.flatMap((row) => row.series.map((point) => Number(point.plays || 0)))
  );
  const step = periods.length > 1 ? w / (periods.length - 1) : w;
  const colors = getChartColors(container);
  const palette = [
    colors.primary,
    colors.accent,
    '#ef4444',
    '#8b5cf6',
    '#22c55e',
    '#3b82f6',
    '#e11d48',
    '#14b8a6',
    '#f97316',
    '#6366f1'
  ];
  const colorByStation = new Map(prepared.map((row, idx) => [row.stationId, palette[idx % palette.length]]));
  const svg = makeSvg(width, height);

  drawAxes(svg, pad, w, h, colors);
  const yAxis = buildNiceYAxis(maxY, 4);
  drawYAxisGrid(svg, pad, w, h, yAxis, colors);

  const xRows = periods.map((period) => ({ period, plays: 0 }));
  drawXAxisTicks(svg, pad, w, h, xRows, bucket, 5, colors);
  drawAxisLabels(svg, pad, w, h, width, height, 'Zeitraum', 'Einsätze');

  prepared.forEach((row) => {
    const valueByPeriod = new Map(row.series.map((point) => [point.period, Number(point.plays || 0)]));
    const color = colorByStation.get(row.stationId) || colors.primary;
    let pathData = '';
    const points = periods.map((period, index) => {
      const x = pad.l + index * step;
      const plays = Number(valueByPeriod.get(period) || 0);
      const y = pad.t + h - (plays / yAxis.maxTick) * h;
      pathData += `${index === 0 ? 'M' : 'L'} ${x} ${y} `;
      return { x, y, plays, period };
    });
    svg.appendChild(makeSvgEl('path', {
      d: pathData.trim(),
      fill: 'none',
      stroke: color,
      'stroke-width': 2
    }));

    points.forEach((point) => {
      const dot = makeSvgEl('circle', { cx: point.x, cy: point.y, r: 3, fill: color });
      svg.appendChild(dot);
      bindChartTooltip(container, dot, () =>
        `${row.stationName} | ${formatSeriesPeriod(point.period, bucket)}: ${point.plays.toLocaleString('de-DE')} Einsätze`
      );
    });
  });

  container.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  const visibleLegend = prepared.slice(0, 6);
  const hiddenCount = Math.max(0, prepared.length - visibleLegend.length);
  visibleLegend.forEach((row) => {
    const item = document.createElement('span');
    item.className = 'chart-legend-item';
    const color = colorByStation.get(row.stationId) || colors.primary;
    const dot = document.createElement('span');
    dot.style.display = 'inline-block';
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '50%';
    dot.style.background = color;
    dot.style.marginRight = '6px';
    item.appendChild(dot);
    item.append(`${row.stationName} (${Number(row.totalPlays || 0).toLocaleString('de-DE')})`);
    legend.appendChild(item);
  });
  if (hiddenCount > 0) {
    const more = document.createElement('span');
    more.className = 'chart-legend-item chart-legend-item-muted';
    more.textContent = `+${hiddenCount} weitere Sender`;
    legend.appendChild(more);
  }
  container.appendChild(legend);
}
