from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Protocol

from .catalog import ProjectCatalog


MAX_CATALOG_BYTES = 80_000_000


class S3CatalogClient(Protocol):
    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...

    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...


class ProjectCatalogProvider:
    """Serve the deployed S3 catalog with a checked-in snapshot fallback."""

    def __init__(
        self,
        data_directory: Path,
        *,
        bucket: str | None = None,
        key: str = "current-projects.json",
        refresh_seconds: int = 300,
        s3_client: S3CatalogClient | None = None,
    ) -> None:
        self._data_directory = data_directory
        self._bucket = bucket
        self._key = key
        self._refresh_seconds = max(refresh_seconds, 0)
        self._s3_client = s3_client
        self._registry = json.loads(
            (data_directory / "source-registry.json").read_text(encoding="utf-8")
        )
        self._catalog = ProjectCatalog(data_directory)
        self._etag: str | None = None
        self._next_check = 0.0
        self._lock = threading.Lock()

    def _client(self) -> S3CatalogClient:
        if self._s3_client is None:
            import boto3

            self._s3_client = boto3.client("s3")
        return self._s3_client

    def get(self) -> ProjectCatalog:
        if not self._bucket:
            return self._catalog
        now = time.monotonic()
        if now < self._next_check:
            return self._catalog
        with self._lock:
            now = time.monotonic()
            if now < self._next_check:
                return self._catalog
            self._next_check = now + self._refresh_seconds
            try:
                client = self._client()
                head = client.head_object(Bucket=self._bucket, Key=self._key)
                etag = str(head.get("ETag") or "").strip('"')
                if etag and etag == self._etag:
                    return self._catalog
                response = client.get_object(Bucket=self._bucket, Key=self._key)
                body = response["Body"].read(MAX_CATALOG_BYTES + 1)
                if len(body) > MAX_CATALOG_BYTES:
                    raise ValueError("S3 catalog exceeded the response-size limit")
                snapshot = json.loads(body.decode("utf-8"))
                self._catalog = ProjectCatalog.from_snapshot(snapshot, self._registry)
                self._etag = etag
            except Exception as error:
                print(f"BidAtlas catalog refresh fell back to the packaged snapshot: {error}")
            return self._catalog
