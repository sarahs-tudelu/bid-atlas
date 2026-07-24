from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.app.api.outreach as outreach_api
from backend.app.api.auth import require_user
from backend.app.dependencies import get_catalog, get_workspace_store
from backend.app.main import app
from backend.app.services.canopy import (
    project_product_matches,
    score_project,
    score_text,
)
from backend.app.services.catalog import ProjectCatalog, SearchFilters
from backend.app.services.marketing_outreach import (
    MARKETING_OWNER,
    marketing_route_key,
    marketing_sender,
)
from backend.app.services.outreach import generate_outreach_draft
from backend.app.services.qualification import (
    contact_research_status,
    is_contactable_canopy_project,
    is_product_project,
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
    sender_mode: str = "marketing",
    marketing_sender_email: str = "",
    reply_owner_email: str = "",
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
        "senderMode": sender_mode,
        "senderEmail": (
            marketing_sender_email or marketing_sender()
            if sender_mode == "marketing"
            else user["email"]
        ),
        "marketingSenderEmail": (
            marketing_sender_email or marketing_sender()
            if sender_mode == "marketing"
            else ""
        ),
        "replyOwnerEmail": (
            reply_owner_email
            if sender_mode == "marketing" and reply_owner_email
            else "jessica@tudelu.com" if sender_mode == "marketing" else user["email"]
        ),
        "replyOwnerName": "Jessica Rigolosi" if sender_mode == "marketing" else user["name"],
    }


def test_canopy_scoring_prioritizes_relevant_construction_language() -> None:
    assert score_text("Architectural metal canopy replacement", "construction", "332311")[0] >= 20
    assert score_text("Covered walkway improvements", "public building construction")[0] >= 12
    assert score_text("Main entrance renovation", "exterior building work")[0] >= 12
    assert score_text("New rooftop pergola", "commercial construction")[0] >= 20
    assert score_text("Interior partition wall replacement", "office renovation")[0] >= 20


def test_canopy_scoring_rejects_false_positive_canopies() -> None:
    assert score_text("Urban tree canopy assessment", "forest habitat mapping")[0] < 0
    assert score_text("Aircraft cockpit canopy parts", "replacement NSN parts")[0] < 0
    assert score_text("100Amp service entrance replacement", "electrical work")[0] < 6
    assert score_text("Database partition maintenance", "table partition algorithm")[0] < 0


def test_product_classification_keeps_canopies_pergolas_and_partition_walls_distinct() -> None:
    canopy = project_product_matches({"title": "Entrance canopy replacement"})
    pergola = project_product_matches({"title": "New rooftop pergola"})
    partitions = project_product_matches(
        {"title": "Demountable interior partition installation"}
    )

    assert [match["id"] for match in canopy] == ["canopies"]
    assert [match["id"] for match in pergola] == ["pergolas"]
    assert [match["id"] for match in partitions] == ["partition-walls"]


def test_compact_archive_records_reuse_validated_fit_and_product_evidence() -> None:
    project = {
        "title": "Compact imported record",
        "canopyFit": {
            "score": 18,
            "band": "high",
            "reasons": ["architectural canopy:title"],
        },
        "productMatches": [
            {
                "id": "canopies",
                "label": "Canopies",
                "score": 18,
                "reasons": [],
            }
        ],
    }

    assert score_project(project)["score"] == 18
    assert project_product_matches(project)[0]["id"] == "canopies"
    assert is_product_project(project)


def test_catalog_product_filter_returns_only_the_requested_product() -> None:
    projects = []
    for index, title in enumerate(
        (
            "Architectural canopy replacement",
            "Courtyard pergola installation",
            "Demountable partition wall renovation",
        ),
        start=1,
    ):
        projects.append(
            {
                "id": f"test:{index}",
                "sourceId": "test",
                "sourceRecordId": str(index),
                "title": title,
                "summary": "Commercial building construction",
                "stage": "design",
                "state": "NJ",
                "sourceUrl": "https://example.gov/project",
                "documents": [],
                "participants": [{"phone": "973-555-0100"}],
            }
        )
    catalog = ProjectCatalog.from_snapshot(
        {
            "generatedAt": "2026-07-23T12:00:00Z",
            "projects": projects,
            "sources": [],
            "coverage": {"states": [{"code": "NJ", "name": "New Jersey"}]},
            "inventory": {},
        },
        {"sources": []},
    )

    response = catalog.search(
        SearchFilters(
            product="partition-walls",
            include_archived=True,
            limit=10,
        )
    )

    assert [project["title"] for project in response["projects"]] == [
        "Demountable partition wall renovation"
    ]
    assert response["projects"][0]["productTypes"] == ["partition-walls"]


def test_catalog_keeps_product_fit_without_contact_and_marks_research_needed() -> None:
    catalog = ProjectCatalog.from_snapshot(
        {
            "generatedAt": "2026-07-23T12:00:00Z",
            "projects": [
                {
                    "id": "test:research",
                    "sourceId": "test",
                    "sourceRecordId": "research",
                    "title": "Architectural canopy replacement",
                    "summary": "Commercial building construction",
                    "stage": "design",
                    "state": "NJ",
                    "sourceUrl": "https://example.gov/research",
                    "documents": [],
                    "participants": [],
                },
                {
                    "id": "test:unqualified",
                    "sourceId": "test",
                    "sourceRecordId": "unqualified",
                    "title": "Office supplies",
                    "summary": "Printer paper",
                    "stage": "bidding",
                    "state": "NJ",
                    "sourceUrl": "https://example.gov/unqualified",
                    "documents": [],
                    "participants": [{"email": "buyer@example.gov"}],
                },
            ],
            "sources": [],
            "coverage": {"states": [{"code": "NJ", "name": "New Jersey"}]},
            "inventory": {},
        },
        {"sources": []},
    )

    assert [project["id"] for project in catalog.projects] == ["test:research"]
    assert catalog.project("test:research")["contactStatus"] == "research-needed"
    assert catalog.dashboard()["inventory"]["contactStatusCounts"] == {
        "research-needed": 1
    }


def test_search_prioritizes_projects_with_public_drawings() -> None:
    base = {
        "sourceId": "test",
        "title": "Architectural canopy replacement",
        "summary": "Commercial building construction",
        "stage": "bidding",
        "state": "NJ",
        "bidDate": "2026-12-01",
        "sourceUrl": "https://example.gov/project",
        "participants": [{"phone": "973-555-0100"}],
    }
    catalog = ProjectCatalog.from_snapshot(
        {
            "generatedAt": "2026-07-23T12:00:00Z",
            "projects": [
                {
                    **base,
                    "id": "test:no-drawings",
                    "sourceRecordId": "no-drawings",
                    "updatedAt": "2026-07-23T12:00:00Z",
                    "documents": [
                        {
                            "name": "Project page",
                            "kind": "source-record",
                            "url": "https://example.gov/project",
                            "access": "public",
                        }
                    ],
                },
                {
                    **base,
                    "id": "test:drawings",
                    "sourceRecordId": "drawings",
                    "updatedAt": "2026-07-01T12:00:00Z",
                    "documents": [
                        {
                            "name": "Architectural plans",
                            "kind": "plans",
                            "url": "https://example.gov/plans.pdf",
                            "access": "public",
                        }
                    ],
                },
                {
                    **base,
                    "id": "test:account-gated-drawings",
                    "sourceRecordId": "account-gated-drawings",
                    "updatedAt": "2026-07-24T12:00:00Z",
                    "documents": [
                        {
                            "name": "Signed-in plan room",
                            "kind": "plans",
                            "url": "https://example.gov/account/plans",
                            "access": "free-account",
                        }
                    ],
                },
            ],
            "sources": [],
            "coverage": {"states": [{"code": "NJ", "name": "New Jersey"}]},
            "inventory": {},
        },
        {"sources": []},
    )

    response = catalog.search(SearchFilters(include_archived=True, limit=10))

    assert [project["id"] for project in response["projects"]] == [
        "test:drawings",
        "test:account-gated-drawings",
        "test:no-drawings",
    ]
    assert response["projects"][0]["hasAccessibleDrawings"] is True
    assert response["projects"][0]["accessibleDrawingCount"] == 1
    assert response["projects"][1]["hasAccessibleDrawings"] is False
    assert catalog.dashboard()["projects"][0]["id"] == "test:drawings"
    documents = catalog.documents()["documents"]
    assert documents[0]["projectId"] == "test:drawings"
    assert documents[0]["isAccessibleDrawing"] is True
    assert next(
        document
        for document in documents
        if document["projectId"] == "test:account-gated-drawings"
    )["isAccessibleDrawing"] is False


def test_default_outreach_template_uses_the_matching_product_family() -> None:
    project = {
        "id": "test:partition",
        "sourceRecordId": "PART-100",
        "title": "Demountable partition wall renovation",
        "state": "NJ",
        "participants": [
            {"name": "Pat Buyer", "email": "pat.buyer@example.gov"}
        ],
    }

    draft = generate_outreach_draft(
        project,
        TEST_USER,
        [],
        sender_mode="employee",
    )

    assert draft["subject"] == "Partition wall support for PART-100"
    assert "partition systems" in draft["body"]
    assert "specialty canopy manufacturer" not in draft["body"]


def test_phone_only_project_is_contactable_without_becoming_emailable() -> None:
    project = {
        "title": "Architectural metal canopy replacement",
        "summary": "Replace covered entrance canopy",
        "participants": [{"name": "Procurement", "phone": "973-555-0100"}],
    }

    assert published_contacts(project) == []
    assert published_phone_contacts(project)[0]["phone"] == "973-555-0100"
    assert is_contactable_canopy_project(project)


def test_product_project_without_contact_is_visible_for_research() -> None:
    project = {
        "title": "Architectural metal canopy replacement",
        "summary": "Replace covered entrance canopy",
        "participants": [],
    }

    assert is_product_project(project)
    assert not is_contactable_canopy_project(project)
    assert contact_research_status(project) == "research-needed"


def test_search_presets_and_profile_results_include_fit_evidence() -> None:
    presets = client.get("/api/search-presets")
    assert presets.status_code == 200
    national = next(
        item for item in presets.json()["presets"] if item["id"] == "direct_national"
    )
    assert len(national["states"]) == 51
    assert "DC" in national["states"]
    assert any(item["id"] == "partition_walls" for item in presets.json()["presets"])

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


def test_outreach_config_defaults_to_marketing_and_limits_reply_owners(monkeypatch) -> None:
    monkeypatch.setattr(outreach_api, "instantly_is_configured", lambda: True)
    monkeypatch.setattr(
        outreach_api,
        "available_marketing_accounts",
        lambda: (
            [
                {
                    "email": "outreach@tudelugroup.com",
                    "name": "Alex Turner",
                    "status": "active",
                    "statusCode": 1,
                    "warmupStatus": 1,
                    "providerCode": 3,
                    "setupPending": False,
                },
                {
                    "email": "sarah@gettudelu.com",
                    "name": "Sarah",
                    "status": "active",
                    "statusCode": 1,
                    "warmupStatus": 1,
                    "providerCode": 1,
                    "setupPending": False,
                },
            ],
            "",
        ),
    )

    response = client.get("/api/outreach/config")

    assert response.status_code == 200
    config = response.json()
    assert config["defaultSenderMode"] == "marketing"
    assert config["marketing"] == {
        "configured": True,
        "email": "outreach@tudelugroup.com",
        "name": "Alex Turner",
    }
    assert config["employee"]["email"] == TEST_USER["email"]
    assert [account["email"] for account in config["marketingAccounts"]] == [
        "outreach@tudelugroup.com",
        "sarah@gettudelu.com",
    ]
    assert config["defaultReplyOwnerEmail"] == "jessica@tudelu.com"
    assert {owner["email"] for owner in config["salesReplyOwners"]} == {
        "jadalyn.gaines@tudelu.com",
        "patrick.may@tudelu.com",
        "jessica@tudelu.com",
        "abe@tudelu.com",
        "shlomo.h@tudelu.com",
    }


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
    recipient = published_contacts(project)[0]["email"]
    store.delete(MARKETING_OWNER, marketing_route_key(recipient))
    monkeypatch.setattr(outreach_api, "gmail_history", lambda *args, **kwargs: [])
    monkeypatch.setattr(outreach_api, "generate_outreach_draft", _fake_generated_draft)
    monkeypatch.setattr(
        outreach_api,
        "send_marketing_email",
        lambda **kwargs: {"provider": "instantly:test-email", "sender": marketing_sender()},
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
    assert draft["senderMode"] == "marketing"
    assert draft["senderEmail"] == marketing_sender()

    draft["subject"] = f"Reviewed: {draft['subject']}"
    saved = client.put("/api/outreach/draft", json=draft)
    assert saved.status_code == 200
    assert saved.json()["draft"]["subject"].startswith("Reviewed:")

    sent = client.post("/api/outreach/send", json=saved.json()["draft"])
    assert sent.status_code == 200
    assert sent.json()["draft"]["status"] == "sent"
    assert sent.json()["draft"]["sentAt"]
    assert sent.json()["draft"]["sentBy"] == TEST_USER["email"]
    assert sent.json()["draft"]["deliveryProvider"] == "instantly:test-email"
    assert sent.json()["draft"]["replyOwnerEmail"] == "jessica@tudelu.com"

    history = client.get("/api/outreach/history")
    assert history.status_code == 200
    assert history.json()["history"][0]["projectId"] == project["id"]


def test_employee_sender_remains_available_through_logged_in_gmail(monkeypatch) -> None:
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
        json={"projectId": project["id"], "senderMode": "employee", "regenerate": True},
    )
    assert generated.status_code == 200
    draft = generated.json()["draft"]
    assert draft["senderEmail"] == TEST_USER["email"]
    sent = client.post("/api/outreach/send", json=draft)

    assert sent.status_code == 200
    assert sent.json()["draft"]["deliveryProvider"] == "gmail"
    assert sent.json()["draft"]["gmailMessageId"] == "gmail-message-1"
    assert sent.json()["draft"]["replyOwnerEmail"] == TEST_USER["email"]


def test_outreach_rejects_recipient_not_published_by_source(monkeypatch) -> None:
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
    generated = client.post("/api/outreach/generate", json={"projectId": project["id"], "regenerate": True})
    draft = {**generated.json()["draft"], "to": "unpublished@example.com"}

    response = client.post("/api/outreach/send", json=draft)

    assert response.status_code == 400
    assert "published" in response.json()["detail"]
