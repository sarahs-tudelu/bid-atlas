from __future__ import annotations

import base64
import json
import secrets
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import settings
from .runtime_secrets import runtime_secret
from .state import WorkspaceStore


GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me"


class GoogleApiError(RuntimeError):
    pass


def oauth_credentials() -> tuple[str, str]:
    return (
        runtime_secret(settings.google_client_id, settings.google_client_id_parameter),
        runtime_secret(settings.google_client_secret, settings.google_client_secret_parameter),
    )


def oauth_is_configured() -> bool:
    try:
        oauth_credentials()
        return True
    except Exception:
        return False


def pkce_pair() -> tuple[str, str]:
    import hashlib

    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def authorization_url(state: str, challenge: str) -> str:
    client_id, _ = oauth_credentials()
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": settings.google_redirect_uri,
            "response_type": "code",
            "scope": " ".join(settings.google_scopes),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "hd": "tudelu.com",
        }
    )
    return f"{GOOGLE_AUTHORIZE_URL}?{query}"


def _json_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
) -> dict[str, Any]:
    request = Request(
        url,
        data=data,
        method=method,
        headers={"Accept": "application/json", **(headers or {})},
    )
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise GoogleApiError(f"Google API request failed ({error.code}): {detail}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise GoogleApiError("Google API request could not be completed") from error


def exchange_code(code: str, verifier: str) -> dict[str, Any]:
    client_id, client_secret = oauth_credentials()
    token = _json_request(
        GOOGLE_TOKEN_URL,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urlencode(
            {
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            }
        ).encode("utf-8"),
    )
    if not token.get("access_token"):
        raise GoogleApiError("Google did not return an access token")
    return token


def google_user(access_token: str) -> dict[str, Any]:
    return _json_request(
        GOOGLE_USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
    )


def account_from_oauth(
    identity: dict[str, Any],
    token: dict[str, Any],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = int(time.time())
    return {
        "email": str(identity.get("email") or "").strip().casefold(),
        "name": str(identity.get("name") or "").strip(),
        "picture": str(identity.get("picture") or "").strip(),
        "accessToken": token["access_token"],
        "refreshToken": token.get("refresh_token") or (existing or {}).get("refreshToken", ""),
        "tokenType": token.get("token_type", "Bearer"),
        "expiresAt": now + int(token.get("expires_in", 3600)),
        "scopes": str(token.get("scope") or " ".join(settings.google_scopes)).split(),
        "connectedAt": datetime.now(timezone.utc).isoformat(),
    }


def _refresh_account(account: dict[str, Any]) -> dict[str, Any]:
    refresh_token = str(account.get("refreshToken") or "")
    if not refresh_token:
        raise GoogleApiError("Reconnect Google to renew Gmail access")
    client_id, client_secret = oauth_credentials()
    token = _json_request(
        GOOGLE_TOKEN_URL,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urlencode(
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            }
        ).encode("utf-8"),
    )
    return {
        **account,
        "accessToken": token["access_token"],
        "tokenType": token.get("token_type", "Bearer"),
        "expiresAt": int(time.time()) + int(token.get("expires_in", 3600)),
        "scopes": str(token.get("scope") or " ".join(account.get("scopes", []))).split(),
    }


def usable_account(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
) -> dict[str, Any]:
    if int(account.get("expiresAt", 0)) > int(time.time()) + 60:
        return account
    refreshed = _refresh_account(account)
    return store.put(owner, "google#account", refreshed)


def _gmail_request(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    active = usable_account(owner, account, store)
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {active['accessToken']}"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    return _json_request(f"{GMAIL_API_URL}{path}", method=method, headers=headers, data=data), active


def gmail_request(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Call the authenticated Gmail API while preserving refreshed credentials."""

    return _gmail_request(owner, account, store, path, method=method, payload=payload)


def gmail_history(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    contact_emails: list[str],
) -> list[dict[str, Any]]:
    """Fetch privacy-minimized message metadata for published project contacts."""

    emails = sorted({email.strip().casefold() for email in contact_emails if email.strip()})[:10]
    if not emails:
        return []
    query = "{" + " ".join(f"from:{email} to:{email}" for email in emails) + "}"
    listing, active = _gmail_request(
        owner,
        account,
        store,
        f"/messages?{urlencode({'q': query, 'maxResults': 20})}",
    )
    thread_ids: list[str] = []
    for message in listing.get("messages", []):
        thread_id = str(message.get("threadId") or "")
        if thread_id and thread_id not in thread_ids:
            thread_ids.append(thread_id)

    history: list[dict[str, Any]] = []
    metadata_query = urlencode(
        [
            ("format", "metadata"),
            ("metadataHeaders", "From"),
            ("metadataHeaders", "To"),
            ("metadataHeaders", "Subject"),
            ("metadataHeaders", "Date"),
        ]
    )
    for thread_id in thread_ids[:10]:
        thread, active = _gmail_request(
            owner,
            active,
            store,
            f"/threads/{thread_id}?{metadata_query}",
        )
        messages: list[dict[str, str]] = []
        for message in thread.get("messages", []):
            headers = {
                str(item.get("name") or "").casefold(): str(item.get("value") or "")
                for item in message.get("payload", {}).get("headers", [])
            }
            messages.append(
                {
                    "id": str(message.get("id") or ""),
                    "from": headers.get("from", ""),
                    "to": headers.get("to", ""),
                    "subject": headers.get("subject", ""),
                    "date": headers.get("date", ""),
                    "snippet": str(message.get("snippet") or "")[:240],
                }
            )
        history.append({"threadId": thread_id, "messages": messages})
    return history


def send_gmail_message(
    owner: str,
    account: dict[str, Any],
    store: WorkspaceStore,
    *,
    recipient: str,
    subject: str,
    body: str,
) -> dict[str, str]:
    message = EmailMessage()
    message["To"] = recipient
    message["From"] = owner
    message["Subject"] = subject
    message.set_content(body)
    raw = base64.urlsafe_b64encode(message.as_bytes()).rstrip(b"=").decode("ascii")
    result, _ = _gmail_request(
        owner,
        account,
        store,
        "/messages/send",
        method="POST",
        payload={"raw": raw},
    )
    message_id = str(result.get("id") or "")
    if not message_id:
        raise GoogleApiError("Gmail accepted the request without returning a message identifier")
    return {"messageId": message_id, "threadId": str(result.get("threadId") or "")}
