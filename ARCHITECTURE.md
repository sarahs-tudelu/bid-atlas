# BidAtlas architecture

This document describes the active React/FastAPI/AWS implementation. The complete operator and user workflow is in [`README.md`](README.md); source expansion policy is in [`docs/NATIONAL_BID_COVERAGE_PLAN.md`](docs/NATIONAL_BID_COVERAGE_PLAN.md).

> Architecture changes are incomplete until this document, the README, relevant domain docs, tests, and deployment configuration agree.

## Design objectives

1. Show actionable Canopy opportunities rather than a noisy construction dump.
2. Preserve a verifiable official-source trail and honest coverage reporting.
3. Authenticate internal work with a verified Tudelu identity.
4. Send only reviewed messages from the signed-in user’s Gmail account.
5. Make arbitrary-recipient relay, duplicate sending, and cross-user workspace access impossible through the normal API contract.
6. Keep runtime secrets out of Git, Lambda environment values, frontend bundles, logs, and CloudFormation templates.
7. Keep one independently deployable AWS serverless stack.

## System context

```text
                   Google OAuth / Gmail API     Anthropic Messages API
                              ^                         ^
                              |                         |
Tudelu browser -> CloudFront -> API Gateway -> FastAPI Lambda
       |              |                              |
       |              +-> private frontend S3       +-> DynamoDB workspace
       |                                             +-> private catalog S3
       v
React authenticated SPA

EventBridge -> Northeast refresh Lambda -> official sources + SAM.gov API
                                      -> versioned catalog S3
```

CloudFront makes the frontend and API same-origin. The default behavior serves the SPA from private S3 through Origin Access Control. `/api/*` and `/health` use a caching-disabled API Gateway origin and forward viewer cookies. Extensionless SPA rewriting is attached only to the frontend behavior, so API callbacks are never rewritten to `index.html`.

## Trust boundaries

### Public boundary

Health, catalog, search, coverage, source-registry, company, document, and OAuth-start endpoints are public HTTP APIs. Catalog responses have already passed the global qualification gate. Coverage aggregates may describe nonqualified raw records but do not expose those records through project lookup.

### Authenticated workspace boundary

Bid drafts, source monitors, outreach drafts/history, Gmail history, and sending depend on `require_user`. The dependency validates an HMAC-signed, expiring HttpOnly cookie and then confirms that the email still has a Google account record in DynamoDB. The browser no longer supplies an identity header.

Every mutable record is partitioned by the normalized verified Google email. User input cannot select another owner partition.

### Google provider boundary

The API Lambda alone can decrypt OAuth client credentials. OAuth uses:

- cryptographically random state;
- a state-bound PKCE verifier/challenge;
- an exact redirect URI;
- `access_type=offline` and explicit consent;
- verified Google user information;
- an exact `@tudelu.com` admission check.

The state cookie lasts 10 minutes. The application session lasts 12 hours and is HttpOnly, Secure in production, and SameSite=Lax. Provider access tokens are refreshed server-side and never returned to React.

Gmail access is restricted to the configured `gmail.readonly` and `gmail.send` scopes. History normalization discards bodies and stores only headers, short snippets, and provider IDs. Sending uses `users/me/messages/send`, so the authenticated mailbox is the sender.

### Anthropic provider boundary

The API Lambda alone can decrypt the Anthropic key. Initial email generation does not call Anthropic; it creates a deterministic signed template. Only `personalize: true` sends Claude a bounded project-facts object and at most 20 Gmail metadata/snippet records; full bodies and Gmail provider IDs are excluded. Prompts label source and Gmail material as untrusted data. Claude supplies only editable subject/body text and cannot select a recipient, choose a sender, access OAuth tokens, or send mail. FastAPI appends the verified rep’s Tudelu signature after generation.

### AWS secret boundary

Parameter Store contains five SecureStrings. Lambda environment variables contain only their names. IAM resources are exact parameter ARNs:

| Consumer | Parameters |
| --- | --- |
| API Lambda | Google client ID, Google client secret, session secret, Anthropic API key |
| Refresh Lambda | SAM.gov API key |

The Google client ID is not intrinsically confidential, but it follows the same promotion and configuration workflow to avoid coupling deployment to a local ignored file.

## Catalog pipeline

The checked-in `data-export/current-projects.json` is a reproducible deployment seed and Lambda fallback. Production’s current catalog is the private versioned S3 object.

`ProjectCatalogProvider`:

1. constructs a catalog from the packaged snapshot;
2. checks the S3 ETag no more than once per configured refresh interval;
3. downloads a changed object under a strict byte limit;
4. atomically replaces the in-memory immutable catalog;
5. retains the current catalog if S3 is unavailable or invalid.

`ProjectCatalog` repairs known legacy text encoding, records the raw snapshot count, applies the visibility admission gate once during initialization, builds exact-ID indexes only from admitted projects, and then serves all list/search/aggregation operations from that admitted list.

### Qualification invariant

```text
visible(project) = canopy_score(project) >= 8
                   AND (count(valid_source_published_email(project)) > 0
                        OR count(valid_source_published_phone(project)) > 0)
```

`services/qualification.py` owns this invariant. No route should duplicate or weaken it. A new catalog surface must operate on `ProjectCatalog.projects` or explicitly call the same predicate.

The dashboard recomputes visible total/stage/company inventory. `/api/coverage` intentionally returns the raw ingestion inventory to measure connectors. Search metadata exposes raw and qualified counts so the difference remains observable.

## Regional source refresh

EventBridge invokes `jobs/refresh_northeast.handler` daily. The orchestrator fetches source partitions concurrently through guarded HTTP adapters:

- NJ DPMC and NJDOT;
- NYDOT and MaineDOT;
- CT/RI WebProcure public boards;
- Massachusetts DCR and Pennsylvania DGS;
- New Hampshire and Vermont DOT/ArcGIS services;
- official SAM.gov Opportunities API searches for each Northeast state and each configured Canopy/proxy query.

The SAM connector paginates with the official API’s documented maximum 1,000-record page for each state/query pair, up to a guarded five-page ceiling. It deduplicates notices returned by multiple queries, normalizes place of performance and `pointOfContact`, applies relevance scoring, and retains source links. It warns if a pair exceeds the guard rather than claiming completeness. The key permits the API’s documented keyed rate/usage path; it is not used to evade site access controls.

The merge algorithm replaces only successful partitions. Failed partitions keep their last successful records and add warnings/degraded status. Aggregated inventory and coverage are recomputed after merge, then S3 receives a new object version. FastAPI request latency is independent of publisher availability.

The CT/RI connector includes a narrowly scoped, checksum-pinned Thawte intermediate certificate because the publisher currently serves an incomplete chain. Hostname and certificate validation remain enabled. Reassess before the certificate expires on 2027-11-02.

## Outreach sequence

```text
React             FastAPI              DynamoDB             Gmail        Claude
  | generate         |                     |                   |             |
  |----------------->| load admitted       |                   |             |
  |                  | project/account --->|                   |             |
  |                  | list messages/threads ----------------->|             |
  |                  | normalize metadata <--------------------|             |
  |                  | create template      |                   |             |
  |                  | store draft/history ->|                  |             |
  |<-----------------|                     |                   |             |
  | personalize AI   |                     |                   |             |
  |----------------->| bounded facts/snippets ------------------------------>|
  |                  | subject/body <----------------------------------------|
  |                  | append signature     |                   |             |
  |                  | replace draft ------>|                   |             |
  |<-----------------|                     |                   |             |
  | edit + save      |                     |                   |             |
  |----------------->| revalidate recipient|                   |             |
  |                  | store draft ------->|                   |             |
  |<-----------------|                     |                   |             |
  | confirm + send   |                     |                   |             |
  |----------------->| revalidate all      |                   |             |
  |                  | conditional lock -->|                   |             |
  |                  | users/me/send ------------------------->|             |
  |                  | provider IDs <--------------------------|             |
  |                  | sent audit + unlock>|                   |             |
  |<-----------------|                     |                   |             |
```

The draft payload is never trusted as recipient authority. Save and send reload the current admitted project and compare the normalized `to` address with its published contacts. Subject line breaks are rejected. The send path refuses an existing sent record and acquires an atomic `put_if_absent` record before contacting Gmail. The lock is removed in a `finally` block after success or provider failure.

Phone is an independent optional contact path. Phone-only projects pass catalog admission and render a `tel:` action, but `/api/outreach/generate` returns `400` unless the current project also has a source-published email. Calls are initiated by the user’s device and are not logged as Gmail outreach.

Generating or saving is not evidence of delivery. Only a successful Gmail API response creates sent status. Stored provider IDs support later reconciliation without retaining a raw RFC 2822 message.

## Persistence model

The DynamoDB table uses `owner` as partition key and `recordKey` as sort key. Payloads are compact JSON strings with `updatedAt` duplicated as a top-level attribute.

| Record key | Contents | Sensitivity |
| --- | --- | --- |
| `google#account` | identity, access/refresh tokens, scopes, expiry | Provider credential; backend-only |
| `draft#<project>` | bid-desk fields | Internal business data |
| `outreach#<project>` | draft, contacts, snippets, status, Gmail IDs | Internal communication audit |
| `gmail-send-lock#<project>` | transient send coordination | Operational |
| `monitor#<uuid>` | proposed source URL/status | Internal workflow |

Production uses on-demand capacity, AWS-managed encryption, point-in-time recovery, and a retain removal policy. Local development/tests use a process-local dictionary with equivalent owner/key behavior.

The documents S3 bucket is an encrypted, versioned, retained boundary for future protected content. The current UI deep-links to official documents and does not proxy or copy them.

## Frontend composition

`App` owns the `AuthProvider` and authenticated route gate. On startup, `useAuth` requests `/api/auth/me`; only a resolved user mounts route pages, preventing authenticated page hooks from racing ahead of session resolution.

`apiRequest` is same-origin by default, always includes browser credentials, adds JSON headers when needed, normalizes FastAPI errors, and handles 204 responses. It carries no browser-generated identity.

`AppShell` shows the current email and sign-out. Search pages use URL query parameters as shareable state. `OutreachPage` keeps selected-project draft state isolated, renders provider metadata, restricts recipients to a source-backed select, requires browser confirmation, and disables mutations after sent status.

Project cards and Bid Desk derive independent email and phone actions from published participants. The Outreach project picker filters to email-capable projects. Its initial draft is deterministic; the explicit personalization button is the only frontend path that invokes Claude.

The UI gate is a usability boundary; the FastAPI dependency is the authorization boundary.

## Backend composition

| Module | Responsibility |
| --- | --- |
| `main.py` | app, middleware, routers, health, Mangum |
| `config.py` | environment-derived immutable settings |
| `dependencies.py` | cached catalog/store construction |
| `api/auth.py` | OAuth/session HTTP contract and `require_user` |
| `api/catalog.py` | public validation and discovery contract |
| `api/workspace.py` | authenticated drafts/monitors; safe integration status |
| `api/outreach.py` | authenticated generate/history/save/send orchestration |
| `services/auth.py` | identity predicate and purpose-bound signed payloads |
| `services/google.py` | Google HTTP/OAuth/token/Gmail client |
| `services/ai_outreach.py` | SAM-style Anthropic prompt, bounded context, response validation, fixed Tudelu signature |
| `services/runtime_secrets.py` | lazy cached SSM decryption |
| `services/qualification.py` | global visibility and published contacts |
| `services/catalog.py` | catalog admission, filters, sort, paging, aggregates |
| `services/canopy.py` | deterministic fit model and profiles |
| `services/state.py` | DynamoDB/memory operations and conditional records |
| `services/northeast*.py` | source-specific fetch/parse/normalize |
| `services/source_refresh.py` | partition-safe snapshot merge |

The Google service deliberately uses Python’s standard HTTP library, keeping the Lambda runtime dependency set small. `boto3` is supplied by Lambda and imported lazily so local catalog work does not require AWS initialization.

## Failure behavior

- Invalid/expired session: `401`; React returns to login on the next full load.
- Missing production secrets: auth status reports unconfigured and OAuth start returns `503`.
- OAuth state/domain failure: callback refuses the login without creating an account/session.
- Revoked/missing refresh token: Gmail operation returns a reconnect error; no sent record is written.
- Gmail provider/network failure: `502`; send lock is released; draft remains unsent.
- Anthropic missing-key/provider/invalid-output failure: `502`; no draft is stored and Gmail is not contacted for sending.
- Phone-only project passed to email generation: `400` with direction to use the call option.
- Concurrent send: `409`; second request does not contact Gmail.
- Previously sent draft mutation/resend: `409`.
- Catalog S3 failure: API serves its last valid in-memory or packaged catalog.
- One connector failure: old source partition remains and warning/status becomes degraded.
- All connector failures: refresh Lambda fails rather than writing an empty snapshot.

## Deployment and caching

CDK bundles the Python API and refresh functions in the official Python 3.12 x86-64 build image. The API timeout stays below API Gateway’s response boundary; regional refresh has a five-minute timeout.

Frontend hashed assets are immutable for one year. `index.html` is no-store and CloudFront is invalidated on deployment. API behavior disables caching, which is required for cookies, auth status, drafts, and provider operations.

Resources are tagged `Project=BidAtlas`. The stack does not import or mutate the old SAM reference application’s EC2, SQLite, DynamoDB, S3, tokens, or deployment resources.

## Verification expectations

Every release runs:

- ESLint for React/TypeScript;
- TypeScript no-emit checking for CDK;
- Ruff for backend and tests;
- Vitest/Testing Library;
- Pytest/FastAPI TestClient, including qualification, exact-domain auth, signed-token tamper/expiry, connector parsing, source merging, published-recipient enforcement, and Gmail send audit behavior;
- Vite production build;
- CDK synth before deploy.

Production smoke checks must not send real mail unless a human has selected a controlled project and recipient.
