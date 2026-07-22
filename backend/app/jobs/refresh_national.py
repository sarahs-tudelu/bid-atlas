from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..services.geography import US_STATES_AND_DC
from ..services.national import (
    configured_source_ids,
    fetch_national_sources,
    national_source_coverage,
    national_warning_prefixes,
)
from ..services.new_jersey import compact_json
from ..services.source_refresh import merge_source_snapshot


def _local_snapshot() -> dict[str, Any]:
    data_directory = Path(os.getenv("BIDATLAS_DATA_DIR", "/var/task/data-export"))
    return json.loads((data_directory / "current-projects.json").read_text(encoding="utf-8"))


def _sam_api_key() -> str:
    direct_value = os.getenv("SAM_API_KEY", "").strip()
    if direct_value:
        return direct_value
    parameter_name = os.getenv("BIDATLAS_SAM_API_KEY_PARAMETER", "").strip()
    if not parameter_name:
        return ""
    import boto3

    response = boto3.client("ssm").get_parameter(Name=parameter_name, WithDecryption=True)
    return str(response["Parameter"]["Value"]).strip()


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
    sam_api_key = _sam_api_key()
    results, warnings = fetch_national_sources(
        sam_api_key=sam_api_key,
        fetched_at=checked_at,
    )
    if not results:
        raise RuntimeError("Every configured source refresh failed: " + "; ".join(warnings))
    refreshed = merge_source_snapshot(
        snapshot,
        results,
        configured_source_ids=configured_source_ids(bool(sam_api_key)),
        source_coverage=national_source_coverage(bool(sam_api_key)),
        warnings=warnings,
        warning_prefixes=national_warning_prefixes(),
        refreshed_at=checked_at,
    )
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=compact_json(refreshed),
        ContentType="application/json",
        CacheControl="no-cache, no-store, must-revalidate",
        Metadata={"refreshed-at": checked_at, "scope": "national"},
    )
    state_codes = set(US_STATES_AND_DC)
    federal_partitions = sum(
        str(result.source_id).startswith("sam-gov-canopy-")
        for result in results
    )
    return {
        "status": "ok",
        "scope": "50-states-and-dc",
        "refreshedAt": checked_at,
        "projects": len(refreshed.get("projects", [])),
        "nationalProjects": sum(
            str(project.get("state") or "").upper() in state_codes
            for project in refreshed.get("projects", [])
        ),
        "refreshedSources": len(results),
        "federalPartitions": federal_partitions,
        "expectedFederalPartitions": len(US_STATES_AND_DC) if sam_api_key else 0,
        "samConfigured": bool(sam_api_key),
        "warnings": warnings,
    }
