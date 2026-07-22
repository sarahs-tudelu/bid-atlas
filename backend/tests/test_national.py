from __future__ import annotations

from datetime import date
from urllib.parse import parse_qs, urlparse

from backend.app.services.geography import (
    US_STATES_AND_DC,
    US_STATE_NAMES_BY_CODE,
)
from backend.app.services import national
from backend.app.services.national import national_source_coverage
from backend.app.services.northeast import SAM_QUERIES, sam_source_id
from backend.app.services.source_refresh import SourceRefreshResult, merge_source_snapshot


def _sam_result(state: str, checked_at: str) -> SourceRefreshResult:
    source_id = sam_source_id(state)
    return SourceRefreshResult(
        source_id,
        [],
        {
            "id": source_id,
            "name": f"SAM.gov Canopy Opportunities - {state}",
            "status": "live",
            "lastChecked": checked_at,
            "stateCode": state,
            "coverageField": "federalProcurement",
        },
    )


def test_national_partition_list_contains_every_state_and_dc_once() -> None:
    assert len(US_STATES_AND_DC) == 51
    assert len(set(US_STATES_AND_DC)) == 51
    assert set(US_STATES_AND_DC) == set(US_STATE_NAMES_BY_CODE)
    assert "DC" in US_STATES_AND_DC


def test_national_coverage_maps_one_federal_partition_per_state() -> None:
    coverage = national_source_coverage(True)

    for state in US_STATES_AND_DC:
        assert coverage[sam_source_id(state)] == ((state,), "federalProcurement")


def test_national_fetch_queries_once_then_isolates_all_state_partitions(monkeypatch) -> None:
    visited_queries: list[str] = []

    monkeypatch.setattr(
        national,
        "fetch_northeast_sources",
        lambda **kwargs: ([], []),
    )

    def fetch_json(url: str) -> dict:
        query = parse_qs(urlparse(url).query)
        assert "state" not in query
        keyword = query["title"][0]
        visited_queries.append(keyword)
        return {
            "totalRecords": 51,
            "opportunitiesData": [
                {
                    "noticeId": f"{keyword}-{state}",
                    "title": f"Architectural canopy replacement {keyword}",
                    "solicitationNumber": f"SOL-{keyword}-{state}",
                    "responseDeadLine": "2026-08-15T17:00:00-04:00",
                    "placeOfPerformance": {"state": {"code": state}},
                    "pointOfContact": [{"email": f"buyer-{state.lower()}@example.gov"}],
                }
                for state in US_STATES_AND_DC
            ],
        }

    results, warnings = national.fetch_national_sources(
        sam_api_key="configured",
        fetch_json=fetch_json,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert warnings == []
    assert set(visited_queries) == set(SAM_QUERIES)
    assert len(visited_queries) == len(SAM_QUERIES)
    assert {result.source_id for result in results} == {
        sam_source_id(state) for state in US_STATES_AND_DC
    }


def test_national_sam_batch_retains_all_partitions_when_one_query_fails(monkeypatch) -> None:
    monkeypatch.setattr(national, "fetch_northeast_sources", lambda **kwargs: ([], []))

    def fetch_json(url: str) -> dict:
        query = parse_qs(urlparse(url).query)["title"][0]
        if query == "awning":
            raise RuntimeError("SAM.gov request returned HTTP 429")
        return {"totalRecords": 0, "opportunitiesData": []}

    results, warnings = national.fetch_national_sources(
        sam_api_key="configured",
        fetch_json=fetch_json,
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert results == []
    assert any("retained all prior state partitions" in warning for warning in warnings)


def test_national_merge_reports_all_federal_partitions_independently() -> None:
    checked_at = "2026-07-22T12:00:00Z"
    snapshot = {
        "generatedAt": "2026-07-21T00:00:00Z",
        "projects": [],
        "sources": [],
        "warnings": [],
        "coverage": {
            "states": [
                {
                    "code": code,
                    "name": US_STATE_NAMES_BY_CODE[code],
                    "loadedProjects": 0,
                    "procurement": "identified",
                    "dotBidding": "identified",
                }
                for code in US_STATES_AND_DC
            ]
        },
        "inventory": {},
    }
    results = [_sam_result(state, checked_at) for state in US_STATES_AND_DC]

    refreshed = merge_source_snapshot(
        snapshot,
        results,
        configured_source_ids={result.source_id for result in results},
        source_coverage=national_source_coverage(True),
        refreshed_at=checked_at,
    )

    assert refreshed["coverage"]["statesAndDistrict"] == 51
    assert refreshed["coverage"]["federalExpectedStates"] == 51
    assert refreshed["coverage"]["federalConnectedStates"] == 51
    assert refreshed["coverage"]["identifiedSourceGroups"] == 153
    assert all(
        state["federalProcurement"] == "partial"
        for state in refreshed["coverage"]["states"]
    )
