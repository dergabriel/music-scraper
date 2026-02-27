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

function makeSvg(width, height) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return svg;
}

function renderLineChart(container, series) {
  container.innerHTML = '';
  if (!series?.length) {
    container.textContent = 'Keine Daten im Zeitraum.';
    return;
  }

  const width = 900;
  const height = 250;
  const pad = { t: 16, r: 16, b: 28, l: 34 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...series.map((s) => Number(s.plays || 0)), 1);
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const svg = makeSvg(width, height);

  let d = '';
  series.forEach((p, i) => {
    const x = pad.l + i * step;
    const y = pad.t + h - (Number(p.plays || 0) / maxY) * h;
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#0ea5a4');
  path.setAttribute('stroke-width', '2.3');
  svg.appendChild(path);

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

  const axisY = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  axisY.setAttribute('x1', String(pad.l));
  axisY.setAttribute('x2', String(pad.l));
  axisY.setAttribute('y1', String(pad.t));
  axisY.setAttribute('y2', String(pad.t + h));
  axisY.setAttribute('stroke', '#7f95aa');
  axisY.setAttribute('stroke-width', '1');
  svg.appendChild(axisY);

  const axisX = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  axisX.setAttribute('x1', String(pad.l));
  axisX.setAttribute('x2', String(pad.l + w));
  axisX.setAttribute('y1', String(pad.t + h));
  axisX.setAttribute('y2', String(pad.t + h));
  axisX.setAttribute('stroke', '#7f95aa');
  axisX.setAttribute('stroke-width', '1');
  svg.appendChild(axisX);

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i += 1) {
    const val = Math.round((max * i) / tickCount);
    const x = pad.l + (w * i) / tickCount;

    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', String(x));
    tick.setAttribute('x2', String(x));
    tick.setAttribute('y1', String(pad.t + h));
    tick.setAttribute('y2', String(pad.t + h + 4));
    tick.setAttribute('stroke', '#7f95aa');
    svg.appendChild(tick);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(pad.t + h + 16));
    label.setAttribute('font-size', '11');
    label.setAttribute('text-anchor', 'middle');
    label.textContent = val.toLocaleString('de-DE');
    svg.appendChild(label);
  }

  rows.forEach((row, i) => {
    const y = pad.t + i * bar + 4;
    const bw = (Number(row.plays || 0) / max) * (w - 8);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '6');
    label.setAttribute('y', String(y + bar / 2 + 4));
    label.setAttribute('font-size', '12');
    label.textContent = row.station_name || row.station_id;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(pad.l));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(Math.max(2, bw)));
    rect.setAttribute('height', String(Math.max(12, bar - 8)));
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', '#f59e0b');

    const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    val.setAttribute('x', String(pad.l + Math.max(2, bw) + 6));
    val.setAttribute('y', String(y + Math.max(10, bar - 8) / 2 + 4));
    val.setAttribute('font-size', '11');
    val.textContent = Number(row.plays || 0).toLocaleString('de-DE');

    svg.appendChild(label);
    svg.appendChild(rect);
    svg.appendChild(val);
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
    renderLineChart(qs('seriesChart'), []);
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
      renderLineChart(qs('seriesChart'), []);
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
    renderLineChart(qs('seriesChart'), []);
    renderBarChart(qs('stationsChart'), []);
    return;
  }

  const identityArtist = totals.identity?.artist || selectedTrack.artist || '-';
  const identityTitle = totals.identity?.title || selectedTrack.title || '-';
  qs('selectedTitle').textContent = `${identityArtist} - ${identityTitle}`;
  qs('selectedMeta').textContent = `Track Key: ${trackKey} | zuletzt: ${fmtDate(selectedTrack.last_played_at_utc)}`;

  qs('totalToday').textContent = Number(totals.totals?.today || 0).toLocaleString('de-DE');
  qs('totalWeek').textContent = Number(totals.totals?.thisWeek || 0).toLocaleString('de-DE');
  qs('totalYear').textContent = Number(totals.totals?.thisYear || 0).toLocaleString('de-DE');
  qs('totalAll').textContent = Number(totals.totals?.allTime || 0).toLocaleString('de-DE');

  renderLineChart(qs('seriesChart'), series.series || []);
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
