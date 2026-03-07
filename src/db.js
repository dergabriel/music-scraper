import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_STATEMENT_CACHE = new WeakMap();
const DB_QUERY_API_CACHE = new WeakMap();

export function createDbQueries(db) {
  return {
    prepare(key, sql) {
      let cache = DB_STATEMENT_CACHE.get(db);
      if (!cache) {
        cache = new Map();
        DB_STATEMENT_CACHE.set(db, cache);
      }
      if (!cache.has(key)) {
        cache.set(key, db.prepare(sql));
      }
      return cache.get(key);
    }
  };
}

function dbQueries(db) {
  let queryApi = DB_QUERY_API_CACHE.get(db);
  if (!queryApi) {
    queryApi = createDbQueries(db);
    DB_QUERY_API_CACHE.set(db, queryApi);
  }
  return queryApi;
}

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.resolve(__dirname, '../schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  ensureTrackMetadataColumns(db);

  return db;
}

function ensureTrackMetadataColumns(db) {
  const existing = new Set(
    db.prepare("select name from pragma_table_info('track_metadata')").all().map((row) => row.name)
  );
  const required = {
    album: 'text',
    label: 'text',
    duration_ms: 'integer',
    preview_url: 'text',
    isrc: 'text',
    spotify_track_id: 'text',
    spotify_confidence: 'real',
    canonical_source: 'text',
    canonical_id: 'text',
    chart_country: 'text'
  };

  for (const [name, type] of Object.entries(required)) {
    if (!existing.has(name)) {
      db.exec(`alter table track_metadata add column ${name} ${type}`);
    }
  }

  const playColumns = new Set(
    db.prepare("select name from pragma_table_info('plays')").all().map((row) => row.name)
  );
  if (!playColumns.has('dedup_song_key')) {
    db.exec('alter table plays add column dedup_song_key text');
  }
  db.exec('create index if not exists idx_plays_station_songkey_playedat on plays(station_id, dedup_song_key, played_at_utc)');
  db.exec('create index if not exists idx_plays_track_played_at on plays(track_key, played_at_utc)');
  db.exec('create index if not exists idx_plays_track_station_played_at on plays(track_key, station_id, played_at_utc)');
  db.exec('create index if not exists idx_track_metadata_isrc on track_metadata(isrc)');
}

export function upsertStation(db, station) {
  const stmt = dbQueries(db).prepare('upsertStation', `
    insert into stations(id, name, url, timezone)
    values (@id, @name, @playlist_url, @timezone)
    on conflict(id) do update set
      name = excluded.name,
      url = excluded.url,
      timezone = excluded.timezone
  `);
  stmt.run(station);
}

export function insertPlayIgnore(db, row) {
  const params = {
    ...row,
    dedup_song_key: row?.dedup_song_key ?? null,
    source_url: row?.source_url ?? null,
    ingested_at_utc: row?.ingested_at_utc ?? null
  };
  const stmt = dbQueries(db).prepare('insertPlayIgnore', `
    insert or ignore into plays(
      station_id,
      played_at_utc,
      artist_raw,
      title_raw,
      artist,
      title,
      track_key,
      dedup_song_key,
      source_url,
      ingested_at_utc
    ) values (
      @station_id,
      @played_at_utc,
      @artist_raw,
      @title_raw,
      @artist,
      @title,
      @track_key,
      @dedup_song_key,
      @source_url,
      @ingested_at_utc
    )
  `);
  return stmt.run(params).changes;
}

export function insertDedupEvent(db, row) {
  const stmt = dbQueries(db).prepare('insertDedupEvent', `
    insert into play_dedup_events(
      station_id,
      played_at_utc,
      artist_raw,
      title_raw,
      artist,
      title,
      track_key,
      dedup_song_key,
      deduped,
      last_counted_at_utc,
      delta_seconds,
      source_url,
      ingested_at_utc
    ) values (
      @station_id,
      @played_at_utc,
      @artist_raw,
      @title_raw,
      @artist,
      @title,
      @track_key,
      @dedup_song_key,
      @deduped,
      @last_counted_at_utc,
      @delta_seconds,
      @source_url,
      @ingested_at_utc
    )
  `);
  return stmt.run(row).changes;
}

export function getStationTrackCounts(db, stationId, startUtcIso, endUtcIso) {
  const stmt = dbQueries(db).prepare('getStationTrackCounts', `
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as count
    from plays
    where station_id = ?
      and played_at_utc >= ?
      and played_at_utc < ?
    group by track_key
    order by count desc, artist asc, title asc
  `);
  return stmt.all(stationId, startUtcIso, endUtcIso);
}

export function getStationTrackCountsWithMetadata(db, stationId, startUtcIso, endUtcIso) {
  const stmt = dbQueries(db).prepare('getStationTrackCountsWithMetadata', `
    select
      p.track_key,
      min(p.artist) as artist,
      min(p.title) as title,
      count(*) as count,
      count(distinct substr(p.played_at_utc, 1, 10)) as active_days,
      min(p.played_at_utc) as first_played_at_utc,
      max(p.played_at_utc) as last_played_at_utc,
      min(m.release_date_utc) as release_date_utc,
      min(m.verification_confidence) as verification_confidence,
      min(m.verified_exists) as verified_exists,
      min(m.external_url) as external_url,
      min(m.preview_url) as preview_url,
      min(m.genre) as genre,
      min(m.album) as album
    from plays p
    left join track_metadata m on m.track_key = p.track_key
    where p.station_id = ?
      and p.played_at_utc >= ?
      and p.played_at_utc < ?
    group by p.track_key
    order by count desc, artist asc, title asc
  `);
  return stmt.all(stationId, startUtcIso, endUtcIso);
}

export function getStationTotalPlays(db, stationId, startUtcIso, endUtcIso) {
  const stmt = dbQueries(db).prepare('getStationTotalPlays', `
    select count(*) as total
    from plays
    where station_id = ?
      and played_at_utc >= ?
      and played_at_utc < ?
  `);
  return stmt.get(stationId, startUtcIso, endUtcIso)?.total ?? 0;
}

export function getStationPlayedAtUtc(db, stationId, startUtcIso, endUtcIso) {
  return dbQueries(db).prepare('getStationPlayedAtUtc', `
    select played_at_utc
    from plays
    where station_id = ?
      and played_at_utc >= ?
      and played_at_utc < ?
    order by played_at_utc asc
  `).all(stationId, startUtcIso, endUtcIso);
}

export function getOverallTrackCounts(db, startUtcIso, endUtcIso) {
  const stmt = dbQueries(db).prepare('getOverallTrackCounts', `
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as count
    from plays
    where played_at_utc >= ?
      and played_at_utc < ?
    group by track_key
    order by count desc, artist asc, title asc
  `);
  return stmt.all(startUtcIso, endUtcIso);
}

export function clearDailyStatsForDate(db, dateBerlin) {
  const q = dbQueries(db);
  q.prepare('clearDailyStatsForDate:station', 'delete from daily_station_stats where date_berlin = ?').run(dateBerlin);
  q.prepare('clearDailyStatsForDate:track', 'delete from daily_track_stats where date_berlin = ?').run(dateBerlin);
  q.prepare('clearDailyStatsForDate:overall', 'delete from daily_overall_track_stats where date_berlin = ?').run(dateBerlin);
}

export function upsertDailyStationStat(db, row) {
  dbQueries(db).prepare('upsertDailyStationStat', `
    insert into daily_station_stats(date_berlin, station_id, total_plays, unique_tracks)
    values (@date_berlin, @station_id, @total_plays, @unique_tracks)
    on conflict(date_berlin, station_id) do update set
      total_plays = excluded.total_plays,
      unique_tracks = excluded.unique_tracks
  `).run(row);
}

export function upsertDailyTrackStat(db, row) {
  dbQueries(db).prepare('upsertDailyTrackStat', `
    insert into daily_track_stats(date_berlin, station_id, track_key, artist, title, plays)
    values (@date_berlin, @station_id, @track_key, @artist, @title, @plays)
    on conflict(date_berlin, station_id, track_key) do update set
      artist = excluded.artist,
      title = excluded.title,
      plays = excluded.plays
  `).run(row);
}

export function upsertDailyOverallTrackStat(db, row) {
  dbQueries(db).prepare('upsertDailyOverallTrackStat', `
    insert into daily_overall_track_stats(date_berlin, track_key, artist, title, plays)
    values (@date_berlin, @track_key, @artist, @title, @plays)
    on conflict(date_berlin, track_key) do update set
      artist = excluded.artist,
      title = excluded.title,
      plays = excluded.plays
  `).run(row);
}

export function listStations(db) {
  return dbQueries(db).prepare('listStations', 'select id, name, url, timezone from stations order by name asc').all();
}

export function searchTracks(db, query, limit = 30) {
  return dbQueries(db).prepare('searchTracks', `
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as total_plays
    from plays
    where artist like ? or title like ?
    group by track_key
    order by total_plays desc
    limit ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function getTrackPlays(db, { trackKey, stationId, startUtcIso, endUtcIso }) {
  const q = dbQueries(db);
  if (stationId) {
    return q.prepare('getTrackPlays:station', `
      select station_id, played_at_utc
      from plays
      where track_key = ?
        and station_id = ?
        and played_at_utc >= ?
        and played_at_utc < ?
      order by played_at_utc asc
    `).all(trackKey, stationId, startUtcIso, endUtcIso);
  }

  return q.prepare('getTrackPlays:allStations', `
    select station_id, played_at_utc
    from plays
    where track_key = ?
      and played_at_utc >= ?
      and played_at_utc < ?
    order by played_at_utc asc
  `).all(trackKey, startUtcIso, endUtcIso);
}

export function getTrackIdentity(db, trackKey) {
  return dbQueries(db).prepare('getTrackIdentity', `
    select min(artist) as artist, min(title) as title
    from plays
    where track_key = ?
  `).get(trackKey);
}

export function getTrackMetadata(db, trackKey) {
  return dbQueries(db).prepare('getTrackMetadata', `
    select
      track_key,
      artist,
      title,
      verified_exists,
      verification_source,
      verification_confidence,
      external_track_id,
      external_url,
      artwork_url,
      release_date_utc,
      genre,
      album,
      label,
      duration_ms,
      preview_url,
      isrc,
      spotify_track_id,
      spotify_confidence,
      canonical_source,
      canonical_id,
      popularity_score,
      chart_airplay_rank,
      chart_single_rank,
      chart_country,
      social_viral_score,
      payload_json,
      last_checked_utc
    from track_metadata
    where track_key = ?
  `).get(trackKey);
}

export function upsertTrackMetadata(db, row) {
  const payload = {
    ...row,
    spotify_track_id: row?.spotify_track_id ?? null,
    spotify_confidence: Number.isFinite(Number(row?.spotify_confidence)) ? Number(row.spotify_confidence) : null,
    canonical_source: row?.canonical_source ?? null,
    canonical_id: row?.canonical_id ?? null
  };
  dbQueries(db).prepare('upsertTrackMetadata', `
    insert into track_metadata(
      track_key,
      artist,
      title,
      verified_exists,
      verification_source,
      verification_confidence,
      external_track_id,
      external_url,
      artwork_url,
      release_date_utc,
      genre,
      album,
      label,
      duration_ms,
      preview_url,
      isrc,
      spotify_track_id,
      spotify_confidence,
      canonical_source,
      canonical_id,
      popularity_score,
      chart_airplay_rank,
      chart_single_rank,
      chart_country,
      social_viral_score,
      payload_json,
      last_checked_utc
    ) values (
      @track_key,
      @artist,
      @title,
      @verified_exists,
      @verification_source,
      @verification_confidence,
      @external_track_id,
      @external_url,
      @artwork_url,
      @release_date_utc,
      @genre,
      @album,
      @label,
      @duration_ms,
      @preview_url,
      @isrc,
      @spotify_track_id,
      @spotify_confidence,
      @canonical_source,
      @canonical_id,
      @popularity_score,
      @chart_airplay_rank,
      @chart_single_rank,
      @chart_country,
      @social_viral_score,
      @payload_json,
      @last_checked_utc
    )
    on conflict(track_key) do update set
      artist = excluded.artist,
      title = excluded.title,
      verified_exists = excluded.verified_exists,
      verification_source = excluded.verification_source,
      verification_confidence = excluded.verification_confidence,
      external_track_id = excluded.external_track_id,
      external_url = excluded.external_url,
      artwork_url = excluded.artwork_url,
      release_date_utc = excluded.release_date_utc,
      genre = excluded.genre,
      album = excluded.album,
      label = excluded.label,
      duration_ms = excluded.duration_ms,
      preview_url = excluded.preview_url,
      isrc = excluded.isrc,
      spotify_track_id = excluded.spotify_track_id,
      spotify_confidence = excluded.spotify_confidence,
      canonical_source = excluded.canonical_source,
      canonical_id = excluded.canonical_id,
      popularity_score = excluded.popularity_score,
      chart_airplay_rank = excluded.chart_airplay_rank,
      chart_single_rank = excluded.chart_single_rank,
      chart_country = excluded.chart_country,
      social_viral_score = excluded.social_viral_score,
      payload_json = excluded.payload_json,
      last_checked_utc = excluded.last_checked_utc
  `).run(payload);
}

export function upsertCanonicalMap(db, row) {
  dbQueries(db).prepare('upsertCanonicalMap', `
    insert into canonical_map(
      canonical_title,
      canonical_primary_artist,
      canonical_track_key,
      updated_at_utc
    ) values (
      @canonical_title,
      @canonical_primary_artist,
      @canonical_track_key,
      @updated_at_utc
    )
    on conflict(canonical_title, canonical_primary_artist) do update set
      canonical_track_key = excluded.canonical_track_key,
      updated_at_utc = excluded.updated_at_utc
  `).run(row);
}

export function listCanonicalMap(db) {
  return dbQueries(db).prepare('listCanonicalMap', `
    select
      canonical_title,
      canonical_primary_artist,
      canonical_track_key,
      updated_at_utc
    from canonical_map
  `).all();
}

export function listTracks(db, { query = '', stationId, limit = 100, includeTrackKey } = {}) {
  const q = dbQueries(db);
  const numericLimit = Number(limit);
  const parsedLimit = Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.max(1, Math.min(numericLimit, 5000))
    : null;
  const run = (key, sql, params = []) => {
    if (parsedLimit == null) {
      return q.prepare(`${key}:nolimit`, sql).all(...params);
    }
    return q.prepare(`${key}:limit`, `${sql}\n      limit ?`).all(...params, parsedLimit);
  };

  const includeKey = String(includeTrackKey || '').trim();
  const withIncludedTrack = (rows) => {
    if (!includeKey || rows.some((row) => row.track_key === includeKey)) return rows;

    const where = ['p.track_key = ?'];
    const params = [includeKey];
    if (stationId) {
      where.push('p.station_id = ?');
      params.push(stationId);
    }

    const included = q.prepare(`listTracks:include:${stationId ? 'station' : 'all'}`, `
      select
        p.track_key,
        min(p.artist) as artist,
        min(p.title) as title,
        count(*) as total_plays,
        count(distinct substr(p.played_at_utc, 1, 10)) as active_days,
        round((count(*) * 1.0) / nullif(count(distinct substr(p.played_at_utc, 1, 10)), 0), 2) as plays_per_day,
        min(p.played_at_utc) as first_played_at_utc,
        max(p.played_at_utc) as last_played_at_utc,
        min(m.release_date_utc) as release_date_utc,
        min(m.verification_confidence) as verification_confidence,
        min(m.external_url) as external_url,
        min(m.preview_url) as preview_url
      from plays p
      left join track_metadata m on m.track_key = p.track_key
      where ${where.join(' and ')}
      group by p.track_key
    `).get(...params);

    if (!included) return rows;

    if (parsedLimit != null && rows.length >= parsedLimit) {
      return [included, ...rows.slice(0, Math.max(0, parsedLimit - 1))];
    }
    return [included, ...rows];
  };

  if (stationId && query) {
    return withIncludedTrack(run('listTracks:stationQuery', `
      select
        p.track_key,
        min(p.artist) as artist,
        min(p.title) as title,
        count(*) as total_plays,
        count(distinct substr(p.played_at_utc, 1, 10)) as active_days,
        round((count(*) * 1.0) / nullif(count(distinct substr(p.played_at_utc, 1, 10)), 0), 2) as plays_per_day,
        min(p.played_at_utc) as first_played_at_utc,
        max(p.played_at_utc) as last_played_at_utc,
        min(m.release_date_utc) as release_date_utc,
        min(m.verification_confidence) as verification_confidence,
        min(m.external_url) as external_url,
        min(m.preview_url) as preview_url
      from plays p
      left join track_metadata m on m.track_key = p.track_key
      where p.station_id = ?
        and (p.artist like ? or p.title like ?)
      group by p.track_key
      order by total_plays desc, artist asc, title asc
    `, [stationId, `%${query}%`, `%${query}%`]));
  }

  if (stationId) {
    return withIncludedTrack(run('listTracks:station', `
      select
        p.track_key,
        min(p.artist) as artist,
        min(p.title) as title,
        count(*) as total_plays,
        count(distinct substr(p.played_at_utc, 1, 10)) as active_days,
        round((count(*) * 1.0) / nullif(count(distinct substr(p.played_at_utc, 1, 10)), 0), 2) as plays_per_day,
        min(p.played_at_utc) as first_played_at_utc,
        max(p.played_at_utc) as last_played_at_utc,
        min(m.release_date_utc) as release_date_utc,
        min(m.verification_confidence) as verification_confidence,
        min(m.external_url) as external_url,
        min(m.preview_url) as preview_url
      from plays p
      left join track_metadata m on m.track_key = p.track_key
      where p.station_id = ?
      group by p.track_key
      order by total_plays desc, artist asc, title asc
    `, [stationId]));
  }

  if (query) {
    return withIncludedTrack(run('listTracks:query', `
      select
        p.track_key,
        min(p.artist) as artist,
        min(p.title) as title,
        count(*) as total_plays,
        count(distinct substr(p.played_at_utc, 1, 10)) as active_days,
        round((count(*) * 1.0) / nullif(count(distinct substr(p.played_at_utc, 1, 10)), 0), 2) as plays_per_day,
        min(p.played_at_utc) as first_played_at_utc,
        max(p.played_at_utc) as last_played_at_utc,
        min(m.release_date_utc) as release_date_utc,
        min(m.verification_confidence) as verification_confidence,
        min(m.external_url) as external_url,
        min(m.preview_url) as preview_url
      from plays p
      left join track_metadata m on m.track_key = p.track_key
      where p.artist like ? or p.title like ?
      group by p.track_key
      order by total_plays desc, artist asc, title asc
    `, [`%${query}%`, `%${query}%`]));
  }

  return withIncludedTrack(run('listTracks:all', `
    select
      p.track_key,
      min(p.artist) as artist,
      min(p.title) as title,
      count(*) as total_plays,
      count(distinct substr(p.played_at_utc, 1, 10)) as active_days,
      round((count(*) * 1.0) / nullif(count(distinct substr(p.played_at_utc, 1, 10)), 0), 2) as plays_per_day,
      min(p.played_at_utc) as first_played_at_utc,
      max(p.played_at_utc) as last_played_at_utc,
      min(m.release_date_utc) as release_date_utc,
      min(m.verification_confidence) as verification_confidence,
      min(m.external_url) as external_url,
      min(m.preview_url) as preview_url
    from plays p
    left join track_metadata m on m.track_key = p.track_key
    group by p.track_key
    order by total_plays desc, artist asc, title asc
  `));
}

export function listNewTitles(
  db,
  {
    startUtcIso,
    endUtcIso,
    referenceDateIso,
    stationId,
    query = '',
    minPlays = 1,
    limit = 250,
    requireReleaseDate = true,
    maxReleaseAgeDays = 730,
    minReleaseConfidence = 0.55
  } = {}
) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 250, 5000));
  const parsedMinPlays = Math.max(1, Math.min(Number(minPlays) || 1, 5000));
  const parsedRequireReleaseDate = Boolean(requireReleaseDate);
  const parsedMaxReleaseAgeDays = Number.isFinite(Number(maxReleaseAgeDays))
    ? Math.max(0, Math.min(Number(maxReleaseAgeDays), 36500))
    : 730;
  const parsedMinReleaseConfidence = Number.isFinite(Number(minReleaseConfidence))
    ? Math.max(0, Math.min(Number(minReleaseConfidence), 1))
    : 0.55;
  const refDateIso = String(referenceDateIso || '').trim() || null;
  const candidateLimit = Math.max(parsedLimit, Math.min(20000, parsedLimit * 6));
  const hasQuery = String(query || '').trim().length > 0;
  const sqlQuery = `%${String(query || '').trim()}%`;

  const whereParts = [];
  const params = [];

  if (stationId) {
    whereParts.push('p.station_id = ?');
    params.push(stationId);
  }
  if (hasQuery) {
    whereParts.push('(p.artist like ? or p.title like ?)');
    params.push(sqlQuery, sqlQuery);
  }

  const whereSql = whereParts.length ? `where ${whereParts.join(' and ')}` : '';

  const sql = `
    select
      p.track_key,
      min(p.artist) as artist,
      min(p.title) as title,
      min(p.played_at_utc) as first_played_at_utc,
      max(p.played_at_utc) as last_played_at_utc,
      count(*) as total_plays,
      count(distinct p.station_id) as station_count,
      group_concat(distinct s.name) as stations_csv,
      min(m.release_date_utc) as release_date_utc,
      min(m.verification_confidence) as release_confidence,
      min(m.external_url) as external_url,
      min(m.preview_url) as preview_url
    from plays p
    left join stations s on s.id = p.station_id
    left join track_metadata m on m.track_key = p.track_key
    ${whereSql}
    group by p.track_key
    having min(p.played_at_utc) >= ?
      and min(p.played_at_utc) < ?
      and count(*) >= ?
    order by min(p.played_at_utc) desc, count(*) desc, artist asc, title asc
    limit ?
  `;

  const stmtKey = `listNewTitles:${stationId ? 'station' : 'all'}:${hasQuery ? 'query' : 'noquery'}`;
  const rows = dbQueries(db).prepare(stmtKey, sql).all(...params, startUtcIso, endUtcIso, parsedMinPlays, candidateLimit);
  const referenceMs = refDateIso ? Date.parse(`${refDateIso}T12:00:00.000Z`) : Date.parse(endUtcIso);

  const filtered = rows.filter((row) => {
    const releaseIso = row?.release_date_utc ? String(row.release_date_utc) : '';
    const releaseMs = releaseIso ? Date.parse(releaseIso) : NaN;
    const hasRelease = Number.isFinite(releaseMs);
    const confidence = Number(row?.release_confidence);
    const hasConfidence = Number.isFinite(confidence);

    if (parsedRequireReleaseDate && !hasRelease) return false;
    if (parsedRequireReleaseDate && (!hasConfidence || confidence < parsedMinReleaseConfidence)) return false;

    if (hasRelease && Number.isFinite(referenceMs) && Number.isFinite(parsedMaxReleaseAgeDays)) {
      const ageDays = Math.max(0, Math.floor((referenceMs - releaseMs) / 86400000));
      if (ageDays > parsedMaxReleaseAgeDays) return false;
    }

    return true;
  });

  return filtered.slice(0, parsedLimit).map((row) => ({
    ...row,
    release_confidence: Number.isFinite(Number(row?.release_confidence)) ? Number(row.release_confidence) : null,
    stations: String(row.stations_csv || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }));
}

export function getTrackStationCounts(db, { trackKey, startUtcIso, endUtcIso }) {
  return dbQueries(db).prepare('getTrackStationCounts', `
    select
      p.station_id,
      min(s.name) as station_name,
      count(*) as plays
    from plays p
    left join stations s on s.id = p.station_id
    where p.track_key = ?
      and p.played_at_utc >= ?
      and p.played_at_utc < ?
    group by p.station_id
    order by plays desc, p.station_id asc
  `).all(trackKey, startUtcIso, endUtcIso);
}

export function getNewTracksInWeek(
  db,
  {
    startUtcIso,
    endUtcIso,
    prevStartUtcIso,
    prevEndUtcIso,
    stationId,
    limit = 50,
    maxReleaseAgeDays = 730,
    releaseYear
  }
) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedMaxReleaseAgeDays = Math.max(1, Math.min(Number(maxReleaseAgeDays) || 730, 3650));
  const parsedReleaseYear = Number.isFinite(Number(releaseYear))
    ? String(Math.floor(Number(releaseYear)))
    : null;

  if (stationId) {
    return dbQueries(db).prepare('getNewTracksInWeek:station', `
      with current_week as (
        select track_key, min(artist) as artist, min(title) as title, count(*) as plays
        from plays
        where station_id = ?
          and played_at_utc >= ?
          and played_at_utc < ?
        group by track_key
      ),
      previous_week as (
        select track_key
        from plays
        where station_id = ?
          and played_at_utc >= ?
          and played_at_utc < ?
        group by track_key
      )
      select c.track_key, c.artist, c.title, c.plays, m.release_date_utc
      from current_week c
      left join previous_week p on p.track_key = c.track_key
      left join track_metadata m on m.track_key = c.track_key
      where p.track_key is null
        and m.release_date_utc is not null
        and (
          (? is not null and substr(m.release_date_utc, 1, 4) = ?)
          or
          (? is null and date(m.release_date_utc) >= date(?, '-' || ? || ' days'))
        )
      order by c.plays desc, c.artist asc, c.title asc
      limit ?
    `).all(
      stationId,
      startUtcIso,
      endUtcIso,
      stationId,
      prevStartUtcIso,
      prevEndUtcIso,
      parsedReleaseYear,
      parsedReleaseYear,
      parsedReleaseYear,
      endUtcIso,
      parsedMaxReleaseAgeDays,
      parsedLimit
    );
  }

  return dbQueries(db).prepare('getNewTracksInWeek:all', `
    with current_week as (
      select track_key, min(artist) as artist, min(title) as title, count(*) as plays
      from plays
      where played_at_utc >= ?
        and played_at_utc < ?
      group by track_key
    ),
    previous_week as (
      select track_key
      from plays
      where played_at_utc >= ?
        and played_at_utc < ?
      group by track_key
    )
    select c.track_key, c.artist, c.title, c.plays, m.release_date_utc
    from current_week c
    left join previous_week p on p.track_key = c.track_key
    left join track_metadata m on m.track_key = c.track_key
    where p.track_key is null
      and m.release_date_utc is not null
      and (
        (? is not null and substr(m.release_date_utc, 1, 4) = ?)
        or
        (? is null and date(m.release_date_utc) >= date(?, '-' || ? || ' days'))
      )
    order by c.plays desc, c.artist asc, c.title asc
    limit ?
  `).all(
    startUtcIso,
    endUtcIso,
    prevStartUtcIso,
    prevEndUtcIso,
    parsedReleaseYear,
    parsedReleaseYear,
    parsedReleaseYear,
    endUtcIso,
    parsedMaxReleaseAgeDays,
    parsedLimit
  );
}

export function dedupeStationToOnePlayPerMinute(db, stationId) {
  const q = dbQueries(db);
  const before = q.prepare('dedupeStationToOnePlayPerMinute:before', 'select count(*) as c from plays where station_id = ?').get(stationId)?.c ?? 0;
  q.prepare('dedupeStationToOnePlayPerMinute:delete', `
    delete from plays
    where station_id = ?
      and id not in (
        select min(id)
        from plays
        where station_id = ?
        group by substr(played_at_utc, 1, 16)
      )
  `).run(stationId, stationId);
  const after = q.prepare('dedupeStationToOnePlayPerMinute:after', 'select count(*) as c from plays where station_id = ?').get(stationId)?.c ?? 0;
  return { before, after, removed: Math.max(0, before - after) };
}

export function dedupeStationByMinGapSeconds(db, stationId, minGapSeconds = 60) {
  const q = dbQueries(db);
  const safeGapSeconds = Math.max(1, Math.floor(Number(minGapSeconds) || 60));
  const before = q.prepare('dedupeStationByMinGapSeconds:before', 'select count(*) as c from plays where station_id = ?').get(stationId)?.c ?? 0;
  const rows = q.prepare('dedupeStationByMinGapSeconds:rows', `
    select id, played_at_utc
    from plays
    where station_id = ?
    order by played_at_utc asc, id asc
  `).all(stationId);

  const toDelete = [];
  let lastKeptAtMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const playedAtMs = Date.parse(row.played_at_utc);
    if (!Number.isFinite(playedAtMs)) continue;
    if (playedAtMs - lastKeptAtMs < safeGapSeconds * 1000) {
      toDelete.push(row.id);
      continue;
    }
    lastKeptAtMs = playedAtMs;
  }

  if (toDelete.length) {
    const delStmt = q.prepare('dedupeStationByMinGapSeconds:deleteById', 'delete from plays where id = ?');
    const tx = db.transaction((ids) => {
      for (const id of ids) delStmt.run(id);
    });
    tx(toDelete);
  }

  const after = q.prepare('dedupeStationByMinGapSeconds:after', 'select count(*) as c from plays where station_id = ?').get(stationId)?.c ?? 0;
  return { before, after, removed: Math.max(0, before - after), minGapSeconds: safeGapSeconds };
}

export function upsertBackpoolStationSummary(db, row) {
  dbQueries(db).prepare('upsertBackpoolStationSummary', `
    insert into backpool_station_summary(
      station_id,
      station_name,
      analysis_from_berlin,
      analysis_to_berlin,
      analyzed_at_utc,
      range_days,
      observed_coverage_days,
      observed_span_days,
      total_plays,
      total_tracks,
      tracks_with_release,
      unvalidated_release_count,
      rotation_min_daily_plays,
      rotation_max_daily_plays,
      rotation_min_active_days,
      rotation_min_span_days,
      rotation_backpool_track_count,
      rotation_backpool_plays,
      rotation_backpool_share,
      hot_rotation_track_count,
      sparse_rotation_track_count,
      release_backpool_track_count,
      release_backpool_plays,
      release_backpool_share
    ) values (
      @station_id,
      @station_name,
      @analysis_from_berlin,
      @analysis_to_berlin,
      @analyzed_at_utc,
      @range_days,
      @observed_coverage_days,
      @observed_span_days,
      @total_plays,
      @total_tracks,
      @tracks_with_release,
      @unvalidated_release_count,
      @rotation_min_daily_plays,
      @rotation_max_daily_plays,
      @rotation_min_active_days,
      @rotation_min_span_days,
      @rotation_backpool_track_count,
      @rotation_backpool_plays,
      @rotation_backpool_share,
      @hot_rotation_track_count,
      @sparse_rotation_track_count,
      @release_backpool_track_count,
      @release_backpool_plays,
      @release_backpool_share
    )
    on conflict(station_id) do update set
      station_name = excluded.station_name,
      analysis_from_berlin = excluded.analysis_from_berlin,
      analysis_to_berlin = excluded.analysis_to_berlin,
      analyzed_at_utc = excluded.analyzed_at_utc,
      range_days = excluded.range_days,
      observed_coverage_days = excluded.observed_coverage_days,
      observed_span_days = excluded.observed_span_days,
      total_plays = excluded.total_plays,
      total_tracks = excluded.total_tracks,
      tracks_with_release = excluded.tracks_with_release,
      unvalidated_release_count = excluded.unvalidated_release_count,
      rotation_min_daily_plays = excluded.rotation_min_daily_plays,
      rotation_max_daily_plays = excluded.rotation_max_daily_plays,
      rotation_min_active_days = excluded.rotation_min_active_days,
      rotation_min_span_days = excluded.rotation_min_span_days,
      rotation_backpool_track_count = excluded.rotation_backpool_track_count,
      rotation_backpool_plays = excluded.rotation_backpool_plays,
      rotation_backpool_share = excluded.rotation_backpool_share,
      hot_rotation_track_count = excluded.hot_rotation_track_count,
      sparse_rotation_track_count = excluded.sparse_rotation_track_count,
      release_backpool_track_count = excluded.release_backpool_track_count,
      release_backpool_plays = excluded.release_backpool_plays,
      release_backpool_share = excluded.release_backpool_share
  `).run(row);
}

export function clearBackpoolTrackCatalogForStation(db, stationId) {
  dbQueries(db).prepare('clearBackpoolTrackCatalogForStation', 'delete from backpool_track_catalog where station_id = ?').run(stationId);
}

export function upsertBackpoolTrackCatalogRow(db, row) {
  dbQueries(db).prepare('upsertBackpoolTrackCatalogRow', `
    insert into backpool_track_catalog(
      station_id,
      track_key,
      station_name,
      artist,
      title,
      classification,
      analysis_from_berlin,
      analysis_to_berlin,
      analyzed_at_utc,
      range_days,
      plays,
      plays_per_day,
      active_days,
      span_days,
      cadence_days,
      first_played_at_utc,
      last_played_at_utc,
      release_date_utc,
      verified_exists,
      verification_confidence,
      metadata_issue,
      is_rotation_backpool,
      is_release_backpool,
      is_low_rotation_release_backpool
    ) values (
      @station_id,
      @track_key,
      @station_name,
      @artist,
      @title,
      @classification,
      @analysis_from_berlin,
      @analysis_to_berlin,
      @analyzed_at_utc,
      @range_days,
      @plays,
      @plays_per_day,
      @active_days,
      @span_days,
      @cadence_days,
      @first_played_at_utc,
      @last_played_at_utc,
      @release_date_utc,
      @verified_exists,
      @verification_confidence,
      @metadata_issue,
      @is_rotation_backpool,
      @is_release_backpool,
      @is_low_rotation_release_backpool
    )
    on conflict(station_id, track_key) do update set
      station_name = excluded.station_name,
      artist = excluded.artist,
      title = excluded.title,
      classification = excluded.classification,
      analysis_from_berlin = excluded.analysis_from_berlin,
      analysis_to_berlin = excluded.analysis_to_berlin,
      analyzed_at_utc = excluded.analyzed_at_utc,
      range_days = excluded.range_days,
      plays = excluded.plays,
      plays_per_day = excluded.plays_per_day,
      active_days = excluded.active_days,
      span_days = excluded.span_days,
      cadence_days = excluded.cadence_days,
      first_played_at_utc = excluded.first_played_at_utc,
      last_played_at_utc = excluded.last_played_at_utc,
      release_date_utc = excluded.release_date_utc,
      verified_exists = excluded.verified_exists,
      verification_confidence = excluded.verification_confidence,
      metadata_issue = excluded.metadata_issue,
      is_rotation_backpool = excluded.is_rotation_backpool,
      is_release_backpool = excluded.is_release_backpool,
      is_low_rotation_release_backpool = excluded.is_low_rotation_release_backpool
  `).run(row);
}

export function listBackpoolTrackCatalog(db, { stationId, classification, limit = 500 } = {}) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));

  if (stationId && classification) {
    return dbQueries(db).prepare('listBackpoolTrackCatalog:stationAndClass', `
      select *
      from backpool_track_catalog
      where station_id = ?
        and classification = ?
      order by plays desc, artist asc, title asc
      limit ?
    `).all(stationId, classification, parsedLimit);
  }

  if (stationId) {
    return dbQueries(db).prepare('listBackpoolTrackCatalog:station', `
      select *
      from backpool_track_catalog
      where station_id = ?
      order by plays desc, artist asc, title asc
      limit ?
    `).all(stationId, parsedLimit);
  }

  if (classification) {
    return dbQueries(db).prepare('listBackpoolTrackCatalog:class', `
      select *
      from backpool_track_catalog
      where classification = ?
      order by plays desc, artist asc, title asc
      limit ?
    `).all(classification, parsedLimit);
  }

  return dbQueries(db).prepare('listBackpoolTrackCatalog:all', `
    select *
    from backpool_track_catalog
    order by plays desc, artist asc, title asc
    limit ?
  `).all(parsedLimit);
}

export function listBackpoolStationSummary(db, { stationId } = {}) {
  if (stationId) {
    return dbQueries(db).prepare('listBackpoolStationSummary:station', `
      select *
      from backpool_station_summary
      where station_id = ?
    `).get(stationId);
  }

  return dbQueries(db).prepare('listBackpoolStationSummary:all', `
    select *
    from backpool_station_summary
    order by station_name asc
  `).all();
}
