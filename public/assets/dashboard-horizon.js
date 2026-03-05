import {
  berlinTodayIsoDate,
  berlinYesterdayIsoDate,
  shiftBerlinIsoDate
} from './date-berlin.js';
import {
  React,
  createRoot,
  Chakra,
  Icons,
  html,
  horizonTheme,
  apiFetch,
  formatNumber,
  useDebouncedValue,
  AppShell,
  PanelCard,
  useUiColors
} from './horizon-lib.js';

const EXTRA_CHARTS_ENABLED = new URLSearchParams(window.location.search).get('extraCharts') === '1';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dayLabel(period) {
  if (!period) return '-';
  const date = new Date(`${period}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(period);
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function dayCount(fromIso, toIso) {
  const start = Date.parse(`${fromIso}T12:00:00.000Z`);
  const end = Date.parse(`${toIso}T12:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

function buildDayStationMatrix(seriesByStation) {
  const periods = Array.isArray(seriesByStation?.periods) ? [...seriesByStation.periods].sort() : [];
  const stations = Array.isArray(seriesByStation?.stations) ? [...seriesByStation.stations] : [];
  const topStations = stations
    .sort((a, b) => Number(b.totalPlays || 0) - Number(a.totalPlays || 0))
    .slice(0, 8);

  const byPeriod = new Map(periods.map((period) => [
    period,
    {
      period,
      total: 0,
      activeStations: 0,
      byStation: topStations.map((station) => ({
        stationId: station.stationId,
        stationName: station.stationName,
        plays: 0
      }))
    }
  ]));

  topStations.forEach((station, stationIndex) => {
    (station.series || []).forEach((row) => {
      const bucket = byPeriod.get(row.period);
      if (!bucket) return;
      const plays = Number(row.plays || 0);
      bucket.byStation[stationIndex].plays = plays;
      bucket.total += plays;
      if (plays > 0) bucket.activeStations += 1;
    });
  });

  const allRows = Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
  const rows = allRows.slice(-21);
  const maxValue = rows.reduce((max, row) => {
    row.byStation.forEach((s) => {
      if (s.plays > max) max = s.plays;
    });
    return max;
  }, 0);

  const stationTotals = topStations.map((station) => {
    const total = rows.reduce((sum, row) => {
      const found = row.byStation.find((item) => item.stationId === station.stationId);
      return sum + Number(found?.plays || 0);
    }, 0);
    return {
      stationId: station.stationId,
      stationName: station.stationName,
      total
    };
  }).sort((a, b) => b.total - a.total);

  return {
    rows,
    stations: topStations,
    maxValue: Math.max(1, maxValue),
    stationTotals
  };
}

function computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays }) {
  if (!selectedTrack) {
    return {
      score: 0,
      label: 'Kein Track',
      popularityPct: 0,
      momentumPct: 0,
      spreadPct: 0,
      dailyStrengthPct: 0
    };
  }

  const popularityPct = clamp((Number(selectedTrack.total_plays || 0) / Math.max(1, Number(maxTrackPlays || 1))) * 100, 0, 100);
  const growth = Number(trend?.growth_percent || 0);
  const momentumPct = clamp((growth + 100) / 2, 0, 100);

  const activeStations = matrix.stationTotals.filter((row) => row.total > 0).length;
  const spreadPct = clamp((activeStations / Math.max(1, matrix.stations.length || 1)) * 100, 0, 100);

  const avgPerDay = Number(totals?.totals?.allTime || 0) / Math.max(1, rangeDays);
  const dailyStrengthPct = clamp((avgPerDay / 8) * 100, 0, 100);

  const score = Math.round(
    popularityPct * 0.4 +
    momentumPct * 0.3 +
    spreadPct * 0.2 +
    dailyStrengthPct * 0.1
  );

  let label = 'Schwach';
  if (score >= 75) label = 'Sehr stark';
  else if (score >= 55) label = 'Gut';
  else if (score >= 35) label = 'Mittel';

  return {
    score,
    label,
    popularityPct,
    momentumPct,
    spreadPct,
    dailyStrengthPct
  };
}

function SongPerformanceCard({ selectedTrack, trend, totals, matrix, maxTrackPlays, from, to }) {
  const ui = useUiColors();
  if (!selectedTrack) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Bitte zuerst einen Track auswählen.<//>`;
  }

  const rangeDays = dayCount(from, to);
  const score = computeSongScore({ selectedTrack, trend, totals, matrix, maxTrackPlays, rangeDays });

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.HStack} justify="space-between">
        <${Chakra.HStack} spacing="4" align="end">
          <${Chakra.Text} fontSize="5xl" lineHeight="1" fontWeight="800" color=${ui.textPrimary}>${score.score}<//>
          <${Chakra.Text} fontSize="md" color=${ui.textMuted} pb="2">/ 100<//>
        <//>
        <${Chakra.Badge} colorScheme=${score.score >= 55 ? 'green' : score.score >= 35 ? 'orange' : 'red'} px="3" py="1" borderRadius="999px">
          ${score.label}
        <//>
      <//>

      <${Chakra.Progress} value=${score.score} colorScheme="blue" borderRadius="999px" size="md" />

      <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2 }} spacing="3">
        <${MetricLine} label="Beliebtheit im Panel" value=${score.popularityPct.toFixed(0)} colorScheme="blue" />
        <${MetricLine} label="Momentum" value=${score.momentumPct.toFixed(0)} colorScheme="green" />
        <${MetricLine} label="Sender-Breite" value=${score.spreadPct.toFixed(0)} colorScheme="purple" />
        <${MetricLine} label="Durchschnitt Plays/Tag" value=${score.dailyStrengthPct.toFixed(0)} colorScheme="orange" />
      <//>

      <${Chakra.SimpleGrid} columns=${{ base: 2, md: 4 }} spacing="2">
        <${MiniKpi} label="Plays gesamt" value=${formatNumber(totals?.totals?.allTime || 0)} />
        <${MiniKpi} label="Heute" value=${formatNumber(totals?.totals?.today || 0)} />
        <${MiniKpi} label="Woche" value=${formatNumber(totals?.totals?.thisWeek || 0)} />
        <${MiniKpi} label="Trend 48h" value=${formatNumber(trend?.plays_last_48h || 0)} />
      <//>
    <//>
  `;
}

function MetricLine({ label, value, colorScheme }) {
  const ui = useUiColors();
  return html`
    <${Chakra.Box}>
      <${Chakra.HStack} justify="space-between" mb="1">
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${label}<//>
        <${Chakra.Text} fontSize="sm" fontWeight="700" color=${ui.textPrimary}>${value}%<//>
      <//>
      <${Chakra.Progress} value=${Number(value || 0)} colorScheme=${colorScheme} size="sm" borderRadius="999px" />
    <//>
  `;
}

function MiniKpi({ label, value }) {
  const ui = useUiColors();
  return html`
    <${Chakra.Box} border="1px solid" borderColor=${ui.lineColor} borderRadius="12px" px="3" py="2">
      <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>${label}<//>
      <${Chakra.Text} fontSize="lg" fontWeight="700" color=${ui.textPrimary}>${value}<//>
    <//>
  `;
}

function SenderDayHeatmap({ matrix }) {
  const ui = useUiColors();
  const cellText = Chakra.useColorModeValue('#1f3154', '#e2e8f0');
  const cellBorder = Chakra.useColorModeValue('rgba(17, 31, 54, 0.06)', 'rgba(226, 232, 240, 0.18)');
  if (!matrix?.rows?.length) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Keine Tagesdaten im gewählten Zeitraum.<//>`;
  }

  return html`
    <${Chakra.VStack} align="stretch" spacing="4">
      <${Chakra.TableContainer}
        border="1px solid"
        borderColor=${ui.lineColor}
        borderRadius="14px"
        maxH="420px"
        overflowY="auto"
        className="horizon-scroll"
      >
        <${Chakra.Table} size="sm" variant="unstyled">
          <${Chakra.Thead} position="sticky" top="0" bg="cardBg" zIndex="1">
            <${Chakra.Tr} borderBottom="1px solid" borderColor=${ui.lineColor}>
              <${Chakra.Th} py="3" color=${ui.textMuted}>Tag<//>
              ${matrix.stations.map((station) => html`
                <${Chakra.Th} key=${station.stationId} py="3" color=${ui.textMuted} textAlign="center">${station.stationName}<//>
              `)}
              <${Chakra.Th} py="3" color=${ui.textMuted} textAlign="center">Gesamt<//>
            <//>
          <//>
          <${Chakra.Tbody}>
            ${matrix.rows.map((row) => html`
              <${Chakra.Tr} key=${row.period} borderBottom="1px solid" borderColor=${ui.lineColor}>
                <${Chakra.Td} py="2" fontWeight="600" color=${ui.textPrimary}>${dayLabel(row.period)}<//>
                ${row.byStation.map((stationRow) => {
                  const value = Number(stationRow.plays || 0);
                  const ratio = value / matrix.maxValue;
                  const alpha = value > 0 ? 0.10 + (0.55 * ratio) : 0.02;
                  const bg = `rgba(54, 127, 245, ${alpha.toFixed(3)})`;
                  const fg = ratio > 0.55 ? 'white' : cellText;
                  return html`
                    <${Chakra.Td} key=${`${row.period}-${stationRow.stationId}`} py="2" textAlign="center">
                      <${Chakra.Box}
                        mx="auto"
                        maxW="64px"
                        borderRadius="10px"
                        bg=${bg}
                        color=${fg}
                        fontWeight="700"
                        fontSize="sm"
                        py="1"
                        border="1px solid"
                        borderColor=${cellBorder}
                      >
                        ${formatNumber(value)}
                      <//>
                    <//>
                  `;
                })}
                <${Chakra.Td} py="2" textAlign="center" fontWeight="700" color=${ui.textPrimary}>${formatNumber(row.total)}<//>
              <//>
            `)}
          <//>
        <//>
      <//>

      <${Chakra.Box}>
        <${Chakra.Text} fontSize="sm" color=${ui.textMuted} mb="2">Senderanteil im Zeitraum<//>
        <${Chakra.VStack} align="stretch" spacing="2">
          ${matrix.stationTotals.map((row) => {
            const maxTotal = Math.max(1, matrix.stationTotals[0]?.total || 1);
            const pct = Math.round((row.total / maxTotal) * 100);
            return html`
              <${Chakra.Box} key=${row.stationId}>
                <${Chakra.HStack} justify="space-between" mb="1">
                  <${Chakra.Text} fontSize="sm" color=${ui.textPrimary}>${row.stationName}<//>
                  <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${formatNumber(row.total)}<//>
                <//>
                <${Chakra.Progress} value=${pct} colorScheme="blue" borderRadius="999px" size="sm" />
              <//>
            `;
          })}
        <//>
      <//>
    <//>
  `;
}

function BucketTrendCompact({ rows }) {
  const ui = useUiColors();
  if (!rows.length) {
    return html`<${Chakra.Text} color=${ui.textMuted}>Keine Bucket-Daten verfügbar.<//>`;
  }
  const visible = rows.slice(-10);
  const max = Math.max(1, ...visible.map((row) => Number(row.plays || 0)));
  return html`
    <${Chakra.VStack} align="stretch" spacing="2">
      ${visible.map((row) => html`
        <${Chakra.Box} key=${row.period}>
          <${Chakra.HStack} justify="space-between" mb="1">
            <${Chakra.Text} fontSize="sm" color=${ui.textPrimary}>${row.period}<//>
            <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${formatNumber(row.plays)}<//>
          <//>
          <${Chakra.Progress} value=${Math.round((Number(row.plays || 0) / max) * 100)} colorScheme="purple" size="sm" borderRadius="999px" />
        <//>
      `)}
    <//>
  `;
}

function DashboardApp() {
  const ui = useUiColors();
  const requestedTrackKey = React.useMemo(() => new URLSearchParams(window.location.search).get('trackKey'), []);

  const [search, setSearch] = React.useState('');
  const [stationId, setStationId] = React.useState('');
  const [stations, setStations] = React.useState([]);
  const [tracks, setTracks] = React.useState([]);
  const [selectedTrackKey, setSelectedTrackKey] = React.useState(requestedTrackKey || '');

  const defaultTo = berlinYesterdayIsoDate();
  const defaultFrom = shiftBerlinIsoDate(defaultTo, -29);
  const [from, setFrom] = React.useState(defaultFrom);
  const [to, setTo] = React.useState(defaultTo);
  const [bucket, setBucket] = React.useState('day');
  const [includeToday, setIncludeToday] = React.useState(false);

  const [loadingTracks, setLoadingTracks] = React.useState(false);
  const [loadingDetails, setLoadingDetails] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const [totals, setTotals] = React.useState(null);
  const [trend, setTrend] = React.useState(null);
  const [seriesByStation, setSeriesByStation] = React.useState(null);
  const [bucketSeries, setBucketSeries] = React.useState([]);

  const debouncedSearch = useDebouncedValue(search, 250);

  const selectedTrack = React.useMemo(
    () => tracks.find((row) => row.track_key === selectedTrackKey) || null,
    [tracks, selectedTrackKey]
  );

  const maxTrackPlays = React.useMemo(
    () => Math.max(1, ...tracks.map((row) => Number(row.total_plays || 0))),
    [tracks]
  );

  const effectiveTo = includeToday ? berlinTodayIsoDate() : to;
  const matrix = React.useMemo(() => buildDayStationMatrix(seriesByStation), [seriesByStation]);

  const trackSummary = React.useMemo(() => {
    const totalPlays = tracks.reduce((sum, row) => sum + Number(row.total_plays || 0), 0);
    const uniqueArtists = new Set(tracks.map((row) => String(row.artist || '').toLowerCase()).filter(Boolean)).size;
    return {
      tracks: tracks.length,
      plays: totalPlays,
      artists: uniqueArtists
    };
  }, [tracks]);

  const loadStations = React.useCallback(async () => {
    const rows = await apiFetch('/api/stations');
    setStations(Array.isArray(rows) ? rows : []);
  }, []);

  const loadTrackDetails = React.useCallback(async (trackKey) => {
    if (!trackKey) {
      setTotals(null);
      setTrend(null);
      setSeriesByStation(null);
      setBucketSeries([]);
      return;
    }

    setLoadingDetails(true);
    setErrorText('');
    try {
      const detailParams = new URLSearchParams({ from, to: effectiveTo });
      const stationParams = new URLSearchParams({ from, to: effectiveTo, bucket: 'day', limit: '8' });
      const bucketParams = new URLSearchParams({ from, to: effectiveTo, bucket });

      const [totalsRes, trendRes, stationRes, bucketRes] = await Promise.all([
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/totals?${detailParams.toString()}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/trend`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series-by-station?${stationParams.toString()}`),
        apiFetch(`/api/tracks/${encodeURIComponent(trackKey)}/series?${bucketParams.toString()}`)
      ]);

      setTotals(totalsRes || null);
      setTrend(trendRes || null);
      setSeriesByStation(stationRes || null);
      setBucketSeries(Array.isArray(bucketRes?.series) ? bucketRes.series : []);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingDetails(false);
    }
  }, [from, effectiveTo, bucket]);

  const loadTracks = React.useCallback(async () => {
    setLoadingTracks(true);
    setErrorText('');
    try {
      const params = new URLSearchParams({
        q: debouncedSearch,
        stationId,
        limit: '1000'
      });
      if (!stationId) params.delete('stationId');
      if (!debouncedSearch) params.delete('q');

      const rows = await apiFetch(`/api/tracks?${params.toString()}`);
      const safeRows = Array.isArray(rows) ? rows : [];
      setTracks(safeRows);

      let nextTrackKey = selectedTrackKey;
      if (!nextTrackKey && requestedTrackKey) nextTrackKey = requestedTrackKey;
      if (!safeRows.find((row) => row.track_key === nextTrackKey)) {
        nextTrackKey = safeRows[0]?.track_key || '';
      }
      setSelectedTrackKey(nextTrackKey);
    } catch (error) {
      setTracks([]);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTracks(false);
    }
  }, [debouncedSearch, stationId, selectedTrackKey, requestedTrackKey]);

  React.useEffect(() => {
    loadStations().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
    });
  }, [loadStations]);

  React.useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  React.useEffect(() => {
    if (!selectedTrackKey) return;
    loadTrackDetails(selectedTrackKey);
  }, [selectedTrackKey, loadTrackDetails]);

  const applyQuickRange = (rangeKey) => {
    const end = includeToday ? berlinTodayIsoDate() : berlinYesterdayIsoDate();
    let start = end;
    if (rangeKey === '7') start = shiftBerlinIsoDate(end, -6);
    if (rangeKey === '30') start = shiftBerlinIsoDate(end, -29);
    if (rangeKey === '90') start = shiftBerlinIsoDate(end, -89);
    if (rangeKey === 'ytd') {
      const year = Number(end.slice(0, 4));
      start = `${year}-01-01`;
    }
    setFrom(start);
    setTo(end);
  };

  return html`
    <${AppShell}
      activeKey="dashboard"
      title="Dashboard"
      subtitle="Klarer Song-Überblick: Performance und Plays pro Sender/Tag"
      controls=${html`
        <${Chakra.Button}
          size="sm"
          leftIcon=${React.createElement(Icons.RepeatIcon)}
          onClick=${() => loadTracks()}
          isLoading=${loadingTracks}
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
          title="So liest du das Dashboard"
          subtitle="1) Track wählen · 2) Zeitraum setzen · 3) Score und Heatmap interpretieren"
          right=${html`<${Chakra.Badge} colorScheme="blue" borderRadius="999px" px="3" py="1">Einheitliche Ansicht<//>`}
        >
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 3 }} spacing="3">
            <${MiniKpi} label="Score" value="Wie stark der Song im Panel performt" />
            <${MiniKpi} label="Heatmap" value="Plays pro Sender pro Tag" />
            <${MiniKpi} label="Sofort lesbar" value="Wenige klare Metriken statt vieler Charts" />
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 1, lg: 2 }} spacing="4">
          <${PanelCard} title="1) Track auswählen">
            <${Chakra.VStack} align="stretch" spacing="3">
              <${Chakra.FormControl}>
                <${Chakra.FormLabel}>Suche<//>
                <${Chakra.Input}
                  placeholder="Interpret oder Titel"
                  value=${search}
                  onChange=${(event) => setSearch(event.target.value)}
                />
              <//>
              <${Chakra.FormControl}>
                <${Chakra.FormLabel}>Sender<//>
                <${Chakra.Select}
                  value=${stationId}
                  onChange=${(event) => setStationId(event.target.value)}
                >
                  <option value="">Alle Sender</option>
                  ${stations.map((station) => html`<option key=${station.id} value=${station.id}>${station.name || station.id}</option>`)}
                <//>
              <//>
              <${Chakra.Button}
                leftIcon=${React.createElement(Icons.SearchIcon)}
                colorScheme="blue"
                onClick=${() => loadTracks()}
                isLoading=${loadingTracks}
              >Treffer laden<//>
            <//>
          <//>

          <${PanelCard} title="2) Zeitraum einstellen" subtitle="Standard bis gestern für stabile Tageswerte">
            <${Chakra.VStack} align="stretch" spacing="3">
              <${Chakra.FormControl}>
                <${Chakra.FormLabel}>Aggregation<//>
                <${Chakra.Select} value=${bucket} onChange=${(event) => setBucket(event.target.value)}>
                  <option value="day">Tag</option>
                  <option value="week">Woche</option>
                  <option value="month">Monat</option>
                  <option value="year">Jahr</option>
                <//>
              <//>
              <${Chakra.HStack} align="end" spacing="3">
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Von<//>
                  <${Chakra.Input} type="date" value=${from} onChange=${(event) => setFrom(event.target.value)} />
                <//>
                <${Chakra.FormControl}>
                  <${Chakra.FormLabel}>Bis<//>
                  <${Chakra.Input} type="date" value=${to} onChange=${(event) => setTo(event.target.value)} />
                <//>
              <//>
              <${Chakra.HStack} spacing="2" flexWrap="wrap">
                ${['7', '30', '90', 'ytd'].map((range) => html`
                  <${Chakra.Button}
                    key=${range}
                    size="sm"
                    variant="outline"
                    onClick=${() => applyQuickRange(range)}
                  >${range === 'ytd' ? 'YTD' : `${range} Tage`}<//>
                `)}
              <//>
              <${Chakra.Checkbox}
                isChecked=${includeToday}
                onChange=${(event) => setIncludeToday(event.target.checked)}
              >Laufenden Tag einbeziehen<//>
              <${Chakra.Button}
                variant="solid"
                colorScheme="blue"
                onClick=${() => loadTrackDetails(selectedTrackKey)}
                isLoading=${loadingDetails}
                isDisabled=${!selectedTrackKey}
              >Statistik aktualisieren<//>
            <//>
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 2, lg: 4 }} spacing="3">
          <${StatCard} label="Gefundene Titel" value=${formatNumber(trackSummary.tracks)} />
          <${StatCard} label="Einsätze (Trefferliste)" value=${formatNumber(trackSummary.plays)} />
          <${StatCard} label="Künstler" value=${formatNumber(trackSummary.artists)} />
          <${StatCard}
            label="Ausgewählter Track"
            value=${selectedTrack ? `${selectedTrack.artist} - ${selectedTrack.title}` : '-'}
            compact=${true}
          />
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 1, xl: 4 }} spacing="4">
          <${PanelCard} title="Tracks" subtitle=${loadingTracks ? 'Lade Treffer...' : `${formatNumber(tracks.length)} Einträge`} p="4">
            <${Chakra.VStack} align="stretch" spacing="2" maxH="620px" overflowY="auto" className="horizon-scroll">
              ${tracks.slice(0, 260).map((row) => html`
                <${Chakra.Button}
                  key=${row.track_key}
                  variant=${row.track_key === selectedTrackKey ? 'solid' : 'ghost'}
                  colorScheme=${row.track_key === selectedTrackKey ? 'blue' : 'gray'}
                  justifyContent="start"
                  whiteSpace="normal"
                  textAlign="left"
                  h="auto"
                  py="2"
                  onClick=${() => setSelectedTrackKey(row.track_key)}
                >
                  <${Chakra.Box}>
                    <${Chakra.Text} fontSize="sm" fontWeight="700">${row.artist}<//>
                    <${Chakra.Text} fontSize="xs" color=${row.track_key === selectedTrackKey ? 'whiteAlpha.900' : ui.textMuted}>${row.title}<//>
                    <${Chakra.Text} fontSize="xs" color=${row.track_key === selectedTrackKey ? 'whiteAlpha.900' : ui.textMuted}>${formatNumber(row.total_plays)} Plays<//>
                  <//>
                <//>
              `)}
              ${tracks.length === 0 && !loadingTracks ? html`
                <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Keine Treffer. Filter anpassen oder Ingest laufen lassen.<//>
              ` : null}
            <//>
          <//>

          <${Chakra.VStack} gridColumn=${{ base: 'span 1', xl: 'span 3' }} align="stretch" spacing="4">
            <${PanelCard}
              title=${selectedTrack ? `3) Wie gut kommt „${selectedTrack.title}“ an?` : '3) Song-Performance'}
              subtitle=${selectedTrack ? `${selectedTrack.artist} | ${from} bis ${effectiveTo}` : 'Bitte Track wählen'}
            >
              <${SongPerformanceCard}
                selectedTrack=${selectedTrack}
                trend=${trend}
                totals=${totals}
                matrix=${matrix}
                maxTrackPlays=${maxTrackPlays}
                from=${from}
                to=${effectiveTo}
              />
            <//>

            <${PanelCard}
              title="Wie oft läuft der Song pro Sender pro Tag?"
              subtitle="Heatmap mit klaren Zahlen je Tag und Sender"
            >
              <${SenderDayHeatmap} matrix=${matrix} />
            <//>

            ${EXTRA_CHARTS_ENABLED ? html`
              <${PanelCard}
                title="Zusatzansicht: Bucket-Verlauf"
                subtitle=${`Bucket = ${bucket}`}
              >
                <${BucketTrendCompact} rows=${bucketSeries} />
              <//>
            ` : null}
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
      <${DashboardApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
