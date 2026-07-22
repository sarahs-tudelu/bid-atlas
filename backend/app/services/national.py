from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from typing import Any, Callable

from .geography import US_STATES_AND_DC
from .northeast import (
    configured_source_ids as configured_regional_source_ids,
    fetch_northeast_sources,
    fetch_official_html,
    fetch_sam_json,
    fetch_sam_state,
    northeast_source_coverage,
    northeast_warning_prefixes,
    sam_source_id,
)
from .source_refresh import SourceResult


SAM_STATE_WORKERS = 6


def configured_source_ids(sam_enabled: bool) -> set[str]:
    source_ids = configured_regional_source_ids(False)
    if sam_enabled:
        source_ids.update(sam_source_id(state) for state in US_STATES_AND_DC)
    return source_ids


def national_source_coverage(
    sam_enabled: bool,
) -> dict[str, tuple[tuple[str, ...], str]]:
    coverage = northeast_source_coverage(False)
    if sam_enabled:
        coverage.update(
            {
                sam_source_id(state): ((state,), "federalProcurement")
                for state in US_STATES_AND_DC
            }
        )
    return coverage


def national_warning_prefixes() -> tuple[str, ...]:
    return northeast_warning_prefixes()


def fetch_national_sources(
    *,
    sam_api_key: str = "",
    fetch_html: Callable[[str], str] = fetch_official_html,
    fetch_json: Callable[[str], dict[str, Any]] = fetch_sam_json,
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
    if not sam_api_key:
        return results, warnings

    with ThreadPoolExecutor(max_workers=SAM_STATE_WORKERS) as executor:
        futures = {
            executor.submit(
                fetch_sam_state,
                state,
                sam_api_key,
                fetch_json,
                today=today,
                fetched_at=checked_at,
            ): state
            for state in US_STATES_AND_DC
        }
        for future in as_completed(futures):
            state = futures[future]
            try:
                state_result, state_warnings = future.result()
            except Exception as error:
                warnings.append(f"SAM.gov {state}: state refresh failed: {error}")
                continue
            if state_result:
                results.append(state_result)
            warnings.extend(state_warnings)
    return results, warnings
