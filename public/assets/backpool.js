const qs = (id) => document.getElementById(id);
let lastBackpoolData = null;
let sortByStation = false;
const ROTATION_PRESETS = {
  easy: {
    label: 'Locker',
    minDaily: 0.15,
    maxDaily: 2,
    minActiveDays: 2,
    minSpanDays: 7,
    minReleaseAgeDays: 1095,
    minTrackAgeDays: 30,
    hint: 'Mehr Titel, aber nur mit Release-Alter >= 3 Jahre.'
  },
  balanced: {
    label: 'Standard',
    minDaily: 0.25,
    maxDaily: 1.6,
    minActiveDays: 3,
    minSpanDays: 10,
    minReleaseAgeDays: 1095,
    minTrackAgeDays: 45,
    hint: 'Guter Mittelweg: nur Songs mit mindestens 3 Jahren Release-Alter.'
  },
  strict: {
    label: 'Streng',
    minDaily: 0.35,
    maxDaily: 1.2,
    minActiveDays: 4,
    minSpanDays: 14,
    minReleaseAgeDays: 1460,
    minTrackAgeDays: 90,
    hint: 'Nur klar alte und stabile Backpool-Rotationen.'
  }
};

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
  from.setDate(to.getDate() - 365);
  qs('fromInput').value = from.toISOString().slice(0, 10);
  qs('toInput').value = to.toISOString().slice(0, 10);
}

async function loadStations() {
  const rows = await apiFetch('/api/stations');
  const select = qs('stationSelect');
  select.innerHTML = '<option value="">Alle Sender</option>';
  rows.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
}

function formatPercent(value, digits = 1) {
  const numeric = Number(value || 0);
  return `${numeric.toFixed(digits).replace('.', ',')}%`;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function getSearchQuery() {
  return String(qs('backpoolSearchInput')?.value || '').trim().toLowerCase();
}

function includesQuery(value, query) {
  return String(value || '').toLowerCase().includes(query);
}

function trackMatchesQuery(track, query, stationNameOverride) {
  if (!query) return true;
  const stationName = stationNameOverride ?? track.stationName ?? '';
  return (
    includesQuery(track.artist, query) ||
    includesQuery(track.title, query) ||
    includesQuery(stationName, query) ||
    includesQuery(track.stationId, query)
  );
}

function applyRotationPreset() {
  const presetId = qs('rotationPresetSelect')?.value || 'balanced';
  const preset = ROTATION_PRESETS[presetId] || ROTATION_PRESETS.balanced;
  qs('rotationMinDailyPlaysInput').value = String(preset.minDaily);
  qs('lowRotationMaxDailyPlaysInput').value = String(preset.maxDaily);
  qs('rotationMinActiveDaysInput').value = String(preset.minActiveDays);
  qs('rotationMinSpanDaysInput').value = String(preset.minSpanDays);
  qs('rotationMinReleaseAgeDaysInput').value = String(preset.minReleaseAgeDays);
  qs('minTrackAgeDaysInput').value = String(preset.minTrackAgeDays);
  if (qs('presetHint')) {
    qs('presetHint').textContent = `${preset.label}: ${preset.hint}`;
  }
}

function normalizeTrackToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/["'`´’“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function aggregateTrackKey(track) {
  if (track.trackKey) return `key:${track.trackKey}`;
  return `name:${normalizeTrackToken(track.artist)}::${normalizeTrackToken(track.title)}`;
}

function minIsoDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a < b ? a : b;
}

function maxIsoDate(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

function formatStationPreview(stations, maxShown = 3) {
  const names = Array.isArray(stations) ? stations.filter(Boolean) : [];
  if (!names.length) return '-';
  if (names.length <= maxShown) return names.join(', ');
  return `${names.slice(0, maxShown).join(', ')} +${names.length - maxShown}`;
}

function allBackpoolTracks(rows) {
  const byTrack = new Map();
  rows.forEach((row) => {
    const tracks = Array.isArray(row.rotationBackpoolTracks) ? row.rotationBackpoolTracks : [];
    tracks.forEach((track) => {
      const mapKey = aggregateTrackKey(track);
      if (!byTrack.has(mapKey)) {
        byTrack.set(mapKey, {
          trackKey: track.trackKey || null,
          artist: track.artist,
          title: track.title,
          plays: 0,
          playsPerDay: 0,
          activeDaysTotal: 0,
          spanDaysMax: 0,
          cadenceSamples: [],
          firstPlayedDate: null,
          lastPlayedDate: null,
          stationNames: new Set(),
          stationIds: new Set()
        });
      }
      const entry = byTrack.get(mapKey);
      entry.plays += Number(track.plays || 0);
      entry.playsPerDay += Number(track.playsPerDay || 0);
      entry.activeDaysTotal += Number(track.activeDays || 0);
      entry.spanDaysMax = Math.max(entry.spanDaysMax, Number(track.spanDays || 0));
      const cadence = Number(track.cadenceDays);
      if (Number.isFinite(cadence)) entry.cadenceSamples.push(cadence);
      entry.firstPlayedDate = minIsoDate(entry.firstPlayedDate, track.firstPlayedDate || null);
      entry.lastPlayedDate = maxIsoDate(entry.lastPlayedDate, track.lastPlayedDate || null);
      if (row.stationName) entry.stationNames.add(row.stationName);
      if (row.stationId) entry.stationIds.add(row.stationId);
      if (!entry.trackKey && track.trackKey) entry.trackKey = track.trackKey;
    });
  });

  return Array.from(byTrack.values()).map((entry) => {
    const stationNames = Array.from(entry.stationNames).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
    const stationIds = Array.from(entry.stationIds).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
    const stationCount = stationNames.length;
    const cadenceDays = entry.cadenceSamples.length
      ? entry.cadenceSamples.reduce((sum, value) => sum + value, 0) / entry.cadenceSamples.length
      : null;
    return {
      trackKey: entry.trackKey,
      artist: entry.artist,
      title: entry.title,
      plays: entry.plays,
      playsPerDay: entry.playsPerDay,
      activeDays: stationCount > 0 ? Math.round(entry.activeDaysTotal / stationCount) : 0,
      spanDays: entry.spanDaysMax,
      cadenceDays,
      firstPlayedDate: entry.firstPlayedDate,
      lastPlayedDate: entry.lastPlayedDate,
      stationCount,
      stationNames,
      stationIds,
      stationName: stationNames.join(', '),
      stationId: stationIds.join(', ')
    };
  });
}

function updateSortButton() {
  const btn = qs('sortModeBtn');
  if (!btn) return;
  btn.textContent = sortByStation ? 'Nach Plays sortieren' : 'Senderweise sortieren';
}

function renderAllBackpoolTable(rows, query = '') {
  const allTracks = allBackpoolTracks(rows);
  const tbody = qs('allBackpoolTable')?.querySelector('tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const filtered = allTracks.filter((row) => trackMatchesQuery(row, query));
  const sorted = filtered.slice().sort((a, b) => {
    if (sortByStation) {
      const stationCmp = String((a.stationNames && a.stationNames[0]) || '').localeCompare(String((b.stationNames && b.stationNames[0]) || ''), 'de', { sensitivity: 'base' });
      if (stationCmp !== 0) return stationCmp;
    }
    if (b.plays !== a.plays) return b.plays - a.plays;
    return String(a.artist || '').localeCompare(String(b.artist || ''), 'de', { sensitivity: 'base' });
  });

  const listState = qs('listState');
  if (listState) {
    listState.textContent =
      `${sorted.length.toLocaleString('de-DE')} eindeutige Titel in der Gesamtliste ` +
      `(Sortierung: ${sortByStation ? 'Sender' : 'Plays'}${query ? ', gefiltert' : ''})`;
  }

  sorted.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td></td>
      <td></td>
      <td>${row.plays.toLocaleString('de-DE')}</td>
      <td>${Number.isFinite(row.playsPerDay) ? row.playsPerDay.toFixed(2) : '-'}</td>
      <td>${row.activeDays.toLocaleString('de-DE')}</td>
      <td>${row.spanDays.toLocaleString('de-DE')}</td>
      <td>${Number.isFinite(row.cadenceDays) ? `${row.cadenceDays.toFixed(2)} Tage` : '-'}</td>
    `;

    const songCell = document.createElement('td');
    if (row.trackKey) {
      const a = document.createElement('a');
      a.href = `/dashboard?trackKey=${encodeURIComponent(row.trackKey)}`;
      a.textContent = `${row.artist} - ${row.title}`;
      songCell.appendChild(a);
    } else {
      songCell.textContent = `${row.artist} - ${row.title}`;
    }
    const meta = document.createElement('div');
    meta.className = 'backpool-song-meta';
    meta.textContent = `Erstes: ${row.firstPlayedDate || '-'} | Letztes: ${row.lastPlayedDate || '-'}`;
    songCell.appendChild(meta);
    tr.children[1].replaceWith(songCell);

    const stationCell = document.createElement('td');
    const stationLabel = row.stationCount <= 1
      ? (row.stationNames[0] || '-')
      : `${row.stationCount.toLocaleString('de-DE')} Sender`;
    stationCell.textContent = stationLabel;
    const stationMeta = document.createElement('div');
    stationMeta.className = 'backpool-song-meta';
    stationMeta.textContent = formatStationPreview(row.stationNames, 4);
    stationCell.appendChild(stationMeta);
    tr.children[2].replaceWith(stationCell);

    tbody.appendChild(tr);
  });
}

function renderBackpool(data) {
  lastBackpoolData = data;
  updateSortButton();
  const baseRows = Array.isArray(data?.rows) ? data.rows : [];
  const query = getSearchQuery();
  const songCards = qs('songCards');
  songCards.innerHTML = '';

  if (!baseRows.length) {
    qs('state').textContent = 'Keine Backpool-Daten für den gewählten Zeitraum.';
    qs('summary').textContent = '-';
    const tbody = qs('allBackpoolTable')?.querySelector('tbody');
    if (tbody) tbody.innerHTML = '';
    if (qs('listState')) qs('listState').textContent = '0 Titel in der Gesamtliste';
    return;
  }

  const presetId = qs('rotationPresetSelect')?.value || 'balanced';
  const preset = ROTATION_PRESETS[presetId] || ROTATION_PRESETS.balanced;
  qs('state').textContent =
    `Zeitraum ${data.from} bis ${data.to} | Profil: ${preset.label} | ` +
    `Schwelle: ${Number(data.rotationMinDailyPlays ?? preset.minDaily).toFixed(2)} bis ${Number(data.lowRotationMaxDailyPlays ?? preset.maxDaily).toFixed(2)} Plays/Tag | ` +
    `min. Release-Alter: ${Number(data.rotationMinReleaseAgeDays ?? preset.minReleaseAgeDays ?? 1095).toLocaleString('de-DE')} Tage | ` +
    `min. Sender-Alter: ${Number(data.minTrackAgeDays ?? preset.minTrackAgeDays).toLocaleString('de-DE')} Tage`;
  const filteredAllTracks = allBackpoolTracks(baseRows).filter((track) => trackMatchesQuery(track, query));
  const shownSongs = filteredAllTracks.length;
  const totalBackpoolPlays = filteredAllTracks.reduce((sum, track) => sum + Number(track.plays || 0), 0);
  qs('summary').textContent =
    `Rotation-Backpool-Songs (eindeutig): ${shownSongs.toLocaleString('de-DE')} | ` +
    `Backpool-Plays: ${totalBackpoolPlays.toLocaleString('de-DE')} | Sender: ${baseRows.length.toLocaleString('de-DE')}${query ? ' | Suche aktiv' : ''}`;
  renderAllBackpoolTable(baseRows, query);

  const issueText = (value) => {
    switch (value) {
      case 'missing_release':
        return 'Kein Release';
      case 'low_confidence':
        return 'Zu geringe Confidence';
      case 'missing_confidence':
        return 'Keine Confidence';
      case 'rejected_match':
        return 'Match abgelehnt';
      case 'invalid_release':
        return 'Ungueltiges Release';
      default:
        return 'Unvalidiert';
    }
  };

  let renderedCardCount = 0;
  baseRows.forEach((row) => {
    const card = document.createElement('article');
    card.className = 'backpool-card';
    const head = document.createElement('div');
    head.className = 'backpool-card-head';
    head.innerHTML = `
      <div class="backpool-card-title">${row.stationName}</div>
      <div class="backpool-card-meta">${Number(row.rotationBackpoolTrackCount || 0).toLocaleString('de-DE')} Rotation-Backpool-Titel | ${Number(row.rotationBackpoolPlays || 0).toLocaleString('de-DE')} Plays</div>
    `;
    card.appendChild(head);

    const stationMatchesQuery = !query || includesQuery(row.stationName, query) || includesQuery(row.stationId, query);
    const tracks = (Array.isArray(row.rotationBackpoolTracks) ? row.rotationBackpoolTracks : [])
      .filter((track) => trackMatchesQuery(track, query, row.stationName));
    const hotTracks = (Array.isArray(row.hotRotationTracks) ? row.hotRotationTracks : [])
      .filter((track) => trackMatchesQuery(track, query, row.stationName));
    const sparseTracks = (Array.isArray(row.sparseRotationTracks) ? row.sparseRotationTracks : [])
      .filter((track) => trackMatchesQuery(track, query, row.stationName));
    const resurgenceTracks = (Array.isArray(row.resurgenceTracks) ? row.resurgenceTracks : [])
      .filter((track) => trackMatchesQuery(track, query, row.stationName));
    const recentTracks = (Array.isArray(row.recentTracks) ? row.recentTracks : [])
      .filter((track) => trackMatchesQuery(track, query, row.stationName));
    const unknownTracks = (Array.isArray(row.unknownReleaseTracks) ? row.unknownReleaseTracks : [])
      .filter((track) => trackMatchesQuery(track, query, row.stationName));
    if (!stationMatchesQuery && !tracks.length && !hotTracks.length && !sparseTracks.length && !resurgenceTracks.length && !recentTracks.length && !unknownTracks.length) {
      return;
    }
    const pattern = row.rotationPattern || {};
    const topHours = Array.isArray(pattern.topHours) ? pattern.topHours : [];
    const peakText = topHours.length
      ? topHours.slice(0, 3).map((slot) => `${formatHour(slot.hour)} (${formatPercent((slot.share || 0) * 100)})`).join(', ')
      : '-';

    const patternGrid = document.createElement('div');
    patternGrid.className = 'backpool-pattern-grid';
    patternGrid.innerHTML = `
      <article class="backpool-pattern-item">
        <div>Aktive Backpool-Stunden</div>
        <strong>${formatPercent(pattern.activeHourPresencePct || 0)}</strong>
        <small>Anteil aller Stunden im Zeitraum</small>
      </article>
      <article class="backpool-pattern-item">
        <div>Backpool-Stunden / Tag</div>
        <strong>${Number(pattern.activeHoursPerDayAvg || 0).toFixed(1).replace('.', ',')}</strong>
        <small>Durchschnittliche aktive Stunden</small>
      </article>
      <article class="backpool-pattern-item">
        <div>Wiederholungsquote</div>
        <strong>${formatPercent((pattern.repeatsShare || 0) * 100)}</strong>
        <small>Plays nach dem ersten Titel-Einsatz</small>
      </article>
      <article class="backpool-pattern-item">
        <div>Titel mit Tages-Repeat</div>
        <strong>${formatPercent((pattern.tracksWithSameDayRepeatPct || 0) * 100)}</strong>
        <small>${Number(pattern.tracksWithSameDayRepeatCount || 0).toLocaleString('de-DE')} von ${Number(row.rotationBackpoolTrackCount || 0).toLocaleString('de-DE')}</small>
      </article>
    `;
    card.appendChild(patternGrid);

    const patternText = document.createElement('p');
    patternText.className = 'backpool-pattern-text';
    patternText.textContent =
      `Peak-Zeiten: ${peakText} | ` +
      `Ø Wiederholungen pro Backpool-Titel: ${Number(pattern.repeatsPerTrackAvg || 0).toFixed(2).replace('.', ',')} | ` +
      `Ø Abstand: ${Number.isFinite(pattern.averageCadenceDays) ? `${Number(pattern.averageCadenceDays).toFixed(2).replace('.', ',')} Tage` : '-'}`;
    card.appendChild(patternText);

    if (!tracks.length) {
      const empty = document.createElement('p');
      empty.className = 'text-secondary mb-0';
      const coverage = Number(row.observedSpanDays || 0);
      const need = Number(row.rotationEffectiveMinSpanDays || row.rotationMinSpanDays || data.rotationMinSpanDays || 28);
      const coverageHint = coverage < need
        ? ` Datenhistorie nur ${coverage.toLocaleString('de-DE')} Tage (benötigt: mind. ${need.toLocaleString('de-DE')}).`
        : '';
      const warmupHint = row.rotationWarmupMode ? ' Warmup-Modus aktiv (Frühindikator).' : '';
      empty.textContent =
        `Keine Rotation-Backpool-Titel im Zeitraum. ` +
        `Hot Rotation: ${hotTracks.length.toLocaleString('de-DE')} | ` +
        `Revival/Trend: ${resurgenceTracks.length.toLocaleString('de-DE')} | ` +
        `Selten/zu kurz verteilt: ${sparseTracks.length.toLocaleString('de-DE')} | ` +
        `Zu neu (Release/Sender): ${recentTracks.length.toLocaleString('de-DE')}.` +
        coverageHint +
        warmupHint;
      card.appendChild(empty);
      songCards.appendChild(card);
      renderedCardCount += 1;
      return;
    }

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    const hint = document.createElement('p');
    hint.className = 'text-secondary mb-2';
    hint.textContent =
      `Logik: ${Number(row.rotationMinDailyPlays ?? data.rotationMinDailyPlays ?? 0.35).toFixed(2)} bis ` +
      `${Number(row.lowRotationMaxDailyPlays ?? data.lowRotationMaxDailyPlays ?? 2).toFixed(2)} Plays/Tag, ` +
      `mind. ${Number(row.rotationEffectiveMinActiveDays ?? row.rotationMinActiveDays ?? data.rotationMinActiveDays ?? 5)} aktive Tage, ` +
      `mind. ${Number(row.rotationEffectiveMinSpanDays ?? row.rotationMinSpanDays ?? data.rotationMinSpanDays ?? 28)} Spanntage, ` +
      `mind. ${Number(row.rotationEffectiveMinReleaseAgeDays ?? row.rotationMinReleaseAgeDays ?? data.rotationMinReleaseAgeDays ?? 1095)} Tage Release-Alter, ` +
      `mind. ${Number(row.rotationEffectiveMinTrackAgeDays ?? row.minTrackAgeDays ?? data.minTrackAgeDays ?? 30)} Tage Sender-Alter. ` +
      `Datenbasis: ${Number(row.observedSpanDays || 0).toLocaleString('de-DE')} Tage. ` +
      `Ohne valides Release kein Backpool. ` +
      `${row.rotationWarmupMode ? 'Warmup-Modus aktiv.' : ''}`;
    card.appendChild(hint);
    const table = document.createElement('table');
    table.className = 'table table-sm align-middle mb-0';
    table.innerHTML = `
      <thead>
        <tr>
          <th>#</th>
          <th>Song</th>
          <th>Plays</th>
          <th>Ø/Tag</th>
          <th>Aktive Tage</th>
          <th>Spanntage</th>
          <th>Ø Abstand</th>
          <th>Erstes</th>
          <th>Letztes</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    tracks.forEach((track, index) => {
      const tr = document.createElement('tr');
      const songCell = document.createElement('td');
      if (track.trackKey) {
        const a = document.createElement('a');
        a.href = `/dashboard?trackKey=${encodeURIComponent(track.trackKey)}`;
        a.textContent = `${track.artist} - ${track.title}`;
        songCell.appendChild(a);
      } else {
        songCell.textContent = `${track.artist} - ${track.title}`;
      }
      const meta = document.createElement('div');
      meta.className = 'backpool-song-meta';
      meta.textContent = [
        track.genre || null,
        track.album || null,
        track.releaseDate ? `Release ${track.releaseDate}` : null,
        Number.isFinite(track.verificationConfidence) ? `Conf ${track.verificationConfidence.toFixed(2)}` : null
      ].filter(Boolean).join(' | ') || ' ';
      songCell.appendChild(meta);

      tr.innerHTML = `
        <td>${index + 1}</td>
        <td></td>
        <td>${Number(track.plays || 0).toLocaleString('de-DE')}</td>
        <td>${Number.isFinite(track.playsPerDay) ? track.playsPerDay.toFixed(2) : '-'}</td>
        <td>${Number(track.activeDays || 0).toLocaleString('de-DE')}</td>
        <td>${Number(track.spanDays || 0).toLocaleString('de-DE')}</td>
        <td>${Number.isFinite(track.cadenceDays) ? `${track.cadenceDays.toFixed(2)} Tage` : '-'}</td>
        <td>${track.firstPlayedDate || '-'}</td>
        <td>${track.lastPlayedDate || '-'}</td>
      `;
      tr.children[1].replaceWith(songCell);
      tbody.appendChild(tr);
    });

    tableWrap.appendChild(table);
    card.appendChild(tableWrap);

    if (hotTracks.length) {
      const hotTitle = document.createElement('p');
      hotTitle.className = 'text-secondary mt-3 mb-2';
      hotTitle.textContent = 'Ausgeschlossen (Hot Rotation):';
      card.appendChild(hotTitle);

      const list = document.createElement('ul');
      list.className = 'mb-0';
      hotTracks.slice(0, 5).forEach((track) => {
        const li = document.createElement('li');
        li.textContent = `${track.artist} - ${track.title} | Ø/Tag ${Number.isFinite(track.playsPerDay) ? track.playsPerDay.toFixed(2) : '-'} | ${Number(track.plays || 0).toLocaleString('de-DE')} Plays`;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    if (sparseTracks.length) {
      const sparseTitle = document.createElement('p');
      sparseTitle.className = 'text-secondary mt-3 mb-2';
      sparseTitle.textContent = 'Ausgeschlossen (zu selten/zu kurze Verteilung):';
      card.appendChild(sparseTitle);

      const list = document.createElement('ul');
      list.className = 'mb-0';
      sparseTracks.slice(0, 5).forEach((track) => {
        const li = document.createElement('li');
        li.textContent = `${track.artist} - ${track.title} | Ø/Tag ${Number.isFinite(track.playsPerDay) ? track.playsPerDay.toFixed(2) : '-'} | aktive Tage ${Number(track.activeDays || 0).toLocaleString('de-DE')} | Spanntage ${Number(track.spanDays || 0).toLocaleString('de-DE')}`;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    if (resurgenceTracks.length) {
      const resurgenceTitle = document.createElement('p');
      resurgenceTitle.className = 'text-secondary mt-3 mb-2';
      resurgenceTitle.textContent = 'Ausgeschlossen (aktueller Revival-/Trend-Track):';
      card.appendChild(resurgenceTitle);

      const list = document.createElement('ul');
      list.className = 'mb-0';
      resurgenceTracks.slice(0, 5).forEach((track) => {
        const li = document.createElement('li');
        const stationCount = Number(track.globalTrendStationCount || 0);
        const stationPart = stationCount > 0 ? ` | Sender ${stationCount.toLocaleString('de-DE')}` : '';
        li.textContent =
          `${track.artist} - ${track.title} | ` +
          `Recent Ø/Tag ${Number.isFinite(track.recentPlaysPerDay) ? track.recentPlaysPerDay.toFixed(2) : '-'}${stationPart} | ` +
          `${Number(track.recentPlays || 0).toLocaleString('de-DE')} Recent-Plays`;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    if (recentTracks.length) {
      const recentTitle = document.createElement('p');
      recentTitle.className = 'text-secondary mt-3 mb-2';
      recentTitle.textContent = 'Ausgeschlossen (zu neu im Sender):';
      card.appendChild(recentTitle);

      const list = document.createElement('ul');
      list.className = 'mb-0';
      recentTracks.slice(0, 5).forEach((track) => {
        const li = document.createElement('li');
        li.textContent =
          `${track.artist} - ${track.title} | ` +
          `Release-Alter ${Number.isFinite(track.releaseAgeDays) ? Number(track.releaseAgeDays).toLocaleString('de-DE') : '-'} Tage | ` +
          `Sender-Alter ${Number(track.stationAgeDays || 0).toLocaleString('de-DE')} Tage | ` +
          `${Number(track.plays || 0).toLocaleString('de-DE')} Plays`;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    if (unknownTracks.length) {
      const candidateTitle = document.createElement('p');
      candidateTitle.className = 'text-secondary mt-3 mb-2';
      candidateTitle.textContent = 'Hinweis Metadaten (nicht für Rotation nötig):';
      card.appendChild(candidateTitle);

      const list = document.createElement('ul');
      list.className = 'mb-0';
      unknownTracks.slice(0, 5).forEach((track) => {
        const li = document.createElement('li');
        li.textContent = `${track.artist} - ${track.title} | ${issueText(track.metadataIssue)}${Number.isFinite(track.verificationConfidence) ? ` (${track.verificationConfidence.toFixed(2)})` : ''}`;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    songCards.appendChild(card);
    renderedCardCount += 1;
  });

  if (renderedCardCount === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-secondary mb-0';
    empty.textContent = 'Keine Sender-Treffer fuer die aktuelle Suche.';
    songCards.appendChild(empty);
  }
}

async function loadBackpool() {
  const hydrate = qs('hydrateInput')?.checked === true;
  qs('state').textContent = hydrate ? 'Lade Backpool-Daten und reichere Metadaten an...' : 'Lade Backpool-Daten...';
  const params = new URLSearchParams();
  const stationId = qs('stationSelect').value;
  if (stationId) params.set('stationId', stationId);
  if (qs('fromInput').value) params.set('from', qs('fromInput').value);
  if (qs('toInput').value) params.set('to', qs('toInput').value);
  params.set('years', qs('yearsInput').value || '5');
  params.set('minPlays', qs('minPlaysInput').value || '1');
  params.set('top', qs('topInput').value || '500');
  params.set('rotationMinDailyPlays', qs('rotationMinDailyPlaysInput').value || '0.35');
  params.set('rotationMinActiveDays', qs('rotationMinActiveDaysInput').value || '5');
  params.set('rotationMinSpanDays', qs('rotationMinSpanDaysInput').value || '28');
  params.set('rotationMinReleaseAgeDays', qs('rotationMinReleaseAgeDaysInput').value || '1095');
  params.set('minTrackAgeDays', qs('minTrackAgeDaysInput').value || '30');
  params.set('rotationAdaptive', qs('rotationAdaptiveInput')?.checked ? '1' : '0');
  params.set('minConfidence', qs('minConfidenceInput').value || '0.72');
  params.set('lowRotationMaxDailyPlays', qs('lowRotationMaxDailyPlaysInput').value || '2');
  params.set('hydrate', hydrate ? '1' : '0');
  const requestedLookups = Number(qs('maxMetaLookupsInput').value || '40');
  const effectiveLookups = hydrate && !stationId ? Math.min(requestedLookups, 40) : requestedLookups;
  params.set('maxMetaLookups', String(Math.max(0, Math.min(effectiveLookups, 400))));

  if (hydrate && !stationId && requestedLookups > 40) {
    qs('state').textContent = 'Lade Backpool-Daten und reichere Metadaten an... (Lookups ohne Senderfilter auf 40 begrenzt)';
  }

  const data = await apiFetch(`/api/insights/backpool?${params.toString()}`);
  renderBackpool(data);
}

function bindReload(id) {
  const el = qs(id);
  if (!el) return;
  el.addEventListener('change', () => {
    loadBackpool().catch((error) => {
      qs('state').textContent = `Fehler: ${error.message}`;
    });
  });
}

function debounce(fn, delay = 240) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function init() {
  applyTheme();
  qs('themeToggle').addEventListener('click', toggleTheme);
  setDefaultDates();
  applyRotationPreset();
  await loadStations();
  await loadBackpool();

  qs('loadBtn').addEventListener('click', () => {
    loadBackpool().catch((error) => {
      qs('state').textContent = `Fehler: ${error.message}`;
    });
  });
  qs('sortModeBtn')?.addEventListener('click', () => {
    sortByStation = !sortByStation;
    updateSortButton();
    if (lastBackpoolData?.rows) {
      renderAllBackpoolTable(lastBackpoolData.rows, getSearchQuery());
    }
  });
  const presetSelect = qs('rotationPresetSelect');
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      applyRotationPreset();
      loadBackpool().catch((error) => {
        qs('state').textContent = `Fehler: ${error.message}`;
      });
    });
  }
  const searchInput = qs('backpoolSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(() => {
      if (lastBackpoolData) renderBackpool(lastBackpoolData);
    }));
  }
  ['stationSelect', 'fromInput', 'toInput', 'yearsInput', 'minPlaysInput', 'topInput', 'rotationMinDailyPlaysInput', 'rotationMinActiveDaysInput', 'rotationMinSpanDaysInput', 'rotationMinReleaseAgeDaysInput', 'minTrackAgeDaysInput', 'rotationAdaptiveInput', 'minConfidenceInput', 'lowRotationMaxDailyPlaysInput', 'maxMetaLookupsInput', 'hydrateInput'].forEach(bindReload);
}

init().catch((error) => {
  qs('state').textContent = `Fehler: ${error.message}`;
});
