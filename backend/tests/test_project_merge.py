from __future__ import annotations

from backend.app.services.catalog import ProjectCatalog
from backend.app.services.project_merge import merge_duplicate_projects


def _project(
    project_id: str,
    *,
    source_id: str,
    address: str,
    contact: bool = False,
    drawings: bool = False,
) -> dict:
    return {
        "id": project_id,
        "sourceId": source_id,
        "sourceRecordId": project_id.rsplit(":", 1)[-1],
        "sourceName": f"{source_id} database",
        "sourceUrl": f"https://example.gov/{project_id}",
        "title": "Architectural canopy replacement at Central Station",
        "summary": "Replace the station entrance canopy.",
        "stage": "bidding",
        "state": "NY",
        "city": "Albany",
        "address": address,
        "bidDate": "2026-09-01T15:00:00Z",
        "updatedAt": "2026-07-24T12:00:00Z",
        "participants": (
            [{"name": "Pat Buyer", "email": "pat@example.gov"}] if contact else []
        ),
        "documents": (
            [
                {
                    "name": "Architectural drawings",
                    "kind": "plans",
                    "url": "https://example.gov/plans.pdf",
                    "access": "public",
                }
            ]
            if drawings
            else []
        ),
    }


def test_cross_source_duplicates_merge_contacts_documents_and_provenance() -> None:
    projects, audit = merge_duplicate_projects(
        [
            _project(
                "alpha:100",
                source_id="alpha",
                address="100 Central Avenue",
                contact=True,
            ),
            _project(
                "beta:ABC-900",
                source_id="beta",
                address="100 Central Ave.",
                drawings=True,
            ),
        ]
    )

    assert audit == {
        "inputProjects": 2,
        "mergedProjects": 1,
        "duplicateGroups": 1,
        "duplicateRowsMerged": 1,
    }
    assert len(projects) == 1
    merged = projects[0]
    assert merged["id"] == "alpha:100"
    assert merged["contactStatus"] == "published-contact"
    assert merged["duplicateSourceCount"] == 2
    assert merged["duplicateProjectIds"] == ["alpha:100", "beta:ABC-900"]
    assert len(merged["sourceRecords"]) == 2
    assert merged["participants"][0]["email"] == "pat@example.gov"
    assert merged["documents"][0]["kind"] == "plans"


def test_similar_records_at_different_addresses_do_not_merge() -> None:
    projects, audit = merge_duplicate_projects(
        [
            _project("alpha:100", source_id="alpha", address="100 Central Avenue"),
            _project("beta:200", source_id="beta", address="200 Central Avenue"),
        ]
    )

    assert len(projects) == 2
    assert audit["duplicateRowsMerged"] == 0


def test_catalog_resolves_every_merged_source_id_to_the_canonical_project() -> None:
    source_projects = [
        _project(
            "alpha:100",
            source_id="alpha",
            address="100 Central Avenue",
            contact=True,
        ),
        _project(
            "beta:ABC-900",
            source_id="beta",
            address="100 Central Ave.",
            drawings=True,
        ),
    ]
    catalog = ProjectCatalog.from_snapshot(
        {
            "generatedAt": "2026-07-24T12:00:00Z",
            "projects": source_projects,
            "sources": [],
            "coverage": {"states": [{"code": "NY", "name": "New York"}]},
            "inventory": {},
        },
        {"sources": []},
    )

    canonical = catalog.project("alpha:100")
    alias = catalog.project("beta:ABC-900")
    assert canonical is not None
    assert alias is not None
    assert canonical["id"] == alias["id"] == "alpha:100"
    assert canonical["duplicateSourceCount"] == 2
    assert catalog.duplicate_merge_audit["duplicateRowsMerged"] == 1
