import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services.outreach import generate_outreach_draft
from backend.app.services.partner_directory import PartnerDirectory, has_published_contact


client = TestClient(app)
DIRECTORY_PATH = (
    Path(__file__).resolve().parents[2]
    / "data-export"
    / "new-jersey-partner-directory.json"
)
RESEARCH_PATH = DIRECTORY_PATH.with_name("tri-state-research-prospects.json")


def test_new_jersey_directory_contains_only_source_backed_contacts() -> None:
    directory = PartnerDirectory(DIRECTORY_PATH)

    assert len(directory.organizations) == 16
    assert sum(item["organizationType"] == "architect" for item in directory.organizations) == 7
    assert sum(item["organizationType"] == "owner" for item in directory.organizations) == 9
    assert all(item["state"] == "NJ" for item in directory.organizations)
    assert all(has_published_contact(item) for item in directory.organizations)
    assert all(item["sourceUrl"].startswith("https://") for item in directory.organizations)
    assert all(item["fitReasons"] for item in directory.organizations)
    assert all(item["productTypes"] for item in directory.organizations)


def test_directory_loader_rejects_missing_contacts_and_non_tri_state_records(
    tmp_path: Path,
) -> None:
    payload = {
        "organizations": [
            {
                "id": "no-contact",
                "name": "No Contact",
                "organizationType": "architect",
                "state": "NJ",
                "sourceUrl": "https://example.com/no-contact",
            },
            {
                "id": "tri-state",
                "name": "Wrong State",
                "organizationType": "developer",
                "state": "NY",
                "email": "owner@example.com",
                "sourceUrl": "https://example.com/tri-state",
            },
            {
                "id": "wrong-state",
                "name": "Outside the tri-state",
                "organizationType": "owner",
                "state": "PA",
                "email": "owner@example.com",
                "sourceUrl": "https://example.com/wrong-state",
            },
            {
                "id": "valid",
                "name": "Valid NJ Owner",
                "organizationType": "owner",
                "state": "NJ",
                "phone": "609-555-0100",
                "sourceUrl": "https://example.com/valid",
                "productTypes": ["canopies"],
            },
        ]
    }
    path = tmp_path / "directory.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    directory = PartnerDirectory(path)

    assert {item["id"] for item in directory.organizations} == {"tri-state", "valid"}


def test_combined_tri_state_research_directory_is_contactable_and_ranked() -> None:
    directory = PartnerDirectory([DIRECTORY_PATH, RESEARCH_PATH])

    assert len(directory.organizations) == 60
    assert all(item["state"] in {"NJ", "NY", "CT"} for item in directory.organizations)
    assert all(has_published_contact(item) for item in directory.organizations)
    assert directory.organizations[0]["name"] == "MBC Landscape Architecture"
    assert directory.organizations[0]["priorityRank"] == 1
    assert directory.organization("prospect:developer:russo-development")["email"] == (
        "sberchtold@russodevelopment.com"
    )

    prospect = directory.outreach_project("prospect:architect:minno-wasko")
    assert prospect is not None
    assert prospect["recordType"] == "prospect"
    assert prospect["participants"][0]["email"] == "design@minnowasko.com"
    assert prospect["prospectFitReasons"]

    draft = generate_outreach_draft(
        prospect,
        {"email": "sales@tudelu.com", "name": "Sales User"},
        [],
    )
    assert draft["recordType"] == "prospect"
    assert draft["sourceUrl"] == prospect["sourceUrl"]
    assert draft["to"] == "design@minnowasko.com"
    assert draft["prospectFitReasons"] == prospect["prospectFitReasons"]
    assert "active bid" not in draft["body"].lower()
    assert "upcoming" in draft["body"].lower()


def test_partner_directory_api_filters_architects_and_product_scope() -> None:
    response = client.get(
        "/api/partner-directory",
        params={"type": "architect", "product": "pergolas", "limit": 25},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["directoryTotal"] == 60
    assert body["summary"]["architects"] == 31
    assert body["summary"]["developers"] == 18
    assert body["summary"]["owners"] == 10
    assert body["summary"]["installers"] == 1
    assert body["summary"]["emailReady"] == 43
    assert body["summary"]["phoneOnly"] == 17
    assert body["meta"]["verifiedAt"] == "2026-07-23"
    assert body["organizations"]
    assert all(item["organizationType"] == "architect" for item in body["organizations"])
    assert all("pergolas" in item["productTypes"] for item in body["organizations"])
    assert all(item["email"] or item["phone"] for item in body["organizations"])


def test_partner_directory_api_searches_contacts_and_sectors() -> None:
    response = client.get(
        "/api/partner-directory",
        params={"q": "capital construction", "limit": 25},
    )

    assert response.status_code == 200
    names = {item["name"] for item in response.json()["organizations"]}
    assert "New Jersey Schools Development Authority" in names
    assert "Rowan University — Facilities, Planning & Operations" in names
