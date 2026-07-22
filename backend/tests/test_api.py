from fastapi.testclient import TestClient

from backend.app.main import app


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
    assert body["meta"]["matchedProjects"] == new_jersey["loadedProjects"]
    assert all(project["state"] == "NJ" for project in body["projects"])


def test_workspace_draft_round_trip() -> None:
    payload = {"projectId": "example:1", "notes": "Confirm addendum."}
    saved = client.post("/api/bid-drafts", json=payload)
    assert saved.status_code == 200
    loaded = client.get("/api/bid-drafts", params={"projectId": "example:1"})
    assert loaded.status_code == 200
    assert loaded.json()["draft"]["notes"] == "Confirm addendum."
