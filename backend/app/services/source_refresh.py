from __future__ import annotations

import copy
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Protocol

from .geography import STATE_CODE_BY_NAME


class SourceResult(Protocol):
    source_id: str
    projects: list[dict[str, Any]]
    source: dict[str, Any]


@dataclass(frozen=True)
class SourceRefreshResult:
    source_id: str
    projects: list[dict[str, Any]]
    source: dict[str, Any]


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _project_state(project: dict[str, Any]) -> str | None:
    state = str(project.get("state") or "").strip().upper()
    return STATE_CODE_BY_NAME.get(state, state or None)


def _project_timestamp(project: dict[str, Any]) -> float:
    raw = project.get("bidDate") or project.get("postedAt") or project.get("updatedAt")
    if not isinstance(raw, str):
        return 0
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def refresh_aggregates(
    snapshot: dict[str, Any],
    refreshed_at: str,
    source_coverage: dict[str, tuple[tuple[str, ...], str]],
) -> None:
    projects = snapshot.get("projects", [])
    sources = snapshot.get("sources", [])
    stage_counts = Counter(str(project.get("stage") or "unclassified") for project in projects)
    state_counts = Counter(state for project in projects if (state := _project_state(project)))
    source_counts = Counter(str(project.get("sourceId") or "") for project in projects)
    contractor_names = {
        _clean_text(str(participant.get("organization") or participant.get("name") or "")).casefold()
        for project in projects
        for participant in project.get("participants", [])
        if participant.get("role") in {"contractor", "bidder"}
        and (participant.get("organization") or participant.get("name"))
    }
    document_indexed = sum(bool(project.get("documentTextIndexed")) for project in projects)

    inventory = snapshot.setdefault("inventory", {})
    inventory.update(
        {
            "mode": "aws-snapshot",
            "totalProjects": len(projects),
            "stageCounts": dict(stage_counts),
            "stateCounts": dict(state_counts),
            "sourceCounts": dict(source_counts),
            "documentTextIndexedProjects": document_indexed,
            "contractorOrganizations": len(contractor_names),
            "refreshedAt": refreshed_at,
        }
    )

    coverage = snapshot.setdefault("coverage", {})
    coverage["asOf"] = refreshed_at
    coverage["loadedProjectRecords"] = len(projects)
    coverage["documentTextIndexedProjects"] = document_indexed
    coverage["connectedSourceGroups"] = sum(source.get("status") == "live" for source in sources)
    source_status = {str(source.get("id")): source.get("status") for source in sources}
    federal_configured_states: set[str] = set()
    for state in coverage.get("states", []):
        code = str(state.get("code") or "").upper()
        state["loadedProjects"] = state_counts.get(code, 0)
        fields = {
            field
            for source_id, (state_codes, field) in source_coverage.items()
            if code in state_codes and source_id
        }
        for field in fields:
            related_sources = [
                source_id
                for source_id, (state_codes, source_field) in source_coverage.items()
                if code in state_codes and source_field == field
            ]
            state[field] = (
                "partial"
                if any(source_status.get(source_id) == "live" for source_id in related_sources)
                else "identified"
            )
            if field == "federalProcurement":
                federal_configured_states.add(code)
        if code not in federal_configured_states:
            state["federalProcurement"] = "not-connected"

    state_rows = coverage.get("states", [])
    coverage["statesAndDistrict"] = len(state_rows)
    coverage["federalExpectedStates"] = len(federal_configured_states)
    coverage["federalConnectedStates"] = sum(
        state.get("federalProcurement") == "partial" for state in state_rows
    )
    coverage["identifiedSourceGroups"] = (
        len(state_rows) * 2 + len(federal_configured_states)
    )


def merge_source_snapshot(
    snapshot: dict[str, Any],
    results: Iterable[SourceResult],
    *,
    configured_source_ids: set[str],
    source_coverage: dict[str, tuple[tuple[str, ...], str]],
    warnings: list[str] | None = None,
    warning_prefixes: tuple[str, ...] = (),
    refreshed_at: str | None = None,
) -> dict[str, Any]:
    """Replace successful source partitions while retaining failed-source records."""

    updated = copy.deepcopy(snapshot)
    checked_at = refreshed_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    materialized_results = list(results)
    successful_ids = {result.source_id for result in materialized_results}

    existing_projects = [
        project for project in updated.get("projects", []) if project.get("sourceId") not in successful_ids
    ]
    incoming_projects = [project for result in materialized_results for project in result.projects]
    stage_rank = {
        "bidding": 0,
        "bid-opened": 1,
        "design": 2,
        "planning": 3,
        "permitting": 4,
        "awarded": 5,
        "construction": 6,
        "completed": 7,
        "cancelled": 8,
        "unclassified": 9,
    }
    updated["projects"] = sorted(
        [*existing_projects, *incoming_projects],
        key=lambda project: (
            stage_rank.get(str(project.get("stage")), 9),
            -_project_timestamp(project),
            str(project.get("id") or ""),
        ),
    )

    source_by_id = {source.get("id"): source for source in updated.get("sources", [])}
    for result in materialized_results:
        source_by_id[result.source_id] = result.source
    for source_id in configured_source_ids - successful_ids:
        existing_source = source_by_id.get(source_id)
        if existing_source:
            note = str(existing_source.get("note") or "").split(" Last refresh failed;")[0]
            source_by_id[source_id] = {
                **existing_source,
                "status": "degraded",
                "lastChecked": checked_at,
                "note": f"{note.rstrip()} Last refresh failed; retained records may be stale.".strip(),
            }
    updated["sources"] = list(source_by_id.values())
    updated["generatedAt"] = checked_at

    existing_warnings = [
        warning
        for warning in updated.get("warnings", [])
        if not str(warning).startswith(warning_prefixes)
    ]
    updated["warnings"] = [*existing_warnings, *(warnings or [])]
    refresh_aggregates(updated, checked_at, source_coverage)
    return updated
