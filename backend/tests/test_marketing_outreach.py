from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace

from backend.app.jobs import sync_marketing_replies as reply_job
from backend.app.services import marketing_outreach
from backend.app.services.marketing_outreach import (
    MARKETING_OWNER,
    active_marketing_cooldown,
    marketing_reply_key,
    record_marketing_route,
)
from backend.app.services.outreach import generate_outreach_draft
from backend.app.services.state import WorkspaceStore


def _project() -> dict:
    return {
        "id": "project-1",
        "sourceRecordId": "SOL-1",
        "title": "Architectural metal entrance canopy",
        "state": "NJ",
        "participants": [
            {
                "name": "Pat Buyer",
                "role": "procurement",
                "email": "pat@example.gov",
            }
        ],
    }


def _reply(*, auto: bool = False) -> dict:
    return {
        "id": "reply-1",
        "from_address_email": "pat@example.gov",
        "subject": "Re: Canopy support for SOL-1",
        "timestamp_created": "2026-07-22T16:00:00Z",
        "timestamp_email": "2026-07-22T16:00:00Z",
        "is_auto_reply": 1 if auto else 0,
        "body": {"text": "Please coordinate with our project manager."},
    }


def _route(store: WorkspaceStore) -> None:
    record_marketing_route(
        store,
        recipient="pat@example.gov",
        subject="Canopy support for SOL-1",
        project_id="project-1",
        project_title="Architectural metal entrance canopy",
        sent_by="outreach@tudelu.com",
        reply_owner_email="jessica@tudelu.com",
        sent_at="2026-07-22T15:00:00Z",
    )


def test_marketing_draft_uses_alex_identity_and_sales_reply_owner() -> None:
    draft = generate_outreach_draft(
        _project(),
        {"email": "employee@tudelu.com", "name": "Employee"},
        [],
    )

    assert draft["senderMode"] == "marketing"
    assert draft["senderEmail"] == "outreach@tudelugroup.com"
    assert draft["replyOwnerEmail"] == "jessica@tudelu.com"
    assert "\nAlex\n" in draft["body"]


def test_marketing_send_uses_designated_instantly_account(monkeypatch) -> None:
    requests: list[tuple[str, str, dict]] = []

    def provider_request(path, *, method="GET", payload=None):
        requests.append((path, method, payload))
        return {"status": "success"}

    monkeypatch.setattr(marketing_outreach, "_provider_request", provider_request)
    result = marketing_outreach.send_marketing_email(
        recipient="pat@example.gov",
        subject="Canopy support",
        body="Hello",
    )

    assert result["sender"] == "outreach@tudelugroup.com"
    assert requests[0][0] == "/emails/test"
    assert requests[0][2]["eaccount"] == "outreach@tudelugroup.com"
    assert requests[0][2]["to_address_email_list"] == "pat@example.gov"


def test_marketing_send_accepts_another_provider_authorized_account(monkeypatch) -> None:
    requests: list[tuple[str, str, dict | None]] = []

    def provider_request(path, *, method="GET", payload=None):
        requests.append((path, method, payload))
        if path.startswith("/accounts?"):
            return {
                "items": [
                    {
                        "email": "sarah@gettudelu.com",
                        "first_name": "Sarah",
                        "last_name": "",
                        "status": 1,
                        "warmup_status": 1,
                        "provider_code": 1,
                        "setup_pending": False,
                    }
                ]
            }
        return {"status": "success"}

    monkeypatch.setattr(marketing_outreach, "_provider_request", provider_request)

    result = marketing_outreach.send_marketing_email(
        recipient="pat@example.gov",
        subject="Canopy support",
        body="Hello",
        sender_email="sarah@gettudelu.com",
    )

    assert result["sender"] == "sarah@gettudelu.com"
    assert requests[-1][0] == "/emails/test"
    assert requests[-1][2]["eaccount"] == "sarah@gettudelu.com"


def test_marketing_account_list_exposes_status_without_provider_secrets(monkeypatch) -> None:
    monkeypatch.setattr(
        marketing_outreach,
        "_provider_request",
        lambda *args, **kwargs: {
            "items": [
                {
                    "email": "outreach@tudelupro.com",
                    "first_name": "Jordan",
                    "last_name": "Blake",
                    "status": 2,
                    "warmup_status": 0,
                    "provider_code": 3,
                    "setup_pending": False,
                }
            ]
        },
    )

    accounts = marketing_outreach.list_marketing_accounts()

    assert accounts == [
        {
            "email": "outreach@tudelupro.com",
            "name": "Jordan Blake",
            "status": "paused",
            "statusCode": 2,
            "warmupStatus": 0,
            "providerCode": 3,
            "setupPending": False,
        }
    ]


def test_instantly_request_identifies_bidatlas_to_provider(monkeypatch) -> None:
    captured = {}

    def fake_urlopen(request, *, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return BytesIO(b'{"items":[]}')

    monkeypatch.setattr(marketing_outreach, "instantly_api_token", lambda: "token")
    monkeypatch.setattr(marketing_outreach, "urlopen", fake_urlopen)

    response = marketing_outreach._provider_request("/emails?limit=1")

    assert response == {"items": []}
    assert captured["timeout"] == 20
    assert captured["request"].get_header("User-agent") == "BidAtlas/1.0"
    assert captured["request"].get_header("Authorization") == "Bearer token"


def test_marketing_route_enforces_reference_cooldown() -> None:
    store = WorkspaceStore(None)
    _route(store)

    assert active_marketing_cooldown(
        store,
        "pat@example.gov",
        now=datetime(2026, 7, 23, tzinfo=timezone.utc),
    )
    assert not active_marketing_cooldown(
        store,
        "pat@example.gov",
        now=datetime(2026, 8, 6, tzinfo=timezone.utc),
    )


def test_reply_sync_forwards_human_response_to_assigned_sales_owner(monkeypatch) -> None:
    store = WorkspaceStore(None)
    _route(store)
    forwarded: list[str] = []
    monkeypatch.setattr(reply_job, "settings", SimpleNamespace(workspace_table="workspace"))
    monkeypatch.setattr(reply_job, "WorkspaceStore", lambda table_name: store)
    monkeypatch.setattr(
        reply_job,
        "list_received_marketing_emails",
        lambda **kwargs: ([_reply()], True),
    )

    def forward(item, *, sales_email, sender_email=""):
        forwarded.append(sales_email)
        return {"provider": "instantly:forward", "messageId": "forward-1"}

    monkeypatch.setattr(reply_job, "forward_marketing_reply", forward)
    result = reply_job.handler({}, None)
    stored = store.get(MARKETING_OWNER, marketing_reply_key("reply-1"))

    assert result["forwarded"] == 1
    assert forwarded == ["jessica@tudelu.com"]
    assert stored["status"] == "forwarded"
    assert stored["replyOwnerEmail"] == "jessica@tudelu.com"


def test_reply_sync_suppresses_provider_marked_auto_reply(monkeypatch) -> None:
    store = WorkspaceStore(None)
    _route(store)
    monkeypatch.setattr(reply_job, "settings", SimpleNamespace(workspace_table="workspace"))
    monkeypatch.setattr(reply_job, "WorkspaceStore", lambda table_name: store)
    monkeypatch.setattr(
        reply_job,
        "list_received_marketing_emails",
        lambda **kwargs: ([_reply(auto=True)], True),
    )
    monkeypatch.setattr(
        reply_job,
        "forward_marketing_reply",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not forward")),
    )

    result = reply_job.handler({}, None)
    stored = store.get(MARKETING_OWNER, marketing_reply_key("reply-1"))

    assert result["suppressed"] == 1
    assert stored["status"] == "auto-reply-suppressed"


def test_reply_sync_suppresses_delivery_failure_subject(monkeypatch) -> None:
    store = WorkspaceStore(None)
    _route(store)
    bounce = {**_reply(), "subject": "Mail delivery failed: returning message"}
    monkeypatch.setattr(reply_job, "settings", SimpleNamespace(workspace_table="workspace"))
    monkeypatch.setattr(reply_job, "WorkspaceStore", lambda table_name: store)
    monkeypatch.setattr(
        reply_job,
        "list_received_marketing_emails",
        lambda **kwargs: ([bounce], True),
    )
    monkeypatch.setattr(
        reply_job,
        "forward_marketing_reply",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not forward")),
    )

    result = reply_job.handler({}, None)

    assert result["suppressed"] == 1


def test_reply_sync_without_routes_does_not_poll_provider(monkeypatch) -> None:
    store = WorkspaceStore(None)
    monkeypatch.setattr(reply_job, "settings", SimpleNamespace(workspace_table="workspace"))
    monkeypatch.setattr(reply_job, "WorkspaceStore", lambda table_name: store)
    monkeypatch.setattr(
        reply_job,
        "list_received_marketing_emails",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not poll")),
    )

    result = reply_job.handler({}, None)

    assert result["status"] == "ok"
    assert result["checked"] == 0
    assert "No BidAtlas marketing routes" in result["message"]
