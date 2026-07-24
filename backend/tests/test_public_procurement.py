from __future__ import annotations

from datetime import date, datetime, timezone
from urllib.parse import parse_qs, urlparse

from backend.app.services.public_procurement import (
    DC_PASS_SOURCE_ID,
    NYC_CROL_SOURCE_ID,
    fetch_dc_pass_projects,
    fetch_nyc_crol_projects,
)


def _epoch(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1000)


def test_dc_pass_connector_paginates_and_keeps_published_contacts() -> None:
    offsets: list[int] = []

    def fake_fetch(url: str) -> dict:
        parsed = urlparse(url)
        assert parsed.hostname == "maps2.dcgis.dc.gov"
        query = parse_qs(parsed.query)
        offsets.append(int(query["resultOffset"][0]))
        if offsets[-1] == 0:
            return {
                "features": [
                    {
                        "attributes": {
                            "SOLICITATIONNUMBER": "DC-100",
                            "SOLICITATIONTITLE": "Demountable partition wall renovation",
                            "SYNOPSIS": "Replace interior office partitions.",
                            "AGENCY_NAME": "Department of General Services",
                            "EVENTDISPLAYSTATUS": "OPEN",
                            "ISSUANCEDATE": _epoch("2026-07-20"),
                            "CLOSEDATE": _epoch("2026-08-15"),
                            "CONTRACTINGOFFICER": "Pat Buyer",
                            "COEMAILADDRESS": "pat.buyer@dc.gov",
                            "PHONE": "202-555-0100",
                        }
                    }
                ],
                "exceededTransferLimit": True,
            }
        return {
            "features": [
                {
                    "attributes": {
                        "SOLICITATIONNUMBER": "DC-101",
                        "SOLICITATIONTITLE": "Courtyard pergola installation",
                        "AGENCY_NAME": "Department of Parks and Recreation",
                        "EVENTDISPLAYSTATUS": "OPEN",
                        "CLOSEDATE": _epoch("2026-08-20"),
                        "CONTRACTINGOFFICER": "Alex Buyer",
                        "COEMAILADDRESS": "alex.buyer@dc.gov",
                    }
                }
            ],
            "exceededTransferLimit": False,
        }

    result, warnings = fetch_dc_pass_projects(
        fake_fetch,
        today=date(2026, 7, 23),
        fetched_at="2026-07-23T12:00:00Z",
    )

    assert warnings == []
    assert result.source_id == DC_PASS_SOURCE_ID
    assert offsets == [0, 1000]
    assert [project["sourceRecordId"] for project in result.projects] == [
        "DC-100",
        "DC-101",
    ]
    assert result.projects[0]["participants"][0]["email"] == "pat.buyer@dc.gov"
    assert result.projects[0]["sourceUrl"].startswith(
        "https://maps2.dcgis.dc.gov/"
    )


def test_nyc_crol_connector_keeps_open_product_solicitations_and_contacts() -> None:
    visited_urls: list[str] = []

    def fake_fetch(url: str) -> list[dict]:
        visited_urls.append(url)
        parsed = urlparse(url)
        assert parsed.hostname == "data.cityofnewyork.us"
        query = parse_qs(parsed.query)
        assert "section_name = 'Procurement'" in query["$where"][0]
        assert query["$offset"] == ["0"]
        return [
            {
                "request_id": "2200456",
                "start_date": "2026-07-20T00:00:00.000",
                "due_date": "2026-08-20T00:00:00.000",
                "agency_name": "Department of Parks and Recreation",
                "type_of_notice_description": "Solicitation",
                "category_description": "Construction",
                "short_title": "Courtyard pergola replacement",
                "additional_description_1": (
                    "Remove and replace the existing timber pergola."
                ),
                "contact_name": "Jordan Buyer",
                "contact_phone": "212-555-0130",
                "email": "jordan.buyer@parks.nyc.gov",
                "pin": "PARKS-2026-100",
            }
        ]

    result, warnings = fetch_nyc_crol_projects(
        fake_fetch,
        today=date(2026, 7, 23),
        fetched_at="2026-07-23T12:00:00Z",
    )

    assert warnings == []
    assert len(visited_urls) == 1
    assert result.source_id == NYC_CROL_SOURCE_ID
    assert result.projects[0]["sourceRecordId"] == "2200456"
    assert result.projects[0]["participants"][0]["email"] == (
        "jordan.buyer@parks.nyc.gov"
    )
    assert result.projects[0]["bidDate"] == "2026-08-20"
