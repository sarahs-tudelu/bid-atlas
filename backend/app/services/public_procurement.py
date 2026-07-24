from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Any, Callable
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .canopy import project_product_matches
from .source_refresh import SourceRefreshResult


DC_PASS_SOURCE_ID = "district-columbia-pass-solicitations"
DC_PASS_SOURCE_URL = (
    "https://maps2.dcgis.dc.gov/dcgis/rest/services/"
    "DCGIS_DATA/Government_Operations/MapServer/19"
)
DC_PASS_DATASET_URL = "https://opendata.dc.gov/datasets/DCGIS::solicitations-from-pass"
NYC_CROL_SOURCE_ID = "new-york-city-record-procurements"
NYC_CROL_API_URL = "https://data.cityofnewyork.us/resource/dg92-zbpx.json"
NYC_CROL_DATASET_URL = "https://data.cityofnewyork.us/d/dg92-zbpx"
MAX_PUBLIC_JSON_BYTES = 12_000_000
DC_PASS_PAGE_SIZE = 1_000
DC_PASS_MAX_PAGES = 5
NYC_CROL_PAGE_SIZE = 1_000
NYC_CROL_MAX_PAGES = 3


def fetch_open_data_json(url: str, timeout_seconds: int = 45) -> dict[str, Any]:
    expected_host = urlparse(url).hostname
    if expected_host != "maps2.dcgis.dc.gov":
        raise ValueError("Open-data request used an unexpected host")
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "BidAtlas/1.0 public-construction-index",
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        if urlparse(response.geturl()).hostname != expected_host:
            raise ValueError("Open-data service redirected to an unexpected host")
        payload = response.read(MAX_PUBLIC_JSON_BYTES + 1)
        if len(payload) > MAX_PUBLIC_JSON_BYTES:
            raise ValueError("Open-data response exceeded the response-size limit")
    value = json.loads(payload.decode("utf-8", errors="replace"))
    if not isinstance(value, dict):
        raise ValueError("Open-data service returned an unexpected response")
    return value


def fetch_nyc_open_data_json(
    url: str,
    timeout_seconds: int = 45,
) -> list[dict[str, Any]]:
    expected_host = urlparse(url).hostname
    if expected_host != "data.cityofnewyork.us":
        raise ValueError("NYC open-data request used an unexpected host")
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "BidAtlas/1.0 public-construction-index",
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        if urlparse(response.geturl()).hostname != expected_host:
            raise ValueError("NYC open-data service redirected to an unexpected host")
        payload = response.read(MAX_PUBLIC_JSON_BYTES + 1)
        if len(payload) > MAX_PUBLIC_JSON_BYTES:
            raise ValueError("NYC open-data response exceeded the response-size limit")
    value = json.loads(payload.decode("utf-8", errors="replace"))
    if not isinstance(value, list) or not all(
        isinstance(record, dict) for record in value
    ):
        raise ValueError("NYC open-data service returned an unexpected response")
    return value


def _clean(value: Any) -> str:
    return " ".join(str(value or "").split())


def _iso_from_epoch(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _iso_from_text(value: Any) -> str | None:
    text = _clean(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def _record_url(record_id: str) -> str:
    escaped = record_id.replace("'", "''")
    params = urlencode(
        {
            "f": "pjson",
            "where": f"SOLICITATIONNUMBER = '{escaped}'",
            "outFields": "*",
            "returnGeometry": "false",
        }
    )
    return f"{DC_PASS_SOURCE_URL}/query?{params}"


def _nyc_record_url(record_id: str) -> str:
    return f"{NYC_CROL_API_URL}?{urlencode({'request_id': record_id})}"


def _participants(record: dict[str, Any], source_url: str) -> list[dict[str, str]]:
    participants: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    candidates = (
        (
            _clean(record.get("CONTRACTINGOFFICER")),
            _clean(record.get("COEMAILADDRESS")).lower(),
            _clean(record.get("PHONE")),
            "contracting officer",
        ),
        (
            _clean(record.get("OWNER")),
            _clean(record.get("EMAIL")).lower(),
            _clean(record.get("PHONE")),
            "procurement contact",
        ),
    )
    for name, email, phone, role in candidates:
        key = (email, "".join(character for character in phone if character.isdigit()))
        if not any(key) or key in seen:
            continue
        seen.add(key)
        participants.append(
            {
                "name": name or "District procurement contact",
                "role": role,
                "participantType": "person",
                "organization": _clean(
                    record.get("AGENCY_NAME")
                    or record.get("OWNERAGENCY")
                    or "District of Columbia"
                ),
                "email": email,
                "phone": phone,
                "sourceUrl": source_url,
            }
        )
    return participants


def normalize_dc_pass_project(
    record: dict[str, Any],
    *,
    fetched_at: str,
) -> dict[str, Any] | None:
    record_id = _clean(
        record.get("SOLICITATIONNUMBER")
        or record.get("SOLICITATIONPROJECTNUMBER")
    )
    title = _clean(record.get("SOLICITATIONTITLE"))
    if not record_id or not title:
        return None

    source_url = _record_url(record_id)
    agency = _clean(
        record.get("AGENCY_NAME")
        or record.get("AGENCYDESCRIPTION")
        or record.get("OWNERAGENCY")
        or "District of Columbia"
    )
    summary = _clean(
        record.get("SYNOPSIS")
        or record.get("NIGPCODEDESCRIPTION")
        or title
    )
    project: dict[str, Any] = {
        "id": f"{DC_PASS_SOURCE_ID}:{record_id}",
        "sourceId": DC_PASS_SOURCE_ID,
        "sourceRecordId": record_id,
        "title": title,
        "summary": summary,
        "stage": "bidding",
        "status": _clean(
            record.get("EVENTDISPLAYSTATUS")
            or record.get("SOLICITATIONSTATUS")
            or "Open"
        ),
        "agency": agency,
        "city": "Washington",
        "state": "DC",
        "postedAt": _iso_from_epoch(
            record.get("ISSUANCEDATE") or record.get("REC_CREATE_DATE")
        ),
        "updatedAt": (
            _iso_from_epoch(
                record.get("REC_LASTMODIFIED_DATE")
                or record.get("DCS_LAST_MOD_DTTM")
            )
            or fetched_at
        ),
        "bidDate": _iso_from_epoch(
            record.get("CLOSEDATE")
            or record.get("DUE_DATE")
            or record.get("OPENDATE")
        ),
        "sourceName": "District of Columbia PASS Solicitations",
        "sourceUrl": source_url,
        "provenance": "live-public-api",
        "confidence": "official",
        "documents": [
            {
                "name": f"Official PASS solicitation record {record_id}",
                "kind": "source-record",
                "url": source_url,
                "access": "public",
                "indexStatus": "metadata-only",
            }
        ],
        "participants": _participants(record, source_url),
        "searchableFields": [
            summary,
            agency,
            _clean(record.get("NIGPCODE")),
            _clean(record.get("NIGPCODEDESCRIPTION")),
            _clean(record.get("PROCUREMENTMETHOD")),
            _clean(record.get("CONTRACTTYPE")),
            _clean(record.get("TYPE")),
            _clean(record.get("WORKSITELOCATION")),
        ],
        "documentTextIndexed": False,
    }
    return project if project_product_matches(project) else None


def fetch_dc_pass_projects(
    fetch_json: Callable[[str], dict[str, Any]] = fetch_open_data_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[SourceRefreshResult, list[str]]:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    records: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    snapshot_complete = True

    for page_index in range(DC_PASS_MAX_PAGES):
        params = {
            "f": "json",
            "where": (
                "EVENTDISPLAYSTATUS = 'OPEN' AND "
                f"CLOSEDATE >= DATE '{current_date.isoformat()}'"
            ),
            "outFields": "*",
            "returnGeometry": "false",
            "orderByFields": "CLOSEDATE ASC",
            "resultOffset": str(page_index * DC_PASS_PAGE_SIZE),
            "resultRecordCount": str(DC_PASS_PAGE_SIZE),
        }
        payload = fetch_json(f"{DC_PASS_SOURCE_URL}/query?{urlencode(params)}")
        features = payload.get("features")
        if not isinstance(features, list):
            raise ValueError("PASS response did not contain a features list")
        for feature in features:
            attributes = feature.get("attributes") if isinstance(feature, dict) else None
            if not isinstance(attributes, dict):
                continue
            record_id = _clean(
                attributes.get("SOLICITATIONNUMBER")
                or attributes.get("SOLICITATIONPROJECTNUMBER")
            )
            if record_id:
                records[record_id] = attributes
        if not payload.get("exceededTransferLimit"):
            break
    else:
        snapshot_complete = False
        warnings.append(
            f"PASS exceeded the guarded {DC_PASS_MAX_PAGES}-page limit"
        )

    projects = [
        project
        for record in records.values()
        if (project := normalize_dc_pass_project(record, fetched_at=checked_at))
        is not None
    ]
    projects.sort(
        key=lambda project: (
            str(project.get("bidDate") or "9999-12-31"),
            str(project.get("title") or ""),
        )
    )
    source = {
        "id": DC_PASS_SOURCE_ID,
        "name": "District of Columbia PASS Solicitations",
        "owner": "District of Columbia Office of Contracting and Procurement",
        "level": "district",
        "sourceClass": "procurement",
        "stages": ["bidding"],
        "status": "live",
        "access": "public-api",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "product-relevant open solicitations",
        "loadedCount": len(projects),
        "snapshotComplete": snapshot_complete,
        "lastChecked": checked_at,
        "url": DC_PASS_DATASET_URL,
        "jurisdiction": "District of Columbia",
        "stateCode": "DC",
        "coverageField": "procurement",
        "note": (
            "Official open PASS solicitation feed with published contracting-officer "
            "contact fields, narrowed to canopy, pergola, and partition-wall relevance."
        ),
    }
    return SourceRefreshResult(DC_PASS_SOURCE_ID, projects, source), warnings


def normalize_nyc_crol_project(
    record: dict[str, Any],
    *,
    fetched_at: str,
) -> dict[str, Any] | None:
    record_id = _clean(record.get("request_id"))
    title = _clean(record.get("short_title"))
    if not record_id or not title:
        return None

    source_url = _nyc_record_url(record_id)
    agency = _clean(record.get("agency_name") or "City of New York")
    detail_fields = [
        _clean(record.get("additional_description_1")),
        _clean(record.get("additional_desctription_2")),
        _clean(record.get("additional_description_3")),
        _clean(record.get("other_info_1")),
        _clean(record.get("other_info_2")),
        _clean(record.get("other_info_3")),
    ]
    details = [value for value in detail_fields if value]
    summary = " ".join(details) or title
    email = _clean(record.get("email")).lower()
    phone = _clean(record.get("contact_phone"))
    participants = []
    if email or phone:
        participants.append(
            {
                "name": _clean(record.get("contact_name"))
                or "NYC procurement contact",
                "role": "procurement contact",
                "participantType": "person",
                "organization": agency,
                "email": email,
                "phone": phone,
                "sourceUrl": source_url,
            }
        )

    documents = [
        {
            "name": f"Official City Record solicitation {record_id}",
            "kind": "source-record",
            "url": source_url,
            "access": "public",
            "indexStatus": "metadata-only",
        }
    ]
    document_link = record.get("document_links")
    if isinstance(document_link, dict):
        linked_url = _clean(document_link.get("url"))
        if linked_url.startswith(("https://", "http://")):
            documents.append(
                {
                    "name": _clean(document_link.get("description"))
                    or "Solicitation documents",
                    "kind": "solicitation-document",
                    "url": linked_url,
                    "access": "public",
                    "indexStatus": "linked",
                }
            )

    project: dict[str, Any] = {
        "id": f"{NYC_CROL_SOURCE_ID}:{record_id}",
        "sourceId": NYC_CROL_SOURCE_ID,
        "sourceRecordId": record_id,
        "title": title,
        "summary": summary,
        "stage": "bidding",
        "status": _clean(record.get("type_of_notice_description") or "Solicitation"),
        "agency": agency,
        "address": _clean(record.get("address_to_request")),
        "city": _clean(record.get("city") or "New York"),
        "state": _clean(record.get("state") or "NY").upper(),
        "postalCode": _clean(record.get("zip_code")),
        "postedAt": _iso_from_text(record.get("start_date")),
        "updatedAt": fetched_at,
        "bidDate": _iso_from_text(record.get("due_date")),
        "sourceName": "New York City Record Procurement Notices",
        "sourceUrl": source_url,
        "provenance": "live-public-api",
        "confidence": "official",
        "documents": documents,
        "participants": participants,
        "searchableFields": [
            summary,
            agency,
            _clean(record.get("category_description")),
            _clean(record.get("selection_method_description")),
            _clean(record.get("pin")),
            _clean(record.get("address_to_request")),
        ],
        "documentTextIndexed": False,
    }
    return project if project_product_matches(project) else None


def fetch_nyc_crol_projects(
    fetch_json: Callable[[str], list[dict[str, Any]]] = fetch_nyc_open_data_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[SourceRefreshResult, list[str]]:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    records: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    snapshot_complete = True

    for page_index in range(NYC_CROL_MAX_PAGES):
        params = {
            "$where": (
                "section_name = 'Procurement' AND "
                "type_of_notice_description = 'Solicitation' AND "
                f"due_date >= '{current_date.isoformat()}T00:00:00.000'"
            ),
            "$order": "due_date ASC",
            "$limit": str(NYC_CROL_PAGE_SIZE),
            "$offset": str(page_index * NYC_CROL_PAGE_SIZE),
        }
        page_records = fetch_json(f"{NYC_CROL_API_URL}?{urlencode(params)}")
        for record in page_records:
            record_id = _clean(record.get("request_id"))
            if record_id:
                records[record_id] = record
        if len(page_records) < NYC_CROL_PAGE_SIZE:
            break
    else:
        snapshot_complete = False
        warnings.append(
            f"City Record exceeded the guarded {NYC_CROL_MAX_PAGES}-page limit"
        )

    projects = [
        project
        for record in records.values()
        if (project := normalize_nyc_crol_project(record, fetched_at=checked_at))
        is not None
    ]
    projects.sort(
        key=lambda project: (
            str(project.get("bidDate") or "9999-12-31"),
            str(project.get("title") or ""),
        )
    )
    source = {
        "id": NYC_CROL_SOURCE_ID,
        "name": "New York City Record Procurement Notices",
        "owner": "New York City Department of Citywide Administrative Services",
        "level": "city",
        "sourceClass": "procurement",
        "stages": ["bidding"],
        "status": "live",
        "access": "public-api",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "product-relevant open solicitations",
        "loadedCount": len(projects),
        "snapshotComplete": snapshot_complete,
        "lastChecked": checked_at,
        "url": NYC_CROL_DATASET_URL,
        "jurisdiction": "New York City",
        "stateCode": "NY",
        "coverageField": "procurement",
        "note": (
            "Official City Record procurement notices with solicitation-specific "
            "contact fields, narrowed to canopy, pergola, and partition-wall relevance."
        ),
    }
    return SourceRefreshResult(NYC_CROL_SOURCE_ID, projects, source), warnings
