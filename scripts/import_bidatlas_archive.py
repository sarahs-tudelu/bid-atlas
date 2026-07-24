from __future__ import annotations

import argparse
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

from backend.app.services.canopy import score_project  # noqa: E402
from backend.app.services.qualification import (  # noqa: E402
    is_contactable_product_project,
    published_contacts,
    published_phone_contacts,
)


ARCHIVED_STAGES = {"cancelled", "completed"}


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


def qualifying_projects(
    archive_directory: Path,
    *,
    verify_checksums: bool = False,
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
    source_counts: Counter[str] = Counter()
    scanned_rows = 0
    projects_by_id: dict[str, dict[str, Any]] = {}

    for source_id in _complete_source_ids(manifest):
        source_directory = crawl_directory / "sources" / source_id
        source_manifest = _read_json(source_directory / "manifest.json")
        if (
            source_manifest.get("complete") is not True
            or source_manifest.get("status") != "complete"
        ):
            raise ValueError(f"{source_id} is not a complete current-scope snapshot")
        for page_path in sorted((source_directory / "pages").glob("*.ndjson.gz")):
            if verify_checksums:
                _verify_page(page_path)
            with gzip.open(page_path, "rt", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    scanned_rows += 1
                    project = json.loads(line)
                    if str(project.get("stage") or "") in ARCHIVED_STAGES:
                        continue
                    if not (
                        published_contacts(project)
                        or published_phone_contacts(project)
                    ):
                        continue
                    fit = score_project(project)
                    if not is_contactable_product_project(project, fit):
                        continue
                    project_id = str(project.get("id") or "").strip()
                    if not project_id:
                        raise ValueError(f"{source_id} emitted a project without an ID")
                    imported = {
                        **project,
                        "archiveImport": {
                            "packageType": "bidatlas-data-only",
                            "packageCreatedAt": package_created_at,
                            "crawlCompletedAt": crawl_completed_at,
                            "scanScope": "current",
                        },
                    }
                    existing = projects_by_id.get(project_id)
                    if existing is None or _timestamp(
                        imported.get("updatedAt")
                    ) >= _timestamp(existing.get("updatedAt")):
                        projects_by_id[project_id] = imported
                    source_counts[source_id] += 1

    projects = sorted(
        projects_by_id.values(),
        key=lambda project: (
            _timestamp(project.get("bidDate")),
            str(project.get("id") or ""),
        ),
    )
    return projects, {
        "packageCreatedAt": package_created_at,
        "crawlCompletedAt": crawl_completed_at,
        "completeSources": len(_complete_source_ids(manifest)),
        "scannedRows": scanned_rows,
        "qualifiedProjects": len(projects),
        "qualifiedBySource": dict(sorted(source_counts.items())),
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
    args = parser.parse_args()

    imported, audit = qualifying_projects(
        args.archive.resolve(),
        verify_checksums=args.verify_checksums,
    )
    snapshot = _read_json(args.target.resolve())
    refreshed_at = str(audit["packageCreatedAt"] or audit["crawlCompletedAt"])
    if not refreshed_at:
        raise ValueError("The archive does not contain a usable capture timestamp")
    merge = merge_projects(snapshot, imported, refreshed_at=refreshed_at)
    result = {**audit, **merge, "target": str(args.target.resolve())}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if not args.dry_run:
        args.target.write_text(
            json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
