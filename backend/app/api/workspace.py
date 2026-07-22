from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from ..config import settings
from ..dependencies import get_workspace_store
from ..services.google import oauth_is_configured
from ..services.state import WorkspaceStore
from .auth import require_user


router = APIRouter(prefix="/api", tags=["workspace"])


@router.get("/bid-drafts")
def get_bid_draft(
    project_id: str = Query(alias="projectId", min_length=1, max_length=300),
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    return {"draft": store.get(user["email"], f"draft#{project_id}")}


@router.post("/bid-drafts")
def save_bid_draft(
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    project_id = str(payload.get("projectId", "")).strip()
    if not project_id or len(project_id) > 300:
        raise HTTPException(status_code=400, detail="projectId is required")
    return {"draft": store.put(user["email"], f"draft#{project_id}", payload)}


@router.get("/source-monitors")
def list_source_monitors(
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    return {"monitors": store.list_prefix(user["email"], "monitor#")}


@router.post("/source-monitors", status_code=201)
def create_source_monitor(
    payload: dict[str, Any],
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    url = str(payload.get("url", "")).strip()
    if not name or not url.startswith("https://"):
        raise HTTPException(status_code=400, detail="A name and public HTTPS URL are required")
    monitor_id = uuid4().hex
    monitor = store.put(
        user["email"],
        f"monitor#{monitor_id}",
        {"id": monitor_id, "name": name, "url": url, "status": "pending-review"},
    )
    return {"monitor": monitor}


@router.get("/integrations")
def integrations() -> dict[str, Any]:
    sam_configured = os.getenv("BIDATLAS_SAM_ENABLED", "false").casefold() == "true"
    anthropic_configured = bool(
        settings.anthropic_api_key or settings.anthropic_api_key_parameter
    )
    return {
        "providers": [
            {
                "id": "gmail",
                "name": "Google Gmail",
                "configured": oauth_is_configured(),
                "detail": "Verified Tudelu login, published-contact history, and reviewed sending from the signed-in mailbox.",
            },
            {
                "id": "sam",
                "name": "SAM.gov",
                "configured": sam_configured,
                "detail": "Daily federal canopy discovery across all 50 states and D.C. through the official opportunities API.",
            },
            {
                "id": "anthropic",
                "name": "Anthropic Claude",
                "configured": anthropic_configured,
                "detail": "Optional SAM-style email personalization; default outreach templates do not call AI.",
            },
            {
                "id": "apollo",
                "name": "Apollo",
                "configured": False,
                "detail": "Professional contact enrichment stays disabled until explicitly configured.",
            },
        ]
    }
