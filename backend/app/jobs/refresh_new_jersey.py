from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..services.new_jersey import compact_json, fetch_new_jersey_sources, merge_new_jersey_snapshot


def _local_snapshot() -> dict[str, Any]:
    data_directory = Path(os.getenv("BIDATLAS_DATA_DIR", "/var/task/data-export"))
    return json.loads((data_directory / "current-projects.json").read_text(encoding="utf-8"))


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del event, context
    bucket = os.environ["BIDATLAS_CATALOG_BUCKET"]
    key = os.getenv("BIDATLAS_CATALOG_KEY", "current-projects.json")
    import boto3

    s3 = boto3.client("s3")
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
        snapshot = json.loads(response["Body"].read().decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        snapshot = _local_snapshot()

    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    results, warnings = fetch_new_jersey_sources(fetched_at=checked_at)
    if not results:
        raise RuntimeError("Every official New Jersey source refresh failed: " + "; ".join(warnings))
    refreshed = merge_new_jersey_snapshot(
        snapshot,
        results,
        warnings=warnings,
        refreshed_at=checked_at,
    )
    payload = compact_json(refreshed)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=payload,
        ContentType="application/json",
        CacheControl="no-cache, no-store, must-revalidate",
        Metadata={"refreshed-at": checked_at},
    )
    return {
        "status": "ok",
        "refreshedAt": checked_at,
        "projects": len(refreshed.get("projects", [])),
        "newJerseyProjects": sum(
            str(project.get("state") or "").upper() in {"NJ", "NEW JERSEY"}
            for project in refreshed.get("projects", [])
        ),
        "warnings": warnings,
    }
