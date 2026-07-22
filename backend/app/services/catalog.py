from __future__ import annotations

import csv
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


ARCHIVED_STAGES = {"completed", "cancelled"}
OPEN_STAGES = {"planning", "design", "permitting", "bidding", "bid-opened", "awarded", "construction"}
ALLOWED_PAGE_SIZES = {10, 25, 50}


@dataclass(frozen=True)
class SearchFilters:
    keywords: str = ""
    location: str = ""
    match: str = "all"
    stage: str = "all"
    state: str = "all"
    due: str = "all"
    freshness: str = "all"
    readiness: str = "all"
    include_archived: bool = False
    page: int = 1
    limit: int = 10


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _repair_text(value: Any) -> Any:
    """Repair the double-encoded punctuation present in the legacy export."""

    if isinstance(value, str) and any(marker in value for marker in ("Ã", "Â", "â")):
        repaired = value
        for _ in range(2):
            try:
                candidate = repaired.encode("latin-1").decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                break
            if candidate == repaired:
                break
            repaired = candidate
        return repaired
    if isinstance(value, list):
        return [_repair_text(item) for item in value]
    if isinstance(value, dict):
        return {key: _repair_text(item) for key, item in value.items()}
    return value


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        try:
            parsed = datetime.fromisoformat(f"{normalized}T23:59:59+00:00")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_keywords(value: str) -> list[str]:
    if not value.strip():
        return []
    try:
        parts = next(csv.reader([value], skipinitialspace=True))
    except (csv.Error, StopIteration):
        parts = value.split(",")
    return [part.strip().strip('"').casefold() for part in parts if part.strip().strip('"')]


def _project_text(project: dict[str, Any]) -> str:
    searchable = project.get("searchableFields", [])
    if not isinstance(searchable, list):
        searchable = [searchable]
    fields: Iterable[Any] = (
        project.get("id"),
        project.get("title"),
        project.get("summary"),
        project.get("agency"),
        project.get("address"),
        project.get("city"),
        project.get("county"),
        project.get("state"),
        project.get("postalCode"),
        project.get("sourceName"),
        *searchable,
    )
    return " ".join(str(field) for field in fields if field).casefold()


class ProjectCatalog:
    """In-memory, immutable view of the exported public-source snapshot."""

    def __init__(self, data_directory: Path) -> None:
        snapshot = _repair_text(_load_json(data_directory / "current-projects.json"))
        registry = _repair_text(_load_json(data_directory / "source-registry.json"))
        self._initialize(snapshot, registry)

    @classmethod
    def from_snapshot(
        cls,
        snapshot: dict[str, Any],
        registry: dict[str, Any],
    ) -> "ProjectCatalog":
        catalog = cls.__new__(cls)
        catalog._initialize(_repair_text(snapshot), _repair_text(registry))
        return catalog

    def _initialize(self, snapshot: dict[str, Any], registry: dict[str, Any]) -> None:
        self.generated_at: str = snapshot["generatedAt"]
        self.projects: list[dict[str, Any]] = snapshot.get("projects", [])
        self.sources: list[dict[str, Any]] = snapshot.get("sources", [])
        self.coverage: dict[str, Any] = snapshot.get("coverage", {})
        self.inventory: dict[str, Any] = snapshot.get("inventory", {})
        self.warnings: list[str] = snapshot.get("warnings", [])
        self.source_registry: dict[str, Any] = registry
        self._projects_by_id = {project["id"]: project for project in self.projects}
        self._state_codes = {
            state.get("name", "").casefold(): state.get("code", "")
            for state in self.coverage.get("states", [])
            if isinstance(state, dict)
        }

    def dashboard(self) -> dict[str, Any]:
        return {
            "generatedAt": self.generated_at,
            "projects": self.projects[:10],
            "sources": self.sources,
            "coverage": self.coverage,
            "inventory": self.inventory,
            "warnings": self.warnings,
        }

    def project(self, project_id: str) -> dict[str, Any] | None:
        return self._projects_by_id.get(project_id)

    def search(self, filters: SearchFilters) -> dict[str, Any]:
        page_size = filters.limit if filters.limit in ALLOWED_PAGE_SIZES else 10
        page = max(filters.page, 1)
        keywords = _parse_keywords(filters.keywords)
        location = filters.location.strip().casefold()
        requested_state = filters.state.strip().casefold()
        now = datetime.now(timezone.utc)

        matches: list[dict[str, Any]] = []
        for project in self.projects:
            if not self._matches_project(
                project,
                filters,
                keywords=keywords,
                location=location,
                requested_state=requested_state,
                now=now,
            ):
                continue
            matches.append(project)

        if filters.readiness == "bid-ready":
            matches.sort(key=lambda item: (_parse_datetime(item.get("bidDate")) or datetime.max.replace(tzinfo=timezone.utc), item.get("title", "")))
        else:
            matches.sort(key=lambda item: _parse_datetime(item.get("updatedAt")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

        total = len(matches)
        total_pages = max(1, math.ceil(total / page_size))
        page = min(page, total_pages)
        start = (page - 1) * page_size
        returned = matches[start : start + page_size]
        return {
            "projects": returned,
            "meta": {
                "matchedProjects": total,
                "returnedProjects": len(returned),
                "page": page,
                "pageSize": page_size,
                "totalPages": total_pages,
                "snapshotGeneratedAt": self.generated_at,
                "sourceMode": "aws-snapshot",
                "nationallyComplete": bool(self.coverage.get("nationallyComplete", False)),
                "warnings": self.warnings,
            },
        }

    def _matches_project(
        self,
        project: dict[str, Any],
        filters: SearchFilters,
        *,
        keywords: list[str],
        location: str,
        requested_state: str,
        now: datetime,
    ) -> bool:
        stage = str(project.get("stage", "unclassified"))
        if filters.stage != "all" and stage != filters.stage:
            return False
        if not filters.include_archived and stage in ARCHIVED_STAGES:
            return False

        if requested_state and requested_state != "all":
            project_state = str(project.get("state", "")).casefold()
            project_code = self._state_codes.get(project_state, project_state)
            if requested_state not in {project_state, str(project_code).casefold()}:
                return False

        searchable = _project_text(project)
        if location and location not in searchable:
            return False
        if keywords:
            term_matches = [term in searchable for term in keywords]
            if filters.match == "any" and not any(term_matches):
                return False
            if filters.match == "exact" and " ".join(keywords) not in searchable:
                return False
            if filters.match not in {"any", "exact"} and not all(term_matches):
                return False

        deadline = _parse_datetime(project.get("bidDate"))
        if filters.readiness == "bid-ready":
            if stage != "bidding" or deadline is None or deadline < now:
                return False
            if not project.get("documents"):
                return False

        if filters.due != "all":
            if deadline is None or deadline < now:
                return False
            due_days = {"today": 1, "7-days": 7, "14-days": 14}.get(filters.due)
            if due_days is not None and deadline > now + timedelta(days=due_days):
                return False

        if filters.freshness == "actionable" and stage not in OPEN_STAGES:
            return False
        if filters.freshness in {"closed", "closed-or-inactive"} and stage not in ARCHIVED_STAGES:
            return False
        if filters.freshness == "inactive" and stage != "cancelled":
            return False
        return True

    def companies(self, query: str = "", page: int = 1, limit: int = 25) -> dict[str, Any]:
        aggregate: dict[tuple[str, str], dict[str, Any]] = {}
        for project in self.projects:
            for participant in project.get("participants", []):
                name = str(participant.get("organization") or participant.get("name") or "").strip()
                role = str(participant.get("role") or "unknown").strip()
                if not name or role == "agency":
                    continue
                key = (name.casefold(), role.casefold())
                company = aggregate.setdefault(
                    key,
                    {"name": name, "role": role, "projectCount": 0, "states": set(), "projects": []},
                )
                company["projectCount"] += 1
                if project.get("state"):
                    company["states"].add(project["state"])
                if len(company["projects"]) < 3:
                    company["projects"].append({"id": project["id"], "title": project["title"]})

        normalized_query = query.strip().casefold()
        companies = [
            {**company, "states": sorted(company["states"])}
            for company in aggregate.values()
            if not normalized_query or normalized_query in company["name"].casefold()
        ]
        companies.sort(key=lambda item: (-item["projectCount"], item["name"]))
        return self._page(companies, page, limit, "companies")

    def documents(self, query: str = "", project_id: str = "", page: int = 1, limit: int = 25) -> dict[str, Any]:
        normalized_query = query.strip().casefold()
        documents: list[dict[str, Any]] = []
        for project in self.projects:
            if project_id and project["id"] != project_id:
                continue
            for index, document in enumerate(project.get("documents", [])):
                searchable = f"{document.get('name', '')} {document.get('kind', '')} {project.get('title', '')}".casefold()
                if normalized_query and normalized_query not in searchable:
                    continue
                documents.append(
                    {
                        "id": f"{project['id']}:{index}",
                        "projectId": project["id"],
                        "projectTitle": project["title"],
                        **document,
                    }
                )
        return self._page(documents, page, limit, "documents")

    @staticmethod
    def _page(items: list[dict[str, Any]], page: int, limit: int, key: str) -> dict[str, Any]:
        page_size = limit if limit in ALLOWED_PAGE_SIZES else 25
        total_pages = max(1, math.ceil(len(items) / page_size))
        active_page = min(max(page, 1), total_pages)
        start = (active_page - 1) * page_size
        return {
            key: items[start : start + page_size],
            "meta": {
                "total": len(items),
                "page": active_page,
                "pageSize": page_size,
                "totalPages": total_pages,
            },
        }


class JurisdictionCatalog:
    """Small AWS-friendly fallback built from the checked-in Census place list."""

    STATE_HEADING = re.compile(r"^\d+\. ([A-Z][A-Z ]+) \((?:[\d,]+) places\)$")
    PLACE_LINE = re.compile(r"^\s*\d+\.\s+(.+?)\s*$")

    def __init__(self, source_file: Path) -> None:
        self.rows: list[dict[str, str]] = []
        current_state = ""
        for line in source_file.read_text(encoding="utf-8").splitlines():
            heading = self.STATE_HEADING.match(line)
            if heading:
                current_state = heading.group(1).title()
                continue
            place = self.PLACE_LINE.match(line)
            if place and current_state:
                self.rows.append(
                    {
                        "id": f"{current_state}:{place.group(1)}",
                        "name": place.group(1),
                        "state": current_state,
                        "kind": "incorporated-place",
                        "connectionStatus": "not-connected",
                    }
                )

    def search(self, query: str = "", state: str = "", page: int = 1, limit: int = 25) -> dict[str, Any]:
        normalized_query = query.strip().casefold()
        normalized_state = state.strip().casefold()
        rows = [
            row
            for row in self.rows
            if (not normalized_query or normalized_query in row["name"].casefold())
            and (not normalized_state or normalized_state == "all" or normalized_state in row["state"].casefold())
        ]
        result = ProjectCatalog._page(rows, page, limit, "jurisdictions")
        result["meta"]["registryScope"] = "2025-incorporated-place-fallback"
        return result
