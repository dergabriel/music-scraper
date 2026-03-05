import { weekStartBerlinIso } from './date-berlin.js';
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

const SORT_OPTIONS = [
  { value: 'plays_per_day_desc', label: 'Plays/Tag absteigend' },
  { value: 'plays_per_day_asc', label: 'Plays/Tag aufsteigend' },
  { value: 'total_plays_desc', label: 'Plays gesamt absteigend' },
  { value: 'total_plays_asc', label: 'Plays gesamt aufsteigend' },
  { value: 'last_played_desc', label: 'Letztes Play neueste zuerst' },
  { value: 'last_played_asc', label: 'Letztes Play älteste zuerst' },
  { value: 'artist_asc', label: 'Interpret A-Z' },
  { value: 'artist_desc', label: 'Interpret Z-A' }
];

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sortRows(rows, sortMode) {
  const data = [...(Array.isArray(rows) ? rows : [])];
  const byString = (a, b) => String(a || '').localeCompare(String(b || ''), 'de', { sensitivity: 'base' });
  const byDate = (a, b) => toNumber(new Date(a).getTime()) - toNumber(new Date(b).getTime());

  data.sort((a, b) => {
    if (sortMode === 'plays_per_day_desc') return toNumber(b.plays_per_day) - toNumber(a.plays_per_day);
    if (sortMode === 'plays_per_day_asc') return toNumber(a.plays_per_day) - toNumber(b.plays_per_day);
    if (sortMode === 'total_plays_desc') return toNumber(b.total_plays) - toNumber(a.total_plays);
    if (sortMode === 'total_plays_asc') return toNumber(a.total_plays) - toNumber(b.total_plays);
    if (sortMode === 'last_played_desc') return byDate(b.last_played_at_utc, a.last_played_at_utc);
    if (sortMode === 'last_played_asc') return byDate(a.last_played_at_utc, b.last_played_at_utc);
    if (sortMode === 'artist_desc') return byString(b.artist, a.artist);
    return byString(a.artist, b.artist);
  });

  return data;
}

function TracksApp() {
  const ui = useUiColors();
  const [stations, setStations] = React.useState([]);
  const [rows, setRows] = React.useState([]);
  const [selectedTrackKey, setSelectedTrackKey] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [stationId, setStationId] = React.useState('');
  const [limit, setLimit] = React.useState('100');
  const [sortMode, setSortMode] = React.useState('plays_per_day_desc');
  const [loading, setLoading] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const [winnerTrackKey, setWinnerTrackKey] = React.useState('');
  const [loserTrackKey, setLoserTrackKey] = React.useState('');
  const [mergeState, setMergeState] = React.useState('Noch kein manueller Merge ausgeführt.');

  const [reportStationId, setReportStationId] = React.useState('');
  const [reportWeekStart, setReportWeekStart] = React.useState(weekStartBerlinIso());
  const [reportRows, setReportRows] = React.useState([]);
  const [reportState, setReportState] = React.useState('Noch kein Senderbericht geladen.');

  const debouncedSearch = useDebouncedValue(search, 250);
  const toast = Chakra.useToast();

  const sortedRows = React.useMemo(() => sortRows(rows, sortMode), [rows, sortMode]);
  const selectedTrack = React.useMemo(
    () => sortedRows.find((row) => row.track_key === selectedTrackKey) || null,
    [sortedRows, selectedTrackKey]
  );

  const summary = React.useMemo(() => {
    const plays = sortedRows.reduce((sum, row) => sum + toNumber(row.total_plays), 0);
    const uniqueArtists = new Set(sortedRows.map((row) => String(row.artist || '').toLowerCase()).filter(Boolean)).size;
    const top = sortedRows[0];
    return {
      hits: sortedRows.length,
      plays,
      artists: uniqueArtists,
      topTrack: top ? `${top.artist} - ${top.title}` : '-'
    };
  }, [sortedRows]);

  const loadStations = React.useCallback(async () => {
    const data = await apiFetch('/api/stations');
    const safe = Array.isArray(data) ? data : [];
    setStations(safe);
    if (!reportStationId && safe.length) setReportStationId(safe[0].id);
  }, [reportStationId]);

  const loadRows = React.useCallback(async () => {
    setLoading(true);
    setErrorText('');
    try {
      const params = new URLSearchParams({ q: debouncedSearch, stationId, limit });
      if (!debouncedSearch) params.delete('q');
      if (!stationId) params.delete('stationId');
      if (!limit) params.delete('limit');
      const data = await apiFetch(`/api/tracks?${params.toString()}`);
      const safeRows = Array.isArray(data) ? data : [];
      setRows(safeRows);
      const nextSelected = safeRows.find((row) => row.track_key === selectedTrackKey)?.track_key || safeRows[0]?.track_key || '';
      setSelectedTrackKey(nextSelected);
    } catch (error) {
      setRows([]);
      setSelectedTrackKey('');
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, stationId, limit, selectedTrackKey]);

  const runMerge = async () => {
    if (!winnerTrackKey.trim() || !loserTrackKey.trim()) {
      setMergeState('Bitte beide Track Keys ausfüllen.');
      return;
    }
    try {
      const result = await apiFetch('/api/admin/merge-tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          winnerTrackKey: winnerTrackKey.trim(),
          loserTrackKey: loserTrackKey.trim()
        })
      });
      setMergeState(`Merge abgeschlossen: ${formatNumber(result?.updatedPlays || 0)} Plays aktualisiert.`);
      toast({ status: 'success', title: 'Merge abgeschlossen' });
      await loadRows();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setMergeState(`Merge fehlgeschlagen: ${msg}`);
      toast({ status: 'error', title: 'Merge fehlgeschlagen', description: msg });
    }
  };

  const loadStationReport = async () => {
    if (!reportStationId) {
      setReportRows([]);
      setReportState('Bitte einen Sender auswählen.');
      return;
    }
    try {
      setReportState('Lade Senderbericht...');
      const data = await apiFetch(`/api/reports/station/${encodeURIComponent(reportStationId)}?weekStart=${encodeURIComponent(reportWeekStart)}`);
      const topRows = Array.isArray(data?.report?.topTracks) ? data.report.topTracks.slice(0, 12) : [];
      setReportRows(topRows);
      setReportState(`${formatNumber(topRows.length)} Top-Titel für die Woche ${reportWeekStart}.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setReportRows([]);
      setReportState(`Fehler beim Laden: ${msg}`);
    }
  };

  React.useEffect(() => {
    loadStations().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorText(msg);
    });
  }, [loadStations]);

  React.useEffect(() => {
    loadRows();
  }, [loadRows]);

  return html`
    <${AppShell}
      activeKey="tracks"
      title="Statistik"
      subtitle="Einheitliche Übersicht für Track-Katalog, Senderreport und Admin-Merge"
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
          title="So liest du die Statistik"
          subtitle="Filter setzen · Trefferliste sortieren · direkt in die Detailanalyse springen"
          right=${html`<${Chakra.Badge} colorScheme="blue" borderRadius="999px" px="3" py="1">Konsistentes UI<//>`}
        >
          <${Chakra.HStack} spacing="3" flexWrap="wrap">
            <${Chakra.Tag} colorScheme="blue" borderRadius="999px">Plays/Tag als Standard<//>
            <${Chakra.Tag} colorScheme="green" borderRadius="999px">Direkter Link zur Song-Analyse<//>
            <${Chakra.Tag} colorScheme="purple" borderRadius="999px">Admin-Merge integriert<//>
          <//>
        <//>

        <${PanelCard} title="Filter">
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2, xl: 5 }} spacing="3">
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Suche<//>
              <${Chakra.Input} value=${search} onChange=${(event) => setSearch(event.target.value)} placeholder="Interpret oder Titel" />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Sender<//>
              <${Chakra.Select} value=${stationId} onChange=${(event) => setStationId(event.target.value)}>
                <option value="">Alle Sender</option>
                ${stations.map((station) => html`<option key=${station.id} value=${station.id}>${station.name || station.id}</option>`)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Limit<//>
              <${Chakra.Select} value=${limit} onChange=${(event) => setLimit(event.target.value)}>
                ${['100', '250', '500', '1000', 'all'].map((value) => html`<option key=${value} value=${value}>${value === 'all' ? 'Insgesamt' : value}</option>`)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Sortierung<//>
              <${Chakra.Select} value=${sortMode} onChange=${(event) => setSortMode(event.target.value)}>
                ${SORT_OPTIONS.map((option) => html`<option key=${option.value} value=${option.value}>${option.label}</option>`)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} visibility="hidden">Laden<//>
              <${Chakra.Button} colorScheme="blue" onClick=${() => loadRows()} isLoading=${loading} w="100%">Laden<//>
            <//>
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 2, lg: 4 }} spacing="3">
          <${StatCard} label="Treffer" value=${formatNumber(summary.hits)} />
          <${StatCard} label="Plays gesamt" value=${formatNumber(summary.plays)} />
          <${StatCard} label="Künstler" value=${formatNumber(summary.artists)} />
          <${StatCard} label="Ausgewählter Titel" value=${selectedTrack ? `${selectedTrack.artist} - ${selectedTrack.title}` : '-'} compact=${true} />
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 3 }} spacing="4">
          <${PanelCard}
            title="Track-Liste"
            subtitle=${loading ? 'Lade...' : `${formatNumber(sortedRows.length)} geladen`}
            p="4"
          >
            <${Chakra.TableContainer} maxH="650px" overflowY="auto" className="horizon-scroll" border="1px solid" borderColor=${ui.lineColor} borderRadius="14px">
                <${Chakra.Table} size="sm">
                  <${Chakra.Thead}>
                  <${Chakra.Tr}>
                    <${Chakra.Th}>Track<//>
                    <${Chakra.Th}>Plays<//>
                    <${Chakra.Th}>Plays/Tag<//>
                    <${Chakra.Th}>Erstes Play<//>
                    <${Chakra.Th}>Letztes Play<//>
                    <${Chakra.Th}>Analyse<//>
                  <//>
                <//>
                <${Chakra.Tbody}>
                  ${sortedRows.map((row) => html`
                    <${Chakra.Tr}
                      key=${row.track_key}
                      onClick=${() => setSelectedTrackKey(row.track_key)}
                      cursor="pointer"
                      bg=${row.track_key === selectedTrackKey ? ui.subtleBg : 'transparent'}
                      _hover=${{ bg: ui.subtleBg }}
                    >
                      <${Chakra.Td}>
                        <${Chakra.Text} fontWeight="700" color=${ui.textPrimary}>${row.artist}<//>
                        <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
                        <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>ID: ${row.track_key}<//>
                      <//>
                      <${Chakra.Td}>${formatNumber(row.total_plays)}<//>
                      <${Chakra.Td}>${toNumber(row.plays_per_day).toLocaleString('de-DE', { maximumFractionDigits: 2 })}<//>
                      <${Chakra.Td}>${formatDateTime(row.first_played_at_utc)}<//>
                      <${Chakra.Td}>${formatDateTime(row.last_played_at_utc)}<//>
                      <${Chakra.Td}>
                        <${Chakra.VStack} align="start" spacing="1">
                          <${Chakra.Link} href=${`/dashboard?trackKey=${encodeURIComponent(row.track_key)}`} color="blue.500" onClick=${(event) => event.stopPropagation()}>Öffnen<//>
                          <${Chakra.Button} size="xs" variant="outline" onClick=${(event) => { event.stopPropagation(); setWinnerTrackKey(row.track_key); }}>Als Winner<//>
                          <${Chakra.Button} size="xs" variant="outline" onClick=${(event) => { event.stopPropagation(); setLoserTrackKey(row.track_key); }}>Als Loser<//>
                        <//>
                      <//>
                    <//>
                  `)}
                  ${sortedRows.length === 0 && !loading ? html`
                    <${Chakra.Tr}>
                      <${Chakra.Td} colSpan="6" color=${ui.textMuted}>Keine Treffer. Filter anpassen oder Ingest laufen lassen.<//>
                    <//>
                  ` : null}
                <//>
              <//>
            <//>
          <//>

          <${Chakra.VStack} align="stretch" spacing="4">
            <${PanelCard} title="Power Admin: Merge" p="4">
              <${Chakra.VStack} align="stretch" spacing="3">
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Winner Track Key<//>
                  <${Chakra.Input} value=${winnerTrackKey} onChange=${(event) => setWinnerTrackKey(event.target.value)} />
                <//>
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Loser Track Key<//>
                  <${Chakra.Input} value=${loserTrackKey} onChange=${(event) => setLoserTrackKey(event.target.value)} />
                <//>
                <${Chakra.Button} colorScheme="red" variant="outline" onClick=${runMerge}>Merge ausführen<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${mergeState}<//>
              <//>
            <//>

            <${PanelCard} title="Senderbericht (Woche)" p="4">
              <${Chakra.VStack} align="stretch" spacing="3">
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Sender<//>
                  <${Chakra.Select} value=${reportStationId} onChange=${(event) => setReportStationId(event.target.value)}>
                    <option value="">Bitte wählen</option>
                    ${stations.map((station) => html`<option key=${station.id} value=${station.id}>${station.name || station.id}</option>`)}
                  <//>
                <//>
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Wochenstart<//>
                  <${Chakra.Input} type="date" value=${reportWeekStart} onChange=${(event) => setReportWeekStart(event.target.value)} />
                <//>
                <${Chakra.Button} colorScheme="blue" onClick=${loadStationReport}>Report laden<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${reportState}<//>
                <${Chakra.VStack} align="stretch" spacing="2" maxH="220px" overflowY="auto" className="horizon-scroll">
                  ${reportRows.map((row, idx) => html`
                    <${Chakra.HStack} key=${row.track_key || `${idx}`} justify="space-between" border="1px solid" borderColor=${ui.lineColor} borderRadius="10px" px="2" py="1">
                      <${Chakra.Text} fontSize="xs" noOfLines=${1}>${row.artist} - ${row.title}<//>
                      <${Chakra.Badge} colorScheme="blue">${formatNumber(row.count || 0)}<//>
                    <//>
                  `)}
                <//>
              <//>
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

function StatCard({ label, value, compact = false }) {
  const ui = useUiColors();
  return html`
    <${PanelCard} p="4">
      <${Chakra.Text} fontSize="xs" color=${ui.textMuted} mb="1">${label}<//>
      <${Chakra.Text} fontSize=${compact ? 'sm' : '2xl'} fontWeight="800" color=${ui.textPrimary} noOfLines=${compact ? 2 : undefined}>
        ${value}
      <//>
    <//>
  `;
}

function Root() {
  return html`
    <${Chakra.ChakraProvider} theme=${horizonTheme}>
      <${TracksApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
