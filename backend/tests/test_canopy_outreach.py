from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.dependencies import get_catalog
from backend.app.main import app
from backend.app.services.canopy import score_text


client = TestClient(app)


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


def test_outreach_draft_save_and_sent_history_round_trip() -> None:
    catalog = get_catalog()
    project = next(
        project
        for project in catalog.projects
        if any(participant.get("email") for participant in project.get("participants", []))
    )
    headers = {"x-bidatlas-user": f"outreach-{uuid4()}@device.bidatlas"}

    generated = client.post(
        "/api/outreach/generate",
        headers=headers,
        json={"projectId": project["id"]},
    )
    assert generated.status_code == 200
    draft = generated.json()["draft"]
    assert draft["to"]
    assert draft["subject"]
    assert "Tudelu" in draft["body"]

    draft["subject"] = f"Reviewed: {draft['subject']}"
    saved = client.put("/api/outreach/draft", headers=headers, json=draft)
    assert saved.status_code == 200
    assert saved.json()["draft"]["subject"].startswith("Reviewed:")

    sent = client.post("/api/outreach/mark-sent", headers=headers, json=saved.json()["draft"])
    assert sent.status_code == 200
    assert sent.json()["draft"]["status"] == "sent"
    assert sent.json()["draft"]["sentAt"]

    history = client.get("/api/outreach/history", headers=headers)
    assert history.status_code == 200
    assert history.json()["history"][0]["projectId"] == project["id"]
