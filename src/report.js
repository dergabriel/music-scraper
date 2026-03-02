import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.length ? rows.map((r) => `| ${r.join(' | ')} |`).join('\n') : '| - | - |';
  return `${head}\n${sep}\n${body}`;
}

function fmtTrack(t) {
  return `${t.artist} - ${t.title}`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function writeMarkdownReport({ weekStart, outputPath, stationAnalytics, crossAnalytics, dataQuality }) {
  const totalPlaysAll = stationAnalytics.reduce((sum, s) => sum + s.totalPlays, 0);
  const totalNew = stationAnalytics.reduce((sum, s) => sum + s.newTracks.length, 0);
  const totalDropped = stationAnalytics.reduce((sum, s) => sum + s.droppedTracks.length, 0);

  const topGainersGlobal = stationAnalytics
    .flatMap((s) => s.movers.topGainers.map((m) => ({ station: s.station.name, ...m })))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5);

  const lines = [];
  lines.push(`# Music Scraper, Woche ab ${weekStart}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push(`- Gesamt Plays (aktuelle Woche): **${totalPlaysAll}**`);
  lines.push(`- Neue Tracks: **${totalNew}**`);
  lines.push(`- Gedroppte Tracks: **${totalDropped}**`);
  lines.push(`- Neue Tracks in >=2 Sendern: **${crossAnalytics.newInMultipleStations.length}**`);
  lines.push('');
  lines.push('### Größte Movers (Top Gainers)');
  if (!topGainersGlobal.length) {
    lines.push('- Keine Veränderung gegenüber Vorwoche.');
  } else {
    for (const m of topGainersGlobal) {
      lines.push(`- ${m.station}: ${fmtTrack(m)} (Delta ${m.delta >= 0 ? '+' : ''}${m.delta})`);
    }
  }

  for (const s of stationAnalytics) {
    lines.push('');
    lines.push(`## ${s.station.name}`);
    lines.push(`- totalPlays: **${s.totalPlays}**`);
    lines.push(`- uniqueTracks: **${s.uniqueTracks}**`);
    lines.push('');

    lines.push('### Top 25');
    lines.push(
      mdTable(
        ['#', 'Track', 'Count', 'Track Key'],
        s.topTracks.map((t, i) => [String(i + 1), fmtTrack(t), String(t.count), t.track_key])
      )
    );

    lines.push('');
    lines.push('### Neu');
    if (!s.newTracks.length) {
      lines.push('- Keine neuen Tracks.');
    } else {
      for (const t of s.newTracks.slice(0, 50)) {
        lines.push(`- ${fmtTrack(t)} (${t.count})`);
      }
    }

    lines.push('');
    lines.push('### Dropped');
    if (!s.droppedTracks.length) {
      lines.push('- Keine gedroppten Tracks.');
    } else {
      for (const t of s.droppedTracks.slice(0, 50)) {
        lines.push(`- ${fmtTrack(t)} (${t.count})`);
      }
    }

    lines.push('');
    lines.push('### Movers');
    lines.push('#### Top Gainers');
    if (!s.movers.topGainers.length) {
      lines.push('- Keine.');
    } else {
      for (const m of s.movers.topGainers) {
        lines.push(`- ${fmtTrack(m)}: ${m.previousCount} -> ${m.count} (Delta +${m.delta})`);
      }
    }

    lines.push('');
    lines.push('#### Top Losers');
    if (!s.movers.topLosers.length) {
      lines.push('- Keine.');
    } else {
      for (const m of s.movers.topLosers) {
        lines.push(`- ${fmtTrack(m)}: ${m.previousCount} -> ${m.count} (Delta ${m.delta})`);
      }
    }
  }

  lines.push('');
  lines.push('## Cross Station Trends');
  lines.push('');
  lines.push('### Neu bei >=2 Sendern');
  if (!crossAnalytics.newInMultipleStations.length) {
    lines.push('- Keine Tracks in mehreren Sendern gleichzeitig neu.');
  } else {
    for (const t of crossAnalytics.newInMultipleStations) {
      lines.push(`- ${t.artist} - ${t.title} (${t.stationCount} Sender: ${t.stations.join(', ')})`);
    }
  }

  lines.push('');
  lines.push('### Overall Top 50');
  lines.push(
    mdTable(
      ['#', 'Track', 'Count', 'Track Key'],
      crossAnalytics.overallTopTracks.map((t, i) => [String(i + 1), fmtTrack(t), String(t.count), t.track_key])
    )
  );

  lines.push('');
  lines.push('## Data Quality');
  lines.push(`- Scrape Errors: **${dataQuality.scrapeErrors}**`);
  lines.push('- Anzahl Plays je Sender (aktuelle Woche):');
  for (const row of dataQuality.stationPlays) {
    lines.push(`  - ${row.stationName}: ${row.totalPlays}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return outputPath;
}

export function writeCsvExports({ csvDir, stationAnalytics, crossAnalytics }) {
  fs.mkdirSync(csvDir, { recursive: true });
  const files = [];

  for (const s of stationAnalytics) {
    const stationFile = path.join(csvDir, `${s.station.id}_top_tracks.csv`);
    const rows = [['rank', 'track_key', 'artist', 'title', 'count']];
    s.topTracks.forEach((t, idx) => rows.push([idx + 1, t.track_key, t.artist, t.title, t.count]));
    fs.writeFileSync(
      stationFile,
      rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n',
      'utf8'
    );
    files.push(stationFile);
  }

  const overallFile = path.join(csvDir, 'overall_top_50.csv');
  const overallRows = [['rank', 'track_key', 'artist', 'title', 'count']];
  crossAnalytics.overallTopTracks.forEach((t, idx) => {
    overallRows.push([idx + 1, t.track_key, t.artist, t.title, t.count]);
  });
  fs.writeFileSync(
    overallFile,
    overallRows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n',
    'utf8'
  );
  files.push(overallFile);
  return files;
}

export function writeStationMarkdownReport({ stationResult, weekStart, outputPath }) {
  const s = stationResult;
  const lines = [];
  lines.push(`# Music Scraper Station Report: ${s.station.name}, Woche ab ${weekStart}`);
  lines.push('');
  lines.push(`- totalPlays: **${s.totalPlays}**`);
  lines.push(`- uniqueTracks: **${s.uniqueTracks}**`);
  lines.push(`- newTracks: **${s.newTracks.length}**`);
  lines.push(`- droppedTracks: **${s.droppedTracks.length}**`);
  lines.push('');
  lines.push('## Top 25');
  lines.push(
    mdTable(
      ['#', 'Track', 'Count', 'Track Key'],
      s.topTracks.map((t, i) => [String(i + 1), `${t.artist} - ${t.title}`, String(t.count), t.track_key])
    )
  );
  lines.push('');
  lines.push('## Neu');
  if (!s.newTracks.length) lines.push('- Keine neuen Tracks.');
  else s.newTracks.slice(0, 100).forEach((t) => lines.push(`- ${t.artist} - ${t.title} (${t.count})`));
  lines.push('');
  lines.push('## Dropped');
  if (!s.droppedTracks.length) lines.push('- Keine gedroppten Tracks.');
  else s.droppedTracks.slice(0, 100).forEach((t) => lines.push(`- ${t.artist} - ${t.title} (${t.count})`));
  lines.push('');
  lines.push('## Movers');
  lines.push('### Top Gainers');
  if (!s.movers.topGainers.length) lines.push('- Keine.');
  else s.movers.topGainers.forEach((m) => lines.push(`- ${m.artist} - ${m.title}: ${m.previousCount} -> ${m.count} (Delta +${m.delta})`));
  lines.push('');
  lines.push('### Top Losers');
  if (!s.movers.topLosers.length) lines.push('- Keine.');
  else s.movers.topLosers.forEach((m) => lines.push(`- ${m.artist} - ${m.title}: ${m.previousCount} -> ${m.count} (Delta ${m.delta})`));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return outputPath;
}

export function gzipFile(filePath, { removeOriginal = false } = {}) {
  const input = fs.readFileSync(filePath);
  const gzPath = `${filePath}.gz`;
  const gz = zlib.gzipSync(input, { level: zlib.constants.Z_BEST_COMPRESSION });
  fs.writeFileSync(gzPath, gz);
  if (removeOriginal) fs.unlinkSync(filePath);
  return gzPath;
}
