import { berlinTodayIsoDate, shiftBerlinIsoDate } from './date-berlin.js';
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
import {
  looksLikeNonMusicTitle,
  dedupeTracksByIdentity,
  displayTrackIdentity,
  matchesSearch,
  trackIdentity
} from './music-quality.js';

const PRESETS = {
  easy: {
    label: 'Locker',
    minDaily: 0.15,
    maxDaily: 2.0,
    minActiveDays: 2,
    minSpanDays: 7,
    minReleaseAgeDays: 1095,
    minTrackAgeDays: 30,
    minConfidence: 0.65,
    hint: 'Mehr Kandidaten, weiterhin nur ältere Songs.'
  },
  balanced: {
    label: 'Standard',
    minDaily: 0.25,
    maxDaily: 1.6,
    minActiveDays: 3,
    minSpanDays: 10,
    minReleaseAgeDays: 1095,
    minTrackAgeDays: 45,
    minConfidence: 0.72,
    hint: 'Empfohlen: guter Mix aus Menge und Qualität.'
  },
  strict: {
    label: 'Streng',
    minDaily: 0.35,
    maxDaily: 1.2,
    minActiveDays: 4,
    minSpanDays: 14,
    minReleaseAgeDays: 1460,
    minTrackAgeDays: 90,
    minConfidence: 0.78,
    hint: 'Nur sehr stabile und klar alte Backpool-Songs.'
  }
};

function toFixedComma(value, digits = 2) {
  return Number(value || 0).toFixed(digits).replace('.', ',');
}

function dayAgeText(days) {
  if (!Number.isFinite(days)) return '-';
  if (days < 365) return `${formatNumber(days)} Tage`;
  return `${toFixedComma(days / 365, 1)} Jahre`;
}

function toIsoDateSafe(value) {
  const str = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
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

function buildProcessed(data, options) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const reasons = {
    trend: 0,
    noisy: 0,
    lowConfidence: 0,
    tooYoungRelease: 0,
    tooYoungStation: 0,
    search: 0
  };

  const perStation = [];
  const allTrackMap = new Map();

  for (const stationRow of rows) {
    const stationName = stationRow.stationName || stationRow.stationId || '-';
    const rotationTracks = Array.isArray(stationRow.rotationBackpoolTracks) ? stationRow.rotationBackpoolTracks : [];
    const trendRows = [
      ...(Array.isArray(stationRow.resurgenceTracks) ? stationRow.resurgenceTracks : []),
      ...(Array.isArray(stationRow.recentTracks) ? stationRow.recentTracks : []),
      ...(Array.isArray(stationRow.hotRotationTracks) ? stationRow.hotRotationTracks : [])
    ];
    const excludedTrendIds = new Set(trendRows.map((row) => trackIdentity(row)));
    const excludedTrendDisplayIds = new Set(trendRows.map((row) => displayTrackIdentity(row)));

    const stationTracks = [];
    for (const track of rotationTracks) {
      const exactId = trackIdentity(track);
      const id = displayTrackIdentity(track);
      const noisy = looksLikeNonMusicTitle(track.artist, track.title);
      const lowConfidence = Number.isFinite(Number(track.verificationConfidence))
        ? Number(track.verificationConfidence) < Number(options.minConfidence || 0)
        : false;
      const tooYoungRelease = Number.isFinite(Number(track.releaseAgeDays))
        ? Number(track.releaseAgeDays) < Number(options.minReleaseAgeDays || 0)
        : false;
      const tooYoungStation = Number.isFinite(Number(track.stationAgeDays))
        ? Number(track.stationAgeDays) < Number(options.minTrackAgeDays || 0)
        : false;
      const trendExcluded = excludedTrendIds.has(exactId) || excludedTrendDisplayIds.has(id);

      let excluded = false;
      if (trendExcluded) {
        reasons.trend += 1;
        excluded = true;
      }
      if (!excluded && options.excludeNoise && noisy) {
        reasons.noisy += 1;
        excluded = true;
      }
      if (!excluded && options.enforceConfidence && lowConfidence) {
        reasons.lowConfidence += 1;
        excluded = true;
      }
      if (!excluded && options.enforceReleaseAge && tooYoungRelease) {
        reasons.tooYoungRelease += 1;
        excluded = true;
      }
      if (!excluded && options.enforceTrackAge && tooYoungStation) {
        reasons.tooYoungStation += 1;
        excluded = true;
      }
      if (excluded) continue;

      const enriched = {
        ...track,
        _id: id,
        trackKey: track.trackKey || track.track_key || null,
        stationName,
        stationId: stationRow.stationId,
        plays: Number(track.plays || 0),
        playsPerDay: Number(track.playsPerDay || 0),
        activeDays: Number(track.activeDays || 0),
        spanDays: Number(track.spanDays || 0),
        cadenceDays: Number(track.cadenceDays || 0)
      };

      if (!matchesSearch(enriched, options.search)) {
        reasons.search += 1;
        continue;
      }

      stationTracks.push(enriched);
    }

    const stationTracksDeduped = dedupeTracksByIdentity(stationTracks, { identityFn: displayTrackIdentity }).map((row) => ({
      ...row,
      _id: displayTrackIdentity(row)
    }));

    for (const enriched of stationTracksDeduped) {
      const id = displayTrackIdentity(enriched);
      if (!allTrackMap.has(id)) {
        allTrackMap.set(id, {
          ...enriched,
          stationNames: new Set([stationName]),
          stationIds: new Set([stationRow.stationId]),
          stationCount: 1,
          playsPerDaySum: Number(enriched.playsPerDay || 0),
          cadenceSamples: Number.isFinite(enriched.cadenceDays) && enriched.cadenceDays > 0 ? [enriched.cadenceDays] : []
        });
      } else {
        const entry = allTrackMap.get(id);
        entry.plays += Number(enriched.plays || 0);
        entry.activeDays = Math.max(entry.activeDays, Number(enriched.activeDays || 0));
        entry.spanDays = Math.max(entry.spanDays, Number(enriched.spanDays || 0));
        entry.playsPerDaySum += Number(enriched.playsPerDay || 0);
        if (Number.isFinite(enriched.cadenceDays) && enriched.cadenceDays > 0) entry.cadenceSamples.push(enriched.cadenceDays);
        entry.stationNames.add(stationName);
        entry.stationIds.add(stationRow.stationId);
      }
    }

    stationTracksDeduped.sort((a, b) => b.plays - a.plays || b.playsPerDay - a.playsPerDay);
    perStation.push({
      stationId: stationRow.stationId,
      stationName,
      tracks: stationTracksDeduped,
      totalPlays: stationTracksDeduped.reduce((sum, row) => sum + Number(row.plays || 0), 0)
    });
  }

  const allTracks = Array.from(allTrackMap.values()).map((entry) => {
    const stationNames = Array.from(entry.stationNames).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
    const stationCount = stationNames.length;
    const avgCadence = entry.cadenceSamples.length
      ? entry.cadenceSamples.reduce((sum, v) => sum + v, 0) / entry.cadenceSamples.length
      : null;
    return {
      ...entry,
      stationNames,
      stationCount,
      playsPerDay: stationCount > 0 ? entry.playsPerDaySum / stationCount : 0,
      cadenceDays: avgCadence
    };
  }).sort((a, b) => b.plays - a.plays || b.playsPerDay - a.playsPerDay);

  perStation.sort((a, b) => b.totalPlays - a.totalPlays);

  return {
    allTracks,
    perStation,
    reasons
  };
}

function BackpoolApp() {
  const ui = useUiColors();

  const today = berlinTodayIsoDate();
  const [from, setFrom] = React.useState(shiftBerlinIsoDate(today, -365));
  const [to, setTo] = React.useState(today);
  const [stationId, setStationId] = React.useState('');
  const [presetId, setPresetId] = React.useState('balanced');
  const [minPlays, setMinPlays] = React.useState('1');
  const [top, setTop] = React.useState('500');
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState('global');

  const [excludeNoise, setExcludeNoise] = React.useState(true);
  const [enforceConfidence, setEnforceConfidence] = React.useState(true);
  const [enforceReleaseAge, setEnforceReleaseAge] = React.useState(true);
  const [enforceTrackAge, setEnforceTrackAge] = React.useState(true);

  const [stations, setStations] = React.useState([]);
  const [rawData, setRawData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');

  const debouncedSearch = useDebouncedValue(search, 240);
  const preset = PRESETS[presetId] || PRESETS.balanced;

  const processed = React.useMemo(() => {
    return buildProcessed(rawData || {}, {
      search: debouncedSearch,
      excludeNoise,
      enforceConfidence,
      enforceReleaseAge,
      enforceTrackAge,
      minConfidence: preset.minConfidence,
      minReleaseAgeDays: preset.minReleaseAgeDays,
      minTrackAgeDays: preset.minTrackAgeDays
    });
  }, [rawData, debouncedSearch, excludeNoise, enforceConfidence, enforceReleaseAge, enforceTrackAge, preset]);

  const kpis = React.useMemo(() => {
    const allTracks = processed.allTracks;
    const plays = allTracks.reduce((sum, row) => sum + Number(row.plays || 0), 0);
    const avgPlaysPerDay = allTracks.length
      ? allTracks.reduce((sum, row) => sum + Number(row.playsPerDay || 0), 0) / allTracks.length
      : 0;
    const senderCount = new Set(allTracks.flatMap((row) => row.stationNames || [])).size;
    return {
      tracks: allTracks.length,
      plays,
      avgPlaysPerDay,
      senderCount
    };
  }, [processed.allTracks]);

  const recentBackpool = React.useMemo(() => {
    const cutoff = shiftBerlinIsoDate(to || berlinTodayIsoDate(), -13);
    return (processed.allTracks || [])
      .filter((row) => {
        const first = toIsoDateSafe(row.firstPlayedDate || row.first_played_at_utc?.slice?.(0, 10));
        return Boolean(first && first >= cutoff);
      })
      .sort((a, b) => String(b.firstPlayedDate || '').localeCompare(String(a.firstPlayedDate || '')))
      .slice(0, 12);
  }, [processed.allTracks, to]);

  const loadStations = React.useCallback(async () => {
    const data = await apiFetch('/api/stations');
    setStations(Array.isArray(data) ? data : []);
  }, []);

  const loadBackpool = React.useCallback(async () => {
    setLoading(true);
    setErrorText('');
    try {
      const params = new URLSearchParams();
      params.set('from', from || shiftBerlinIsoDate(berlinTodayIsoDate(), -365));
      params.set('to', to || berlinTodayIsoDate());
      params.set('years', '5');
      params.set('minPlays', minPlays || '1');
      params.set('top', top || '500');
      params.set('rotationMinDailyPlays', String(preset.minDaily));
      params.set('lowRotationMaxDailyPlays', String(preset.maxDaily));
      params.set('rotationMinActiveDays', String(preset.minActiveDays));
      params.set('rotationMinSpanDays', String(preset.minSpanDays));
      params.set('rotationMinReleaseAgeDays', String(preset.minReleaseAgeDays));
      params.set('minTrackAgeDays', String(preset.minTrackAgeDays));
      params.set('rotationAdaptive', '1');
      params.set('minConfidence', String(preset.minConfidence));
      params.set('hydrate', '0');
      params.set('maxMetaLookups', '0');
      if (stationId) params.set('stationId', stationId);

      const data = await apiFetch(`/api/insights/backpool?${params.toString()}`);
      setRawData(data || null);
    } catch (error) {
      setRawData(null);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [from, to, minPlays, top, preset, stationId]);

  React.useEffect(() => {
    loadStations().catch((error) => {
      setErrorText(error instanceof Error ? error.message : String(error));
    });
  }, [loadStations]);

  React.useEffect(() => {
    loadBackpool();
  }, [loadBackpool]);

  const applyRange = (days) => {
    const end = berlinTodayIsoDate();
    const start = shiftBerlinIsoDate(end, -(days - 1));
    setFrom(start);
    setTo(end);
  };

  return html`
    <${AppShell}
      activeKey="backpool"
      title="Backpool"
      subtitle="Alte, niedrig rotierende Songs mit klaren Qualitätsregeln"
      controls=${html`
        <${Chakra.Button}
          size="sm"
          leftIcon=${React.createElement(Icons.RepeatIcon)}
          onClick=${() => loadBackpool()}
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
          title="So liest du den Backpool"
          subtitle="Gesamtliste zeigt nur validierte Backpool-Titel. Senderansicht zeigt Verteilung je Station."
          right=${html`<${Chakra.Badge} colorScheme="purple" borderRadius="999px" px="3" py="1">${preset.label}<//>`}
        >
          <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>${preset.hint}<//>
        <//>

        <${PanelCard} title="Filter">
          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2, xl: 7 }} spacing="3">
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
              <${Chakra.FormLabel}>Profil<//>
              <${Chakra.Select} value=${presetId} onChange=${(event) => setPresetId(event.target.value)}>
                ${Object.entries(PRESETS).map(([key, item]) => html`<option key=${key} value=${key}>${item.label}</option>`)}
              <//>
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Min. Einsätze<//>
              <${Chakra.Input} type="number" min="1" max="500" value=${minPlays} onChange=${(event) => setMinPlays(event.target.value)} />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Max. Titel<//>
              <${Chakra.Input} type="number" min="1" max="500" value=${top} onChange=${(event) => setTop(event.target.value)} />
            <//>
            <${Chakra.FormControl}>
              <${Chakra.FormLabel}>Suche<//>
              <${Chakra.Input} value=${search} onChange=${(event) => setSearch(event.target.value)} placeholder="Interpret, Titel, Sender" />
            <//>
          <//>

          <${Chakra.HStack} spacing="2" mt="3" flexWrap="wrap">
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(90)}>90 Tage<//>
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(180)}>180 Tage<//>
            <${Chakra.Button} size="sm" variant="outline" onClick=${() => applyRange(365)}>365 Tage<//>
            <${Chakra.Button} size="sm" colorScheme="blue" onClick=${() => loadBackpool()} isLoading=${loading}>Laden<//>
          <//>

          <${Chakra.SimpleGrid} columns=${{ base: 1, md: 2, xl: 4 }} spacing="3" mt="4">
            <${Chakra.Checkbox} isChecked=${excludeNoise} onChange=${(event) => setExcludeNoise(event.target.checked)}>
              Nicht-Musik ausblenden
            <//>
            <${Chakra.Checkbox} isChecked=${enforceConfidence} onChange=${(event) => setEnforceConfidence(event.target.checked)}>
              Min. Treffsicherheit ${preset.minConfidence}
            <//>
            <${Chakra.Checkbox} isChecked=${enforceReleaseAge} onChange=${(event) => setEnforceReleaseAge(event.target.checked)}>
              Min. Release-Alter ${formatNumber(preset.minReleaseAgeDays)} Tage
            <//>
            <${Chakra.Checkbox} isChecked=${enforceTrackAge} onChange=${(event) => setEnforceTrackAge(event.target.checked)}>
              Min. Sender-Alter ${formatNumber(preset.minTrackAgeDays)} Tage
            <//>
          <//>
        <//>

        <${Chakra.SimpleGrid} columns=${{ base: 2, lg: 4 }} spacing="3">
          <${StatCard} label="Backpool-Titel" value=${formatNumber(kpis.tracks)} />
          <${StatCard} label="Backpool-Plays" value=${formatNumber(kpis.plays)} />
          <${StatCard} label="Ø Plays/Tag" value=${toFixedComma(kpis.avgPlaysPerDay, 2)} />
          <${StatCard} label="Aktive Sender" value=${formatNumber(kpis.senderCount)} />
        <//>

        <${PanelCard}
          title="Neu im Backpool"
          subtitle="Titel, die in den letzten 14 Tagen erstmals als Backpool im Monitoring auftauchen"
          right=${html`<${Chakra.Badge} colorScheme="green" borderRadius="999px" px="3" py="1">${formatNumber(recentBackpool.length)} Titel<//>`}
        >
          <${Chakra.VStack} align="stretch" spacing="2">
            ${recentBackpool.map((row) => html`
              <${Chakra.HStack} key=${row._id} justify="space-between" border="1px solid" borderColor=${ui.lineColor} borderRadius="10px" px="3" py="2">
                <${Chakra.Box} minW="0">
                  <${Chakra.Text} fontSize="sm" fontWeight="700" color=${ui.textPrimary} noOfLines=${1}>${row.artist} - ${row.title}<//>
                  <${Chakra.Text} fontSize="xs" color=${ui.textMuted}>
                    Erstes Backpool-Signal: ${row.firstPlayedDate || '-'} | Ø/Tag: ${toFixedComma(row.playsPerDay, 2)} | Sender: ${formatNumber(row.stationCount)}
                  <//>
                <//>
                ${row.trackKey ? html`
                  <${Chakra.Link} href=${`/dashboard?trackKey=${encodeURIComponent(row.trackKey)}`} color="blue.500" whiteSpace="nowrap">Öffnen<//>
                ` : null}
              <//>
            `)}
            ${recentBackpool.length === 0 ? html`
              <${Chakra.Text} fontSize="sm" color=${ui.textMuted}>Keine neuen Backpool-Titel in den letzten 14 Tagen.<//>
            ` : null}
          <//>
        <//>

        <${PanelCard} title="Qualitätsfilter" subtitle="Ausgeblendete Titel nach Grund">
          <${Chakra.HStack} spacing="3" flexWrap="wrap">
            <${Chakra.Tag} colorScheme="red" borderRadius="999px">Nicht-Musik: ${formatNumber(processed.reasons.noisy)}<//>
            <${Chakra.Tag} colorScheme="orange" borderRadius="999px">Trend/Revival: ${formatNumber(processed.reasons.trend)}<//>
            <${Chakra.Tag} colorScheme="purple" borderRadius="999px">Low Confidence: ${formatNumber(processed.reasons.lowConfidence)}<//>
            <${Chakra.Tag} colorScheme="blue" borderRadius="999px">Zu jung (Release): ${formatNumber(processed.reasons.tooYoungRelease)}<//>
            <${Chakra.Tag} colorScheme="gray" borderRadius="999px">Zu jung (Sender): ${formatNumber(processed.reasons.tooYoungStation)}<//>
            <${Chakra.Tag} colorScheme="teal" borderRadius="999px">Suchfilter: ${formatNumber(processed.reasons.search)}<//>
          <//>
        <//>

        <${PanelCard}
          title="Ansicht"
          right=${html`
            <${Chakra.ButtonGroup} size="sm" isAttached variant="outline">
              <${Chakra.Button} colorScheme=${viewMode === 'global' ? 'blue' : 'gray'} onClick=${() => setViewMode('global')}>Gesamtliste<//>
              <${Chakra.Button} colorScheme=${viewMode === 'station' ? 'blue' : 'gray'} onClick=${() => setViewMode('station')}>Senderansicht<//>
            <//>
          `}
        >
          ${viewMode === 'global'
            ? html`<${GlobalList} rows=${processed.allTracks} lineColor=${ui.lineColor} textMuted=${ui.textMuted} textPrimary=${ui.textPrimary} />`
            : html`<${StationView} rows=${processed.perStation} lineColor=${ui.lineColor} textMuted=${ui.textMuted} textPrimary=${ui.textPrimary} />`}
        <//>
      <//>
    <//>
  `;
}

function GlobalList({ rows, lineColor, textMuted, textPrimary }) {
  return html`
    <${Chakra.TableContainer} maxH="660px" overflowY="auto" className="horizon-scroll" border="1px solid" borderColor=${lineColor} borderRadius="14px">
      <${Chakra.Table} size="sm">
        <${Chakra.Thead}>
          <${Chakra.Tr}>
            <${Chakra.Th}>Titel<//>
            <${Chakra.Th}>Plays<//>
            <${Chakra.Th}>Ø/Tag<//>
            <${Chakra.Th}>Sender<//>
            <${Chakra.Th}>Release-Alter<//>
            <${Chakra.Th}>Ø Abstand<//>
            <${Chakra.Th}>Analyse<//>
          <//>
        <//>
        <${Chakra.Tbody}>
          ${rows.map((row) => html`
            <${Chakra.Tr} key=${row._id}>
              <${Chakra.Td}>
                <${Chakra.Text} fontWeight="700" color=${textPrimary}>${row.artist}<//>
                <${Chakra.Text} fontSize="xs" color=${textMuted}>${row.title}<//>
                <${Chakra.Text} fontSize="xs" color=${textMuted}>ID: ${row.trackKey || '-'}<//>
              <//>
              <${Chakra.Td}>${formatNumber(row.plays)}<//>
              <${Chakra.Td}>${toFixedComma(row.playsPerDay, 2)}<//>
              <${Chakra.Td}>
                <${Chakra.Text}>${formatNumber(row.stationCount)}<//>
                <${Chakra.Text} fontSize="xs" color=${textMuted}>${(row.stationNames || []).slice(0, 2).join(', ') || '-'}<//>
              <//>
              <${Chakra.Td}>${dayAgeText(row.releaseAgeDays)}<//>
              <${Chakra.Td}>${Number.isFinite(row.cadenceDays) && row.cadenceDays > 0 ? `${toFixedComma(row.cadenceDays, 2)} Tage` : '-'}<//>
              <${Chakra.Td}>
                ${row.trackKey ? html`
                  <${Chakra.VStack} align="start" spacing="1">
                    <${Chakra.Link} href=${`/dashboard?trackKey=${encodeURIComponent(row.trackKey)}`} color="blue.500">Öffnen<//>
                    <${Chakra.Button} size="xs" variant="outline" onClick=${() => copyToClipboard(row.trackKey)}>ID kopieren<//>
                  <//>
                ` : '-'}
              <//>
            <//>
          `)}
          ${rows.length === 0 ? html`
            <${Chakra.Tr}><${Chakra.Td} colSpan="7" color=${textMuted}>Keine Backpool-Titel für diese Filter.<//><//>
          ` : null}
        <//>
      <//>
    <//>
  `;
}

function StationView({ rows, lineColor, textMuted, textPrimary }) {
  return html`
    <${Chakra.VStack} align="stretch" spacing="3">
      ${rows.map((station) => html`
        <${Chakra.Box} key=${station.stationId} border="1px solid" borderColor=${lineColor} borderRadius="14px" p="3">
          <${Chakra.HStack} justify="space-between" mb="2">
            <${Chakra.Text} fontWeight="700" color=${textPrimary}>${station.stationName}<//>
            <${Chakra.Text} fontSize="sm" color=${textMuted}>${formatNumber(station.tracks.length)} Titel | ${formatNumber(station.totalPlays)} Plays<//>
          <//>
          <${Chakra.TableContainer}>
            <${Chakra.Table} size="sm" variant="simple">
              <${Chakra.Thead}>
                <${Chakra.Tr}>
                  <${Chakra.Th}>Titel<//>
                  <${Chakra.Th}>Plays<//>
                  <${Chakra.Th}>Ø/Tag<//>
                  <${Chakra.Th}>Release-Alter<//>
                <//>
              <//>
              <${Chakra.Tbody}>
                ${(station.tracks || []).slice(0, 10).map((row) => html`
                  <${Chakra.Tr} key=${row._id}>
                    <${Chakra.Td}>
                      <${Chakra.Text} fontWeight="600" color=${textPrimary}>${row.artist} - ${row.title}<//>
                      <${Chakra.Text} fontSize="xs" color=${textMuted}>ID: ${row.trackKey || '-'}<//>
                    <//>
                    <${Chakra.Td}>${formatNumber(row.plays)}<//>
                    <${Chakra.Td}>${toFixedComma(row.playsPerDay, 2)}<//>
                    <${Chakra.Td}>${dayAgeText(row.releaseAgeDays)}<//>
                  <//>
                `)}
              <//>
            <//>
          <//>
        <//>
      `)}
      ${rows.length === 0 ? html`<${Chakra.Text} color=${textMuted}>Keine Senderdaten für die aktuelle Auswahl.<//>` : null}
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
      <${BackpoolApp} />
    <//>
  `;
}

const root = createRoot(document.getElementById('app'));
root.render(React.createElement(Root));
