const qs = (id) => document.getElementById(id);
const getQueryTrackKey = () => new URLSearchParams(window.location.search).get('trackKey');
const requestedTrackKey = getQueryTrackKey();
const focusedTrackMode = Boolean(getQueryTrackKey());

function applyTheme() {
  const saved = localStorage.getItem('juka-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-bs-theme', theme);
  qs('themeToggle').textContent = theme === 'dark' ? 'Light' : 'Dark';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('juka-theme', next);
  qs('themeToggle').textContent = next === 'dark' ? 'Light' : 'Dark';
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function weekStartIso(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
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
    const x = event.clientX - rect.left + 10;
    const y = event.clientY - rect.top - 26;
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  };
  const hide = () => {
    tooltip.style.opacity = '0';
  };
  target.addEventListener('mousemove', show);
  target.addEventListener('mouseenter', show);
  target.addEventListener('mouseleave', hide);
}

function formatSeriesPeriod(period, bucket) {
  if (!period) return '-';
  if (bucket === 'day') {
    const [y, m, d] = period.split('-');
    return `${d}.${m}.${y}`;
  }
  return period;
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
    ['Release', fmtReleaseDate(metadata.release_date_utc)],
    ['Genre', metadata.genre || '-'],
    ['Album', metadata.album || '-'],
    ['Label', metadata.label || '-'],
    ['Dauer', fmtDuration(metadata.duration_ms)],
    ['ISRC', metadata.isrc || '-'],
    ['Chart (DE)', metadata.chart_single_rank ? `#${metadata.chart_single_rank}` : '-'],
    ['Confidence', Number.isFinite(metadata.verification_confidence) ? `${Math.round(metadata.verification_confidence * 100)}%` : '-']
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
    if (metadata.external_url) linkItems.push({ href: metadata.external_url, label: 'Track-Seite' });
    if (metadata.preview_url) linkItems.push({ href: metadata.preview_url, label: 'Preview' });
    if (metadata.artwork_url) linkItems.push({ href: metadata.artwork_url, label: 'Cover-URL' });

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

function renderLineChart(container, series, bucket = 'day') {
  container.innerHTML = '';
  if (!series?.length) {
    container.textContent = 'Keine Daten im Zeitraum.';
    return;
  }

  const width = 900;
  const height = 250;
  const pad = { t: 18, r: 16, b: 46, l: 54 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...series.map((s) => Number(s.plays || 0)), 1);
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const svg = makeSvg(width, height);
  const axisColor = '#7f95aa';
  const pointColor = '#0ea5a4';

  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));
  svg.appendChild(makeSvgEl('line', { x1: pad.l, y1: pad.t + h, x2: pad.l + w, y2: pad.t + h, stroke: axisColor, 'stroke-width': 1 }));

  const tickCountY = 4;
  for (let i = 0; i <= tickCountY; i += 1) {
    const val = Math.round((maxY * i) / tickCountY);
    const y = pad.t + h - (h * i) / tickCountY;
    svg.appendChild(makeSvgEl('line', { x1: pad.l - 4, y1: y, x2: pad.l, y2: y, stroke: axisColor }));
    const label = makeSvgEl('text', { x: pad.l - 8, y: y + 4, 'font-size': 11, 'text-anchor': 'end' });
    label.textContent = val.toLocaleString('de-DE');
    svg.appendChild(label);
  }

  const xTickIndexes = Array.from(new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])).filter((i) => i >= 0);
  xTickIndexes.forEach((i) => {
    const x = pad.l + i * step;
    svg.appendChild(makeSvgEl('line', { x1: x, y1: pad.t + h, x2: x, y2: pad.t + h + 4, stroke: axisColor }));
    const label = makeSvgEl('text', { x, y: pad.t + h + 17, 'font-size': 11, 'text-anchor': 'middle' });
    label.textContent = formatSeriesPeriod(series[i]?.period, bucket);
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
  yLabel.textContent = 'Plays';
  svg.appendChild(yLabel);

  let d = '';
  const points = [];
  series.forEach((p, i) => {
    const x = pad.l + i * step;
    const y = pad.t + h - (Number(p.plays || 0) / maxY) * h;
    points.push({ x, y, period: p.period, plays: Number(p.plays || 0) });
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  });

  const path = makeSvgEl('path', {
    d: d.trim(),
    fill: 'none',
    stroke: pointColor,
    'stroke-width': 2.3
  });
  svg.appendChild(path);

  points.forEach((p) => {
    const dot = makeSvgEl('circle', { cx: p.x, cy: p.y, r: 3.8, fill: pointColor });
    svg.appendChild(dot);
    bindChartTooltip(container, dot, () => `${formatSeriesPeriod(p.period, bucket)}: ${p.plays.toLocaleString('de-DE')} Plays`);
  });

  container.appendChild(svg);
}

function renderBarChart(container, rows) {
  container.innerHTML = '';
  if (!rows?.length) {
    container.textContent = 'Keine Senderdaten im Zeitraum.';
    return;
  }

  const width = 980;
  const height = Math.max(320, rows.length * 28 + 56);
  const pad = { t: 16, r: 80, b: 26, l: 190 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(...rows.map((r) => Number(r.plays || 0)), 1);
  const bar = h / rows.length;
  const svg = makeSvg(width, height);

  const axisY = makeSvgEl('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + h, stroke: '#7f95aa', 'stroke-width': 1 });
  svg.appendChild(axisY);

  const axisX = makeSvgEl('line', { x1: pad.l, x2: pad.l + w, y1: pad.t + h, y2: pad.t + h, stroke: '#7f95aa', 'stroke-width': 1 });
  svg.appendChild(axisX);

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i += 1) {
    const val = Math.round((max * i) / tickCount);
    const x = pad.l + (w * i) / tickCount;

    const tick = makeSvgEl('line', { x1: x, x2: x, y1: pad.t + h, y2: pad.t + h + 4, stroke: '#7f95aa' });
    svg.appendChild(tick);

    const label = makeSvgEl('text', { x, y: pad.t + h + 16, 'font-size': 11, 'text-anchor': 'middle' });
    label.textContent = val.toLocaleString('de-DE');
    svg.appendChild(label);
  }

  const xLabel = makeSvgEl('text', { x: pad.l + w / 2, y: height - 6, 'font-size': 12, 'text-anchor': 'middle' });
  xLabel.textContent = 'Anzahl Plays';
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

  rows.forEach((row, i) => {
    const y = pad.t + i * bar + 4;
    const bw = (Number(row.plays || 0) / max) * (w - 8);

    const stationName = row.station_name || row.station_id;
    const playsValue = Number(row.plays || 0).toLocaleString('de-DE');

    const label = makeSvgEl('text', { x: 6, y: y + bar / 2 + 4, 'font-size': 12 });
    label.textContent = row.station_name || row.station_id;

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
    val.textContent = playsValue;

    svg.appendChild(label);
    svg.appendChild(rect);
    svg.appendChild(val);
    bindChartTooltip(container, rect, () => `${stationName}: ${playsValue} Plays`);
  });

  container.appendChild(svg);
}

let stations = [];
let tracks = [];
let selectedTrack = null;
let newWeekRows = [];

function renderTrackList() {
  const tbody = qs('tracksTable').querySelector('tbody');
  tbody.innerHTML = '';

  if (!tracks.length) {
    qs('tracksState').textContent = 'Keine Tracks gefunden.';
    return;
  }

  qs('tracksState').textContent = `${tracks.length} Tracks`;

  tracks.forEach((t) => {
    const tr = document.createElement('tr');
    if (selectedTrack?.track_key === t.track_key) tr.classList.add('selected');
    tr.innerHTML = `<td><strong>${t.artist}</strong><br><small>${t.title}</small><br><small>${Number(t.total_plays || 0).toLocaleString('de-DE')} Plays</small></td>`;
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
    topList.innerHTML = '<li>Keine Treffer.</li>';
    return;
  }

  topRows.forEach((row) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="link-btn" type="button">${row.artist} - ${row.title} <small>(${Number(row.total_plays || 0).toLocaleString('de-DE')})</small></button>`;
    li.querySelector('button').addEventListener('click', () => {
      selectedTrack = row;
      renderTrackList();
      loadDetails();
    });
    topList.appendChild(li);
  });
}

async function loadStations() {
  stations = await apiFetch('/api/stations');
  const select = qs('stationSelect');
  select.innerHTML = '<option value="">Alle Sender</option>';
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
    qs('selectedTitle').textContent = 'Song-Details';
    qs('selectedMeta').textContent = 'Kein passender Song im aktuellen Filter gefunden.';
    renderTrackMetadata(null);
    renderLineChart(qs('seriesChart'), [], qs('bucketSelect')?.value || 'day');
    renderBarChart(qs('stationsChart'), []);
  }
}

async function loadNewThisWeek() {
  const params = new URLSearchParams();
  const stationId = qs('stationSelect').value;
  if (stationId) params.set('stationId', stationId);
  params.set('weekStart', weekStartIso());
  params.set('limit', '12');

  const data = await apiFetch(`/api/insights/new-this-week?${params.toString()}`);
  newWeekRows = data.rows || [];
  const ul = qs('newWeekList');
  ul.innerHTML = '';

  newWeekRows.slice(0, 12).forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="link-btn" type="button">${r.artist} - ${r.title} <small>(${Number(r.plays || 0).toLocaleString('de-DE')})</small></button>`;
    li.querySelector('button').addEventListener('click', () => {
      const hit = tracks.find((t) => t.track_key === r.track_key);
      if (hit) selectedTrack = hit;
      else selectedTrack = { track_key: r.track_key, artist: r.artist, title: r.title };
      renderTrackList();
      loadDetails();
    });
    ul.appendChild(li);
  });

  if (!ul.children.length) {
    ul.innerHTML = '<li>Keine neuen Tracks.</li>';
  }
}

async function loadDetails() {
  if (!selectedTrack) return;
  const trackKey = selectedTrack.track_key;
  if (!trackKey) return;

  const params = new URLSearchParams();
  const stationId = qs('stationSelect').value;
  const bucket = qs('bucketSelect').value;
  if (stationId) params.set('stationId', stationId);
  params.set('bucket', bucket);
  if (qs('fromInput').value) params.set('from', qs('fromInput').value);
  if (qs('toInput').value) params.set('to', qs('toInput').value);

  let totals;
  let series;
  let stationsData;
  let metadata = null;
  try {
    [totals, series, stationsData] = await Promise.all([
      apiFetch(`/api/tracks/${trackKey}/totals?${params.toString()}`),
      apiFetch(`/api/tracks/${trackKey}/series?${params.toString()}`),
      apiFetch(`/api/tracks/${trackKey}/stations?${params.toString()}`)
    ]);
  } catch (error) {
    const fallback = tracks[0] || null;
    if (requestedTrackKey && trackKey === requestedTrackKey) {
      qs('selectedTitle').textContent = 'Song-Details';
      qs('selectedMeta').textContent = `Track konnte nicht geladen werden (${error.message}).`;
      qs('totalToday').textContent = '-';
      qs('totalWeek').textContent = '-';
      qs('totalYear').textContent = '-';
      qs('totalAll').textContent = '-';
      renderTrackMetadata(null);
      renderLineChart(qs('seriesChart'), [], bucket);
      renderBarChart(qs('stationsChart'), []);
      return;
    }
    if (fallback && fallback.track_key !== trackKey) {
      selectedTrack = fallback;
      renderTrackList();
      return loadDetails();
    }
    qs('selectedTitle').textContent = 'Song-Details';
    qs('selectedMeta').textContent = `Keine Detaildaten für den gewählten Song (${error.message}).`;
    qs('totalToday').textContent = '-';
    qs('totalWeek').textContent = '-';
    qs('totalYear').textContent = '-';
    qs('totalAll').textContent = '-';
    renderTrackMetadata(null);
    renderLineChart(qs('seriesChart'), [], bucket);
    renderBarChart(qs('stationsChart'), []);
    return;
  }

  try {
    const metaResponse = await apiFetch(`/api/tracks/${trackKey}/meta/refresh`, { method: 'POST' });
    metadata = metaResponse.metadata || null;
  } catch {
    metadata = null;
  }

  const identityArtist = totals.identity?.artist || selectedTrack.artist || '-';
  const identityTitle = totals.identity?.title || selectedTrack.title || '-';
  qs('selectedTitle').textContent = `${identityArtist} - ${identityTitle}`;
  qs('selectedMeta').textContent = `Track Key: ${trackKey} | zuletzt: ${fmtDate(selectedTrack.last_played_at_utc)}`;

  qs('totalToday').textContent = Number(totals.totals?.today || 0).toLocaleString('de-DE');
  qs('totalWeek').textContent = Number(totals.totals?.thisWeek || 0).toLocaleString('de-DE');
  qs('totalYear').textContent = Number(totals.totals?.thisYear || 0).toLocaleString('de-DE');
  qs('totalAll').textContent = Number(totals.totals?.allTime || 0).toLocaleString('de-DE');
  renderTrackMetadata(metadata);

  renderLineChart(qs('seriesChart'), series.series || [], bucket);
  renderBarChart(qs('stationsChart'), stationsData.stations || []);
}

function setDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 90);
  qs('fromInput').value = from.toISOString().slice(0, 10);
  qs('toInput').value = to.toISOString().slice(0, 10);
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
    qs('tracksState').textContent = `Fehler: ${msg}`;
  });

  qs('refreshBtn').addEventListener('click', () => runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler: ${msg}`;
  }));
  qs('stationSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler: ${msg}`;
  }));
  qs('bucketSelect').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler: ${msg}`;
  }));
  qs('fromInput').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler: ${msg}`;
  }));
  qs('toInput').addEventListener('change', () => runSafe(loadDetails, (msg) => {
    qs('selectedMeta').textContent = `Fehler: ${msg}`;
  }));
  qs('searchInput').addEventListener('input', debounce(() => runSafe(loadTracks, (msg) => {
    qs('tracksState').textContent = `Fehler: ${msg}`;
  })));
}

init().catch((error) => {
  qs('tracksState').textContent = `Fehler: ${error.message}`;
});
