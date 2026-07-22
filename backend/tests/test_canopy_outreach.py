from __future__ import annotations

from fastapi.testclient import TestClient

import backend.app.api.outreach as outreach_api
from backend.app.api.auth import require_user
from backend.app.dependencies import get_catalog, get_workspace_store
from backend.app.main import app
from backend.app.services.canopy import score_text


client = TestClient(app)
TEST_USER = {"email": "outreach@tudelu.com", "name": "Outreach User", "picture": "", "gmailConnected": True}
app.dependency_overrides[require_user] = lambda: TEST_USER


def test_canopy_scoring_prioritizes_relevant_construction_language() -> None:
    assert score_text("Architectural metal canopy replacement", "construction", "332311")[0] >= 20
    assert score_text("Covered walkway improvements", "public building construction")[0] >= 12
    assert score_text("Main entrance renovation", "exterior building work")[0] >= 12


def test_canopy_scoring_rejects_false_positive_canopies() -> None:
    assert score_text("Urban tree canopy assessment", "forest habitat mapping")[0] < 0
    assert score_text("Aircraft cockpit canopy parts", "replacement NSN parts")[0] < 0
    assert score_text("100Amp service entrance replacement", "electrical work")[0] < 6


def test_search_presets_and_profile_results_include_fit_evidence() -> None:
    presets = client.get("/api/search-presets")
    assert presets.status_code == 200
    assert any(item["id"] == "direct_northeast" for item in presets.json()["presets"])

    response = client.get(
        "/api/search",
        params={
            "profile": "direct_northeast",
            "readiness": "all",
            "includeArchived": True,
            "limit": 50,
        },
    )
    assert response.status_code == 200
    assert all(project["canopyFit"]["score"] >= 8 for project in response.json()["projects"])


def test_outreach_draft_save_and_sent_history_round_trip(monkeypatch) -> None:
    catalog = get_catalog()
    project = next(
        project
        for project in catalog.projects
        if any(participant.get("email") for participant in project.get("participants", []))
    )
    store = get_workspace_store()
    store.put(TEST_USER["email"], "google#account", {"email": TEST_USER["email"], "accessToken": "test"})
    monkeypatch.setattr(outreach_api, "gmail_history", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        outreach_api,
        "send_gmail_message",
        lambda *args, **kwargs: {"messageId": "gmail-message-1", "threadId": "gmail-thread-1"},
    )

    generated = client.post(
        "/api/outreach/generate",
        json={"projectId": project["id"]},
    )
    assert generated.status_code == 200
    draft = generated.json()["draft"]
    assert draft["to"]
    assert draft["subject"]
    assert "Tudelu" in draft["body"]

    draft["subject"] = f"Reviewed: {draft['subject']}"
    saved = client.put("/api/outreach/draft", json=draft)
    assert saved.status_code == 200
    assert saved.json()["draft"]["subject"].startswith("Reviewed:")

    sent = client.post("/api/outreach/send", json=saved.json()["draft"])
    assert sent.status_code == 200
    assert sent.json()["draft"]["status"] == "sent"
    assert sent.json()["draft"]["sentAt"]
    assert sent.json()["draft"]["sentBy"] == TEST_USER["email"]
    assert sent.json()["draft"]["gmailMessageId"] == "gmail-message-1"

    history = client.get("/api/outreach/history")
    assert history.status_code == 200
    assert history.json()["history"][0]["projectId"] == project["id"]


def test_outreach_rejects_recipient_not_published_by_source(monkeypatch) -> None:
    catalog = get_catalog()
    project = catalog.projects[0]
    store = get_workspace_store()
    store.delete(TEST_USER["email"], f"outreach#{project['id']}")
    store.put(TEST_USER["email"], "google#account", {"email": TEST_USER["email"], "accessToken": "test"})
    monkeypatch.setattr(outreach_api, "gmail_history", lambda *args, **kwargs: [])
    generated = client.post("/api/outreach/generate", json={"projectId": project["id"], "regenerate": True})
    draft = {**generated.json()["draft"], "to": "unpublished@example.com"}

    response = client.post("/api/outreach/send", json=draft)

    assert response.status_code == 400
    assert "published" in response.json()["detail"]
