create table if not exists stations(
  id text primary key,
  name text,
  url text,
  timezone text
);

create table if not exists plays(
  id integer primary key autoincrement,
  station_id text not null,
  played_at_utc text not null,
  artist_raw text not null,
  title_raw text not null,
  artist text not null,
  title text not null,
  track_key text not null,
  source_url text,
  ingested_at_utc text not null,
  unique(station_id, played_at_utc, artist_raw, title_raw),
  foreign key(station_id) references stations(id)
);

create index if not exists idx_plays_station_played_at on plays(station_id, played_at_utc);
create index if not exists idx_plays_track_key on plays(track_key);

create table if not exists daily_station_stats(
  date_berlin text not null,
  station_id text not null,
  total_plays integer not null,
  unique_tracks integer not null,
  primary key(date_berlin, station_id),
  foreign key(station_id) references stations(id)
);

create table if not exists daily_track_stats(
  date_berlin text not null,
  station_id text not null,
  track_key text not null,
  artist text not null,
  title text not null,
  plays integer not null,
  primary key(date_berlin, station_id, track_key),
  foreign key(station_id) references stations(id)
);

create table if not exists daily_overall_track_stats(
  date_berlin text not null,
  track_key text not null,
  artist text not null,
  title text not null,
  plays integer not null,
  primary key(date_berlin, track_key)
);

create table if not exists track_metadata(
  track_key text primary key,
  artist text not null,
  title text not null,
  verified_exists integer,
  verification_source text,
  verification_confidence real,
  external_track_id text,
  external_url text,
  artwork_url text,
  release_date_utc text,
  genre text,
  album text,
  label text,
  duration_ms integer,
  preview_url text,
  isrc text,
  spotify_track_id text,
  spotify_confidence real,
  canonical_source text,
  canonical_id text,
  popularity_score real,
  chart_airplay_rank integer,
  chart_single_rank integer,
  chart_country text,
  social_viral_score real,
  payload_json text,
  last_checked_utc text not null
);

create index if not exists idx_track_metadata_isrc on track_metadata(isrc);

create table if not exists backpool_station_summary(
  station_id text primary key,
  station_name text not null,
  analysis_from_berlin text not null,
  analysis_to_berlin text not null,
  analyzed_at_utc text not null,
  range_days integer not null,
  observed_coverage_days integer not null,
  observed_span_days integer not null,
  total_plays integer not null,
  total_tracks integer not null,
  tracks_with_release integer not null,
  unvalidated_release_count integer not null,
  rotation_min_daily_plays real not null,
  rotation_max_daily_plays real not null,
  rotation_min_active_days integer not null,
  rotation_min_span_days integer not null,
  rotation_backpool_track_count integer not null,
  rotation_backpool_plays integer not null,
  rotation_backpool_share real not null,
  hot_rotation_track_count integer not null,
  sparse_rotation_track_count integer not null,
  release_backpool_track_count integer not null,
  release_backpool_plays integer not null,
  release_backpool_share real not null,
  foreign key(station_id) references stations(id)
);

create table if not exists backpool_track_catalog(
  station_id text not null,
  track_key text not null,
  station_name text not null,
  artist text not null,
  title text not null,
  classification text not null,
  analysis_from_berlin text not null,
  analysis_to_berlin text not null,
  analyzed_at_utc text not null,
  range_days integer not null,
  plays integer not null,
  plays_per_day real not null,
  active_days integer not null,
  span_days integer not null,
  cadence_days real,
  first_played_at_utc text,
  last_played_at_utc text,
  release_date_utc text,
  verified_exists integer,
  verification_confidence real,
  metadata_issue text,
  is_rotation_backpool integer not null default 0,
  is_release_backpool integer not null default 0,
  is_low_rotation_release_backpool integer not null default 0,
  primary key(station_id, track_key),
  foreign key(station_id) references stations(id)
);

create index if not exists idx_backpool_track_class on backpool_track_catalog(classification);
create index if not exists idx_backpool_track_station_class on backpool_track_catalog(station_id, classification);

create table if not exists canonical_map(
  canonical_title text not null,
  canonical_primary_artist text not null,
  canonical_track_key text not null,
  updated_at_utc text not null,
  primary key(canonical_title, canonical_primary_artist)
);

create index if not exists idx_canonical_map_title_primary
  on canonical_map(canonical_title, canonical_primary_artist);
