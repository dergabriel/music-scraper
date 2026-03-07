import {
  berlinTodayIsoDate,
  berlinYesterdayIsoDate,
  berlinYear,
  shiftBerlinIsoDate,
  weekStartBerlinIso
} from './date-berlin.js';
import { apiFetch, buildUrl } from './dashboard.api.js';
import {
  getState,
  hasMetadataRefreshAttempt,
  markMetadataRefreshAttempt,
  setDetailCache,
  setNewWeekRows,
  setSelectedTrack,
  setStations,
  setTracks
} from './dashboard.state.js';
import {
  fillDailySeriesRange,
  formatPlays,
  formatSeriesPeriod,
  toCumulativeSeries
} from './charts.base.js';
import { renderLineChart } from './charts.line.js';
import { renderBarChart, renderDailyBarChart } from './charts.bar.js';

const qs = (id) => document.getElementById(id);
let chartResizeObserver = null;

function themeToggleText(theme) {
  return theme === 'dark' ? 'Hell' : 'Dunkel';
}

function applyTheme() {
  const saved = localStorage.getItem('music-scraper-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-bs-theme', theme);
  const toggle = qs('themeToggle');
  if (toggle) toggle.textContent = themeToggleText(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('music-scraper-theme', next);
  const toggle = qs('themeToggle');
  if (toggle) toggle.textContent = themeToggleText(next);
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

function trendBadgeLabel(status) {
  if (status === 'hot') return 'Heiß';
  if (status === 'dropping') return 'Fällt';
  return 'Stabil';
}

function lifecycleBadgeLabel(status) {
  if (status === 'new') return 'Neu';
  if (status === 'active') return 'Aktiv';
  if (status === 'declining') return 'Rückläufig';
  return 'Katalog';
}

function renderTrackMetadata(metadata) {
  const stateNode = qs('trackMetaState');
  const list = qs('trackMetaList');
  const cover = qs('trackMetaCover');
  if (!stateNode || !list || !cover) return;
  list.innerHTML = '';

  if (!metadata) {
    stateNode.textContent = 'Keine Metadaten verfügbar.';
    cover.removeAttribute('src');
    cover.alt = 'Kein Cover verfügbar';
    return;
  }

  stateNode.textContent = `Quelle: ${metadata.verification_source || '-'} | Aktualisiert: ${fmtDate(metadata.last_checked_utc)}`;
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
    ['Spotify-ID', metadata.spotify_track_id || '-'],
    ['Spotify-Confidence', Number.isFinite(metadata.spotify_confidence) ? `${Math.round(metadata.spotify_confidence * 100)}%` : '-'],
    ['Canonical Quelle', metadata.canonical_source || '-'],
    ['Canonical ID', metadata.canonical_id || '-'],
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

function renderTrackInsights({ trend = null, lifecycle = null, divergence = null } = {}) {
  const trendBadge = qs('trendBadge');
  const trendSummary = qs('trendSummary');
  const lifecycleBadge = qs('lifecycleBadge');
  const lifecycleSummary = qs('lifecycleSummary');
  const divergenceTop = qs('divergenceTop');
  const divergenceSummary = qs('divergenceSummary');
  if (!trendBadge || !trendSummary || !lifecycleBadge || !lifecycleSummary || !divergenceTop || !divergenceSummary) return;

  if (!trend) {
    trendBadge.textContent = '-';
    trendSummary.textContent = '-';
  } else {
    trendBadge.textContent = trendBadgeLabel(trend.status);
    trendSummary.textContent =
      `${formatPlays(trend.plays_last_48h)} Einsätze | Wachstum ${Number(trend.growth_percent || 0).toLocaleString('de-DE', { maximumFractionDigits: 1 })}%`;
  }

  if (!lifecycle) {
    lifecycleBadge.textContent = '-';
    lifecycleSummary.textContent = '-';
  } else {
    lifecycleBadge.textContent = lifecycleBadgeLabel(lifecycle.status);
    lifecycleSummary.textContent = `Alter ${formatPlays(lifecycle.age_days)} Tage | Letztes Play vor ${formatPlays(lifecycle.days_since_last_play ?? 0)} Tagen`;
  }

  const divergenceRows = Array.isArray(divergence?.rows) ? divergence.rows : [];
  if (!divergenceRows.length) {
    divergenceTop.textContent = '-';
    divergenceSummary.textContent = 'Keine Abweichungen im 7-Tage-Fenster.';
    return;
  }
  const top = divergenceRows[0];
  divergenceTop.textContent = `${top.station_name} (${Number(top.deviation_percent || 0).toLocaleString('de-DE', { maximumFractionDigits: 1 })}%)`;
  const strongCount = divergenceRows.filter((row) => Math.abs(Number(row.deviation_percent || 0)) >= 25).length;
  divergenceSummary.textContent = `${formatPlays(strongCount)} Sender mit deutlicher Abweichung (±25%).`;
}

function selectedStationName() {
  const state = getState();
  const stationId = qs('stationSelect')?.value || '';
  if (!stationId) return 'Alle';
  return state.stations.find((s) => s.id === stationId)?.name || stationId;
}

function renderTrackList() {
  const state = getState();
  const table = qs('tracksTable');
  const status = qs('tracksState');
  if (!table || !status) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  if (!state.tracks.length) {
    status.textContent = 'Keine Treffer. Filter anpassen oder Ingest laufen lassen.';
    return;
  }

  status.textContent = `${state.tracks.length.toLocaleString('de-DE')} Titel gefunden.`;

  state.tracks.forEach((track) => {
    const tr = document.createElement('tr');
    if (state.selectedTrack?.track_key === track.track_key) tr.classList.add('selected');
    const td = document.createElement('td');
    const artist = document.createElement('strong');
    artist.textContent = track.artist || '-';
    const title = document.createElement('small');
    title.textContent = track.title || '-';
    const plays = document.createElement('small');
    plays.textContent = `${formatPlays(track.total_plays)} Einsätze`;
    td.appendChild(artist);
    td.appendChild(document.createElement('br'));
    td.appendChild(title);
    td.appendChild(document.createElement('br'));
    td.appendChild(plays);
    tr.appendChild(td);
    tr.addEventListener('click', () => {
      setSelectedTrack(track);
      renderTrackList();
      void loadDetails();
    });
    tbody.appendChild(tr);
  });
}

function renderOverview() {
  const state = getState();
  const totalPlays = state.tracks.reduce((sum, r) => sum + Number(r.total_plays || 0), 0);
  const ovTracks = qs('ovTracks');
  const ovPlays = qs('ovPlays');
  const ovNewWeek = qs('ovNewWeek');
  const ovStation = qs('ovStation');
  if (ovTracks) ovTracks.textContent = Number(state.tracks.length || 0).toLocaleString('de-DE');
  if (ovPlays) ovPlays.textContent = totalPlays.toLocaleString('de-DE');
  if (ovNewWeek) ovNewWeek.textContent = Number(state.newWeekRows.length || 0).toLocaleString('de-DE');
  if (ovStation) ovStation.textContent = selectedStationName();

  const topList = qs('quickTopList');
  if (!topList) return;
  topList.innerHTML = '';
  const topRows = state.tracks.slice(0, 8);
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
      setSelectedTrack(row);
      renderTrackList();
      void loadDetails();
    });
    li.appendChild(button);
    topList.appendChild(li);
  });
}

async function loadStations() {
  const rows = await apiFetch('/api/stations');
  setStations(rows);
  const select = qs('stationSelect');
  if (!select) return;
  select.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'Alle Sender';
  select.appendChild(allOption);
  const state = getState();
  state.stations.forEach((station) => {
    const opt = document.createElement('option');
    opt.value = station.id;
    opt.textContent = station.name;
    select.appendChild(opt);
  });
}

async function loadTracks() {
  const params = new URLSearchParams();
  params.set('limit', '120');
  const q = qs('searchInput')?.value.trim() || '';
  const stationId = qs('stationSelect')?.value || '';
  if (q) params.set('q', q);
  if (stationId) params.set('stationId', stationId);

  const rows = await apiFetch(buildUrl('/api/tracks', params));
  setTracks(rows);
  const state = getState();

  if (!state.selectedTrack && state.requestedTrackKey) {
    setSelectedTrack(state.tracks.find((x) => x.track_key === state.requestedTrackKey) || {
      track_key: state.requestedTrackKey,
      artist: '',
      title: ''
    });
  }
  if (!state.selectedTrack && state.tracks.length) setSelectedTrack(state.tracks[0]);
  if (state.selectedTrack) {
    setSelectedTrack(state.tracks.find((x) => x.track_key === state.selectedTrack.track_key) || state.selectedTrack || state.tracks[0] || null);
  }

  renderTrackList();
  await loadNewThisWeek();
  renderOverview();
  if (state.selectedTrack) {
    await loadDetails();
  } else {
    const selectedTitle = qs('selectedTitle');
    const selectedMeta = qs('selectedMeta');
    if (selectedTitle) selectedTitle.textContent = 'Titel-Details';
    if (selectedMeta) selectedMeta.textContent = 'Kein passender Titel gefunden. Bitte Sender oder Suchbegriff anpassen.';
    renderTrackMetadata(null);
    renderTrackInsights(null);
    renderLineChart(qs('seriesChart'), [], qs('bucketSelect')?.value || 'day');
    renderDailyBarChart(qs('seriesByStationChart'), [], 'day');
    renderBarChart(qs('stationsChart'), []);
  }
}

async function loadNewThisWeek() {
  const params = new URLSearchParams();
  const stationId = qs('stationSelect')?.value || '';
  if (stationId) params.set('stationId', stationId);
  params.set('weekStart', weekStartBerlinIso(new Date()));
  params.set('limit', '12');
  params.set('releaseYear', String(berlinYear(new Date())));

  const data = await apiFetch(buildUrl('/api/insights/new-this-week', params));
  setNewWeekRows(data.rows || []);

  const ul = qs('newWeekList');
  if (!ul) return;
  ul.innerHTML = '';
  const state = getState();
  state.newWeekRows.slice(0, 12).forEach((row) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'link-btn';
    button.type = 'button';
    button.append(`${row.artist || '-'} - ${row.title || '-'} `);
    const small = document.createElement('small');
    small.textContent = `(${formatPlays(row.plays)})`;
    button.appendChild(small);
    button.addEventListener('click', () => {
      const currentState = getState();
      const hit = currentState.tracks.find((track) => track.track_key === row.track_key);
      if (hit) setSelectedTrack(hit);
      else setSelectedTrack({ track_key: row.track_key, artist: row.artist, title: row.title });
      renderTrackList();
      void loadDetails();
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

function applyDetailHeader(identityArtist, identityTitle, trackKey, range, selectedTrack) {
  const selectedTitle = qs('selectedTitle');
  const selectedMeta = qs('selectedMeta');
  if (selectedTitle) selectedTitle.textContent = `${identityArtist} - ${identityTitle}`;
  if (selectedMeta) {
    selectedMeta.textContent =
      `Titel-Schlüssel: ${trackKey} | Zeitraum: ${range.fromIso} bis ${range.toIso}${range.includeToday ? ' (inkl. heute)' : ' (bis gestern)'} | ` +
      `zuletzt: ${fmtDate(selectedTrack?.last_played_at_utc)}`;
  }
}

function renderDetailsFromCache(cache) {
  if (!cache) return;
  const { trackKey, range, bucket, selectedTrack, totals, cumulativeSeries, periodSeries, stationsData, trendData, lifecycleData, divergenceData, metadata } = cache;
  const identityArtist = totals.identity?.artist || selectedTrack?.artist || '-';
  const identityTitle = totals.identity?.title || selectedTrack?.title || '-';
  applyDetailHeader(identityArtist, identityTitle, trackKey, range, selectedTrack);

  const totalToday = qs('totalToday');
  const totalWeek = qs('totalWeek');
  const totalYear = qs('totalYear');
  const totalAll = qs('totalAll');
  if (totalToday) totalToday.textContent = Number(totals.totals?.today || 0).toLocaleString('de-DE');
  if (totalWeek) totalWeek.textContent = Number(totals.totals?.thisWeek || 0).toLocaleString('de-DE');
  if (totalYear) totalYear.textContent = Number(totals.totals?.thisYear || 0).toLocaleString('de-DE');
  if (totalAll) totalAll.textContent = Number(totals.totals?.allTime || 0).toLocaleString('de-DE');

  renderTrackMetadata(metadata);
  renderTrackInsights({ trend: trendData, lifecycle: lifecycleData, divergence: divergenceData });

  const cumulativeRows = toCumulativeSeries(cumulativeSeries.series || []);
  const cumulativeStart = Number(cumulativeRows[0]?.plays || 0);
  const cumulativeEnd = Number(cumulativeRows[cumulativeRows.length - 1]?.plays || 0);
  renderLineChart(qs('seriesChart'), cumulativeRows, bucket, {
    showArea: true,
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

async function loadDetails() {
  const state = getState();
  if (!state.selectedTrack) return;
  const trackKey = state.selectedTrack.track_key;
  if (!trackKey) return;

  const bucket = qs('bucketSelect')?.value || 'day';
  const range = getEffectiveDetailRange();
  if (!range) {
    const selectedMeta = qs('selectedMeta');
    if (selectedMeta) selectedMeta.textContent = 'Ungültiger Zeitraum. Bitte Von/Bis prüfen.';
    renderTrackInsights(null);
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
  let trendData;
  let lifecycleData;
  let divergenceData;
  let metadata = null;
  try {
    [totals, cumulativeSeries, periodSeries, stationsData, trendData, lifecycleData, divergenceData] = await Promise.all([
      apiFetch(buildUrl(`/api/tracks/${trackKey}/totals`, detailsParams)),
      apiFetch(buildUrl(`/api/tracks/${trackKey}/series`, cumulativeParams)),
      apiFetch(buildUrl(`/api/tracks/${trackKey}/series`, detailsParams)),
      apiFetch(buildUrl(`/api/tracks/${trackKey}/stations`, stationParams)),
      apiFetch(`/api/tracks/${trackKey}/trend`),
      apiFetch(`/api/tracks/${trackKey}/lifecycle`),
      apiFetch(`/api/tracks/${trackKey}/station-divergence`)
    ]);
  } catch (error) {
    const fallback = state.tracks[0] || null;
    const selectedTitle = qs('selectedTitle');
    const selectedMeta = qs('selectedMeta');
    if (state.requestedTrackKey && trackKey === state.requestedTrackKey) {
      if (selectedTitle) selectedTitle.textContent = 'Titel-Details';
      if (selectedMeta) selectedMeta.textContent = `Titel konnte nicht geladen werden (${error.message}).`;
      ['totalToday', 'totalWeek', 'totalYear', 'totalAll'].forEach((id) => {
        const el = qs(id);
        if (el) el.textContent = '-';
      });
      renderTrackMetadata(null);
      renderTrackInsights(null);
      renderLineChart(qs('seriesChart'), [], bucket);
      renderDailyBarChart(qs('seriesByStationChart'), [], bucket);
      renderBarChart(qs('stationsChart'), []);
      return;
    }
    if (fallback && fallback.track_key !== trackKey) {
      setSelectedTrack(fallback);
      renderTrackList();
      return loadDetails();
    }
    if (selectedTitle) selectedTitle.textContent = 'Titel-Details';
    if (selectedMeta) selectedMeta.textContent = `Keine Detaildaten für den gewählten Titel (${error.message}).`;
    ['totalToday', 'totalWeek', 'totalYear', 'totalAll'].forEach((id) => {
      const el = qs(id);
      if (el) el.textContent = '-';
    });
    renderTrackMetadata(null);
    renderTrackInsights(null);
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
    if (needsRefresh && !hasMetadataRefreshAttempt(trackKey)) {
      markMetadataRefreshAttempt(trackKey);
      const refreshed = await apiFetch(`/api/tracks/${trackKey}/meta/refresh`, { method: 'POST' });
      metadata = refreshed.metadata || metadata;
    }
  } catch {
    metadata = null;
  }

  const cache = {
    trackKey,
    range,
    bucket,
    selectedTrack: getState().selectedTrack,
    totals,
    cumulativeSeries,
    periodSeries,
    stationsData,
    trendData,
    lifecycleData,
    divergenceData,
    metadata
  };
  setDetailCache(cache);
  renderDetailsFromCache(cache);
}

function setDefaultDates() {
  const toIso = berlinTodayIsoDate();
  const fromIso = shiftBerlinIsoDate(toIso, -90);
  const fromInput = qs('fromInput');
  const toInput = qs('toInput');
  if (fromInput) fromInput.value = fromIso;
  if (toInput) toInput.value = toIso;
  if (qs('includeTodayInput')) qs('includeTodayInput').checked = false;
  updateCutoffHint(getEffectiveDetailRange());
}

function getEffectiveDetailRange() {
  const includeToday = Boolean(qs('includeTodayInput')?.checked);
  const todayIso = berlinTodayIsoDate();
  const yesterdayIso = berlinYesterdayIsoDate();
  const fromIso = qs('fromInput')?.value || shiftBerlinIsoDate(todayIso, -90);
  const inputToIso = qs('toInput')?.value || todayIso;
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

function setupChartResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return;
  if (chartResizeObserver) chartResizeObserver.disconnect();
  const rerender = debounce(() => {
    const state = getState();
    if (!state.detailCache) return;
    renderDetailsFromCache(state.detailCache);
  }, 120);
  chartResizeObserver = new ResizeObserver(() => rerender());
  ['seriesChart', 'seriesByStationChart', 'stationsChart'].forEach((id) => {
    const el = qs(id);
    if (el) chartResizeObserver.observe(el);
  });
}

export async function initDashboardPage() {
  applyTheme();
  qs('themeToggle')?.addEventListener('click', toggleTheme);
  setDefaultDates();
  const state = getState();
  if (state.focusedTrackMode) {
    qs('overviewCard')?.classList.add('hidden');
    qs('quickListsSection')?.classList.add('hidden');
  }
  await runSafe(loadStations, (msg) => {
    const stateNode = qs('tracksState');
    if (stateNode) stateNode.textContent = `Fehler beim Laden der Sender: ${msg}`;
  });
  await runSafe(loadTracks, (msg) => {
    const stateNode = qs('tracksState');
    if (stateNode) stateNode.textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  });

  setupChartResizeObserver();

  qs('refreshTracksBtn')?.addEventListener('click', () => runSafe(loadTracks, (msg) => {
    const stateNode = qs('tracksState');
    if (stateNode) stateNode.textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  }));
  qs('refreshDetailsBtn')?.addEventListener('click', () => runSafe(loadDetails, (msg) => {
    const meta = qs('selectedMeta');
    if (meta) meta.textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('stationSelect')?.addEventListener('change', () => runSafe(loadTracks, (msg) => {
    const stateNode = qs('tracksState');
    if (stateNode) stateNode.textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  }));
  qs('bucketSelect')?.addEventListener('change', () => runSafe(loadDetails, (msg) => {
    const meta = qs('selectedMeta');
    if (meta) meta.textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('fromInput')?.addEventListener('change', () => runSafe(loadDetails, (msg) => {
    const meta = qs('selectedMeta');
    if (meta) meta.textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('toInput')?.addEventListener('change', () => runSafe(loadDetails, (msg) => {
    const meta = qs('selectedMeta');
    if (meta) meta.textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('includeTodayInput')?.addEventListener('change', () => runSafe(loadDetails, (msg) => {
    const meta = qs('selectedMeta');
    if (meta) meta.textContent = `Fehler bei den Diagrammdaten: ${msg}`;
  }));
  qs('searchInput')?.addEventListener('input', debounce(() => runSafe(loadTracks, (msg) => {
    const stateNode = qs('tracksState');
    if (stateNode) stateNode.textContent = `Fehler beim Laden. Bitte später erneut versuchen (${msg}).`;
  })));
  document.querySelectorAll('.range-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const rangeId = button.getAttribute('data-range');
      runSafe(() => applyQuickRange(rangeId), (msg) => {
        const meta = qs('selectedMeta');
        if (meta) meta.textContent = `Fehler bei den Diagrammdaten: ${msg}`;
      });
    });
  });
}
