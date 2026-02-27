const qs = (id) => document.getElementById(id);

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
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 90);
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

function renderBackpool(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const songCards = qs('songCards');
  songCards.innerHTML = '';

  if (!rows.length) {
    qs('state').textContent = 'Keine Backpool-Daten für den gewählten Zeitraum.';
    qs('summary').textContent = '-';
    return;
  }

  qs('state').textContent = `Zeitraum ${data.from} bis ${data.to} | Backpool-Cutoff: ${data.cutoff} | Min. Confidence: ${Number(data.minReleaseConfidence ?? 0.72).toFixed(2)}`;
  const shownSongs = rows.reduce((sum, row) => sum + Number(row.backpoolTrackCount || 0), 0);
  qs('summary').textContent = `Streng validierte Backpool-Songs: ${shownSongs.toLocaleString('de-DE')} (Sender: ${rows.length.toLocaleString('de-DE')})`;

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

  rows.forEach((row) => {
    const card = document.createElement('article');
    card.className = 'backpool-card';
    const head = document.createElement('div');
    head.className = 'backpool-card-head';
    head.innerHTML = `
      <div class="backpool-card-title">${row.stationName}</div>
      <div class="backpool-card-meta">${Number(row.backpoolTrackCount || 0).toLocaleString('de-DE')} Backpool-Titel | ${Number(row.backpoolPlays || 0).toLocaleString('de-DE')} Plays</div>
    `;
    card.appendChild(head);

    const tracks = Array.isArray(row.topBackpoolTracks) ? row.topBackpoolTracks : [];
    const unknownTracks = Array.isArray(row.unknownReleaseTracks) ? row.unknownReleaseTracks : [];
    const missingRelease = Math.max(0, Number(row.totalTracks || 0) - Number(row.tracksWithRelease || 0));
    if (!tracks.length) {
      const empty = document.createElement('p');
      empty.className = 'text-secondary mb-0';
      empty.textContent = `Keine validierten Backpool-Titel im Zeitraum. Fehlende oder unvalidierte Release-Daten bei ${missingRelease.toLocaleString('de-DE')} Tracks.`;
      card.appendChild(empty);
      if (unknownTracks.length) {
        const candidateTitle = document.createElement('p');
        candidateTitle.className = 'text-secondary mt-3 mb-2';
        candidateTitle.textContent = 'Top unvalidierte Titel (nicht als Backpool gewertet):';
        card.appendChild(candidateTitle);

        const list = document.createElement('ul');
        list.className = 'mb-0';
        unknownTracks.forEach((track) => {
          const li = document.createElement('li');
          li.textContent = `${track.artist} - ${track.title} | ${Number(track.plays || 0).toLocaleString('de-DE')} Plays | ${issueText(track.metadataIssue)}${Number.isFinite(track.verificationConfidence) ? ` (${track.verificationConfidence.toFixed(2)})` : ''}`;
          list.appendChild(li);
        });
        card.appendChild(list);
      }
      songCards.appendChild(card);
      return;
    }

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    const hint = document.createElement('p');
    hint.className = 'text-secondary mb-2';
    hint.textContent = `Release-Daten vorhanden für ${Number(row.tracksWithRelease || 0).toLocaleString('de-DE')} von ${Number(row.totalTracks || 0).toLocaleString('de-DE')} Tracks.`;
    card.appendChild(hint);
    const table = document.createElement('table');
    table.className = 'table table-sm align-middle mb-0';
    table.innerHTML = `
      <thead>
        <tr>
          <th>#</th>
          <th>Song</th>
          <th>Plays</th>
          <th>Release</th>
          <th>Alter</th>
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
        Number.isFinite(track.verificationConfidence) ? `Conf ${track.verificationConfidence.toFixed(2)}` : null
      ].filter(Boolean).join(' | ') || ' ';
      songCell.appendChild(meta);

      tr.innerHTML = `
        <td>${index + 1}</td>
        <td></td>
        <td>${Number(track.plays || 0).toLocaleString('de-DE')}</td>
        <td>${track.releaseDate || '-'}</td>
        <td>${Number.isFinite(track.ageYears) ? `${track.ageYears.toFixed(1)} Jahre` : '-'}</td>
      `;
      tr.children[1].replaceWith(songCell);
      tbody.appendChild(tr);
    });

    tableWrap.appendChild(table);
    card.appendChild(tableWrap);

    if (unknownTracks.length) {
      const candidateTitle = document.createElement('p');
      candidateTitle.className = 'text-secondary mt-3 mb-2';
      candidateTitle.textContent = 'Top unvalidierte Titel (nicht als Backpool gewertet):';
      card.appendChild(candidateTitle);

      const list = document.createElement('ul');
      list.className = 'mb-0';
      unknownTracks.forEach((track) => {
        const li = document.createElement('li');
        li.textContent = `${track.artist} - ${track.title} | ${Number(track.plays || 0).toLocaleString('de-DE')} Plays | ${issueText(track.metadataIssue)}${Number.isFinite(track.verificationConfidence) ? ` (${track.verificationConfidence.toFixed(2)})` : ''}`;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    songCards.appendChild(card);
  });
}

async function loadBackpool() {
  qs('state').textContent = 'Lade Backpool-Daten...';
  const params = new URLSearchParams();
  const stationId = qs('stationSelect').value;
  if (stationId) params.set('stationId', stationId);
  if (qs('fromInput').value) params.set('from', qs('fromInput').value);
  if (qs('toInput').value) params.set('to', qs('toInput').value);
  params.set('years', qs('yearsInput').value || '5');
  params.set('minPlays', qs('minPlaysInput').value || '3');
  params.set('top', qs('topInput').value || '10');
  params.set('minConfidence', qs('minConfidenceInput').value || '0.72');
  params.set('hydrate', '0');

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

async function init() {
  applyTheme();
  qs('themeToggle').addEventListener('click', toggleTheme);
  setDefaultDates();
  await loadStations();
  await loadBackpool();

  qs('loadBtn').addEventListener('click', () => {
    loadBackpool().catch((error) => {
      qs('state').textContent = `Fehler: ${error.message}`;
    });
  });
  ['stationSelect', 'fromInput', 'toInput', 'yearsInput', 'minPlaysInput', 'topInput', 'minConfidenceInput'].forEach(bindReload);
}

init().catch((error) => {
  qs('state').textContent = `Fehler: ${error.message}`;
});
