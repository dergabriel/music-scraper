import { berlinIsoDate } from './date-berlin.js';

export function formatPlays(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

export function formatSeriesPeriod(period, bucket, compact = false) {
  if (!period) return '-';
  if (bucket === 'day') {
    const date = new Date(`${period}T12:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('de-DE', compact
        ? { day: '2-digit', month: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    const [y, m, d] = String(period).split('-');
    return compact ? `${d}.${m}` : `${d}.${m}.${y}`;
  }
  return period;
}

export function makeSvg(width, height) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return svg;
}

export function makeSvgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  });
  return el;
}

export function chartVar(container, name, fallback) {
  const root = container || document.documentElement;
  const styles = getComputedStyle(root);
  const globalStyles = getComputedStyle(document.documentElement);
  const value = styles.getPropertyValue(name).trim() || globalStyles.getPropertyValue(name).trim();
  return value || fallback;
}

export function getChartColors(container) {
  return {
    axis: chartVar(container, '--chart-axis', '#7f95aa'),
    grid: chartVar(container, '--chart-grid', 'rgba(127,149,170,0.25)'),
    text: chartVar(container, '--chart-text', 'currentColor'),
    primary: chartVar(container, '--chart-series-primary', '#0ea5a4'),
    primaryFill: chartVar(container, '--chart-series-primary-fill', 'rgba(20,184,166,0.12)'),
    accent: chartVar(container, '--chart-series-accent', '#f59e0b'),
    secondary: chartVar(container, '--chart-series-secondary', '#14b8a6')
  };
}

export function ensureChartTooltip(container) {
  let tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    container.appendChild(tooltip);
  }
  return tooltip;
}

export function bindChartTooltip(container, target, getText) {
  const tooltip = ensureChartTooltip(container);
  let latestEvent = null;
  let raf = null;

  const paint = () => {
    raf = null;
    if (!latestEvent) return;
    tooltip.textContent = getText();
    tooltip.style.opacity = '1';

    const rect = container.getBoundingClientRect();
    const rawX = latestEvent.clientX - rect.left + 10;
    const rawY = latestEvent.clientY - rect.top - 26;
    const maxX = Math.max(8, rect.width - tooltip.offsetWidth - 8);
    const maxY = Math.max(8, rect.height - tooltip.offsetHeight - 8);
    tooltip.style.left = `${Math.max(8, Math.min(rawX, maxX))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rawY, maxY))}px`;
  };

  const onMove = (event) => {
    latestEvent = event;
    if (!raf) raf = requestAnimationFrame(paint);
  };

  const hide = () => {
    latestEvent = null;
    tooltip.style.opacity = '0';
  };

  target.addEventListener('mousemove', onMove);
  target.addEventListener('mouseenter', onMove);
  target.addEventListener('mouseleave', hide);
}

export function buildNiceYAxis(maxValue, targetTicks = 4) {
  const safeMax = Math.max(1, Number(maxValue || 0));
  const roughStep = safeMax / Math.max(1, targetTicks);
  const exp = Math.floor(Math.log10(roughStep));
  const base = 10 ** exp;
  const norm = roughStep / base;
  const factor = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = factor * base;
  const maxTick = Math.ceil(safeMax / step) * step;
  const ticks = [];
  for (let value = 0; value <= maxTick + step * 0.25; value += step) {
    ticks.push(Number(value.toFixed(8)));
  }
  return { step, maxTick, ticks };
}

export function buildXTickIndexes(length, maxTicks = 6) {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const count = Math.min(maxTicks, length);
  const indexes = new Set([0, length - 1]);
  for (let i = 1; i < count - 1; i += 1) {
    indexes.add(Math.round((i * (length - 1)) / (count - 1)));
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

export function renderChartEmpty(container, message) {
  container.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'chart-empty';
  empty.textContent = message;
  container.appendChild(empty);
}

export function appendChartStats(container, stats) {
  if (!Array.isArray(stats) || !stats.length) return;
  const row = document.createElement('div');
  row.className = 'chart-stats';
  stats.forEach((item) => {
    if (!item?.label) return;
    const chip = document.createElement('div');
    chip.className = 'chart-stat';
    const label = document.createElement('span');
    label.textContent = item.label;
    const value = document.createElement('strong');
    value.textContent = item.value ?? '-';
    chip.appendChild(label);
    chip.appendChild(value);
    row.appendChild(chip);
  });
  if (row.children.length) container.appendChild(row);
}

export function downsampleSeries(series, maxPoints = 220) {
  const rows = Array.isArray(series) ? series : [];
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < rows.length; i += step) sampled.push(rows[i]);
  if (sampled[sampled.length - 1] !== rows[rows.length - 1]) sampled.push(rows[rows.length - 1]);
  return sampled;
}

export function fillDailySeriesRange(series, fromIso, toIso) {
  const rows = Array.isArray(series) ? series : [];
  if (!fromIso || !toIso) return rows;
  const start = new Date(`${fromIso}T12:00:00.000Z`);
  const end = new Date(`${toIso}T12:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return rows;

  const valueByPeriod = new Map(rows.map((row) => [row.period, Number(row.plays || 0)]));
  const filled = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    const iso = berlinIsoDate(cursor);
    filled.push({ period: iso, plays: Number(valueByPeriod.get(iso) || 0) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

export function toCumulativeSeries(series) {
  let total = 0;
  return (Array.isArray(series) ? series : []).map((row) => {
    total += Number(row.plays || 0);
    return { period: row.period, plays: total };
  });
}

export function chartWidth(container, preferred, minWidth = 360) {
  const available = Number(container?.clientWidth || 0);
  if (!Number.isFinite(available) || available <= 0) return Math.max(minWidth, preferred);
  return Math.max(minWidth, preferred, available - 4);
}

export function drawAxes(svg, pad, w, h, colors) {
  svg.appendChild(makeSvgEl('line', {
    x1: pad.l,
    y1: pad.t,
    x2: pad.l,
    y2: pad.t + h,
    stroke: colors.axis,
    'stroke-width': 1
  }));
  svg.appendChild(makeSvgEl('line', {
    x1: pad.l,
    y1: pad.t + h,
    x2: pad.l + w,
    y2: pad.t + h,
    stroke: colors.axis,
    'stroke-width': 1
  }));
}

export function drawYAxisGrid(svg, pad, w, h, yAxis, colors) {
  yAxis.ticks.forEach((val) => {
    const y = pad.t + h - (val / yAxis.maxTick) * h;
    svg.appendChild(makeSvgEl('line', {
      x1: pad.l,
      y1: y,
      x2: pad.l + w,
      y2: y,
      stroke: colors.grid,
      'stroke-width': 1
    }));
    const label = makeSvgEl('text', { x: pad.l - 8, y: y + 4, 'font-size': 11, 'text-anchor': 'end' });
    label.textContent = formatPlays(val);
    svg.appendChild(label);
  });
}

export function drawXAxisTicks(svg, pad, w, h, rows, bucket, maxTicks = 6, colors = null) {
  const step = rows.length > 1 ? w / (rows.length - 1) : 0;
  const axisColor = colors?.axis || '#7f95aa';
  buildXTickIndexes(rows.length, maxTicks).forEach((i, idx, all) => {
    const x = rows.length > 1 ? pad.l + i * step : pad.l + w / 2;
    svg.appendChild(makeSvgEl('line', { x1: x, y1: pad.t + h, x2: x, y2: pad.t + h + 4, stroke: axisColor }));
    const anchor = idx === 0 ? 'start' : idx === all.length - 1 ? 'end' : 'middle';
    const label = makeSvgEl('text', { x, y: pad.t + h + 17, 'font-size': 11, 'text-anchor': anchor });
    label.textContent = formatSeriesPeriod(rows[i]?.period, bucket, true);
    svg.appendChild(label);
  });
}

export function drawAxisLabels(svg, pad, w, h, width, height, xText = 'Zeitraum', yText = 'Einsätze') {
  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 8, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = xText;
  svg.appendChild(xLabel);
  const yLabel = makeSvgEl('text', {
    x: 16,
    y: pad.t + h / 2,
    'font-size': 12,
    'text-anchor': 'middle',
    transform: `rotate(-90 16 ${pad.t + h / 2})`
  });
  yLabel.textContent = yText;
  svg.appendChild(yLabel);
}
