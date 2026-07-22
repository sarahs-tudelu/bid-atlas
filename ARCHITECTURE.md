# BidAtlas architecture

## Design goals

1. Keep the browser application static, typed, accessible, and same-origin with its API.
2. Keep HTTP concerns in thin FastAPI routers and domain behavior in testable services.
3. Keep project search read-only and snapshot-backed so upstream portal latency never affects a user request.
4. Preserve source evidence, distinguish partial coverage from completeness, and retain the last good partition on connector failure.
5. Keep mutable workspace data low-risk until real authentication and authorization are added.
6. Keep the AWS footprint isolated, encrypted, low-cost, and reproducible with CDK.

## Runtime request flow

```text
Browser
  |
  v
CloudFront
  +-- frontend route/static asset --> private frontend S3 bucket
  |                                  +-- no-cache index.html
  |                                  +-- immutable hashed assets
  |
  +-- /api/* or /health --> API Gateway HTTP API --> FastAPI Lambda
                                                   +-- catalog router
                                                   +-- outreach router
                                                   +-- workspace router
                                                         |
                               +-------------------------+--------------------+
                               v                                              v
                    private versioned catalog S3                    DynamoDB workspace table
                    (read-only to the API)                          (drafts, outreach, monitors)
```

The API begins with the packaged `data-export` snapshot. `ProjectCatalogProvider` checks the private S3 object version at a bounded five-minute cadence and swaps in a newly parsed immutable catalog only when the object changes. Searches never call a procurement portal.

## Scheduled ingestion flow

```text
EventBridge daily rule
  -> Northeast refresh Lambda
       -> fixed source adapters run independently
       -> source response host/size/page guards
       -> source-specific normalization
       -> deterministic canopy qualification where the source is broad
       -> optional SAM.gov state/query fan-out using an SSM SecureString
       -> replace successful partitions only
       -> retain failed partitions and mark their source degraded
       -> recompute inventory and coverage
       -> write a new version of current-projects.json to catalog S3
```

The active scheduled adapters cover:

- NJ DPMC and NJDOT public construction pages;
- MaineDOT and NYSDOT current construction pages;
- Connecticut CTsource and Rhode Island RIDOT public WebProcure boards;
- Massachusetts DCR and Pennsylvania DGS current construction listings;
- NHDOT and VTrans official ArcGIS project services;
- optional SAM.gov active federal notices by Northeast place of performance.

The WebProcure adapter uses normal hostname and certificate verification plus a checksum-pinned DigiCert `Thawte TLS RSA CA G1` intermediate for that host because the publisher currently omits the intermediate from its server chain. This host-specific trust-chain completion must be removed when the publisher repairs its TLS configuration or reviewed before the intermediate expires on November 2, 2027. Disabling TLS verification is not an accepted fallback.

Each source declares its state and coverage class. A live source can be partial even when it currently yields zero qualified records. No adapter marks a state complete.

## Frontend boundaries

`frontend/src/App.tsx` owns the route table. Route pages compose shared components and call `apiRequest` or `useApi`; they do not know where FastAPI runs. Local Vite proxying and CloudFront path routing keep the contract same-origin.

`ProjectResultsPage` treats URL query parameters as search state. Search profiles come from `/api/search-presets`, and cards display deterministic canopy-fit evidence returned with each project. `OutreachPage` owns project selection, editable message state, email-client handoff, and draft/sent history.

Browser contracts live in `frontend/src/types.ts`. Shared formatting, query serialization, loading/error states, responsive navigation, theme state, and feedback components remain outside route pages.

## Backend boundaries

- `backend/app/main.py` creates middleware, routers, health, OpenAPI, and the Mangum Lambda adapter.
- `api/catalog.py` validates read-only catalog/search input.
- `api/outreach.py` validates draft generation, editing, and explicit sent markers.
- `api/workspace.py` handles bid drafts, source monitors, and integration status.
- `services/catalog.py` loads, filters, scores, sorts, and pages one immutable snapshot.
- `services/canopy.py` owns deterministic scoring patterns and reusable search profiles.
- `services/outreach.py` selects published contacts and creates the default message without a network or LLM dependency.
- `services/source_refresh.py` owns partition replacement, degraded-source retention, and aggregate reconciliation.
- `services/northeast*.py` own source-specific guarded fetching and normalization.
- `services/state.py` owns DynamoDB/in-memory workspace persistence.

## Persistence

The checked-in snapshot is both deployment seed and failure fallback. The private versioned catalog bucket is the current runtime source. FastAPI has read-only catalog access; only the refresh Lambda writes the current catalog.

DynamoDB uses this device-workspace layout:

```text
owner                              recordKey                 payload
<device-id>@device.bidatlas        draft#<project-id>        JSON bid draft
<device-id>@device.bidatlas        outreach#<project-id>     JSON draft/sent outreach record
<device-id>@device.bidatlas        monitor#<uuid>            JSON source monitor
```

The browser supplies a random local-storage identifier through `X-BidAtlas-User`. This prevents accidental device-workspace mixing but is not authentication. Workspace records must not contain confidential bids, credentials, or sensitive personal data.

The documents bucket is provisioned for future protected ingestion. The active UI links official source documents and does not upload or proxy document bytes.

## Outreach security boundary

Draft generation uses only the project record and source-published contacts. It is deterministic, editable, and persisted per device workspace. **Open in email client** uses `mailto:` after saving; the backend does not send email. **Mark sent** is a separate explicit action and is not inferred from opening the client.

Server-side Gmail, SMTP, or SES delivery must not be added until BidAtlas has authenticated users, per-user provider authorization, abuse/rate controls, audit logs, revocation, and an endpoint-specific threat review. The current public device header cannot authorize a mail sender.

## Deployment

CDK bundles Python dependencies in the official Python 3.12 Lambda build image. Lambda uses x86-64 to match compiled wheels. Vite content-hashes frontend assets; CDK uploads them to private S3 and waits for CloudFront invalidation.

The regional refresh Lambda has catalog read/write access. When `samApiKeyParameterName` is supplied as CDK context, it receives `ssm:GetParameter` only for that parameter ARN and reads the SecureString at runtime. The key is never placed in Lambda environment variables or CloudFormation.

All resources belong to `BidAtlasStack`; no Canopy or Tudelu stack resource is imported or modified.

## Legacy and reference boundaries

`legacy/cloudflare` contains the former Next/Vinext routes, D1/R2 code, connector runtime, ingestion Worker, scripts, and tests. It is excluded from active package scripts and AWS assets.

The local `sam_dot_gov-main` folder was used only as a feature-design reference for scoring, presets, contacts, editable drafts, and sent history. It is ignored by Git and excluded from every runtime artifact. Reusable behavior was reimplemented within the active React/FastAPI architecture and its current security boundary.
