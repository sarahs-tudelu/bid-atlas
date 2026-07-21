# BidAtlas national architecture

## What “complete” means

There is no lawful single endpoint for every U.S. public or private construction project. Private residential and commercial work is discoverable only where a public permit, planning, zoning, environmental-review, procurement, or document source exposes it. BidAtlas therefore measures public-source completeness as a matrix:

`jurisdiction/owner x source class x lifecycle stage x last successful complete check`

The 2025 Census Government Organization data reports 91,438 independent local governments: 3,031 counties, 19,489 municipalities, 16,184 townships, 12,535 independent school districts, and 40,199 special districts. The workbook also supplies 1,318 dependent school systems and 4,485 dependent agencies. The importer therefore maps 97,241 jurisdiction/agency rows before adding the federal government, 50 states, DC, territories, universities, ports, airports, housing authorities, utilities, and other quasi-public owners.

Official baseline: [Census 2025 Government Organization data](https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html).

Applicable coverage cells include:

1. planning, zoning, agendas, and environmental review;
2. capital plans, budgets, bonds, STIPs, and TIPs;
3. building, demolition, grading, utility, and land-development permits;
4. architect/engineer and design procurement;
5. construction solicitations, plan rooms, addenda, and RFIs;
6. transportation lettings and contract documents;
7. plan/specification/document availability;
8. bid openings, apparent bidders, and bid tabs;
9. intent-to-award, award, executed contract, and change orders.

No national coverage percentage is shown until the underlying Census jurisdictions and applicable cells have actually been loaded. Healthy connectors and complete coverage are separate measurements.

## Current connectors and discovery roots

The application currently normalizes:

- [Federal Permitting Dashboard](https://data.permits.performance.gov/Permitting-Project/Permitting-Dashboard-Full-Dataset/mcm3-xbid) for major federal review/permitting milestones.
- [USAspending](https://api.usaspending.gov/docs/endpoints) for federal award and recipient reconciliation.
- [Caltrans advertised projects](https://ccop.dot.ca.gov/allProjects) for current transportation bids and contract-document links.
- Official state DOT construction-bid feeds for Washington, Illinois, Texas, New York, North Carolina, Iowa, statewide Florida, Virginia, Michigan, Ohio, and Pennsylvania. The connectors retain public solicitation, addendum, plan, and plan-holder links where published and explicitly label Bid Express, CPP, ProjectWise, or MiLogin/eProposal account gates instead of presenting gated files as public downloads. Texas joins the official current order-of-bids export to both State-Let Construction and State-Let Maintenance archives, the authoritative TxDOT bid-item deadline dataset, cancellations, and the Authorized Bidder export by controlling CSJ. Authorized Bidder rows are labeled plan holders/authorized proposal requesters rather than proof of bid submission. TxDOT plan-package links remain metadata-only because download is governed by the TxDOT Plans Online license agreement; the system does not automatically copy or index them. Ohio validates filed ArcGIS candidates against current public plan and proposal documents in three bounded date-range cabinet snapshots. Pennsylvania uses isolated official anonymous ECMS sessions for parallel detail workers, serializes stateful requests inside each session, rejects cross-project identities, expands consolidated plan files and public planholder contacts only when a project is opened, and never persists the temporary session identifier.
- [Seattle building permits](https://data.seattle.gov/Permitting/Building-Permits/76t5-zqzr/about_data) for full-history permit/plan-review descriptions, values, addresses, and contractor names, with a separate active-project view.
- [NYC DOB NOW filings](https://data.cityofnewyork.us/d/w9ak-ipjd), [Los Angeles submitted building permits](https://data.lacity.org/d/gwh9-jnip), [Chicago building permits](https://data.cityofchicago.org/d/ydr8-5enu), [Austin construction permits](https://data.austintexas.gov/d/3syk-w9eu), and [San Francisco building permits](https://data.sfgov.org/d/i98e-djp9) for permit/application intelligence using stable source keysets. These feeds can identify private residential and commercial work and stages; they are not mislabeled as open solicitations, and their metadata rows do not establish that plan files are public.
- [Tempe Building Safety permits](https://data.tempe.gov/datasets/tempegov::permits-issued-by-building-safety/about) and [Miami iBuild permits](https://www.miami.gov/Permits-Construction/Apply-for-or-Manage-Building-Permits-iBuild) through official ArcGIS services, [Pittsburgh PLI permits](https://data.wprdc.org/dataset/pli-permits) and [Boston approved building permits](https://data.boston.gov/dataset/approved-building-permits) through official CKAN DataStores, and [Philadelphia L&I permits](https://data.phila.gov/visualizations/li-building-permits/) through the official Carto SQL API, using reusable deterministic keyset adapters. Philadelphia's interactive view is limited to active building, zoning, and trade-permit rows; ingestion revisits a bounded recent-terminal window to reconcile completed work, and it promotes only organization-like owner or contractor names. Counts are permit rows, not unique buildings or projects. These are verified local implementations of standardized families, not citywide plan repositories or statewide coverage claims.
- [NYC City Record procurement notices](https://data.cityofnewyork.us/d/dg92-zbpx), retaining the full Procurement section because architecture, engineering, renovation, and building-product opportunities are not consistently categorized as Construction.
- [Legistar Web API](https://webapi.legistar.com/Home/) for early council/committee signals in configured cities.
- [SAM.gov Opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/) for sources sought, presolicitations, solicitations, attachment links, and awards when a free API key is configured.

`app/lib/state-source-registry.ts` contains official statewide procurement and DOT discovery roots for all 50 states plus DC. These 102 roots do not cover every local agency, university, authority, below-threshold procurement, or separate public-works board; those receive individual source records.

Source-family expansion uses:

- [Data.gov Catalog API](https://resources.data.gov/catalog-api/) and public catalog search for dataset discovery;
- [Socrata APIs](https://dev.socrata.com/docs/endpoints) for permits, planning applications, capital projects, bids, and awards;
- [ArcGIS item search](https://developers.arcgis.com/rest/users-groups-and-items/search-reference/) and [Feature Service query](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/) for public project/permit layers;
- agency-specific public portals operated through Accela, Tyler/EnerGov, OpenGov, Bonfire, Euna/IonWave, PlanetBids, JAGGAER, PeopleSoft, CGI Advantage, Bid Express, Public Purchase, and related systems.

Undocumented protected endpoints are not treated as public APIs. Current source records carry access mode and cadence, but the durable source model still needs explicit terms/license URLs, robots decisions, redistribution policy, and enforced request-budget fields before automated onboarding can safely scale beyond individually reviewed adapters. A discovery candidate is never treated as connected merely because its URL is public.

### Portal-family classification and review handoff

`app/lib/portal-classification.ts` is a network-free classifier for official source roots and supplied public metadata. It recognizes Socrata, ArcGIS, CKAN, Carto, OpenGov, Bonfire, PlanetBids, BidNet, IonWave, DemandStar, Public Purchase, generic HTML, manual/document-only sources, and unknown or unsafe values. Results include a bounded confidence score and the hostname, path, or metadata evidence used. Host matching is suffix-bounded so lookalike domains do not inherit a vendor classification. URLs containing embedded credentials or credential-like query parameters are rejected without retaining those values.

The resulting adapter object is intentionally only a review candidate. Discovery persists its family, confidence, classifier version, evidence, review state, connection state, and classification time while forcing `unverified`, `not-connected`, and `disabled-until-reviewed`. Rediscovery refreshes unreviewed metadata but cannot overwrite a prior human `verified` or `rejected` decision. It does not derive or invent an API endpoint and disables network access until a reviewer confirms ownership, terms, robots policy, public access, rate limits, and pagination. Even after review, its declared method ceiling is public metadata-only `GET`/`HEAD`; it never authorizes login automation, credential collection, CAPTCHA handling, or access-control bypass.

`scripts/enrich-jurisdiction-source-seeds.mjs` applies that classifier to the 102 procurement and transportation roots already present in `app/lib/state-source-registry.ts`. The optional output is stable-sorted by source key and retains the exact registry module, field, URL, first-seen time, last metadata-check time, fingerprints, confidence evidence, and human review annotations. A later public-page observation may add bounded `observedMetadata` only when its `sourceUrl` exactly matches that official root; changing those observations triggers deterministic reclassification. Unchanged records keep their timestamps by default; `--recheck-all` updates them only when the operator explicitly supplies the new check time. Separately managed jurisdiction roots in an existing manifest are preserved rather than deleted.

The safe integration path is: generate or merge the manifest, review classifications, then import accepted rows as unverified candidate provenance linked by the authoritative jurisdiction key. A candidate can enter adapter implementation only after its public endpoint and operating policy are verified. Successful ingestion may create partial occurrence evidence; neither classification nor candidate import may advance a coverage cell to `connected`.

## Jurisdiction identity, city seeds, and discovery jobs

The Government Units Survey import is the authoritative public-owner keyspace. It preserves Census government identifiers and maps 91,438 independent local governments plus 5,803 dependent school-system/agency rows, for 97,241 registry rows. Names alone are not identity keys: similarly named cities, boroughs, authorities, and school systems must remain distinct.

`data/city-seeds-2025.json` is a supplemental discovery manifest generated from the user-supplied `all_50_us_states_and_cities_2025.txt`. That file contains 19,482 rows derived from the Census [Vintage 2025 incorporated-place population series](https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025.csv) across the 50 states. It excludes DC, omits stable Census place identifiers, and has 11 within-state duplicate display labels (19,471 unique state/name pairs). It therefore cannot stand in for the government registry and does not include counties, townships, most school districts, special districts, authorities, or other public owners. When D1 is unavailable, the jurisdiction API may display these names, plus an explicit DC supplement, as `not-connected` discovery targets only.

The authoritative registry is also the keyspace for logical discovery workers. Rather than running thousands of permanent processes, BidAtlas stores a resumable job row per jurisdiction. The registry importer pre-seeds all active registry rows, and scheduled runs materialize missing active jobs in small batches. Each job carries its required source classes, cursor, priority, attempt count, lease owner/expiry, next-run time, error, and candidate count. Observed project/document counts live separately in `jurisdiction_metrics`.

The scheduled Worker leases a bounded number of due jobs, searches the official Data.gov catalog, persists provenance-bearing `dataset_candidates`, and then releases, requeues, or backs off the job. Due work is tiered so a jurisdiction with an active source-class/page scan (including a due retry or an expired lease) finishes ahead of untouched jobs, and untouched jobs finish ahead of weekly rechecks for completed scans. Population priority, due time, and stable job ID break ties inside each tier. This prevents the 97,241-row initial queue from stranding every jurisdiction after its first source-class turn. It prefers the keyed GSA v4 search and falls back to Data.gov's public catalog search endpoint when no key is configured; the cursor records the provider so switching APIs cannot reuse an incompatible page token. Catalog pagination, short request timeouts, retry delays, and D1 batch limits keep discovery resumable. A job status of `complete` means only that its bounded catalog scan finished; it does not mean jurisdiction coverage is complete.

The owner-scoped Source Monitor is the small-market acquisition path for already-published opportunities. An authenticated user registers one original public procurement feed, contractor/owner planroom, or builders-exchange page. Each fetch is limited to public HTTPS, validates A/AAAA results before every request, follows at most three independently validated redirects, accepts only text/feed media types, caps the response at 2 MiB, and normalizes at most 100 postings. RSS, Atom, JSON Feed, JSON-LD, and bounded HTML link/table discovery produce `source_posting_candidates`; missing deadline, location, bid language, or bid-document evidence stays in `needs-review`. Only complete automatic or human-reviewed candidates materialize canonical `projects`, `project_sources`, `documents`, contacts, and `project_opportunity_verifications`. The scheduled Worker refreshes at most three due monitors per trigger and uses bounded backoff after failures. A later passed deadline closes the opportunity even when its descriptive fields were reviewed manually.

The connection states have strict meanings:

- `not-connected`: only a registry row, seed, queued job, completed discovery scan, or unverified candidate exists;
- `partial`: at least one applicable source class has a verified live adapter and a successful ingestion, but other required source classes remain;
- `connected`: every currently required source class has reviewed scope evidence, a verified live adapter, a successful complete ingestion, and current provenance. Connected evidence expires from the read path when the latest success is older than the greater of three expected source cadences or 24 hours.

Candidate discovery never writes directly to the connected `sources` set. A candidate is linked to each originating authoritative Census jurisdiction whose discovery job returned it through `dataset_candidate_jurisdictions`; this is an unverified association, not proof of every jurisdiction a shared dataset serves. Verification must establish the official owner, public access method, stable identifiers, served jurisdictions, terms/rate limits, pagination behavior, and a successful normalized ingestion before connection metrics advance.

Ingestion materializes project counts only when a project location resolves to exactly one official place or county government within its state. Ambiguous same-name matches remain unlinked. For exact matches, a live adapter writes a **partial occurrence-evidence** row per source/class/stage and recomputes the aggregate `coverage_cells` state. Exact location proves that the project belongs to the jurisdiction; it does not prove that the adapter covers every applicable record there. Promotion to `connected` therefore requires a separate reviewed-scope decision plus a successful complete snapshot. Overlapping adapters remain independent, and a degraded source cannot erase another source's evidence. The worker refreshes lifecycle, public-document, and explicitly connected-source-class counts in `jurisdiction_metrics`. Discovery candidates, registry bookmarks, and unverified location guesses never affect those counts.

## Durable ingestion

The Worker has a five-minute scheduled handler plus a protected internal trigger. A 30-minute D1 lease spans the schedule interval and prevents scheduled and manual runs from overlapping. Ingestion proceeds as follows:

1. load the durable ingestion cursor and select one project source from independent backfill and refresh round robins (two backfill pages, then one refresh page for incremental runs); each source retains its own refresh state, and high-volume permit adapters use a durable forward-only source-update watermark after their first head page;
2. request exactly one bounded upstream page for that source, using its persisted source-native cursor;
3. upsert source health and source-reported totals;
4. upsert canonical project rows without deleting provenance, retaining `(source_id, source_record_id)` as the idempotency key;
5. persist official identifiers, participants, document metadata, and versions;
6. update FTS metadata rows;
7. stop below the configured D1 statement budget and persist `pageProjectId`, `pageProjectOffset`, plus `projectDocumentOffset` when the current page cannot be fully materialized;
8. retain the stable IDs already persisted from a partial page, re-fetch that page on retry so newly inserted or reordered records are still considered, and advance the upstream `sourceCursors[source_id]` plus the round-robin source index only after every current project and deferred document in that page has been persisted;
9. record the ingestion run, loaded count, reported count, page state, and snapshot-complete state; preserve prior records on failure and retry visibly.

The pageable adapters use deterministic, source-specific navigation: the Federal Permitting Dashboard uses an immutable project-ID keyset; Seattle and the NYC/Los Angeles/Chicago/Austin/San Francisco Socrata feeds use stable source keysets; Tempe, Pittsburgh, Boston, Miami, and Philadelphia use deterministic ArcGIS, CKAN, or Carto keysets; Legistar uses a frozen scan window with a stable matter order plus `$skip`; USAspending follows `hasNext`, persists both `last_record_unique_id` and `last_record_sort_value`, and freezes its date window; and SAM advances a page-index cursor over a frozen date window. The Worker fetches one source page per run instead of first downloading a large cross-source window. If the statement budget interrupts a page, the upstream cursor does not advance and its frozen query cursor is retained. The next run uses a saved copy of the current project and document list before applying its document offset, so an upstream reorder/removal cannot redirect that offset to a different record.

Completing one page, or even reaching the current end of one adapter query, is not national completeness. A record is never marked withdrawn from a truncated page; withdrawal requires repeated absence from a verified complete snapshot, and national completeness still requires every applicable jurisdiction/source-class/lifecycle cell to be connected and current.

The refresh lane rotates after every page and stores state independently per source. Seattle and the configured Socrata, ArcGIS, CKAN, and Carto permit adapters first read the newest bounded head, persist its source sort value plus stable identity, and then query strictly after that pair in ascending order. Delta pages advance the watermark only after materialization; rows sharing one timestamp continue by identity, and an empty/final delta retains the last watermark. This prevents a later head check from jumping over rows 51 onward while allowing historical backfill to remain independent. Older adapter families keep their source-native continuation behavior. This is still not a completeness proof: source-specific cadences and dedicated high-priority lanes are required before near-deadline alerting can be considered complete.

Source ingestion and jurisdiction catalog discovery are separate bounded workloads. The scheduled handler runs ingestion first and discovery second so their leases and D1 statement budgets do not compete. Protected manual triggers are available at `/api/internal/ingest` and `/api/internal/discover`; accepting either trigger is not evidence that it completed successfully.

Recommended cadence:

- active solicitations/addenda: every 4-6 hours;
- closing within 72 hours: every 1-2 hours;
- permits/planning/agendas: daily;
- bid tabs and awards: daily for 90 days after close;
- capital plans/budgets: weekly;
- verified-source health rediscovery: weekly after the publisher/source-family discovery redesign described below;
- Census jurisdiction reconciliation: annually.

The current per-jurisdiction catalog queue is intentionally conservative: at three leased jobs per five-minute run and one source class per job turn, it can perform at most 864 jurisdiction-class scans per day. A 97,241-by-seven initial matrix would still take roughly 2.2 years before pagination and retries, so this queue is a correctness scaffold—not a credible national rollout cadence. Production-scale discovery must deduplicate by publisher, portal, and source family, fan verified coverage back out to jurisdictions, and use reviewed API-specific rate budgets. Daily project freshness comes from the resulting verified source adapters, not from rerunning hundreds of thousands of catalog keyword searches.

## Product and location search

Search accepts multiple product/material/system phrases, location text, state, lifecycle stage, and freshness. The Projects route defaults to the dated `new` plus `current` set; stale, terminal, and undated active-looking records require an explicit filter choice. Keyword modes are:

- all terms;
- any term;
- normalized exact phrase.

Project metadata and document text are deliberately separated. D1 FTS5 indexes materialized project fields and page-aware document chunks. The source connectors do not yet automatically fetch and extract every linked plan/specification binary; authenticated users can now import safe public HTTPS files or upload an authorized workspace copy, and an external worker can post bounded page-aware extraction results. Until those paths populate chunks, a document remains metadata-only or conversion-pending. Indexed chunks report the document version, page range, extraction method, confidence, source URL, and index timestamp. A currently observed live source ID overrides its persisted metadata before filters and counts are merged. A record outside the connector's bounded current window remains an as-of-last-successful-ingestion record; a criteria-scoped live query cannot prove that an unseen record did not later transition out of the requested facet.

Residential/commercial search adds conservative normalized tags from project title, summary, status, and adapter-supplied use/scope fields. It recognizes common official categories such as single-family dwelling, `1-2FAM`, `1-3FAM`, ADU, duplex, commercial/`Comm`, retail, office, warehouse, hotel, and mixed use. Agency names, contact channels, addresses, and document names are excluded from inference. These tags improve recall; they are not proof that a project is privately owned, currently actionable, or accompanied by public plans.

A no-result response always means “no match in indexed public content.” It never asserts that an item is absent from an uncollected, account-gated, encrypted, failed-OCR, or nonpublic plan set.

The interface is split into purpose-specific routes: `/` for the overview, `/projects` for search and project review, `/documents` for plans/specifications/drawings/CAD metadata and extracted-text search, `/bid-desk` for estimating and package preparation, and `/coverage` for state/source and jurisdiction coverage. Project and document results default to 10 per page and offer 10, 25, or 50 with First/Previous/Next/Last navigation. Their bounded filters and page state are represented in the URL so reloads and shared links restore the same view. Before a connected search, the small feed already loaded by the page is filtered and paged locally. A connected project search uses `/api/search?page=…&limit=…`; the persisted index applies deterministic SQL `LIMIT/OFFSET`, and the API fills the same page from deduplicated live fallbacks when needed. The reported total counts materialized, navigable records only—an upstream source-reported total can be larger when that adapter window is incomplete. The jurisdiction explorer also uses server-side `page` and `limit` parameters through `/api/jurisdictions`, with the same 10/25/50 choices and a hard API limit of 50 rows per request.

## Plans, drawings, and native CAD

The normally attainable contract record is PDF plans, specifications, addenda, reports, bid forms, bid tabs, and awards. Native DWG, DGN, RVT, BIM, or editable design files are opportunistic because they may never be filed, may be reference-only, or may be copyrighted, account-gated, records-request-only, or withheld for security.

Document states include public link, public archived snapshot, free account, agency API, public-records request, invite-only, view-only, paid, restricted/security-sensitive, and unavailable. BidAtlas never bypasses login gates, CAPTCHAs, paywalls, sealed-bid controls, or license restrictions.

The persistence and API layer now stores canonical source URL, source document ID, filename/MIME, SHA-256 hash, bytes, access class, visibility, license/redistribution evidence, retrieval and security state, posting time, versions, and supersession relationships. Public-HTTPS import follows at most four redirects, applies a 20-second whole-operation deadline, and validates public A/AAAA answers before each fetch; browser uploads require a bounded `Content-Length` before multipart parsing and retain a 25 MiB file ceiling. Eligible bytes use content-addressed R2 keys and deduplicate identical payloads while D1 keeps metadata and version lineage. Private visibility is owner-only, workspace visibility is authenticated-workspace shared, cross-owner private takeover is rejected, object keys are never returned by public APIs, and extraction callbacks require the configured internal service token. Document metadata has its own trigger-maintained FTS index; page-aware extraction chunks continue to feed the project/document FTS used by product search. Anonymous download remains impossible unless visibility is public, access is public, redistribution is explicitly allowed, the blob is ready, and security review is approved. Workers cannot pin the final TLS connection to the DNS-validated IP, so production egress policy remains the final DNS-rebinding boundary. Scanned-PDF OCR and native-CAD conversion still require a separate sandboxed asynchronous extraction service; D1/R2 store and index the results but do not execute untrusted converters.

The page-aware contact parser is a downstream-only component. It consumes existing `document_chunks` and emits unverified candidates only for blocks explicitly labeled owner, architect, engineer, contractor, or agency. Every candidate carries the verbatim bounded evidence snippet, page range, project, document version, extraction, chunk, and source URL. It validates email syntax, accepts only ten-digit US numbers from an explicit phone/tel/mobile/direct field, ignores fax fields, and never infers a role from an unlabeled name, plan-holder list, prospective-bidder list, applicant, or developer. Parser readiness is exposed by `GET /api/integrations`, but execution and contact persistence remain disabled while production has no lawful binary retrieval/OCR pipeline and therefore no extracted chunks to process.

## Supplier portal registration

The public Tudelu supplier profile is prefilled once from the company website. `portal_accounts` and `portal_registration_tasks` track each agency portal and its verification state without storing raw passwords, tax IDs, banking data, or one-time codes in D1.

Registration can reuse public company details, but it pauses for owner-controlled data or actions: authorized representative, registration email verification, EIN/W-9, UEI/CAGE, license/insurance/certification claims, banking details, portal terms, attestations, and electronic signatures. Account access does not authorize bypassing a portal’s terms or redistributing protected plans.

## Bid Desk, contacts, and controlled delivery

The Bid Desk UI follows `research → qualify → estimate → package → approval → delivered`. Opening an exact configured project starts a bounded official-source research pass when no fresh result exists. Each opportunity stays linked to the public project and its provenance. The persistence schema supports separate canonical contacts joined to projects by explicit roles such as owner, agency, architect, engineer, contractor, and bidder. Some source records publish literal professional email or phone fields; many private permits publish only an agency or participant name, and the interface labels that as non-routable rather than calling it a direct contact. A plan holder is never promoted to bidder or contractor without evidence.

The Bid Desk creates line items, scope, exclusions, lead time, validity, recipients, readiness evidence, and an editable cover message. Authenticated workspace users can privately save and restore that draft through `/api/bid-drafts`; opportunity and package identity is scoped by the normalized authenticated owner, and reads/writes cannot cross that boundary. A client snapshot may create a non-overwriting project stub needed for a legitimate loaded fallback record, but it cannot modify an existing canonical project. Every save resets approval to pending and never inserts a submission attempt. Recipient routes accept only strictly parsed HTTPS URLs or valid email addresses, and failed/aborted draft hydration remains retryable. The schema remains prepared for versioned packages, immutable hashes, approvals, channel selection, idempotency keys, provider receipts, and append-only activity events, but external delivery is still disabled. Original project documents remain source artifacts and are not silently bundled for redistribution.

Contact enrichment is provider-neutral. The current Apollo adapter is optional and accepts only professional identities after an authenticated caller explicitly confirms credit use. It disables personal-email, phone, and waterfall enrichment. Enriched data is not a submission instruction: the team must still verify a direct work address or the project’s official portal and preserve that evidence.

External delivery is deliberately not configured. A package can be drafted, copied, downloaded, and approved in-session, but email or portal submission remains disabled until the relevant adapter can enforce the solicitation’s approved channel, deadline and timezone, required forms, file limits, acknowledgements, opt-outs/suppressions, and a final human confirmation of the exact payload and recipients. A public email address alone is not proof that bids may be submitted there.

## Bidders, contractors, and deduplication

Plan holders and prospective bidders are not labeled as bidders. Bidder identity and pricing are recorded only when an official bid opening/tabulation publishes them. Award records identify the contractor after award.

The overview's contractor/bidder organization metric is a distinct known-name union across loaded persisted and live records. It is not a current bidder roster: when a newer source record replaces a participant, the older organization remains part of historical loaded knowledge unless lifecycle reconciliation explicitly supersedes that relationship.

Current ingestion deduplicates idempotently within each source by `(source_id, source_record_id)`. Cross-source reconciliation is still future work: the planned second pass will use authoritative solicitation, permit, parcel, contract, and capital-project identifiers, then score normalized address, coordinates, owner, title, value, and dates. Ambiguous matches will remain separate for review, and merges must never destroy source records or event history.

## Honest boundary

“Every lawfully available public record” is the operational target, including public filings for private residential and commercial work. No truthful system can guarantee every private project, unpublished architect files, sealed bidder identities, personal homeowner details, security-sensitive plans, or native CAD that an owner never released. BidAtlas is designed to distinguish an unavailable record from a source the system has not connected yet—and to make the latter gap impossible to hide.
