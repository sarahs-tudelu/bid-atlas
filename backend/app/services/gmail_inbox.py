from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses
from pathlib import PurePath
from typing import Any, Protocol
from urllib.parse import urlencode

from .catalog import ProjectCatalog
from .google import GoogleApiError, gmail_request
from .qualification import published_contacts
from .state import WorkspaceStore


GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
MAX_CONTACTS_PER_QUERY = 12
MAX_CONTACT_QUERIES = 8
MAX_MESSAGES_PER_SYNC = 250
MAX_ATTACHMENT_BYTES = 20_000_000
MAX_MESSAGE_ATTACHMENT_BYTES = 30_000_000
INITIAL_LOOKBACK_DAYS = 90
SYNC_OVERLAP_DAYS = 2
TITLE_STOPWORDS = {
    "and",
    "bid",
    "building",
    "construction",
    "contract",
    "for",
    "from",
    "improvements",
    "invitation",
    "project",
    "proposal",
    "renovation",
    "replacement",
    "request",
    "services",
    "the",
    "with",
}


class DocumentStore(Protocol):
    def put_object(self, **kwargs: Any) -> dict[str, Any]: ...


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _headers(message: dict[str, Any]) -> dict[str, str]:
    return {
        str(item.get("name") or "").casefold(): str(item.get("value") or "").strip()
        for item in message.get("payload", {}).get("headers", [])
    }


def _addresses(*values: str) -> set[str]:
    return {
        email.strip().casefold()
        for _, email in getaddresses([value for value in values if value.strip()])
        if email.strip() and "@" in email
    }


def _title_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.casefold())
        if len(token) >= 4 and token not in TITLE_STOPWORDS
    }


def _occurred_at(message: dict[str, Any], headers: dict[str, str]) -> str:
    milliseconds = str(message.get("internalDate") or "")
    if milliseconds.isdigit():
        return datetime.fromtimestamp(int(milliseconds) / 1000, tz=timezone.utc).isoformat()
    return headers.get("date") or _now().isoformat()


def _safe_filename(value: str) -> str:
    name = PurePath(value.replace("\\", "/")).name.strip()
    normalized = re.sub(r"[^A-Za-z0-9._() -]+", "_", name)
    return normalized[:180] or "attachment"


def _decode_base64url(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))


def _attachment_parts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    pending = [payload]
    while pending:
        part = pending.pop()
        pending.extend(item for item in part.get("parts", []) if isinstance(item, dict))
        filename = str(part.get("filename") or "").strip()
        body = part.get("body") if isinstance(part.get("body"), dict) else {}
        if filename and (body.get("attachmentId") or body.get("data")):
            found.append(
                {
                    "filename": filename,
                    "mimeType": str(part.get("mimeType") or "application/octet-stream"),
                    "attachmentId": str(body.get("attachmentId") or ""),
                    "data": str(body.get("data") or ""),
                    "declaredSize": int(body.get("size") or 0),
                }
            )
    return found


def _project_index(
    catalog: ProjectCatalog,
) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]]]:
    projects = {str(project["id"]): project for project in catalog.projects}
    contacts: dict[str, set[str]] = {}
    for project_id, project in projects.items():
        for contact in published_contacts(project):
            contacts.setdefault(contact["email"], set()).add(project_id)
    return projects, contacts


def _thread_projects(store: WorkspaceStore, owner: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for record in store.list_prefix(owner, "outreach#"):
        thread_id = str(record.get("gmailThreadId") or "")
        project_id = str(record.get("projectId") or "")
        if thread_id and project_id:
            mapping[thread_id] = project_id
    for record in store.list_prefix(owner, "correspondence#"):
        thread_id = str(record.get("threadId") or "")
        project_id = str(record.get("projectId") or "")
        if thread_id and project_id:
            mapping[thread_id] = project_id
    return mapping


def _match_project(
    message: dict[str, Any],
    headers: dict[str, str],
    projects: dict[str, dict[str, Any]],
    contact_projects: dict[str, set[str]],
    thread_projects: dict[str, str],
) -> dict[str, Any]:
    thread_id = str(message.get("threadId") or "")
    if thread_id in thread_projects and thread_projects[thread_id] in projects:
        return {
            "projectId": thread_projects[thread_id],
            "candidateProjectIds": [thread_projects[thread_id]],
            "matchedBy": "gmail-thread",
            "matchConfidence": "high",
        }

    involved = _addresses(
        headers.get("from", ""),
        headers.get("to", ""),
        headers.get("cc", ""),
        headers.get("bcc", ""),
    )
    candidates: set[str] = set()
    for email in involved:
        candidates.update(contact_projects.get(email, set()))
    text = f"{headers.get('subject', '')} {message.get('snippet', '')}".casefold()

    referenced = {
        project_id
        for project_id, project in projects.items()
        if (
            reference := str(project.get("sourceRecordId") or "").strip().casefold()
        )
        and len(reference) >= 4
        and reference in text
    }
    if len(referenced) == 1:
        project_id = next(iter(referenced))
        return {
            "projectId": project_id,
            "candidateProjectIds": sorted(candidates | referenced),
            "matchedBy": "project-reference",
            "matchConfidence": "high",
        }
    candidates.update(referenced)

    if len(candidates) == 1:
        project_id = next(iter(candidates))
        return {
            "projectId": project_id,
            "candidateProjectIds": [project_id],
            "matchedBy": "published-contact",
            "matchConfidence": "medium",
        }
    if candidates:
        message_tokens = _title_tokens(text)
        scores = {
            project_id: len(_title_tokens(str(projects[project_id].get("title") or "")) & message_tokens)
            for project_id in candidates
        }
        best_score = max(scores.values())
        winners = [project_id for project_id, score in scores.items() if score == best_score]
        if best_score >= 2 and len(winners) == 1:
            return {
                "projectId": winners[0],
                "candidateProjectIds": sorted(candidates),
                "matchedBy": "contact-and-title",
                "matchConfidence": "medium",
            }
    return {
        "projectId": "",
        "candidateProjectIds": sorted(candidates)[:10],
        "matchedBy": "needs-review",
        "matchConfidence": "unassigned",
    }


def _project_fields(project_id: str, projects: dict[str, dict[str, Any]]) -> dict[str, str]:
    project = projects.get(project_id)
    if project is None:
        return {"projectId": "", "projectTitle": "", "sourceRecordId": ""}
    return {
        "projectId": project_id,
        "projectTitle": str(project.get("title") or ""),
        "sourceRecordId": str(project.get("sourceRecordId") or project_id),
    }


def _attachment_bytes(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    message_id: str,
    part: dict[str, Any],
) -> tuple[bytes, dict[str, Any]]:
    if part["data"]:
        return _decode_base64url(part["data"]), account
    attachment_id = part["attachmentId"]
    response, active = gmail_request(
        owner,
        account,
        store,
        f"/messages/{message_id}/attachments/{attachment_id}",
    )
    return _decode_base64url(str(response.get("data") or "")), active


def _file_attachments(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    document_store: DocumentStore | None,
    documents_bucket: str | None,
    message: dict[str, Any],
    existing: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    if existing and isinstance(existing.get("attachments"), list):
        return list(existing["attachments"]), account, []
    parts = _attachment_parts(message.get("payload", {}))
    if not parts or document_store is None or not documents_bucket:
        return [], account, []

    message_id = str(message.get("id") or "")
    owner_hash = hashlib.sha256(owner.casefold().encode("utf-8")).hexdigest()[:24]
    attachments: list[dict[str, Any]] = []
    warnings: list[str] = []
    total_bytes = 0
    active = account
    for index, part in enumerate(parts):
        declared_size = int(part.get("declaredSize") or 0)
        filename = _safe_filename(part["filename"])
        if declared_size > MAX_ATTACHMENT_BYTES:
            warnings.append(f"{filename} exceeded the 20 MB filing limit")
            continue
        try:
            content, active = _attachment_bytes(owner, active, store, message_id, part)
        except (GoogleApiError, ValueError) as error:
            warnings.append(f"{filename} could not be downloaded: {error}")
            continue
        total_bytes += len(content)
        if len(content) > MAX_ATTACHMENT_BYTES or total_bytes > MAX_MESSAGE_ATTACHMENT_BYTES:
            warnings.append(f"{filename} exceeded the message filing limit")
            continue
        key = f"gmail/{owner_hash}/{message_id}/{index:02d}-{filename}"
        document_store.put_object(
            Bucket=documents_bucket,
            Key=key,
            Body=content,
            ContentType=part["mimeType"],
            Metadata={"gmail-message-id": message_id, "owner-hash": owner_hash},
        )
        attachments.append(
            {
                "name": filename,
                "mimeType": part["mimeType"],
                "size": len(content),
                "key": key,
                "status": "filed",
            }
        )
    return attachments, active, warnings


def _message_record(
    owner: str,
    message: dict[str, Any],
    projects: dict[str, dict[str, Any]],
    contact_projects: dict[str, set[str]],
    thread_projects: dict[str, str],
    attachments: list[dict[str, Any]],
    attachment_warnings: list[str],
) -> dict[str, Any]:
    headers = _headers(message)
    match = _match_project(message, headers, projects, contact_projects, thread_projects)
    project = _project_fields(match["projectId"], projects)
    from_addresses = _addresses(headers.get("from", ""))
    direction = "sent" if owner.casefold() in from_addresses else "received"
    return {
        "messageId": str(message.get("id") or ""),
        "threadId": str(message.get("threadId") or ""),
        **project,
        **match,
        "subject": headers.get("subject") or "(No subject)",
        "from": headers.get("from", ""),
        "to": headers.get("to", ""),
        "cc": headers.get("cc", ""),
        "occurredAt": _occurred_at(message, headers),
        "direction": direction,
        "snippet": str(message.get("snippet") or "")[:500],
        "attachments": attachments,
        "hasAttachments": bool(attachments or _attachment_parts(message.get("payload", {}))),
        "attachmentWarnings": attachment_warnings,
        "labels": [str(value) for value in message.get("labelIds", [])],
    }


def record_sent_correspondence(
    store: WorkspaceStore,
    owner: str,
    project: dict[str, Any],
    draft: dict[str, Any],
    *,
    message_id: str,
    thread_id: str,
    sent_at: str,
) -> dict[str, Any]:
    """Log a Gmail send immediately; the background sync enriches it later."""

    payload = {
        "messageId": message_id,
        "threadId": thread_id,
        "projectId": str(project["id"]),
        "projectTitle": str(project.get("title") or draft.get("projectTitle") or ""),
        "sourceRecordId": str(
            project.get("sourceRecordId") or draft.get("sourceRecordId") or project["id"]
        ),
        "candidateProjectIds": [str(project["id"])],
        "matchedBy": "sent-from-project",
        "matchConfidence": "high",
        "subject": str(draft.get("subject") or ""),
        "from": owner,
        "to": str(draft.get("to") or ""),
        "cc": "",
        "occurredAt": sent_at,
        "direction": "sent",
        "snippet": str(draft.get("body") or "")[:500],
        "attachments": [],
        "hasAttachments": False,
        "attachmentWarnings": [],
        "labels": ["SENT"],
    }
    return store.put(owner, f"correspondence#{message_id}", payload)


def assign_correspondence_project(
    store: WorkspaceStore,
    owner: str,
    message_id: str,
    project: dict[str, Any],
) -> dict[str, Any] | None:
    existing = store.get(owner, f"correspondence#{message_id}")
    if existing is None:
        return None
    return store.put(
        owner,
        f"correspondence#{message_id}",
        {
            **existing,
            "projectId": str(project["id"]),
            "projectTitle": str(project.get("title") or ""),
            "sourceRecordId": str(project.get("sourceRecordId") or project["id"]),
            "candidateProjectIds": [str(project["id"])],
            "matchedBy": "manual",
            "matchConfidence": "high",
        },
    )


def sync_gmail_account(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    catalog: ProjectCatalog,
    *,
    document_store: DocumentStore | None = None,
    documents_bucket: str | None = None,
    max_messages: int = MAX_MESSAGES_PER_SYNC,
) -> dict[str, Any]:
    """Sync only correspondence tied to known projects, contacts, and tracked threads."""

    scopes = {str(value) for value in account.get("scopes", [])}
    if GMAIL_READONLY_SCOPE not in scopes:
        raise GoogleApiError("Reconnect Google to grant read-only Gmail access for the project inbox")

    projects, contact_projects = _project_index(catalog)
    thread_projects = _thread_projects(store, owner)
    state = store.get(owner, "gmail-inbox#state") or {}
    last_sync = str(state.get("lastSuccessfulSync") or "")
    has_checkpoint = bool(last_sync)
    try:
        last_sync_date = datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
    except ValueError:
        last_sync_date = _now() - timedelta(days=INITIAL_LOOKBACK_DAYS)
    if last_sync_date.tzinfo is None:
        last_sync_date = last_sync_date.replace(tzinfo=timezone.utc)
    overlap = SYNC_OVERLAP_DAYS if has_checkpoint else 0
    after = (last_sync_date.astimezone(timezone.utc) - timedelta(days=overlap)).date()
    message_limit = min(max(int(max_messages), 1), MAX_MESSAGES_PER_SYNC)

    active = account
    message_ids: set[str] = set()
    contacts = sorted(contact_projects)
    for start in range(0, len(contacts), MAX_CONTACTS_PER_QUERY):
        if start // MAX_CONTACTS_PER_QUERY >= MAX_CONTACT_QUERIES:
            break
        chunk = contacts[start : start + MAX_CONTACTS_PER_QUERY]
        contact_query = "{" + " ".join(
            f"from:{email} to:{email}" for email in chunk
        ) + "}"
        query = f"after:{after:%Y/%m/%d} {contact_query}"
        listing, active = gmail_request(
            owner,
            active,
            store,
            f"/messages?{urlencode({'q': query, 'maxResults': 100})}",
        )
        message_ids.update(
            str(item.get("id") or "")
            for item in listing.get("messages", [])
            if item.get("id")
        )

    messages: dict[str, dict[str, Any]] = {}
    for message_id in sorted(message_ids):
        if len(messages) >= message_limit:
            break
        message, active = gmail_request(
            owner,
            active,
            store,
            f"/messages/{message_id}?{urlencode({'format': 'full'})}",
        )
        messages[message_id] = message

    for thread_id in list(thread_projects)[:100]:
        if len(messages) >= message_limit:
            break
        thread, active = gmail_request(
            owner,
            active,
            store,
            f"/threads/{thread_id}?{urlencode({'format': 'full'})}",
        )
        for message in thread.get("messages", []):
            message_id = str(message.get("id") or "")
            if message_id:
                messages[message_id] = message
            if len(messages) >= message_limit:
                break

    stored_count = 0
    assigned_count = 0
    attachment_count = 0
    warnings: list[str] = []
    for message in messages.values():
        message_id = str(message.get("id") or "")
        if not message_id:
            continue
        existing = store.get(owner, f"correspondence#{message_id}")
        attachments, active, file_warnings = _file_attachments(
            owner,
            active,
            store,
            document_store,
            documents_bucket,
            message,
            existing,
        )
        record = _message_record(
            owner,
            message,
            projects,
            contact_projects,
            thread_projects,
            attachments,
            file_warnings,
        )
        # Preserve a manual assignment even if the automatic evidence remains ambiguous.
        if existing and existing.get("matchedBy") == "manual":
            manual_project_id = str(existing.get("projectId") or "")
            record = {
                **record,
                **_project_fields(manual_project_id, projects),
                "candidateProjectIds": [manual_project_id],
                "matchedBy": "manual",
                "matchConfidence": "high",
            }
        store.put(owner, f"correspondence#{message_id}", record)
        if record["projectId"]:
            thread_projects[record["threadId"]] = record["projectId"]
            assigned_count += 1
        stored_count += 1
        attachment_count += len(attachments)
        warnings.extend(file_warnings)

    completed_at = _now().isoformat()
    store.put(
        owner,
        "gmail-inbox#state",
        {
            "lastSuccessfulSync": completed_at,
            "messagesReviewed": len(messages),
            "messagesStored": stored_count,
            "assignedMessages": assigned_count,
            "filedAttachments": attachment_count,
            "warnings": warnings[:20],
        },
    )
    return {
        "syncedAt": completed_at,
        "messagesReviewed": len(messages),
        "messagesStored": stored_count,
        "assignedMessages": assigned_count,
        "filedAttachments": attachment_count,
        "warnings": warnings[:20],
    }
