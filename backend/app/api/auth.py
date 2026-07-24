from __future__ import annotations

import secrets
import time
from typing import Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Response
from fastapi.responses import RedirectResponse

from ..config import settings
from ..dependencies import get_workspace_store
from ..services.auth import (
    OAUTH_STATE_TTL_SECONDS,
    SESSION_TTL_SECONDS,
    is_tudelu_identity,
    public_user,
    sign_payload,
    verify_payload,
)
from ..services.google import (
    GoogleApiError,
    account_from_oauth,
    authorization_url,
    exchange_code,
    google_user,
    oauth_credentials,
    oauth_is_configured,
    pkce_pair,
)
from ..services.runtime_secrets import runtime_secret
from ..services.state import WorkspaceStore


router = APIRouter(prefix="/api/auth", tags=["authentication"])
SESSION_COOKIE = "bidatlas_session"
STATE_COOKIE = "bidatlas_oauth_state"


def _session_secret() -> str:
    return runtime_secret(settings.session_secret, settings.session_secret_parameter)


def _secure_cookie() -> bool:
    return settings.environment.casefold() == "production"


def require_user(
    bidatlas_session: str | None = Cookie(default=None),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> dict[str, Any]:
    if not bidatlas_session:
        raise HTTPException(status_code=401, detail="Sign in with a Tudelu Google account")
    try:
        payload = verify_payload(bidatlas_session, _session_secret(), purpose="session")
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="Google authentication is not configured") from error
    email = str((payload or {}).get("email") or "").casefold()
    if not email:
        raise HTTPException(status_code=401, detail="Your session has expired")
    account = store.get(email, "google#account")
    account_email = str((account or {}).get("email") or "").strip().casefold()
    if (
        not account
        or account_email != email
        or not is_tudelu_identity(account_email, True)
    ):
        raise HTTPException(status_code=401, detail="Reconnect your Tudelu Google account")
    return public_user(account)


@router.get("/google/status")
def google_status() -> dict[str, Any]:
    return {
        "configured": oauth_is_configured(),
        "domain": "tudelu.com",
        "scopes": list(settings.google_scopes),
    }


@router.get("/google/start")
def google_start(
    next_path: str = Query(default="/outreach", alias="next", max_length=200),
) -> Response:
    try:
        oauth_credentials()
        secret = _session_secret()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="Google authentication is not configured") from error

    state = secrets.token_urlsafe(32)
    verifier, challenge = pkce_pair()
    safe_next = next_path if next_path in {"/", "/outreach", "/inbox"} else "/outreach"
    token = sign_payload(
        {
            "state": state,
            "verifier": verifier,
            "next": safe_next,
            "exp": int(time.time()) + OAUTH_STATE_TTL_SECONDS,
        },
        secret,
        purpose="oauth-state",
    )
    response = RedirectResponse(authorization_url(state, challenge), status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        token,
        max_age=OAUTH_STATE_TTL_SECONDS,
        httponly=True,
        secure=_secure_cookie(),
        samesite="lax",
        path="/api/auth/google/callback",
    )
    return response


@router.get("/google/callback")
def google_callback(
    code: str = Query(min_length=1),
    state: str = Query(min_length=1),
    bidatlas_oauth_state: str | None = Cookie(default=None),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> Response:
    if not bidatlas_oauth_state:
        raise HTTPException(status_code=400, detail="OAuth state cookie is missing")
    payload = verify_payload(bidatlas_oauth_state, _session_secret(), purpose="oauth-state")
    if not payload or not secrets.compare_digest(str(payload.get("state") or ""), state):
        raise HTTPException(status_code=400, detail="OAuth state validation failed")
    try:
        token = exchange_code(code, str(payload["verifier"]))
        identity = google_user(str(token["access_token"]))
    except GoogleApiError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    email = str(identity.get("email") or "").strip().casefold()
    if not is_tudelu_identity(email, bool(identity.get("email_verified"))):
        raise HTTPException(status_code=403, detail="A verified @tudelu.com Google account is required")
    account = account_from_oauth(identity, token, store.get(email, "google#account"))
    if not account.get("refreshToken"):
        raise HTTPException(status_code=502, detail="Google did not grant offline Gmail access; reconnect and approve access")
    store.put(email, "google#account", account)

    session = sign_payload(
        {"email": email, "exp": int(time.time()) + SESSION_TTL_SECONDS},
        _session_secret(),
        purpose="session",
    )
    next_path = str(payload.get("next") or "/outreach")
    if next_path not in {"/", "/outreach", "/inbox"}:
        next_path = "/outreach"
    redirect = RedirectResponse(f"{settings.public_url}{next_path}", status_code=302)
    redirect.set_cookie(
        SESSION_COOKIE,
        session,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=_secure_cookie(),
        samesite="lax",
        path="/",
    )
    redirect.delete_cookie(STATE_COOKIE, path="/api/auth/google/callback")
    return redirect


@router.get("/me")
def me(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return {"user": user}


@router.post("/logout", status_code=204)
def logout() -> Response:
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(STATE_COOKIE, path="/api/auth/google/callback")
    return response
