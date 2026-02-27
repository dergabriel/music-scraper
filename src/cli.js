#!/usr/bin/env node
import { Command } from 'commander';
import pino from 'pino';
import { DateTime } from 'luxon';
import { BERLIN_TZ } from './time.js';
import { runIngest, runReport, runDailyEvaluation, runStationReport, runCoverageAudit } from './services.js';
import { openDb, dedupeStationToOnePlayPerMinute } from './db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const program = new Command();
program.name('yrpa').description('JUKA Radio Playlist Analyzer').version('1.0.0');

program
  .command('ingest')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
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
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
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
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
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
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
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
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
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
  .command('daily-job')
  .requiredOption('--config <path>', 'Path to config.yaml')
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
  .option('--make-report', 'Also generate weekly report for current week')
  .option('--audit-coverage', 'Also run day coverage audit')
  .action((opts) => {
    runIngest({ configPath: opts.config, dbPath: opts.db, logger })
      .then(() => {
        const berlinToday = DateTime.now().setZone(BERLIN_TZ).toISODate();
        runDailyEvaluation({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinToday,
          logger
        });

        if (opts.auditCoverage) {
          runCoverageAudit({
            configPath: opts.config,
            dbPath: opts.db,
            date: berlinToday,
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
  .option('--db <path>', 'Path to SQLite database', 'yrpa.sqlite')
  .action((opts) => {
    try {
      const db = openDb(opts.db);
      const result = dedupeStationToOnePlayPerMinute(db, opts.stationId);
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
  .option('--schedule-daily', 'Run ingest + daily evaluation automatically at 23:00 Europe/Berlin')
  .option('--daily-hour <number>', 'Berlin hour for scheduled daily run', '23')
  .action(async (opts) => {
    try {
      if (opts.startupReport) {
        logger.info('running startup ingest/evaluation/report before API boot');
        await runIngest({ configPath: opts.config, dbPath: opts.db, logger });
        const berlinToday = DateTime.now().setZone(BERLIN_TZ).toISODate();
        runDailyEvaluation({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinToday,
          logger
        });
        runCoverageAudit({
          configPath: opts.config,
          dbPath: opts.db,
          date: berlinToday,
          logger
        });
        const weekStart = DateTime.now().setZone(BERLIN_TZ).startOf('week').toISODate();
        runReport({ configPath: opts.config, dbPath: opts.db, weekStart, csv: true, logger });
      }

      const { startApiServer } = await import('./api.js');
      await startApiServer({
        configPath: opts.config,
        dbPath: opts.db,
        port: Number(opts.port),
        scheduleDaily: Boolean(opts.scheduleDaily),
        dailyHour: Number(opts.dailyHour)
      });
    } catch (err) {
      logger.error({ err: err.message }, 'api failed');
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
