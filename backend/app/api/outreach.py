from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..dependencies import get_catalog, get_workspace_store
from ..services.catalog import ProjectCatalog
from ..services.outreach import generate_outreach_draft, validate_draft
from ..services.state import WorkspaceStore
from .workspace import workspace_owner


router = APIRouter(prefix="/api/outreach", tags=["outreach"])


class GenerateRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)
    regenerate: bool = False


class DraftRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)
    to: str = Field(default="", max_length=254)
    contactName: str = Field(default="", max_length=200)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=10_000)


def _project_or_404(project_id: str, catalog: ProjectCatalog) -> dict[str, Any]:
    project = catalog.project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/draft")
def get_draft(
    project_id: str = Query(alias="projectId", min_length=1, max_length=300),
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    return {"draft": store.get(owner, f"outreach#{project_id}")}


@router.post("/generate")
def generate(
    payload: GenerateRequest,
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is not None and not payload.regenerate:
        return {"draft": existing, "reused": True}
    project = _project_or_404(payload.projectId, catalog)
    draft = store.put(owner, f"outreach#{payload.projectId}", generate_outreach_draft(project))
    return {"draft": draft, "reused": False}


@router.put("/draft")
def save_draft(
    payload: DraftRequest,
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    project = _project_or_404(payload.projectId, catalog)
    existing = store.get(owner, f"outreach#{payload.projectId}") or generate_outreach_draft(project)
    try:
        draft = validate_draft({**existing, **payload.model_dump(), "status": "draft"})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"draft": store.put(owner, f"outreach#{payload.projectId}", draft)}


@router.post("/mark-sent")
def mark_sent(
    payload: DraftRequest,
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    _project_or_404(payload.projectId, catalog)
    try:
        draft = validate_draft(payload.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not draft["to"]:
        raise HTTPException(status_code=400, detail="Recipient email is required before marking outreach sent")
    sent_at = datetime.now(timezone.utc).isoformat()
    stored = store.put(
        owner,
        f"outreach#{payload.projectId}",
        {**draft, "status": "sent", "sentAt": sent_at},
    )
    return {"draft": stored}


@router.get("/history")
def history(
    owner: str = Depends(workspace_owner),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    records = store.list_prefix(owner, "outreach#")
    records.sort(key=lambda item: str(item.get("sentAt") or item.get("updatedAt") or ""), reverse=True)
    return {"history": records}
