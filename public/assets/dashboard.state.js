const requestedTrackKey = new URLSearchParams(window.location.search).get('trackKey');

const state = {
  stations: [],
  tracks: [],
  selectedTrack: null,
  newWeekRows: [],
  metadataRefreshAttempted: new Set(),
  requestedTrackKey,
  focusedTrackMode: Boolean(requestedTrackKey),
  detailCache: null
};

export function getState() {
  return state;
}

export function setStations(rows) {
  state.stations = Array.isArray(rows) ? rows : [];
}

export function setTracks(rows) {
  state.tracks = Array.isArray(rows) ? rows : [];
}

export function setSelectedTrack(track) {
  state.selectedTrack = track || null;
}

export function setNewWeekRows(rows) {
  state.newWeekRows = Array.isArray(rows) ? rows : [];
}

export function markMetadataRefreshAttempt(trackKey) {
  if (trackKey) state.metadataRefreshAttempted.add(trackKey);
}

export function hasMetadataRefreshAttempt(trackKey) {
  return state.metadataRefreshAttempted.has(trackKey);
}

export function setDetailCache(cache) {
  state.detailCache = cache || null;
}
