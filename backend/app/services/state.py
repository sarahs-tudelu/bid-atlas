from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any


class WorkspaceStore:
    """Small key/value workspace store backed by DynamoDB in AWS and memory locally."""

    def __init__(self, table_name: str | None) -> None:
        self._table_name = table_name
        self._memory: dict[tuple[str, str], dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._table = None

    def _dynamo_table(self):
        if not self._table_name:
            return None
        if self._table is None:
            import boto3

            self._table = boto3.resource("dynamodb").Table(self._table_name)
        return self._table

    def get(self, owner: str, record_key: str) -> dict[str, Any] | None:
        table = self._dynamo_table()
        if table is not None:
            response = table.get_item(Key={"owner": owner, "recordKey": record_key})
            item = response.get("Item")
            return json.loads(item["payload"]) if item else None
        with self._lock:
            value = self._memory.get((owner, record_key))
            return dict(value) if value else None

    def put(self, owner: str, record_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        stored = {**payload, "updatedAt": datetime.now(timezone.utc).isoformat()}
        table = self._dynamo_table()
        if table is not None:
            table.put_item(
                Item={
                    "owner": owner,
                    "recordKey": record_key,
                    "payload": json.dumps(stored, separators=(",", ":")),
                    "updatedAt": stored["updatedAt"],
                }
            )
        else:
            with self._lock:
                self._memory[(owner, record_key)] = stored
        return stored

    def put_if_absent(self, owner: str, record_key: str, payload: dict[str, Any]) -> bool:
        """Create a short-lived coordination record without overwriting an existing one."""

        stored = {**payload, "updatedAt": datetime.now(timezone.utc).isoformat()}
        table = self._dynamo_table()
        if table is not None:
            from botocore.exceptions import ClientError

            try:
                table.put_item(
                    Item={
                        "owner": owner,
                        "recordKey": record_key,
                        "payload": json.dumps(stored, separators=(",", ":")),
                        "updatedAt": stored["updatedAt"],
                    },
                    ConditionExpression="attribute_not_exists(#owner) AND attribute_not_exists(#key)",
                    ExpressionAttributeNames={"#owner": "owner", "#key": "recordKey"},
                )
                return True
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                    return False
                raise
        with self._lock:
            key = (owner, record_key)
            if key in self._memory:
                return False
            self._memory[key] = stored
            return True

    def delete(self, owner: str, record_key: str) -> None:
        table = self._dynamo_table()
        if table is not None:
            table.delete_item(Key={"owner": owner, "recordKey": record_key})
            return
        with self._lock:
            self._memory.pop((owner, record_key), None)

    def list_prefix(self, owner: str, prefix: str) -> list[dict[str, Any]]:
        table = self._dynamo_table()
        if table is not None:
            from boto3.dynamodb.conditions import Key

            response = table.query(
                KeyConditionExpression=Key("owner").eq(owner) & Key("recordKey").begins_with(prefix)
            )
            return [json.loads(item["payload"]) for item in response.get("Items", [])]
        with self._lock:
            return [
                dict(value)
                for (item_owner, record_key), value in self._memory.items()
                if item_owner == owner and record_key.startswith(prefix)
            ]
