# BidAtlas source and data transfer

This package is an internal handoff of BidAtlas at source commit
`ee08c1d92923d494347dde9655e8fe344af4a585`.

## What is included

- All Git-tracked application source, documentation, migrations, tests, and package lockfile.
- A consistent local D1/SQLite snapshot under `.wrangler/state/v3/d1/`.
- The 2025 Census jurisdiction seed at `outputs/census-jurisdictions.sql`.
- The original city-list input and timestamped API snapshots under `data-export/`.
- A local `.env` containing the configuration values explicitly requested for this internal transfer.

The database contains 97,241 jurisdictions, 96,810 discovery-job scaffolds,
9 persisted projects, 9 research jobs, 134 research findings, 19 open research
gaps, and 15 source attempts. It contains no saved bids, bid submissions,
uploaded documents, document blobs, stored integration credentials, or R2 files.

`data-export/current-projects.json` captures 794 projects returned by the live
dashboard feed at `2026-07-21T20:08:53.525Z`. It is a reference snapshot. The
application continues to refresh live public sources when it runs, and this
snapshot is not a claim of complete nationwide coverage.

## Security

The included `.env` contains a real credential-encryption master key. Keep this
ZIP private, share it only with the intended recipient, never commit `.env`, and
rotate the key if the archive is ever exposed. Persisted research may contain
public-agency contact information and public-record person/address context.

## Install and run

1. Extract the `BidAtlas` folder.
2. Install Node.js 22.13 or newer.
3. Run `npm ci`.
4. Run `npm run build`.
5. Run `npm start`.
6. Open `http://localhost:3000/`.

The bundled local D1 database is already at the Miniflare path used on the
source machine. If the recipient's runtime creates a different hashed SQLite
filename, stop the app and replace that newly created non-`metadata.sqlite`
database with the bundled snapshot. Do not copy SQLite `-wal` or `-shm` files.
The included Census SQL supports rebuilding with `npm run db:local-bootstrap`
if a fresh database is preferred.

## Excluded reinstallable/generated content

`node_modules`, `dist`, `.vinext`, caches, logs, prior archives, and SQLite
WAL/SHM files are excluded. Dependencies are reproduced from `package-lock.json`.

