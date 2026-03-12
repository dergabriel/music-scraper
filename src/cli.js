#!/usr/bin/env node
import { Command } from 'commander';
import pino from 'pino';
import { DateTime } from 'luxon';
import { BERLIN_TZ } from './time.js';
import {
  runIngest,
  runReport,
  runDailyEvaluation,
  runStationReport,
  runCoverageAudit,
  runBackpoolAnalysis,
  runCanonicalArtistMaintenance,
  runItunesCanonicalMaintenance,
  runMergeDuplicateTracksMaintenance,
  runCanonicalMapRefreshMaintenance,
  runTrackOrientationMaintenance,
  runNoisePlayCleanup,
  runPromoMarkerMaintenance,
  runReleaseDateBackfillMaintenance,
  runAllMaintenance
} from './services.js';
import { openDb, dedupeStationToOnePlayPerMinute, dedupeStationByMinGapSeconds } from './db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const program = new Command();
program.name('music-scraper').description('Music Scraper').version('1.0.0');

program
  .command('ingest')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .action((opts) => {
    runIngest({ configPath: opts.config, dbPath: opts.db, logger }).catch((err) => {
      logger.error({ err: err.message }, 'ingest failed');
      process.exitCode = 1;
    });
  });

program
  .command('report')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .requiredOption('--week-start <YYYY-MM-DD>', 'Week start date in Europe/Berlin')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--csv', 'Write CSV exports')
  .option('--gzip', 'Also write .gz compressed artifacts')
  .option('--gzip-only', 'Keep only .gz artifacts (remove plain .md/.csv)')
  .action((opts) => {
    try {
      runReport({
        configPath: opts.config,
        dbPath: opts.db,
        weekStart: opts.weekStart,
        csv: Boolean(opts.csv),
        gzip: Boolean(opts.gzip),
        gzipOnly: Boolean(opts.gzipOnly),
        logger
      });
    } catch (err) {
      logger.error({ err: err.message }, 'report failed');
      process.exitCode = 1;
    }
  });

program
  .command('report-station')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .requiredOption('--station-id <id>', 'Station id, e.g. dlf_nova')
  .requiredOption('--week-start <YYYY-MM-DD>', 'Week start date in Europe/Berlin')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--gzip', 'Also write .gz compressed artifact')
  .option('--gzip-only', 'Keep only .gz artifact (remove plain .md)')
  .action((opts) => {
    try {
      runStationReport({
        configPath: opts.config,
        dbPath: opts.db,
        stationId: opts.stationId,
        weekStart: opts.weekStart,
        gzip: Boolean(opts.gzip),
        gzipOnly: Boolean(opts.gzipOnly),
        logger
      });
    } catch (err) {
      logger.error({ err: err.message }, 'station report failed');
      process.exitCode = 1;
    }
  });

program
  .command('evaluate-daily')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--date <YYYY-MM-DD>', 'Berlin date to evaluate (default: today in Europe/Berlin)')
  .action((opts) => {
    try {
      runDailyEvaluation({ configPath: opts.config, dbPath: opts.db, date: opts.date, logger });
    } catch (err) {
      logger.error({ err: err.message }, 'daily evaluation failed');
      process.exitCode = 1;
    }
  });

program
  .command('audit-coverage')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--date <YYYY-MM-DD>', 'Berlin day to audit (default: yesterday in Europe/Berlin)')
  .action((opts) => {
    try {
      runCoverageAudit({ configPath: opts.config, dbPath: opts.db, date: opts.date, logger });
    } catch (err) {
      logger.error({ err: err.message }, 'coverage audit failed');
      process.exitCode = 1;
    }
  });

program
  .command('analyze-backpool')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--from <YYYY-MM-DD>', 'Start date in Europe/Berlin (default: 365 days ago)')
  .option('--to <YYYY-MM-DD>', 'End date in Europe/Berlin (default: today)')
  .option('--years <number>', 'Backpool threshold age in years', '5')
  .option('--min-plays <number>', 'Minimum plays per track in range', '1')
  .option('--rotation-min-daily-plays <number>', 'Minimum avg plays/day for rotation backpool', '0.35')
  .option('--min-confidence <number>', 'Minimum metadata confidence (0-1) for valid release dates', '0.72')
  .option('--low-rotation-max-daily-plays <number>', 'Max avg plays/day for low-rotation backpool list', '2')
  .option('--rotation-min-active-days <number>', 'Minimum active days in range for rotation backpool', '5')
  .option('--rotation-min-span-days <number>', 'Minimum first-to-last span days for rotation backpool', '28')
  .option('--rotation-min-release-age-days <number>', 'Minimum release age in days for rotation backpool', '1095')
  .option('--min-track-age-days <number>', 'Minimum age of a track in station history to count as backpool', '30')
  .option('--rotation-adaptive <0|1>', 'Adapt rotation thresholds to available station history (default: 1)', '1')
  .option('--hydrate-missing-release', 'Enrich missing release metadata during analysis')
  .option('--max-meta-lookups <number>', 'Max metadata lookups during enrichment', '120')
  .option('--top <number>', 'Top backpool tracks per station in report', '20')
  .action(async (opts) => {
    try {
      await runBackpoolAnalysis({
        configPath: opts.config,
        dbPath: opts.db,
        from: opts.from,
        to: opts.to,
        years: Number(opts.years),
        minTrackPlays: Number(opts.minPlays),
        rotationMinDailyPlays: Number(opts.rotationMinDailyPlays),
        minReleaseConfidence: Number(opts.minConfidence),
        lowRotationMaxDailyPlays: Number(opts.lowRotationMaxDailyPlays),
        rotationMinActiveDays: Number(opts.rotationMinActiveDays),
        rotationMinSpanDays: Number(opts.rotationMinSpanDays),
        rotationMinReleaseAgeDays: Number(opts.rotationMinReleaseAgeDays),
        minTrackAgeDays: Number(opts.minTrackAgeDays),
        rotationAdaptive: String(opts.rotationAdaptive ?? '1') !== '0',
        autoEnrichMissingRelease: Boolean(opts.hydrateMissingRelease),
        maxMetadataLookups: Number(opts.maxMetaLookups),
        top: Number(opts.top),
        logger
      });
    } catch (err) {
      logger.error({ err: err.message }, 'backpool analysis failed');
      process.exitCode = 1;
    }
  });

program
  .command('maintain-db')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--dry-run', 'Only report candidate merges, do not write changes')
  .option('--max-pairs <number>', 'Maximum swapped pairs to process in one run', '5000')
  .option('--min-score-gap <number>', 'Minimum score difference to merge a swapped pair', '0.35')
  .option('--min-play-ratio <number>', 'Minimum play-count ratio fallback for close scores', '1.2')
  .option('--release-max-lookups <number>', 'Maximum release metadata backfill lookups per run', '80')
  .option('--release-min-plays <number>', 'Minimum plays required for release metadata backfill candidates', '1')
  .option('--release-min-confidence <number>', 'Minimum release confidence target (0-1)', '0.55')
  .option('--release-stale-hours <number>', 'Minimum hours before a failed/missing metadata candidate is retried', '12')
  .action(async (opts) => {
    try {
      runNoisePlayCleanup({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        logger
      });
      runPromoMarkerMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      runItunesCanonicalMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      runCanonicalArtistMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      runMergeDuplicateTracksMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        logger
      });
      if (!Boolean(opts.dryRun)) {
        runCanonicalMapRefreshMaintenance({
          dbPath: opts.db,
          logger
        });
      }
      const result = runTrackOrientationMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxPairs: Number(opts.maxPairs),
        minScoreGap: Number(opts.minScoreGap),
        minPlayRatio: Number(opts.minPlayRatio),
        logger
      });
      await runReleaseDateBackfillMaintenance({
        dbPath: opts.db,
        dryRun: Boolean(opts.dryRun),
        maxLookups: Number(opts.releaseMaxLookups),
        minPlays: Number(opts.releaseMinPlays),
        minConfidence: Number(opts.releaseMinConfidence),
        staleHours: Number(opts.releaseStaleHours),
        includeChart: false,
        logger
      });
      logger.info(result, 'database maintenance finished');
    } catch (err) {
      logger.error({ err: err.message }, 'database maintenance failed');
      process.exitCode = 1;
    }
  });

program
  .command('daily-job')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--make-report', 'Also generate weekly report for current week')
  .option('--audit-coverage', 'Also run coverage audit for yesterday (Europe/Berlin)')
  .action(async (opts) => {
    runIngest({ configPath: opts.config, dbPath: opts.db, logger })
      .then(async () => {
        await runAllMaintenance({
          dbPath: opts.db,
          releaseMaxLookups: Number(process.env.YRPA_RELEASE_BACKFILL_DAILY_LOOKUPS || 180),
          logger
        });
        const berlinYesterday = DateTime.now().setZone(BERLIN_TZ).minus({ days: 1 }).toISODate();
        runDailyEvaluation({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinYesterday,
          logger
        });

        await runBackpoolAnalysis({
          configPath: opts.config,
          dbPath: opts.db,
          writeReport: false,
          autoEnrichMissingRelease: false,
          persistToDb: true,
          logger
        });

        if (opts.auditCoverage) {
          runCoverageAudit({
            configPath: opts.config,
            dbPath: opts.db,
            date: berlinYesterday,
            logger
          });
        }

        if (opts.makeReport) {
          const weekStart = DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
          runReport({ configPath: opts.config, dbPath: opts.db, weekStart, csv: true, logger });
        }
      })
      .catch((err) => {
        logger.error({ err: err.message }, 'daily job failed');
        process.exitCode = 1;
      });
  });

program
  .command('cleanup-station')
  .requiredOption('--station-id <id>', 'Station id, e.g. dlf_nova')
  .option('--db <path>', 'Path to SQLite database', 'music-scraper.sqlite')
  .option('--min-gap-seconds <number>', 'Minimum seconds between two counted plays', '60')
  .option('--one-per-minute', 'Legacy mode: keep only one play per minute')
  .action((opts) => {
    try {
      const db = openDb(opts.db);
      const result = opts.onePerMinute
        ? dedupeStationToOnePlayPerMinute(db, opts.stationId)
        : dedupeStationByMinGapSeconds(db, opts.stationId, Number(opts.minGapSeconds));
      db.close();
      logger.info({ stationId: opts.stationId, ...result }, 'station cleanup finished');
    } catch (err) {
      logger.error({ err: err.message }, 'station cleanup failed');
      process.exitCode = 1;
    }
  });

program
  .command('api')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
  .option('--port <number>', 'API port', '8787')
  .option('--no-startup-report', 'Skip automatic ingest + evaluation + weekly report at API startup')
  .action(async (opts) => {
    try {
      if (opts.startupReport) {
        logger.info('running startup ingest/evaluation/report before API boot');
        await runIngest({ configPath: opts.config, dbPath: opts.db, logger });
        await runAllMaintenance({
          dbPath: opts.db,
          releaseMaxLookups: Number(process.env.YRPA_RELEASE_BACKFILL_STARTUP_LOOKUPS || 260),
          logger
        });
        const berlinYesterday = DateTime.now().setZone(BERLIN_TZ).minus({ days: 1 }).toISODate();
        runDailyEvaluation({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinYesterday,
          logger
        });
        runCoverageAudit({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinYesterday,
          logger
        });
        await runBackpoolAnalysis({
          configPath: opts.config,
          dbPath: opts.db,
          writeReport: false,
          autoEnrichMissingRelease: false,
          persistToDb: true,
          logger
        });
        const weekStart = DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
        runReport({ configPath: opts.config, dbPath: opts.db, weekStart, csv: true, logger });
      }

      const { startApiServer } = await import('./api.js');
      await startApiServer({
        configPath: opts.config,
        dbPath: opts.db,
        port: Number(opts.port)
      });
    } catch (err) {
      logger.error({ err: err.message }, 'api failed');
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
