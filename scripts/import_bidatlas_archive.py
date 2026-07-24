from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from backend.app.services.canopy import project_product_matches, score_project  # noqa: E402
from backend.app.services.catalog_provider import MAX_CATALOG_BYTES  # noqa: E402
from backend.app.services.qualification import (  # noqa: E402
    contact_research_status,
    is_product_project,
)


ARCHIVED_STAGES = {"cancelled", "completed"}
PROJECT_FIELDS = (
    "id",
    "sourceId",
    "sourceRecordId",
    "title",
    "summary",
    "stage",
    "status",
    "agency",
    "address",
    "city",
    "county",
    "state",
    "postalCode",
    "value",
    "postedAt",
    "bidDate",
    "bidDateTimeZone",
    "updatedAt",
    "sourceName",
    "sourceUrl",
    "provenance",
    "confidence",
    "naicsCode",
    "documentTextIndexed",
)
PARTICIPANT_FIELDS = (
    "name",
    "role",
    "participantType",
    "organization",
    "email",
    "phone",
)
PRIORITY_DOCUMENT_TERMS = (
    "addendum",
    "drawing",
    "proposal",
    "solicitation",
    "specification",
)
PRIORITY_DOCUMENT_KINDS = {
    "architectural-drawings",
    "bid-package",
    "construction-drawings",
    "drawing",
    "drawings",
    "eplans",
    "plan-set",
    "plans",
    "proposal",
    "solicitation",
    "specifications",
}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _timestamp(value: Any) -> datetime:
    text = str(value or "").strip().replace("Z", "+00:00")
    if not text:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _verify_page(page_path: Path) -> None:
    metadata_path = page_path.with_suffix("").with_suffix(".json")
    metadata = _read_json(metadata_path)
    expected = str(metadata.get("gzipSha256") or "").lower()
    if not expected:
        raise ValueError(f"{metadata_path} does not declare gzipSha256")
    with page_path.open("rb") as handle:
        actual = hashlib.file_digest(handle, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"Checksum mismatch for {page_path}")


def _complete_source_ids(manifest: dict[str, Any]) -> list[str]:
    completeness = manifest.get("sourceCompleteness")
    if not isinstance(completeness, dict):
        raise ValueError("The crawl manifest does not contain sourceCompleteness")
    sources = completeness.get("sources")
    if not isinstance(sources, list):
        raise ValueError("The crawl manifest does not contain source rows")
    return sorted(
        str(source["sourceId"])
        for source in sources
        if source.get("status") == "complete"
        and source.get("snapshotComplete") is True
    )


def _present(value: Any) -> bool:
    return value not in (None, "", [], {})


def _compact_participants(project: dict[str, Any]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    seen: set[str] = set()
    project_source_url = str(project.get("sourceUrl") or "")
    agency = str(project.get("agency") or "").strip().casefold()
    for participant in project.get("participants") or []:
        if not isinstance(participant, dict):
            continue
        normalized = {
            field: participant[field]
            for field in PARTICIPANT_FIELDS
            if _present(participant.get(field))
        }
        participant_source_url = str(participant.get("sourceUrl") or "")
        if participant_source_url and participant_source_url != project_source_url:
            normalized["sourceUrl"] = participant_source_url
        participant_name = str(
            normalized.get("organization") or normalized.get("name") or ""
        ).strip().casefold()
        if (
            participant_name == agency
            and not normalized.get("email")
            and not normalized.get("phone")
        ):
            continue
        if not normalized:
            continue
        signature = json.dumps(
            normalized,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        if signature in seen:
            continue
        seen.add(signature)
        compact.append(normalized)
    return compact


def _compact_documents(project: dict[str, Any]) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    stage = str(project.get("stage") or "")
    for document in project.get("documents") or []:
        if not isinstance(document, dict):
            continue
        searchable = f"{document.get('kind') or ''} {document.get('name') or ''}".casefold()
        kind = str(document.get("kind") or "").strip().casefold()
        is_priority = kind in PRIORITY_DOCUMENT_KINDS or any(
            term in searchable for term in PRIORITY_DOCUMENT_TERMS
        )
        if stage != "bidding" and not is_priority:
            continue
        compact = {
            field: value
            for field, value in document.items()
            if field in {"name", "kind", "url", "access", "indexStatus"}
            and _present(value)
        }
        if compact.get("url"):
            documents.append(compact)
    return documents


def _compact_project(
    project: dict[str, Any],
    fit: dict[str, Any],
) -> dict[str, Any]:
    compact = {
        field: project[field]
        for field in PROJECT_FIELDS
        if _present(project.get(field))
    }
    participants = _compact_participants(project)
    documents = _compact_documents(project)
    matches = project_product_matches(project)
    if participants:
        compact["participants"] = participants
    if documents:
        compact["documents"] = documents
    compact["canopyFit"] = fit
    compact["productMatches"] = [
        {
            "id": match["id"],
            "label": match["label"],
            "score": match["score"],
            "reasons": [],
        }
        for match in matches
    ]
    compact["productTypes"] = [match["id"] for match in matches]
    compact["contactStatus"] = contact_research_status(project)
    return compact


def _scan_page(
    page_path: Path,
    source_id: str,
    *,
    verify_checksum: bool,
) -> tuple[int, list[dict[str, Any]]]:
    if verify_checksum:
        _verify_page(page_path)
    scanned_rows = 0
    projects: list[dict[str, Any]] = []
    with gzip.open(page_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            scanned_rows += 1
            project = json.loads(line)
            if str(project.get("stage") or "") in ARCHIVED_STAGES:
                continue
            fit = score_project(project)
            if not is_product_project(project, fit):
                continue
            project_id = str(project.get("id") or "").strip()
            if not project_id:
                raise ValueError(f"{source_id} emitted a project without an ID")
            projects.append(_compact_project(project, fit))
    return scanned_rows, projects


def _scan_page_from_arguments(
    arguments: tuple[Path, str, bool],
) -> tuple[int, list[dict[str, Any]]]:
    page_path, source_id, verify_checksum = arguments
    return _scan_page(
        page_path,
        source_id,
        verify_checksum=verify_checksum,
    )


def qualifying_projects(
    archive_directory: Path,
    *,
    verify_checksums: bool = False,
    workers: int = 1,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    crawl_directory = archive_directory / "current-source-crawl"
    manifest = _read_json(crawl_directory / "manifest.json")
    package = _read_json(archive_directory / "PACKAGE-SUMMARY.json")
    if package.get("packageType") != "bidatlas-data-only":
        raise ValueError("The archive is not a BidAtlas data-only package")
    if package.get("containsSecrets") is not False:
        raise ValueError("The archive must explicitly declare that it contains no secrets")

    package_created_at = str(package.get("packageCreatedAt") or "")
    crawl_completed_at = str(
        manifest.get("completedAt")
        or manifest.get("finishedAt")
        or package.get("dataCapturedAt")
        or ""
    )
    scanned_rows = 0
    projects_by_id: dict[str, dict[str, Any]] = {}
    pages: list[tuple[Path, str]] = []

    for source_id in _complete_source_ids(manifest):
        source_directory = crawl_directory / "sources" / source_id
        source_manifest = _read_json(source_directory / "manifest.json")
        if (
            source_manifest.get("complete") is not True
            or source_manifest.get("status") != "complete"
        ):
            raise ValueError(f"{source_id} is not a complete current-scope snapshot")
        for page_path in sorted((source_directory / "pages").glob("*.ndjson.gz")):
            pages.append((page_path, source_id))

    def scan(page: tuple[Path, str]) -> tuple[int, list[dict[str, Any]]]:
        page_path, source_id = page
        return _scan_page(
            page_path,
            source_id,
            verify_checksum=verify_checksums,
        )

    if workers > 1:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
            page_results = executor.map(
                _scan_page_from_arguments,
                (
                    (
                        page_path,
                        source_id,
                        verify_checksums,
                    )
                    for page_path, source_id in pages
                ),
            )
            materialized_results = list(page_results)
    else:
        materialized_results = [scan(page) for page in pages]

    for page_scanned_rows, page_projects in materialized_results:
        scanned_rows += page_scanned_rows
        for imported in page_projects:
            project_id = str(imported["id"])
            existing = projects_by_id.get(project_id)
            if existing is None or _timestamp(imported.get("updatedAt")) >= _timestamp(
                existing.get("updatedAt")
            ):
                projects_by_id[project_id] = imported

    projects = sorted(
        projects_by_id.values(),
        key=lambda project: (
            _timestamp(project.get("bidDate")),
            str(project.get("id") or ""),
        ),
    )
    contact_status_counts = Counter(
        str(project.get("contactStatus") or "research-needed")
        for project in projects
    )
    source_counts = Counter(
        str(project.get("sourceId") or "unknown") for project in projects
    )
    field_bytes: Counter[str] = Counter()
    for project in projects:
        for field, value in project.items():
            field_bytes[field] += len(
                json.dumps(
                    value,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
    return projects, {
        "packageCreatedAt": package_created_at,
        "crawlCompletedAt": crawl_completed_at,
        "completeSources": len(_complete_source_ids(manifest)),
        "scannedRows": scanned_rows,
        "qualifiedProjects": len(projects),
        "publishedContactProjects": contact_status_counts["published-contact"],
        "researchNeededProjects": contact_status_counts["research-needed"],
        "qualifiedBySource": dict(sorted(source_counts.items())),
        "largestFieldBytes": dict(field_bytes.most_common(12)),
    }


def _aggregate_snapshot(snapshot: dict[str, Any], refreshed_at: str) -> None:
    projects = list(snapshot.get("projects") or [])
    stage_counts: Counter[str] = Counter()
    state_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    organizations: set[str] = set()
    document_text_indexed = 0
    for project in projects:
        stage_counts[str(project.get("stage") or "unclassified")] += 1
        state = str(project.get("state") or "").strip().upper()
        if len(state) == 2:
            state_counts[state] += 1
        source_counts[str(project.get("sourceId") or "unknown")] += 1
        document_text_indexed += int(bool(project.get("documentTextIndexed")))
        for participant in project.get("participants") or []:
            organization = str(participant.get("organization") or "").strip().lower()
            if organization:
                organizations.add(organization)

    snapshot["generatedAt"] = refreshed_at
    snapshot["inventory"] = {
        **(snapshot.get("inventory") or {}),
        "totalProjects": len(projects),
        "stageCounts": dict(stage_counts),
        "stateCounts": dict(state_counts),
        "sourceCounts": dict(source_counts),
        "documentTextIndexedProjects": document_text_indexed,
        "contractorOrganizations": len(organizations),
        "refreshedAt": refreshed_at,
    }
    coverage = {
        **(snapshot.get("coverage") or {}),
        "asOf": refreshed_at,
        "loadedProjectRecords": len(projects),
        "documentTextIndexedProjects": document_text_indexed,
    }
    coverage["states"] = [
        {
            **state,
            "loadedProjects": state_counts.get(
                str(state.get("code") or "").strip().upper(),
                0,
            ),
        }
        for state in coverage.get("states") or []
    ]
    snapshot["coverage"] = coverage


def merge_projects(
    snapshot: dict[str, Any],
    imported_projects: Iterable[dict[str, Any]],
    *,
    refreshed_at: str,
) -> dict[str, int]:
    projects: list[dict[str, Any]] = []
    index_by_id: dict[str, int] = {}
    deduplicated = 0
    for existing in snapshot.get("projects") or []:
        project_id = str(existing.get("id") or "")
        existing_index = index_by_id.get(project_id)
        if existing_index is None:
            index_by_id[project_id] = len(projects)
            projects.append(existing)
            continue
        deduplicated += 1
        if _timestamp(existing.get("updatedAt")) > _timestamp(
            projects[existing_index].get("updatedAt")
        ):
            projects[existing_index] = existing

    inserted = 0
    updated = 0
    retained = 0
    for imported in imported_projects:
        project_id = str(imported["id"])
        existing_index = index_by_id.get(project_id)
        if existing_index is None:
            index_by_id[project_id] = len(projects)
            projects.append(imported)
            inserted += 1
            continue
        existing = projects[existing_index]
        if _timestamp(imported.get("updatedAt")) > _timestamp(existing.get("updatedAt")):
            projects[existing_index] = imported
            updated += 1
        else:
            retained += 1
    snapshot["projects"] = projects
    _aggregate_snapshot(snapshot, refreshed_at)
    return {
        "inserted": inserted,
        "updated": updated,
        "retained": retained,
        "deduplicated": deduplicated,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Import qualifying current projects from a BidAtlas data-only archive.",
    )
    parser.add_argument(
        "archive",
        nargs="?",
        type=Path,
        default=REPOSITORY_ROOT / "BidAtlas-data-only",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=REPOSITORY_ROOT / "data-export" / "current-projects.json",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-checksums", action="store_true")
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Parallel archive pages to score (default: 1).",
    )
    args = parser.parse_args()

    imported, audit = qualifying_projects(
        args.archive.resolve(),
        verify_checksums=args.verify_checksums,
        workers=max(args.workers, 1),
    )
    snapshot = _read_json(args.target.resolve())
    refreshed_at = str(audit["packageCreatedAt"] or audit["crawlCompletedAt"])
    if not refreshed_at:
        raise ValueError("The archive does not contain a usable capture timestamp")
    merge = merge_projects(snapshot, imported, refreshed_at=refreshed_at)
    prior_imports = [
        item
        for item in snapshot.get("archiveImports") or []
        if isinstance(item, dict)
        and item.get("packageCreatedAt") != audit["packageCreatedAt"]
    ]
    snapshot["archiveImports"] = [
        *prior_imports,
        {
            "packageType": "bidatlas-data-only",
            "packageCreatedAt": audit["packageCreatedAt"],
            "crawlCompletedAt": audit["crawlCompletedAt"],
            "scanScope": "current",
            "completeSources": audit["completeSources"],
            "scannedRows": audit["scannedRows"],
            "qualifiedProjects": audit["qualifiedProjects"],
            "publishedContactProjects": audit["publishedContactProjects"],
            "researchNeededProjects": audit["researchNeededProjects"],
        },
    ]
    serialized = (
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    catalog_bytes = len(serialized.encode("utf-8"))
    result = {
        **audit,
        **merge,
        "catalogBytes": catalog_bytes,
        "target": str(args.target.resolve()),
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
    if catalog_bytes > MAX_CATALOG_BYTES:
        raise ValueError(
            f"The merged catalog is {catalog_bytes:,} bytes, above the "
            f"{MAX_CATALOG_BYTES:,}-byte runtime limit"
        )
    if not args.dry_run:
        args.target.write_text(serialized, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
