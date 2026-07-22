# BidAtlas

BidAtlas is a public-record construction intelligence system. It follows private residential, private commercial, and public projects from planning and design through permitting, bidding, bid opening, and award while retaining the official source for every record and document.

The dashboard is deliberately explicit: loaded counts are **not U.S. totals**. The authoritative 2025 Census baseline is 97,241 registry rows (91,438 independent local governments plus 5,803 dependent school-system/agency rows), and each applicable jurisdiction/source-class/lifecycle cell must be connected and current before national completeness can be claimed.

## Implemented now

- Twenty base project adapters: Federal Permitting, USAspending construction awards, Caltrans advertised projects, SAM.gov (free API key required), Seattle building permits, Seattle/San Jose Legistar matters, New York City DOB filings, approved permits, and City Record procurement, New Jersey construction-permit activity, Los Angeles submitted building permits, Chicago building permits, Austin construction permits, San Francisco building permits, Tempe ArcGIS permits, Pittsburgh CKAN permits, Boston approved building permits, Miami iBuild plan-review permits, and Philadelphia L&I building, zoning, and trade-permit rows through Carto.
- Publicly filed private-work coverage in the configured permit jurisdictions. Los Angeles, Boston, Miami, Philadelphia, New York City, Chicago, Austin, San Francisco, Seattle, Tempe, and Pittsburgh records can expose residential and commercial scope, use, address, value, lifecycle, or named participants when those literal fields are published. NYC approved-permit rows contribute a general contractor only when DOB explicitly publishes the permittee license type as `GC`; person-only owner and applicant names are suppressed. New Jersey's statewide activity feed is discovery-only because it omits address, work description, owner, and contractor fields, so the application links the user to the issuing municipal construction office instead of inferring those identities. A permit record is not evidence that plan sheets, CAD, homeowner details, or a bid opportunity are public.
- A 51-state/DC source registry with 102 official statewide procurement and DOT letting roots.
- An authenticated local-market Source Monitor for public procurement feeds, contractor/owner planrooms, and builders exchanges. It accepts bounded public HTTPS RSS, Atom, JSON Feed, and HTML listing sources; validates public DNS before every fetch and redirect; normalizes at most 100 postings per scan; and keeps incomplete records in a private review queue. A posting reaches the canonical Open bids index only when it has bid language, a current deadline, a location, an original source URL, and a plans/specifications route. Verified records retain publisher, contact, document, review, and source evidence, while rejected or expired records are removed from the actionable queue. Active monitors refresh from the scheduled Worker with bounded exponential retry.
- A network-free portal classifier for Socrata, ArcGIS, CKAN, Carto, OpenGov, Bonfire, PlanetBids, BidNet, IonWave, DemandStar, Public Purchase, HTML, manual, and unknown roots. It records confidence and evidence, rejects credential-bearing URLs, and persists review-only discovery candidates as explicitly `unverified`, `not-connected`, and network-disabled. Automated rediscovery cannot overwrite a prior human review.
- Product and location search with comma-separated phrases plus all/any/exact matching. Conservative source-field normalization makes categories such as `Dwelling - Single Family`, `1-2FAM`, ADU, `Comm`, retail, and warehouse discoverable through residential/commercial searches without treating agency/contact wording as a building classification. `/projects` defaults to dated new/current records; stale, completed, cancelled, and undated records remain available through explicit freshness filters.
- Explicit lifecycle-stage filtering across planning, design/plan review, permitting, bidding, bid-opened, awarded, completed/closed, cancelled/inactive, and unclassified source records.
- Explicit metadata-only versus extracted-document-text search coverage. A no-match never claims that a product is absent from unindexed plans.
- D1 persistence for sources, projects, provenance, participants, document versions/extractions/chunks, per-source coverage evidence plus aggregate coverage cells, dataset candidates, ingestion runs, supplier profiles, and portal-registration tasks.
- D1 FTS5 indexes for project metadata and page-aware document chunks.
- A protected project-document pipeline for plans, specifications, addenda, drawings, CAD, bid forms, schedules, and reports. D1 stores provenance, rights, versions, hashes, processing state, and searchable metadata while R2 stores content-addressed bytes. HTTPS imports use bounded redirects, a whole-operation timeout, and fail-closed public-DNS checks; uploads require a bounded declared length before multipart buffering. Private files are owner-only, workspace files are shared only inside the authenticated workspace, R2 keys never leave the server, and anonymous download requires every public-license, redistribution, storage, and security gate. SHA-256 deduplication, internal-service-only extraction handoff, and metadata/extracted-text search are implemented. Automated OCR and native-CAD conversion remain separate sandboxed workers.
- A conservative plan/spec contact parser is ready for page-aware extracted text. It accepts only explicit owner, architect, engineer, contractor, or agency labels and retains the exact page snippet plus document-version/extraction/chunk provenance. It does not promote plan holders, applicants, developers, or unlabeled names into project roles. The capability remains queued and persistence-disabled until a real document retrieval/extraction service populates `document_extractions` and `document_chunks`.
- A scheduled Worker handler and protected `POST /api/internal/ingest` endpoint. Each run selects one configured project source, requests one bounded upstream page, and persists that source's next cursor only after the page has been fully materialized. Incremental scheduling separates historical backfill from refresh work. High-volume Seattle, Socrata, ArcGIS, CKAN, and Carto permit adapters seed a durable source-native refresh watermark from their newest official row, then query strictly forward from that sort-value/identity pair; tied timestamps page without gaps and an empty delta keeps the watermark. The refresh source still rotates after every page, while older adapter families retain independent continuations. The Worker configuration declares a five-minute trigger for the current 31-project-source queue (including official state DOT bid feeds for Washington, Illinois, Texas, New York, North Carolina, Iowa, statewide Florida, Virginia, Michigan, Ohio, and Pennsylvania), but this configured queue is not complete nationwide coverage, and production scheduling must also be enabled by the hosting control plane.
- Source-native upstream paging for the pageable adapters: immutable ID keysets for Federal Permitting, full-history Seattle permits, eight configured Socrata feeds, and five ArcGIS/CKAN/Carto feeds; a frozen Legistar scan window plus `$skip`; USAspending `hasNext` plus `last_record` watermarks; and SAM page-index cursors over a frozen date window. D1-budget pauses retain the current project and its stable document list plus project/document offsets inside the current page, so the next run never applies an attachment offset to another record.
- A public Tudelu supplier profile prefilled from the company website. Passwords, tax IDs, banking data, signatures, and verification codes are not stored in the project database.
- An official Census workbook importer that maps 91,438 independent local governments plus 5,803 dependent school/agency rows (97,241 registry rows total) into D1.
- A supplemental 19,482-row Vintage 2025 incorporated-place seed manifest for city-name discovery when the D1 registry is unavailable. It is not the jurisdiction denominator and is never counted as a connection.
- One resumable jurisdiction-discovery job per active authoritative registry jurisdiction, with bounded leases, cursors, retries, and candidate provenance. Lease fairness finishes active source-class/page scans before untouched jobs and defers completed weekly rechecks until after untouched work; population priority and due time break ties inside those tiers. It uses the keyed GSA Data.gov v4 search when configured and the official public Data.gov catalog search endpoint as a no-key fallback, so a missing key no longer stops the queue. A completed catalog scan creates review candidates only; it does not mark a source connected. The current three-job batch is a conservative correctness scaffold, not a nationwide-speed rollout; production discovery must deduplicate work by publisher/portal/source family before daily national freshness is attainable.
- Durable candidate-to-Census-jurisdiction links plus conservative exact city/county matching for ingested projects. Only unambiguous matches update per-jurisdiction lifecycle and document counts.
- A Bid Desk with a research-to-delivery pipeline, project stakeholder graph, missing-role checklist, quote line items, scope/exclusions/lead-time terms, recipient-channel verification, internal release checklist, approval gate, text-package export, and authenticated private draft save/restore. Opening an exact configured record runs bounded official-source research when no fresh result exists; missing contacts, plans, and scope remain explicit gaps. Drafts are isolated by authenticated owner, client snapshots cannot overwrite canonical project data, and saving never sends or submits anything.
- A durable D1 model for contacts, project-contact roles, saved searches, opportunities, versioned bid packages, attachments, recipients, immutable submission attempts, suppressions, enrichment requests, and activity events.
- An optional Apollo professional-contact adapter that requires authenticated access, explicit credit confirmation, and a separate `APOLLO_ENRICHMENT_ENABLED=true` operator opt-in. Personal email, phone, and waterfall enrichment are disabled. No outbound email or procurement-portal submission connector is configured.

## Application routes

- `/` - compact national overview and links into each work area.
- `/projects` - project, location, product/document-keyword, and lifecycle-stage search. Results start at 10 per page and can be displayed at 10, 25, or 50 per page with First, Previous, Next, and Last controls. Connected searches page through the API/database instead of downloading a fixed browser-side result cap, and the bounded filters/page are retained in the shareable URL.
- `/documents?project=<project-id>&source=<source-id>` - separate plans/specifications/drawings/CAD library with metadata and extracted-text search, processing-state filters, 10/25/50 paging, official-URL import, and authenticated workspace upload. Search scope and paging are retained in the route URL.
- `/bid-desk?project=<project-id>` - the selected project's controlled estimating and bid-package workspace.
- `/coverage` - source health, state/DC coverage, and the paged jurisdiction explorer. Jurisdiction rows also support 10, 25, or 50 per page.
- `/source-monitor` - authenticated registration, scanning, pausing, review, and publication for local public posting feeds and planrooms.

The Projects page starts with the first server-paged D1/live result page, and every subsequent search uses `GET /api/search` against D1 plus deterministic live fallbacks. Totals include only materialized records that can actually be opened; source-reported record counts are displayed separately. Materialized D1 results no longer have a browser-side 200-record cap. Live records override a stored copy when the current connector window observes the same source ID; stored records outside that window remain an as-of-last-ingestion view and can lag a later stage, location, or status change. The direct Seattle source-search fallback remains a bounded 1,000-row window until source-native paging is integrated, and the UI warns when upstream matches exceed that window. Jurisdiction paging is performed by `GET /api/jurisdictions` against D1, with the place-seed manifest used only as an explicit fallback.

The live NYC City Record universe keeps every current Procurement-section category—not only rows labeled Construction—because architecture, engineering, renovation, and building-product opportunities are also published as Services or Goods. Long-term and administrative/open-ended solicitations remain searchable, while unmistakable or aged placeholder dates are normalized out of the `today`, `7-days`, and `14-days` deadline buckets. City Record calendar timestamps are interpreted in `America/New_York`; project cards show the exact Eastern cutoff and only link a sign-in portal when that project record provides evidence for it.

## APIs

- `GET /api/projects` - current connected-source project view with provenance and coverage scope.
- `GET /api/search?keywords=canopy,%22partition%20wall%22&match=any&location=Seattle&state=WA&due=7-days&page=1&limit=10` - multi-term metadata/document search with source-local `today`, `7-days`, and `14-days` deadline windows, bounded live fallbacks, exact materialized-result totals, and server-side paging. `limit` accepts 10, 25, or 50.
- `GET /api/coverage` - source health and 51-state/DC coverage ledger.
- `GET /api/source-registry` - official state procurement and DOT discovery roots.
- `GET|POST|PUT /api/source-monitors` - authenticated, owner-scoped source-monitor listing, creation, and pause/resume controls.
- `POST /api/source-monitors/<monitor-id>/scan` - safely fetch and normalize one owned public posting source, then return verified and review-queue counts.
- `PATCH /api/source-monitors/candidates/<candidate-id>` - reject a discovered posting or complete its missing facts and publish it into the verified bid index.
- `GET /api/jurisdictions?q=Seattle&state=WA&page=1&limit=10` - paged Census government/dependent-agency registry plus discovery and connection metrics. `limit` is capped at 50.
- `POST /api/internal/ingest?mode=incremental` - protected background ingestion; advances at most one source page and may pause within that page at the D1 statement budget.
- `POST /api/internal/ingest?mode=bootstrap` - protected bootstrap trigger using the same bounded source pages and persisted source, project, and document cursor guarantees.
- `POST /api/internal/discover?limit=3` - protected, bounded jurisdiction catalog-discovery batch. Its results remain candidates until a source is verified and successfully ingested.
- `GET /api/integrations` - capability flags only; no credentials or secrets.
- `PUT|DELETE /api/integrations` - authenticated, owner-scoped, write-only API-key vault management for the allowlisted SAM.gov and Apollo providers. Stored keys are encrypted with AES-256-GCM and are never returned.
- `POST /api/integrations` - optional, authenticated professional-person enrichment. Requires `confirmCreditUse: true` and a configured `APOLLO_API_KEY`.
- `GET /api/documents/search?q=canopy&projectId=<project-id>&page=1&limit=10&public=1` - rights-aware document metadata and extracted-text search.
- `POST /api/documents/import` - authenticated public-HTTPS metadata/byte import with provenance and rights fields.
- `POST /api/documents/upload` - authenticated multipart upload into content-addressed R2 storage.
- `GET /api/documents/<document-id>` and `/download` - protected metadata/version and byte retrieval; anonymous public access is allowed only when every redistribution and security gate passes.
- `POST /api/documents/<document-id>/extractions` - internal-token-only, bounded page-aware text extraction handoff for an external OCR/CAD worker.
- `GET|POST /api/bid-drafts` - authenticated, owner-isolated private bid-draft restore/save. It never creates a submission attempt or invokes an outbound connector.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

To verify the production build locally, run `npm run build` and then
`npm start`. The production start command includes a process-local Windows URL
separator compatibility wrapper for Vinext's static-asset cache; it does not
modify `node_modules` and is inert on POSIX hosts.

After the dev server creates its local D1 database, generate the Census registry SQL in a
second terminal, apply every migration, and load the registry:

```bash
node scripts/import-census-jurisdictions.mjs --out outputs/census-jurisdictions.sql
npm run db:local-bootstrap
```

Copy `.env.example` to `.env.local` and set any available free keys/secrets.

```text
SAM_API_KEY=
INGEST_TOKEN=
DATA_GOV_API_KEY=
APOLLO_API_KEY=
APOLLO_ENRICHMENT_ENABLED=false
BIDATLAS_INTERNAL_TOKEN=
```

## Verify

```bash
npm run build
npm test
npm run db:generate
npm run db:validate
```

Inspect the current Census workbook, generate a Wrangler-compatible SQL import, or upload it directly through the authenticated Cloudflare D1 API:

```bash
npm run registry:inspect
node scripts/import-census-jurisdictions.mjs --out outputs/census-jurisdictions.sql
node scripts/import-census-jurisdictions.mjs --upload
```

Audit or regenerate the supplemental incorporated-place seed manifest from the supplied text file:

```bash
npm run cities:audit -- --input /path/to/all_50_us_states_and_cities_2025.txt --out data/city-seeds-2025.json
```

Classify the existing 102 official state/DC roots into a deterministic review manifest. Supply the actual UTC time of the metadata review; unchanged rows retain their prior check time unless `--recheck-all` is explicitly added.

```bash
npm run sources:classify -- --out outputs/jurisdiction-source-portals.json --checked-at 2026-07-16T12:00:00.000Z
```

This command performs no portal requests and creates no live adapters. The generated candidates must go through ownership, terms, robots, public-access, rate-limit, and pagination review before implementation.

The supplied file has 19,482 rows across 50 states, excludes DC, and contains 11 state/name labels that are ambiguous because the text omits stable Census place identifiers. It is population-place geography, not a list of every public owner. The authoritative coverage registry remains the 97,241-row Government Units Survey import: 91,438 independent governments plus 5,803 dependent school-system/agency rows.

Direct upload requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and a scoped `CLOUDFLARE_API_TOKEN` with D1 write permission.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the coverage model, connector families, document/CAD boundaries, deduplication rules, and rollout plan. [COMPETITOR_PARITY.md](COMPETITOR_PARITY.md) maps the official ConstructConnect and PlanHub workflow capabilities to the BidAtlas implementation and safety boundaries.
