const qs = (id) => document.getElementById(id);

let allRows = [];
let filteredRows = [];

function applyTheme() {
  const saved = localStorage.getItem('music-scraper-theme');
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
  localStorage.setItem('music-scraper-theme', next);
  qs('themeToggle').textContent = next === 'dark' ? 'Light' : 'Dark';
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 1);
  qs('fromInput').value = from.toISOString().slice(0, 10);
  qs('toInput').value = to.toISOString().slice(0, 10);
}

function parseDateInput(value, endOfDay = false) {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const dt = new Date(`${value}${suffix}`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleString('de-DE');
}

function ageInDays(iso) {
  if (!iso) return null;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  const diffMs = Date.now() - dt.getTime();
  return Math.max(0, Math.floor(diffMs / 86400000));
}

function badgeForAge(days) {
  if (days === null) return '<span class="badge text-bg-secondary">Unbekannt</span>';
  if (days <= 1) return '<span class="badge text-bg-success">Frisch</span>';
  if (days <= 3) return '<span class="badge text-bg-primary">Neu</span>';
  if (days <= 7) return '<span class="badge text-bg-warning">Diese Woche</span>';
  return '<span class="badge text-bg-secondary">Im Zeitraum</span>';
}

function daysText(days) {
  if (days === null) return '-';
  if (days === 0) return 'heute';
  if (days === 1) return 'gestern';
  return `vor ${days} Tagen`;
}

function filterRows() {
  const from = parseDateInput(qs('fromInput').value, false);
  const to = parseDateInput(qs('toInput').value, true);
  const q = qs('searchInput').value.trim().toLowerCase();
  const minPlays = Number(qs('minPlaysInput').value || '1');

  filteredRows = allRows.filter((row) => {
    const first = row.first_played_at_utc ? new Date(row.first_played_at_utc) : null;
    if (!first || Number.isNaN(first.getTime())) return false;
    if (from && first < from) return false;
    if (to && first > to) return false;
    if (Number(row.total_plays || 0) < minPlays) return false;
    if (!q) return true;
    const combined = `${row.artist || ''} ${row.title || ''}`.toLowerCase();
    return combined.includes(q);
  });

  filteredRows.sort((a, b) => {
    const ad = new Date(a.first_played_at_utc).getTime();
    const bd = new Date(b.first_played_at_utc).getTime();
    return bd - ad;
  });
}

function renderKpis() {
  const totalPlays = filteredRows.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
  const todayIso = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const todayCount = filteredRows.filter((row) => String(row.first_played_at_utc || '').startsWith(todayIso)).length;
  const weekCount = filteredRows.filter((row) => {
    const first = new Date(row.first_played_at_utc);
    return !Number.isNaN(first.getTime()) && first >= weekAgo;
  }).length;

  qs('kpiNewCount').textContent = filteredRows.length.toLocaleString('de-DE');
  qs('kpiNewPlays').textContent = totalPlays.toLocaleString('de-DE');
  qs('kpiTodayCount').textContent = todayCount.toLocaleString('de-DE');
  qs('kpiWeekCount').textContent = weekCount.toLocaleString('de-DE');
}

function renderSpotlights() {
  const box = qs('spotlightCards');
  box.innerHTML = '';
  const top = filteredRows.slice(0, 6);
  qs('spotlightState').textContent = top.length
    ? 'Die neuesten Titel im gewählten Zeitraum:'
    : 'Keine neuen Titel für diese Filter.';

  top.forEach((row) => {
    const days = ageInDays(row.first_played_at_utc);
    const card = document.createElement('article');
    card.className = 'new-title-card';
    card.innerHTML = `
      <div class="new-title-card-head">
        <div class="new-title-badge">${badgeForAge(days)}</div>
        <a class="btn btn-outline-primary btn-sm" href="/dashboard?trackKey=${encodeURIComponent(row.track_key)}">Öffnen</a>
      </div>
      <h3 class="h6 mb-1">${row.artist} - ${row.title}</h3>
      <p class="text-secondary mb-1">Erstes Play: ${formatDateTime(row.first_played_at_utc)}</p>
      <p class="text-secondary mb-0">Plays: ${Number(row.total_plays || 0).toLocaleString('de-DE')} | ${daysText(days)}</p>
    `;
    box.appendChild(card);
  });
}

function renderTable() {
  const tbody = qs('newTitlesTable').querySelector('tbody');
  tbody.innerHTML = '';

  filteredRows.forEach((row) => {
    const tr = document.createElement('tr');
    const days = ageInDays(row.first_played_at_utc);
    tr.innerHTML = `
      <td><strong>${row.artist}</strong><br><small>${row.title}</small></td>
      <td>${Number(row.total_plays || 0).toLocaleString('de-DE')}</td>
      <td>${formatDateTime(row.first_played_at_utc)}</td>
      <td>${formatDateTime(row.last_played_at_utc)}</td>
      <td>${badgeForAge(days)} <span class="text-secondary">${daysText(days)}</span></td>
      <td><a href="/dashboard?trackKey=${encodeURIComponent(row.track_key)}">Analyse</a></td>
    `;
    tbody.appendChild(tr);
  });

  qs('state').textContent = filteredRows.length
    ? `${filteredRows.length.toLocaleString('de-DE')} neue Titel gefunden.`
    : 'Keine neuen Titel im gewählten Zeitraum.';
}

function renderAll() {
  filterRows();
  renderKpis();
  renderSpotlights();
  renderTable();
}

async function loadStations() {
  const stations = await apiFetch('/api/stations');
  const select = qs('stationSelect');
  select.innerHTML = '<option value="">Alle Sender</option>';
  stations.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
}

async function loadRows() {
  const params = new URLSearchParams();
  params.set('limit', qs('limitSelect').value || '250');
  const stationId = qs('stationSelect').value;
  if (stationId) params.set('stationId', stationId);
  const query = qs('searchInput').value.trim();
  if (query) params.set('q', query);

  qs('state').textContent = 'Lade neue Titel...';
  const rows = await apiFetch(`/api/tracks?${params.toString()}`);
  allRows = Array.isArray(rows) ? rows : [];
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
    qs('state').textContent = `Fehler: ${msg}`;
  });

  qs('loadBtn').addEventListener('click', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  }));
  qs('stationSelect').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  }));
  qs('limitSelect').addEventListener('change', () => runSafe(loadRows, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  }));

  const localFilterRefresh = debounce(() => {
    renderAll();
  });

  qs('fromInput').addEventListener('change', localFilterRefresh);
  qs('toInput').addEventListener('change', localFilterRefresh);
  qs('minPlaysInput').addEventListener('change', localFilterRefresh);
  qs('searchInput').addEventListener('input', localFilterRefresh);
}

init().catch((error) => {
  qs('state').textContent = `Fehler: ${error.message}`;
});
