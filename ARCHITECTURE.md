# BidAtlas architecture

This document describes the active React/FastAPI/AWS implementation. The complete operator and user workflow is in [`README.md`](README.md); source expansion policy is in [`docs/NATIONAL_BID_COVERAGE_PLAN.md`](docs/NATIONAL_BID_COVERAGE_PLAN.md); marketing identity and reply-routing policy is in [`docs/COLD_OUTREACH_INTEGRATION.md`](docs/COLD_OUTREACH_INTEGRATION.md); Gmail filing policy is in [`docs/GMAIL_PROJECT_INBOX.md`](docs/GMAIL_PROJECT_INBOX.md).

> Architecture changes are incomplete until this document, the README, relevant domain docs, tests, and deployment configuration agree.

## Design objectives

1. Show actionable canopy, pergola, and partition-wall opportunities rather than a noisy construction dump.
2. Preserve a verifiable official-source trail and honest coverage reporting.
3. Authenticate internal work with a verified Tudelu identity.
4. Default reviewed outreach to the designated marketing mailbox while preserving an explicit signed-in employee Gmail option.
5. Make arbitrary-recipient relay, duplicate sending, and cross-user workspace access impossible through the normal API contract.
6. Organize employee Gmail correspondence without cloning or indexing an employee’s entire mailbox.
7. Keep runtime secrets out of Git, Lambda environment values, frontend bundles, logs, and CloudFormation templates.
8. Keep one independently deployable AWS serverless stack.

## System context

```text
          Google OAuth / Gmail API   Anthropic Messages API   Instantly API
                        ^                      ^                    ^
                        |                      |                    |
Tudelu browser -> CloudFront -> API Gateway -> FastAPI Lambda
       |              |                              |
       |              +-> private frontend S3       +-> DynamoDB workspace
       |                                             +-> private catalog S3
       |                                             +-> private documents S3
       v
React authenticated SPA

EventBridge -> National refresh Lambda -> regional official sources + nationwide SAM.gov API
                                      -> versioned catalog S3
EventBridge -> Public-source refresh Lambda -> implemented state/DOT/municipal adapters
                                           -> versioned catalog S3
EventBridge -> Marketing reply-sync Lambda -> Instantly received mail
                                          -> designated Tudelu sales owner
EventBridge -> Gmail inbox-sync Lambda -> known contacts + tracked Gmail threads
                                       -> DynamoDB correspondence + private documents S3
```

CloudFront makes the frontend and API same-origin. The default behavior serves the SPA from private S3 through Origin Access Control. `/api/*` and `/health` use a caching-disabled API Gateway origin and forward viewer cookies. Extensionless SPA rewriting is attached only to the frontend behavior, so API callbacks are never rewritten to `index.html`.

## Trust boundaries

### Public boundary

Health, catalog, search, coverage, source-registry, company, document, and OAuth-start endpoints are public HTTP APIs. Catalog responses have already passed the global qualification gate. Coverage aggregates may describe nonqualified raw records but do not expose those records through project lookup.

### Authenticated workspace boundary

Bid drafts, source monitors, outreach drafts/history, the project inbox, Gmail history, attachment downloads, and sending depend on `require_user`. The dependency validates an HMAC-signed, expiring HttpOnly cookie and then confirms that the email still has a Google account record in DynamoDB. The browser no longer supplies an identity header.

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

Gmail access is restricted to the configured `gmail.readonly` and `gmail.send` scopes. History and inbox normalization discard bodies and store only headers, bounded snippets, matching evidence, and provider IDs. Inbox discovery is constrained to known project contacts and tracked threads. Sending uses `users/me/messages/send`, so the authenticated mailbox is the sender. Matched attachment bytes are stored only in the private documents bucket; an authenticated owner check is required before the API creates a five-minute download URL.

### Instantly provider boundary

Marketing mode is the default, but no provider call occurs until the authenticated employee reviews and confirms a draft. The default is `outreach@tudelugroup.com`; the selectable account list is fetched through the server-held token, and every nondefault sender is revalidated against that provider-authorized list before generation and send. The browser cannot invent a marketing sender, arbitrary reply owner, or provider token. A cross-user recipient lock and 14-day cooldown protect all shared marketing identities.

The scheduled reply Lambda groups routes by their recorded sender account, polls received messages for each applicable account, matches the prospect and timestamp to an existing BidAtlas route, suppresses provider-marked or deterministic automatic replies, and forwards human responses through the same account to the designated sales owner with the prospect address as Reply-To. It stores only a bounded snippet, provider ID, routing metadata, and forwarding status. A provider reply ID is processed once unless a recorded forwarding attempt failed.

### Anthropic provider boundary

The API Lambda alone can decrypt the Anthropic key. Initial email generation does not call Anthropic; it creates a deterministic signed template. Only `personalize: true` sends Claude a bounded project-facts object and at most 20 minimized contact-history records; full bodies and provider IDs are excluded. Prompts label source and message material as untrusted data. Claude supplies only editable subject/body text and cannot select a recipient, sender, reply owner, access tokens, or send mail. FastAPI appends the server-resolved marketing persona or verified employee’s Tudelu signature after generation.

### AWS secret boundary

Parameter Store contains six SecureStrings. Lambda environment variables contain only their names. IAM resources are exact parameter ARNs:

| Consumer | Parameters |
| --- | --- |
| API Lambda | Google client ID, Google client secret, session secret, Anthropic API key, Instantly token |
| Refresh Lambda | SAM.gov API key |
| Marketing reply-sync Lambda | Instantly token |
| Gmail inbox-sync Lambda | Google client ID and Google client secret |

The Google client ID is not intrinsically confidential, but it follows the same promotion and configuration workflow to avoid coupling deployment to a local ignored file.

## Catalog pipeline

The checked-in `data-export/current-projects.json` is a reproducible deployment seed and Lambda fallback. Production’s current catalog is the private versioned S3 object.

`ProjectCatalogProvider`:

1. constructs a catalog from the packaged snapshot;
2. checks the S3 ETag no more than once per configured refresh interval;
3. downloads a changed object under the enforced 80,000,000-byte limit;
4. atomically replaces the in-memory immutable catalog;
5. retains the current catalog if S3 is unavailable or invalid.

`ProjectCatalog` repairs known legacy text encoding, records the raw snapshot count, merges conservative cross-source duplicates, applies the product-fit visibility gate once during initialization, derives `published-contact` or `research-needed` status for every admitted project, builds exact-ID and merged-alias indexes only from admitted projects, and then serves all list/search/aggregation operations from that admitted list.

The data-only archive importer validates complete-source manifests and page checksums, scores every non-terminal row, and stores a compact website projection for qualified records. It removes redundant crawler search arrays and generic early-stage document wrappers while retaining visible project facts, official source URLs, useful named participants, cached fit/classification evidence, and bid/drawing document routes. Package-level import provenance and contact-status counts live once at the snapshot root. The API, national refresh, and Gmail inbox-sync Lambdas use 2 GB memory so the bounded expanded catalog can be parsed without approaching the runtime ceiling.

### Qualification invariant

```text
visible(project) = product_score(project) >= 8

contact_status(project) = published-contact
                          when a valid source-published email or phone exists
                          otherwise research-needed
```

`services/qualification.py` owns these invariants. The scorer preserves the `canopyFit` response field for compatibility while classifying explicit `productTypes`/`productMatches` for canopies, pergolas, and partition walls. No route should duplicate or weaken the visibility invariant. Email and call actions remain restricted to literal source-published contact evidence. A new catalog surface must operate on `ProjectCatalog.projects` or explicitly call the same predicate.

The dashboard recomputes visible total/stage/company inventory. `/api/coverage` intentionally returns the raw ingestion inventory to measure connectors. Search metadata exposes raw and qualified counts so the difference remains observable.

### Duplicate-merging invariant

Duplicate merging is a read-model operation, not destructive source partitioning. `services/project_merge.py` never matches two rows from the same source. Cross-source candidates are blocked by normalized official identifier, address, substantive title, locality, and date, then accepted only with corroborating evidence. Conflicting published addresses prevent a title-only merge. The canonical result preserves every original ID and official URL in `sourceRecords`, and the project index maps each alias back to that canonical result.

The S3 snapshot retains raw source rows because scheduled refreshes replace or retain source partitions independently. Persistently collapsing those rows would make later source-specific refreshes capable of deleting another publisher’s evidence. The API therefore reports both raw and merged counts.

Search and dashboard results use a stable drawing-readiness priority after the requested relevance/readiness sort. A project is drawing-ready only when an official document is classified as plans/drawings, is marked `open` or `public`, and has an HTTPS route. Project and document responses expose that result without treating account-gated plan systems as publicly accessible.

### Tri-state partner directory

`data-export/new-jersey-partner-directory.json` and `data-export/tri-state-research-prospects.json` are curated prospecting aids rather than project-opportunity feeds. Together they contain NJ/NY/CT design firms, developers, owners, and installer partners with a published business email address or phone number. `PartnerDirectory` enforces the tri-state, source-URL, organization-type, and contact requirements again when loading the files.

`GET /api/partner-directory` supports text, organization-type, and product-scope filters. Each returned record includes its published contact, source URL, verification date, and plain-language scope reasoning. Email-capable records can be converted into synthetic `prospect:` opportunities for the existing reviewed outreach workflow; phone-only records expose a call action and are excluded from email draft selection. The UI explicitly labels the reasoning as potential alignment—not evidence of an active project, procurement, or endorsement.

## National source refresh

EventBridge invokes `jobs/refresh_national.handler` daily. The orchestrator fetches source partitions concurrently through guarded HTTP adapters:

- NJ DPMC and NJDOT;
- NYDOT and MaineDOT;
- CT/RI WebProcure public boards;
- Massachusetts DCR and Pennsylvania DGS;
- New Hampshire and Vermont DOT/ArcGIS services;
- District of Columbia PASS solicitations through the official public ArcGIS service, including record-level contracting-officer contacts;
- New York City Record procurement solicitations through the official Socrata API, including record-level procurement contacts;
- official SAM.gov Opportunities API searches for all 50 states and D.C.; each configured canopy, pergola, partition-wall, or proxy query runs once nationwide and records are split locally into independent state partitions by published place of performance.

The SAM connector paginates with the official API’s documented maximum 1,000-record page for each nationwide keyword query, up to a guarded five-page ceiling. It paces requests, applies bounded global backoff to HTTP 429 responses, deduplicates notices returned by multiple queries, normalizes place of performance and `pointOfContact`, applies relevance scoring, and retains source links. It warns if a query exceeds the guard rather than claiming completeness. The key permits the API’s documented keyed rate/usage path; it is not used to evade site access controls.

The 14-keyword SAM batch is transactional for provider failures: if any keyword request fails, all prior state partitions are retained instead of being replaced by partial data. A complete batch is split into 51 state/D.C. results, allowing source-level health and coverage to remain independently observable. Notices returned by multiple queries are deduplicated before partitioning. The independently fetched D.C. PASS and NYC City Record partitions can still refresh if SAM fails. Aggregated inventory and coverage are recomputed after merge, then S3 receives a new object version. FastAPI request latency is independent of publisher availability.

The CT/RI connector includes a narrowly scoped, checksum-pinned Thawte intermediate certificate because the publisher currently serves an incomplete chain. Hostname and certificate validation remain enabled. Reassess before the certificate expires on 2027-11-02.

In addition, EventBridge invokes `infra/handlers/legacy-source-refresh.handler` daily for the implemented public connector library that is not owned by the Python refresh. It merges source partitions transactionally: successful partitions replace their prior records, a degraded partition is accepted only when it returned usable project data, and failed partitions retain the last good data. The worker uses the official TxDOT endpoints with a narrowly scoped DigiCert intermediate because that host currently serves an incomplete chain; hostname and certificate validation remain enabled.

## Outreach sequence

```text
React             FastAPI               DynamoDB           Instantly       Gmail/Claude
  | config/generate   |                      |                  |                 |
  |------------------>| load project/user -->|                  |                 |
  |                   | marketing history -->|                  |                 |
  |                   | or employee history -------------------------------->|
  |                   | create sender-aware template          |                 |
  |                   | store draft -------->|                  |                 |
  |<------------------|                      |                  |                 |
  | personalize AI    |                      |                  |                 |
  |------------------>| bounded facts/snippets -------------------------------->|
  |                   | subject/body + server signature <-----------------------|
  |                   | replace draft ------>|                  |                 |
  |<------------------|                      |                  |                 |
  | edit + save       |                      |                  |                 |
  |------------------>| revalidate recipient/sender/reply owner|                 |
  |                   | store draft -------->|                  |                 |
  |<------------------|                      |                  |                 |
  | confirm + send    |                      |                  |                 |
  |------------------>| revalidate + acquire mode-specific lock|                 |
  |                   | marketing: test-email ---------------->|                 |
  |                   | employee: users/me/send -------------------------------->|
  |                   | sent audit/route + unlock ------------->|                 |
  |<------------------|                      |                  |                 |

EventBridge       Reply Lambda           DynamoDB           Instantly       Sales owner
  | every 5 min      |                      |                  |                 |
  |----------------->| load routes -------->|                  |                 |
  |                  | list received mail -------------------->|                 |
  |                  | match/dedupe/suppress|                  |                 |
  |                  | forward human reply ------------------->|---------------->|
  |                  | forwarding audit --->|                  |                 |

EventBridge       Gmail Inbox Lambda      Gmail API          DynamoDB        Documents S3
  | every 5 min      |                       |                   |                |
  |----------------->| list accounts ------>|                   |                |
  |                  | query contacts/threads ----------------->|                |
  |                  | normalize + match                        |                |
  |                  | correspondence audit ------------------->|                |
  |                  | matched attachment ------------------------------------->|
```

The draft payload is never trusted as recipient, sender, or reply-owner authority. Save and send reload the current admitted project, compare the normalized `to` address with its published contacts, force the marketing sender from configuration, and restrict reply owners to the server list. Subject line breaks are rejected. The send path refuses an existing sent record and acquires an atomic `put_if_absent` record before contacting either provider. The lock is removed in a `finally` block after success or provider failure.

Phone is an independent optional contact path. Phone-only projects pass catalog admission and render a `tel:` action, but `/api/outreach/generate` returns `400` unless the current project also has a source-published email. Calls are initiated by the user’s device and are not logged as email outreach.

Generating or saving is not evidence of delivery. Only a successful Instantly or Gmail response creates sent status. Marketing delivery records its route only after provider success. Stored provider IDs support reply deduplication and Gmail reconciliation without retaining raw messages.

## Persistence model

The DynamoDB table uses `owner` as partition key and `recordKey` as sort key. Payloads are compact JSON strings with `updatedAt` duplicated as a top-level attribute.

| Record key | Contents | Sensitivity |
| --- | --- | --- |
| `google#account` | identity, access/refresh tokens, scopes, expiry | Provider credential; backend-only |
| `draft#<project>` | bid-desk fields | Internal business data |
| `outreach#<project>` | draft, contacts, snippets, sender mode, reply owner, status, provider IDs | Internal communication audit |
| `correspondence#<gmail-message-id>` | headers, bounded snippet, direction, project match/evidence, attachment metadata | Internal communication audit |
| `gmail-inbox#state` | last successful checkpoint and bounded sync counters/warnings | Operational |
| `gmail-send-lock#<project>` | transient send coordination | Operational |
| `monitor#<uuid>` | proposed source URL/status | Internal workflow |
| `route#<recipient-hash>` under system owner | latest marketing send, project, sales owner, cooldown timestamp | Internal routing audit |
| `send-lock#<recipient-hash>` under system owner | transient cross-user marketing coordination | Operational |
| `reply#<provider-id-hash>` under system owner | bounded reply snippet, disposition, forwarding status | Internal communication audit |

Production uses on-demand capacity, AWS-managed encryption, point-in-time recovery, and a retain removal policy. Local development/tests use a process-local dictionary with equivalent owner/key behavior.

The documents S3 bucket is encrypted, versioned, private, SSL-only, and retained. Gmail attachments are stored at `gmail/<owner-hash>/<message-id>/<index>-<safe-name>`. DynamoDB stores the private object key, but the API response does not. Source-published documents remain direct official links and are not copied.

## Frontend composition

`App` owns the `AuthProvider` and authenticated route gate. On startup, `useAuth` requests `/api/auth/me`; only a resolved user mounts route pages, preventing authenticated page hooks from racing ahead of session resolution.

`apiRequest` is same-origin by default, always includes browser credentials, adds JSON headers when needed, normalizes FastAPI errors, and handles 204 responses. It carries no browser-generated identity.

`AppShell` shows the current email and sign-out. Search pages use URL query parameters as shareable state, including the `product` classification filter. Project cards render product-category evidence separately from the overall fit score, expose plain-language scoring reasons, and use equal-height desktop rows. Project-workspace links carry an allowlisted internal return destination so navigation returns to the originating filtered leads/bids, inbox, dashboard, companies, or documents page. `OutreachPage` keeps selected-project draft state isolated, renders provider metadata, restricts recipients to a source-backed select, defaults to the server-declared marketing identity, permits selection among provider-authorized marketing identities or the employee's Gmail account, restricts marketing reply owners to the server list, requires browser confirmation, and disables mutations after sent status.

`InboxPage` uses URL-driven project, assignment-status, search, and page filters. It shows the owner’s project folders, deterministic matching explanation, manual assignment control, and authenticated attachment links. `BidDeskPage` embeds the project’s latest correspondence and files without weakening the API ownership boundary.

Project cards and Project Workspace derive independent email and phone actions from published participants. The Outreach project picker filters to email-capable projects. Changing sender mode regenerates the draft so its visible signature matches the enforced provider identity. The initial draft is deterministic; the explicit personalization button is the only frontend path that invokes Claude.

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
| `api/inbox.py` | authenticated correspondence listing, sync, manual assignment, and attachment downloads |
| `services/auth.py` | identity predicate and purpose-bound signed payloads |
| `services/google.py` | Google HTTP/OAuth/token/Gmail client |
| `services/gmail_inbox.py` | project-scoped Gmail discovery, deterministic matching, minimization, and attachment filing |
| `services/marketing_outreach.py` | Instantly delivery/reply client, marketing identity, cooldown, routing, reply normalization |
| `services/outreach.py` | sender-aware deterministic draft and delivery-field validation |
| `services/ai_outreach.py` | SAM-style Anthropic prompt, bounded context, response validation, fixed Tudelu signature |
| `services/runtime_secrets.py` | lazy cached SSM decryption |
| `services/qualification.py` | product visibility, published contacts, and research-needed status |
| `services/project_merge.py` | conservative cross-source entity resolution and provenance preservation |
| `services/catalog.py` | catalog admission, filters, sort, paging, aggregates |
| `services/canopy.py` | deterministic fit model, product classification, and profiles |
| `services/geography.py` | canonical 50-state/D.C. partition set |
| `services/national.py` | nationwide federal fan-out and regional orchestration |
| `services/state.py` | DynamoDB/memory operations and conditional records |
| `services/northeast*.py` | source-specific regional and SAM-state fetch/parse/normalize |
| `services/public_procurement.py` | official D.C. PASS and NYC City Record open-solicitation fetch/parse/normalize |
| `services/source_refresh.py` | partition-safe snapshot merge |
| `jobs/sync_marketing_replies.py` | scheduled reply matching, suppression, forwarding, and audit |
| `jobs/sync_gmail_inboxes.py` | scheduled per-account project correspondence and attachment sync |

The Google service deliberately uses Python’s standard HTTP library, keeping the Lambda runtime dependency set small. `boto3` is supplied by Lambda and imported lazily so local catalog work does not require AWS initialization.

## Failure behavior

- Invalid/expired session: `401`; React returns to login on the next full load.
- Missing production secrets: auth status reports unconfigured and OAuth start returns `503`.
- OAuth state/domain failure: callback refuses the login without creating an account/session.
- Revoked/missing refresh token: Gmail operation returns a reconnect error; no sent record is written.
- Missing `gmail.readonly` grant: inbox sync requests reconnection and does not scan the mailbox.
- Ambiguous project match: message is retained in the owner’s unassigned review queue; no project is guessed.
- Attachment over 20 MB, message attachment total over 30 MB, or attachment download failure: correspondence is retained with a visible bounded warning and the file is skipped.
- Gmail provider/network failure: `502`; send lock is released; draft remains unsent.
- Missing/failed Instantly marketing provider: configuration reports unavailable or send returns `502`; the cross-user lock is released and no route/sent record is written.
- Instantly reply-list failure: scheduled invocation fails for EventBridge retry; no reply dispositions are written.
- Instantly reply-forward failure: a `forward-failed` audit is retained and retried on a later invocation; it is not marked forwarded.
- Anthropic missing-key/provider/invalid-output failure: `502`; no replacement draft is stored and neither delivery provider is contacted.
- Phone-only project passed to email generation: `400` with direction to use the call option.
- Concurrent send: `409`; second request does not contact either provider.
- Marketing recipient inside the 14-day cooldown: `409`; no provider call occurs.
- Previously sent draft mutation/resend: `409`.
- Catalog S3 failure: API serves its last valid in-memory or packaged catalog.
- One connector failure: old source partition remains and warning/status becomes degraded.
- All connector failures: refresh Lambda fails rather than writing an empty snapshot.

## Deployment and caching

CDK bundles the Python API, national refresh, marketing reply-sync, and Gmail inbox-sync functions in the official Python 3.12 x86-64 build image. The API timeout stays below API Gateway’s response boundary; the national refresh has 1,024 MB of memory and a 15-minute timeout for the bounded 51-partition fan-out; the marketing reply sync has 512 MB and a two-minute timeout; the Gmail inbox sync has 1,024 MB and a five-minute timeout. EventBridge runs both mail synchronization jobs every five minutes with two retries.

Frontend hashed assets are immutable for one year. `index.html` is no-store and CloudFront is invalidated on deployment. API behavior disables caching, which is required for cookies, auth status, drafts, and provider operations.

Resources are tagged `Project=BidAtlas`. Lambda assets explicitly exclude both reference repositories. The stack does not import or mutate their EC2 hosts, databases, S3 objects, contact exports, send history, CRM state, tokens, or deployment resources.

## Verification expectations

Every release runs:

- ESLint for React/TypeScript;
- TypeScript no-emit checking for CDK;
- Ruff for backend and tests;
- Vitest/Testing Library;
- Pytest/FastAPI TestClient, including qualification, exact-domain auth, signed-token tamper/expiry, connector parsing, source merging, published-recipient enforcement, marketing identity/cooldown/reply routing, and employee Gmail send audit behavior;
- Vite production build;
- CDK synth before deploy.

Production smoke checks may validate the connected Instantly account and invoke reply sync only when no marketing routes exist. They must not send real mail unless a human has selected a controlled project and recipient.
