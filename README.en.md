# Music Scraper

Tool for automated radio playlist ingestion, normalization, and analysis.

With Music Scraper you can:

- ingest playlists from multiple stations on a schedule
- analyze rotations, new tracks, and backpool behavior
- inspect results via web dashboard and API
- automate daily reports and quality checks

## Quick Start

```bash
npm install
node src/cli.js api --config config.yaml --port 8787
```

Open in browser:

- `http://localhost:8787/dashboard`
- `http://localhost:8787/backpool`
- `http://localhost:8787/new-titles`
- `http://localhost:8787/api/docs`

## Core Features

- station-specific ingest (parser + fallback URL support)
- daily/weekly evaluation workflows
- backpool analysis with release/rotation rules
- track metadata (cover, release, genre, chart info)
- DB maintenance (`maintain-db`) for noise/jingle/duplicate cleanup

## Common Commands

```bash
# ingest playlist data
node src/cli.js ingest --config config.yaml --db music-scraper.sqlite

# run API + dashboard
node src/cli.js api --config config.yaml --db music-scraper.sqlite --port 8787

# daily job (ingest + eval + optional report/audit)
node src/cli.js daily-job --config config.yaml --db music-scraper.sqlite --make-report --audit-coverage

# run backpool analysis
node src/cli.js analyze-backpool --config config.yaml --db music-scraper.sqlite

# maintenance cleanup
node src/cli.js maintain-db --db music-scraper.sqlite
```

## Documentation

- Setup guide: [docs/setup.md](docs/setup.md)
- API docs endpoint: `GET /api/docs`

## Privacy & Safe Publishing

Before pushing to GitHub:

- do not commit local databases (`*.sqlite`, `*.db`, `data/` are ignored)
- do not store tokens/secrets in files (`.env*` is ignored)
- avoid committing sensitive reports (`reports/` is ignored)

If a token has already been exposed, revoke/rotate it immediately.
