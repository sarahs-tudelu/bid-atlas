from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from backend.app.services.new_jersey import (  # noqa: E402
    compact_json,
    fetch_new_jersey_sources,
    merge_new_jersey_snapshot,
)


def _write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(compact_json(value))
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh official New Jersey construction sources.")
    parser.add_argument("--data-dir", type=Path, default=Path("data-export"))
    args = parser.parse_args()

    data_directory = args.data_dir.resolve()
    snapshot_path = data_directory / "current-projects.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    results, warnings = fetch_new_jersey_sources(fetched_at=checked_at)
    if not results:
        raise SystemExit("Every official New Jersey source refresh failed: " + "; ".join(warnings))
    refreshed = merge_new_jersey_snapshot(
        snapshot,
        results,
        warnings=warnings,
        refreshed_at=checked_at,
    )
    _write_json(snapshot_path, refreshed)

    coverage_path = data_directory / "coverage.json"
    if coverage_path.exists():
        coverage_export = {
            "coverage": refreshed.get("coverage", {}),
            "inventory": refreshed.get("inventory", {}),
            "sources": refreshed.get("sources", []),
            "warnings": refreshed.get("warnings", []),
        }
        _write_json(coverage_path, coverage_export)

    manifest_path = data_directory / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["createdAt"] = checked_at
        manifest.setdefault("liveProjectSnapshot", {})["projects"] = len(refreshed["projects"])
        manifest["liveProjectSnapshot"]["sourceStatusEntries"] = len(refreshed["sources"])
        _write_json(manifest_path, manifest)

    new_jersey_projects = [
        project
        for project in refreshed["projects"]
        if str(project.get("state") or "").upper() in {"NJ", "NEW JERSEY"}
    ]
    open_bids = [project for project in new_jersey_projects if project.get("stage") == "bidding"]
    print(
        f"Refreshed {len(new_jersey_projects)} New Jersey projects, "
        f"including {len(open_bids)} currently advertised bids."
    )
    for warning in warnings:
        print(f"Warning: {warning}")


if __name__ == "__main__":
    main()
