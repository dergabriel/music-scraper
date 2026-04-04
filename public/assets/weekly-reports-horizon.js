import {
  React,
  createRoot,
  Chakra,
  Icons,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  AppShell,
  PanelCard,
  useUiColors
} from './horizon-lib.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function getMondayOfWeek(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function shiftWeek(weekStart, delta) {
  const d = new Date(`${weekStart}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta * 7);
  return d.toISOString().slice(0, 10);
}

function currentWeekStart() {
  return getMondayOfWeek(new Date().toISOString().slice(0, 10));
}

function formatWeekLabel(weekStart, weekEnd) {
  if (!weekStart || !weekEnd) return weekStart ?? '';
  const fmt = (iso) => {
    const d = new Date(`${iso}T12:00:00Z`);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };
  // weekEnd from the API is exclusive (Monday of next week), display as Sunday
  const endDisplay = new Date(`${weekEnd}T12:00:00Z`);
  endDisplay.setUTCDate(endDisplay.getUTCDate() - 1);
  const endIso = endDisplay.toISOString().slice(0, 10);
  return `${fmt(weekStart)} – ${fmt(endIso)}`;
}

function deltaBadge(delta, ui) {
  if (delta == null || delta === 0) return null;
  const positive = delta > 0;
  const color = positive ? 'green' : 'red';
  const prefix = positive ? '+' : '';
  return html`
    <${Chakra.Badge}
      colorScheme=${color}
      borderRadius="999px"
      px="2"
      fontSize="xs"
      ml="1"
    >${prefix}${formatNumber(delta)}<//>
  `;
}

function pct(current, previous) {
  if (!previous || previous === 0) return current > 0 ? null : null;
  return Math.round(((current - previous) / previous) * 100);
}

// ── sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }) {
  const ui = useUiColors();
  return html`
    <${PanelCard} p="4">
      <${Chakra.Text} fontSize="xs" color=${ui.textMuted} mb="1">${label}<//>
      <${Chakra.Text} fontSize="2xl" fontWeight="800" color=${ui.textPrimary}>${value}<//>
      ${sub ? html`<${Chakra.Text} fontSize="xs" color=${ui.textMuted} mt="1">${sub}<//>` : null}
    <//>
  `;
}

function TopTracksTable({ tracks }) {
  const ui = useUiColors();
  if (!tracks || tracks.length === 0) {
    return html`<${Chakra.Text} color=${ui.textMuted} fontSize="sm">Keine Daten vorhanden.<//>`;
  }
  return html`
    <${Chakra.Box} overflowX="auto">
      <${Chakra.Table} size="sm" variant="simple">
        <${Chakra.Thead}>
          <${Chakra.Tr}>
            <${Chakra.Th} w="8">#<//>
            <${Chakra.Th}>Interpret<//>
            <${Chakra.Th}>Titel<//>
            <${Chakra.Th} isNumeric>Plays<//>
            <${Chakra.Th} isNumeric>Δ Vorwoche<//>
            <${Chakra.Th} isNumeric>Sender<//>
          <//>
        <//>
        <${Chakra.Tbody}>
          ${tracks.map((row, index) => html`
            <${Chakra.Tr}
              key=${row.track_key}
              cursor="pointer"
              _hover=${{ bg: ui.subtleBg }}
              onClick=${() => { window.location.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`; }}
            >
              <${Chakra.Td} color=${ui.textMuted} fontSize="xs">${index + 1}<//>
              <${Chakra.Td} fontWeight="600">${row.artist}<//>
              <${Chakra.Td} color=${ui.textMuted}>${row.title}<//>
              <${Chakra.Td} isNumeric fontWeight="700">${formatNumber(row.plays)}<//>
              <${Chakra.Td} isNumeric>
                ${row.delta != null ? deltaBadge(row.delta, ui) : '-'}
              <//>
              <${Chakra.Td} isNumeric color=${ui.textMuted}>${formatNumber(row.station_count)}<//>
            <//>
          `)}
        <//>
      <//>
    <//>
  `;
}

function StationTotalsTable({ stationTotals, stations }) {
  const ui = useUiColors();
  const nameById = React.useMemo(() => {
    const m = new Map();
    (stations || []).forEach((s) => m.set(s.id, s.name || s.id));
    return m;
  }, [stations]);

  if (!stationTotals || stationTotals.length === 0) {
    return html`<${Chakra.Text} color=${ui.textMuted} fontSize="sm">Keine Senderdaten vorhanden.<//>`;
  }

  return html`
    <${Chakra.Box} overflowX="auto">
      <${Chakra.Table} size="sm" variant="simple">
        <${Chakra.Thead}>
          <${Chakra.Tr}>
            <${Chakra.Th}>Sender<//>
            <${Chakra.Th} isNumeric>Plays diese Woche<//>
            <${Chakra.Th} isNumeric>Δ Vorwoche<//>
            <${Chakra.Th} isNumeric>Unique Titel<//>
          <//>
        <//>
        <${Chakra.Tbody}>
          ${stationTotals.map((row) => {
            const delta = Number(row.plays) - Number(row.prev_plays ?? 0);
            return html`
              <${Chakra.Tr} key=${row.station_id}>
                <${Chakra.Td} fontWeight="600">${nameById.get(row.station_id) ?? row.station_id}<//>
                <${Chakra.Td} isNumeric fontWeight="700">${formatNumber(row.plays)}<//>
                <${Chakra.Td} isNumeric>${deltaBadge(delta, ui) ?? '-'}<//>
                <${Chakra.Td} isNumeric color=${ui.textMuted}>${formatNumber(row.unique_tracks)}<//>
              <//>
            `;
          })}
        <//>
      <//>
    <//>
  `;
}

function StationReportPanel({ stationId, weekStart, stations }) {
  const ui = useUiColors();
  const [report, setReport] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!stationId || !weekStart) return;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ weekStart });
    apiFetch(`/api/reports/station/${encodeURIComponent(stationId)}?${params}`)
      .then((data) => setReport(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [stationId, weekStart]);

  if (!stationId) {
    return html`<${Chakra.Text} color=${ui.textMuted} fontSize="sm">Bitte einen Sender auswählen.<//>`;
  }
  if (loading) {
    return html`<${Chakra.Spinner} size="sm" />`;
  }
  if (error) {
    return html`
      <${Chakra.Alert} status="error" borderRadius="12px">
        <${Chakra.AlertIcon} />
        ${error}
      <//>
    `;
  }
  if (!report) return null;

  const r = report.report;
  const stationName = stations.find((s) => s.id === stationId)?.name ?? stationId;

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="3">
        <${KpiCard} label="Sender" value=${stationName} />
        <${KpiCard} label="Plays diese Woche" value=${formatNumber(r.totalPlays)} />
        <${KpiCard} label="Unique Titel" value=${formatNumber(r.uniqueTracks)} />
        <${KpiCard} label="Neue Titel" value=${formatNumber(r.newTracks?.length ?? 0)} sub="nicht in Vorwoche gespielt" />
      <//>

      <${Chakra.SimpleGrid} columns=${{ base: 1, lg: 2 }} spacing="4">
        <${PanelCard} title="Top-Titel diese Woche" subtitle="Nach Plays sortiert">
          <${Chakra.VStack} align="stretch" spacing="1" maxH="400px" overflowY="auto" className="horizon-scroll">
            ${(r.topTracks || []).map((row, index) => html`
              <${Chakra.HStack}
                key=${row.track_key}
                justify="space-between" py="1" borderBottom="1px solid" borderColor=${ui.lineColor} align="flex-start"
                cursor="pointer" _hover=${{ bg: ui.subtleBg }}
                onClick=${() => { window.location.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`; }}
              >
                <${Chakra.HStack} spacing="2" flex="1" minW="0" align="flex-start">
                  <${Chakra.Text} fontSize="xs" color=${ui.textMuted} flexShrink="0" w="5" textAlign="right" pt="0.5">${index + 1}<//>
                  <${Chakra.Box} flex="1" minW="0">
                    <${Chakra.Text} fontSize="sm" fontWeight="600">${row.artist}<//>
                    <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
                  <//>
                <//>
                <${Chakra.Text} fontSize="sm" fontWeight="700" flexShrink="0" ml="2">${formatNumber(row.count)}<//>
              <//>
            `)}
          <//>
        <//>

        <${Chakra.VStack} align="stretch" spacing="4">
          <${PanelCard} title="Neue Titel" subtitle="Diese Woche erstmals gespielt">
            ${(r.newTracks || []).length === 0
              ? html`<${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Keine neuen Titel diese Woche.<//>`
              : html`
                <${Chakra.VStack} align="stretch" spacing="1" maxH="170px" overflowY="auto" className="horizon-scroll">
                  ${(r.newTracks || []).map((row) => html`
                    <${Chakra.HStack}
                      key=${row.track_key}
                      justify="space-between" py="1" borderBottom="1px solid" borderColor=${ui.lineColor} align="flex-start"
                      cursor="pointer" _hover=${{ bg: ui.subtleBg }}
                      onClick=${() => { window.location.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`; }}
                    >
                      <${Chakra.Box} flex="1" minW="0">
                        <${Chakra.Text} fontSize="sm" fontWeight="600">${row.artist}<//>
                        <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
                      <//>
                      <${Chakra.Badge} colorScheme="green" borderRadius="999px" flexShrink="0" ml="2">${formatNumber(row.count)}<//>
                    <//>
                  `)}
                <//>
              `}
          <//>

          <${PanelCard} title="Größte Gewinner" subtitle="Meiste Play-Zuwächse vs. Vorwoche">
            ${(r.movers?.topGainers || []).length === 0
              ? html`<${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Keine Daten.<//>`
              : html`
                <${Chakra.VStack} align="stretch" spacing="1" maxH="170px" overflowY="auto" className="horizon-scroll">
                  ${(r.movers?.topGainers || []).map((row) => html`
                    <${Chakra.HStack}
                      key=${row.track_key}
                      justify="space-between" py="1" borderBottom="1px solid" borderColor=${ui.lineColor} align="flex-start"
                      cursor="pointer" _hover=${{ bg: ui.subtleBg }}
                      onClick=${() => { window.location.href = `/dashboard?trackKey=${encodeURIComponent(row.track_key)}`; }}
                    >
                      <${Chakra.Box} flex="1" minW="0">
                        <${Chakra.Text} fontSize="sm" fontWeight="600">${row.artist}<//>
                        <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
                      <//>
                      <${Chakra.Badge} colorScheme="green" borderRadius="999px" flexShrink="0" ml="2">+${formatNumber(row.delta)}<//>
                    <//>
                  `)}
                <//>
              `}
          <//>
        <//>
      <//>
    <//>
  `;
}

// ── main app ──────────────────────────────────────────────────────────────────

function WeeklyReportsApp() {
  const ui = useUiColors();

  const [weekStart, setWeekStart] = React.useState(currentWeekStart);
  const [overview, setOverview] = React.useState(null);
  const [stations, setStations] = React.useState([]);
  const [selectedStationId, setSelectedStationId] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  const loadOverview = React.useCallback(async (ws) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ weekStart: ws, limit: '50' });
      const data = await apiFetch(`/api/reports/weekly-overview?${params}`);
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    apiFetch('/api/stations')
      .then((rows) => setStations(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    loadOverview(weekStart);
  }, [weekStart, loadOverview]);

  const prevWeekDelta = overview
    ? pct(overview.totalPlays, overview.prevTotalPlays)
    : null;

  const weekLabel = overview
    ? formatWeekLabel(overview.weekStart, overview.weekEnd)
    : formatWeekLabel(weekStart, shiftWeek(weekStart, 1));

  return html`
    <${AppShell}
      activeKey="weekly-reports"
      title="Wochenberichte"
      subtitle=${weekLabel}
      controls=${html`
        <${Chakra.HStack} spacing="2">
          <${Chakra.IconButton}
            icon=${React.createElement(Icons.ChevronLeftIcon)}
            size="sm"
            variant="outline"
            aria-label="Vorherige Woche"
            onClick=${() => setWeekStart((ws) => shiftWeek(ws, -1))}
          />
          <${Chakra.Input}
            type="date"
            size="sm"
            value=${weekStart}
            onChange=${(e) => setWeekStart(getMondayOfWeek(e.target.value))}
            w="140px"
          />
          <${Chakra.IconButton}
            icon=${React.createElement(Icons.ChevronRightIcon)}
            size="sm"
            variant="outline"
            aria-label="Nächste Woche"
            onClick=${() => setWeekStart((ws) => shiftWeek(ws, 1))}
          />
          <${Chakra.Button}
            size="sm"
            variant="outline"
            onClick=${() => setWeekStart(currentWeekStart())}
          >Aktuelle Woche<//>
          <${Chakra.Button}
            size="sm"
            leftIcon=${React.createElement(Icons.RepeatIcon)}
            colorScheme="blue"
            isLoading=${loading}
            onClick=${() => loadOverview(weekStart)}
          >Neu laden<//>
        <//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">
        ${error ? html`
          <${Chakra.Alert} status="error" borderRadius="14px">
            <${Chakra.AlertIcon} />
            ${error}
          <//>
        ` : null}

        <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="3">
          <${KpiCard}
            label="Plays diese Woche"
            value=${loading ? '…' : formatNumber(overview?.totalPlays)}
            sub=${prevWeekDelta != null ? `${prevWeekDelta > 0 ? '+' : ''}${prevWeekDelta}% vs. Vorwoche` : null}
          />
          <${KpiCard}
            label="Aktive Sender"
            value=${loading ? '…' : formatNumber(overview?.stationCount)}
          />
          <${KpiCard}
            label="Plays Vorwoche"
            value=${loading ? '…' : formatNumber(overview?.prevTotalPlays)}
          />
          <${KpiCard}
            label="Top-Song Plays"
            value=${loading ? '…' : formatNumber(overview?.topTracks?.[0]?.plays)}
            sub=${overview?.topTracks?.[0] ? `${overview.topTracks[0].artist} – ${overview.topTracks[0].title}` : null}
          />
        <//>

        <${Chakra.Tabs} variant="soft-rounded" colorScheme="blue">
          <${Chakra.TabList} mb="4">
            <${Chakra.Tab}>Gesamtübersicht<//>
            <${Chakra.Tab}>Einzelsender<//>
          <//>
          <${Chakra.TabPanels}>

            <${Chakra.TabPanel} px="0" pb="0">
              <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 2 }} spacing="4">
                <${PanelCard} title="Top 50 Titel" subtitle="Meistgespielt diese Woche, alle Sender zusammen">
                  ${loading
                    ? html`<${Chakra.Spinner} size="sm" />`
                    : html`<${TopTracksTable} tracks=${overview?.topTracks} />`}
                <//>

                <${PanelCard} title="Plays je Sender" subtitle="Vergleich mit Vorwoche">
                  ${loading
                    ? html`<${Chakra.Spinner} size="sm" />`
                    : html`<${StationTotalsTable} stationTotals=${overview?.stationTotals} stations=${stations} />`}
                <//>
              <//>
            <//>

            <${Chakra.TabPanel} px="0" pb="0">
              <${Chakra.VStack} align="stretch" spacing="4">
                <${PanelCard} title="Sender auswählen">
                  <${Chakra.Select}
                    placeholder="Sender wählen…"
                    value=${selectedStationId}
                    onChange=${(e) => setSelectedStationId(e.target.value)}
                    maxW="400px"
                  >
                    ${stations.map((s) => html`
                      <option key=${s.id} value=${s.id}>${s.name || s.id}</option>
                    `)}
                  <//>
                <//>

                <${StationReportPanel}
                  stationId=${selectedStationId}
                  weekStart=${weekStart}
                  stations=${stations}
                />
              <//>
            <//>

          <//>
        <//>
      <//>
    <//>
  `;
}

function Root() {
  return html`
    <${Chakra.ChakraProvider} theme=${horizonTheme}>
      <${WeeklyReportsApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
