from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import urlencode

from .geography import US_STATES_AND_DC
from .northeast import (
    SAM_API_URL,
    SAM_MAX_PAGES_PER_QUERY,
    SAM_PAGE_LIMIT,
    SAM_QUERIES,
    _nested_name,
    _normalize_sam_project,
    configured_source_ids as configured_regional_source_ids,
    fetch_northeast_sources,
    fetch_official_html,
    fetch_sam_json,
    northeast_source_coverage,
    northeast_warning_prefixes,
    sam_source_id,
)
from .public_procurement import (
    DC_PASS_SOURCE_ID,
    NYC_CROL_SOURCE_ID,
    fetch_dc_pass_projects,
    fetch_nyc_crol_projects,
    fetch_nyc_open_data_json,
    fetch_open_data_json,
)
from .source_refresh import SourceRefreshResult, SourceResult


def configured_source_ids(sam_enabled: bool) -> set[str]:
    source_ids = configured_regional_source_ids(False)
    source_ids.add(DC_PASS_SOURCE_ID)
    source_ids.add(NYC_CROL_SOURCE_ID)
    if sam_enabled:
        source_ids.update(sam_source_id(state) for state in US_STATES_AND_DC)
    return source_ids


def national_source_coverage(
    sam_enabled: bool,
) -> dict[str, tuple[tuple[str, ...], str]]:
    coverage = northeast_source_coverage(False)
    coverage[DC_PASS_SOURCE_ID] = (("DC",), "procurement")
    coverage[NYC_CROL_SOURCE_ID] = (("NY",), "procurement")
    if sam_enabled:
        coverage.update(
            {
                sam_source_id(state): ((state,), "federalProcurement")
                for state in US_STATES_AND_DC
            }
        )
    return coverage


def national_warning_prefixes() -> tuple[str, ...]:
    return (
        *northeast_warning_prefixes(),
        "District of Columbia PASS solicitations:",
        "New York City Record solicitations:",
    )


def fetch_nationwide_sam_partitions(
    api_key: str,
    fetch_json: Callable[[str], dict[str, Any]] = fetch_sam_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[list[SourceRefreshResult], list[str]]:
    """Query each keyword once, then partition the results by state locally."""

    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    records: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    failed_queries = 0
    complete = True

    for query in SAM_QUERIES:
        try:
            for page_index in range(SAM_MAX_PAGES_PER_QUERY):
                params: list[tuple[str, str]] = [
                    ("api_key", api_key),
                    ("postedFrom", (current_date - timedelta(days=364)).strftime("%m/%d/%Y")),
                    ("postedTo", current_date.strftime("%m/%d/%Y")),
                    ("limit", str(SAM_PAGE_LIMIT)),
                    ("offset", str(page_index * SAM_PAGE_LIMIT)),
                    ("status", "active"),
                    ("title", query),
                ]
                params.extend(("ptype", item) for item in ("p", "o", "k", "r"))
                payload = fetch_json(f"{SAM_API_URL}?{urlencode(params)}")
                page_records = payload.get("opportunitiesData")
                if not isinstance(page_records, list):
                    raise ValueError("response did not contain an opportunitiesData list")
                for record in page_records:
                    if isinstance(record, dict) and record.get("noticeId"):
                        records.setdefault(str(record["noticeId"]), record)
                total_records = int(payload.get("totalRecords") or 0)
                if (page_index + 1) * SAM_PAGE_LIMIT >= total_records:
                    break
            else:
                complete = False
                warnings.append(
                    f"SAM.gov national: {query!r} exceeded the guarded "
                    f"{SAM_MAX_PAGES_PER_QUERY}-page limit"
                )
        except Exception as error:
            failed_queries += 1
            warnings.append(f"SAM.gov national: {query!r} query failed: {error}")

    # Treat the keyword batch transactionally. A provider failure retains
    # every prior state partition instead of replacing them with partial data.
    if failed_queries:
        warnings.append(
            "SAM.gov national: one or more keyword queries failed; retained all prior state partitions"
        )
        return [], warnings

    projects_by_state: dict[str, list[dict[str, Any]]] = {
        state: [] for state in US_STATES_AND_DC
    }
    for record in records.values():
        place = record.get("placeOfPerformance")
        if not isinstance(place, dict):
            continue
        state = _nested_name(place.get("state"), prefer_code=True).upper()
        if state not in projects_by_state:
            continue
        project = _normalize_sam_project(record, state, checked_at)
        if project is None:
            continue
        if project.get("bidDate") and str(project["bidDate"]) < current_date.isoformat():
            continue
        projects_by_state[state].append(project)

    results: list[SourceRefreshResult] = []
    for state in US_STATES_AND_DC:
        projects = projects_by_state[state]
        projects.sort(
            key=lambda project: str(project.get("bidDate") or "9999-12-31")
        )
        results.append(
            SourceRefreshResult(
                sam_source_id(state),
                projects,
                {
                    "id": sam_source_id(state),
                    "name": f"SAM.gov Product Opportunities - {state}",
                    "owner": "U.S. General Services Administration",
                    "level": "federal",
                    "sourceClass": "procurement",
                    "stages": ["bidding"],
                    "status": "live",
                    "access": "api-key",
                    "cadence": "Daily",
                    "recordCount": len(projects),
                    "recordCountUnit": "qualified projects",
                    "loadedCount": len(projects),
                    "snapshotComplete": complete,
                    "lastChecked": checked_at,
                    "url": "https://sam.gov/search/?index=opp",
                    "jurisdiction": state,
                    "stateCode": state,
                    "coverageField": "federalProcurement",
                    "note": (
                        "Official SAM.gov active opportunities grouped by place of performance "
                        "after rate-efficient national canopy, pergola, and partition-wall "
                        "keyword queries. This is federal, not statewide procurement coverage."
                    ),
                },
            )
        )
    return results, warnings


def fetch_national_sources(
    *,
    sam_api_key: str = "",
    fetch_html: Callable[[str], str] = fetch_official_html,
    fetch_json: Callable[[str], dict[str, Any]] = fetch_sam_json,
    fetch_open_json: Callable[[str], dict[str, Any]] = fetch_open_data_json,
    fetch_nyc_json: Callable[
        [str], list[dict[str, Any]]
    ] = fetch_nyc_open_data_json,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[list[SourceResult], list[str]]:
    """Refresh regional portals plus independent SAM partitions nationwide."""

    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    results, warnings = fetch_northeast_sources(
        sam_api_key="",
        fetch_html=fetch_html,
        fetch_json=fetch_json,
        today=today,
        fetched_at=checked_at,
    )

    try:
        dc_result, dc_warnings = fetch_dc_pass_projects(
            fetch_open_json,
            today=today,
            fetched_at=checked_at,
        )
        results.append(dc_result)
        warnings.extend(
            f"District of Columbia PASS solicitations: {warning}"
            for warning in dc_warnings
        )
    except Exception as error:
        warnings.append(f"District of Columbia PASS solicitations: {error}")

    try:
        nyc_result, nyc_warnings = fetch_nyc_crol_projects(
            fetch_nyc_json,
            today=today,
            fetched_at=checked_at,
        )
        results.append(nyc_result)
        warnings.extend(
            f"New York City Record solicitations: {warning}"
            for warning in nyc_warnings
        )
    except Exception as error:
        warnings.append(f"New York City Record solicitations: {error}")

    if not sam_api_key:
        return results, warnings

    sam_results, sam_warnings = fetch_nationwide_sam_partitions(
        sam_api_key,
        fetch_json,
        today=today,
        fetched_at=checked_at,
    )
    results.extend(sam_results)
    warnings.extend(sam_warnings)
    return results, warnings
