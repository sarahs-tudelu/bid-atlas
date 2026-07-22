from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..dependencies import get_catalog, get_workspace_store
from ..services.ai_outreach import AnthropicGenerationError
from ..services.catalog import ProjectCatalog
from ..services.google import GoogleApiError, gmail_history, send_gmail_message
from ..services.outreach import generate_outreach_draft, validate_draft
from ..services.qualification import published_contacts
from ..services.state import WorkspaceStore
from .auth import require_user


router = APIRouter(prefix="/api/outreach", tags=["outreach"])


class GenerateRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)
    regenerate: bool = False
    personalize: bool = False
    to: str = Field(default="", max_length=254)


class DraftRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)
    to: str = Field(default="", max_length=254)
    contactName: str = Field(default="", max_length=200)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=10_000)


def _project_or_404(project_id: str, catalog: ProjectCatalog) -> dict[str, Any]:
    project = catalog.project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Qualified project not found")
    return project


def _google_account(owner: str, store: WorkspaceStore) -> dict[str, Any]:
    account = store.get(owner, "google#account")
    if not account:
        raise HTTPException(status_code=401, detail="Reconnect your Tudelu Google account")
    return account


def _validate_published_recipient(draft: dict[str, Any], project: dict[str, Any]) -> None:
    published = {contact["email"] for contact in published_contacts(project)}
    if draft["to"] not in published:
        raise HTTPException(
            status_code=400,
            detail="Recipient must be an email address published with this project",
        )


def _sync_history(
    owner: str,
    project: dict[str, Any],
    store: WorkspaceStore,
) -> list[dict[str, Any]]:
    try:
        return gmail_history(
            owner,
            _google_account(owner, store),
            store,
            [contact["email"] for contact in published_contacts(project)],
        )
    except GoogleApiError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


def _generate_draft(
    project: dict[str, Any],
    user: dict[str, Any],
    history: list[dict[str, Any]],
    *,
    personalize: bool,
    recipient: str,
) -> dict[str, Any]:
    try:
        return generate_outreach_draft(
            project,
            user,
            history,
            personalize=personalize,
            recipient=recipient,
        )
    except AnthropicGenerationError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("/draft")
def get_draft(
    project_id: str = Query(alias="projectId", min_length=1, max_length=300),
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    return {"draft": store.get(user["email"], f"outreach#{project_id}")}


@router.post("/generate")
def generate(
    payload: GenerateRequest,
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    owner = user["email"]
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is not None and existing.get("status") == "sent":
        raise HTTPException(status_code=409, detail="Sent outreach cannot be regenerated")
    if existing is not None and not payload.regenerate:
        return {"draft": existing, "reused": True}
    project = _project_or_404(payload.projectId, catalog)
    if not published_contacts(project):
        raise HTTPException(
            status_code=400,
            detail="This project has a published phone contact but no email contact; use the call option",
        )
    history = _sync_history(owner, project, store)
    draft = _generate_draft(
        project,
        user,
        history,
        personalize=payload.personalize,
        recipient=payload.to,
    )
    draft["emailHistory"] = history
    draft["historySyncedAt"] = datetime.now(timezone.utc).isoformat()
    stored = store.put(owner, f"outreach#{payload.projectId}", draft)
    return {"draft": stored, "reused": False}


@router.post("/gmail-history")
def refresh_gmail_history(
    payload: GenerateRequest,
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    owner = user["email"]
    project = _project_or_404(payload.projectId, catalog)
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is None:
        raise HTTPException(status_code=404, detail="Generate an email draft before refreshing Gmail history")
    stored = store.put(
        owner,
        f"outreach#{payload.projectId}",
        {
            **existing,
            "emailHistory": _sync_history(owner, project, store),
            "historySyncedAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return {"draft": stored}


@router.put("/draft")
def save_draft(
    payload: DraftRequest,
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    owner = user["email"]
    project = _project_or_404(payload.projectId, catalog)
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is None:
        raise HTTPException(status_code=404, detail="Generate an email draft before saving it")
    if existing.get("status") == "sent":
        raise HTTPException(status_code=409, detail="Sent outreach cannot be edited")
    try:
        draft = validate_draft({**existing, **payload.model_dump(), "status": "draft"})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    _validate_published_recipient(draft, project)
    return {"draft": store.put(owner, f"outreach#{payload.projectId}", draft)}


@router.post("/send")
def send(
    payload: DraftRequest,
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    owner = user["email"]
    project = _project_or_404(payload.projectId, catalog)
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing and existing.get("status") == "sent":
        raise HTTPException(status_code=409, detail="This outreach message is already marked sent")
    try:
        draft = validate_draft({**(existing or {}), **payload.model_dump()})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    _validate_published_recipient(draft, project)

    lock_key = f"gmail-send-lock#{payload.projectId}"
    if not store.put_if_absent(owner, lock_key, {"projectId": payload.projectId}):
        raise HTTPException(status_code=409, detail="This message is already being sent")
    try:
        gmail = send_gmail_message(
            owner,
            _google_account(owner, store),
            store,
            recipient=draft["to"],
            subject=draft["subject"],
            body=draft["body"],
        )
        sent = store.put(
            owner,
            f"outreach#{payload.projectId}",
            {
                **draft,
                "status": "sent",
                "sentAt": datetime.now(timezone.utc).isoformat(),
                "sentBy": owner,
                "gmailMessageId": gmail["messageId"],
                "gmailThreadId": gmail["threadId"],
            },
        )
    except GoogleApiError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    finally:
        store.delete(owner, lock_key)
    return {"draft": sent}


@router.get("/history")
def history(
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    records = store.list_prefix(user["email"], "outreach#")
    records.sort(key=lambda item: str(item.get("sentAt") or item.get("updatedAt") or ""), reverse=True)
    return {"history": records}
