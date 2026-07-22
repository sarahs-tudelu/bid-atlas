from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.app.api.outreach as outreach_api
from backend.app.api.auth import require_user
from backend.app.dependencies import get_catalog, get_workspace_store
from backend.app.main import app
from backend.app.services.canopy import score_project, score_text
from backend.app.services.qualification import (
    is_contactable_canopy_project,
    published_contacts,
    published_phone_contacts,
)


client = TestClient(app)
TEST_USER = {"email": "outreach@tudelu.com", "name": "Outreach User", "picture": "", "gmailConnected": True}


@pytest.fixture(autouse=True)
def authenticated_outreach_user():
    previous = app.dependency_overrides.get(require_user)
    app.dependency_overrides[require_user] = lambda: TEST_USER
    yield
    if previous is None:
        app.dependency_overrides.pop(require_user, None)
    else:
        app.dependency_overrides[require_user] = previous


def _fake_generated_draft(
    project: dict,
    user: dict,
    history: list,
    *,
    personalize: bool = False,
    recipient: str = "",
) -> dict:
    contacts = published_contacts(project)
    contact = contacts[0]
    return {
        "projectId": project["id"],
        "projectTitle": project["title"],
        "sourceRecordId": project.get("sourceRecordId") or project["id"],
        "to": recipient or contact["email"],
        "contactName": contact["name"],
        "subject": "AI canopy outreach",
        "body": "Project-specific draft.\n\nBest regards,\nOutreach User\nBusiness Development | Tudelu\n718-782-7882\ntudelu.com",
        "status": "draft",
        "contacts": contacts,
        "canopyFit": score_project(project),
        "generation": (
            {"provider": "anthropic", "model": "claude-sonnet-4-6"}
            if personalize
            else {"provider": "template"}
        ),
    }


def test_canopy_scoring_prioritizes_relevant_construction_language() -> None:
    assert score_text("Architectural metal canopy replacement", "construction", "332311")[0] >= 20
    assert score_text("Covered walkway improvements", "public building construction")[0] >= 12
    assert score_text("Main entrance renovation", "exterior building work")[0] >= 12


def test_canopy_scoring_rejects_false_positive_canopies() -> None:
    assert score_text("Urban tree canopy assessment", "forest habitat mapping")[0] < 0
    assert score_text("Aircraft cockpit canopy parts", "replacement NSN parts")[0] < 0
    assert score_text("100Amp service entrance replacement", "electrical work")[0] < 6


def test_phone_only_project_is_contactable_without_becoming_emailable() -> None:
    project = {
        "title": "Architectural metal canopy replacement",
        "summary": "Replace covered entrance canopy",
        "participants": [{"name": "Procurement", "phone": "973-555-0100"}],
    }

    assert published_contacts(project) == []
    assert published_phone_contacts(project)[0]["phone"] == "973-555-0100"
    assert is_contactable_canopy_project(project)


def test_search_presets_and_profile_results_include_fit_evidence() -> None:
    presets = client.get("/api/search-presets")
    assert presets.status_code == 200
    national = next(
        item for item in presets.json()["presets"] if item["id"] == "direct_national"
    )
    assert len(national["states"]) == 51
    assert "DC" in national["states"]

    response = client.get(
        "/api/search",
        params={
            "profile": "direct_national",
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
    store.delete(TEST_USER["email"], f"outreach#{project['id']}")
    store.put(TEST_USER["email"], "google#account", {"email": TEST_USER["email"], "accessToken": "test"})
    monkeypatch.setattr(outreach_api, "gmail_history", lambda *args, **kwargs: [])
    monkeypatch.setattr(outreach_api, "generate_outreach_draft", _fake_generated_draft)
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
    assert draft["generation"]["provider"] == "template"

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
    monkeypatch.setattr(outreach_api, "generate_outreach_draft", _fake_generated_draft)
    generated = client.post("/api/outreach/generate", json={"projectId": project["id"], "regenerate": True})
    draft = {**generated.json()["draft"], "to": "unpublished@example.com"}

    response = client.post("/api/outreach/send", json=draft)

    assert response.status_code == 400
    assert "published" in response.json()["detail"]
