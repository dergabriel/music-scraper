const qs = (id) => document.getElementById(id);

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

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('de-DE') : '-';
}

function weekStartIso(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function loadStations() {
  const rows = await apiFetch('/api/stations');
  const stationSelect = qs('stationSelect');
  const reportSelect = qs('reportStationSelect');
  stationSelect.innerHTML = '<option value="">Alle Sender</option>';
  reportSelect.innerHTML = '<option value="">Bitte wählen</option>';

  rows.forEach((s) => {
    const a = document.createElement('option');
    a.value = s.id;
    a.textContent = s.name;
    stationSelect.appendChild(a);

    const b = document.createElement('option');
    b.value = s.id;
    b.textContent = s.name;
    reportSelect.appendChild(b);
  });
}

function renderStats(rows) {
  const totalPlays = rows.reduce((sum, r) => sum + Number(r.total_plays || 0), 0);
  const uniqueArtists = new Set(rows.map((r) => r.artist)).size;

  qs('stats').innerHTML = `
    <article class="item"><span>Treffer</span><b>${rows.length.toLocaleString('de-DE')}</b></article>
    <article class="item"><span>Plays (Summe)</span><b>${totalPlays.toLocaleString('de-DE')}</b></article>
    <article class="item"><span>Künstler</span><b>${uniqueArtists.toLocaleString('de-DE')}</b></article>
    <article class="item"><span>Top Track</span><b>${rows[0] ? `${rows[0].artist} - ${rows[0].title}` : '-'}</b></article>
  `;
}

async function loadTracks() {
  const params = new URLSearchParams();
  params.set('limit', qs('limitSelect').value);
  const q = qs('searchInput').value.trim();
  const stationId = qs('stationSelect').value;
  if (q) params.set('q', q);
  if (stationId) params.set('stationId', stationId);

  qs('state').textContent = 'Lade Daten...';
  const rows = await apiFetch(`/api/tracks?${params.toString()}`);

  const tbody = qs('tracksTable').querySelector('tbody');
  tbody.innerHTML = '';

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${r.artist}</strong><br><small>${r.title}</small></td>
      <td>${Number(r.total_plays || 0).toLocaleString('de-DE')}</td>
      <td>${fmtDate(r.first_played_at_utc)}</td>
      <td>${fmtDate(r.last_played_at_utc)}</td>
      <td><a href="/dashboard?trackKey=${encodeURIComponent(r.track_key)}">Öffnen</a></td>
    `;
    tbody.appendChild(tr);
  });

  renderStats(rows);
  qs('state').textContent = `${rows.length} Tracks geladen.`;
}

async function loadStationReport() {
  const stationId = qs('reportStationSelect').value;
  const weekStart = qs('weekStartInput').value;
  if (!stationId) {
    qs('reportState').textContent = 'Bitte einen Sender wählen.';
    qs('reportWeekNew').textContent = 'Neu diese Woche: -';
    return;
  }

  qs('reportState').textContent = 'Lade Sender-Report...';
  const data = await apiFetch(`/api/reports/station/${encodeURIComponent(stationId)}?weekStart=${encodeURIComponent(weekStart)}`);
  const report = data.report;

  qs('reportState').textContent = `${report.station.name} | Woche ab ${data.weekStart}`;
  qs('reportWeekNew').textContent = `Neu diese Woche: ${Number(report.newTracks?.length || 0).toLocaleString('de-DE')}`;
  qs('reportContent').innerHTML = `
    <p><strong>Total Plays:</strong> ${Number(report.totalPlays || 0).toLocaleString('de-DE')}</p>
    <p><strong>Unique Tracks:</strong> ${Number(report.uniqueTracks || 0).toLocaleString('de-DE')}</p>
    <p><strong>Neu:</strong> ${Number(report.newTracks?.length || 0).toLocaleString('de-DE')}</p>
    <p><strong>Dropped:</strong> ${Number(report.droppedTracks?.length || 0).toLocaleString('de-DE')}</p>
    <h3>Top 10</h3>
    <ol>
      ${(report.topTracks || []).slice(0, 10).map((t) => `<li>${t.artist} - ${t.title} (${t.count})</li>`).join('') || '<li>Keine Daten</li>'}
    </ol>
  `;
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
  qs('weekStartInput').value = weekStartIso();

  await runSafe(loadStations, (msg) => {
    qs('state').textContent = `Fehler beim Laden der Sender: ${msg}`;
  });
  await runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  });

  qs('searchInput').addEventListener('input', debounce(() => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  })));
  qs('stationSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  }));
  qs('limitSelect').addEventListener('change', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  }));
  qs('loadBtn').addEventListener('click', () => runSafe(loadTracks, (msg) => {
    qs('state').textContent = `Fehler: ${msg}`;
  }));
  qs('loadReportBtn').addEventListener('click', () => runSafe(loadStationReport, (msg) => {
    qs('reportState').textContent = `Fehler: ${msg}`;
  }));
  qs('reportStationSelect').addEventListener('change', () => runSafe(loadStationReport, (msg) => {
    qs('reportState').textContent = `Fehler: ${msg}`;
  }));
}

init().catch((error) => {
  qs('state').textContent = `Fehler: ${error.message}`;
  if (qs('reportWeekNew')) qs('reportWeekNew').textContent = 'Neu diese Woche: -';
});
