# BidAtlas

BidAtlas is Tudelu’s construction-opportunity workspace. It collects source-backed public projects, ranks canopy, pergola, and partition-wall potential, admits only opportunities with a published contact, and lets a verified Tudelu user review and send outreach. Reviewed emails default to the designated `outreach@tudelugroup.com` marketing mailbox, while an employee can explicitly switch to their own Tudelu Gmail account. A project correspondence inbox then organizes each employee’s Gmail sends and replies and privately files matched attachments with the correct project.

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
  -> National refresh Lambda fetches bounded, allowlisted sources
  -> Regional board adapters run alongside a rate-efficient nationwide SAM query batch
  -> SAM results are partitioned locally into 51 independent state/D.C. source results
  -> Each successful source partition is normalized and replaced
  -> Failed partitions retain their prior records and are marked degraded
  -> Versioned, encrypted private S3 catalog
  -> FastAPI refreshes its in-memory catalog from S3 every five minutes
  -> Global admission gate requires BOTH:
       1. deterministic product fit score >= 8
       2. at least one source-published, valid email OR phone contact
  -> React shows only admitted projects, companies, and document routes
  -> User signs in with a verified @tudelu.com Google account
  -> HttpOnly signed session identifies the user and their DynamoDB workspace
  -> Email-capable projects load the relevant marketing-reply or employee-Gmail context
  -> FastAPI creates a deterministic Tudelu template using the selected sender identity
  -> Optional "Personalize with AI" calls Claude Sonnet 4.6 with bounded facts/context
  -> Marketing drafts use the Alex Turner mailbox identity and Alex Tudelu signoff
  -> Employee drafts use the signed-in employee and their Tudelu signature
  -> User selects a published recipient, a sender mode, and (for marketing) a sales reply owner
  -> User reviews subject/body and explicitly confirms the send
  -> FastAPI sends from marketing through Instantly by default or through Gmail when selected
  -> Employee Gmail sends are logged immediately against the selected project
  -> Marketing sends enforce a cross-user recipient lock and 14-day cooldown
  -> A five-minute reply-sync job suppresses automatic replies and forwards human replies to the selected sales owner
  -> A separate five-minute Gmail inbox job checks known project contacts, tracked threads, and project references
  -> High-confidence correspondence is filed to a project; ambiguous messages enter a manual assignment queue
  -> Matched attachments are copied to the private, encrypted, versioned documents bucket
  -> Draft, minimized contact/reply metadata, provider, sender, reply owner, and sent time are logged
```

The application uses the official SAM.gov Opportunities API when its API key is configured. It does not browser-scrape SAM.gov.
The connector runs 14 canopy, pergola, partition-wall, and related proxy keyword searches once nationwide, paginates with the API’s documented maximum of 1,000 records per query page, deduplicates overlapping results, and partitions records locally by place of performance. Requests are paced, HTTP 429 responses honor bounded backoff, and a failed keyword batch retains every prior state partition. The connector warns instead of silently claiming completeness if a query exceeds the guarded five-page ceiling. See the [official GSA API contract](https://open.gsa.gov/api/get-opportunities-public-api/).

## Technology stack

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Frontend | React 19, React Router 7 | Authenticated SPA, URL-driven search, project workspace, outreach |
| Frontend build | Vite 8, TypeScript 5.9 | Strict browser contracts and content-hashed assets |
| Styling | Plain CSS | Responsive UI and theme support |
| Backend | FastAPI, Python 3.12 | Auth, catalog/search, workspace, outreach, provider boundaries |
| Lambda adapter | Mangum | API Gateway HTTP API to ASGI |
| Relevance | Deterministic Python rules | Canopy, pergola, partition-wall, proxy, NAICS, and false-positive rules |
| Optional AI drafting | Anthropic Messages API, Claude Sonnet 4.6 | Opt-in SAM-style email personalization from bounded evidence |
| Catalog | Amazon S3 | Private, encrypted, versioned source snapshot |
| Workspace | Amazon DynamoDB | Per-Tudelu-user drafts, OAuth account tokens, outreach logs, project correspondence, monitors |
| Filed documents | Amazon S3 | Private, encrypted, versioned Gmail attachments matched to a project |
| Secrets | AWS Systems Manager Parameter Store | Decrypted only at runtime under parameter-specific IAM grants |
| Email delivery | Instantly API; Gmail API | Default marketing-mailbox delivery, reply routing, optional employee-mailbox delivery |
| Identity | Google OAuth 2.0 with PKCE | Verified Tudelu login and employee Gmail authorization |
| Scheduling | Amazon EventBridge | Daily national ingestion plus five-minute marketing-reply and Gmail-project-inbox synchronization |
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
- the source record contains at least one valid published email or plausible published phone number.

This gate applies before search, exact-project lookup, dashboard cards, company aggregation, document aggregation, and outreach. Raw source counts remain visible only in coverage/inventory reporting so connector health stays auditable. Search metadata reports both raw snapshot count and qualified count.

The score is a prioritization signal, not a claim that the notice definitively contains a Tudelu product scope. Users must verify the official source.

### Product scoring and classification

Positive evidence includes architectural/metal/entrance canopies, covered walkways, shade structures, passenger shelters, pergolas, interior and non-load-bearing partitions, demountable/operable/glass/acoustic/restroom partition systems, entrance/facade work, inspection gates, pavilions, awnings, relevant fabrication, and selected NAICS codes. Tree canopy, aircraft/parachute canopy, fabric tents, equipment parts, electrical service entrances, and computing/geopolitical uses of “partition” receive negative weights.

Every search response retains the backward-compatible `canopyFit` score and also returns explicit `productTypes` and evidence-bearing `productMatches`. The `product` query parameter accepts `canopies`, `pergolas`, or `partition-walls`, and the React search form exposes the same filter.

Reusable profiles are returned by `GET /api/search-presets`. `direct_national` covers all 50 states and D.C. with the same minimum score as the global admission gate. `direct_northeast` remains available as a narrower regional preset.

### Contact and email rules

- Contacts must be published with the source record; BidAtlas does not manufacture or enrich a recipient.
- A project may qualify with email, phone, or both. Email-capable projects offer marketing or employee outreach; phone-capable projects offer a direct `tel:` call action.
- The server revalidates the recipient against the current project on save and send. A modified browser cannot turn the API into an arbitrary relay.
- Every send requires a signed-in, verified `@tudelu.com` user and an explicit UI confirmation.
- Marketing is the default sender mode and defaults to the connected `outreach@tudelugroup.com` Instantly account with the Alex Turner identity. The user can select any other account authorized by the connected Instantly token; the employee option uses Gmail `users/me` for the signed-in employee.
- Marketing replies are assigned to one of the designated Tudelu sales owners and forwarded by the scheduled reply-sync job. Employee-mailbox replies return directly to that employee.
- Marketing sending has a cross-user per-recipient conditional lock and a 14-day cooldown. Employee sending has a per-user/per-project lock.
- Sent records cannot be edited, regenerated, or resent.
- Contact history stores only From, To, Subject, Date, short snippets, status, and necessary provider IDs. Full inbox bodies are not persisted.
- The project inbox searches only source-published project contacts, previously tracked Gmail threads, and project/solicitation references. It does not copy or index the employee’s whole mailbox.
- Automatic filing prioritizes an existing Gmail thread, then an exact project reference, then unique contact/title evidence. Ambiguous contact matches remain unassigned for a user to file manually.
- Only attachments on project-scoped messages are copied. They remain private in S3 and can be downloaded only through an authenticated, owner-checked API route with a short-lived signed URL.
- Only the explicit **Personalize with AI** action calls Anthropic. It sends bounded project facts plus minimized contact-history headers/snippets; provider IDs and full bodies are excluded from the AI prompt.
- Claude returns subject/body text only. FastAPI appends the server-resolved marketing account's signoff or the verified employee’s Tudelu signature, including the known SAM employee extension mapping.
- Generated text is always editable and must be reviewed. Claude cannot select a sender, recipient, reply owner, or invoke either delivery provider.
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
2. URL query parameters represent keywords, product type, location, state, deadline, stage, freshness, profile, archive flag, page, and page size.
3. FastAPI starts from the admitted catalog, applies filters, calculates product classification and the backward-compatible `canopyFit`, sorts, and paginates.
4. Cards show plain-language product-fit reasons, link to the official source and internal Project Workspace, then show email and/or phone actions according to the contact methods the source published.

A bid-ready result additionally requires bidding stage, a non-expired deadline, and an official document route.

### Project workspace and monitors

Project Workspace loads project evidence, full product-fit scoring reasons, and matched product categories beside the user’s internal draft. Its return action preserves the originating dashboard, filtered lead/bid results, company list, or document list. `GET/POST /api/bid-drafts` persists notes under the signed-in email. Source monitors accept a name and an allowlisted public `https://` URL and store a `pending-review` record; registering a monitor does not automatically fetch or publish the source.

### Outreach delivery and reply routing

1. `/outreach?project=<id>` selects an admitted project.
2. `GET /api/outreach/config` returns every marketing account authorized by the connected Instantly token, the signed-in employee identity, designated sales reply owners, and default sender mode. It exposes only safe account identity/status fields and never provider credentials.
3. `POST /api/outreach/generate` requires a source-published email and creates a deterministic template without contacting Anthropic. Marketing mode uses the shared reply audit; employee mode queries Gmail metadata/snippets to and from the project’s published contacts.
4. **Personalize with AI** repeats generation with `regenerate: true` and `personalize: true`. Claude Sonnet 4.6 produces an opportunity-specific subject/body using the SAM application’s Tudelu context and style; the existing draft remains available if the provider fails.
5. FastAPI appends the server-resolved selected marketing account's Tudelu signoff in marketing mode or the verified employee’s fixed Tudelu signature in employee mode.
6. The user can switch only among source-published recipients, choose any provider-authorized marketing account or their employee mailbox, select a designated sales reply owner for marketing, edit subject/body, save, refresh contact context, or re-personalize an unsent draft.
7. Marketing delivery is preselected. The employee must still review the message and accept the explicit sender/recipient confirmation before any provider call. This release does not create an unattended bulk-send campaign.
8. `POST /api/outreach/send` revalidates the project, recipient, selected sender, reply owner, subject, body, prior sent state, cooldown, and duplicate-send lock. It calls Instantly for marketing mode or Gmail `users/me/messages/send` for employee mode.
9. Marketing routes are stored under a system partition so all BidAtlas users share the 14-day per-recipient cooldown. The sent record stores the provider, sender, reply owner, and timestamp; employee sends also retain Gmail message/thread IDs.
10. EventBridge invokes the marketing reply-sync Lambda every five minutes. It groups routes by the marketing account that sent them, polls each applicable account's received messages, matches replies to BidAtlas routes, suppresses deterministic/provider-marked automatic replies, forwards human responses to the selected sales owner with the prospect as Reply-To, and deduplicates provider IDs.
11. `/api/outreach/history` restores the authenticated user’s drafts and sent records. The marketing reply audit exposes only bounded metadata/snippets to the outreach page.

Phone-only opportunities do not enter the email generator. Their card and Project Workspace actions open the published number through a `tel:` link, while the published evidence remains available for manual verification.

### Project correspondence inbox

1. `/inbox` loads only the signed-in employee’s `correspondence#*` records and project folders.
2. `POST /api/inbox/sync` runs a bounded on-demand sync of up to 50 messages; EventBridge also invokes a 250-message version for every connected employee account every five minutes.
3. The first sync looks back 90 days. Later syncs overlap the prior successful checkpoint by two days and search only published project contacts. Existing outreach/correspondence Gmail threads are fetched directly.
4. Gmail message payloads are reduced to From, To, Cc, Subject, internal timestamp, direction, labels, a 500-character Gmail snippet, matching evidence, and attachment metadata. Full message bodies are not stored.
5. Matching applies deterministic evidence in this order: tracked thread, exact project/solicitation reference, unique published contact, or a unique contact-and-title match. More than one plausible project produces an unassigned review item.
6. `PUT /api/inbox/messages/{messageId}/project` lets the signed-in owner file an ambiguous message. A manual assignment is preserved on later syncs.
7. Attachments up to 20 MB each and 30 MB per message are written under an owner-hashed/message-specific S3 prefix. The API never exposes the S3 object key.
8. The Project Workspace shows its latest correspondence and filed attachments and links back to the project-filtered inbox.

See [`docs/GMAIL_PROJECT_INBOX.md`](docs/GMAIL_PROJECT_INBOX.md) for the matching, privacy, and AWS boundaries.

### Coverage and ingestion

Coverage separates raw connected-source inventory from the admitted product-opportunity queue. The daily refresh currently includes:

- a scheduled public-adapter network covering the implemented federal, state, DOT, municipal procurement, permit, and planning connectors, with failed refreshes retaining the last good source partition;
- NJ DPMC and NJDOT;
- NYDOT and MaineDOT;
- Connecticut and Rhode Island WebProcure boards;
- Massachusetts DCR and Pennsylvania DGS;
- New Hampshire DOT and Vermont VTrans/ArcGIS;
- the District of Columbia PASS open solicitation feed, including record-level contracting-officer contacts;
- New York City Record procurement notices, including solicitation-specific contact fields;
- SAM.gov federal opportunities for all 50 states and D.C.; each configured product/proxy query runs once nationwide and the results are split into independent state partitions by published place of performance.

The municipal connectors use the official [Solicitations from PASS open-data service](https://opendata.dc.gov/datasets/DCGIS::solicitations-from-pass) and [New York City Record open dataset](https://data.cityofnewyork.us/d/dg92-zbpx). The SAM.gov overlay provides a nationwide federal connection, not complete state or local coverage. State coverage remains `partial` where a named regional agency/board is connected and `identified` or `not-connected` elsewhere. These connections do not cover every municipality, school, authority, permit office, platform, or private project. Search, dashboard, cards, and document results rank records with direct public drawing/plan routes ahead of otherwise-equivalent records and label the accessible drawing count. See [`docs/NATIONAL_BID_COVERAGE_PLAN.md`](docs/NATIONAL_BID_COVERAGE_PLAN.md).

## Browser route and API map

| Browser route | React page | Main APIs |
| --- | --- | --- |
| `/` | `HomePage` | `/api/dashboard` |
| `/projects` | `ProjectsPage` | `/api/search`, `/api/search-presets` |
| `/leads` | `LeadsPage` | `/api/search`, `/api/search-presets` |
| `/inbox` | `InboxPage` | `/api/inbox`, `/api/inbox/sync`, assignment and attachment routes |
| `/companies` | `CompaniesPage` | `/api/companies`, `/api/partner-directory` |
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
| `GET` | `/api/partner-directory` | Public | Contact-only tri-state design, developer, owner, and installer directory |
| `GET` | `/api/auth/google/status`, `/google/start`, `/google/callback` | Public OAuth flow | Google configuration and login |
| `GET` | `/api/auth/me` | Session | Current Tudelu user |
| `POST` | `/api/auth/logout` | Cookie | End browser session |
| `GET/POST` | `/api/bid-drafts`, `/api/source-monitors` | Session | Per-user workspace |
| `GET` | `/api/integrations` | App-gated | Google, SAM, Anthropic, Instantly, and disabled connector status; never secret values |
| `GET` | `/api/outreach/config` | Session | Safe sender identities and designated sales reply-owner choices |
| `GET` | `/api/outreach/draft`, `/history` | Session | Per-user outreach records |
| `POST` | `/api/outreach/generate`, `/gmail-history` | Session | Draft and selected-provider metadata sync; employee mode requires Google |
| `PUT` | `/api/outreach/draft` | Session | Save reviewed draft |
| `POST` | `/api/outreach/send` | Session | Confirmed Instantly marketing send or signed-in employee Gmail send |
| `GET` | `/api/inbox` | Session | Signed-in employee’s project correspondence, folders, filters, and sync status |
| `POST` | `/api/inbox/sync` | Session | Bounded on-demand Gmail project sync |
| `PUT` | `/api/inbox/messages/{messageId}/project` | Session | Manually file the owner’s correspondence under an admitted project |
| `GET` | `/api/inbox/attachments/{messageId}/{index}` | Session | Owner-check then redirect to a five-minute S3 download URL |

FastAPI publishes the authoritative request/response schema at `/api/docs`.

## Repository map

```text
frontend/src/
  api/client.ts             credentialed same-origin HTTP client
  hooks/useAuth.tsx         session provider and sign-out
  pages/LoginPage.tsx       Tudelu Google login gate
  pages/OutreachPage.tsx    sender/reply-owner choice, context, review, confirmed send
  pages/InboxPage.tsx       project folders, correspondence filters, attachment filing
  pages/*                   discovery, coverage, companies, documents, project workspace
  components/*              shell, cards, filters, loading/error feedback
  types.ts                  browser API contracts

backend/app/
  api/auth.py               OAuth start/callback, session, logout
  api/catalog.py            public qualified catalog endpoints
  api/outreach.py           authenticated history/draft/send boundary
  api/inbox.py              authenticated correspondence, sync, assignment, download boundary
  api/workspace.py          authenticated drafts/monitors and integration status
  services/auth.py          domain validation and signed tokens
  services/google.py        OAuth, token refresh, Gmail metadata and send
  services/gmail_inbox.py   bounded Gmail discovery, matching, minimization, attachment filing
  services/marketing_outreach.py  Instantly delivery, cooldown, routing, reply normalization
  services/outreach.py      deterministic sender-aware draft generation
  services/ai_outreach.py   Anthropic prompt, response validation, fixed signature
  services/qualification.py global contact + product-fit admission rule
  services/canopy.py        deterministic scoring, classification, and profiles
  services/catalog*.py      S3/local snapshot loading, search, aggregation
  services/partner_directory.py  sourced tri-state prospect contact filtering
  services/geography.py     canonical 50-state/D.C. code and name set
  services/national.py      nationwide SAM fan-out and regional orchestration
  services/northeast*.py    source-specific regional boards and SAM state adapter
  services/public_procurement.py  D.C. PASS and NYC City Record open-data adapters
  services/source_refresh.py partition-safe merge and coverage reconciliation
  services/state.py         DynamoDB/in-memory persistence and send locks
  jobs/refresh_national.py  scheduled Lambda entry point
  jobs/sync_marketing_replies.py  scheduled marketing reply forwarding

data-export/                deploy seed, tri-state prospect directory, registry, coverage and provenance
infra/                      AWS CDK stack and context
scripts/                    local national refresh tooling
docs/                       domain plans and operating documentation
legacy/cloudflare/          archived prior runtime, excluded from deployment
sam_dot_gov-main/           ignored reference application, excluded from Git/AWS assets
tudelu-cold-outreach-main/  ignored reference application, excluded from Git/AWS assets
```

The SAM and cold-outreach reference applications’ databases, lead/contact exports, send history, CRM state, and OAuth tokens are not imported into BidAtlas. Only reusable behavior was reimplemented. Required values from ignored local configuration are promoted to BidAtlas SSM SecureStrings without exposing them in Git or CloudFormation. See [`docs/COLD_OUTREACH_INTEGRATION.md`](docs/COLD_OUTREACH_INTEGRATION.md).

## Persistence and AWS architecture

```text
CloudFront
  +-- default route -> private frontend S3 (Origin Access Control)
  +-- /api/*, /health -> API Gateway HTTP API -> FastAPI Lambda

FastAPI Lambda
  +-- read catalog S3
  +-- read/write DynamoDB workspace
  +-- decrypt Google client ID/secret, session secret, Anthropic key, and Instantly token
  +-- call Anthropic Messages API for reviewed email drafts
  +-- send reviewed marketing email through a server-validated Instantly account
  +-- optionally send from the signed-in employee through Gmail

EventBridge (daily 10:15 UTC)
  -> National refresh Lambda
       +-- decrypt only SAM API key parameter
       +-- isolate federal results by all 50 states and D.C.
       +-- read/write versioned catalog S3

EventBridge (daily 09:45 UTC)
  -> Public-source refresh Lambda
       +-- run the implemented public state, DOT, municipal, permit, and planning adapters
       +-- retain last-good source partitions when a publisher fails
       +-- read/write versioned catalog S3

EventBridge (every five minutes)
  -> Marketing reply-sync Lambda
       +-- decrypt only the Instantly token parameter
       +-- read system marketing routes/reply audits in DynamoDB
       +-- forward human replies to the route's designated sales owner
```

DynamoDB keys:

```text
owner=<verified Tudelu email>  recordKey=google#account                  encrypted OAuth account
owner=<verified Tudelu email>  recordKey=draft#<project-id>             bid draft
owner=<verified Tudelu email>  recordKey=outreach#<project-id>          draft/history/sent audit
owner=<verified Tudelu email>  recordKey=gmail-send-lock#<project-id>   conditional transient lock
owner=<verified Tudelu email>  recordKey=monitor#<uuid>                 source review item
owner=system#marketing-outreach recordKey=route#<recipient-hash>        latest route and cooldown
owner=system#marketing-outreach recordKey=send-lock#<recipient-hash>    cross-user transient lock
owner=system#marketing-outreach recordKey=reply#<provider-id-hash>      forwarding/suppression audit
```

The table uses AWS-managed encryption, on-demand billing, point-in-time recovery, and `RETAIN`. Catalog and document buckets are private, encrypted, TLS-only, versioned, and retained. The frontend bucket is private and disposable because CDK can rebuild it.

## Configuration and secrets

Copy `.env.example` for local development. Never commit `.env` files.

Production parameter names are nonsecret CDK context in `infra/cdk.json`:

- `/BidAtlas/sam-api-key`
- `/BidAtlas/google-client-id`
- `/BidAtlas/google-client-secret`
- `/BidAtlas/session-secret`
- `/BidAtlas/anthropic-api-key`
- `/tudelu-marketing/INSTANTLY_API_TOKEN`

Values must be `SecureString`s. CDK passes parameter names—not values—to Lambda, and IAM grants `ssm:GetParameter` only on the required ARNs. Google OAuth and Anthropic values belong only to the API Lambda; the SAM key belongs only to the refresh Lambda; the Instantly token belongs only to the API and marketing reply-sync Lambdas. Production pins `BIDATLAS_ANTHROPIC_MODEL=claude-sonnet-4-6` to match the SAM reference implementation and `BIDATLAS_MARKETING_SENDER=outreach@tudelugroup.com` as the default. Other selectable marketing accounts are discovered from and revalidated against the connected Instantly account list at runtime.

## Local development

Prerequisites: Node 22+, Python 3.12+, and AWS CLI/CDK only for AWS operations.

```powershell
npm install
python -m pip install -r backend/requirements-dev.txt
npm run dev
```

Vite runs on `http://localhost:5173` and proxies `/api` and `/health` to FastAPI on `http://localhost:8000`. Configure a Google OAuth web client redirect for `http://localhost:8000/api/auth/google/callback` and use direct `BIDATLAS_GOOGLE_*` environment values locally.
Set `BIDATLAS_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) for local AI email generation; never commit it.
Set `BIDATLAS_INSTANTLY_API_TOKEN` and optionally `BIDATLAS_MARKETING_SENDER` for local marketing-provider checks. Never perform a provider send as an automated smoke test.

Optional local source refresh:

```powershell
$env:SAM_API_KEY = "<local key>"
python scripts/refresh_national_snapshot.py
```

The former Northeast script remains a compatibility alias. This command modifies `data-export` and should be reviewed like any source-data change.

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
2. invoke the national refresh Lambda once and confirm `samConfigured: true`, `scope: 50-states-and-dc`, and 51 expected federal partitions;
3. verify every returned `/api/search` project has a published email or phone and score of at least 8;
4. verify the marketing reply-sync schedule is enabled and a no-route invocation exits without polling or forwarding;
5. complete a Tudelu Google login and confirm marketing is preselected, a designated sales reply owner is required, and employee Gmail remains selectable;
6. confirm the default template does not require AI, then personalize an unsent marketing and employee draft and verify the corresponding fixed Tudelu signatures;
7. use a controlled recipient/project before performing any live provider send test.

Do not send a production email merely as an infrastructure smoke test.
