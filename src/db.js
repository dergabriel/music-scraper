import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    chart_country: 'text'
  };

  for (const [name, type] of Object.entries(required)) {
    if (!existing.has(name)) {
      db.exec(`alter table track_metadata add column ${name} ${type}`);
    }
  }
}

export function upsertStation(db, station) {
  const stmt = db.prepare(`
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
  const stmt = db.prepare(`
    insert or ignore into plays(
      station_id,
      played_at_utc,
      artist_raw,
      title_raw,
      artist,
      title,
      track_key,
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
      @source_url,
      @ingested_at_utc
    )
  `);
  return stmt.run(row).changes;
}

export function getStationTrackCounts(db, stationId, startUtcIso, endUtcIso) {
  const stmt = db.prepare(`
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
  const stmt = db.prepare(`
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
  const stmt = db.prepare(`
    select count(*) as total
    from plays
    where station_id = ?
      and played_at_utc >= ?
      and played_at_utc < ?
  `);
  return stmt.get(stationId, startUtcIso, endUtcIso)?.total ?? 0;
}

export function getStationPlayedAtUtc(db, stationId, startUtcIso, endUtcIso) {
  return db.prepare(`
    select played_at_utc
    from plays
    where station_id = ?
      and played_at_utc >= ?
      and played_at_utc < ?
    order by played_at_utc asc
  `).all(stationId, startUtcIso, endUtcIso);
}

export function getOverallTrackCounts(db, startUtcIso, endUtcIso) {
  const stmt = db.prepare(`
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
  db.prepare('delete from daily_station_stats where date_berlin = ?').run(dateBerlin);
  db.prepare('delete from daily_track_stats where date_berlin = ?').run(dateBerlin);
  db.prepare('delete from daily_overall_track_stats where date_berlin = ?').run(dateBerlin);
}

export function upsertDailyStationStat(db, row) {
  db.prepare(`
    insert into daily_station_stats(date_berlin, station_id, total_plays, unique_tracks)
    values (@date_berlin, @station_id, @total_plays, @unique_tracks)
    on conflict(date_berlin, station_id) do update set
      total_plays = excluded.total_plays,
      unique_tracks = excluded.unique_tracks
  `).run(row);
}

export function upsertDailyTrackStat(db, row) {
  db.prepare(`
    insert into daily_track_stats(date_berlin, station_id, track_key, artist, title, plays)
    values (@date_berlin, @station_id, @track_key, @artist, @title, @plays)
    on conflict(date_berlin, station_id, track_key) do update set
      artist = excluded.artist,
      title = excluded.title,
      plays = excluded.plays
  `).run(row);
}

export function upsertDailyOverallTrackStat(db, row) {
  db.prepare(`
    insert into daily_overall_track_stats(date_berlin, track_key, artist, title, plays)
    values (@date_berlin, @track_key, @artist, @title, @plays)
    on conflict(date_berlin, track_key) do update set
      artist = excluded.artist,
      title = excluded.title,
      plays = excluded.plays
  `).run(row);
}

export function listStations(db) {
  return db.prepare('select id, name, url, timezone from stations order by name asc').all();
}

export function searchTracks(db, query, limit = 30) {
  return db.prepare(`
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
  if (stationId) {
    return db.prepare(`
      select station_id, played_at_utc
      from plays
      where track_key = ?
        and station_id = ?
        and played_at_utc >= ?
        and played_at_utc < ?
      order by played_at_utc asc
    `).all(trackKey, stationId, startUtcIso, endUtcIso);
  }

  return db.prepare(`
    select station_id, played_at_utc
    from plays
    where track_key = ?
      and played_at_utc >= ?
      and played_at_utc < ?
    order by played_at_utc asc
  `).all(trackKey, startUtcIso, endUtcIso);
}

export function getTrackIdentity(db, trackKey) {
  return db.prepare(`
    select min(artist) as artist, min(title) as title
    from plays
    where track_key = ?
  `).get(trackKey);
}

export function getTrackMetadata(db, trackKey) {
  return db.prepare(`
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
  db.prepare(`
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
      popularity_score = excluded.popularity_score,
      chart_airplay_rank = excluded.chart_airplay_rank,
      chart_single_rank = excluded.chart_single_rank,
      chart_country = excluded.chart_country,
      social_viral_score = excluded.social_viral_score,
      payload_json = excluded.payload_json,
      last_checked_utc = excluded.last_checked_utc
  `).run(row);
}

export function listTracks(db, { query = '', stationId, limit = 100 } = {}) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));

  if (stationId && query) {
    return db.prepare(`
      select
        track_key,
        min(artist) as artist,
        min(title) as title,
        count(*) as total_plays,
        min(played_at_utc) as first_played_at_utc,
        max(played_at_utc) as last_played_at_utc
      from plays
      where station_id = ?
        and (artist like ? or title like ?)
      group by track_key
      order by total_plays desc, artist asc, title asc
      limit ?
    `).all(stationId, `%${query}%`, `%${query}%`, parsedLimit);
  }

  if (stationId) {
    return db.prepare(`
      select
        track_key,
        min(artist) as artist,
        min(title) as title,
        count(*) as total_plays,
        min(played_at_utc) as first_played_at_utc,
        max(played_at_utc) as last_played_at_utc
      from plays
      where station_id = ?
      group by track_key
      order by total_plays desc, artist asc, title asc
      limit ?
    `).all(stationId, parsedLimit);
  }

  if (query) {
    return db.prepare(`
      select
        track_key,
        min(artist) as artist,
        min(title) as title,
        count(*) as total_plays,
        min(played_at_utc) as first_played_at_utc,
        max(played_at_utc) as last_played_at_utc
      from plays
      where artist like ? or title like ?
      group by track_key
      order by total_plays desc, artist asc, title asc
      limit ?
    `).all(`%${query}%`, `%${query}%`, parsedLimit);
  }

  return db.prepare(`
    select
      track_key,
      min(artist) as artist,
      min(title) as title,
      count(*) as total_plays,
      min(played_at_utc) as first_played_at_utc,
      max(played_at_utc) as last_played_at_utc
    from plays
    group by track_key
    order by total_plays desc, artist asc, title asc
    limit ?
  `).all(parsedLimit);
}

export function getTrackStationCounts(db, { trackKey, startUtcIso, endUtcIso }) {
  return db.prepare(`
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
    maxReleaseAgeDays = 730
  }
) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedMaxReleaseAgeDays = Math.max(1, Math.min(Number(maxReleaseAgeDays) || 730, 3650));

  if (stationId) {
    return db.prepare(`
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
        and date(m.release_date_utc) >= date(?, '-' || ? || ' days')
      order by c.plays desc, c.artist asc, c.title asc
      limit ?
    `).all(
      stationId,
      startUtcIso,
      endUtcIso,
      stationId,
      prevStartUtcIso,
      prevEndUtcIso,
      endUtcIso,
      parsedMaxReleaseAgeDays,
      parsedLimit
    );
  }

  return db.prepare(`
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
      and date(m.release_date_utc) >= date(?, '-' || ? || ' days')
    order by c.plays desc, c.artist asc, c.title asc
    limit ?
  `).all(startUtcIso, endUtcIso, prevStartUtcIso, prevEndUtcIso, endUtcIso, parsedMaxReleaseAgeDays, parsedLimit);
}

export function dedupeStationToOnePlayPerMinute(db, stationId) {
  const before = db.prepare('select count(*) as c from plays where station_id = ?').get(stationId)?.c ?? 0;
  db.prepare(`
    delete from plays
    where station_id = ?
      and id not in (
        select min(id)
        from plays
        where station_id = ?
        group by substr(played_at_utc, 1, 16)
      )
  `).run(stationId, stationId);
  const after = db.prepare('select count(*) as c from plays where station_id = ?').get(stationId)?.c ?? 0;
  return { before, after, removed: Math.max(0, before - after) };
}

export function upsertBackpoolStationSummary(db, row) {
  db.prepare(`
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
  db.prepare('delete from backpool_track_catalog where station_id = ?').run(stationId);
}

export function upsertBackpoolTrackCatalogRow(db, row) {
  db.prepare(`
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
    return db.prepare(`
      select *
      from backpool_track_catalog
      where station_id = ?
        and classification = ?
      order by plays desc, artist asc, title asc
      limit ?
    `).all(stationId, classification, parsedLimit);
  }

  if (stationId) {
    return db.prepare(`
      select *
      from backpool_track_catalog
      where station_id = ?
      order by plays desc, artist asc, title asc
      limit ?
    `).all(stationId, parsedLimit);
  }

  if (classification) {
    return db.prepare(`
      select *
      from backpool_track_catalog
      where classification = ?
      order by plays desc, artist asc, title asc
      limit ?
    `).all(classification, parsedLimit);
  }

  return db.prepare(`
    select *
    from backpool_track_catalog
    order by plays desc, artist asc, title asc
    limit ?
  `).all(parsedLimit);
}

export function listBackpoolStationSummary(db, { stationId } = {}) {
  if (stationId) {
    return db.prepare(`
      select *
      from backpool_station_summary
      where station_id = ?
    `).get(stationId);
  }

  return db.prepare(`
    select *
    from backpool_station_summary
    order by station_name asc
  `).all();
}
