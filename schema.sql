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
  popularity_score real,
  chart_airplay_rank integer,
  chart_single_rank integer,
  social_viral_score real,
  payload_json text,
  last_checked_utc text not null
);
