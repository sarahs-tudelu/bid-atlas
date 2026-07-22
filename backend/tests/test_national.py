from __future__ import annotations

from datetime import date

from backend.app.services.geography import (
    US_STATES_AND_DC,
    US_STATE_NAMES_BY_CODE,
)
from backend.app.services import national
from backend.app.services.national import national_source_coverage
from backend.app.services.northeast import sam_source_id
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


def test_national_fetch_isolates_all_federal_state_partitions(monkeypatch) -> None:
    visited: list[str] = []

    monkeypatch.setattr(
        national,
        "fetch_northeast_sources",
        lambda **kwargs: ([], []),
    )

    def fetch_state(state, api_key, fetch_json, *, today, fetched_at):
        del api_key, fetch_json, today
        visited.append(state)
        return _sam_result(state, fetched_at), []

    monkeypatch.setattr(national, "fetch_sam_state", fetch_state)
    results, warnings = national.fetch_national_sources(
        sam_api_key="configured",
        today=date(2026, 7, 22),
        fetched_at="2026-07-22T12:00:00Z",
    )

    assert warnings == []
    assert set(visited) == set(US_STATES_AND_DC)
    assert {result.source_id for result in results} == {
        sam_source_id(state) for state in US_STATES_AND_DC
    }


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
