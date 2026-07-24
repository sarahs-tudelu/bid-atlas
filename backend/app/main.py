from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from .api.catalog import router as catalog_router
from .api.auth import require_user, router as auth_router
from .api.inbox import router as inbox_router
from .api.outreach import router as outreach_router
from .api.workspace import router as workspace_router
from .config import settings


def create_app() -> FastAPI:
    production = settings.environment.casefold() == "production"
    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        docs_url=None if production else "/api/docs",
        openapi_url=None if production else "/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["accept", "content-type"],
    )
    app.include_router(auth_router)
    protected = [Depends(require_user)]
    app.include_router(catalog_router, dependencies=protected)
    app.include_router(inbox_router, dependencies=protected)
    app.include_router(outreach_router, dependencies=protected)
    app.include_router(workspace_router, dependencies=protected)

    @app.get("/health", tags=["operations"])
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "bidatlas-api"}

    return app


app = create_app()
handler = Mangum(app, lifespan="off")
