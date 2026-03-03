import { weekStartBerlinIso } from './date-berlin.js';

const qs = (id) => document.getElementById(id);

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
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('de-DE') : '-';
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

function fmtPlaysPerDay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function sortRows(rows, sortMode) {
  const out = [...rows];
  const valueNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const valueTime = (v) => {
    const t = Date.parse(v || '');
    return Number.isFinite(t) ? t : 0;
  };
  const valueText = (v) => String(v || '').toLocaleLowerCase('de-DE');

  switch (sortMode) {
    case 'plays_per_day_asc':
      out.sort((a, b) => valueNum(a.plays_per_day) - valueNum(b.plays_per_day) || valueNum(a.total_plays) - valueNum(b.total_plays));
      break;
    case 'total_plays_desc':
      out.sort((a, b) => valueNum(b.total_plays) - valueNum(a.total_plays) || valueNum(b.plays_per_day) - valueNum(a.plays_per_day));
      break;
    case 'total_plays_asc':
      out.sort((a, b) => valueNum(a.total_plays) - valueNum(b.total_plays) || valueNum(a.plays_per_day) - valueNum(b.plays_per_day));
      break;
    case 'last_played_desc':
      out.sort((a, b) => valueTime(b.last_played_at_utc) - valueTime(a.last_played_at_utc));
      break;
    case 'last_played_asc':
      out.sort((a, b) => valueTime(a.last_played_at_utc) - valueTime(b.last_played_at_utc));
      break;
    case 'artist_asc':
      out.sort((a, b) => valueText(a.artist).localeCompare(valueText(b.artist), 'de-DE'));
      break;
    case 'artist_desc':
      out.sort((a, b) => valueText(b.artist).localeCompare(valueText(a.artist), 'de-DE'));
      break;
    case 'plays_per_day_desc':
    default:
      out.sort((a, b) => valueNum(b.plays_per_day) - valueNum(a.plays_per_day) || valueNum(b.total_plays) - valueNum(a.total_plays));
      break;
  }

  return out;
}

async function loadStations() {
  const rows = await apiFetch('/api/stations');
  const stationSelect = qs('stationSelect');
  const reportSelect = qs('reportStationSelect');
  stationSelect.innerHTML = '';
  reportSelect.innerHTML = '';

  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Alle Sender';
  stationSelect.appendChild(allOpt);

  const reportOpt = document.createElement('option');
  reportOpt.value = '';
  reportOpt.textContent = 'Bitte wählen';
  reportSelect.appendChild(reportOpt);

  rows.forEach((station) => {
    const a = document.createElement('option');
    a.value = station.id;
    a.textContent = station.name;
    stationSelect.appendChild(a);

    const b = document.createElement('option');
    b.value = station.id;
    b.textContent = station.name;
    reportSelect.appendChild(b);
  });
}

function renderStats(rows) {
  const totalPlays = rows.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
  const uniqueArtists = new Set(rows.map((row) => String(row.artist || '').trim()).filter(Boolean)).size;
  const top = rows[0] ? `${rows[0].artist || '-'} - ${rows[0].title || '-'}` : '-';

  qs('statsHits').textContent = fmtNumber(rows.length);
  qs('statsPlays').textContent = fmtNumber(totalPlays);
  qs('statsArtists').textContent = fmtNumber(uniqueArtists);
  qs('statsTopTrack').textContent = top;
}

function renderRows(rows) {
  const tbody = qs('tracksTable').querySelector('tbody');
  tbody.innerHTML = '';

  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const tdTrack = document.createElement('td');
    const artist = document.createElement('strong');
    artist.textContent = row.artist || '-';
    const title = document.createElement('small');
    title.textContent = row.title || '-';
    tdTrack.appendChild(artist);
    tdTrack.appendChild(document.createElement('br'));
    tdTrack.appendChild(title);

    const tdPlays = document.createElement('td');
    tdPlays.textContent = fmtNumber(row.total_plays);

    const tdPerDay = document.createElement('td');
    tdPerDay.textContent = fmtPlaysPerDay(row.plays_per_day);

    const tdFirst = document.createElement('td');
    tdFirst.textContent = fmtDate(row.first_played_at_utc);

    const tdLast = document.createElement('td');
    tdLast.textContent = fmtDate(row.last_played_at_utc);

    const tdOpen = document.createElement('td');
    const link = document.createElement('a');
    link.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`;
    link.textContent = 'Öffnen';
    tdOpen.appendChild(link);

    tr.appendChild(tdTrack);
    tr.appendChild(tdPlays);
    tr.appendChild(tdPerDay);
    tr.appendChild(tdFirst);
    tr.appendChild(tdLast);
    tr.appendChild(tdOpen);

    tbody.appendChild(tr);
  });
}

async function loadTracks() {
  const params = new URLSearchParams();
  const selectedLimit = qs('limitSelect').value;
  if (selectedLimit) params.set('limit', selectedLimit === 'all' ? 'all' : selectedLimit);

  const query = qs('searchInput').value.trim();
  const stationId = qs('stationSelect').value;
  const sortMode = qs('sortSelect').value || 'plays_per_day_desc';
  if (query) params.set('q', query);
  if (stationId) params.set('stationId', stationId);

  qs('state').textContent = 'Lade Titel...';
  const rows = sortRows(await apiFetch(`/api/tracks?${params.toString()}`), sortMode);
  renderRows(rows);
  renderStats(rows);

  qs('state').textContent = rows.length
    ? `${fmtNumber(rows.length)} Titel geladen.`
    : 'Keine Titel gefunden. Filter ändern oder Ingest laufen lassen.';
}

function renderReportContent(report) {
  const container = qs('reportContent');
  container.innerHTML = '';

  const pTotal = document.createElement('p');
  const totalLabel = document.createElement('strong');
  totalLabel.textContent = 'Gesamt-Einsätze:';
  pTotal.appendChild(totalLabel);
  pTotal.append(` ${fmtNumber(report.totalPlays || 0)}`);

  const pUnique = document.createElement('p');
  const uniqueLabel = document.createElement('strong');
  uniqueLabel.textContent = 'Eindeutige Titel:';
  pUnique.appendChild(uniqueLabel);
  pUnique.append(` ${fmtNumber(report.uniqueTracks || 0)}`);

  const pNew = document.createElement('p');
  const newLabel = document.createElement('strong');
  newLabel.textContent = 'Neu:';
  pNew.appendChild(newLabel);
  pNew.append(` ${fmtNumber(report.newTracks?.length || 0)}`);

  const pDropped = document.createElement('p');
  const droppedLabel = document.createElement('strong');
  droppedLabel.textContent = 'Nicht mehr aktiv:';
  pDropped.appendChild(droppedLabel);
  pDropped.append(` ${fmtNumber(report.droppedTracks?.length || 0)}`);

  const heading = document.createElement('h3');
  heading.textContent = 'Beste 10';

  const list = document.createElement('ol');
  const topRows = Array.isArray(report.topTracks) ? report.topTracks.slice(0, 10) : [];
  if (!topRows.length) {
    const li = document.createElement('li');
    li.textContent = 'Keine Daten';
    list.appendChild(li);
  } else {
    topRows.forEach((track) => {
      const li = document.createElement('li');
      li.textContent = `${track.artist || '-'} - ${track.title || '-'} (${fmtNumber(track.count)})`;
      list.appendChild(li);
    });
  }

  container.appendChild(pTotal);
  container.appendChild(pUnique);
  container.appendChild(pNew);
  container.appendChild(pDropped);
  container.appendChild(heading);
  container.appendChild(list);
}

async function loadStationReport() {
  const stationId = qs('reportStationSelect').value;
  const weekStart = qs('weekStartInput').value;
  if (!stationId) {
    qs('reportState').textContent = 'Bitte einen Sender wählen.';
    qs('reportWeekNew').textContent = 'Neu diese Woche: -';
    qs('reportContent').textContent = 'Noch keine Daten.';
    return;
  }

  qs('reportState').textContent = 'Lade Senderbericht...';
  const data = await apiFetch(`/api/reports/station/${encodeURIComponent(stationId)}?weekStart=${encodeURIComponent(weekStart)}`);
  const report = data.report;

  qs('reportState').textContent = `${report.station.name} | Woche ab ${data.weekStart}`;
  qs('reportWeekNew').textContent = `Neu diese Woche: ${fmtNumber(report.newTracks?.length || 0)}`;
  renderReportContent(report);
}

async function mergeTracksManually() {
  const winnerTrackKey = qs('winnerTrackKeyInput')?.value?.trim() || '';
  const loserTrackKey = qs('loserTrackKeyInput')?.value?.trim() || '';
  const state = qs('mergeState');
  if (!winnerTrackKey || !loserTrackKey) {
    if (state) state.textContent = 'Bitte beide Track Keys ausfüllen.';
    return;
  }
  if (winnerTrackKey === loserTrackKey) {
    if (state) state.textContent = 'Winner und Loser dürfen nicht identisch sein.';
    return;
  }

  if (state) state.textContent = 'Merge läuft...';
  const result = await apiFetch('/api/admin/merge-tracks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ winnerTrackKey, loserTrackKey })
  });
  if (state) {
    state.textContent =
      `Merge erfolgreich: ${fmtNumber(result.playsUpdated)} Plays verschoben, ${fmtNumber(result.dailyRowsRebuilt)} Daily-Zeilen neu aufgebaut.`;
  }
  await loadTracks();
}

function debounce(fn, delay = 250) {
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
  qs('weekStartInput').value = weekStartBerlinIso(new Date());

  await runSafe(loadStations, (msg) => {
    qs('state').textContent = `Fehler beim Laden der Sender: ${msg}`;
  });
  await runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  });

  qs('searchInput').addEventListener('input', debounce(() => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  })));
  qs('stationSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('limitSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('sortSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('loadBtn').addEventListener('click', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('loadReportBtn').addEventListener('click', () => runSafe(loadStationReport, (msg) => {
    qs('reportState').textContent = `Fehler beim Laden des Berichts: ${msg}`;
  }));
  qs('reportStationSelect').addEventListener('change', () => runSafe(loadStationReport, (msg) => {
    qs('reportState').textContent = `Fehler beim Laden des Berichts: ${msg}`;
  }));
  qs('mergeTracksBtn')?.addEventListener('click', () => runSafe(mergeTracksManually, (msg) => {
    const mergeState = qs('mergeState');
    if (mergeState) mergeState.textContent = `Merge fehlgeschlagen: ${msg}`;
  }));
}

init().catch((error) => {
  qs('state').textContent = `Fehler: ${error.message}`;
  if (qs('reportWeekNew')) qs('reportWeekNew').textContent = 'Neu diese Woche: -';
});
