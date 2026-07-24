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

            items: list[dict[str, Any]] = []
            query: dict[str, Any] = {
                "KeyConditionExpression": (
                    Key("owner").eq(owner) & Key("recordKey").begins_with(prefix)
                )
            }
            while True:
                response = table.query(**query)
                items.extend(json.loads(item["payload"]) for item in response.get("Items", []))
                last_key = response.get("LastEvaluatedKey")
                if not last_key:
                    return items
                query["ExclusiveStartKey"] = last_key
        with self._lock:
            return [
                dict(value)
                for (item_owner, record_key), value in self._memory.items()
                if item_owner == owner and record_key.startswith(prefix)
            ]

    def list_all_prefix(self, prefix: str) -> list[tuple[str, dict[str, Any]]]:
        """Return records with a key prefix across every workspace owner."""

        table = self._dynamo_table()
        if table is not None:
            from boto3.dynamodb.conditions import Attr

            records: list[tuple[str, dict[str, Any]]] = []
            scan: dict[str, Any] = {
                "FilterExpression": Attr("recordKey").begins_with(prefix),
                "ProjectionExpression": "#owner, payload",
                "ExpressionAttributeNames": {"#owner": "owner"},
            }
            while True:
                response = table.scan(**scan)
                records.extend(
                    (str(item["owner"]), json.loads(item["payload"]))
                    for item in response.get("Items", [])
                )
                last_key = response.get("LastEvaluatedKey")
                if not last_key:
                    return records
                scan["ExclusiveStartKey"] = last_key
        with self._lock:
            return [
                (owner, dict(value))
                for (owner, record_key), value in self._memory.items()
                if record_key.startswith(prefix)
            ]

    def list_google_accounts(self) -> list[tuple[str, dict[str, Any]]]:
        """Return connected Google accounts for the background Gmail sync job."""

        table = self._dynamo_table()
        if table is not None:
            from boto3.dynamodb.conditions import Attr

            accounts: list[tuple[str, dict[str, Any]]] = []
            scan: dict[str, Any] = {
                "FilterExpression": Attr("recordKey").eq("google#account"),
                "ProjectionExpression": "#owner, payload",
                "ExpressionAttributeNames": {"#owner": "owner"},
            }
            while True:
                response = table.scan(**scan)
                for item in response.get("Items", []):
                    accounts.append((str(item["owner"]), json.loads(item["payload"])))
                last_key = response.get("LastEvaluatedKey")
                if not last_key:
                    return accounts
                scan["ExclusiveStartKey"] = last_key
        with self._lock:
            return [
                (owner, dict(payload))
                for (owner, record_key), payload in self._memory.items()
                if record_key == "google#account"
            ]
