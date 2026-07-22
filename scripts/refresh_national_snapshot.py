from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from backend.app.services.national import (  # noqa: E402
    configured_source_ids,
    fetch_national_sources,
    national_source_coverage,
    national_warning_prefixes,
)
from backend.app.services.new_jersey import compact_json  # noqa: E402
from backend.app.services.source_refresh import merge_source_snapshot  # noqa: E402


def _write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(compact_json(value))
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Refresh official regional portals and nationwide SAM.gov canopy sources."
    )
    parser.add_argument("--data-dir", type=Path, default=Path("data-export"))
    args = parser.parse_args()

    data_directory = args.data_dir.resolve()
    snapshot_path = data_directory / "current-projects.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sam_api_key = os.getenv("SAM_API_KEY", "").strip()
    results, warnings = fetch_national_sources(
        sam_api_key=sam_api_key,
        fetched_at=checked_at,
    )
    if not results:
        raise SystemExit("Every configured source refresh failed: " + "; ".join(warnings))
    refreshed = merge_source_snapshot(
        snapshot,
        results,
        configured_source_ids=configured_source_ids(bool(sam_api_key)),
        source_coverage=national_source_coverage(bool(sam_api_key)),
        warnings=warnings,
        warning_prefixes=national_warning_prefixes(),
        refreshed_at=checked_at,
    )
    _write_json(snapshot_path, refreshed)

    coverage_path = data_directory / "coverage.json"
    if coverage_path.exists():
        _write_json(
            coverage_path,
            {
                "coverage": refreshed.get("coverage", {}),
                "inventory": refreshed.get("inventory", {}),
                "sources": refreshed.get("sources", []),
                "warnings": refreshed.get("warnings", []),
            },
        )

    manifest_path = data_directory / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["createdAt"] = checked_at
        manifest.setdefault("liveProjectSnapshot", {})["projects"] = len(refreshed["projects"])
        manifest["liveProjectSnapshot"]["sourceStatusEntries"] = len(refreshed["sources"])
        _write_json(manifest_path, manifest)

    federal_partitions = sum(
        str(result.source_id).startswith("sam-gov-canopy-")
        for result in results
    )
    print(
        f"Refreshed {len(results)} source partitions, including "
        f"{federal_partitions} nationwide SAM.gov partitions."
    )
    for warning in warnings:
        print(f"Warning: {warning}")


if __name__ == "__main__":
    main()
