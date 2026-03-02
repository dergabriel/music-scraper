import {
  berlinIsoDate,
  berlinTodayIsoDate,
  berlinYesterdayIsoDate,
  berlinYear,
  shiftBerlinIsoDate,
  weekStartBerlinIso
} from './date-berlin.js';

const qs = (id) => document.getElementById(id);
const getQueryTrackKey = () => new URLSearchParams(window.location.search).get('trackKey');
const requestedTrackKey = getQueryTrackKey();
const focusedTrackMode = Boolean(getQueryTrackKey());

function themeToggleText(theme) {
  return theme === 'dark' ? 'Hell' : 'Dunkel';
}

function applyTheme() {
  const saved = localStorage.getItem('music-scraper-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-bs-theme', theme);
  qs('themeToggle').textContent = themeToggleText(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('music-scraper-theme', next);
  qs('themeToggle').textContent = themeToggleText(next);
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('de-DE') : '-';
}

function fmtReleaseDate(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('de-DE');
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function makeSvg(width, height) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return svg;
}

function makeSvgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  });
  return el;
}

function ensureChartTooltip(container) {
  let tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    container.appendChild(tooltip);
  }
  return tooltip;
}

function bindChartTooltip(container, target, getText) {
  const tooltip = ensureChartTooltip(container);
  const show = (event) => {
    tooltip.textContent = getText();
    tooltip.style.opacity = '1';
    const rect = container.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 10;
    const rawY = event.clientY - rect.top - 26;
    const maxX = Math.max(8, rect.width - tooltip.offsetWidth - 8);
    const maxY = Math.max(8, rect.height - tooltip.offsetHeight - 8);
    tooltip.style.left = `${Math.max(8, Math.min(rawX, maxX))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rawY, maxY))}px`;
  };
  const hide = () => {
    tooltip.style.opacity = '0';
  };
  target.addEventListener('mousemove', show);
  target.addEventListener('mouseenter', show);
  target.addEventListener('mouseleave', hide);
}

function formatSeriesPeriod(period, bucket, compact = false) {
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

function formatPlays(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

function buildNiceYAxis(maxValue, targetTicks = 4) {
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

function buildXTickIndexes(length, maxTicks = 6) {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const count = Math.min(maxTicks, length);
  const indexes = new Set([0, length - 1]);
  for (let i = 1; i < count - 1; i += 1) {
    indexes.add(Math.round((i * (length - 1)) / (count - 1)));
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

function renderChartEmpty(container, message) {
  container.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'chart-empty';
  empty.textContent = message;
  container.appendChild(empty);
}

function appendChartStats(container, stats) {
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
  if (row.children.length) {
    container.appendChild(row);
  }
}

function downsampleSeries(series, maxPoints = 220) {
  const rows = Array.isArray(series) ? series : [];
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < rows.length; i += step) {
    sampled.push(rows[i]);
  }
  if (sampled[sampled.length - 1] !== rows[rows.length - 1]) {
    sampled.push(rows[rows.length - 1]);
  }
  return sampled;
}

function fillDailySeriesRange(series, fromIso, toIso) {
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

function toCumulativeSeries(series) {
  let total = 0;
  return (Array.isArray(series) ? series : []).map((row) => {
    total += Number(row.plays || 0);
    return {
      period: row.period,
      plays: total
    };
  });
}

function renderTrackMetadata(metadata) {
  const state = qs('trackMetaState');
  const list = qs('trackMetaList');
  const cover = qs('trackMetaCover');
  list.innerHTML = '';

  if (!metadata) {
    state.textContent = 'Keine Metadaten verfügbar.';
    cover.removeAttribute('src');
    cover.alt = 'Kein Cover verfügbar';
    return;
  }

  state.textContent = `Quelle: ${metadata.verification_source || '-'} | Aktualisiert: ${fmtDate(metadata.last_checked_utc)}`;
  if (metadata.artwork_url) {
    cover.src = metadata.artwork_url;
    cover.alt = `${metadata.artist || ''} - ${metadata.title || ''}`.trim() || 'Cover';
  } else {
    cover.removeAttribute('src');
    cover.alt = 'Kein Cover verfügbar';
  }

  const items = [
    ['Veröffentlichung', fmtReleaseDate(metadata.release_date_utc)],
    ['Genre', metadata.genre || '-'],
    ['Album', metadata.album || '-'],
    ['Label', metadata.label || '-'],
    ['Dauer', fmtDuration(metadata.duration_ms)],
    ['ISRC', metadata.isrc || '-'],
    ['Chart (DE)', metadata.chart_single_rank ? `#${metadata.chart_single_rank}` : '-'],
    ['Vertrauen', Number.isFinite(metadata.verification_confidence) ? `${Math.round(metadata.verification_confidence * 100)}%` : '-']
  ];

  items.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'track-meta-item';
    const b = document.createElement('b');
    b.textContent = `${label}:`;
    row.appendChild(b);
    row.append(` ${value}`);
    list.appendChild(row);
  });

  if (metadata.external_url || metadata.preview_url || metadata.artwork_url) {
    const links = document.createElement('div');
    links.className = 'track-meta-item';
    const b = document.createElement('b');
    b.textContent = 'Links:';
    links.appendChild(b);

    const linkItems = [];
    if (metadata.external_url) linkItems.push({ href: metadata.external_url, label: 'Titel-Seite' });
    if (metadata.preview_url) linkItems.push({ href: metadata.preview_url, label: 'Vorhören' });
    if (metadata.artwork_url) linkItems.push({ href: metadata.artwork_url, label: 'Cover-Link' });

    linkItems.forEach((link, idx) => {
      links.append(' ');
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = link.label;
      links.appendChild(a);
      if (idx < linkItems.length - 1) links.append(' |');
    });
    list.appendChild(links);
  }
}

function renderLineChart(container, series, bucket = 'day', options = {}) {
  container.innerHTML = '';
  const rows = downsampleSeries(series || [], options.maxPoints || 220);
  if (!rows.length) {
    renderChartEmpty(container, 'Keine Daten im Zeitraum.');
    return;
  }

  appendChartStats(container, options.stats);

  const width = Math.max(900, rows.length * 26);
  const height = 260;
  const pad = { t: 18, r: 36, b: 50, l: 60 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...rows.map((s) => Number(s.plays || 0)), 1);
  const yAxis = buildNiceYAxis(maxY, 4);
  const step = rows.length > 1 ? w / (rows.length - 1) : 0;
  const svg = makeSvg(width, height);
  const axisColor = '#7f95aa';
  const gridColor = 'rgba(127,149,170,0.25)';
  const pointColor = options.color || '#0ea5a4';

  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t + h, x2: pad.l + w, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));

  yAxis.ticks.forEach((val) => {
    const y = pad.t + h - (val / yAxis.maxTick) * h;
    svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: y, x2: pad.l + w, y2: y, stroke: gridColor, 'stroke-width': 1 }));
    const label = makeSvgEl('text', { x: pad.l - 8, y: y + 4, 'font-size': 11, 'text-anchor': 'end' });
    label.textContent = formatPlays(val);
    svg.appendChild(label);
  });

  buildXTickIndexes(rows.length, 6).forEach((i, idx, all) => {
    const x = rows.length > 1 ? pad.l + i * step : pad.l + w / 2;
    svg.appendChild(makeSvgEl('line', { x1: x, y1: pad.t + h, x2: x, y2: pad.t + h + 4, stroke: axisColor }));
    const anchor = idx === 0 ? 'start' : idx === all.length - 1 ? 'end' : 'middle';
    const label = makeSvgEl('text', { x, y: pad.t + h + 17, 'font-size': 11, 'text-anchor': anchor });
    label.textContent = formatSeriesPeriod(rows[i]?.period, bucket, true);
    svg.appendChild(label);
  });

  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 8, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = 'Zeitraum';
  svg.appendChild(xLabel);

  const yLabel = makeSvgEl('text', {
    x: 16,
    y: pad.t + h / 2,
    'font-size': 12,
    'text-anchor': 'middle',
    transform: `rotate(-90 16 ${pad.t + h / 2})`
  });
  yLabel.textContent = 'Einsätze';
  svg.appendChild(yLabel);

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
    const area = makeSvgEl('path', {
      d: `${d.trim()} L ${last.x} ${pad.t + h} L ${first.x} ${pad.t + h} Z`,
      fill: 'rgba(20,184,166,0.12)',
      stroke: 'none'
    });
    svg.appendChild(area);
  }

  const path = makeSvgEl('path', {
    d: d.trim(),
    fill: 'none',
    stroke: pointColor,
    'stroke-width': 2.3
  });
  svg.appendChild(path);

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

function renderDailyBarChart(container, series, bucket = 'day', options = {}) {
  container.innerHTML = '';
  const rows = Array.isArray(series) ? series : [];
  if (!rows.length) {
    renderChartEmpty(container, 'Keine Tagesdaten im Zeitraum.');
    return;
  }

  appendChartStats(container, options.stats);

  const width = Math.max(900, rows.length * 24);
  const height = 260;
  const pad = { t: 16, r: 24, b: 52, l: 60 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...rows.map((row) => Number(row.plays || 0)), 1);
  const yAxis = buildNiceYAxis(maxY, 4);
  const step = rows.length > 1 ? w / (rows.length - 1) : 0;
  const barWidth = rows.length > 1 ? Math.max(4, Math.min(step * 0.7, 22)) : 28;
  const axisColor = '#7f95aa';
  const gridColor = 'rgba(127,149,170,0.25)';
  const barColor = '#f59e0b';
  const svg = makeSvg(width, height);

  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t + h, x2: pad.l + w, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));

  yAxis.ticks.forEach((val) => {
    const y = pad.t + h - (val / yAxis.maxTick) * h;
    svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: y, x2: pad.l + w, y2: y, stroke: gridColor, 'stroke-width': 1 }));
    const label = makeSvgEl('text', { x: pad.l - 8, y: y + 4, 'font-size': 11, 'text-anchor': 'end' });
    label.textContent = formatPlays(val);
    svg.appendChild(label);
  });

  buildXTickIndexes(rows.length, 7).forEach((i, idx, all) => {
    const x = rows.length > 1 ? pad.l + i * step : pad.l + w / 2;
    svg.appendChild(makeSvgEl('line', { x1: x, y1: pad.t + h, x2: x, y2: pad.t + h + 4, stroke: axisColor }));
    const anchor = idx === 0 ? 'start' : idx === all.length - 1 ? 'end' : 'middle';
    const label = makeSvgEl('text', { x, y: pad.t + h + 17, 'font-size': 11, 'text-anchor': anchor });
    label.textContent = formatSeriesPeriod(rows[i]?.period, bucket, true);
    svg.appendChild(label);
  });

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
      fill: barColor
    });
    svg.appendChild(rect);
    bindChartTooltip(container, rect, () => `${formatSeriesPeriod(row.period, bucket)}: ${formatPlays(val)} Einsätze`);
  });

  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 8, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = 'Zeitraum';
  svg.appendChild(xLabel);
  const yLabel = makeSvgEl('text', {
    x: 16,
    y: pad.t + h / 2,
    'font-size': 12,
    'text-anchor': 'middle',
    transform: `rotate(-90 16 ${pad.t + h / 2})`
  });
  yLabel.textContent = bucket === 'day' ? 'Einsätze / Tag' : 'Einsätze / Zeitraum';
  svg.appendChild(yLabel);

  container.appendChild(svg);
}

function renderSeriesByStationChart(container, rows, bucket = 'day') {
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
      `Für einen echten Verlauf bitte einen größeren Datumsbereich wählen.`;
    container.appendChild(hint);
    return;
  }

  const width = 940;
  const height = 300;
  const pad = { t: 16, r: 16, b: 56, l: 54 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(
    1,
    ...prepared.flatMap((row) => row.series.map((point) => Number(point.plays || 0)))
  );
  const step = periods.length > 1 ? w / (periods.length - 1) : w;
  const axisColor = '#7f95aa';
  const colors = ['#0ea5a4', '#f59e0b', '#ef4444', '#8b5cf6', '#22c55e', '#3b82f6', '#e11d48', '#14b8a6', '#f97316', '#6366f1'];
  const colorByStation = new Map(prepared.map((row, idx) => [row.stationId, colors[idx % colors.length]]));
  const svg = makeSvg(width, height);

  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t + h, x2: pad.l + w, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));

  const yTicks = 4;
  for (let i = 0; i <= yTicks; i += 1) {
    const val = Math.round((maxY * i) / yTicks);
    const y = pad.t + h - (h * i) / yTicks;
    svg.appendChild(makeSvgEl('line', { x1: pad.l - 4, y1: y, x2: pad.l, y2: y, stroke: axisColor }));
    const label = makeSvgEl('text', { x: pad.l - 8, y: y + 4, 'font-size': 11, 'text-anchor': 'end' });
    label.textContent = val.toLocaleString('de-DE');
    svg.appendChild(label);
  }

  const xTickIndexes = Array.from(new Set([0, Math.floor((periods.length - 1) / 2), periods.length - 1])).filter((i) => i >= 0);
  xTickIndexes.forEach((index) => {
    const x = pad.l + index * step;
    svg.appendChild(makeSvgEl('line', { x1: x, y1: pad.t + h, x2: x, y2: pad.t + h + 4, stroke: axisColor }));
    const label = makeSvgEl('text', { x, y: pad.t + h + 17, 'font-size': 11, 'text-anchor': 'middle' });
    label.textContent = formatSeriesPeriod(periods[index], bucket);
    svg.appendChild(label);
  });

  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 8, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = 'Zeitraum';
  svg.appendChild(xLabel);
  const yLabel = makeSvgEl('text', {
    x: 16,
    y: pad.t + h / 2,
    'font-size': 12,
    'text-anchor': 'middle',
    transform: `rotate(-90 16 ${pad.t + h / 2})`
  });
  yLabel.textContent = 'Einsätze';
  svg.appendChild(yLabel);

  prepared.forEach((row) => {
    const valueByPeriod = new Map(row.series.map((point) => [point.period, Number(point.plays || 0)]));
    const color = colorByStation.get(row.stationId) || '#0ea5a4';
    let pathData = '';
    const points = periods.map((period, index) => {
      const x = pad.l + index * step;
      const plays = Number(valueByPeriod.get(period) || 0);
      const y = pad.t + h - (plays / maxY) * h;
      pathData += `${index === 0 ? 'M' : 'L'} ${x} ${y} `;
      return { x, y, plays, period };
    });
    const path = makeSvgEl('path', {
      d: pathData.trim(),
      fill: 'none',
      stroke: color,
      'stroke-width': 2
    });
    svg.appendChild(path);

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
  legend.className = 'mt-2 d-flex flex-wrap gap-2';
  const visibleLegend = prepared.slice(0, 6);
  const hiddenCount = Math.max(0, prepared.length - visibleLegend.length);
  visibleLegend.forEach((row) => {
    const item = document.createElement('span');
    item.className = 'badge text-bg-light';
    const color = colorByStation.get(row.stationId) || '#0ea5a4';
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
    more.className = 'badge text-bg-secondary';
    more.textContent = `+${hiddenCount} weitere Sender`;
    legend.appendChild(more);
  }
  container.appendChild(legend);
}

function renderStationCompareChart(container, totalRows, yesterdayRows) {
  container.innerHTML = '';
  const totals = Array.isArray(totalRows) ? totalRows : [];
  const yRows = Array.isArray(yesterdayRows) ? yesterdayRows : [];
  if (!totals.length && !yRows.length) {
    container.textContent = 'Keine Senderdaten im Zeitraum.';
    return;
  }

  const totalMap = new Map(totals.map((row) => [
    row.station_id,
    {
      stationId: row.station_id,
      stationName: row.station_name || row.station_id,
      totalPlays: Number(row.plays || 0)
    }
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
    container.textContent = 'Keine Senderdaten im Zeitraum.';
    return;
  }

  const width = 980;
  const height = Math.max(320, rows.length * 32 + 72);
  const pad = { t: 18, r: 120, b: 30, l: 200 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(1, ...rows.map((row) => Math.max(row.totalPlays, row.yesterdayPlays)));
  const bar = h / rows.length;
  const svg = makeSvg(width, height);

  svg.appendChild(makeSvgEl('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + h, stroke: '#7f95aa', 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, x2: pad.l + w, y1: pad.t + h, y2: pad.t + h, stroke: '#7f95aa', 'stroke-width': 1 }));

  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const val = Math.round((max * i) / ticks);
    const x = pad.l + (w * i) / ticks;
    svg.appendChild(makeSvgEl('line', { x1: x, x2: x, y1: pad.t + h, y2: pad.t + h + 4, stroke: '#7f95aa' }));
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
      fill: '#f59e0b'
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
        fill: '#14b8a6'
      });
      svg.appendChild(yRect);
      bindChartTooltip(container, yRect, () => `${row.stationName}: Gestern ${row.yesterdayPlays.toLocaleString('de-DE')} Einsätze`);
    }

    const val = makeSvgEl('text', { x: pad.l + Math.max(2, totalW) + 6, y: y + barH / 2 + 4, 'font-size': 11 });
    val.textContent = `${row.totalPlays.toLocaleString('de-DE')} | G ${row.yesterdayPlays.toLocaleString('de-DE')}`;
    svg.appendChild(val);
  });

  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 6, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = 'Anzahl Einsätze';
  svg.appendChild(xLabel);

  const yLabel = makeSvgEl('text', {
    x: 16,
    y: pad.t + h / 2,
    'font-size': 12,
    'text-anchor': 'middle',
    transform: `rotate(-90 16 ${pad.t + h / 2})`
  });
  yLabel.textContent = 'Sender';
  svg.appendChild(yLabel);

  container.appendChild(svg);
  const legend = document.createElement('div');
  legend.className = 'text-secondary mt-2';
  legend.textContent = 'Orange = Gesamt im gewählten Zeitraum, Türkis = gestriger Tag';
  container.appendChild(legend);
}

function renderBarChart(container, rows) {
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

  const width = 980;
  const height = Math.max(340, prepared.length * 30 + 70);
  const longestLabel = prepared.reduce((maxLen, row) => Math.max(maxLen, row.stationName.length), 0);
  const padLeft = Math.min(280, Math.max(170, longestLabel * 7 + 24));
  const pad = { t: 18, r: 132, b: 30, l: padLeft };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...prepared.map((r) => r.plays), 1);
  const xAxis = buildNiceYAxis(max, 4);
  const bar = h / prepared.length;
  const svg = makeSvg(width, height);

  const axisY = makeSvgEl('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + h, stroke: '#7f95aa', 'stroke-width': 1 });
  svg.appendChild(axisY);

  const axisX = makeSvgEl('line', { x1: pad.l, x2: pad.l + w, y1: pad.t + h, y2: pad.t + h, stroke: '#7f95aa', 'stroke-width': 1 });
  svg.appendChild(axisX);

  xAxis.ticks.forEach((val) => {
    const x = pad.l + (val / xAxis.maxTick) * w;
    const grid = makeSvgEl('line', {
      x1: x,
      x2: x,
      y1: pad.t,
      y2: pad.t + h,
      stroke: 'rgba(127,149,170,0.22)',
      'stroke-width': 1
    });
    svg.appendChild(grid);

    const tick = makeSvgEl('line', { x1: x, x2: x, y1: pad.t + h, y2: pad.t + h + 4, stroke: '#7f95aa' });
    svg.appendChild(tick);

    const label = makeSvgEl('text', { x, y: pad.t + h + 16, 'font-size': 11, 'text-anchor': 'middle' });
    label.textContent = formatPlays(val);
    svg.appendChild(label);
  });

  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 6, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = 'Anzahl Einsätze';
  svg.appendChild(xLabel);

  const yLabel = makeSvgEl('text', {
    x: 16,
    y: pad.t + h / 2,
    'font-size': 12,
    'text-anchor': 'middle',
    transform: `rotate(-90 16 ${pad.t + h / 2})`
  });
  yLabel.textContent = 'Sender';
  svg.appendChild(yLabel);

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
      fill: '#f59e0b'
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

let stations = [];
let tracks = [];
let selectedTrack = null;
let newWeekRows = [];
const metadataRefreshAttempted = new Set();

function renderTrackList() {
  const tbody = qs('tracksTable').querySelector('tbody');
  tbody.innerHTML = '';

  if (!tracks.length) {
    qs('tracksState').textContent = 'Keine Treffer. Filter anpassen oder Ingest laufen lassen.';
    return;
  }

  qs('tracksState').textContent = `${tracks.length.toLocaleString('de-DE')} Titel gefunden.`;

  tracks.forEach((t) => {
    const tr = document.createElement('tr');
    if (selectedTrack?.track_key === t.track_key) tr.classList.add('selected');
    const td = document.createElement('td');
    const artist = document.createElement('strong');
    artist.textContent = t.artist || '-';
    const title = document.createElement('small');
    title.textContent = t.title || '-';
    const plays = document.createElement('small');
    plays.textContent = `${formatPlays(t.total_plays)} Einsätze`;
    td.appendChild(artist);
    td.appendChild(document.createElement('br'));
    td.appendChild(title);
    td.appendChild(document.createElement('br'));
    td.appendChild(plays);
    tr.appendChild(td);
    tr.addEventListener('click', () => {
      selectedTrack = t;
      renderTrackList();
      loadDetails();
    });
    tbody.appendChild(tr);
  });
}

function selectedStationName() {
  const stationId = qs('stationSelect').value;
  if (!stationId) return 'Alle';
  return stations.find((s) => s.id === stationId)?.name || stationId;
}

function renderOverview() {
  const totalPlays = tracks.reduce((sum, r) => sum + Number(r.total_plays || 0), 0);
  qs('ovTracks').textContent = Number(tracks.length || 0).toLocaleString('de-DE');
  qs('ovPlays').textContent = totalPlays.toLocaleString('de-DE');
  qs('ovNewWeek').textContent = Number(newWeekRows.length || 0).toLocaleString('de-DE');
  qs('ovStation').textContent = selectedStationName();

  const topList = qs('quickTopList');
  topList.innerHTML = '';
  const topRows = tracks.slice(0, 8);
  if (!topRows.length) {
    const li = document.createElement('li');
    li.textContent = 'Keine Treffer. Filter ändern oder später erneut laden.';
    topList.appendChild(li);
    return;
  }

  topRows.forEach((row) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'link-btn';
    button.type = 'button';
    const mainText = document.createTextNode(`${row.artist || '-'} - ${row.title || '-'} `);
    const small = document.createElement('small');
    small.textContent = `(${formatPlays(row.total_plays)})`;
    button.appendChild(mainText);
    button.appendChild(small);
    button.addEventListener('click', () => {
      selectedTrack = row;
      renderTrackList();
      loadDetails();
    });
    li.appendChild(button);
    topList.appendChild(li);
  });
}

async function loadStations() {
  stations = await apiFetch('/api/stations');
  const select = qs('stationSelect');
  select.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'Alle Sender';
  select.appendChild(allOption);
  stations.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
}

async function loadTracks() {
  const params = new URLSearchParams();
  params.set('limit', '120');
  const q = qs('searchInput').value.trim();
  const stationId = qs('stationSelect').value;
  if (q) params.set('q', q);
  if (stationId) params.set('stationId', stationId);

  tracks = await apiFetch(`/api/tracks?${params.toString()}`);
  if (!selectedTrack && requestedTrackKey) {
    selectedTrack = tracks.find((x) => x.track_key === requestedTrackKey) || {
      track_key: requestedTrackKey,
      artist: '',
      title: ''
    };
  }
  if (!selectedTrack && tracks.length) selectedTrack = tracks[0];
  if (selectedTrack) {
    selectedTrack = tracks.find((x) => x.track_key === selectedTrack.track_key) || selectedTrack || tracks[0] || null;
  }

  renderTrackList();
  await loadNewThisWeek();
  renderOverview();
  if (selectedTrack) {
    await loadDetails();
  } else {
    qs('selectedTitle').textContent = 'Titel-Details';
    qs('selectedMeta').textContent = 'Kein passender Titel gefunden. Bitte Sender oder Suchbegriff anpassen.';
    renderTrackMetadata(null);
    renderLineChart(qs('seriesChart'), [], qs('bucketSelect')?.value || 'day');
    renderDailyBarChart(qs('seriesByStationChart'), [], 'day');
    renderBarChart(qs('stationsChart'), []);
  }
}

async function loadNewThisWeek() {
  const params = new URLSearchParams();
  const stationId = qs('stationSelect').value;
  if (stationId) params.set('stationId', stationId);
  params.set('weekStart', weekStartBerlinIso(new Date()));
  params.set('limit', '12');
  params.set('releaseYear', String(berlinYear(new Date())));

  const data = await apiFetch(`/api/insights/new-this-week?${params.toString()}`);
  newWeekRows = data.rows || [];
  const ul = qs('newWeekList');
  ul.innerHTML = '';

  newWeekRows.slice(0, 12).forEach((r) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'link-btn';
    button.type = 'button';
    button.append(`${r.artist || '-'} - ${r.title || '-'} `);
    const small = document.createElement('small');
    small.textContent = `(${formatPlays(r.plays)})`;
    button.appendChild(small);
    button.addEventListener('click', () => {
      const hit = tracks.find((t) => t.track_key === r.track_key);
      if (hit) selectedTrack = hit;
      else selectedTrack = { track_key: r.track_key, artist: r.artist, title: r.title };
      renderTrackList();
      loadDetails();
    });
    li.appendChild(button);
    ul.appendChild(li);
  });

  if (!ul.children.length) {
    const li = document.createElement('li');
    li.textContent = 'Keine neuen Titel in dieser Woche.';
    ul.appendChild(li);
  }
}

async function loadDetails() {
  if (!selectedTrack) return;
  const trackKey = selectedTrack.track_key;
  if (!trackKey) return;

  const bucket = qs('bucketSelect').value || 'day';
  const range = getEffectiveDetailRange();
  if (!range) {
    qs('selectedMeta').textContent = 'Ungültiger Zeitraum. Bitte Von/Bis prüfen.';
    renderLineChart(qs('seriesChart'), [], bucket);
    renderDailyBarChart(qs('seriesByStationChart'), [], bucket);
    renderBarChart(qs('stationsChart'), []);
    return;
  }
  updateCutoffHint(range);

  const detailsParams = new URLSearchParams();
  detailsParams.set('bucket', bucket);
  detailsParams.set('from', range.fromIso);
  detailsParams.set('to', range.toIso);

  const periodParams = new URLSearchParams();
  periodParams.set('bucket', bucket);
  periodParams.set('from', range.fromIso);
  periodParams.set('to', range.toIso);

  const cumulativeParams = new URLSearchParams();
  cumulativeParams.set('bucket', bucket);
  cumulativeParams.set('from', '2000-01-01');
  cumulativeParams.set('to', range.toIso);

  const stationParams = new URLSearchParams();
  stationParams.set('from', range.fromIso);
  stationParams.set('to', range.toIso);

  let totals;
  let cumulativeSeries;
  let periodSeries;
  let stationsData;
  let metadata = null;
  try {
    [totals, cumulativeSeries, periodSeries, stationsData] = await Promise.all([
      apiFetch(`/api/tracks/${trackKey}/totals?${detailsParams.toString()}`),
      apiFetch(`/api/tracks/${trackKey}/series?${cumulativeParams.toString()}`),
      apiFetch(`/api/tracks/${trackKey}/series?${periodParams.toString()}`),
      apiFetch(`/api/tracks/${trackKey}/stations?${stationParams.toString()}`),
    ]);
  } catch (error) {
    const fallback = tracks[0] || null;
    if (requestedTrackKey && trackKey === requestedTrackKey) {
      qs('selectedTitle').textContent = 'Titel-Details';
      qs('selectedMeta').textContent = `Titel konnte nicht geladen werden (${error.message}).`;
      qs('totalToday').textContent = '-';
      qs('totalWeek').textContent = '-';
      qs('totalYear').textContent = '-';
      qs('totalAll').textContent = '-';
      renderTrackMetadata(null);
      renderLineChart(qs('seriesChart'), [], bucket);
      renderDailyBarChart(qs('seriesByStationChart'), [], bucket);
      renderBarChart(qs('stationsChart'), []);
      return;
    }
    if (fallback && fallback.track_key !== trackKey) {
      selectedTrack = fallback;
      renderTrackList();
      return loadDetails();
    }
    qs('selectedTitle').textContent = 'Titel-Details';
    qs('selectedMeta').textContent = `Keine Detaildaten für den gewählten Titel (${error.message}).`;
    qs('totalToday').textContent = '-';
    qs('totalWeek').textContent = '-';
    qs('totalYear').textContent = '-';
    qs('totalAll').textContent = '-';
    renderTrackMetadata(null);
    renderLineChart(qs('seriesChart'), [], bucket);
    renderDailyBarChart(qs('seriesByStationChart'), [], bucket);
    renderBarChart(qs('stationsChart'), []);
    return;
  }

  try {
    const metaResponse = await apiFetch(`/api/tracks/${trackKey}/meta`);
    metadata = metaResponse.metadata || null;
    const lastChecked = metadata?.last_checked_utc ? new Date(metadata.last_checked_utc) : null;
    const ageMs = lastChecked && !Number.isNaN(lastChecked.getTime()) ? (Date.now() - lastChecked.getTime()) : Number.POSITIVE_INFINITY;
    const needsRefresh = !metadata || ageMs > (7 * 24 * 60 * 60 * 1000);
    if (needsRefresh && !metadataRefreshAttempted.has(trackKey)) {
      metadataRefreshAttempted.add(trackKey);
      const refreshed = await apiFetch(`/api/tracks/${trackKey}/meta/refresh`, { method: 'POST' });
      metadata = refreshed.metadata || metadata;
    }
  } catch {
    metadata = null;
  }

  const identityArtist = totals.identity?.artist || selectedTrack.artist || '-';
  const identityTitle = totals.identity?.title || selectedTrack.title || '-';
  qs('selectedTitle').textContent = `${identityArtist} - ${identityTitle}`;
  qs('selectedMeta').textContent =
    `Titel-Schlüssel: ${trackKey} | Zeitraum: ${range.fromIso} bis ${range.toIso}${range.includeToday ? ' (inkl. heute)' : ' (bis gestern)'} | ` +
    `zuletzt: ${fmtDate(selectedTrack.last_played_at_utc)}`;

  qs('totalToday').textContent = Number(totals.totals?.today || 0).toLocaleString('de-DE');
  qs('totalWeek').textContent = Number(totals.totals?.thisWeek || 0).toLocaleString('de-DE');
  qs('totalYear').textContent = Number(totals.totals?.thisYear || 0).toLocaleString('de-DE');
  qs('totalAll').textContent = Number(totals.totals?.allTime || 0).toLocaleString('de-DE');
  renderTrackMetadata(metadata);

  const cumulativeRows = toCumulativeSeries(cumulativeSeries.series || []);
  const cumulativeStart = Number(cumulativeRows[0]?.plays || 0);
  const cumulativeEnd = Number(cumulativeRows[cumulativeRows.length - 1]?.plays || 0);
  renderLineChart(qs('seriesChart'), cumulativeRows, bucket, {
    showArea: true,
    color: '#0ea5a4',
    stats: [
      { label: 'Stand', value: `${formatPlays(cumulativeEnd)} Einsätze` },
      { label: 'Zuwachs', value: `+${formatPlays(Math.max(0, cumulativeEnd - cumulativeStart))}` },
      { label: 'Punkte', value: formatPlays(cumulativeRows.length) }
    ]
  });

  const rawPeriodRows = Array.isArray(periodSeries.series) ? periodSeries.series : [];
  const normalizedPeriodRows = bucket === 'day'
    ? fillDailySeriesRange(rawPeriodRows, range.fromIso, range.toIso)
    : rawPeriodRows;
  const totalInRange = normalizedPeriodRows.reduce((sum, row) => sum + Number(row.plays || 0), 0);
  const avgInRange = normalizedPeriodRows.length ? totalInRange / normalizedPeriodRows.length : 0;
  const peakPeriod = normalizedPeriodRows.reduce((best, row) => {
    const plays = Number(row.plays || 0);
    if (!best || plays > best.plays) return { period: row.period, plays };
    return best;
  }, null);

  renderDailyBarChart(qs('seriesByStationChart'), normalizedPeriodRows, bucket, {
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
  renderBarChart(qs('stationsChart'), stationsData.stations || []);
}

function setDefaultDates() {
  const toIso = berlinTodayIsoDate();
  const fromIso = shiftBerlinIsoDate(toIso, -90);
  qs('fromInput').value = fromIso;
  qs('toInput').value = toIso;
  if (qs('includeTodayInput')) qs('includeTodayInput').checked = false;
  updateCutoffHint(getEffectiveDetailRange());
}

function getEffectiveDetailRange() {
  const includeToday = Boolean(qs('includeTodayInput')?.checked);
  const todayIso = berlinTodayIsoDate();
  const yesterdayIso = berlinYesterdayIsoDate();
  const fromIso = qs('fromInput').value || shiftBerlinIsoDate(todayIso, -90);
  const inputToIso = qs('toInput').value || todayIso;
  const maxToIso = includeToday ? todayIso : yesterdayIso;
  const toIso = inputToIso > maxToIso ? maxToIso : inputToIso;
  const wasCapped = inputToIso > maxToIso;
  if (!fromIso || !toIso || fromIso > toIso) return null;
  return { fromIso, toIso, inputToIso, includeToday, wasCapped };
}

function updateCutoffHint(range) {
  const hint = qs('cutoffHint');
  if (!hint) return;
  if (!range) {
    hint.textContent = 'Bitte gültigen Zeitraum wählen.';
    return;
  }
  if (range.includeToday) {
    hint.textContent = `Zeitraum aktiv: ${range.fromIso} bis ${range.toIso} (laufender Tag eingeschlossen).`;
    return;
  }
  if (range.wasCapped) {
    hint.textContent = `Bis-Datum wurde auf gestern (${range.toIso}) gekürzt, damit der laufende Tag die Auswertung nicht verzerrt.`;
    return;
  }
  hint.textContent = `Zeitraum aktiv: ${range.fromIso} bis ${range.toIso} (bis gestern).`;
}

function applyQuickRange(rangeId) {
  const includeToday = Boolean(qs('includeTodayInput')?.checked);
  const endIso = includeToday ? berlinTodayIsoDate() : berlinYesterdayIsoDate();
  let startIso = shiftBerlinIsoDate(endIso, -89);
  if (rangeId === '7') startIso = shiftBerlinIsoDate(endIso, -6);
  if (rangeId === '30') startIso = shiftBerlinIsoDate(endIso, -29);
  if (rangeId === '90') startIso = shiftBerlinIsoDate(endIso, -89);
  if (rangeId === 'ytd') startIso = `${endIso.slice(0, 4)}-01-01`;

  qs('fromInput').value = startIso;
  qs('toInput').value = endIso;
  updateCutoffHint(getEffectiveDetailRange());
  return loadDetails();
}

function debounce(fn, delay = 280) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function runSafe(action, onError) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (onError) onError(message);
  }
}

async function init() {
  applyTheme();
  qs('themeToggle').addEventListener('click', toggleTheme);
  setDefaultDates();
  if (focusedTrackMode) {
    qs('overviewCard')?.classList.add('hidden');
    qs('quickListsSection')?.classList.add('hidden');
  }
  await runSafe(loadStations, (msg) => {
    qs('tracksState').textContent = `Fehler beim Laden der Sender: ${msg}`;
  });
  await runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  });

  qs('refreshTracksBtn').addEventListener('click', () => runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  }));
  qs('refreshDetailsBtn').addEventListener('click', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('stationSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  }));
  qs('bucketSelect').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('fromInput').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('toInput').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('includeTodayInput').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('searchInput').addEventListener('input', debounce(() => runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  })));
  document.querySelectorAll('.range-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const rangeId = button.getAttribute('data-range');
      runSafe(() => applyQuickRange(rangeId), (msg) => {
        qs('selectedMeta').textContent = `Fehler bei den Diagrammdaten: ${msg}`;
      });
    });
  });
}

init().catch((error) => {
  qs('tracksState').textContent = `Fehler: ${error.message}`;
});
