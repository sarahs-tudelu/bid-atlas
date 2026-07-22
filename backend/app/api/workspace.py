from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from ..dependencies import get_workspace_store
from ..services.state import WorkspaceStore


router = APIRouter(prefix="/api", tags=["workspace"])


def workspace_owner(x_bidatlas_user: str | None = Header(default=None)) -> str:
    """Use the upstream identity when available and a local workspace otherwise."""

    value = (x_bidatlas_user or "local@bidatlas.app").strip().lower()
    if len(value) > 254 or "@" not in value:
        raise HTTPException(status_code=400, detail="Invalid workspace identity")
    return value


@router.get("/bid-drafts")
def get_bid_draft(
    project_id: str = Query(alias="projectId", min_length=1, max_length=300),
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    return {"draft": store.get(owner, f"draft#{project_id}")}


@router.post("/bid-drafts")
def save_bid_draft(
    payload: dict[str, Any],
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    project_id = str(payload.get("projectId", "")).strip()
    if not project_id or len(project_id) > 300:
        raise HTTPException(status_code=400, detail="projectId is required")
    return {"draft": store.put(owner, f"draft#{project_id}", payload)}


@router.get("/source-monitors")
def list_source_monitors(
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    return {"monitors": store.list_prefix(owner, "monitor#")}


@router.post("/source-monitors", status_code=201)
def create_source_monitor(
    payload: dict[str, Any],
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    url = str(payload.get("url", "")).strip()
    if not name or not url.startswith("https://"):
        raise HTTPException(status_code=400, detail="A name and public HTTPS URL are required")
    monitor_id = uuid4().hex
    monitor = store.put(
        owner,
        f"monitor#{monitor_id}",
        {"id": monitor_id, "name": name, "url": url, "status": "pending-review"},
    )
    return {"monitor": monitor}


@router.get("/integrations")
def integrations() -> dict[str, Any]:
    sam_configured = bool(
        os.getenv("SAM_API_KEY", "").strip()
        or os.getenv("BIDATLAS_SAM_API_KEY_PARAMETER", "").strip()
    )
    return {
        "providers": [
            {
                "id": "sam",
                "name": "SAM.gov",
                "configured": sam_configured,
                "detail": "Daily Northeast federal canopy discovery through the official opportunities API.",
            },
            {
                "id": "apollo",
                "name": "Apollo",
                "configured": False,
                "detail": "Professional contact enrichment stays disabled until explicitly configured.",
            },
        ]
    }
