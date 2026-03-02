import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, upsertStation, insertPlayIgnore, upsertTrackMetadata } from '../src/db.js';
import { normalizeArtistTitle } from '../src/normalize.js';

const tmpDirs = [];

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-cli-int-'));
  tmpDirs.push(dir);
  return dir;
}

function runCli(projectRoot, cwd, args) {
  const cliPath = path.resolve(projectRoot, 'src/cli.js');
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function toDataHtmlUrl(html) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

function addPlayDirect(db, { stationId, playedAtUtcIso, artistRaw, titleRaw }) {
  const normalized = normalizeArtistTitle(artistRaw, titleRaw);
  insertPlayIgnore(db, {
    station_id: stationId,
    played_at_utc: playedAtUtcIso,
    artist_raw: artistRaw,
    title_raw: titleRaw,
    artist: normalized.artist,
    title: normalized.title,
    track_key: normalized.trackKey,
    source_url: 'https://example.test',
    ingested_at_utc: '2026-02-23T10:00:00.000Z'
  });
  return normalized.trackKey;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI integration', () => {
  it(
    'runs ingest and report end-to-end and continues when one station fails',
    () => {
      const projectRoot = path.resolve('.');
      const tmp = mkTmpDir();
      const dbPath = path.join(tmp, 'integration.sqlite');
      const configPath = path.join(tmp, 'config.yaml');

      const dlfHtml = `
        <html><body>
          <li class="playlist-item" data-playlist-item>
            <time datetime="2026-02-17 10:10">10:10</time>
            <span class="artist">Moderat</span>
            <span class="title">Bad Kingdom</span>
          </li>
          <li class="playlist-item" data-playlist-item>
            <time datetime="2026-02-17 10:05">10:05</time>
            <span class="artist">Bonobo</span>
            <span class="title">Cirrus</span>
          </li>
        </body></html>
      `;

      const genericHtml = `
        <html><body>
          <table>
            <tr>
              <td class="time">2026-02-17 11:00</td>
              <td>Justice - D.A.N.C.E.</td>
            </tr>
            <tr>
              <td class="time">2026-02-17 10:55</td>
              <td>Daft Punk - One More Time</td>
            </tr>
          </table>
        </body></html>
      `;

      fs.writeFileSync(
        configPath,
        [
          'stations:',
          '  - id: "ok_dlf"',
          '    name: "OK DLF"',
          `    playlist_url: "${toDataHtmlUrl(dlfHtml)}"`,
          '    parser: "dlf_nova"',
          '    fetcher: "http"',
          '    timezone: "Europe/Berlin"',
          '',
          '  - id: "ok_generic"',
          '    name: "OK Generic"',
          `    playlist_url: "${toDataHtmlUrl(genericHtml)}"`,
          '    parser: "generic_html"',
          '    fetcher: "http"',
          '    timezone: "Europe/Berlin"',
          '',
          '  - id: "play_fail"',
          '    name: "Play Fail"',
          '    playlist_url: "http://127.0.0.1:9/unreachable"',
          '    parser: "generic_html"',
          '    fetcher: "playwright"',
          '    timezone: "Europe/Berlin"',
          ''
        ].join('\n'),
        'utf8'
      );

      const ingest = runCli(projectRoot, tmp, ['ingest', '--config', configPath, '--db', dbPath]);
      expect(ingest.status).toBe(0);

      const logOutput = `${ingest.stdout}\n${ingest.stderr}`;
      expect(logOutput).toContain('station ingest failed');
      expect(logOutput).toContain('play_fail');

      const db = new Database(dbPath, { readonly: true });
      const byStation = db
        .prepare('select station_id, count(*) as c from plays group by station_id order by station_id')
        .all();
      db.close();

      const counts = Object.fromEntries(byStation.map((r) => [r.station_id, r.c]));
      expect(counts.ok_dlf).toBe(2);
      expect(counts.ok_generic).toBe(2);
      expect(counts.play_fail ?? 0).toBe(0);

      const report = runCli(projectRoot, tmp, [
        'report',
        '--config',
        configPath,
        '--db',
        dbPath,
        '--week-start',
        '2026-02-16',
        '--csv'
      ]);
      expect(report.status).toBe(0);

      const mdPath = path.join(tmp, 'reports', '2026-02-16_weekly.md');
      const overallCsv = path.join(tmp, 'reports', 'csv', 'overall_top_50.csv');
      const stationCsv = path.join(tmp, 'reports', 'csv', 'ok_dlf_top_tracks.csv');

      expect(fs.existsSync(mdPath)).toBe(true);
      expect(fs.existsSync(overallCsv)).toBe(true);
      expect(fs.existsSync(stationCsv)).toBe(true);

      const md = fs.readFileSync(mdPath, 'utf8');
      expect(md).toContain('Music Scraper, Woche ab 2026-02-16');
      expect(md).toContain('## OK DLF');
      expect(md).toContain('## OK Generic');
    },
    30000
  );

  it('runs backpool analysis and writes station gold-title report', () => {
    const projectRoot = path.resolve('.');
    const tmp = mkTmpDir();
    const dbPath = path.join(tmp, 'integration.sqlite');
    const configPath = path.join(tmp, 'config.yaml');

    fs.writeFileSync(
      configPath,
      [
        'stations:',
        '  - id: "gold_station"',
        '    name: "Gold Station"',
        '    playlist_url: "https://example.test"',
        '    parser: "generic_html"',
        '    fetcher: "http"',
        '    timezone: "Europe/Berlin"',
        ''
      ].join('\n'),
      'utf8'
    );

    const db = openDb(dbPath);
    upsertStation(db, {
      id: 'gold_station',
      name: 'Gold Station',
      playlist_url: 'https://example.test',
      timezone: 'Europe/Berlin'
    });

    const oldTrackKey = addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-10T10:00:00.000Z',
      artistRaw: 'Coldplay',
      titleRaw: 'Viva La Vida'
    });
    addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-11T10:00:00.000Z',
      artistRaw: 'Coldplay',
      titleRaw: 'Viva La Vida'
    });
    addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-12T10:00:00.000Z',
      artistRaw: 'Coldplay',
      titleRaw: 'Viva La Vida'
    });

    const newTrackKey = addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-13T10:00:00.000Z',
      artistRaw: 'Dua Lipa',
      titleRaw: 'Houdini'
    });
    addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-14T10:00:00.000Z',
      artistRaw: 'Dua Lipa',
      titleRaw: 'Houdini'
    });
    addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-15T10:00:00.000Z',
      artistRaw: 'Dua Lipa',
      titleRaw: 'Houdini'
    });

    const lowConfidenceTrackKey = addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-16T10:00:00.000Z',
      artistRaw: 'Topic',
      titleRaw: 'Body'
    });
    addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-17T10:00:00.000Z',
      artistRaw: 'Topic',
      titleRaw: 'Body'
    });
    addPlayDirect(db, {
      stationId: 'gold_station',
      playedAtUtcIso: '2026-02-18T10:00:00.000Z',
      artistRaw: 'Topic',
      titleRaw: 'Body'
    });

    upsertTrackMetadata(db, {
      track_key: oldTrackKey,
      artist: 'coldplay',
      title: 'viva la vida',
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 1,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2008-05-25T00:00:00.000Z',
      genre: 'Pop',
      album: 'Viva La Vida',
      label: 'Parlophone',
      duration_ms: 242000,
      preview_url: null,
      isrc: null,
      popularity_score: 90,
      chart_airplay_rank: null,
      chart_single_rank: 3,
      chart_country: 'DE',
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-02-23T10:00:00.000Z'
    });
    upsertTrackMetadata(db, {
      track_key: newTrackKey,
      artist: 'dua lipa',
      title: 'houdini',
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 1,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2024-01-01T00:00:00.000Z',
      genre: 'Pop',
      album: 'Houdini',
      label: 'Warner',
      duration_ms: 210000,
      preview_url: null,
      isrc: null,
      popularity_score: 90,
      chart_airplay_rank: null,
      chart_single_rank: 4,
      chart_country: 'DE',
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-02-23T10:00:00.000Z'
    });
    upsertTrackMetadata(db, {
      track_key: lowConfidenceTrackKey,
      artist: 'topic',
      title: 'body',
      verified_exists: 1,
      verification_source: 'test',
      verification_confidence: 0.2,
      external_track_id: null,
      external_url: null,
      artwork_url: null,
      release_date_utc: '2020-07-30T00:00:00.000Z',
      genre: 'Pop',
      album: 'Body',
      label: 'Test',
      duration_ms: 180000,
      preview_url: null,
      isrc: null,
      popularity_score: 20,
      chart_airplay_rank: null,
      chart_single_rank: null,
      chart_country: 'DE',
      social_viral_score: null,
      payload_json: '{}',
      last_checked_utc: '2026-02-23T10:00:00.000Z'
    });
    db.close();

    const backpool = runCli(projectRoot, tmp, [
      'analyze-backpool',
      '--config',
      configPath,
      '--db',
      dbPath,
      '--from',
      '2026-02-01',
      '--to',
      '2026-02-28',
      '--years',
      '5',
      '--min-plays',
      '3',
      '--top',
      '10'
    ]);
    expect(backpool.status).toBe(0);

    const mdPath = path.join(tmp, 'reports', 'backpool', '2026-02-01_2026-02-28_backpool.md');
    expect(fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, 'utf8');
    expect(md).toContain('Gold Station');
    expect(md).toContain('coldplay - viva la vida');
    expect(md).not.toContain('dua lipa - houdini');
    expect(md).not.toContain('topic - body');
  });
});
