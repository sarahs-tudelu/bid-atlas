from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

from scripts.import_bidatlas_archive import merge_projects, qualifying_projects


def _project(project_id: str, *, stage: str = "bidding", contact: bool = True) -> dict:
    return {
        "id": project_id,
        "sourceId": "test-current-source",
        "sourceRecordId": project_id.rsplit(":", 1)[-1],
        "title": "Architectural canopy replacement",
        "summary": "Replace the public entrance canopy.",
        "stage": stage,
        "status": "Open",
        "state": "NY",
        "updatedAt": "2026-07-22T20:00:00Z",
        "documents": [],
        "participants": (
            [{"name": "Public contact", "email": "contact@example.gov"}]
            if contact
            else []
        ),
        "searchableFields": [],
        "documentTextIndexed": False,
    }


def _write_archive(tmp_path: Path) -> Path:
    archive = tmp_path / "BidAtlas-data-only"
    source = archive / "current-source-crawl" / "sources" / "test-current-source"
    pages = source / "pages"
    pages.mkdir(parents=True)
    (archive / "PACKAGE-SUMMARY.json").write_text(
        json.dumps(
            {
                "packageType": "bidatlas-data-only",
                "packageCreatedAt": "2026-07-24T14:51:50Z",
                "dataCapturedAt": "2026-07-22",
                "containsSecrets": False,
            }
        ),
        encoding="utf-8",
    )
    (archive / "current-source-crawl" / "manifest.json").write_text(
        json.dumps(
            {
                "completedAt": "2026-07-22T21:03:11Z",
                "sourceCompleteness": {
                    "sources": [
                        {
                            "sourceId": "test-current-source",
                            "status": "complete",
                            "snapshotComplete": True,
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    (source / "manifest.json").write_text(
        json.dumps({"status": "complete", "complete": True}),
        encoding="utf-8",
    )
    page_path = pages / "000001.ndjson.gz"
    with gzip.open(page_path, "wt", encoding="utf-8") as handle:
        for project in (
            _project("test-current-source:qualifying"),
            _project("test-current-source:no-contact", contact=False),
            _project("test-current-source:completed", stage="completed"),
        ):
            handle.write(json.dumps(project) + "\n")
    checksum = hashlib.sha256(page_path.read_bytes()).hexdigest()
    (pages / "000001.json").write_text(
        json.dumps({"gzipSha256": checksum}),
        encoding="utf-8",
    )
    return archive


def test_archive_import_keeps_product_projects_and_flags_missing_contacts(
    tmp_path: Path,
) -> None:
    projects, audit = qualifying_projects(
        _write_archive(tmp_path),
        verify_checksums=True,
    )

    assert [project["id"] for project in projects] == [
        "test-current-source:no-contact",
        "test-current-source:qualifying"
    ]
    by_id = {project["id"]: project for project in projects}
    assert by_id["test-current-source:qualifying"]["contactStatus"] == "published-contact"
    assert by_id["test-current-source:no-contact"]["contactStatus"] == "research-needed"
    assert projects[0]["canopyFit"]["score"] >= 8
    assert "searchableFields" not in projects[0]
    assert audit["scannedRows"] == 3
    assert audit["qualifiedProjects"] == 2
    assert audit["publishedContactProjects"] == 1
    assert audit["researchNeededProjects"] == 1


def test_archive_merge_is_idempotent_and_refreshes_aggregates() -> None:
    imported = _project("test-current-source:qualifying")
    snapshot = {
        "generatedAt": "2026-07-21T00:00:00Z",
        "projects": [],
        "sources": [],
        "inventory": {},
        "coverage": {"states": [{"code": "NY", "loadedProjects": 0}]},
    }

    first = merge_projects(
        snapshot,
        [imported],
        refreshed_at="2026-07-24T14:51:50Z",
    )
    second = merge_projects(
        snapshot,
        [imported],
        refreshed_at="2026-07-24T14:51:50Z",
    )

    assert first == {
        "inserted": 1,
        "updated": 0,
        "retained": 0,
        "deduplicated": 0,
    }
    assert second == {
        "inserted": 0,
        "updated": 0,
        "retained": 1,
        "deduplicated": 0,
    }
    assert snapshot["inventory"]["totalProjects"] == 1
    assert snapshot["coverage"]["loadedProjectRecords"] == 1
    assert snapshot["coverage"]["states"][0]["loadedProjects"] == 1
