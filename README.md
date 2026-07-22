# BidAtlas

BidAtlas is a public-record construction intelligence application. It helps users find construction opportunities, inspect the official evidence behind each record, follow projects before and during bidding, and keep internal bid notes.

The active application is a Vite/React single-page application backed by FastAPI and deployed in an isolated AWS serverless stack.

> **Coverage rule:** Loaded records are records observed through connected public sources. They are not a claim of complete United States construction coverage. The application must preserve this distinction in its interface, APIs, and documentation.

## Documentation maintenance rule

> **Required for every future change:** Before changing BidAtlas, read this README, [`ARCHITECTURE.md`](ARCHITECTURE.md), and any relevant file in [`docs/`](docs/). If a change affects a workflow, route, API contract, data source, persistence rule, security boundary, environment variable, test command, deployment step, or AWS resource, update the corresponding documentation in the same change. Documentation and implementation must not be allowed to drift.

Use this documentation checklist when opening or reviewing future work:

1. Identify the user workflow and technical boundary being changed.
2. Read the relevant sections of this README and `ARCHITECTURE.md` before editing code.
3. Check the domain plans in `docs/` when the change concerns national coverage or company intelligence.
4. Update route, endpoint, data-flow, security, testing, and deployment descriptions affected by the change.
5. Run the documented verification commands and record any new operational caveat.

## Current deployment

- Application: <https://d9ubnak81sn3g.cloudfront.net>
- API documentation: <https://d9ubnak81sn3g.cloudfront.net/api/docs>
- AWS region: `us-east-1`
- CloudFormation stack: `BidAtlasStack`

## Application workflow at a glance

```text
Checked-in public-source snapshot seeds a private S3 catalog
  -> Daily NJ refresh reads official DPMC and NJDOT pages
  -> FastAPI checks the S3 catalog and indexes the latest version
  -> User opens the React application through CloudFront
  -> User searches open bids or explores earlier project leads
  -> FastAPI filters, sorts, and paginates source-backed records
  -> User verifies the official source and document routes
  -> User opens a project in Bid Desk
  -> Draft notes are stored in the device workspace in DynamoDB
  -> Coverage and source views explain what is connected and what is missing
```

The AWS runtime remains snapshot-backed, but New Jersey is now the first migrated scheduled source group. EventBridge refreshes official DPMC construction advertisements and NJDOT advertised construction projects daily into a private versioned S3 catalog. The former connector network remains under `legacy/cloudflare` while other sources await migration to equivalent scheduled Python jobs.

## Complete runtime architecture

```text
Browser
  |
  v
Amazon CloudFront
  |
  +-- Frontend route or static asset
  |     |
  |     +-- CloudFront SPA rewrite for extensionless routes
  |     +-- Private S3 frontend bucket through Origin Access Control
  |           +-- index.html: no-cache, no-store, must-revalidate
  |           +-- hashed JS/CSS assets: one-year immutable cache
  |
  +-- /api/* or /health
        |
        v
      API Gateway HTTP API
        |
        v
      AWS Lambda, Python 3.12 x86-64
        |
        +-- Mangum ASGI adapter
        +-- FastAPI application
              |
              +-- Catalog API
              |     +-- ProjectCatalog
              |     +-- five-minute S3 version check
              |     +-- JurisdictionCatalog
              |     +-- checked-in data-export fallback
              |
              +-- Workspace API
                    +-- WorkspaceStore
                    +-- DynamoDB in AWS
                    +-- in-memory store during local tests

Private, versioned S3 documents bucket
  -> Provisioned for protected document content
  -> Not yet used by the current React document-route workflow

EventBridge daily schedule
  -> New Jersey refresh Lambda
  -> Official NJ DPMC and NJDOT public pages
  -> Private, encrypted, versioned catalog S3 bucket
```

## Technology stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend framework | React 19 | Component-based browser interface |
| Frontend routing | React Router 7 | Client-side route selection and URL state |
| Frontend build | Vite 8 | Local development, asset bundling, and content hashing |
| Frontend language | TypeScript 5.9 | Strict UI types and API contracts |
| Frontend styling | Plain CSS | Responsive visual system without a runtime CSS framework |
| Backend framework | FastAPI 0.116 | Typed HTTP API and generated OpenAPI documentation |
| Lambda adapter | Mangum 0.19 | Translates API Gateway events into ASGI requests |
| Backend language | Python 3.12 | Catalog, filtering, pagination, and workspace services |
| Public catalog data | JSON exports and private versioned S3 | Checked-in deployment seed plus daily New Jersey refreshes |
| Mutable state | Amazon DynamoDB | Device-workspace drafts and registered source monitors |
| Document storage | Amazon S3 | Private, encrypted, versioned document-object boundary |
| Frontend storage | Amazon S3 | Private static assets accessed only through CloudFront |
| Edge delivery | Amazon CloudFront | HTTPS, SPA routing, security headers, and caching |
| API ingress | API Gateway HTTP API | Public `/api/*` and `/health` routing to Lambda |
| Compute | AWS Lambda | Serverless FastAPI runtime |
| Infrastructure | AWS CDK 2 / CloudFormation | Reproducible AWS resource definitions and deployment |
| Frontend tests | Vitest and Testing Library | React route and component behavior |
| Backend tests | Pytest and FastAPI TestClient | API contracts and workspace persistence |
| Static checks | ESLint, TypeScript, Ruff | Frontend, infrastructure, and Python validation |

Exact dependency versions are pinned in `frontend/package.json`, `backend/requirements*.txt`, and `infra/package.json`.

## Repository map

```text
BidAtlas/
  frontend/
    src/
      api/                 Browser HTTP client and query serialization
      components/          Shared navigation, cards, filters, and states
      hooks/               Reusable API-loading behavior
      pages/               Route-level React workflows
      test/                Browser test setup
      App.tsx              Route table
      main.tsx             Browser entry point
      styles.css           Shared responsive visual system
      types.ts             Browser-side project and coverage contracts
    index.html             Vite HTML entry point and social metadata
    vite.config.ts         Local proxy, build, and test configuration

  backend/
    app/
      api/
        catalog.py         Read-only catalog and discovery endpoints
        workspace.py       Draft, monitor, and integration endpoints
      services/
        catalog.py         Snapshot loading, filtering, paging, and aggregation
        state.py           DynamoDB and local workspace persistence
      config.py            Environment-derived runtime settings
      dependencies.py      Cached service construction
      main.py              FastAPI application and Lambda handler
    tests/                 FastAPI contract tests
    requirements.txt       Lambda runtime dependencies
    requirements-dev.txt   Local development and test dependencies

  data-export/
    current-projects.json  Runtime project/source/coverage snapshot
    source-registry.json   Runtime state/DC source registry
    all_50_us_states_and_cities_2025.txt
                           Runtime incorporated-place fallback
    coverage.json          Exported coverage audit artifact
    database-verification.json
                           Source-database verification artifact
    manifest.json          Export provenance and scope notes

  infra/
    bin/bidatlas.ts        CDK application entry point
    lib/bidatlas-stack.ts  AWS resources, permissions, caching, and outputs
    cdk.json               CDK bootstrap and application configuration

  docs/
    NATIONAL_BID_COVERAGE_PLAN.md
                           National source-coverage plan and constraints
    NY_NJ_PUBLIC_COMPANY_WORKFLOW.md
                           NY/NJ company-evidence workflow

  legacy/cloudflare/       Archived Next/Vinext, D1, R2, connector, and Worker code
  ARCHITECTURE.md          Detailed component boundaries and design decisions
```

Generated directories such as `frontend/dist`, `infra/cdk.out`, caches, and installed dependencies are ignored and are not source-of-truth documentation.

## User workflows

### 1. Open the application

1. The browser requests `/` or a direct route from CloudFront.
2. CloudFront serves `index.html` from the private frontend bucket.
3. Extensionless routes such as `/projects` are rewritten to `index.html` so browser refreshes work.
4. React starts in `frontend/src/main.tsx`.
5. `frontend/src/App.tsx` selects the page using React Router.
6. `AppShell` renders global navigation, the coverage warning, and the footer.

### 2. Search qualified open bids

1. The user opens `/projects`.
2. `ProjectResultsPage` reads filters from the URL so searches can be bookmarked or shared.
3. The frontend calls `GET /api/search` with `readiness=bid-ready` and `freshness=actionable`.
4. `ProjectCatalog` applies keyword, location, state, deadline, stage, freshness, archive, and readiness rules.
5. A bid-ready result must be in the bidding stage, have a current deadline, and have at least one official document route.
6. Results are deadline-sorted, paginated, and returned with snapshot and completeness metadata.
7. Each card links to the official public source and the internal Bid Desk.

### 3. Explore earlier project leads

1. The user opens `/leads`.
2. The same search endpoint is used without the bid-ready restriction.
3. The user can filter planning, design, permitting, bidding, award, or construction records.
4. Completed and cancelled records remain excluded unless a future workflow explicitly enables archived records.
5. This keeps early intelligence separate from the stricter open-bid index.

### 4. Review company evidence

1. The user opens `/companies`.
2. The frontend calls `GET /api/companies`.
3. `ProjectCatalog.companies()` aggregates organizations named literally in project participants.
4. Agency-only participants are excluded from the company list.
5. Each company shows its role, connected project count, states, and sample project links.
6. This is source-published evidence, not inferred ownership or contractor identity.

### 5. Review document routes

1. The user opens `/documents`, optionally with a project or text filter.
2. The frontend calls `GET /api/documents/search`.
3. FastAPI flattens project document references while preserving their project relationship.
4. The UI displays document kind, access requirement, project title, and the official URL.
5. Current production behavior links to official document routes; it does not upload or proxy document bytes.

### 6. Build a bid draft

1. The user selects a project and opens `/bid-desk?project=<id>`.
2. The frontend loads the exact project with `GET /api/projects/{projectId}`.
3. It shows official source details, documents, and published participants beside the internal draft form.
4. The browser creates a random device workspace identifier and sends it as `X-BidAtlas-User`.
5. `GET /api/bid-drafts?projectId=<id>` restores an existing draft.
6. `POST /api/bid-drafts` stores scope, exclusions, notes, and an update timestamp.
7. In AWS, `WorkspaceStore` writes the record to DynamoDB. Locally, it uses an in-memory store.

The device identifier prevents accidental workspace mixing but is not authentication. Do not store confidential pricing, personal information, credentials, or submission secrets until an identity provider is added.

### 7. Register a source for review

1. The user opens `/source-monitor`.
2. The frontend loads device-workspace monitors with `GET /api/source-monitors`.
3. A submitted source must have a name and public `https://` URL.
4. `POST /api/source-monitors` saves it with `pending-review` status.
5. The current AWS runtime does not fetch, classify, scan, or publish that source automatically.
6. The former scanning implementation remains under `legacy/cloudflare` as migration reference.

### 8. Inspect integration status

1. The user opens `/integrations`.
2. The frontend calls `GET /api/integrations`.
3. The API returns capability metadata for SAM.gov and Apollo without returning credentials.
4. Both integrations remain disabled until their AWS runtime configuration and controlled workflows are implemented.

### 9. Audit national coverage

1. The user opens `/coverage`.
2. The frontend calls `GET /api/coverage`.
3. The page shows registry size, loaded records, connected and identified source groups, and national completeness.
4. The state/DC matrix distinguishes identified, partial, and not-connected source classes.
5. Official procurement and DOT links remain available for source-level verification.

## Route, component, and API map

| Browser route | Primary React page | API calls | Main purpose |
| --- | --- | --- | --- |
| `/` | `HomePage` | `GET /api/dashboard` | Product summary, metrics, sample records |
| `/projects` | `ProjectsPage` -> `ProjectResultsPage` | `GET /api/search` | Strict, bid-ready opportunities |
| `/leads` | `LeadsPage` -> `ProjectResultsPage` | `GET /api/search` | Broader connected project pipeline |
| `/companies` | `CompaniesPage` | `GET /api/companies` | Source-published organization evidence |
| `/documents` | `DocumentsPage` | `GET /api/documents/search` | Official document routes |
| `/bid-desk` | `BidDeskPage` | `GET /api/projects/{id}`, `GET/POST /api/bid-drafts` | Evidence review and internal draft notes |
| `/coverage` | `CoveragePage` | `GET /api/coverage` | State/DC connection ledger |
| `/source-monitor` | `SourceMonitorPage` | `GET/POST /api/source-monitors` | Device-workspace source review queue |
| `/integrations` | `IntegrationsPage` | `GET /api/integrations` | Connector capability status |
| `/api/docs` | FastAPI Swagger UI | `GET /api/openapi.json` | Interactive API reference |

## API map

### Operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service health check |
| `GET` | `/api/meta` | Backend, snapshot, source, and completeness metadata |
| `GET` | `/api/docs` | Swagger UI |
| `GET` | `/api/openapi.json` | OpenAPI schema |

### Catalog and discovery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/dashboard` | Home-page feed, sources, coverage, inventory, and warnings |
| `GET` | `/api/projects` | Current catalog feed |
| `GET` | `/api/projects/{projectId}` | Exact project lookup |
| `GET` | `/api/search` | Filtered and paged project search |
| `GET` | `/api/coverage` | Coverage, inventory, sources, and warnings |
| `GET` | `/api/source-registry` | State/DC procurement and DOT source registry |
| `GET` | `/api/jurisdictions` | Incorporated-place fallback search |
| `GET` | `/api/companies` | Aggregated source-published organizations |
| `GET` | `/api/documents/search` | Flattened official document routes |

`GET /api/search` accepts these principal parameters:

- `keywords`: comma-separated terms or quoted phrases.
- `location`: free-text location match across searchable fields.
- `match`: `all`, `any`, or `exact`.
- `stage`: a project lifecycle stage or `all`.
- `state`: state code, state name, or `all`.
- `due`: `all`, `today`, `7-days`, or `14-days`.
- `freshness`: actionable, closed/inactive, or broad catalog mode.
- `readiness`: `all` or `bid-ready`.
- `includeArchived`: whether completed/cancelled stages may appear.
- `page`: one-based page number.
- `limit`: `10`, `25`, or `50`.

### Workspace

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/bid-drafts?projectId=<id>` | Restore one device-workspace draft |
| `POST` | `/api/bid-drafts` | Save one device-workspace draft |
| `GET` | `/api/source-monitors` | List device-workspace source registrations |
| `POST` | `/api/source-monitors` | Register a public HTTPS source for review |
| `GET` | `/api/integrations` | Return connector capability metadata only |

## Data workflow and contracts

### Runtime snapshot loading

FastAPI constructs services through cached dependencies in `backend/app/dependencies.py`. `ProjectCatalogProvider` starts with the packaged snapshot, checks the private S3 catalog at most every five minutes, and atomically replaces its in-memory `ProjectCatalog` only when the object version changes. A temporary S3 failure leaves the last good catalog in service.

Runtime inputs are:

- `data-export/current-projects.json`: projects, active sources, coverage summary, inventory, warnings, and generation timestamp.
- `data-export/source-registry.json`: state/DC discovery roots and coverage context.
- `data-export/all_50_us_states_and_cities_2025.txt`: incorporated-place fallback used by jurisdiction search.

AWS also seeds these exports into the private catalog bucket. The daily New Jersey job replaces only the two New Jersey source partitions, recomputes inventory and coverage counts, and writes a new version of `current-projects.json`. It retains the previous records for an individual source when that source cannot be refreshed.

The remaining files in `data-export` document export provenance and database verification but are not currently loaded by FastAPI.

### Search behavior

`ProjectCatalog` normalizes double-encoded punctuation inherited from the legacy export, indexes projects by ID, builds searchable text from official record fields, and applies filtering in memory. It does not infer facts missing from the source record.

Project results keep the original source URL, source record ID, lifecycle stage, official document routes, published participants, value, location, and timestamps when available.

### Workspace data model

DynamoDB uses a composite primary key:

```text
owner                              recordKey                 payload
<device-id>@device.bidatlas        draft#<project-id>        JSON bid draft
<device-id>@device.bidatlas        monitor#<uuid>            JSON source monitor
```

Each stored payload receives an ISO 8601 `updatedAt` timestamp. The table uses on-demand billing, AWS-managed encryption, point-in-time recovery, and a retain policy.

### Document boundary

The AWS stack provisions a private, encrypted, versioned documents bucket and grants the FastAPI role read/write access. The active API does not yet expose upload or download endpoints, so the bucket is an infrastructure boundary for future protected ingestion rather than an active user workflow.

## Frontend behavior

- URL query parameters are the source of truth for project and company searches.
- API requests are same-origin in local and deployed environments.
- The browser HTTP boundary is centralized in `frontend/src/api/client.ts`.
- The API base can be overridden with `VITE_API_BASE_URL`; the default is the current origin.
- A random device workspace ID is stored in browser local storage and sent on API requests.
- Loading, failure, empty, pagination, and evidence states use shared components.
- The layout is responsive and includes reduced-motion handling.

## Backend behavior

- `backend/app/main.py` creates FastAPI, CORS, routers, `/health`, OpenAPI, and the Lambda handler.
- API modules validate HTTP input and delegate business behavior to services.
- Catalog services are immutable after loading.
- The catalog provider refreshes the immutable view from S3 at a bounded five-minute cadence.
- The New Jersey refresh Lambda accepts data only from the two allowlisted official `nj.gov` pages, enforces HTTPS, response-size limits, and official-host redirects, and runs daily.
- Workspace writes use DynamoDB only when `BIDATLAS_WORKSPACE_TABLE` is configured.
- Local development and tests use a thread-safe in-memory workspace store.
- API errors use normal FastAPI status codes and JSON detail messages.

## Environment variables

| Variable | Used by | Purpose | Default |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | Frontend build | Optional API origin override | Same origin |
| `BIDATLAS_ENVIRONMENT` | FastAPI | Environment label | `development` |
| `BIDATLAS_DATA_DIR` | FastAPI | Directory containing runtime export files | Repository `data-export/` |
| `BIDATLAS_CATALOG_BUCKET` | FastAPI and refresh job | Private S3 bucket containing the current catalog | Packaged snapshot only when unset |
| `BIDATLAS_CATALOG_KEY` | FastAPI and refresh job | S3 object key for the current project catalog | `current-projects.json` |
| `BIDATLAS_CATALOG_REFRESH_SECONDS` | FastAPI | Minimum interval between S3 catalog version checks | `300` |
| `BIDATLAS_WORKSPACE_TABLE` | FastAPI | DynamoDB table name | In-memory store when unset |
| `BIDATLAS_DOCUMENTS_BUCKET` | FastAPI | Private documents bucket name | Unset locally |
| `BIDATLAS_CORS_ORIGINS` | FastAPI | Comma-separated browser origins | `http://localhost:5173` |
| `AWS_REGION` | CDK/AWS SDK | Deployment or runtime region | `us-east-1` through CDK |
| `CDK_DEFAULT_ACCOUNT` | CDK | Target AWS account | Derived from AWS CLI credentials |
| `CDK_DEFAULT_REGION` | CDK | Target AWS region | `AWS_REGION` or `us-east-1` |

Do not commit `.env` files, API keys, access tokens, AWS credentials, customer data, bid pricing, or personal information.

## Local development workflow

Requirements:

- Node.js 22.13 or newer
- Python 3.12 or newer
- Docker for Lambda dependency packaging during CDK synthesis/deployment
- AWS CLI only when synthesizing against or deploying to AWS

Install dependencies:

```powershell
npm install
python -m pip install -r backend\requirements-dev.txt
```

Start React and FastAPI together:

```powershell
npm run dev
```

Local endpoints:

- React: `http://localhost:5173`
- FastAPI: `http://localhost:8000`
- API docs: `http://localhost:8000/api/docs`
- Health: `http://localhost:8000/health`

Vite proxies `/api` and `/health` to FastAPI, so frontend code uses the same relative URLs locally and in AWS.

## Verification workflow

Run the complete local verification set before deployment:

```powershell
npm test
npm run lint
npm run build
npm audit --omit=dev
npm run synth:aws
```

What each command covers:

- `npm test`: Vitest frontend tests followed by Pytest backend tests.
- `npm run lint`: ESLint, infrastructure TypeScript type checking, and Ruff.
- `npm run build`: strict TypeScript compilation and the Vite production build.
- `npm audit --omit=dev`: dependencies shipped in the application runtime.
- `npm run synth:aws`: frontend rebuild plus CDK/CloudFormation synthesis and Lambda packaging.

After deployment, verify at minimum:

```text
GET /
GET /projects
GET /health
GET /api/meta
GET /api/search?readiness=bid-ready&limit=10
GET /api/docs
```

Also verify:

- Direct frontend routes return `200` and `text/html`.
- `index.html` returns `Cache-Control: no-cache, no-store, must-revalidate`.
- Hashed JS/CSS assets return `Cache-Control: public, max-age=31536000, immutable`.
- API routes return JSON rather than the React application.
- CloudFormation reports `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
- CloudFront reports `Deployed` before announcing success.
- A temporary draft can be written and restored through CloudFront, then removed from DynamoDB.

## AWS deployment workflow

Confirm the target account before making changes:

```powershell
aws sts get-caller-identity --region us-east-1
```

Review the infrastructure change:

```powershell
npm run build
Set-Location infra
npx cdk diff BidAtlasStack --no-change-set
Set-Location ..
```

Deploy:

```powershell
npm run deploy:aws
```

The deploy command builds the frontend and deploys `BidAtlasStack` without interactive approval. CDK packages only `backend/app`, runtime Python dependencies, and `data-export` into the Lambda asset.

### AWS resources

`BidAtlasStack` owns:

- CloudFront distribution with SPA rewrite and API behaviors.
- Private S3 frontend bucket with Origin Access Control.
- API Gateway HTTP API.
- Python 3.12 x86-64 Lambda function running FastAPI through Mangum.
- DynamoDB workspace table using on-demand billing and point-in-time recovery.
- Private, encrypted, versioned documents S3 bucket.
- Private, encrypted, versioned catalog S3 bucket seeded from `data-export`.
- Daily EventBridge rule and Python Lambda for official NJ DPMC and NJDOT refreshes.
- CloudWatch API log group with one-week retention.
- Deployment support resources and least-scope application IAM permissions.

The workspace table, documents bucket, and catalog bucket use `RETAIN`. The generated frontend bucket is disposable because it can be rebuilt from source. All resources carry the `Project=BidAtlas` tag and remain independent from the Canopy and Tudelu stacks.

### CloudFront routing and caching

- Default behavior: private frontend S3 origin.
- `api/*`: API Gateway origin, caching disabled, all API methods allowed.
- `health`: API Gateway origin, caching disabled.
- Extensionless frontend routes: rewritten to `/index.html` by a CloudFront Function.
- `index.html`: no-cache, no-store, must-revalidate.
- Hashed and static assets: public one-year immutable cache.
- Frontend deployment waits for the `/*` invalidation to complete.

## Security boundaries and known limitations

- S3 public access is blocked for the frontend, document, and catalog buckets.
- CloudFront accesses frontend objects using Origin Access Control.
- DynamoDB and S3 use encryption at rest.
- Document objects are versioned and retained.
- FastAPI receives only the permissions required for its workspace table, documents bucket, and read-only catalog access. The scheduled NJ job receives catalog read/write access only.
- API responses do not expose integration credentials.
- The API is publicly reachable through CloudFront and API Gateway.
- Device workspace identifiers are pseudonymous isolation keys, not authenticated identities.
- Source monitor registration does not currently fetch untrusted URLs.
- Document upload, download, extraction, and rights enforcement are not active in the AWS API.
- The catalog is still partial. Only NJ DPMC and NJDOT currently have scheduled AWS refreshes; New Jersey municipalities, counties, schools, authorities, NJSTART listings outside DPMC construction, permits, and planning sources are not yet connected.

Before enabling confidential drafts, uploads, enrichment, or automated source fetching, add a real identity provider, authorization checks, request limits, data classification, audit logging, and endpoint-specific threat review.

## Data freshness and migration status

The deployed API serves the latest private S3 `current-projects.json`, falling back to the packaged `data-export/current-projects.json`. Its generation timestamp is returned by `/api/meta` and displayed in the product. Deployments seed the S3 object; the daily New Jersey job then refreshes DPMC and NJDOT records without requiring a site deployment.

The previous implementation remains in `legacy/cloudflare` and includes:

- Next/Vinext server-rendered pages and route handlers.
- TypeScript public-source connectors.
- Cloudflare Worker ingestion and jurisdiction discovery.
- D1 schema, migrations, repositories, and full connector tests.
- R2 document ingestion, extraction, and access-control workflows.

Those files are reference material, not part of the active package scripts, Lambda asset, frontend build, or AWS runtime. Port connectors one bounded capability at a time into tested Python services or scheduled jobs; do not silently reconnect the legacy runtime.

## Documentation index

- [`README.md`](README.md): complete workflow, stack, operations, and maintenance contract.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): design goals, component boundaries, persistence model, and legacy boundary.
- [`docs/NATIONAL_BID_COVERAGE_PLAN.md`](docs/NATIONAL_BID_COVERAGE_PLAN.md): national coverage strategy and completeness constraints.
- [`docs/NY_NJ_PUBLIC_COMPANY_WORKFLOW.md`](docs/NY_NJ_PUBLIC_COMPANY_WORKFLOW.md): public company-evidence workflow for New York and New Jersey.
- [`legacy/cloudflare/README.md`](legacy/cloudflare/README.md): scope and purpose of the archived implementation.

## Future-change documentation matrix

| Change type | Documentation that must be reviewed and updated |
| --- | --- |
| React route, page, navigation, or search behavior | This README route/workflow maps and relevant frontend notes |
| API endpoint, parameter, response, or validation | This README API map, `ARCHITECTURE.md`, and FastAPI tests |
| Search/readiness/freshness rule | User workflows, data contracts, coverage language, and backend tests |
| Data source or connector | Data workflow, migration status, coverage plan, and source-specific docs |
| DynamoDB key or payload | Persistence sections, security boundaries, and migration notes |
| Authentication or authorization | Security sections, environment variables, workflows, and deployment docs |
| S3 document behavior | Document workflow, rights/security notes, IAM map, and tests |
| AWS resource, permission, cache, or route | Architecture diagram, AWS resource map, deployment and smoke checks |
| Dependency, runtime, or build command | Technology stack, requirements, local setup, and verification workflow |
| Production URL or environment | Current deployment, environment variables, and operations checks |

If a future change cannot be accurately explained in the documentation, it is not ready to merge or deploy.
