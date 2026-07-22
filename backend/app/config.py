from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    """Runtime configuration loaded once from environment variables."""

    app_name: str
    environment: str
    data_directory: Path
    catalog_bucket: str | None
    catalog_key: str
    catalog_refresh_seconds: int
    workspace_table: str | None
    documents_bucket: str | None
    cors_origins: tuple[str, ...]


def load_settings() -> Settings:
    backend_root = Path(__file__).resolve().parents[1]
    configured_data = os.getenv("BIDATLAS_DATA_DIR")
    data_directory = (
        Path(configured_data).expanduser().resolve()
        if configured_data
        else (backend_root.parent / "data-export").resolve()
    )
    cors_origins = tuple(
        origin.strip()
        for origin in os.getenv("BIDATLAS_CORS_ORIGINS", "http://localhost:5173").split(",")
        if origin.strip()
    )
    return Settings(
        app_name="BidAtlas API",
        environment=os.getenv("BIDATLAS_ENVIRONMENT", "development"),
        data_directory=data_directory,
        catalog_bucket=os.getenv("BIDATLAS_CATALOG_BUCKET") or None,
        catalog_key=os.getenv("BIDATLAS_CATALOG_KEY", "current-projects.json"),
        catalog_refresh_seconds=max(
            int(os.getenv("BIDATLAS_CATALOG_REFRESH_SECONDS", "300")),
            0,
        ),
        workspace_table=os.getenv("BIDATLAS_WORKSPACE_TABLE") or None,
        documents_bucket=os.getenv("BIDATLAS_DOCUMENTS_BUCKET") or None,
        cors_origins=cors_origins,
    )


settings = load_settings()
