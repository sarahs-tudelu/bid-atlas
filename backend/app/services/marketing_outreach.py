from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import settings
from .runtime_secrets import runtime_secret
from .state import WorkspaceStore


INSTANTLY_API_BASE = "https://api.instantly.ai/api/v2"
INSTANTLY_USER_AGENT = "BidAtlas/1.0"
MARKETING_OWNER = "system#marketing-outreach"
MARKETING_PERSONA = {"name": "Alex", "email": "outreach@tudelugroup.com"}
MARKETING_COOLDOWN_DAYS = 14
MAX_PROVIDER_BYTES = 2_000_000
MAX_REPLY_PAGES = 5
MAX_ACCOUNT_PAGES = 5
ACCOUNT_STATUS_LABELS = {
    1: "active",
    2: "paused",
    3: "maintenance",
    -1: "connection-error",
    -2: "soft-bounce-error",
    -3: "sending-error",
}

# These owners come from the cold-outreach handoff policy. The sender persona is
# deliberately separate from the employee who owns the sales response.
SALES_REPLY_OWNERS = (
    {"name": "Jadalyn Gaines", "email": "jadalyn.gaines@tudelu.com"},
    {"name": "Patrick May", "email": "patrick.may@tudelu.com"},
    {"name": "Jessica Rigolosi", "email": "jessica@tudelu.com"},
    {"name": "Abe Straus", "email": "abe@tudelu.com"},
    {"name": "Shlomo Horowitz", "email": "shlomo.h@tudelu.com"},
)
SALES_REPLY_EMAILS = {owner["email"] for owner in SALES_REPLY_OWNERS}


class InstantlyApiError(RuntimeError):
    """Raised when marketing email delivery or reply synchronization fails."""


def marketing_sender() -> str:
    return settings.marketing_sender or MARKETING_PERSONA["email"]


def _normalized_sender(sender_email: str = "") -> str:
    return sender_email.strip().lower() or marketing_sender()


def instantly_api_token() -> str:
    return runtime_secret(
        settings.instantly_api_token,
        settings.instantly_api_token_parameter,
    )


def instantly_is_configured() -> bool:
    try:
        return bool(instantly_api_token())
    except Exception:
        return False


def sales_reply_owner(email: str) -> dict[str, str] | None:
    normalized = email.strip().lower()
    return next(
        (owner for owner in SALES_REPLY_OWNERS if owner["email"] == normalized),
        None,
    )


def default_sales_reply_owner(user_email: str) -> dict[str, str]:
    return sales_reply_owner(user_email) or SALES_REPLY_OWNERS[2]


def marketing_persona() -> dict[str, str]:
    return {**MARKETING_PERSONA, "email": marketing_sender()}


def _provider_request(
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = (
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if payload is not None
        else None
    )
    request = Request(
        f"{INSTANTLY_API_BASE}{path}",
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {instantly_api_token()}",
            "User-Agent": INSTANTLY_USER_AGENT,
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read(MAX_PROVIDER_BYTES + 1)
            if len(raw) > MAX_PROVIDER_BYTES:
                raise InstantlyApiError("Instantly response exceeded the size limit")
            return json.loads(raw.decode("utf-8")) if raw else {}
    except HTTPError as error:
        detail = error.read(500).decode("utf-8", errors="replace")
        raise InstantlyApiError(
            f"Instantly request failed ({error.code}): {detail}"
        ) from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise InstantlyApiError("Instantly request could not be completed") from error


def list_marketing_accounts() -> list[dict[str, Any]]:
    """Return every sender account visible to the configured Instantly token."""

    accounts: list[dict[str, Any]] = []
    starting_after = ""
    for _ in range(MAX_ACCOUNT_PAGES):
        query = {"limit": "100"}
        if starting_after:
            query["starting_after"] = starting_after
        response = _provider_request(f"/accounts?{urlencode(query)}")
        items = response.get("items")
        if not isinstance(items, list):
            raise InstantlyApiError("Instantly account response did not contain an item list")
        for item in items:
            if not isinstance(item, dict):
                continue
            email = str(item.get("email") or "").strip().lower()
            if not email:
                continue
            first_name = str(item.get("first_name") or "").strip()
            last_name = str(item.get("last_name") or "").strip()
            name = " ".join(part for part in (first_name, last_name) if part)
            status_code = int(item.get("status") or 0)
            accounts.append(
                {
                    "email": email,
                    "name": name or email,
                    "status": ACCOUNT_STATUS_LABELS.get(status_code, "unknown"),
                    "statusCode": status_code,
                    "warmupStatus": int(item.get("warmup_status") or 0),
                    "providerCode": int(item.get("provider_code") or 0),
                    "setupPending": bool(item.get("setup_pending")),
                }
            )
        starting_after = str(response.get("next_starting_after") or "")
        if not starting_after:
            break
    else:
        raise InstantlyApiError("Instantly account list exceeded the page limit")

    default_sender = marketing_sender()
    deduplicated = {account["email"]: account for account in accounts}
    return sorted(
        deduplicated.values(),
        key=lambda account: (
            account["email"] != default_sender,
            account["statusCode"] != 1,
            account["name"].casefold(),
            account["email"],
        ),
    )


def available_marketing_accounts() -> tuple[list[dict[str, Any]], str]:
    """Return provider accounts with a safe default fallback during provider outages."""

    try:
        accounts = list_marketing_accounts()
        if accounts:
            return accounts, ""
        warning = "Instantly returned no sender accounts; using the configured default"
    except (InstantlyApiError, RuntimeError) as error:
        warning = str(error)
    return (
        [
            {
                "email": marketing_sender(),
                "name": "Alex Turner",
                "status": "configured",
                "statusCode": 0,
                "warmupStatus": 0,
                "providerCode": 0,
                "setupPending": False,
            }
        ],
        warning,
    )


def marketing_account(sender_email: str = "") -> dict[str, Any]:
    """Resolve a client-selected sender against provider-authorized accounts."""

    normalized = _normalized_sender(sender_email)
    if normalized == marketing_sender():
        return {
            "email": marketing_sender(),
            "name": "Alex Turner",
            "status": "configured",
            "statusCode": 0,
            "warmupStatus": 0,
            "providerCode": 0,
            "setupPending": False,
        }
    try:
        account = next(
            (
                candidate
                for candidate in list_marketing_accounts()
                if candidate["email"] == normalized
            ),
            None,
        )
    except (InstantlyApiError, RuntimeError):
        raise
    if account is None:
        raise InstantlyApiError("Selected marketing sender is not available to BidAtlas")
    return account


def marketing_persona_for(sender_email: str = "") -> dict[str, str]:
    account = marketing_account(sender_email)
    if account["email"] == marketing_sender():
        return {**MARKETING_PERSONA, "email": account["email"]}
    return {"name": str(account["name"]), "email": str(account["email"])}


def _plain_text_html(value: str) -> str:
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;'
        'line-height:1.55;color:#111">'
        f"{html.escape(value).replace(chr(10), '<br>')}</div>"
    )


def send_marketing_email(
    *,
    recipient: str,
    subject: str,
    body: str,
    sender_email: str = "",
) -> dict[str, str]:
    sender = marketing_account(sender_email)["email"]
    response = _provider_request(
        "/emails/test",
        method="POST",
        payload={
            "eaccount": sender,
            "to_address_email_list": recipient,
            "subject": subject,
            "body": {"html": _plain_text_html(body), "text": body},
        },
    )
    if response.get("status") != "success" and response.get("success") is not True:
        raise InstantlyApiError("Instantly did not confirm marketing email delivery")
    return {"provider": "instantly:test-email", "sender": sender}


def list_received_marketing_emails(
    *,
    since: datetime,
    sender_email: str = "",
) -> tuple[list[dict[str, Any]], bool]:
    sender = _normalized_sender(sender_email)
    items: list[dict[str, Any]] = []
    starting_after = ""
    complete = True
    for _ in range(MAX_REPLY_PAGES):
        query = {
            "limit": "100",
            "email_type": "received",
            "mode": "emode_all",
            "preview_only": "false",
            "eaccount": sender,
            "min_timestamp_created": since.astimezone(timezone.utc).isoformat(),
        }
        if starting_after:
            query["starting_after"] = starting_after
        response = _provider_request(f"/emails?{urlencode(query)}")
        page_items = response.get("items")
        if not isinstance(page_items, list):
            raise InstantlyApiError("Instantly reply response did not contain an item list")
        items.extend(item for item in page_items if isinstance(item, dict))
        starting_after = str(response.get("next_starting_after") or "")
        if not starting_after:
            break
    else:
        complete = False
    return items, complete


def forward_marketing_reply(
    item: dict[str, Any],
    *,
    sales_email: str,
    sender_email: str = "",
) -> dict[str, str]:
    sender_account = _normalized_sender(sender_email)
    reply_id = str(item.get("id") or "").strip()
    if not reply_id:
        raise InstantlyApiError("Instantly reply is missing its email id")
    sender = str(item.get("from_address_email") or item.get("lead") or "").strip().lower()
    subject = str(item.get("subject") or "Marketing reply").strip()[:300]
    response = _provider_request(
        "/emails/forward",
        method="POST",
        payload={
            "eaccount": sender_account,
            "reply_to_uuid": reply_id,
            "to_address_email_list": sales_email,
            "reply_to": sender,
            "subject": f"Fwd: {subject}"[:300],
            "include_original_body": True,
            "body": {
                "text": (
                    "A response to a BidAtlas marketing outreach message is forwarded below. "
                    "Reply to this forwarded message to answer the original sender."
                ),
            },
        },
    )
    message_id = str(response.get("id") or response.get("message_id") or "").strip()
    if not message_id:
        raise InstantlyApiError("Instantly did not confirm reply forwarding")
    return {"provider": "instantly:forward", "messageId": message_id}


def _hashed_key(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()
    return f"{prefix}#{digest}"


def marketing_route_key(recipient: str) -> str:
    return _hashed_key("route", recipient)


def marketing_reply_key(provider_id: str) -> str:
    return _hashed_key("reply", provider_id)


def marketing_lock_key(recipient: str) -> str:
    return _hashed_key("send-lock", recipient)


def active_marketing_cooldown(
    store: WorkspaceStore,
    recipient: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    route = store.get(MARKETING_OWNER, marketing_route_key(recipient))
    if not route or not route.get("sentAt"):
        return None
    try:
        sent_at = datetime.fromisoformat(str(route["sentAt"]).replace("Z", "+00:00"))
    except ValueError:
        return None
    current = now or datetime.now(timezone.utc)
    return route if current - sent_at < timedelta(days=MARKETING_COOLDOWN_DAYS) else None


def record_marketing_route(
    store: WorkspaceStore,
    *,
    recipient: str,
    subject: str,
    project_id: str,
    project_title: str,
    sent_by: str,
    reply_owner_email: str,
    sent_at: str,
    sender_email: str = "",
) -> dict[str, Any]:
    sender = _normalized_sender(sender_email)
    return store.put(
        MARKETING_OWNER,
        marketing_route_key(recipient),
        {
            "recipient": recipient,
            "subject": subject,
            "projectId": project_id,
            "projectTitle": project_title,
            "sentBy": sent_by,
            "senderEmail": sender,
            "replyOwnerEmail": reply_owner_email,
            "sentAt": sent_at,
        },
    )


def reply_matches_route(item: dict[str, Any], route: dict[str, Any]) -> bool:
    sender = str(item.get("from_address_email") or item.get("lead") or "").strip().lower()
    if sender != str(route.get("recipient") or "").strip().lower():
        return False
    try:
        occurred_at = datetime.fromisoformat(
            str(item.get("timestamp_created") or item.get("timestamp_email") or "").replace("Z", "+00:00")
        )
        sent_at = datetime.fromisoformat(str(route.get("sentAt") or "").replace("Z", "+00:00"))
    except ValueError:
        return False
    return occurred_at >= sent_at


def auto_reply_reason(item: dict[str, Any]) -> str | None:
    if item.get("is_auto_reply") in {True, 1, "1"}:
        return "Instantly marked the response as automatic"
    precedence = str(item.get("precedence") or "").strip().lower()
    if precedence in {"auto_reply", "auto-reply", "bulk", "junk", "list"}:
        return "Response used an automatic or bulk precedence"
    auto_submitted = str(item.get("auto_submitted") or "").strip().lower()
    if auto_submitted not in {"", "no", "none", "false", "0"}:
        return "Response declared itself automatically submitted"
    searchable = " ".join(
        str(value or "")
        for value in (
            item.get("subject"),
            item.get("content_preview"),
            item.get("auto_submitted"),
            item.get("precedence"),
        )
    )
    if re.search(
        r"\b(?:automatic reply|auto[- ]?reply|out of (?:the )?office|ooo|"
        r"vacation (?:reply|response|message|responder)|away from the office|"
        r"delivery status notification|undeliver(?:ed|able)|mail delivery "
        r"(?:failed|failure|subsystem)|failure notice|returned mail)\b",
        searchable,
        re.IGNORECASE,
    ):
        return "Response matched an automatic-reply signal"
    return None


def marketing_reply_history(store: WorkspaceStore, recipient: str) -> list[dict[str, Any]]:
    normalized = recipient.strip().lower()
    records = [
        record
        for record in store.list_prefix(MARKETING_OWNER, "reply#")
        if str(record.get("recipient") or "").strip().lower() == normalized
    ]
    records.sort(key=lambda record: str(record.get("occurredAt") or ""), reverse=True)
    return [
        {
            "threadId": str(record.get("providerId") or record.get("updatedAt") or "reply"),
            "messages": [
                {
                    "id": str(record.get("providerId") or "reply"),
                    "from": normalized,
                    "to": str(record.get("senderEmail") or marketing_sender()),
                    "subject": str(record.get("subject") or ""),
                    "date": str(record.get("occurredAt") or ""),
                    "snippet": str(record.get("snippet") or record.get("status") or "")[:240],
                }
            ],
        }
        for record in records[:20]
    ]
