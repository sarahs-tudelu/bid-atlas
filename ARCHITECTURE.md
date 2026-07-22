# BidAtlas architecture

## Design goals

1. Keep the browser application framework-neutral and static.
2. Keep HTTP concerns in thin FastAPI routers.
3. Keep catalog filtering and workspace persistence in testable services.
4. Keep the AWS footprint isolated, low-cost, encrypted, and reproducible.
5. Preserve the legacy connector implementation without letting it obscure the active runtime.

## Runtime request flow

```text
                     ┌──────────────────────────┐
                     │ CloudFront distribution  │
                     └────────────┬─────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
        frontend route or asset              /api/* or /health
                 │                                 │
                 ▼                                 ▼
       private S3 frontend bucket        API Gateway HTTP API
                                                   │
                                                   ▼
                                          FastAPI Lambda
                                          ├─ ProjectCatalog
                                          ├─ JurisdictionCatalog
                                          └─ WorkspaceStore
                                                   │
                                    ┌──────────────┴──────────────┐
                                    ▼                             ▼
                              DynamoDB state               private S3 documents
```

## Frontend boundaries

`frontend/src/App.tsx` owns the route table. Pages compose reusable components and call `apiRequest` or `useApi`; they do not know where FastAPI runs. Local Vite proxying and CloudFront path routing keep the browser contract same-origin in every environment.

The project and coverage interfaces live in `frontend/src/types.ts`. Presentational formatting stays close to the component using it. There is no server-rendering lifecycle or framework-specific link component.

## Backend boundaries

`backend/app/main.py` creates the application, middleware, routers, health endpoint, and Lambda adapter.

`backend/app/api/catalog.py` exposes read-only public catalog endpoints. `backend/app/api/workspace.py` exposes small mutable workspace endpoints. Both delegate domain work to services.

`ProjectCatalog` indexes one immutable export and retains the existing filtering and pagination conventions. `ProjectCatalogProvider` starts with the packaged export, checks the private S3 object version at a bounded cadence, and swaps in a newly validated immutable catalog when it changes. Searches never wait for upstream procurement portals. `WorkspaceStore` uses DynamoDB in AWS and a thread-safe in-memory implementation for local development and tests.

## Persistence

The checked-in source snapshot is the deployment seed and failure fallback. The private versioned catalog bucket holds the current runtime snapshot. A scheduled, allowlisted New Jersey job is its only writer today; it refreshes official DPMC and NJDOT records and preserves the previous partition when a source fails. Workspace drafts and registered source monitors are mutable user data stored in a single-table DynamoDB layout:

```text
owner                  recordKey                 payload
user@example.com       draft#<project-id>        JSON draft
user@example.com       monitor#<uuid>            JSON monitor
```

The deployed frontend creates a random device workspace identifier and supplies it through `X-BidAtlas-User`. It prevents accidental cross-device mixing but is not account authentication, so drafts must not contain confidential pricing or personal data until an identity provider is added.

The documents bucket is provisioned for protected document ingestion. The current React application links official document routes and does not yet upload files into that bucket.

## Deployment

CDK bundles Python dependencies in the official Python 3.12 Lambda build image. The Lambda runtime is x86-64 to match compiled wheels. Frontend assets are content-hashed by Vite, uploaded by CDK, and invalidated through CloudFront before deployment completion.

All resources are created by `BidAtlasStack`; no Canopy or Tudelu stack resources are imported or modified.

The New Jersey refresh Lambda runs daily from EventBridge, fetches only the two configured official HTTPS `nj.gov` pages, bounds response size and redirects, normalizes source records, and updates the catalog object. FastAPI has read-only catalog access; the refresh Lambda has catalog read/write access. API state filters operate entirely on the loaded catalog, so a New Jersey query does not invoke unrelated national sources.

## Legacy boundary

`legacy/cloudflare` contains the former Next/Vinext server components, TypeScript API routes, D1 schema/migrations, R2 document code, connectors, ingestion Worker, scripts, and tests. It is preserved as migration source material and is excluded from active package scripts and AWS assets.
