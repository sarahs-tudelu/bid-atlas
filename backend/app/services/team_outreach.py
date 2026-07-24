from __future__ import annotations

import hashlib
from email.utils import getaddresses
from typing import Any, Iterable

from .auth import is_tudelu_identity
from .qualification import published_contacts
from .state import WorkspaceStore


TEAM_OUTREACH_OWNER = "system#team-outreach"
MAX_TEAM_HISTORY_THREADS = 50
MAX_TEAM_OUTREACH_LOG_RECORDS = 500
TEAM_SENT_LOG_FIELDS = (
    "projectId",
    "projectTitle",
    "sourceRecordId",
    "status",
    "to",
    "subject",
    "senderMode",
    "senderEmail",
    "deliveryProvider",
    "sentAt",
    "updatedAt",
)


def _addresses(*values: object) -> set[str]:
    return {
        address.strip().casefold()
        for _, address in getaddresses([str(value or "") for value in values])
        if address.strip() and "@" in address
    }


def _project_ids(project: dict[str, Any]) -> set[str]:
    identifiers = {
        str(project.get("id") or "").strip(),
        *(
            str(value).strip()
            for value in project.get("duplicateProjectIds") or []
            if value
        ),
    }
    identifiers.update(
        str(record.get("id") or "").strip()
        for record in project.get("sourceRecords") or []
        if isinstance(record, dict)
    )
    return {value for value in identifiers if value}


def _matches_project_or_contact(
    record: dict[str, Any],
    project_ids: set[str],
    contact_emails: set[str],
) -> bool:
    if str(record.get("projectId") or "").strip() in project_ids:
        return True
    involved = _addresses(
        record.get("to"),
        record.get("from"),
        record.get("cc"),
        record.get("recipient"),
    )
    return bool(contact_emails & involved)


def _message(
    record: dict[str, Any],
    owner: str,
    *,
    message_id: str,
) -> dict[str, str]:
    sender = str(record.get("senderEmail") or record.get("from") or owner)
    return {
        "id": message_id,
        "from": sender,
        "to": str(record.get("to") or record.get("recipient") or ""),
        "subject": str(record.get("subject") or ""),
        "date": str(
            record.get("sentAt")
            or record.get("occurredAt")
            or record.get("updatedAt")
            or ""
        ),
        "snippet": str(record.get("body") or record.get("snippet") or "")[:240],
        "sentBy": str(record.get("sentBy") or owner),
    }


def team_contact_summary(
    store: WorkspaceStore,
    project: dict[str, Any],
) -> dict[str, Any]:
    """Summarize sent contact across every verified Tudelu workspace."""

    project_ids = _project_ids(project)
    contact_emails = {
        str(contact.get("email") or "").strip().casefold()
        for contact in published_contacts(project)
        if contact.get("email")
    }
    messages: list[dict[str, str]] = []
    seen: set[str] = set()

    for owner, record in store.list_all_prefix("outreach#"):
        if not is_tudelu_identity(owner, True) or record.get("status") != "sent":
            continue
        if not _matches_project_or_contact(record, project_ids, contact_emails):
            continue
        message_id = str(record.get("gmailMessageId") or "").strip()
        if not message_id:
            identity = "|".join(
                (
                    owner,
                    str(record.get("projectId") or ""),
                    str(record.get("to") or ""),
                    str(record.get("sentAt") or record.get("updatedAt") or ""),
                )
            )
            message_id = f"outreach-{hashlib.sha256(identity.encode()).hexdigest()[:24]}"
        if message_id in seen:
            continue
        seen.add(message_id)
        messages.append(_message(record, owner, message_id=message_id))

    for owner, record in store.list_all_prefix("correspondence#"):
        if not is_tudelu_identity(owner, True) or record.get("direction") != "sent":
            continue
        if not _matches_project_or_contact(record, project_ids, contact_emails):
            continue
        message_id = str(record.get("messageId") or "").strip()
        if not message_id or message_id in seen:
            continue
        seen.add(message_id)
        messages.append(_message(record, owner, message_id=message_id))

    messages.sort(key=lambda item: item["date"], reverse=True)
    contacted_by = sorted(
        {
            message["sentBy"].strip().casefold()
            for message in messages
            if is_tudelu_identity(message["sentBy"], True)
        }
    )
    return {
        "history": [
            {
                "threadId": f"team:{message['id']}",
                "messages": [message],
            }
            for message in messages[:MAX_TEAM_HISTORY_THREADS]
        ],
        "priorContactCount": len(messages),
        "priorContactedBy": contacted_by,
        "lastPriorContactAt": messages[0]["date"] if messages else "",
    }


def merge_contact_history(
    *histories: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge provider and stored team history without repeating messages."""

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for history in histories:
        for thread in history:
            messages = []
            for message in thread.get("messages") or []:
                message_id = str(message.get("id") or "").strip()
                identity = message_id or "|".join(
                    str(message.get(field) or "")
                    for field in ("from", "to", "subject", "date")
                )
                if identity in seen:
                    continue
                seen.add(identity)
                messages.append(message)
            if messages:
                merged.append({**thread, "messages": messages})
    return merged[:MAX_TEAM_HISTORY_THREADS]


def team_outreach_log(
    store: WorkspaceStore,
    current_owner: str,
) -> list[dict[str, Any]]:
    """Return the current user's drafts plus sent outreach from the whole team."""

    records: list[dict[str, Any]] = []
    for owner, record in store.list_all_prefix("outreach#"):
        if not is_tudelu_identity(owner, True):
            continue
        if owner != current_owner and record.get("status") != "sent":
            continue
        visible_record = (
            record
            if owner == current_owner
            else {
                field: record[field]
                for field in TEAM_SENT_LOG_FIELDS
                if field in record
            }
        )
        records.append(
            {
                **visible_record,
                "sentBy": str(record.get("sentBy") or owner),
                "workspaceOwner": owner,
            }
        )
    records.sort(
        key=lambda item: str(item.get("sentAt") or item.get("updatedAt") or ""),
        reverse=True,
    )
    return records[:MAX_TEAM_OUTREACH_LOG_RECORDS]


def team_send_lock_key(recipient: str) -> str:
    digest = hashlib.sha256(recipient.strip().casefold().encode()).hexdigest()
    return f"send-lock#{digest}"
