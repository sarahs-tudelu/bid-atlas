from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..dependencies import get_catalog, get_partner_directory, get_workspace_store
from ..services.ai_outreach import AnthropicGenerationError
from ..services.catalog import ProjectCatalog
from ..services.google import GoogleApiError, gmail_history, send_gmail_message
from ..services.gmail_inbox import record_sent_correspondence
from ..services.marketing_outreach import (
    MARKETING_COOLDOWN_DAYS,
    MARKETING_OWNER,
    SALES_REPLY_OWNERS,
    InstantlyApiError,
    active_marketing_cooldown,
    available_marketing_accounts,
    default_sales_reply_owner,
    instantly_is_configured,
    marketing_account,
    marketing_lock_key,
    marketing_reply_history,
    marketing_sender,
    record_marketing_route,
    sales_reply_owner,
    send_marketing_email,
)
from ..services.outreach import generate_outreach_draft, validate_draft
from ..services.partner_directory import PartnerDirectory
from ..services.qualification import published_contacts
from ..services.state import WorkspaceStore
from .auth import require_user


router = APIRouter(prefix="/api/outreach", tags=["outreach"])


class GenerateRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)
    regenerate: bool = False
    personalize: bool = False
    to: str = Field(default="", max_length=254)
    senderMode: Literal["marketing", "employee"] = "marketing"
    marketingSenderEmail: str = Field(default="", max_length=254)
    replyOwnerEmail: str = Field(default="", max_length=254)


class DraftRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=300)
    to: str = Field(default="", max_length=254)
    contactName: str = Field(default="", max_length=200)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=10_000)
    senderMode: Literal["marketing", "employee"] = "marketing"
    marketingSenderEmail: str = Field(default="", max_length=254)
    replyOwnerEmail: str = Field(default="", max_length=254)


def _project_or_404(
    project_id: str,
    catalog: ProjectCatalog,
    directory: PartnerDirectory,
) -> dict[str, Any]:
    project = catalog.project(project_id)
    if project is None and project_id.startswith("prospect:"):
        project = directory.outreach_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Qualified project or prospect not found")
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


def _sync_gmail_history(
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
    sender_mode: str,
    marketing_sender_email: str,
    reply_owner_email: str,
) -> dict[str, Any]:
    try:
        return generate_outreach_draft(
            project,
            user,
            history,
            personalize=personalize,
            recipient=recipient,
            sender_mode=sender_mode,
            marketing_sender_email=marketing_sender_email,
            reply_owner_email=reply_owner_email,
        )
    except AnthropicGenerationError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def _validated_delivery(
    draft: dict[str, Any],
    user: dict[str, Any],
) -> dict[str, Any]:
    sender_mode = str(draft.get("senderMode") or "marketing")
    if sender_mode == "employee":
        owner_email = str(user["email"]).strip().lower()
        return {
            **draft,
            "senderMode": "employee",
            "senderEmail": owner_email,
            "replyOwnerEmail": owner_email,
            "replyOwnerName": str(user.get("name") or owner_email),
        }
    if sender_mode != "marketing":
        raise HTTPException(status_code=400, detail="Sender mode must be marketing or employee")
    requested_sender = str(
        draft.get("marketingSenderEmail") or draft.get("senderEmail") or ""
    )
    try:
        sender_account = marketing_account(requested_sender)
    except InstantlyApiError as error:
        status_code = (
            400
            if "not available to BidAtlas" in str(error)
            else 502
        )
        raise HTTPException(status_code=status_code, detail=str(error)) from error
    owner = sales_reply_owner(str(draft.get("replyOwnerEmail") or ""))
    if owner is None:
        raise HTTPException(
            status_code=400,
            detail="Marketing replies must be assigned to a designated Tudelu sales owner",
        )
    return {
        **draft,
        "senderMode": "marketing",
        "senderEmail": sender_account["email"],
        "marketingSenderEmail": sender_account["email"],
        "replyOwnerEmail": owner["email"],
        "replyOwnerName": owner["name"],
    }


@router.get("/config")
def outreach_config(
    user: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    default_owner = default_sales_reply_owner(str(user["email"]))
    marketing_accounts, accounts_warning = available_marketing_accounts()
    return {
        "defaultSenderMode": "marketing",
        "marketing": {
            "configured": instantly_is_configured(),
            "email": marketing_sender(),
            "name": "Alex Turner",
        },
        "marketingAccounts": marketing_accounts,
        "marketingAccountsWarning": accounts_warning,
        "employee": {"email": user["email"], "name": user.get("name") or user["email"]},
        "salesReplyOwners": SALES_REPLY_OWNERS,
        "defaultReplyOwnerEmail": default_owner["email"],
    }


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
    directory: PartnerDirectory = Depends(get_partner_directory),
) -> dict[str, Any]:
    owner = user["email"]
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is not None and existing.get("status") == "sent":
        raise HTTPException(status_code=409, detail="Sent outreach cannot be regenerated")
    if (
        existing is not None
        and not payload.regenerate
        and existing.get("senderMode") == payload.senderMode
        and (
            payload.senderMode != "marketing"
            or str(existing.get("senderEmail") or marketing_sender())
            == (payload.marketingSenderEmail.strip().lower() or marketing_sender())
        )
    ):
        return {"draft": existing, "reused": True}
    project = _project_or_404(payload.projectId, catalog, directory)
    if not published_contacts(project):
        raise HTTPException(
            status_code=400,
            detail="This project has a published phone contact but no email contact; use the call option",
        )
    contact_email = payload.to.strip().lower() or published_contacts(project)[0]["email"]
    history = (
        marketing_reply_history(store, contact_email)
        if payload.senderMode == "marketing"
        else _sync_gmail_history(owner, project, store)
    )
    draft = _generate_draft(
        project,
        user,
        history,
        personalize=payload.personalize,
        recipient=payload.to,
        sender_mode=payload.senderMode,
        marketing_sender_email=payload.marketingSenderEmail,
        reply_owner_email=payload.replyOwnerEmail,
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
    directory: PartnerDirectory = Depends(get_partner_directory),
) -> dict[str, Any]:
    owner = user["email"]
    project = _project_or_404(payload.projectId, catalog, directory)
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is None:
        raise HTTPException(status_code=404, detail="Generate an email draft before refreshing Gmail history")
    stored = store.put(
        owner,
        f"outreach#{payload.projectId}",
        {
            **existing,
            "emailHistory": (
                marketing_reply_history(store, str(existing.get("to") or ""))
                if existing.get("senderMode") == "marketing"
                else _sync_gmail_history(owner, project, store)
            ),
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
    directory: PartnerDirectory = Depends(get_partner_directory),
) -> dict[str, Any]:
    owner = user["email"]
    project = _project_or_404(payload.projectId, catalog, directory)
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing is None:
        raise HTTPException(status_code=404, detail="Generate an email draft before saving it")
    if existing.get("status") == "sent":
        raise HTTPException(status_code=409, detail="Sent outreach cannot be edited")
    try:
        draft = _validated_delivery(
            validate_draft({**existing, **payload.model_dump(), "status": "draft"}),
            user,
        )
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
    directory: PartnerDirectory = Depends(get_partner_directory),
) -> dict[str, Any]:
    owner = user["email"]
    project = _project_or_404(payload.projectId, catalog, directory)
    existing = store.get(owner, f"outreach#{payload.projectId}")
    if existing and existing.get("status") == "sent":
        raise HTTPException(status_code=409, detail="This outreach message is already marked sent")
    try:
        draft = _validated_delivery(
            validate_draft({**(existing or {}), **payload.model_dump()}),
            user,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    _validate_published_recipient(draft, project)

    marketing_delivery = draft["senderMode"] == "marketing"
    if marketing_delivery:
        cooldown = active_marketing_cooldown(store, draft["to"])
        if cooldown:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Marketing outreach to this contact is inside the "
                    f"{MARKETING_COOLDOWN_DAYS}-day cooldown"
                ),
            )
    lock_owner = MARKETING_OWNER if marketing_delivery else owner
    lock_key = (
        marketing_lock_key(draft["to"])
        if marketing_delivery
        else f"gmail-send-lock#{payload.projectId}"
    )
    if not store.put_if_absent(lock_owner, lock_key, {"projectId": payload.projectId}):
        raise HTTPException(status_code=409, detail="This message is already being sent")
    try:
        if marketing_delivery:
            provider = send_marketing_email(
                recipient=draft["to"],
                subject=draft["subject"],
                body=draft["body"],
                sender_email=draft["senderEmail"],
            )
        else:
            gmail = send_gmail_message(
                owner,
                _google_account(owner, store),
                store,
                recipient=draft["to"],
                subject=draft["subject"],
                body=draft["body"],
            )
            provider = {
                "provider": "gmail",
                "sender": owner,
                "messageId": gmail["messageId"],
                "threadId": gmail["threadId"],
            }
        sent_at = datetime.now(timezone.utc).isoformat()
        if marketing_delivery:
            record_marketing_route(
                store,
                recipient=draft["to"],
                subject=draft["subject"],
                project_id=payload.projectId,
                project_title=str(draft.get("projectTitle") or ""),
                sent_by=owner,
                reply_owner_email=draft["replyOwnerEmail"],
                sent_at=sent_at,
                sender_email=draft["senderEmail"],
            )
        sent = store.put(
            owner,
            f"outreach#{payload.projectId}",
            {
                **draft,
                "status": "sent",
                "sentAt": sent_at,
                "sentBy": owner,
                "senderEmail": provider["sender"],
                "deliveryProvider": provider["provider"],
                **(
                    {"gmailMessageId": provider["messageId"], "gmailThreadId": provider["threadId"]}
                    if provider["provider"] == "gmail"
                    else {}
                ),
            },
        )
        if provider["provider"] == "gmail":
            record_sent_correspondence(
                store,
                owner,
                project,
                draft,
                message_id=provider["messageId"],
                thread_id=provider["threadId"],
                sent_at=sent_at,
            )
    except (GoogleApiError, InstantlyApiError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    finally:
        store.delete(lock_owner, lock_key)
    return {"draft": sent}


@router.get("/history")
def history(
    user: dict[str, Any] = Depends(require_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    records = store.list_prefix(user["email"], "outreach#")
    records.sort(key=lambda item: str(item.get("sentAt") or item.get("updatedAt") or ""), reverse=True)
    return {"history": records}
