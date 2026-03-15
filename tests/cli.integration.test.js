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

  it('ingest keeps only plays between 06:00 and 20:59 local station time', () => {
    const projectRoot = path.resolve('.');
    const tmp = mkTmpDir();
    const dbPath = path.join(tmp, 'integration.sqlite');
    const configPath = path.join(tmp, 'config.yaml');

    const html = `
      <html><body>
        <table>
          <tr><td>2026-02-17 05:59</td><td>Artist A</td><td>Song Before</td></tr>
          <tr><td>2026-02-17 06:00</td><td>Artist B</td><td>Song Start</td></tr>
          <tr><td>2026-02-17 20:59</td><td>Artist C</td><td>Song End</td></tr>
          <tr><td>2026-02-17 21:00</td><td>Artist D</td><td>Song After</td></tr>
        </table>
      </body></html>
    `;

    fs.writeFileSync(
      configPath,
      [
        'stations:',
        '  - id: "hour_window_station"',
        '    name: "Hour Window Station"',
        `    playlist_url: "${toDataHtmlUrl(html)}"`,
        '    parser: "generic_html"',
        '    fetcher: "http"',
        '    timezone: "Europe/Berlin"',
        ''
      ].join('\n'),
      'utf8'
    );

    const ingest = runCli(projectRoot, tmp, ['ingest', '--config', configPath, '--db', dbPath]);
    expect(ingest.status).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('select artist_raw, title_raw, played_at_utc from plays order by played_at_utc asc')
      .all();
    db.close();

    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.title_raw)).toEqual(['Song Start', 'Song End']);
  });

});
