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
    public_url: str
    google_redirect_uri: str
    google_scopes: tuple[str, ...]
    google_client_id: str | None
    google_client_secret: str | None
    session_secret: str | None
    google_client_id_parameter: str | None
    google_client_secret_parameter: str | None
    session_secret_parameter: str | None
    anthropic_api_key: str | None
    anthropic_api_key_parameter: str | None
    anthropic_model: str


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
        public_url=os.getenv("BIDATLAS_PUBLIC_URL", "http://localhost:5173").rstrip("/"),
        google_redirect_uri=os.getenv(
            "BIDATLAS_GOOGLE_REDIRECT_URI",
            "http://localhost:8000/api/auth/google/callback",
        ),
        google_scopes=tuple(
            scope.strip()
            for scope in os.getenv(
                "BIDATLAS_GOOGLE_SCOPES",
                "openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
            ).split()
            if scope.strip()
        ),
        google_client_id=os.getenv("BIDATLAS_GOOGLE_CLIENT_ID") or None,
        google_client_secret=os.getenv("BIDATLAS_GOOGLE_CLIENT_SECRET") or None,
        session_secret=os.getenv("BIDATLAS_SESSION_SECRET") or None,
        google_client_id_parameter=os.getenv("BIDATLAS_GOOGLE_CLIENT_ID_PARAMETER") or None,
        google_client_secret_parameter=os.getenv("BIDATLAS_GOOGLE_CLIENT_SECRET_PARAMETER") or None,
        session_secret_parameter=os.getenv("BIDATLAS_SESSION_SECRET_PARAMETER") or None,
        anthropic_api_key=os.getenv("BIDATLAS_ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or None,
        anthropic_api_key_parameter=os.getenv("BIDATLAS_ANTHROPIC_API_KEY_PARAMETER") or None,
        anthropic_model=os.getenv("BIDATLAS_ANTHROPIC_MODEL", "claude-sonnet-4-6"),
    )


settings = load_settings()
