import {
  React,
  createRoot,
  Chakra,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  AppShell,
  PanelCard,
  useUiColors,
  Icons
} from './horizon-lib.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function DaySelector({ value, onChange }) {
  return html`
    <${Chakra.HStack} spacing="2">
      ${[7, 14].map((d) => html`
        <${Chakra.Button}
          key=${d}
          size="sm"
          variant=${value === d ? 'solid' : 'outline'}
          colorScheme=${value === d ? 'blue' : 'gray'}
          borderRadius="999px"
          onClick=${() => onChange(d)}
        >${d} Tage<//>
      `)}
    <//>
  `;
}

function StatCard({ label, value, colorScheme = 'blue' }) {
  const ui = useUiColors();
  return html`
    <${Chakra.Box}
      bg=${ui.cardBg}
      border="1px solid"
      borderColor=${ui.lineColor}
      borderRadius="16px"
      p="5"
      flex="1"
      minW="140px"
    >
      <${Chakra.Text} fontSize="xs" color=${ui.textSecondary} mb="1">${label}<//>
      <${Chakra.Text} fontSize="2xl" fontWeight="700" color="${colorScheme}.500">${formatNumber(value)}<//>
    <//>
  `;
}

function TrackRow({ track, badge, badgeScheme = 'blue' }) {
  const ui = useUiColors();
  return html`
    <${Chakra.Tr}>
      <${Chakra.Td} py="2" px="3">
        <${Chakra.VStack} align="start" spacing="0">
          <${Chakra.Text} fontWeight="600" fontSize="sm">${track.artist}<//>
          <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>${track.title}<//>
        <//>
      <//>
      <${Chakra.Td} py="2" px="3" isNumeric>
        <${Chakra.Badge} colorScheme=${badgeScheme} borderRadius="999px" px="2">${badge}<//>
      <//>
    <//>
  `;
}

// ─── Missed Tab ─────────────────────────────────────────────────────────────

function MissedTab({ days }) {
  const ui = useUiColors();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [minOtherStations, setMinOtherStations] = React.useState(2);

  React.useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/my-station/missed?days=${days}&minOtherStations=${minOtherStations}&minOtherPlays=3&limit=100`)
      .then((data) => setRows(data.tracks ?? []))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [days, minOtherStations]);

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.HStack} spacing="3" flexWrap="wrap">
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>Mindestens bei<//>
        ${[2, 3, 5].map((n) => html`
          <${Chakra.Button}
            key=${n}
            size="xs"
            variant=${minOtherStations === n ? 'solid' : 'outline'}
            colorScheme=${minOtherStations === n ? 'orange' : 'gray'}
            borderRadius="999px"
            onClick=${() => setMinOtherStations(n)}
          >${n} Sendern<//>
        `)}
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>gespielt, bei JUKA nicht.<//>
      <//>

      ${error ? html`
        <${Chakra.Alert} status="error" borderRadius="12px">
          <${Chakra.AlertIcon} />${error}
        <//>
      ` : null}

      ${loading ? html`
        <${Chakra.Flex} justify="center" py="8">
          <${Chakra.Spinner} size="lg" color="orange.400" />
        <//>
      ` : html`
        <${PanelCard}
          title="Tracks die JUKA verpasst hat"
          subtitle=${`${rows.length} Tracks laufen bei anderen Sendern, aber nicht bei JUKA`}
          right=${html`<${Chakra.Badge} colorScheme="orange" borderRadius="999px" px="3" py="1">${rows.length} Tracks<//>`}
        >
          ${rows.length === 0 ? html`
            <${Chakra.Text} color=${ui.textSecondary} fontSize="sm">
              Keine Tracks gefunden – entweder sind die Daten noch frisch oder JUKA spielt alles mit!
            <//>
          ` : html`
            <${Chakra.TableContainer}>
              <${Chakra.Table} size="sm" variant="simple">
                <${Chakra.Thead}>
                  <${Chakra.Tr}>
                    <${Chakra.Th}>Artist / Titel<//>
                    <${Chakra.Th} isNumeric>Plays bei anderen<//>
                  <//>
                <//>
                <${Chakra.Tbody}>
                  ${rows.map((t) => html`
                    <${TrackRow}
                      key=${t.track_key}
                      track=${t}
                      badge=${`${t.other_plays}× / ${t.other_stations} Sender`}
                      badgeScheme="orange"
                    />
                  `)}
                <//>
              <//>
            <//>
          `}
        <//>
      `}
    <//>
  `;
}

// ─── Exclusives Tab ──────────────────────────────────────────────────────────

function ExclusivesTab({ days }) {
  const ui = useUiColors();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [maxOtherStations, setMaxOtherStations] = React.useState(0);

  React.useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/my-station/exclusives?days=${days}&maxOtherStations=${maxOtherStations}&limit=100`)
      .then((data) => setRows(data.tracks ?? []))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [days, maxOtherStations]);

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.HStack} spacing="3" flexWrap="wrap">
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>Max. bei anderen Sendern:<//>
        ${[0, 1, 2].map((n) => html`
          <${Chakra.Button}
            key=${n}
            size="xs"
            variant=${maxOtherStations === n ? 'solid' : 'outline'}
            colorScheme=${maxOtherStations === n ? 'green' : 'gray'}
            borderRadius="999px"
            onClick=${() => setMaxOtherStations(n)}
          >${n === 0 ? 'nur JUKA' : `≤ ${n} Sender`}<//>
        `)}
      <//>

      ${error ? html`
        <${Chakra.Alert} status="error" borderRadius="12px">
          <${Chakra.AlertIcon} />${error}
        <//>
      ` : null}

      ${loading ? html`
        <${Chakra.Flex} justify="center" py="8">
          <${Chakra.Spinner} size="lg" color="green.400" />
        <//>
      ` : html`
        <${PanelCard}
          title="JUKAs Geheimtipps"
          subtitle=${`${rows.length} Tracks die JUKA spielt, aber kaum jemand sonst`}
          right=${html`<${Chakra.Badge} colorScheme="green" borderRadius="999px" px="3" py="1">${rows.length} Tracks<//>`}
        >
          ${rows.length === 0 ? html`
            <${Chakra.Text} color=${ui.textSecondary} fontSize="sm">
              Keine exklusiven Tracks im gewählten Zeitraum.
            <//>
          ` : html`
            <${Chakra.TableContainer}>
              <${Chakra.Table} size="sm" variant="simple">
                <${Chakra.Thead}>
                  <${Chakra.Tr}>
                    <${Chakra.Th}>Artist / Titel<//>
                    <${Chakra.Th} isNumeric>JUKA Plays<//>
                  <//>
                <//>
                <${Chakra.Tbody}>
                  ${rows.map((t) => html`
                    <${TrackRow}
                      key=${t.track_key}
                      track=${t}
                      badge=${`${t.my_plays}×`}
                      badgeScheme="green"
                    />
                  `)}
                <//>
              <//>
            <//>
          `}
        <//>
      `}
    <//>
  `;
}

// ─── Main App ────────────────────────────────────────────────────────────────

function MyStationApp() {
  const ui = useUiColors();
  const [days, setDays] = React.useState(7);
  const [overview, setOverview] = React.useState(null);
  const [overviewLoading, setOverviewLoading] = React.useState(false);
  const [tab, setTab] = React.useState(0);

  React.useEffect(() => {
    setOverviewLoading(true);
    apiFetch(`/api/my-station/overview?days=${days}`)
      .then((data) => setOverview(data))
      .catch(() => setOverview(null))
      .finally(() => setOverviewLoading(false));
  }, [days]);

  const stationName = overview?.my_station_name ?? 'Mein Sender';

  return html`
    <${AppShell}
      activeKey="my-station"
      title=${stationName}
      subtitle="Vergleich mit anderen Sendern: was verpasst JUKA, was ist exklusiv?"
      controls=${html`
        <${DaySelector} value=${days} onChange=${setDays} />
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">

        ${/* Stat-Karten */null}
        <${Chakra.Flex} gap="4" flexWrap="wrap">
          <${StatCard}
            label="JUKA Plays"
            value=${overviewLoading ? '…' : (overview?.my_plays ?? 0)}
            colorScheme="blue"
          />
          <${StatCard}
            label="Einzigartige Tracks"
            value=${overviewLoading ? '…' : (overview?.my_unique_tracks ?? 0)}
            colorScheme="purple"
          />
          <${StatCard}
            label="Verpasste Tracks"
            value=${overviewLoading ? '…' : (overview?.missed_count ?? 0)}
            colorScheme="orange"
          />
          <${StatCard}
            label="Nur bei JUKA"
            value=${overviewLoading ? '…' : (overview?.exclusives_count ?? 0)}
            colorScheme="green"
          />
        <//>

        ${/* Erklärungsbox */null}
        <${PanelCard}
          title="So liest du diese Seite"
          subtitle="Zeitraum oben rechts wählbar: 7 oder 14 Tage"
        >
          <${Chakra.SimpleGrid} columns=${[1, 2]} spacing="4">
            <${Chakra.HStack} align="start" spacing="3">
              <${Chakra.Box} w="10px" h="10px" borderRadius="999px" bg="orange.400" mt="1" flexShrink="0" />
              <${Chakra.Box}>
                <${Chakra.Text} fontWeight="600" fontSize="sm">Verpasste Tracks<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>
                  Tracks, die andere Sender oft gespielt haben, JUKA aber nicht.
                  Gute Kandidaten für neue Musik im Programm.
                <//>
              <//>
            <//>
            <${Chakra.HStack} align="start" spacing="3">
              <${Chakra.Box} w="10px" h="10px" borderRadius="999px" bg="green.400" mt="1" flexShrink="0" />
              <${Chakra.Box}>
                <${Chakra.Text} fontWeight="600" fontSize="sm">Geheimtipps<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>
                  Tracks die JUKA spielt, aber kaum andere Sender kennen.
                  Das sind JUKAs Alleinstellungsmerkmale.
                <//>
              <//>
            <//>
          <//>
        <//>

        ${/* Tabs */null}
        <${Chakra.Tabs}
          index=${tab}
          onChange=${setTab}
          colorScheme="blue"
          variant="line"
          isLazy
        >
          <${Chakra.TabList} borderColor=${ui.lineColor}>
            <${Chakra.Tab} fontWeight="600">
              <${Chakra.HStack} spacing="2">
                <${Chakra.Box} w="8px" h="8px" borderRadius="999px" bg="orange.400" />
                <${Chakra.Text}>Verpasste Tracks<//>
              <//>
            <//>
            <${Chakra.Tab} fontWeight="600">
              <${Chakra.HStack} spacing="2">
                <${Chakra.Box} w="8px" h="8px" borderRadius="999px" bg="green.400" />
                <${Chakra.Text}>Geheimtipps<//>
              <//>
            <//>
          <//>
          <${Chakra.TabPanels}>
            <${Chakra.TabPanel} px="0">
              <${MissedTab} days=${days} />
            <//>
            <${Chakra.TabPanel} px="0">
              <${ExclusivesTab} days=${days} />
            <//>
          <//>
        <//>
      <//>
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(html`
  <${Chakra.ChakraProvider} theme=${horizonTheme}>
    <${MyStationApp} />
  <//>
`);
