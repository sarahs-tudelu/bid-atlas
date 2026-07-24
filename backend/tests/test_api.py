from fastapi.testclient import TestClient

from backend.app.api.auth import require_user
from backend.app.dependencies import get_workspace_store
from backend.app.main import app
from backend.app.services.qualification import is_product_project


TEST_USER = {"email": "tester@tudelu.com", "name": "Test User", "picture": "", "gmailConnected": True}
app.dependency_overrides[require_user] = lambda: TEST_USER


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_meta_exposes_fastapi_catalog() -> None:
    response = client.get("/api/meta")
    assert response.status_code == 200
    body = response.json()
    assert body["backend"] == "FastAPI"
    assert body["projectCount"] > 0
    assert body["statesAndDistrict"] == 51


def test_bid_search_returns_only_qualified_bids() -> None:
    response = client.get("/api/search", params={"readiness": "bid-ready", "limit": 10})
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["pageSize"] == 10
    assert all(project["stage"] == "bidding" for project in body["projects"])
    assert all(project.get("documents") for project in body["projects"])


def test_new_jersey_catalog_is_connected_and_searchable() -> None:
    coverage_response = client.get("/api/coverage")
    assert coverage_response.status_code == 200
    new_jersey = next(
        state
        for state in coverage_response.json()["coverage"]["states"]
        if state["code"] == "NJ"
    )
    assert new_jersey["loadedProjects"] > 0
    assert new_jersey["procurement"] == "partial"
    assert new_jersey["dotBidding"] == "partial"

    search_response = client.get(
        "/api/search",
        params={
            "state": "NJ",
            "readiness": "all",
            "includeArchived": True,
            "limit": 10,
        },
    )
    assert search_response.status_code == 200
    body = search_response.json()
    assert body["meta"]["matchedProjects"] <= new_jersey["loadedProjects"]
    assert all(project["state"] == "NJ" for project in body["projects"])
    assert all(is_product_project(project) for project in body["projects"])
    assert all(
        project["contactStatus"] in {"published-contact", "research-needed"}
        for project in body["projects"]
    )


def test_workspace_draft_round_trip() -> None:
    payload = {"projectId": "example:1", "notes": "Confirm addendum."}
    saved = client.post("/api/bid-drafts", json=payload)
    assert saved.status_code == 200
    loaded = client.get("/api/bid-drafts", params={"projectId": "example:1"})
    assert loaded.status_code == 200
    assert loaded.json()["draft"]["notes"] == "Confirm addendum."


def test_inbox_is_owner_scoped_and_manual_assignment_uses_qualified_project() -> None:
    project = client.get("/api/search", params={"readiness": "all", "limit": 10}).json()["projects"][0]
    store = get_workspace_store()
    store.put(
        TEST_USER["email"],
        "correspondence#api-message-1",
        {
            "messageId": "api-message-1",
            "threadId": "api-thread-1",
            "projectId": "",
            "projectTitle": "",
            "sourceRecordId": "",
            "candidateProjectIds": [project["id"]],
            "matchedBy": "needs-review",
            "matchConfidence": "unassigned",
            "subject": "Project documents",
            "from": "architect@example.com",
            "to": TEST_USER["email"],
            "cc": "",
            "occurredAt": "2026-07-23T12:00:00+00:00",
            "direction": "received",
            "snippet": "The drawing is attached.",
            "attachments": [
                {
                    "name": "drawing.pdf",
                    "mimeType": "application/pdf",
                    "size": 1024,
                    "status": "filed",
                    "key": "gmail/private/api-message-1/drawing.pdf",
                }
            ],
            "hasAttachments": True,
            "attachmentWarnings": [],
        },
    )
    response = client.get(
        "/api/inbox",
        params={"status": "unassigned", "limit": 25},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(response.content) < 1_000_000
    assert len(body["projects"]) <= 500
    assert any(item["id"] == project["id"] for item in body["projects"])
    message = next(item for item in body["messages"] if item["messageId"] == "api-message-1")
    assert "key" not in message["attachments"][0]
    assert message["attachments"][0]["downloadUrl"].endswith("/api-message-1/0")

    assigned = client.put(
        "/api/inbox/messages/api-message-1/project",
        json={"projectId": project["id"]},
    )
    assert assigned.status_code == 200
    assert assigned.json()["message"]["projectId"] == project["id"]
    assert assigned.json()["message"]["matchedBy"] == "manual"

    project_view = client.get(
        "/api/inbox",
        params={"projectId": project["id"], "limit": 10},
    )
    assert project_view.status_code == 200
    assert any(
        item["messageId"] == "api-message-1"
        for item in project_view.json()["messages"]
    )
