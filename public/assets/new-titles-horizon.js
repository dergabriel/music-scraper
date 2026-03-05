import { berlinTodayIsoDate, shiftBerlinIsoDate } from './date-berlin.js';
import {
  React,
  createRoot,
  Chakra,
  html,
  horizonTheme,
  apiFetch,
  formatDateTime,
  formatNumber,
  useDebouncedValue,
  AppShell,
  PanelCard,
  useUiColors,
  Icons
} from './horizon-lib.js';
import {
  looksLikeNonMusicTitle,
  dedupeTracksByIdentity,
  displayTrackIdentity,
  releaseAgeDays,
  matchesSearch
} from './music-quality.js';

function fmtDateOnly(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('de-DE');
}

function daysText(days) {
  if (days == null) return 'ohne Release-Datum';
  if (days <= 0) return 'heute veröffentlicht';
  if (days === 1) return '1 Tag alt';
  if (days < 365) return `${days} Tage alt`;
  return `${(days / 365).toFixed(1).replace('.', ',')} Jahre alt`;
}

function PreviewControl({ previewUrl, externalUrl, compact = false }) {
  if (previewUrl) {
    return html`
      <${Chakra.HStack} spacing="2" align="center">
        <audio controls preload="none" src=${previewUrl} style=${{ height: '30px', width: compact ? '170px' : '220px' }} />
        ${externalUrl
          ? html`<${Chakra.Link} href=${externalUrl} target="_blank" rel="noreferrer" color="teal.500">iTunes<//>`
          : null}
      <//>
    `;
  }

  if (externalUrl) {
    return html`<${Chakra.Link} href=${externalUrl} target="_blank" rel="noreferrer" color="teal.500">Titelseite<//>`;
  }

  return html`<${Chakra.Tag} size="sm" colorScheme="orange" borderRadius="999px">Kein Preview<//>`;
}

async function copyToClipboard(value) {
  const text = String(value || '').trim();
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  document.execCommand('copy');
  area.remove();
}

function NewTitlesApp() {
  const ui = useUiColors();
  const [stations, setStations] = React.useState([]);
  const [rowsRaw, setRowsRaw] = React.useState([]);

  const today = berlinTodayIsoDate();
  const [from, setFrom] = React.useState(shiftBerlinIsoDate(today, -7));
  const [to, setTo] = React.useState(today);
  const [stationId, setStationId] = React.useState('');
  const [minPlays, setMinPlays] = React.useState('1');
  const [limit, setLimit] = React.useState('250');
  const [search, setSearch] = React.useState('');

  const [onlyRecentRelease, setOnlyRecentRelease] = React.useState(true);
  const [maxReleaseAgeYears, setMaxReleaseAgeYears] = React.useState('2');
  const [requireReleaseDate, setRequireReleaseDate] = React.useState(true);
  const [minReleaseConfidence, setMinReleaseConfidence] = React.useState('0.55');
  const [excludeNoise, setExcludeNoise] = React.useState(true);

  const [loading, setLoading] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const debouncedSearch = useDebouncedValue(search, 240);

  const processed = React.useMemo(() => {
    const maxAgeYears = Math.max(0, Number(maxReleaseAgeYears || 0));
    const maxAgeDays = Math.round(maxAgeYears * 365);
    const reasons = {
      oldRelease: 0,
      missingRelease: 0,
      noise: 0,
      search: 0
    };

    const withFlags = (rowsRaw || []).map((row) => {
      const ageDays = releaseAgeDays(row.release_date_utc, berlinTodayIsoDate());
      const noise = looksLikeNonMusicTitle(row.artist, row.title);
      return {
        ...row,
        station_count: Number(row.station_count || 0),
        total_plays: Number(row.total_plays || 0),
        ageDays,
        noise,
        _id: displayTrackIdentity(row)
      };
    });

    const deduped = dedupeTracksByIdentity(withFlags, { identityFn: displayTrackIdentity }).map((row) => ({
      ...row,
      _id: displayTrackIdentity(row)
    }));

    const filtered = [];
    for (const row of deduped) {
      if (excludeNoise && row.noise) {
        reasons.noise += 1;
        continue;
      }
      if (requireReleaseDate && row.ageDays == null) {
        reasons.missingRelease += 1;
        continue;
      }
      if (onlyRecentRelease && row.ageDays != null && row.ageDays > maxAgeDays) {
        reasons.oldRelease += 1;
        continue;
      }
      if (!matchesSearch(row, debouncedSearch)) {
        reasons.search += 1;
        continue;
      }
      filtered.push(row);
    }

    filtered.sort((a, b) => {
      const aFirst = Date.parse(String(a.first_played_at_utc || ''));
      const bFirst = Date.parse(String(b.first_played_at_utc || ''));
      if (Number.isFinite(aFirst) && Number.isFinite(bFirst) && bFirst !== aFirst) return bFirst - aFirst;
      if (b.total_plays !== a.total_plays) return b.total_plays - a.total_plays;
      return String(a.artist || '').localeCompare(String(b.artist || ''), 'de', { sensitivity: 'base' });
    });

    return {
      rows: filtered,
      reasons,
      maxAgeDays
    };
  }, [rowsRaw, excludeNoise, requireReleaseDate, onlyRecentRelease, maxReleaseAgeYears, debouncedSearch]);

  const kpis = React.useMemo(() => {
    const rows = processed.rows;
    const plays = rows.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
    const verifiedReleases = rows.filter((row) => row.ageDays != null).length;
    const todayIso = berlinTodayIsoDate();
    const weekStart = shiftBerlinIsoDate(todayIso, -6);

    let todayCount = 0;
    let weekCount = 0;
    for (const row of rows) {
      const first = String(row.first_played_at_utc || '').slice(0, 10);
      if (first === todayIso) todayCount += 1;
      if (first >= weekStart && first <= todayIso) weekCount += 1;
    }

    return {
      count: rows.length,
      plays,
      todayCount,
      weekCount,
      verifiedReleases
    };
  }, [processed.rows]);

  const spotlight = React.useMemo(() => processed.rows.slice(0, 6), [processed.rows]);

  const loadStations = React.useCallback(async () => {
    const data = await apiFetch('/api/stations');
    setStations(Array.isArray(data) ? data : []);
  }, []);

  const loadRows = React.useCallback(async () => {
    setLoading(true);
    setErrorText('');
    try {
      const params = new URLSearchParams();
      params.set('from', from || shiftBerlinIsoDate(berlinTodayIsoDate(), -30));
      params.set('to', to || berlinTodayIsoDate());
      params.set('limit', limit || '250');
      params.set('minPlays', minPlays || '1');
      params.set('requireReleaseDate', requireReleaseDate ? '1' : '0');
      params.set('minReleaseConfidence', minReleaseConfidence || '0.55');
      if (onlyRecentRelease) {
        const maxAgeYears = Math.max(0, Number(maxReleaseAgeYears || 0));
        params.set('maxReleaseAgeDays', String(Math.round(maxAgeYears * 365)));
      } else {
        params.set('maxReleaseAgeDays', '36500');
      }
      if (stationId) params.set('station', stationId);
      const data = await apiFetch(`/api/new-titles?${params.toString()}`);
      setRowsRaw(Array.isArray(data.rows) ? data.rows : []);
    } catch (error) {
      setRowsRaw([]);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [from, to, limit, minPlays, stationId, requireReleaseDate, onlyRecentRelease, maxReleaseAgeYears, minReleaseConfidence]);

  React.useEffect(() => {
    loadStations().catch((error) => {
      setErrorText(error instanceof Error ? error.message : String(error));
    });
  }, [loadStations]);

  React.useEffect(() => {
    loadRows();
  }, [loadRows]);

  const applyRange = (days) => {
    const end = berlinTodayIsoDate();
    const start = shiftBerlinIsoDate(end, -(days - 1));
    setFrom(start);
    setTo(end);
  };

  return html`
    <${AppShell}
      activeKey="new-titles"
      title="Neue Titel"
      subtitle="Neu im Monitoring: Titel mit erstem Play im gewählten Zeitraum"
      controls=${html`
        <${Chakra.Button}
          size="sm"
          leftIcon=${React.createElement(Icons.RepeatIcon)}
          onClick=${() => loadRows()}
          isLoading=${loading}
          colorScheme="blue"
        >Neu laden<//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">
        ${errorText ? html`
          <${Chakra.Alert} status="error" borderRadius="14px">
            <${Chakra.AlertIcon} />
            <${Chakra.Text}>${errorText}<//>
          <//>
        ` : null}

        <${PanelCard}
          title="So liest du die Seite"
          subtitle="Neu = erster Play im Zeitraum. Für echte Neuerscheinungen: verifizierte Releases aktivieren."
          right=${html`<${Chakra.Badge} colorScheme="blue" borderRadius="999px" px="3" py="1">Fokus: wirklich neu<//>`}
        >
          <${Chakra.HStack} spacing="3" flexWrap="wrap">
            <${Chakra.Tag} colorScheme="green" borderRadius="999px">Release max. ${maxReleaseAgeYears} Jahre (wenn bekannt)<//>
            <${Chakra.Tag} colorScheme="purple" borderRadius="999px">Nicht-Musik wird ausgeblendet<//>
            <${Chakra.Tag} colorScheme="blue" borderRadius="999px">Sortiert nach erstem Play<//>
          <//>
        <//>

        <${PanelCard} title="Filter">
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2, xl: 6 }} spacing="3">
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Sender<//>
              <${Chakra.Select} value=${stationId} onChange=${(event) => setStationId(event.target.value)}>
                <option value="">Alle Sender</option>
                ${stations.map((station) => html`<option key=${station.id} value=${station.id}>${station.name || station.id}</option>`)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Von<//>
              <${Chakra.Input} type="date" value=${from} onChange=${(event) => setFrom(event.target.value)} />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Bis<//>
              <${Chakra.Input} type="date" value=${to} onChange=${(event) => setTo(event.target.value)} />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Min. Einsätze<//>
              <${Chakra.Input} type="number" min="1" max="200" value=${minPlays} onChange=${(event) => setMinPlays(event.target.value)} />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Max. Titel<//>
              <${Chakra.Select} value=${limit} onChange=${(event) => setLimit(event.target.value)}>
                ${['100', '250', '500', '1000'].map((v) => html`<option key=${v} value=${v}>${v}</option>`)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Suche<//>
              <${Chakra.Input} value=${search} onChange=${(event) => setSearch(event.target.value)} placeholder="Interpret oder Titel" />
            <//>
          <//>

          <${Chakra.HStack} spacing="2" mt="3" flexWrap="wrap">
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(3)}>3 Tage<//>
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(7)}>7 Tage<//>
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(30)}>30 Tage<//>
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(90)}>90 Tage<//>
            <${Chakra.Button} size="sm" colorScheme="blue" onClick=${() => loadRows()} isLoading=${loading}>Laden<//>
          <//>

          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2, xl: 5 }} spacing="3" mt="4">
            <${Chakra.Checkbox} isChecked=${onlyRecentRelease} onChange=${(event) => setOnlyRecentRelease(event.target.checked)}>
              Nur aktuelle Releases
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Release max. Jahre<//>
              <${Chakra.Input} type="number" min="0" max="30" value=${maxReleaseAgeYears} onChange=${(event) => setMaxReleaseAgeYears(event.target.value)} />
            <//>
            <${Chakra.Checkbox} isChecked=${requireReleaseDate} onChange=${(event) => setRequireReleaseDate(event.target.checked)}>
              Nur verifizierte Neuerscheinungen
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Min. Confidence<//>
              <${Chakra.Input} type="number" min="0" max="1" step="0.01" value=${minReleaseConfidence} onChange=${(event) => setMinReleaseConfidence(event.target.value)} />
            <//>
            <${Chakra.Checkbox} isChecked=${excludeNoise} onChange=${(event) => setExcludeNoise(event.target.checked)}>
              Nicht-Musik ausblenden
            <//>
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 2, lg: 4 }} spacing="3">
          <${StatCard} label="Neue Titel" value=${formatNumber(kpis.count)} />
          <${StatCard} label="Verifizierte Releases" value=${formatNumber(kpis.verifiedReleases)} />
          <${StatCard} label="Neu heute" value=${formatNumber(kpis.todayCount)} />
          <${StatCard} label="Neu letzte 7 Tage" value=${formatNumber(kpis.weekCount)} />
        <//>

        <${PanelCard} title="Qualitätsfilter" subtitle="Was wurde ausgeblendet und warum?">
          <${Chakra.HStack} spacing="3" flexWrap="wrap">
            <${Chakra.Tag} colorScheme="orange" borderRadius="999px">Zu alt: ${formatNumber(processed.reasons.oldRelease)}<//>
            <${Chakra.Tag} colorScheme="gray" borderRadius="999px">Kein Release: ${formatNumber(processed.reasons.missingRelease)}<//>
            <${Chakra.Tag} colorScheme="red" borderRadius="999px">Nicht-Musik: ${formatNumber(processed.reasons.noise)}<//>
            <${Chakra.Tag} colorScheme="blue" borderRadius="999px">Suchfilter: ${formatNumber(processed.reasons.search)}<//>
          <//>
        <//>

        <${PanelCard} title="Zuletzt neu hinzugefügt" subtitle=${spotlight.length ? 'Aktuelle Highlights' : 'Keine Treffer'}>
          <${Chakra.SimpleGrid} columns=${{ base: 1, lg: 2, xl: 3 }} spacing="3">
            ${spotlight.map((row) => html`
              <${Chakra.Box} key=${row._id} border="1px solid" borderColor=${ui.lineColor} borderRadius="14px" p="3">
                <${Chakra.HStack} justify="space-between" mb="2">
                  <${Chakra.Badge} colorScheme=${row.ageDays == null ? 'gray' : row.ageDays <= 14 ? 'green' : 'orange'}>
                    ${daysText(row.ageDays)}
                  <//>
                  <${Chakra.HStack} spacing="2">
                    <${PreviewControl} previewUrl=${row.preview_url} externalUrl=${row.external_url} compact=${true} />
                    <${Chakra.Link} href=${`/dashboard?trackKey=${encodeURIComponent(row.track_key)}`} color="blue.500">Öffnen<//>
                  <//>
                <//>
                <${Chakra.Text} fontWeight="700" color=${ui.textPrimary}>${row.artist} - ${row.title}<//>
                <${Chakra.HStack} spacing="2" mt="1">
                  <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>Track ID: ${row.track_key || '-'}<//>
                  ${row.track_key ? html`
                    <${Chakra.Button} size="xs" variant="outline" onClick=${() => copyToClipboard(row.track_key)}>Kopieren<//>
                  ` : null}
                <//>
                <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Erstes Play: ${formatDateTime(row.first_played_at_utc)}<//>
                <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Release: ${fmtDateOnly(row.release_date_utc)}<//>
                <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Plays: ${formatNumber(row.total_plays)} | Sender: ${formatNumber(row.station_count)}${row.ageDays == null ? ' | Release offen' : ''}<//>
              <//>
            `)}
          <//>
        <//>

        <${PanelCard} title="Neue Titel Liste" subtitle=${loading ? 'Lade...' : `${formatNumber(processed.rows.length)} Titel sichtbar`}>
          <${Chakra.TableContainer} maxH="640px" overflowY="auto" className="horizon-scroll" border="1px solid" borderColor=${ui.lineColor} borderRadius="14px">
            <${Chakra.Table} size="sm">
              <${Chakra.Thead}>
                <${Chakra.Tr}>
                  <${Chakra.Th}>Titel<//>
                  <${Chakra.Th}>Einsätze<//>
                  <${Chakra.Th}>Erster Einsatz<//>
                  <${Chakra.Th}>Release<//>
                  <${Chakra.Th}>Sender<//>
                  <${Chakra.Th}>Analyse<//>
                <//>
              <//>
              <${Chakra.Tbody}>
                ${processed.rows.map((row) => html`
                  <${Chakra.Tr} key=${row._id}>
                    <${Chakra.Td}>
                      <${Chakra.Text} fontWeight="700" color=${ui.textPrimary}>${row.artist}<//>
                      <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
                      <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>ID: ${row.track_key || '-'}<//>
                    <//>
                    <${Chakra.Td}>${formatNumber(row.total_plays)}<//>
                    <${Chakra.Td}>${formatDateTime(row.first_played_at_utc)}<//>
                    <${Chakra.Td}>
                      <${Chakra.Text}>${fmtDateOnly(row.release_date_utc)}<//>
                      <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${daysText(row.ageDays)}<//>
                    <//>
                    <${Chakra.Td}>${formatNumber(row.station_count)}<//>
                    <${Chakra.Td}>
                      <${Chakra.VStack} align="start" spacing="1">
                        <${Chakra.Link} href=${`/dashboard?trackKey=${encodeURIComponent(row.track_key)}`} color="blue.500">Öffnen<//>
                        <${PreviewControl} previewUrl=${row.preview_url} externalUrl=${row.external_url} compact=${true} />
                        ${row.track_key ? html`
                          <${Chakra.Button} size="xs" variant="outline" onClick=${() => copyToClipboard(row.track_key)}>ID kopieren<//>
                        ` : null}
                      <//>
                    <//>
                  <//>
                `)}
                ${processed.rows.length === 0 && !loading ? html`
                  <${Chakra.Tr}><${Chakra.Td} colSpan="6" color=${ui.textMuted}>Keine passenden neuen Titel. Zeitraum/Filter anpassen oder Ingest laufen lassen.<//><//>
                ` : null}
              <//>
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

function StatCard({ label, value }) {
  const ui = useUiColors();
  return html`
    <${PanelCard} p="4">
      <${Chakra.Text} fontSize="xs" color=${ui.textMuted} mb="1">${label}<//>
      <${Chakra.Text} fontSize="2xl" fontWeight="800" color=${ui.textPrimary}>${value}<//>
    <//>
  `;
}

function Root() {
  return html`
    <${Chakra.ChakraProvider} theme=${horizonTheme}>
      <${NewTitlesApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
