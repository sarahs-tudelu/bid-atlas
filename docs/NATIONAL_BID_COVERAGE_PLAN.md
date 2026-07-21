# BidAtlas national bid coverage plan

## The promise we can defend

BidAtlas should become the most complete index of **discoverable, publicly advertised United States construction opportunities that contain enough verified information to act on**. It must never claim that one public website contains every public and private project or that every plan set is legally public.

The product has two deliberately separate inventories:

1. **Qualified open bids** — shown in the primary bid queue only when a user can identify the solicitation, deadline, location, scope, official source, and an official plan/specification route.
2. **Early project leads** — permits, planning cases, design activity, awards, and authorized private invitations. These can support prospecting, but they must not inflate open-bid counts or appear as ready-to-bid projects.

This split is the central product rule.

## Admission contract for the primary queue

A record is `bid-ready` only when all of these are true:

- the source is an official procurement publisher;
- the opportunity is in the bidding stage;
- the submission deadline is today or later;
- title, owner/agency, solicitation identifier, scope, status, and project location are published;
- an HTTPS official-source link exists;
- at least one official plans, drawings, specifications, CAD, or addendum route exists;
- the record has not been superseded, cancelled, awarded, completed, or detected as a duplicate.

The UI must say whether a document is a direct public file or requires free portal sign-in. A generic agency homepage is not a plan route. Unknown information remains unknown; it is not inferred and presented as fact.

## Why this requires a connector network

There is no single public national database containing every federal, state, local, residential, commercial, and private construction bid with plans and contacts.

- SAM.gov is the federal opportunity system and exposes a public opportunities API, but it does not cover every state, municipality, school district, utility, or private project.
- The Census Bureau counted 91,438 local governments in 2025. A city-only list therefore misses counties, townships, school districts, and special districts.
- The Census Building Permits Survey is a statistical program covering buildings, units, and valuation. It is not a national project-plan repository.
- Some permit authorities explicitly prohibit public plan viewing in their portals. NYC DOB is one published example.
- Bidder identities can be protected before bid opening; the federal sealed-bidding rules are one example. BidAtlas must not promise a complete pre-opening bidder list.

Official references:

- SAM.gov Opportunities API: https://open.gsa.gov/api/get-opportunities-public-api/
- 2025 Census government organization report: https://www.census.gov/content/dam/Census/library/publications/2025/econ/govtorg2225.pdf
- Census Building Permits Survey methodology: https://www.census.gov/construction/bps/methodology.html
- NYC DOB public portal FAQ: https://www.nyc.gov/site/buildings/industry/dob-now-public-portal-faqs.page
- FAR sealed-bid opening rules: https://www.acquisition.gov/far/subpart-14.4
- Architectural works copyright guidance: https://www.copyright.gov/register/va-architecture.html

## Connector program, in priority order

### 1. National and state anchors

Build and operate first-class connectors for:

- SAM.gov federal opportunities;
- all 50 state procurement portals plus District of Columbia and territories in scope;
- every state department of transportation;
- state facilities, higher education, corrections, courts, and public works publishers;
- USACE, VA, GSA, DOD service branches, and other high-volume federal construction publishers where SAM links out to plans.

Each connector must capture notice revisions, addenda, deadlines with source timezone, contacts, documents, and the official submission route.

### 2. Shared procurement-platform adapters

One platform adapter can unlock many agencies. Maintain reusable, versioned adapters for the major public portal families, including:

- OpenGov Procurement;
- Bonfire;
- PlanetBids;
- Ion Wave;
- Periscope/BidSync;
- DemandStar;
- Public Purchase;
- AASHTOWare Project and Bid Express;
- agency-hosted ArcGIS/Open Data/Socrata feeds when they publish procurement records.

Adapters must use documented APIs, feeds, exports, or permitted browser workflows. Respect rate limits, access controls, robots directives, copyright, terms, and document redistribution rights.

### 3. Long-tail government registry

The unit of coverage is an **issuing organization**, not a city. Maintain a registry for states, counties, municipalities, townships, school districts, universities, airports, ports, transit authorities, housing authorities, hospitals, utilities, water/sewer districts, and other special districts.

For every organization store:

- official procurement URL and platform family;
- document-host URL and authentication mode;
- feed/API availability and last successful check;
- expected publishing cadence;
- jurisdiction and organization type;
- connector health, record counts, parse errors, and last verified sample;
- manual-review owner and escalation history.

Discovery agents can propose sources, but a source enters production only after validation against an official domain and a sampled opportunity.

### 4. Private construction and residential coverage

Private-house and commercial permits are useful early leads, not automatically open bids. Keep them in the early-lead inventory until there is an authorized bid invitation or a published procurement route.

Acquire private opportunities through legitimate channels:

- direct feeds and forwarding mailboxes supplied by owners, architects, general contractors, and plan rooms;
- authorized integrations with invitation and project-management platforms;
- opt-in contractor and architect uploads;
- public planning and permit data used for discovery and outreach, subject to privacy and solicitation law;
- licensed data where public records do not expose the needed plans or contacts.

Never bypass portal authentication or present copyrighted architectural plans as downloadable unless access and redistribution rights permit it.

## Daily ingestion and qualification pipeline

1. **Discover** — schedule connectors according to source cadence; monitor sitemaps, feeds, APIs, portal indexes, revision pages, and addenda pages.
2. **Fetch** — retain source URL, fetch time, response checksum, terms/access classification, and immutable raw evidence where permitted.
3. **Normalize** — map issuer, solicitation, dates/timezone, location, scope, trade codes, contacts, documents, and submission method into the canonical model.
4. **Resolve** — deduplicate with issuer + solicitation ID first, then source lineage, address, title, and document fingerprints.
5. **Classify** — assign lifecycle stage, public/private class, document access, and bid-readiness with explicit reason codes.
6. **Verify** — re-check deadline, status, document routes, and addenda before admission and before each daily digest.
7. **Index** — extract permitted PDF text/OCR and section headings so multiple product/trade keywords search plans and specifications, not just notice titles.
8. **Enrich on demand** — when a user opens a project, refresh the official page, enumerate current documents, extract published project-team contacts, and flag contradictions.
9. **Retire** — remove a project from the primary queue immediately after cancellation, award, deadline expiration, or completion while retaining an audit history.

## Plans and drawings workflow

Every qualified card exposes the official plan/spec route. On opening a project:

- refresh the source and addenda index;
- download public files only when permitted, otherwise deep-link to the official signed-in portal;
- virus-scan, checksum, version, and label each retrieved file;
- render supported PDFs inside the app;
- preserve CAD/BIM files as downloadable originals when rights permit;
- extract cover-sheet parties, sheet index, specification divisions, alternates, approved manufacturers, and product keywords;
- show source, version, retrieved time, access restriction, and superseded status beside every file.

## Contact rules

Show published procurement contact, owner/agency, architect/engineer, construction manager, and named general contractors with role and source. Rank the outreach target based on the requested product and current stage. Do not manufacture private contact details or imply that a plan holder is a bidder.

Before opening, display only confirmed public plan holders or bidders when the issuer legally publishes them. After opening, ingest bid tabs and award notices and clearly label their effective date.

## Coverage dashboard that tells the truth

Do not use decorative state percentages. Report operational measures:

- issuing organizations discovered, validated, and actively monitored;
- connectors healthy, degraded, authentication-required, or failed;
- last successful fetch and last human-verified sample;
- open notices found, qualified, rejected, and rejection reasons;
- qualified opportunities with direct files versus portal sign-in;
- median detection delay, document completeness, deadline accuracy, and duplicate rate;
- source-level reconciliation against the publisher's current list.

A state is never marked “connected” merely because one agency in that state is connected.

## Rollout

### First 30 days

Harden the bid-readiness gate, SAM connector, Caltrans reference connector, source registry, connector-health telemetry, document refresh, and plan text extraction. Validate the top state/DOT and portal-family connectors by opportunity volume.

### Days 31–60

Deploy all state procurement and DOT connectors, the highest-leverage shared portal adapters, daily reconciliation, addendum alerts, on-demand contact extraction, and a manual source-review workbench.

### Days 61–90

Expand through the long-tail government registry by organization type and volume, add authenticated portal workflows with user-supplied credentials, onboard authorized private invitation feeds, and publish measured coverage gaps.

### Ongoing

Run daily source discovery, failure repair, sample verification, legal/access review, and coverage reconciliation. Expand internationally only by adding country-specific legal, procurement, language, and connector modules; do not relabel U.S. coverage as worldwide coverage.
