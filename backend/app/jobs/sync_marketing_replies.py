from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import settings
from ..services.marketing_outreach import (
    MARKETING_OWNER,
    auto_reply_reason,
    forward_marketing_reply,
    list_received_marketing_emails,
    marketing_reply_key,
    reply_matches_route,
)
from ..services.state import WorkspaceStore


def _reply_snippet(item: dict[str, Any]) -> str:
    body = item.get("body") if isinstance(item.get("body"), dict) else {}
    return str(
        body.get("text")
        or item.get("content_preview")
        or item.get("preview")
        or ""
    ).strip()[:240]


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del event, context
    if not settings.workspace_table:
        raise RuntimeError("BIDATLAS_WORKSPACE_TABLE is required")

    store = WorkspaceStore(settings.workspace_table)
    routes = {
        str(route.get("recipient") or "").strip().lower(): route
        for route in store.list_prefix(MARKETING_OWNER, "route#")
        if route.get("recipient")
    }
    if not routes:
        return {
            "status": "ok",
            "checked": 0,
            "forwarded": 0,
            "suppressed": 0,
            "unmatched": 0,
            "message": "No BidAtlas marketing routes have been sent yet",
        }

    items, complete = list_received_marketing_emails(
        since=datetime.now(timezone.utc) - timedelta(days=30)
    )
    checked = forwarded = suppressed = unmatched = failed = 0
    for item in items:
        provider_id = str(item.get("id") or "").strip()
        if not provider_id:
            continue
        checked += 1
        record_key = marketing_reply_key(provider_id)
        existing = store.get(MARKETING_OWNER, record_key)
        if existing and existing.get("status") != "forward-failed":
            continue

        recipient = str(
            item.get("from_address_email") or item.get("lead") or ""
        ).strip().lower()
        route = routes.get(recipient)
        if not route or not reply_matches_route(item, route):
            unmatched += 1
            continue

        occurred_at = str(
            item.get("timestamp_email")
            or item.get("timestamp_created")
            or datetime.now(timezone.utc).isoformat()
        )
        base_record = {
            "providerId": provider_id,
            "recipient": recipient,
            "subject": str(item.get("subject") or "")[:300],
            "occurredAt": occurred_at,
            "snippet": _reply_snippet(item),
            "projectId": route.get("projectId"),
            "projectTitle": route.get("projectTitle"),
            "replyOwnerEmail": route.get("replyOwnerEmail"),
        }
        reason = auto_reply_reason(item)
        if reason:
            store.put(
                MARKETING_OWNER,
                record_key,
                {**base_record, "status": "auto-reply-suppressed", "reason": reason},
            )
            suppressed += 1
            continue

        try:
            result = forward_marketing_reply(
                item,
                sales_email=str(route["replyOwnerEmail"]),
            )
            store.put(
                MARKETING_OWNER,
                record_key,
                {
                    **base_record,
                    "status": "forwarded",
                    "forwardedAt": datetime.now(timezone.utc).isoformat(),
                    "forwardProvider": result["provider"],
                    "forwardMessageId": result["messageId"],
                },
            )
            forwarded += 1
        except Exception as error:
            store.put(
                MARKETING_OWNER,
                record_key,
                {**base_record, "status": "forward-failed", "error": str(error)[:500]},
            )
            failed += 1

    return {
        "status": "ok" if failed == 0 else "degraded",
        "checked": checked,
        "forwarded": forwarded,
        "suppressed": suppressed,
        "unmatched": unmatched,
        "failed": failed,
        "complete": complete,
    }
