from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

from .qualification import contact_research_status


WORD = re.compile(r"[a-z0-9]+")
STOP_WORDS = {
    "and",
    "at",
    "bid",
    "building",
    "construction",
    "contract",
    "for",
    "improvement",
    "improvements",
    "of",
    "project",
    "renovation",
    "repair",
    "replacement",
    "services",
    "the",
    "to",
}
ADDRESS_EQUIVALENTS = {
    "avenue": "ave",
    "boulevard": "blvd",
    "circle": "cir",
    "court": "ct",
    "drive": "dr",
    "highway": "hwy",
    "lane": "ln",
    "parkway": "pkwy",
    "place": "pl",
    "road": "rd",
    "street": "st",
    "terrace": "ter",
}


def _normalized(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").casefold())
    return " ".join(WORD.findall(text))


def _title_tokens(project: dict[str, Any]) -> frozenset[str]:
    return frozenset(
        token
        for token in WORD.findall(_normalized(project.get("title")))
        if token not in STOP_WORDS and (len(token) >= 3 or token.isdigit())
    )


def _state(project: dict[str, Any]) -> str:
    return _normalized(project.get("state"))


def _address(project: dict[str, Any]) -> str:
    return " ".join(
        ADDRESS_EQUIVALENTS.get(token, token)
        for token in _normalized(project.get("address")).split()
    )


def _locality(project: dict[str, Any]) -> str:
    return _normalized(
        project.get("postalCode")
        or project.get("city")
        or project.get("county")
    )


def _identifier(project: dict[str, Any]) -> str:
    identifier = "".join(WORD.findall(_normalized(project.get("sourceRecordId"))))
    if identifier.isdigit():
        return identifier if len(identifier) >= 8 else ""
    if len(identifier) >= 5 and any(character.isdigit() for character in identifier):
        return identifier
    return ""


def _date(value: Any) -> str:
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else ""


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _locations_overlap(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_address = _address(left)
    right_address = _address(right)
    if left_address and left_address == right_address:
        return True
    left_locality = _locality(left)
    right_locality = _locality(right)
    return bool(left_locality and left_locality == right_locality)


def _strong_locations_overlap(
    left: dict[str, Any],
    right: dict[str, Any],
) -> bool:
    left_address = _address(left)
    right_address = _address(right)
    if left_address and left_address == right_address:
        return True
    left_postal_code = _normalized(left.get("postalCode"))
    right_postal_code = _normalized(right.get("postalCode"))
    return bool(left_postal_code and left_postal_code == right_postal_code)


def _same_project(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if str(left.get("sourceId") or "") == str(right.get("sourceId") or ""):
        return False
    left_state = _state(left)
    right_state = _state(right)
    if left_state and right_state and left_state != right_state:
        return False

    left_title = _normalized(left.get("title"))
    right_title = _normalized(right.get("title"))
    left_tokens = _title_tokens(left)
    right_tokens = _title_tokens(right)
    title_similarity = _jaccard(left_tokens, right_tokens)
    locations_overlap = _locations_overlap(left, right)
    left_address = _address(left)
    right_address = _address(right)
    addresses_conflict = bool(
        left_address and right_address and left_address != right_address
    )

    left_identifier = _identifier(left)
    right_identifier = _identifier(right)
    if (
        left_identifier
        and left_identifier == right_identifier
        and (locations_overlap or title_similarity >= 0.35)
    ):
        return True

    if (
        left_address
        and left_address == right_address
        and len(left_tokens | right_tokens) >= 3
        and title_similarity >= 0.72
    ):
        return True

    if (
        len(left_title) >= 20
        and left_title == right_title
        and not addresses_conflict
    ):
        left_bid_date = _date(left.get("bidDate"))
        right_bid_date = _date(right.get("bidDate"))
        return _strong_locations_overlap(left, right) or (
            locations_overlap
            and bool(left_bid_date)
            and left_bid_date == right_bid_date
        )

    return False


def _candidate_keys(project: dict[str, Any]) -> set[tuple[str, ...]]:
    state = _state(project)
    title = _normalized(project.get("title"))
    identifier = _identifier(project)
    address = _address(project)
    locality = _locality(project)
    tokens = _title_tokens(project)
    keys: set[tuple[str, ...]] = set()
    if identifier:
        keys.add(("identifier", state, identifier))
    if address:
        keys.add(("address", state, address))
    if len(title) >= 20 and locality:
        keys.add(("title-locality", state, title, locality))
    if len(tokens) >= 3 and locality:
        keys.add(("tokens-locality", state, " ".join(sorted(tokens)), locality))
    return keys


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


def _unique_dicts(
    rows: Iterable[dict[str, Any]],
    *,
    identity_fields: tuple[str, ...],
) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[tuple[str, ...]] = set()
    for row in rows:
        identity = tuple(_normalized(row.get(field)) for field in identity_fields)
        if not any(identity):
            identity = (repr(sorted(row.items())),)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(row)
    return unique


def _source_record(project: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in {
            "id": project.get("id"),
            "sourceId": project.get("sourceId"),
            "sourceRecordId": project.get("sourceRecordId"),
            "sourceName": project.get("sourceName"),
            "sourceUrl": project.get("sourceUrl"),
            "updatedAt": project.get("updatedAt"),
        }.items()
        if value not in (None, "")
    }


def _merge_group(projects: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(projects, key=lambda project: str(project.get("id") or ""))
    merged = dict(ordered[0])
    for project in ordered[1:]:
        for field, value in project.items():
            if field in {
                "id",
                "sourceRecords",
                "duplicateProjectIds",
                "documents",
                "participants",
                "searchableFields",
                "canopyFit",
                "productMatches",
                "productTypes",
                "contactStatus",
            }:
                continue
            if merged.get(field) in (None, "", [], {}) and value not in (
                None,
                "",
                [],
                {},
            ):
                merged[field] = value
        if len(str(project.get("summary") or "")) > len(
            str(merged.get("summary") or "")
        ):
            merged["summary"] = project["summary"]
        if _timestamp(project.get("updatedAt")) > _timestamp(merged.get("updatedAt")):
            merged["updatedAt"] = project["updatedAt"]

    documents = [
        document
        for project in ordered
        for document in project.get("documents") or []
        if isinstance(document, dict)
    ]
    participants = [
        participant
        for project in ordered
        for participant in project.get("participants") or []
        if isinstance(participant, dict)
    ]
    searchable_fields = [
        value
        for project in ordered
        for value in project.get("searchableFields") or []
        if value not in (None, "")
    ]
    merged["documents"] = _unique_dicts(documents, identity_fields=("url", "name"))
    merged["participants"] = _unique_dicts(
        participants,
        identity_fields=("email", "phone", "name", "organization", "role"),
    )
    if searchable_fields:
        merged["searchableFields"] = list(dict.fromkeys(searchable_fields))

    fits = [
        project.get("canopyFit")
        for project in ordered
        if isinstance(project.get("canopyFit"), dict)
        and isinstance(project["canopyFit"].get("score"), int)
    ]
    if fits:
        merged["canopyFit"] = max(fits, key=lambda fit: int(fit["score"]))

    matches_by_id: dict[str, dict[str, Any]] = {}
    for project in ordered:
        for match in project.get("productMatches") or []:
            if not isinstance(match, dict) or not match.get("id"):
                continue
            match_id = str(match["id"])
            existing = matches_by_id.get(match_id)
            if existing is None or int(match.get("score") or 0) > int(
                existing.get("score") or 0
            ):
                matches_by_id[match_id] = match
    if matches_by_id:
        merged["productMatches"] = sorted(
            matches_by_id.values(),
            key=lambda match: (-int(match.get("score") or 0), str(match.get("label") or "")),
        )
        merged["productTypes"] = [
            str(match["id"]) for match in merged["productMatches"]
        ]

    source_records = [
        record
        for project in ordered
        for record in (
            project.get("sourceRecords")
            if isinstance(project.get("sourceRecords"), list)
            else [_source_record(project)]
        )
        if isinstance(record, dict)
    ]
    merged["sourceRecords"] = _unique_dicts(
        source_records,
        identity_fields=("id", "sourceUrl"),
    )
    merged["duplicateProjectIds"] = sorted(
        {
            str(project_id)
            for project in ordered
            for project_id in [
                project.get("id"),
                *(project.get("duplicateProjectIds") or []),
            ]
            if project_id
        }
    )
    merged["duplicateSourceCount"] = len(
        {
            str(record.get("sourceId"))
            for record in merged["sourceRecords"]
            if record.get("sourceId")
        }
    )
    merged["contactStatus"] = contact_research_status(merged)
    return merged


def merge_duplicate_projects(
    projects: Iterable[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Merge conservative cross-source matches while retaining every source record."""

    materialized = list(projects)
    parents = list(range(len(materialized)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    blocks: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for index, project in enumerate(materialized):
        candidates: set[int] = set()
        keys = _candidate_keys(project)
        for key in keys:
            candidates.update(blocks[key])
        for candidate in candidates:
            if _same_project(materialized[candidate], project):
                union(candidate, index)
        for key in keys:
            blocks[key].append(index)

    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for index, project in enumerate(materialized):
        groups[find(index)].append(project)

    merged = [
        _merge_group(group) if len(group) > 1 else group[0]
        for _, group in sorted(groups.items())
    ]
    duplicate_groups = sum(len(group) > 1 for group in groups.values())
    return merged, {
        "inputProjects": len(materialized),
        "mergedProjects": len(merged),
        "duplicateGroups": duplicate_groups,
        "duplicateRowsMerged": len(materialized) - len(merged),
    }
