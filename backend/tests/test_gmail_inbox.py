from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Any

from backend.app.services.gmail_inbox import (
    GMAIL_READONLY_SCOPE,
    assign_correspondence_project,
    record_sent_correspondence,
    sync_gmail_account,
)
from backend.app.services.state import WorkspaceStore


def _message(
    message_id: str,
    *,
    sender: str,
    recipient: str = "seller@tudelu.com",
    subject: str,
    snippet: str = "",
    attachment: bool = False,
) -> dict[str, Any]:
    parts = []
    if attachment:
        content = base64.urlsafe_b64encode(b"project drawing").decode("ascii").rstrip("=")
        parts.append(
            {
                "filename": "drawing.pdf",
                "mimeType": "application/pdf",
                "body": {"data": content, "size": 15},
            }
        )
    return {
        "id": message_id,
        "threadId": f"thread-{message_id}",
        "internalDate": "1767225600000",
        "snippet": snippet,
        "labelIds": ["INBOX"],
        "payload": {
            "headers": [
                {"name": "From", "value": sender},
                {"name": "To", "value": recipient},
                {"name": "Subject", "value": subject},
            ],
            "parts": parts,
        },
    }


class FakeS3:
    def __init__(self) -> None:
        self.objects: list[dict[str, Any]] = []

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        self.objects.append(kwargs)
        return {}


def test_sync_files_project_mail_and_leaves_ambiguous_contact_for_review(monkeypatch) -> None:
    projects = [
        {
            "id": "project-1",
            "title": "Civic Center Canopy",
            "sourceRecordId": "SOL-100",
            "participants": [{"email": "architect@example.com"}],
        },
        {
            "id": "project-2",
            "title": "East School Pergola",
            "sourceRecordId": "SOL-200",
            "participants": [{"email": "shared@example.com"}],
        },
        {
            "id": "project-3",
            "title": "West School Partitions",
            "sourceRecordId": "SOL-300",
            "participants": [{"email": "shared@example.com"}],
        },
    ]
    messages = {
        "m1": _message(
            "m1",
            sender="Architect <architect@example.com>",
            subject="Re: drawings for SOL-100",
            snippet="The revised canopy set is attached.",
            attachment=True,
        ),
        "m2": _message(
            "m2",
            sender="shared@example.com",
            subject="Following up",
            snippet="Please review.",
        ),
    }

    def fake_gmail_request(owner, account, store, path, **kwargs):
        del owner, store, kwargs
        if path.startswith("/messages?"):
            return {"messages": [{"id": "m1"}, {"id": "m2"}]}, account
        message_id = path.split("/")[2].split("?")[0]
        return messages[message_id], account

    monkeypatch.setattr(
        "backend.app.services.gmail_inbox.gmail_request",
        fake_gmail_request,
    )
    store = WorkspaceStore(None)
    s3 = FakeS3()
    result = sync_gmail_account(
        "seller@tudelu.com",
        {"scopes": [GMAIL_READONLY_SCOPE]},
        store,
        SimpleNamespace(projects=projects),
        document_store=s3,
        documents_bucket="private-documents",
    )

    filed = store.get("seller@tudelu.com", "correspondence#m1")
    ambiguous = store.get("seller@tudelu.com", "correspondence#m2")
    assert result["messagesStored"] == 2
    assert filed["projectId"] == "project-1"
    assert filed["matchedBy"] == "project-reference"
    assert filed["direction"] == "received"
    assert filed["attachments"][0]["name"] == "drawing.pdf"
    assert s3.objects[0]["Bucket"] == "private-documents"
    assert s3.objects[0]["Body"] == b"project drawing"
    assert ambiguous["projectId"] == ""
    assert ambiguous["candidateProjectIds"] == ["project-2", "project-3"]


def test_sent_mail_is_logged_immediately_and_can_be_reassigned() -> None:
    store = WorkspaceStore(None)
    project = {
        "id": "project-1",
        "title": "Civic Center Canopy",
        "sourceRecordId": "SOL-100",
    }
    record_sent_correspondence(
        store,
        "seller@tudelu.com",
        project,
        {
            "subject": "Canopy support",
            "body": "Hello from Tudelu",
            "to": "architect@example.com",
        },
        message_id="sent-1",
        thread_id="thread-1",
        sent_at="2026-07-23T12:00:00+00:00",
    )
    sent = store.get("seller@tudelu.com", "correspondence#sent-1")
    assert sent["direction"] == "sent"
    assert sent["matchedBy"] == "sent-from-project"
    assert sent["projectId"] == "project-1"

    reassigned = assign_correspondence_project(
        store,
        "seller@tudelu.com",
        "sent-1",
        {"id": "project-2", "title": "School Pergola", "sourceRecordId": "SOL-200"},
    )
    assert reassigned["projectId"] == "project-2"
    assert reassigned["matchedBy"] == "manual"
