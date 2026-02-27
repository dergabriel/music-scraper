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

  return db;
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
      popularity_score,
      chart_airplay_rank,
      chart_single_rank,
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
      popularity_score,
      chart_airplay_rank,
      chart_single_rank,
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
      @popularity_score,
      @chart_airplay_rank,
      @chart_single_rank,
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
      popularity_score = excluded.popularity_score,
      chart_airplay_rank = excluded.chart_airplay_rank,
      chart_single_rank = excluded.chart_single_rank,
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

export function getNewTracksInWeek(db, { startUtcIso, endUtcIso, prevStartUtcIso, prevEndUtcIso, stationId, limit = 50 }) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

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
      select c.track_key, c.artist, c.title, c.plays
      from current_week c
      left join previous_week p on p.track_key = c.track_key
      where p.track_key is null
      order by c.plays desc, c.artist asc, c.title asc
      limit ?
    `).all(stationId, startUtcIso, endUtcIso, stationId, prevStartUtcIso, prevEndUtcIso, parsedLimit);
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
    select c.track_key, c.artist, c.title, c.plays
    from current_week c
    left join previous_week p on p.track_key = c.track_key
    where p.track_key is null
    order by c.plays desc, c.artist asc, c.title asc
    limit ?
  `).all(startUtcIso, endUtcIso, prevStartUtcIso, prevEndUtcIso, parsedLimit);
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
