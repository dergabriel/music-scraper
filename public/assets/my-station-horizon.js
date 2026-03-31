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

// ─── Cookie helpers ──────────────────────────────────────────────────────────

const COOKIE_KEY = 'my_station_id';

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  const href = `/dashboard?trackKey=${encodeURIComponent(track.track_key)}`;
  return html`
    <${Chakra.Tr}
      cursor="pointer"
      _hover=${{ bg: ui.hoverBg ?? (ui.cardBg + '99') }}
      onClick=${() => { window.location.href = href; }}
    >
      <${Chakra.Td} py="2" px="3">
        <${Chakra.VStack} align="start" spacing="0">
          <${Chakra.Text} fontWeight="600" fontSize="sm">${track.artist}<//>
          <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>${track.title}<//>
        <//>
      <//>
      <${Chakra.Td} py="2" px="3" isNumeric>
        <${Chakra.Badge} colorScheme=${badgeScheme} borderRadius="999px" px="2">${badge}<//>
      <//>
      <${Chakra.Td} py="2" px="2" w="8">
        <${Chakra.Icon} as=${Icons.ChevronRightIcon} color=${ui.textSecondary} boxSize="4" />
      <//>
    <//>
  `;
}

// ─── Sender-Auswahl Setup ────────────────────────────────────────────────────

function StationSetup({ stations, onSelect }) {
  const ui = useUiColors();
  const [selected, setSelected] = React.useState('');

  return html`
    <${Chakra.VStack} align="stretch" spacing="6" maxW="480px" mx="auto" py="8">
      <${Chakra.VStack} align="start" spacing="1">
        <${Chakra.Heading} size="md">Welcher ist dein Sender?<//>
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>
          Wähle deinen Sender aus der Liste. Die Auswahl wird im Browser gespeichert.
        <//>
      <//>

      <${Chakra.Select}
        placeholder="Sender wählen…"
        value=${selected}
        onChange=${(e) => setSelected(e.target.value)}
        size="md"
        borderRadius="10px"
      >
        ${stations.map((s) => html`
          <option key=${s.id} value=${s.id}>${s.name}</option>
        `)}
      <//>

      <${Chakra.Button}
        colorScheme="blue"
        isDisabled=${!selected}
        onClick=${() => {
          setCookie(COOKIE_KEY, selected);
          onSelect(selected);
        }}
        borderRadius="10px"
      >
        Sender festlegen
      <//>
    <//>
  `;
}

// ─── Missed Tab ──────────────────────────────────────────────────────────────

function MissedTab({ days, stationId }) {
  const ui = useUiColors();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [minOtherStations, setMinOtherStations] = React.useState(2);

  React.useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/my-station/missed?days=${days}&minOtherStations=${minOtherStations}&minOtherPlays=3&limit=100&stationId=${encodeURIComponent(stationId)}`)
      .then((data) => setRows(data.tracks ?? []))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [days, minOtherStations, stationId]);

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
        <${Chakra.Text} fontSize="sm" color=${ui.textSecondary}>gespielt, bei deinem Sender nicht.<//>
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
          title="Verpasste Tracks"
          subtitle=${`${rows.length} Tracks laufen bei anderen, aber nicht bei deinem Sender`}
          right=${html`<${Chakra.Badge} colorScheme="orange" borderRadius="999px" px="3" py="1">${rows.length} Tracks<//>`}
        >
          ${rows.length === 0 ? html`
            <${Chakra.Text} color=${ui.textSecondary} fontSize="sm">
              Keine Tracks gefunden – entweder sind die Daten noch frisch oder dein Sender spielt alles mit!
            <//>
          ` : html`
            <${Chakra.TableContainer}>
              <${Chakra.Table} size="sm" variant="simple">
                <${Chakra.Thead}>
                  <${Chakra.Tr}>
                    <${Chakra.Th}>Artist / Titel<//>
                    <${Chakra.Th} isNumeric>Plays bei anderen<//>
                    <${Chakra.Th} w="8" />
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

function ExclusivesTab({ days, stationId }) {
  const ui = useUiColors();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [maxOtherStations, setMaxOtherStations] = React.useState(0);

  React.useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/my-station/exclusives?days=${days}&maxOtherStations=${maxOtherStations}&limit=100&stationId=${encodeURIComponent(stationId)}`)
      .then((data) => setRows(data.tracks ?? []))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [days, maxOtherStations, stationId]);

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
          >${n === 0 ? 'nur mein Sender' : `≤ ${n} Sender`}<//>
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
          title="Geheimtipps"
          subtitle=${`${rows.length} Tracks die dein Sender spielt, aber kaum jemand sonst`}
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
                    <${Chakra.Th} isNumeric>Plays<//>
                    <${Chakra.Th} w="8" />
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
  const [tab, setTab] = React.useState(0);
  const [stations, setStations] = React.useState([]);
  const [stationId, setStationId] = React.useState(() => getCookie(COOKIE_KEY) ?? '');
  const [overview, setOverview] = React.useState(null);
  const [overviewLoading, setOverviewLoading] = React.useState(false);

  React.useEffect(() => {
    apiFetch('/api/stations').then((data) => setStations(Array.isArray(data) ? data : []));
  }, []);

  React.useEffect(() => {
    if (!stationId) return;
    setOverviewLoading(true);
    apiFetch(`/api/my-station/overview?days=${days}&stationId=${encodeURIComponent(stationId)}`)
      .then((data) => setOverview(data))
      .catch(() => setOverview(null))
      .finally(() => setOverviewLoading(false));
  }, [days, stationId]);

  const stationName = stationId
    ? (stations.find((s) => s.id === stationId)?.name ?? stationId)
    : 'Mein Sender';

  // Kein Sender gewählt → Setup-Screen
  if (!stationId) {
    return html`
      <${AppShell} activeKey="my-station" title="Mein Sender" subtitle="Sender einrichten">
        <${StationSetup} stations=${stations} onSelect=${setStationId} />
      <//>
    `;
  }

  return html`
    <${AppShell}
      activeKey="my-station"
      title=${stationName}
      subtitle="Vergleich mit anderen Sendern: was verpasst dein Sender, was ist exklusiv?"
      controls=${html`
        <${Chakra.HStack} spacing="3">
          <${DaySelector} value=${days} onChange=${setDays} />
          <${Chakra.Button}
            size="sm"
            variant="ghost"
            leftIcon=${React.createElement(Icons.SettingsIcon)}
            onClick=${() => {
              setCookie(COOKIE_KEY, '');
              setStationId('');
              setOverview(null);
            }}
            title="Sender wechseln"
          >Ändern<//>
        <//>
      `}
    >
      <${Chakra.VStack} align="stretch" spacing="5">

        <${Chakra.Flex} gap="4" flexWrap="wrap">
          <${StatCard}
            label="Plays gesamt"
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
            label="Nur dein Sender"
            value=${overviewLoading ? '…' : (overview?.exclusives_count ?? 0)}
            colorScheme="green"
          />
        <//>

        <${PanelCard}
          title="So liest du diese Seite"
          subtitle="Zeitraum oben rechts wählbar: 7 oder 14 Tage · Auf einen Track klicken öffnet die Detailseite"
        >
          <${Chakra.SimpleGrid} columns=${[1, 2]} spacing="4">
            <${Chakra.HStack} align="start" spacing="3">
              <${Chakra.Box} w="10px" h="10px" borderRadius="999px" bg="orange.400" mt="1" flexShrink="0" />
              <${Chakra.Box}>
                <${Chakra.Text} fontWeight="600" fontSize="sm">Verpasste Tracks<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>
                  Tracks, die andere Sender oft gespielt haben, dein Sender aber nicht.
                  Gute Kandidaten für neue Musik im Programm.
                <//>
              <//>
            <//>
            <${Chakra.HStack} align="start" spacing="3">
              <${Chakra.Box} w="10px" h="10px" borderRadius="999px" bg="green.400" mt="1" flexShrink="0" />
              <${Chakra.Box}>
                <${Chakra.Text} fontWeight="600" fontSize="sm">Geheimtipps<//>
                <${Chakra.Text} fontSize="xs" color=${ui.textSecondary}>
                  Tracks die dein Sender spielt, aber kaum andere Sender kennen.
                  Das sind deine Alleinstellungsmerkmale.
                <//>
              <//>
            <//>
          <//>
        <//>

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
              <${MissedTab} days=${days} stationId=${stationId} />
            <//>
            <${Chakra.TabPanel} px="0">
              <${ExclusivesTab} days=${days} stationId=${stationId} />
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
