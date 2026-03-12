import {
  React,
  createRoot,
  Chakra,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  useDebouncedValue,
  AppShell,
  PanelCard,
  useUiColors,
  Icons
} from './horizon-lib.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtPlaysPerDay(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n.toFixed(2).replace('.', ',');
}

function ageDays(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function ageDaysText(days) {
  if (days === null || !Number.isFinite(days)) return '-';
  if (days < 30) return `${days} T`;
  if (days < 365) return `${Math.round(days / 30)} M`;
  return `${(days / 365).toFixed(1).replace('.', ',')} J`;
}

function matchSearch(row, q) {
  if (!q) return true;
  const lq = q.toLowerCase();
  return (
    String(row.artist || '').toLowerCase().includes(lq) ||
    String(row.title || '').toLowerCase().includes(lq)
  );
}

// ── TrackRow ──────────────────────────────────────────────────────────────────

function TrackRow({ row, index, ui }) {
  const age = ageDays(row.first_played_at_utc);
  const lastAge = ageDays(row.last_played_at_utc);
  return html`
    <${Chakra.Tr} _hover=${{ bg: ui.subtleBg }}>
      <${Chakra.Td} color=${ui.textMuted} fontSize="xs" w="8" textAlign="right">${index + 1}<//>
      <${Chakra.Td}>
        <${Chakra.Text} fontWeight="600" fontSize="sm">${row.artist}<//>
        <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
      <//>
      <${Chakra.Td} isNumeric fontWeight="700">${formatNumber(row.plays)}<//>
      <${Chakra.Td} isNumeric color=${ui.textMuted}>${fmtPlaysPerDay(row.plays_per_day)}/T<//>
      <${Chakra.Td} isNumeric color=${ui.textMuted}>${formatNumber(row.active_days)}<//>
      <${Chakra.Td} isNumeric>
        <${Chakra.Text} fontSize="sm">${ageDaysText(age)}<//>
        <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${fmtDate(row.first_played_at_utc)}<//>
      <//>
      <${Chakra.Td} isNumeric>
        <${Chakra.Text} fontSize="sm" color=${lastAge !== null && lastAge <= 14 ? 'green.400' : ui.textMuted}>${ageDaysText(lastAge)}<//>
      <//>
    <//>
  `;
}

// ── StationPanel ──────────────────────────────────────────────────────────────

function StationPanel({ station, stationName, search, ui }) {
  const visible = React.useMemo(
    () => station.tracks.filter((r) => matchSearch(r, search)),
    [station.tracks, search]
  );

  return html`
    <${Chakra.AccordionItem} border="none" mb="2">
      <${Chakra.AccordionButton}
        bg=${ui.cardBg}
        borderRadius="12px"
        px="4" py="3"
        _hover=${{ bg: ui.subtleBg }}
        _expanded=${{ borderBottomRadius: '0' }}
      >
        <${Chakra.HStack} flex="1" spacing="3">
          <${Chakra.Text} fontWeight="700" fontSize="sm">${stationName}<//>
          <${Chakra.Badge} colorScheme="purple" borderRadius="999px" px="2">
            ${visible.length}${search ? ` / ${station.trackCount}` : ''} Titel
          <//>
        <//>
        <${Chakra.AccordionIcon} />
      <//>
      <${Chakra.AccordionPanel}
        pb="0" px="0"
        bg=${ui.cardBg}
        borderBottomRadius="12px"
        overflow="hidden"
      >
        ${visible.length === 0
          ? html`<${Chakra.Text} px="4" py="3" fontSize="sm" color=${ui.textMuted}>Keine Treffer.<//>`
          : html`
            <${Chakra.Box} overflowX="auto" maxH="420px" overflowY="auto" className="horizon-scroll">
              <${Chakra.Table} size="sm" variant="simple">
                <${Chakra.Thead} position="sticky" top="0" zIndex="1" bg=${ui.cardBg}>
                  <${Chakra.Tr}>
                    <${Chakra.Th} w="8">#<//>
                    <${Chakra.Th}>Interpret / Titel<//>
                    <${Chakra.Th} isNumeric>Plays<//>
                    <${Chakra.Th} isNumeric>Ø/Tag<//>
                    <${Chakra.Th} isNumeric>Tage aktiv<//>
                    <${Chakra.Th} isNumeric>Im Sender seit<//>
                    <${Chakra.Th} isNumeric>Zuletzt gespielt<//>
                  <//>
                <//>
                <${Chakra.Tbody}>
                  ${visible.map((row, i) => html`
                    <${TrackRow} key=${row.track_key} row=${row} index=${i} ui=${ui} />
                  `)}
                <//>
              <//>
            <//>
          `}
      <//>
    <//>
  `;
}

// ── GlobalTable ────────────────────────────────────────────────────────────────

function GlobalTable({ rows, stationNames, search, ui }) {
  const nameById = React.useMemo(() => {
    const m = new Map();
    (stationNames || []).forEach((s) => m.set(s.id, s.name || s.id));
    return m;
  }, [stationNames]);

  const visible = React.useMemo(
    () => rows.filter((r) => matchSearch(r, search)),
    [rows, search]
  );

  if (!visible.length) {
    return html`<${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Keine Einträge gefunden.<//>`;
  }

  return html`
    <${Chakra.Box} overflowX="auto" maxH="580px" overflowY="auto" className="horizon-scroll">
      <${Chakra.Table} size="sm" variant="simple">
        <${Chakra.Thead} position="sticky" top="0" zIndex="1" bg=${ui.cardBg}>
          <${Chakra.Tr}>
            <${Chakra.Th} w="8">#<//>
            <${Chakra.Th}>Interpret / Titel<//>
            <${Chakra.Th}>Sender<//>
            <${Chakra.Th} isNumeric>Plays<//>
            <${Chakra.Th} isNumeric>Ø/Tag<//>
            <${Chakra.Th} isNumeric>Tage aktiv<//>
            <${Chakra.Th} isNumeric>Im Sender seit<//>
            <${Chakra.Th} isNumeric>Zuletzt gespielt<//>
          <//>
        <//>
        <${Chakra.Tbody}>
          ${visible.map((row, i) => {
            const age = ageDays(row.first_played_at_utc);
            const lastAge = ageDays(row.last_played_at_utc);
            return html`
              <${Chakra.Tr} key=${`${row.station_id}__${row.track_key}`} _hover=${{ bg: ui.subtleBg }}>
                <${Chakra.Td} color=${ui.textMuted} fontSize="xs" textAlign="right">${i + 1}<//>
                <${Chakra.Td}>
                  <${Chakra.Text} fontWeight="600" fontSize="sm">${row.artist}<//>
                  <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${row.title}<//>
                <//>
                <${Chakra.Td} fontSize="xs" color=${ui.textMuted}>${nameById.get(row.station_id) ?? row.station_id}<//>
                <${Chakra.Td} isNumeric fontWeight="700">${formatNumber(row.plays)}<//>
                <${Chakra.Td} isNumeric color=${ui.textMuted}>${fmtPlaysPerDay(row.plays_per_day)}/T<//>
                <${Chakra.Td} isNumeric color=${ui.textMuted}>${formatNumber(row.active_days)}<//>
                <${Chakra.Td} isNumeric>
                  <${Chakra.Text} fontSize="sm">${ageDaysText(age)}<//>
                  <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${fmtDate(row.first_played_at_utc)}<//>
                <//>
                <${Chakra.Td} isNumeric>
                  <${Chakra.Text} fontSize="sm" color=${lastAge !== null && lastAge <= 14 ? 'green.400' : ui.textMuted}>${ageDaysText(lastAge)}<//>
                <//>
              <//>
            `;
          })}
        <//>
      <//>
    <//>
  `;
}

// ── KpiCard ────────────────────────────────────────────────────────────────────

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

// ── main app ───────────────────────────────────────────────────────────────────

function BackpoolApp() {
  const ui = useUiColors();

  const [minAgeDays, setMinAgeDays] = React.useState('180');
  const [recentDays, setRecentDays] = React.useState('60');
  const [minPlays, setMinPlays] = React.useState('2');
  const [stationFilter, setStationFilter] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState('station');

  const [stations, setStations] = React.useState([]);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  const debouncedSearch = useDebouncedValue(search, 200);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams({
        minAgeDays: minAgeDays || '180',
        recentDays: recentDays || '60',
        minPlays: minPlays || '2',
        limit: '2000'
      });
      if (stationFilter) p.set('stationId', stationFilter);
      const result = await apiFetch(`/api/backpool/simple?${p}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [minAgeDays, recentDays, minPlays, stationFilter]);

  React.useEffect(() => {
    apiFetch('/api/stations')
      .then((rows) => setStations(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const kpiTotalTracks = data?.totalTracks ?? 0;
  const kpiStationCount = data?.stations?.length ?? 0;
  const allRows = React.useMemo(
    () => (data?.stations ?? []).flatMap((s) => s.tracks),
    [data]
  );
  const kpiAvgAge = React.useMemo(() => {
    if (!allRows.length) return null;
    const ages = allRows.map((r) => ageDays(r.first_played_at_utc)).filter((v) => v !== null);
    if (!ages.length) return null;
    return Math.round(ages.reduce((a, b) => a + b, 0) / ages.length);
  }, [allRows]);

  const stationNameById = React.useMemo(() => {
    const m = new Map();
    stations.forEach((s) => m.set(s.id, s.name || s.id));
    return m;
  }, [stations]);

  const allRowsSorted = React.useMemo(
    () => [...allRows].sort((a, b) => Number(b.plays) - Number(a.plays)),
    [allRows]
  );

  return html`
    <${AppShell}
      activeKey="backpool"
      title="Backpool"
      subtitle="Ältere Songs, die Sender noch aktiv spielen"
      controls=${html`
        <${Chakra.Button}
          size="sm"
          leftIcon=${React.createElement(Icons.RepeatIcon)}
          colorScheme="blue"
          isLoading=${loading}
          onClick=${load}
        >Neu laden<//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">
        ${error ? html`
          <${Chakra.Alert} status="error" borderRadius="14px">
            <${Chakra.AlertIcon} />
            ${error}
          <//>
        ` : null}

        <${PanelCard} title="Filter">
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2, xl: 5 }} spacing="3">
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Sender<//>
              <${Chakra.Select}
                size="sm"
                value=${stationFilter}
                onChange=${(e) => setStationFilter(e.target.value)}
              >
                <option value="">Alle Sender</option>
                ${stations.map((s) => html`
                  <option key=${s.id} value=${s.id}>${s.name || s.id}</option>
                `)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Mindestalter im Sender (Tage)<//>
              <${Chakra.NumberInput}
                size="sm"
                min="7" max="3650"
                value=${minAgeDays}
                onChange=${(v) => setMinAgeDays(v)}
              >
                <${Chakra.NumberInputField} />
                <${Chakra.NumberInputStepper}>
                  <${Chakra.NumberIncrementStepper} />
                  <${Chakra.NumberDecrementStepper} />
                <//>
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Aktiv in letzten N Tagen<//>
              <${Chakra.NumberInput}
                size="sm"
                min="1" max="365"
                value=${recentDays}
                onChange=${(v) => setRecentDays(v)}
              >
                <${Chakra.NumberInputField} />
                <${Chakra.NumberInputStepper}>
                  <${Chakra.NumberIncrementStepper} />
                  <${Chakra.NumberDecrementStepper} />
                <//>
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Min. Plays<//>
              <${Chakra.NumberInput}
                size="sm"
                min="1" max="500"
                value=${minPlays}
                onChange=${(v) => setMinPlays(v)}
              >
                <${Chakra.NumberInputField} />
                <${Chakra.NumberInputStepper}>
                  <${Chakra.NumberIncrementStepper} />
                  <${Chakra.NumberDecrementStepper} />
                <//>
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel} fontSize="sm">Suche<//>
              <${Chakra.Input}
                size="sm"
                placeholder="Interpret oder Titel…"
                value=${search}
                onChange=${(e) => setSearch(e.target.value)}
              />
            <//>
          <//>
          <${Chakra.HStack} mt="3" spacing="2" flexWrap="wrap">
            <${Chakra.Button} size="xs" variant="outline" onClick=${() => { setMinAgeDays('90'); setRecentDays('30'); }}>3 Monate<//>
            <${Chakra.Button} size="xs" variant="outline" onClick=${() => { setMinAgeDays('180'); setRecentDays('60'); }}>6 Monate<//>
            <${Chakra.Button} size="xs" variant="outline" onClick=${() => { setMinAgeDays('365'); setRecentDays('90'); }}>1 Jahr+<//>
            <${Chakra.Button} size="xs" colorScheme="blue" onClick=${load} isLoading=${loading}>Laden<//>
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="3">
          <${KpiCard} label="Backpool-Titel" value=${loading ? '…' : formatNumber(kpiTotalTracks)} sub="über alle Sender" />
          <${KpiCard} label="Aktive Sender" value=${loading ? '…' : formatNumber(kpiStationCount)} />
          <${KpiCard} label="Ø Alter im Sender" value=${loading ? '…' : kpiAvgAge !== null ? ageDaysText(kpiAvgAge) : '-'} sub="seit Erstausstrahlung" />
          <${KpiCard}
            label="Definition"
            value="Backpool"
            sub=${`≥${minAgeDays}T alt, gespielt in letzten ${recentDays}T`}
          />
        <//>

        <${Chakra.Tabs}
          variant="soft-rounded"
          colorScheme="blue"
          index=${viewMode === 'station' ? 0 : 1}
          onChange=${(i) => setViewMode(i === 0 ? 'station' : 'global')}
        >
          <${Chakra.TabList} mb="4">
            <${Chakra.Tab}>Je Sender<//>
            <${Chakra.Tab}>Gesamtliste<//>
          <//>
          <${Chakra.TabPanels}>

            <${Chakra.TabPanel} px="0" pb="0">
              ${loading
                ? html`<${Chakra.Spinner} size="sm" />`
                : (data?.stations ?? []).length === 0
                  ? html`<${Chakra.Text} color=${ui.textMuted} fontSize="sm">Keine Daten. Bitte Filter anpassen.<//>`
                  : html`
                    <${Chakra.Accordion} allowMultiple defaultIndex=${[0]}>
                      ${(data?.stations ?? []).map((station) => html`
                        <${StationPanel}
                          key=${station.stationId}
                          station=${station}
                          stationName=${stationNameById.get(station.stationId) ?? station.stationId}
                          search=${debouncedSearch}
                          ui=${ui}
                        />
                      `)}
                    <//>
                  `}
            <//>

            <${Chakra.TabPanel} px="0" pb="0">
              <${PanelCard} title="Alle Backpool-Titel" subtitle="Über alle Sender, nach Plays sortiert">
                ${loading
                  ? html`<${Chakra.Spinner} size="sm" />`
                  : html`
                    <${GlobalTable}
                      rows=${allRowsSorted}
                      stationNames=${stations}
                      search=${debouncedSearch}
                      ui=${ui}
                    />
                  `}
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
      <${BackpoolApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
