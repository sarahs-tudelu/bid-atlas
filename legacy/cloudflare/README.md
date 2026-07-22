# Legacy Cloudflare implementation

This directory preserves the pre-AWS BidAtlas implementation:

- Next/Vinext server-rendered pages and route handlers
- TypeScript public-source connectors
- Cloudflare Worker ingestion and discovery jobs
- D1 schema, migrations, repositories, and tests
- R2 document workflows

It is intentionally outside the active React/FastAPI build. Use it as source material when porting an individual connector or workflow, and add new production behavior under `backend` or `frontend` with tests there.
