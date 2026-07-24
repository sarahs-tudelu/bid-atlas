from __future__ import annotations

import math
from functools import lru_cache
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..dependencies import get_catalog, get_workspace_store
from ..services.catalog import ProjectCatalog
from ..services.gmail_inbox import (
    GMAIL_READONLY_SCOPE,
    assign_correspondence_project,
    sync_gmail_account,
)
from ..services.google import GoogleApiError
from ..services.state import WorkspaceStore
from .auth import require_user


router = APIRouter(prefix="/api/inbox", tags=["inbox"])


class ProjectAssignment(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)


@lru_cache(maxsize=1)
def _documents_client():
    if not settings.documents_bucket:
        return None
    import boto3

    return boto3.client("s3")


def _account(owner: str, store: WorkspaceStore) -> dict[str, Any]:
    account = store.get(owner, "google#account")
    if not account:
        raise HTTPException(status_code=401, detail="Reconnect your Tudelu Google account")
    return account


def _public_message(record: dict[str, Any]) -> dict[str, Any]:
    attachments = []
    message_id = str(record.get("messageId") or "")
    for index, attachment in enumerate(record.get("attachments") or []):
        attachments.append(
            {
                "name": attachment.get("name"),
                "mimeType": attachment.get("mimeType"),
                "size": attachment.get("size"),
                "status": attachment.get("status"),
                "downloadUrl": f"/api/inbox/attachments/{message_id}/{index}",
            }
        )
    return {**record, "attachments": attachments}


@router.get("")
def inbox(
    project_id: str = Query(default="", alias="projectId", max_length=300),
    status: Literal["all", "assigned", "unassigned"] = "all",
    query: str = Query(default="", alias="q", max_length=200),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=25, ge=10, le=50),
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    if limit not in {10, 25, 50}:
        raise HTTPException(status_code=422, detail="limit must be 10, 25, or 50")
    owner = str(user["email"])
    all_records = store.list_prefix(owner, "correspondence#")
    all_records.sort(
        key=lambda item: str(item.get("occurredAt") or item.get("updatedAt") or ""),
        reverse=True,
    )
    project_counts: dict[str, int] = {}
    for record in all_records:
        record_project_id = str(record.get("projectId") or "")
        if record_project_id:
            project_counts[record_project_id] = project_counts.get(record_project_id, 0) + 1

    normalized_query = query.strip().casefold()
    records = []
    for record in all_records:
        record_project_id = str(record.get("projectId") or "")
        if project_id and record_project_id != project_id:
            continue
        if status == "assigned" and not record_project_id:
            continue
        if status == "unassigned" and record_project_id:
            continue
        searchable = " ".join(
            str(record.get(field) or "")
            for field in ("subject", "from", "to", "snippet", "projectTitle", "sourceRecordId")
        ).casefold()
        if normalized_query and normalized_query not in searchable:
            continue
        records.append(record)

    total = len(records)
    total_pages = max(1, math.ceil(total / limit))
    active_page = min(page, total_pages)
    start = (active_page - 1) * limit
    account = store.get(owner, "google#account") or {}
    scopes = {str(value) for value in account.get("scopes", [])}
    projects = [
        {
            "id": str(project["id"]),
            "title": str(project.get("title") or ""),
            "sourceRecordId": str(project.get("sourceRecordId") or project["id"]),
            "messageCount": project_counts.get(str(project["id"]), 0),
        }
        for project in catalog.projects
    ]
    projects.sort(key=lambda item: (-item["messageCount"], item["title"]))
    return {
        "messages": [_public_message(record) for record in records[start : start + limit]],
        "projects": projects,
        "meta": {
            "total": total,
            "page": active_page,
            "pageSize": limit,
            "totalPages": total_pages,
            "allMessages": len(all_records),
            "assignedMessages": sum(1 for item in all_records if item.get("projectId")),
            "unassignedMessages": sum(1 for item in all_records if not item.get("projectId")),
            "gmailConnected": bool(account),
            "gmailReadAccess": GMAIL_READONLY_SCOPE in scopes,
            "sync": store.get(owner, "gmail-inbox#state"),
        },
    }


@router.post("/sync")
def sync_inbox(
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    owner = str(user["email"])
    try:
        result = sync_gmail_account(
            owner,
            _account(owner, store),
            store,
            catalog,
            document_store=_documents_client(),
            documents_bucket=settings.documents_bucket,
            max_messages=50,
        )
    except GoogleApiError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"sync": result}


@router.put("/messages/{message_id}/project")
def assign_project(
    payload: ProjectAssignment,
    message_id: str = Path(min_length=1, max_length=200),
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
    catalog: ProjectCatalog = Depends(get_catalog),
) -> dict[str, Any]:
    project = catalog.project(payload.projectId)
    if project is None:
        raise HTTPException(status_code=404, detail="Qualified project not found")
    message = assign_correspondence_project(store, str(user["email"]), message_id, project)
    if message is None:
        raise HTTPException(status_code=404, detail="Correspondence not found")
    return {"message": _public_message(message)}


@router.get("/attachments/{message_id}/{attachment_index}")
def download_attachment(
    message_id: str = Path(min_length=1, max_length=200),
    attachment_index: int = Path(ge=0, le=100),
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> RedirectResponse:
    record = store.get(str(user["email"]), f"correspondence#{message_id}")
    attachments = record.get("attachments", []) if record else []
    if attachment_index >= len(attachments):
        raise HTTPException(status_code=404, detail="Filed attachment not found")
    key = str(attachments[attachment_index].get("key") or "")
    client = _documents_client()
    if not key or client is None or not settings.documents_bucket:
        raise HTTPException(status_code=404, detail="Filed attachment not found")
    url = client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.documents_bucket,
            "Key": key,
            "ResponseContentDisposition": (
                f'attachment; filename="{attachments[attachment_index].get("name") or "attachment"}"'
            ),
        },
        ExpiresIn=300,
    )
    return RedirectResponse(url=url, status_code=307)
