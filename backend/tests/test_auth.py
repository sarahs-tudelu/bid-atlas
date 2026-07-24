from __future__ import annotations

import time

from backend.app.services.auth import is_tudelu_identity, sign_payload, verify_payload
from backend.app.services.google import account_from_oauth, pkce_pair


def test_tudelu_identity_requires_verified_exact_domain() -> None:
    assert is_tudelu_identity("Person@TUDELU.COM", True)
    assert not is_tudelu_identity("@tudelu.com", True)
    assert not is_tudelu_identity("person@@tudelu.com", True)
    assert not is_tudelu_identity("person@tudelu.com.example", True)
    assert not is_tudelu_identity("person@example.com", True)
    assert not is_tudelu_identity("person@tudelu.com", False)


def test_signed_session_rejects_tampering_and_expiration() -> None:
    token = sign_payload({"email": "person@tudelu.com", "exp": int(time.time()) + 60}, "secret", purpose="session")
    assert verify_payload(token, "secret", purpose="session")["email"] == "person@tudelu.com"
    assert verify_payload(f"{token}x", "secret", purpose="session") is None
    expired = sign_payload({"exp": int(time.time()) - 1}, "secret", purpose="session")
    assert verify_payload(expired, "secret", purpose="session") is None
    assert verify_payload("malformed", "secret", purpose="session") is None


def test_pkce_and_oauth_account_preserve_refresh_token() -> None:
    verifier, challenge = pkce_pair()
    assert len(verifier) >= 43
    assert challenge
    account = account_from_oauth(
        {"email": "person@tudelu.com", "name": "Person"},
        {"access_token": "new-access", "expires_in": 3600},
        {"refreshToken": "existing-refresh"},
    )
    assert account["refreshToken"] == "existing-refresh"
    assert account["accessToken"] == "new-access"
