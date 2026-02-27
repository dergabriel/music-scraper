function toMap(rows) {
  const m = new Map();
  for (const row of rows) m.set(row.track_key, row);
  return m;
}

export function buildStationAnalytics({ station, currentRows, previousRows, currentTotalPlays }) {
  const currentMap = toMap(currentRows);
  const previousMap = toMap(previousRows);

  const newTracks = [];
  const droppedTracks = [];
  const movers = [];
  const allKeys = new Set([...currentMap.keys(), ...previousMap.keys()]);

  for (const row of currentRows) {
    if (!previousMap.has(row.track_key)) {
      newTracks.push(row);
    }
  }

  for (const row of previousRows) {
    if (!currentMap.has(row.track_key)) droppedTracks.push(row);
  }

  for (const key of allKeys) {
    const cur = currentMap.get(key);
    const prev = previousMap.get(key);
    const delta = (cur?.count ?? 0) - (prev?.count ?? 0);
    if (delta === 0) continue;
    movers.push({
      track_key: key,
      artist: cur?.artist ?? prev?.artist ?? '',
      title: cur?.title ?? prev?.title ?? '',
      count: cur?.count ?? 0,
      previousCount: prev?.count ?? 0,
      delta
    });
  }

  const topGainers = movers
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.count - a.count)
    .slice(0, 10);

  const topLosers = movers
    .filter((m) => m.delta < 0)
    .sort((a, b) => a.delta - b.delta || b.previousCount - a.previousCount)
    .slice(0, 10);

  return {
    station,
    totalPlays: currentTotalPlays,
    uniqueTracks: currentRows.length,
    topTracks: currentRows.slice(0, 25),
    newTracks,
    droppedTracks,
    movers: {
      topGainers,
      topLosers
    }
  };
}

export function buildCrossStationAnalytics(stationAnalytics, overallTopRows) {
  const appearances = new Map();

  for (const stationResult of stationAnalytics) {
    for (const t of stationResult.newTracks) {
      if (!appearances.has(t.track_key)) {
        appearances.set(t.track_key, {
          trackKey: t.track_key,
          artist: t.artist,
          title: t.title,
          stations: new Set(),
          totalCount: 0
        });
      }
      const agg = appearances.get(t.track_key);
      agg.stations.add(stationResult.station.id);
      agg.totalCount += t.count;
    }
  }

  const newInMultipleStations = Array.from(appearances.values())
    .filter((x) => x.stations.size >= 2)
    .map((x) => ({
      trackKey: x.trackKey,
      artist: x.artist,
      title: x.title,
      stationCount: x.stations.size,
      stations: Array.from(x.stations).sort(),
      totalCount: x.totalCount
    }))
    .sort((a, b) => b.stationCount - a.stationCount || b.totalCount - a.totalCount);

  return {
    newInMultipleStations,
    overallTopTracks: overallTopRows.slice(0, 50)
  };
}
