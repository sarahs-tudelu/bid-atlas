# BidAtlas

BidAtlas is Tudelu/Canopy’s construction-opportunity workspace. It collects source-backed public projects, ranks architectural-canopy potential, admits only opportunities with a published contact, lets a verified Tudelu user review prior Gmail contact, and sends reviewed outreach from that user’s own Gmail account.

- Production: <https://d9ubnak81sn3g.cloudfront.net>
- API documentation: <https://d9ubnak81sn3g.cloudfront.net/api/docs>
- AWS: `us-east-1`, stack `BidAtlasStack`

> Coverage is evidence, not a completeness claim. Counts on the Coverage page describe records observed through connected sources. They do not mean every public or private project in a state has been found.

## Required documentation rule

> Every future change must begin by reading this README, [`ARCHITECTURE.md`](ARCHITECTURE.md), and the relevant files in [`docs/`](docs/). If a change affects a user workflow, route, API, data contract, source connector, qualification rule, authentication boundary, secret, persistence model, AWS resource, test, or deployment step, update the corresponding documentation in the same commit.

Reviewers should reject a code change when the documented workflow no longer matches the implementation.

## End-to-end application workflow

```text
Official state pages / public bid boards / ArcGIS / SAM.gov Opportunities API
  -> Daily EventBridge invocation
  -> Northeast refresh Lambda fetches bounded, allowlisted sources
  -> Each successful source partition is normalized and replaced
  -> Failed partitions retain their prior records and are marked degraded
  -> Versioned, encrypted private S3 catalog
  -> FastAPI refreshes its in-memory catalog from S3 every five minutes
  -> Global admission gate requires BOTH:
       1. deterministic Canopy fit score >= 8
       2. at least one source-published, valid email contact
  -> React shows only admitted projects, companies, and document routes
  -> User signs in with a verified @tudelu.com Google account
  -> HttpOnly signed session identifies the user and their DynamoDB workspace
  -> Outreach generation reads Gmail metadata for published project contacts
  -> User selects a published recipient and reviews subject/body
  -> Explicit confirmation calls Gmail users.messages.send as the signed-in user
  -> Draft, metadata-only contact history, Gmail IDs, sender, and sent time are logged
```

The application uses the official SAM.gov Opportunities API when its API key is configured. It does not browser-scrape SAM.gov.
The connector paginates with the API’s documented maximum of 1,000 records per state/query page, deduplicates overlapping query results, and warns instead of silently claiming completeness if a query exceeds the guarded five-page ceiling. See the [official GSA API contract](https://open.gsa.gov/api/get-opportunities-public-api/).

## Technology stack

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Frontend | React 19, React Router 7 | Authenticated SPA, URL-driven search, bid desk, outreach |
| Frontend build | Vite 8, TypeScript 5.9 | Strict browser contracts and content-hashed assets |
| Styling | Plain CSS | Responsive UI and theme support |
| Backend | FastAPI, Python 3.12 | Auth, catalog/search, workspace, outreach, Gmail boundary |
| Lambda adapter | Mangum | API Gateway HTTP API to ASGI |
| Relevance | Deterministic Python rules | Canopy/proxy terms, NAICS boosts, false-positive penalties |
| Catalog | Amazon S3 | Private, encrypted, versioned source snapshot |
| Workspace | Amazon DynamoDB | Per-Tudelu-user drafts, OAuth account tokens, outreach logs, monitors |
| Secrets | AWS Systems Manager Parameter Store | Decrypted only at runtime under parameter-specific IAM grants |
| Email/auth | Google OAuth 2.0 with PKCE; Gmail API | Tudelu identity, message metadata, per-user sending |
| Scheduling | Amazon EventBridge | Daily Northeast ingestion |
| Compute | AWS Lambda | FastAPI API and scheduled connector runtime |
| Web delivery | CloudFront + private S3 | HTTPS SPA, security headers, static caching, API proxy |
| API ingress | API Gateway HTTP API | Same-origin `/api/*` and `/health` routing |
| Infrastructure | AWS CDK 2 / CloudFormation | Stack, IAM, buckets, table, functions, schedule, distribution |
| Verification | Vitest, Testing Library, Pytest, Ruff, ESLint, TypeScript | UI, API, connector, security, and static checks |

Exact versions are pinned in `frontend/package.json`, `backend/requirements*.txt`, and `infra/package.json`.

## Product and data rules

### Visibility admission gate

`services/qualification.py` is the single product-wide visibility rule. A project is visible only when:

- `score_project(project).score >= 8`; and
- `published_contacts(project)` contains at least one valid email explicitly present in the source record.

This gate applies before search, exact-project lookup, dashboard cards, company aggregation, document aggregation, and outreach. Raw source counts remain visible only in coverage/inventory reporting so connector health stays auditable. Search metadata reports both raw snapshot count and qualified count.

The score is a prioritization signal, not a claim that the notice definitively contains Canopy scope. Users must verify the official source.

### Canopy scoring

Positive evidence includes architectural/metal/entrance canopies, covered walkways, shade structures, passenger shelters, entrance/facade work, inspection gates, pavilions, awnings, relevant fabrication, and selected NAICS codes. Tree canopy, aircraft/parachute canopy, fabric tents, equipment parts, and electrical service entrances receive negative weights.

Reusable profiles are returned by `GET /api/search-presets`. `direct_northeast` covers CT, ME, MA, NH, RI, VT, NY, NJ, and PA with the same minimum score as the global admission gate.

### Contact and email rules

- Contacts must be published with the source record; BidAtlas does not manufacture or enrich a recipient.
- The server revalidates the recipient against the current project on save and send. A modified browser cannot turn the API into an arbitrary relay.
- Every send requires a signed-in, verified `@tudelu.com` user and an explicit UI confirmation.
- Gmail sends as `users/me`; no shared SMTP identity is used.
- A per-project conditional DynamoDB lock prevents concurrent duplicate sends.
- Sent records cannot be edited, regenerated, or resent.
- Gmail history stores only From, To, Subject, Date, a short snippet, and Gmail message/thread IDs. Full inbox bodies are not persisted.
- OAuth access/refresh tokens are stored only in the encrypted DynamoDB table and are never returned to React.

## User workflows

### Sign in and session

1. React calls `GET /api/auth/me` with credentials.
2. Without a valid HttpOnly session cookie it shows the login screen.
3. `GET /api/auth/google/start` creates state and a PKCE verifier/challenge, stores the signed state in a short-lived HttpOnly cookie, and redirects to Google.
4. The callback verifies state, exchanges the authorization code, loads Google identity, and rejects unverified or non-`@tudelu.com` accounts.
5. Tokens are stored under that email’s DynamoDB partition. A separate 12-hour signed HttpOnly, Secure, SameSite=Lax cookie is issued.
6. Sign-out deletes the browser session cookie. Reconnecting Google replaces provider tokens while preserving an existing refresh token when Google does not return a new one.

Required Google scopes are `openid`, `email`, `profile`, `gmail.send`, and `gmail.readonly`. Production’s authorized redirect URI must exactly equal:

```text
https://d9ubnak81sn3g.cloudfront.net/api/auth/google/callback
```

### Find projects and leads

1. `/projects` requests bid-ready projects; `/leads` includes earlier actionable lifecycle stages.
2. URL query parameters represent keywords, location, state, deadline, stage, freshness, profile, archive flag, page, and page size.
3. FastAPI starts from the admitted catalog, applies filters, calculates `canopyFit`, sorts, and paginates.
4. Cards link to the official source, internal Bid Desk, and Gmail outreach.

A bid-ready result additionally requires bidding stage, a non-expired deadline, and an official document route.

### Bid desk and monitors

Bid Desk loads project evidence beside the user’s internal draft. `GET/POST /api/bid-drafts` persists it under the signed-in email. Source monitors accept a name and an allowlisted public `https://` URL and store a `pending-review` record; registering a monitor does not automatically fetch or publish the source.

### Gmail outreach

1. `/outreach?project=<id>` selects an admitted project.
2. `POST /api/outreach/generate` chooses the first source-published contact, creates an editable Tudelu introduction, and queries Gmail for messages to/from all published contacts.
3. The user can switch only among published contacts, edit subject/body, save, refresh Gmail context, or regenerate an unsent draft.
4. **Send with Gmail** shows an explicit sender/recipient confirmation.
5. `POST /api/outreach/send` revalidates project, recipient, subject, body, prior sent state, and duplicate-send lock before calling Gmail.
6. The stored sent record includes `sentAt`, `sentBy`, `gmailMessageId`, and `gmailThreadId`.
7. `/api/outreach/history` restores the authenticated user’s drafts and sent records.

### Coverage and ingestion

Coverage separates raw connected-source inventory from the admitted Canopy queue. The daily refresh currently includes:

- NJ DPMC and NJDOT;
- NYDOT and MaineDOT;
- Connecticut and Rhode Island WebProcure boards;
- Massachusetts DCR and Pennsylvania DGS;
- New Hampshire DOT and Vermont VTrans/ArcGIS;
- SAM.gov federal opportunities, fanned out by each Northeast state and canopy/proxy query.

All state coverage remains `partial`: these are named agencies/boards, not every municipality, school, authority, permit office, platform, or private project. See [`docs/NATIONAL_BID_COVERAGE_PLAN.md`](docs/NATIONAL_BID_COVERAGE_PLAN.md).

## Browser route and API map

| Browser route | React page | Main APIs |
| --- | --- | --- |
| `/` | `HomePage` | `/api/dashboard` |
| `/projects` | `ProjectsPage` | `/api/search`, `/api/search-presets` |
| `/leads` | `LeadsPage` | `/api/search`, `/api/search-presets` |
| `/companies` | `CompaniesPage` | `/api/companies` |
| `/documents` | `DocumentsPage` | `/api/documents/search` |
| `/bid-desk` | `BidDeskPage` | `/api/projects/{id}`, `/api/bid-drafts` |
| `/outreach` | `OutreachPage` | `/api/outreach/*` |
| `/coverage` | `CoveragePage` | `/api/coverage` |
| `/source-monitor` | `SourceMonitorPage` | `/api/source-monitors` |
| `/integrations` | `IntegrationsPage` | `/api/integrations` |

| Method | API | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Runtime health |
| `GET` | `/api/meta`, `/dashboard`, `/projects`, `/projects/{id}` | Public | Qualified catalog |
| `GET` | `/api/search`, `/search-presets` | Public | Filtered discovery and scoring profiles |
| `GET` | `/api/coverage`, `/source-registry`, `/jurisdictions` | Public | Coverage and source evidence |
| `GET` | `/api/companies`, `/documents/search` | Public | Qualified-project aggregates |
| `GET` | `/api/auth/google/status`, `/google/start`, `/google/callback` | Public OAuth flow | Google configuration and login |
| `GET` | `/api/auth/me` | Session | Current Tudelu user |
| `POST` | `/api/auth/logout` | Cookie | End browser session |
| `GET/POST` | `/api/bid-drafts`, `/api/source-monitors` | Session | Per-user workspace |
| `GET` | `/api/integrations` | App-gated | Connector status, never secret values |
| `GET` | `/api/outreach/draft`, `/history` | Session | Per-user outreach records |
| `POST` | `/api/outreach/generate`, `/gmail-history` | Session + Google | Draft and Gmail metadata sync |
| `PUT` | `/api/outreach/draft` | Session | Save reviewed draft |
| `POST` | `/api/outreach/send` | Session + Google | Send from the logged-in Gmail account |

FastAPI publishes the authoritative request/response schema at `/api/docs`.

## Repository map

```text
frontend/src/
  api/client.ts             credentialed same-origin HTTP client
  hooks/useAuth.tsx         session provider and sign-out
  pages/LoginPage.tsx       Tudelu Google login gate
  pages/OutreachPage.tsx    Gmail history, draft review, confirmed sending
  pages/*                   discovery, coverage, companies, documents, bid desk
  components/*              shell, cards, filters, loading/error feedback
  types.ts                  browser API contracts

backend/app/
  api/auth.py               OAuth start/callback, session, logout
  api/catalog.py            public qualified catalog endpoints
  api/outreach.py           authenticated history/draft/send boundary
  api/workspace.py          authenticated drafts/monitors and integration status
  services/auth.py          domain validation and signed tokens
  services/google.py        OAuth, token refresh, Gmail metadata and send
  services/qualification.py global contact + Canopy admission rule
  services/canopy.py        deterministic scoring and profiles
  services/catalog*.py      S3/local snapshot loading, search, aggregation
  services/northeast*.py    Northeast state and SAM.gov connectors
  services/source_refresh.py partition-safe merge and coverage reconciliation
  services/state.py         DynamoDB/in-memory persistence and send locks
  jobs/refresh_northeast.py scheduled Lambda entry point

data-export/                deploy seed, registry, coverage and provenance
infra/                      AWS CDK stack and context
scripts/                    local regional refresh tooling
docs/                       domain plans and operating documentation
legacy/cloudflare/          archived prior runtime, excluded from deployment
sam_dot_gov-main/           ignored reference application, excluded from Git/AWS assets
```

The SAM reference application’s SQLite/DynamoDB content and historical OAuth tokens are not imported into BidAtlas. Only reusable behavior was reimplemented. Values from its ignored `.env` are promoted to new BidAtlas SSM SecureStrings during deployment without exposing values in Git or CloudFormation.

## Persistence and AWS architecture

```text
CloudFront
  +-- default route -> private frontend S3 (Origin Access Control)
  +-- /api/*, /health -> API Gateway HTTP API -> FastAPI Lambda

FastAPI Lambda
  +-- read catalog S3
  +-- read/write DynamoDB workspace
  +-- decrypt only Google client ID, client secret, and session secret parameters

EventBridge (daily 10:15 UTC)
  -> Northeast refresh Lambda
       +-- decrypt only SAM API key parameter
       +-- read/write versioned catalog S3
```

DynamoDB keys:

```text
owner=<verified Tudelu email>  recordKey=google#account                  encrypted OAuth account
owner=<verified Tudelu email>  recordKey=draft#<project-id>             bid draft
owner=<verified Tudelu email>  recordKey=outreach#<project-id>          draft/history/sent audit
owner=<verified Tudelu email>  recordKey=gmail-send-lock#<project-id>   conditional transient lock
owner=<verified Tudelu email>  recordKey=monitor#<uuid>                 source review item
```

The table uses AWS-managed encryption, on-demand billing, point-in-time recovery, and `RETAIN`. Catalog and document buckets are private, encrypted, TLS-only, versioned, and retained. The frontend bucket is private and disposable because CDK can rebuild it.

## Configuration and secrets

Copy `.env.example` for local development. Never commit `.env` files.

Production parameter names are nonsecret CDK context in `infra/cdk.json`:

- `/BidAtlas/sam-api-key`
- `/BidAtlas/google-client-id`
- `/BidAtlas/google-client-secret`
- `/BidAtlas/session-secret`

Values must be `SecureString`s. CDK passes parameter names—not values—to Lambda, and IAM grants `ssm:GetParameter` only on the required ARNs. Google OAuth values belong only to the API Lambda; the SAM key belongs only to the refresh Lambda.

## Local development

Prerequisites: Node 22+, Python 3.12+, and AWS CLI/CDK only for AWS operations.

```powershell
npm install
python -m pip install -r backend/requirements-dev.txt
npm run dev
```

Vite runs on `http://localhost:5173` and proxies `/api` and `/health` to FastAPI on `http://localhost:8000`. Configure a Google OAuth web client redirect for `http://localhost:8000/api/auth/google/callback` and use direct `BIDATLAS_GOOGLE_*` environment values locally.

Optional local source refresh:

```powershell
$env:SAM_API_KEY = "<local key>"
python scripts/refresh_northeast_snapshot.py
```

This modifies `data-export` and should be reviewed like any source-data change.

## Verification and deployment

```powershell
npm run lint
npm test
npm run build
npm run synth:aws
npm run deploy:aws
```

Deployment builds React, bundles FastAPI for Python 3.12 x86-64, updates CloudFormation, uploads the frontend and catalog seed, and invalidates CloudFront for `index.html`. After deployment:

1. verify `/health`, `/api/meta`, and `/api/auth/google/status`;
2. invoke the regional refresh Lambda once and confirm `samConfigured: true`;
3. verify every returned `/api/search` project has a published email and score of at least 8;
4. complete a Tudelu Google login and confirm Gmail history loads;
5. use a controlled recipient/project before performing any live send test.

Do not send a production email merely as an infrastructure smoke test.
