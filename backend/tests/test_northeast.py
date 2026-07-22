from __future__ import annotations

import json
import ssl
from datetime import date
from io import BytesIO
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

from backend.app.services import northeast
from backend.app.services.northeast import (
    MAINE_DOT_SOURCE_ID,
    NEW_YORK_DOT_SOURCE_ID,
    fetch_sam_state,
    northeast_source_coverage,
    parse_maine_dot_projects,
    parse_new_york_dot_projects,
    sam_source_id,
)
from backend.app.services.source_refresh import merge_source_snapshot
from backend.app.services.northeast_portals import (
    MASSACHUSETTS_SOURCE_ID,
    PENNSYLVANIA_SOURCE_ID,
    WEBPROCURE_SOURCES,
    _webprocure_ssl_context,
    fetch_vermont_projects,
    fetch_webprocure_source,
    parse_massachusetts_dcr_projects,
    parse_pennsylvania_dgs_projects,
)


MAINE_HTML = """
<table>
  <tr><th>Bid Date</th><th>WIN(s)</th><th>Municipality</th><th>Summary</th><th>Status</th><th>Date posted</th></tr>
  <tr>
    <td><time datetime="2026-08-12T12:00:00Z">08/12/2026</time></td>
    <td><a href="/dot/doing-business/bid-opportunities/02865200">028652.00</a></td>
    <td>Portland</td>
    <td>Passenger shelter and covered walkway replacement.</td>
    <td>Pending</td>
    <td>07/20/2026</td>
  </tr>
</table>
"""


NEW_YORK_HTML = """
<table id="myTable">
  <thead><tr><th>D #</th><th>Advertised Letting Date</th></tr></thead>
  <tbody>
    <tr><td><a href="/doing-business/opportunities/const-contract-docs?p_d_id=D265786">D265786</a></td><td>September 16, 2026</td></tr>
    <tr><td><a href="https://example.com/D999999">D999999</a></td><td>September 20, 2026</td></tr>
    <tr><td><a href="/doing-business/opportunities/const-contract-docs?p_d_id=D200000">D200000</a></td><td>June 1, 2026</td></tr>
  </tbody>
</table>
"""


MASSACHUSETTS_HTML = """
<table>
  <tr><th>Contract #</th><th>Name</th><th>Date</th></tr>
  <tr><td>P26-3636-C6A</td><td>Project Shade: Lake Wyola</td><td>07/30/2026</td></tr>
  <tr><td>P26-OLD-C1A</td><td>Past project</td><td>06/01/2026</td></tr>
</table>
"""


PENNSYLVANIA_HTML = """
<h3>Current Projects Bidding</h3>
<ul><li>DGS 403-86 P4 - Cheyney University - Athletic Complex Construction</li></ul>
<h3>Awarded Bids</h3>
<ul><li>DGS 100-01 - Old award</li></ul>
"""


def test_webprocure_context_preserves_tls_verification() -> None:
    context = _webprocure_ssl_context()

    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_maine_and_new_york_parsers_keep_official_current_records() -> None:
    maine = parse_maine_dot_projects(
        MAINE_HTML,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert maine.source_id == MAINE_DOT_SOURCE_ID
    assert maine.projects[0]["stage"] == "bidding"
    assert maine.projects[0]["city"] == "Portland"
    assert maine.projects[0]["sourceUrl"].startswith("https://www.maine.gov/")

    new_york = parse_new_york_dot_projects(
        NEW_YORK_HTML,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert new_york.source_id == NEW_YORK_DOT_SOURCE_ID
    assert [project["sourceRecordId"] for project in new_york.projects] == ["D265786"]


def test_massachusetts_and_pennsylvania_current_construction_parsers() -> None:
    massachusetts = parse_massachusetts_dcr_projects(
        MASSACHUSETTS_HTML,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert massachusetts.source_id == MASSACHUSETTS_SOURCE_ID
    assert [project["sourceRecordId"] for project in massachusetts.projects] == ["P26-3636-C6A"]
    assert massachusetts.projects[0]["participants"][0]["email"].endswith("@mass.gov")

    pennsylvania = parse_pennsylvania_dgs_projects(
        PENNSYLVANIA_HTML,
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert pennsylvania.source_id == PENNSYLVANIA_SOURCE_ID
    assert len(pennsylvania.projects) == 1
    assert "Old award" not in pennsylvania.projects[0]["title"]


def test_webprocure_connector_keeps_relevant_open_bid_and_contact() -> None:
    config = WEBPROCURE_SOURCES[0]

    def fake_html(url: str) -> str:
        assert url == config.source_url
        return "_wprocure.push(['_customerid', 51]);"

    def fake_json(url: str) -> dict:
        if "/soldetail/" in url:
            return {
                "records": [
                    {
                        "bidContacts": [
                            {
                                "bidContactDetail": {
                                    "contactinfo": "Pat Buyer\npat.buyer@example.gov"
                                }
                            }
                        ]
                    }
                ]
            }
        return {
            "hits": 1,
            "records": [
                {
                    "bidid": 123,
                    "bidNumber": "CT-123",
                    "title": "Architectural metal canopy replacement",
                    "description": "Replace the entrance canopy.",
                    "openDate": 1786838400000,
                    "startDate": 1782864000000,
                    "creatorOrg": {"name": "Town of Example"},
                    "orgBidClassType": {"description": "Invitation for Bid"},
                }
            ],
        }

    result, warnings = fetch_webprocure_source(
        config,
        fake_html,
        fake_json,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert warnings == []
    assert len(result.projects) == 1
    assert result.projects[0]["participants"][0]["email"] == "pat.buyer@example.gov"


def test_vermont_project_service_adds_published_factsheet_contact() -> None:
    def fake_json(url: str) -> dict:
        if "/1/query" in url:
            return {
                "features": [
                    {
                        "attributes": {
                            "PIN": "22G064",
                            "ProjectName": "HARTFORD",
                            "ProjectNumber": "PLAT(6)",
                            "LocalName": "Canopy Maintenance",
                            "Status": "Development",
                            "Description": "Replace the station platform canopy.",
                            "ProjMan": "Dejan,Sasa",
                        }
                    }
                ],
                "exceededTransferLimit": False,
            }
        return {"features": [], "exceededTransferLimit": False}

    result = fetch_vermont_projects(
        lambda url: '<a href="mailto:sasa.dejan@vermont.gov">Contact</a>',
        fake_json,
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert len(result.projects) == 1
    assert result.projects[0]["participants"][0]["name"] == "Sasa Dejan"
    assert result.projects[0]["participants"][0]["email"] == "sasa.dejan@vermont.gov"


def test_sam_state_connector_deduplicates_queries_and_keeps_published_contact() -> None:
    def fake_fetch(url: str) -> dict:
        query = parse_qs(urlparse(url).query)
        state = query["state"][0]
        assert query["limit"] == ["1000"]
        return {
            "totalRecords": 1,
            "opportunitiesData": [
                {
                    "noticeId": f"notice-{state}",
                    "title": "Architectural metal canopy replacement",
                    "solicitationNumber": f"SOL-{state}",
                    "type": "Solicitation",
                    "postedDate": "2026-07-01",
                    "responseDeadLine": "2026-08-15T17:00:00-04:00",
                    "naicsCode": "332311",
                    "department": "GENERAL SERVICES ADMINISTRATION",
                    "subTier": "PUBLIC BUILDINGS SERVICE",
                    "placeOfPerformance": {
                        "state": {"code": state, "name": "Connecticut"},
                        "city": {"name": "Hartford"},
                    },
                    "pointOfContact": [
                        {
                            "fullName": "Pat Buyer",
                            "email": "pat@example.gov",
                            "phone": "555-0100",
                        }
                    ],
                    "uiLink": f"https://sam.gov/opp/notice-{state}/view",
                }
            ],
        }

    result, warnings = fetch_sam_state(
        "CT",
        "not-a-real-key",
        fake_fetch,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert warnings == []
    assert result is not None
    assert result.source_id == sam_source_id("CT")
    assert len(result.projects) == 1
    assert result.projects[0]["participants"][0]["email"] == "pat@example.gov"
    assert result.projects[0]["sourceUrl"].startswith("https://sam.gov/")


def test_sam_http_client_retries_429_after_global_backoff(monkeypatch) -> None:
    calls = 0
    deferred: list[float] = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def geturl(self) -> str:
            return "https://api.sam.gov/opportunities/v2/search"

        def read(self, limit: int) -> bytes:
            del limit
            return json.dumps({"totalRecords": 0, "opportunitiesData": []}).encode()

    def urlopen(request, *, timeout):
        nonlocal calls
        del timeout
        calls += 1
        if calls == 1:
            raise HTTPError(
                request.full_url,
                429,
                "Too Many Requests",
                {"Retry-After": "0"},
                BytesIO(),
            )
        return Response()

    monkeypatch.setattr(northeast, "urlopen", urlopen)
    monkeypatch.setattr(northeast, "_wait_for_sam_request_slot", lambda: None)
    monkeypatch.setattr(northeast, "_defer_sam_requests", deferred.append)

    result = northeast.fetch_sam_json(
        "https://api.sam.gov/opportunities/v2/search?api_key=not-real"
    )

    assert result["opportunitiesData"] == []
    assert calls == 2
    assert deferred == [2.0]


def test_sam_state_connector_follows_documented_pagination() -> None:
    offsets: list[int] = []

    def fake_fetch(url: str) -> dict:
        query = parse_qs(urlparse(url).query)
        offset = int(query["offset"][0])
        offsets.append(offset)
        return {
            "totalRecords": 1001,
            "opportunitiesData": [
                {
                    "noticeId": f"{query['title'][0]}-{offset}",
                    "title": "Architectural metal canopy replacement",
                    "solicitationNumber": f"SOL-{offset}",
                    "type": "Solicitation",
                    "postedDate": "2026-07-01",
                    "responseDeadLine": "2026-08-15T17:00:00-04:00",
                    "placeOfPerformance": {"state": {"code": "CT"}},
                    "pointOfContact": [{"email": "pat@example.gov"}],
                    "uiLink": f"https://sam.gov/opp/{offset}/view",
                }
            ],
        }

    result, warnings = fetch_sam_state(
        "CT",
        "key",
        fake_fetch,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert warnings == []
    assert result is not None
    assert len(result.projects) == 14
    assert offsets.count(0) == 7
    assert offsets.count(1000) == 7


def test_regional_merge_marks_connected_federal_partition_as_partial() -> None:
    sam_result, _ = fetch_sam_state(
        "CT",
        "key",
        lambda url: {"totalRecords": 0, "opportunitiesData": []},
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )
    assert sam_result is not None
    snapshot = {
        "generatedAt": "2026-07-21T00:00:00Z",
        "projects": [],
        "sources": [],
        "warnings": [],
        "coverage": {
            "states": [
                {
                    "code": "CT",
                    "loadedProjects": 0,
                    "procurement": "identified",
                    "dotBidding": "identified",
                }
            ]
        },
        "inventory": {},
    }

    refreshed = merge_source_snapshot(
        snapshot,
        [sam_result],
        configured_source_ids={sam_source_id("CT")},
        source_coverage=northeast_source_coverage(True),
        refreshed_at="2026-07-22T12:00:00Z",
    )
    assert refreshed["coverage"]["states"][0]["federalProcurement"] == "partial"
