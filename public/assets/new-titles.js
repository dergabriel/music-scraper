import {
  berlinIsoDate,
  berlinTodayIsoDate,
  shiftBerlinIsoDate
} from './date-berlin.js';

const qs = (id) => document.getElementById(id);

let allRows = [];
let filteredRows = [];

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

function setDefaultDates() {
  const toIso = berlinTodayIsoDate();
  const fromIso = shiftBerlinIsoDate(toIso, -30);
  qs('fromInput').value = fromIso;
  qs('toInput').value = toIso;
}

function fmtDate(iso) {
  if (!iso) return '-';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '-';
  return value.toLocaleString('de-DE');
}

function fmtDateOnly(iso) {
  if (!iso) return '-';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '-';
  return value.toLocaleDateString('de-DE');
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

function ageInDays(iso) {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - value.getTime()) / 86400000));
}

function daysText(days) {
  if (days === null) return '-';
  if (days === 0) return 'heute';
  if (days === 1) return 'gestern';
  return `vor ${days} Tagen`;
}

function firstPlayBerlinIso(row) {
  if (!row?.first_played_at_utc) return null;
  const date = new Date(row.first_played_at_utc);
  if (Number.isNaN(date.getTime())) return null;
  return berlinIsoDate(date);
}

function createAgeBadge(days) {
  const span = document.createElement('span');
  span.className = 'badge';
  if (days === null) {
    span.classList.add('text-bg-secondary');
    span.textContent = 'Unbekannt';
    return span;
  }
  if (days <= 1) {
    span.classList.add('text-bg-success');
    span.textContent = 'Frisch';
    return span;
  }
  if (days <= 3) {
    span.classList.add('text-bg-primary');
    span.textContent = 'Neu';
    return span;
  }
  if (days <= 7) {
    span.classList.add('text-bg-warning');
    span.textContent = 'Diese Woche';
    return span;
  }
  span.classList.add('text-bg-secondary');
  span.textContent = 'Im Zeitraum';
  return span;
}

function applyLocalFilter() {
  const q = String(qs('searchInput').value || '').trim().toLocaleLowerCase('de-DE');
  if (!q) {
    filteredRows = [...allRows];
    return;
  }
  filteredRows = allRows.filter((row) => {
    const haystack = `${row.artist || ''} ${row.title || ''} ${(row.stations || []).join(' ')}`.toLocaleLowerCase('de-DE');
    return haystack.includes(q);
  });
}

function renderKpis() {
  const totalPlays = filteredRows.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
  const todayIso = berlinTodayIsoDate();
  const weekStartIso = shiftBerlinIsoDate(todayIso, -6);

  const todayCount = filteredRows.filter((row) => firstPlayBerlinIso(row) === todayIso).length;
  const weekCount = filteredRows.filter((row) => {
    const firstIso = firstPlayBerlinIso(row);
    return Boolean(firstIso && firstIso >= weekStartIso && firstIso <= todayIso);
  }).length;

  qs('kpiNewCount').textContent = fmtNumber(filteredRows.length);
  qs('kpiNewPlays').textContent = fmtNumber(totalPlays);
  qs('kpiTodayCount').textContent = fmtNumber(todayCount);
  qs('kpiWeekCount').textContent = fmtNumber(weekCount);
}

function renderSpotlights() {
  const box = qs('spotlightCards');
  box.innerHTML = '';
  const top = filteredRows.slice(0, 6);
  qs('spotlightState').textContent = top.length
    ? 'Die zuletzt neu hinzugefügten Titel im Zeitraum:'
    : 'Keine neuen Titel für diese Filter. Bitte Zeitraum oder Sender ändern.';

  top.forEach((row) => {
    const card = document.createElement('article');
    card.className = 'new-title-card';

    const head = document.createElement('div');
    head.className = 'new-title-card-head';
    const badgeWrap = document.createElement('div');
    badgeWrap.className = 'new-title-badge';
    const days = ageInDays(row.first_played_at_utc);
    badgeWrap.appendChild(createAgeBadge(days));

    const openLink = document.createElement('a');
    openLink.className = 'btn btn-outline-primary btn-sm';
    openLink.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`;
    openLink.textContent = 'Öffnen';

    head.appendChild(badgeWrap);
    head.appendChild(openLink);

    const title = document.createElement('h3');
    title.className = 'h6 mb-1';
    title.textContent = `${row.artist || '-'} - ${row.title || '-'}`;

    const meta = document.createElement('p');
    meta.className = 'text-secondary mb-1';
    meta.textContent =
      `Veröffentlichung: ${fmtDateOnly(row.release_date_utc)} | Erster Einsatz: ${fmtDate(row.first_played_at_utc)}`;

    const stationNames = Array.isArray(row.stations) ? row.stations.filter(Boolean) : [];
    const sub = document.createElement('p');
    sub.className = 'text-secondary mb-0';
    sub.textContent =
      `Einsätze: ${fmtNumber(row.total_plays)} | ${daysText(days)} | ` +
      `Sender: ${row.station_count ? fmtNumber(row.station_count) : '-'}${stationNames.length ? ` (${stationNames.slice(0, 3).join(', ')})` : ''}`;

    card.appendChild(head);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(sub);
    box.appendChild(card);
  });
}

function renderTable() {
  const tbody = qs('newTitlesTable').querySelector('tbody');
  tbody.innerHTML = '';

  filteredRows.forEach((row) => {
    const tr = document.createElement('tr');

    const tdTrack = document.createElement('td');
    const artist = document.createElement('strong');
    artist.textContent = row.artist || '-';
    const title = document.createElement('small');
    title.textContent = row.title || '-';
    const release = document.createElement('small');
    release.className = 'text-secondary';
    release.textContent = `Veröffentlichung: ${fmtDateOnly(row.release_date_utc)}`;
    tdTrack.appendChild(artist);
    tdTrack.appendChild(document.createElement('br'));
    tdTrack.appendChild(title);
    tdTrack.appendChild(document.createElement('br'));
    tdTrack.appendChild(release);

    const tdPlays = document.createElement('td');
    tdPlays.textContent = fmtNumber(row.total_plays);

    const tdFirst = document.createElement('td');
    tdFirst.textContent = fmtDate(row.first_played_at_utc);

    const tdLast = document.createElement('td');
    tdLast.textContent = fmtDate(row.last_played_at_utc);

    const tdAge = document.createElement('td');
    const days = ageInDays(row.first_played_at_utc);
    tdAge.appendChild(createAgeBadge(days));
    tdAge.append(' ');
    const ageText = document.createElement('span');
    ageText.className = 'text-secondary';
    ageText.textContent = daysText(days);
    tdAge.appendChild(ageText);

    const tdOpen = document.createElement('td');
    const link = document.createElement('a');
    link.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`;
    link.textContent = 'Analyse';
    tdOpen.appendChild(link);

    tr.appendChild(tdTrack);
    tr.appendChild(tdPlays);
    tr.appendChild(tdFirst);
    tr.appendChild(tdLast);
    tr.appendChild(tdAge);
    tr.appendChild(tdOpen);
    tbody.appendChild(tr);
  });

  qs('state').textContent = filteredRows.length
    ? `${fmtNumber(filteredRows.length)} neue Titel gefunden.`
    : 'Keine neuen Titel für diesen Zeitraum. Filter anpassen oder Ingest laufen lassen.';
}

function renderAll() {
  applyLocalFilter();
  renderKpis();
  renderSpotlights();
  renderTable();
}

async function loadStations() {
  const stations = await apiFetch('/api/stations');
  const select = qs('stationSelect');
  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Alle Sender';
  select.appendChild(allOpt);

  stations.forEach((station) => {
    const opt = document.createElement('option');
    opt.value = station.id;
    opt.textContent = station.name;
    select.appendChild(opt);
  });
}

async function loadRows() {
  const from = qs('fromInput').value;
  const to = qs('toInput').value;
  if (from && to && from > to) {
    qs('state').textContent = 'Ungültiger Zeitraum: "Von" liegt nach "Bis".';
    allRows = [];
    renderAll();
    return;
  }

  const params = new URLSearchParams();
  params.set('from', from || shiftBerlinIsoDate(berlinTodayIsoDate(), -30));
  params.set('to', to || berlinTodayIsoDate());
  params.set('limit', qs('limitSelect').value || '250');
  params.set('minPlays', qs('minPlaysInput').value || '1');

  const stationId = qs('stationSelect').value;
  if (stationId) params.set('station', stationId);

  qs('state').textContent = 'Lade neue Titel...';
  const data = await apiFetch(`/api/new-titles?${params.toString()}`);
  allRows = Array.isArray(data.rows) ? data.rows : [];
  renderAll();
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
  setDefaultDates();

  await runSafe(loadStations, (msg) => {
    qs('state').textContent = `Fehler beim Laden der Sender: ${msg}`;
  });
  await runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  });

  qs('loadBtn').addEventListener('click', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('stationSelect').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('limitSelect').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('minPlaysInput').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('fromInput').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('toInput').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler beim Laden: ${msg}. Bitte später erneut versuchen.`;
  }));
  qs('searchInput').addEventListener('input', debounce(() => {
    renderAll();
  }));
}

init().catch((error) => {
  qs('state').textContent = `Fehler: ${error.message}`;
});
