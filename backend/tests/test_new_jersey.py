from __future__ import annotations

from datetime import date

from backend.app.services.new_jersey import (
    DPMC_SOURCE_ID,
    NJDOT_SOURCE_ID,
    merge_new_jersey_snapshot,
    parse_dpmc_projects,
    parse_njdot_projects,
)
from backend.app.services.catalog import ProjectCatalog, SearchFilters
from backend.app.services.catalog_provider import ProjectCatalogProvider


DPMC_HTML = """
<table id="example1">
  <thead><tr><th>Project</th><th>Description</th><th>Cost</th><th>Due</th><th>Status</th></tr></thead>
  <tbody>
    <tr>
      <td><a href="Assets/Files/advertisements/project-construction-advertisements/M1642-00Ad.pdf">M1642-00</a><p>SBE Opportunity</p></td>
      <td>Chiller Replacement and Associated Repairs – New Brunswick, Middlesex County, NJ</td>
      <td>$911,411</td>
      <td><p>08/20/2026</p><p>08/27/2026</p></td>
      <td></td>
    </tr>
    <tr>
      <td><a href="Assets/Files/advertisements/project-construction-advertisements/P1330-00Ad.pdf">P1330-00</a></td>
      <td>Old Office Renovation – Long Valley, Morris County, NJ</td>
      <td>$510,300</td>
      <td>06/04/2026</td>
      <td><a href="P1330-00Award.pdf">Award Information</a><br>NTP date 07/20/2026</td>
    </tr>
    <tr>
      <td><a href="Assets/Files/advertisements/project-construction-advertisements/E0402-00Ad.pdf">E0402-00</a></td>
      <td>HVAC and roof replacement – Ewing, Mercer County, NJ</td>
      <td>$3,673,250</td>
      <td>05/07/2026</td>
      <td>CANCELLED</td>
    </tr>
  </tbody>
</table>
"""


NJDOT_HTML = """
<table>
  <tr><th>Letting Date</th><th>Project</th></tr>
  <tr>
    <td><strong>8/11/26</strong></td>
    <td>
      <a href="/transportation/contribute/business/procurement/ConstrServ/documents/NoticeToContractors_DP26416.pdf">
        Vegetation Safety Management Project, Route I-280, Morris, Essex, and Hudson Counties; DP No: 26416.
      </a>
      <a href="https://example.com/not-official.pdf">DP No: 99999 outside host</a>
    </td>
  </tr>
  <tr>
    <td>6/9/26</td>
    <td><a href="/transportation/contribute/business/procurement/ConstrServ/documents/NoticeToContractors_DP25417.pdf">Signature Bridge Preventive Maintenance Contract, Monmouth and Ocean Counties; DP No: 25417.</a></td>
  </tr>
</table>
"""


def test_dpmc_parser_uses_latest_due_date_and_truthful_lifecycle() -> None:
    result = parse_dpmc_projects(
        DPMC_HTML,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert result.source_id == DPMC_SOURCE_ID
    assert result.source["status"] == "live"
    assert result.source["loadedCount"] == 3
    projects = {project["sourceRecordId"]: project for project in result.projects}
    assert projects["M1642-00"]["stage"] == "bidding"
    assert projects["M1642-00"]["bidDate"] == "2026-08-27"
    assert projects["M1642-00"]["value"] == 911_411
    assert projects["M1642-00"]["county"] == "Middlesex"
    assert projects["M1642-00"]["documents"][0]["url"].startswith("https://www.nj.gov/")
    assert projects["P1330-00"]["stage"] == "construction"
    assert projects["E0402-00"]["stage"] == "cancelled"


def test_njdot_parser_rejects_external_links_and_classifies_deadlines() -> None:
    result = parse_njdot_projects(
        NJDOT_HTML,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert result.source_id == NJDOT_SOURCE_ID
    assert len(result.projects) == 2
    projects = {project["sourceRecordId"]: project for project in result.projects}
    assert projects["26416"]["stage"] == "bidding"
    assert projects["26416"]["county"] == "Essex, Hudson, Morris"
    assert projects["25417"]["stage"] == "bid-opened"
    assert "99999" not in projects


def test_snapshot_merge_replaces_only_successful_nj_sources_and_updates_coverage() -> None:
    dpmc = parse_dpmc_projects(
        DPMC_HTML,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )
    snapshot = {
        "generatedAt": "2026-07-21T00:00:00Z",
        "projects": [
            {
                "id": "other:1",
                "sourceId": "other",
                "sourceRecordId": "1",
                "title": "Other project",
                "stage": "bidding",
                "state": "NY",
                "bidDate": "2026-09-01",
                "documents": [{"url": "https://example.gov/notice"}],
                "participants": [],
            },
            {
                "id": f"{DPMC_SOURCE_ID}:old",
                "sourceId": DPMC_SOURCE_ID,
                "sourceRecordId": "old",
                "title": "Stale NJ project",
                "stage": "bidding",
                "state": "NJ",
                "bidDate": "2026-08-01",
                "documents": [],
                "participants": [],
            },
        ],
        "sources": [{"id": "other", "status": "live"}],
        "warnings": [],
        "coverage": {
            "states": [
                {"code": "NY", "loadedProjects": 1},
                {
                    "code": "NJ",
                    "loadedProjects": 0,
                    "procurement": "identified",
                    "dotBidding": "identified",
                },
            ]
        },
        "inventory": {},
    }

    refreshed = merge_new_jersey_snapshot(
        snapshot,
        [dpmc],
        refreshed_at="2026-07-22T12:00:00Z",
    )

    ids = {project["id"] for project in refreshed["projects"]}
    assert "other:1" in ids
    assert f"{DPMC_SOURCE_ID}:old" not in ids
    assert refreshed["inventory"]["stateCounts"]["NJ"] == 3
    nj = next(state for state in refreshed["coverage"]["states"] if state["code"] == "NJ")
    assert nj["loadedProjects"] == 3
    assert nj["procurement"] == "partial"
    assert nj["dotBidding"] == "identified"

    catalog = ProjectCatalog.from_snapshot(refreshed, {"sources": []})
    search = catalog.search(SearchFilters(state="NJ", readiness="bid-ready", limit=10))
    assert search["meta"]["matchedProjects"] == 1
    assert search["projects"][0]["sourceRecordId"] == "M1642-00"


class _Body:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def read(self, size: int = -1) -> bytes:
        return self.payload if size < 0 else self.payload[:size]


class _S3:
    def __init__(self, snapshot: dict) -> None:
        self.snapshot = snapshot
        self.etag = "one"

    def head_object(self, **kwargs: object) -> dict:
        return {"ETag": f'"{self.etag}"'}

    def get_object(self, **kwargs: object) -> dict:
        import json

        return {"Body": _Body(json.dumps(self.snapshot).encode("utf-8"))}


def test_catalog_provider_reloads_changed_s3_snapshot(tmp_path) -> None:
    import json

    local_snapshot = {
        "generatedAt": "2026-07-21T00:00:00Z",
        "projects": [],
        "sources": [],
        "coverage": {"states": []},
        "inventory": {},
        "warnings": [],
    }
    (tmp_path / "current-projects.json").write_text(json.dumps(local_snapshot), encoding="utf-8")
    (tmp_path / "source-registry.json").write_text('{"sources":[]}', encoding="utf-8")
    s3 = _S3({**local_snapshot, "generatedAt": "2026-07-22T00:00:00Z"})
    provider = ProjectCatalogProvider(
        tmp_path,
        bucket="catalog",
        refresh_seconds=0,
        s3_client=s3,
    )

    assert provider.get().generated_at == "2026-07-22T00:00:00Z"
    s3.snapshot = {**local_snapshot, "generatedAt": "2026-07-23T00:00:00Z"}
    s3.etag = "two"
    assert provider.get().generated_at == "2026-07-23T00:00:00Z"
