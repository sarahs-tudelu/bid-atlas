from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Any


TUDELU_DOMAIN = "tudelu.com"
SESSION_TTL_SECONDS = 12 * 60 * 60
OAUTH_STATE_TTL_SECONDS = 10 * 60


def is_tudelu_identity(email: str, email_verified: bool) -> bool:
    normalized = email.strip().casefold()
    return email_verified and normalized.endswith(f"@{TUDELU_DOMAIN}") and normalized.count("@") == 1


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def sign_payload(payload: dict[str, Any], secret: str, *, purpose: str) -> str:
    serialized = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = _encode(serialized)
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{purpose}.{encoded}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return f"{encoded}.{_encode(signature)}"


def verify_payload(token: str, secret: str, *, purpose: str) -> dict[str, Any] | None:
    try:
        encoded, provided = token.split(".", 1)
        expected = hmac.new(
            secret.encode("utf-8"),
            f"{purpose}.{encoded}".encode("utf-8"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(_decode(provided), expected):
            return None
        payload = json.loads(_decode(encoded))
        if not isinstance(payload, dict) or int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError, binascii.Error):
        return None


def public_user(account: dict[str, Any]) -> dict[str, Any]:
    return {
        "email": account["email"],
        "name": account.get("name", ""),
        "picture": account.get("picture", ""),
        "gmailConnected": bool(account.get("refreshToken") or account.get("accessToken")),
    }
