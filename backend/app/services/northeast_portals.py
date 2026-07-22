from __future__ import annotations

import hashlib
import hmac
import json
import re
import ssl
from dataclasses import dataclass
from datetime import date, datetime, timezone
from functools import lru_cache
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .canopy import score_project
from .new_jersey import HtmlTableParser
from .source_refresh import SourceRefreshResult


CONNECTICUT_SOURCE_ID = "connecticut-ctsource-canopy-opportunities"
CONNECTICUT_SOURCE_URL = "https://portal.ct.gov/das/ctsource/bidboard"
RHODE_ISLAND_SOURCE_ID = "rhode-island-ridot-canopy-opportunities"
RHODE_ISLAND_SOURCE_URL = "https://www.dot.ri.gov/ridotbidding/"
MASSACHUSETTS_SOURCE_ID = "massachusetts-dcr-construction-bids"
MASSACHUSETTS_SOURCE_URL = "https://www.mass.gov/info-details/dcr-contracts-and-procurement"
NEW_HAMPSHIRE_SOURCE_ID = "new-hampshire-dot-project-pipeline"
NEW_HAMPSHIRE_SOURCE_URL = (
    "https://maps.dot.nh.gov/arcgis_server/rest/services/Projects/"
    "NHDOT_PROJECT_PROPOSALS_BY_TYPE/FeatureServer/0"
)
VERMONT_SOURCE_ID = "vermont-vtrans-project-pipeline"
VERMONT_SOURCE_URL = (
    "https://maps.vtrans.vermont.gov/arcgis/rest/services/Rail/VTransProjects/FeatureServer"
)
PENNSYLVANIA_SOURCE_ID = "pennsylvania-dgs-current-construction-projects"
PENNSYLVANIA_SOURCE_URL = (
    "https://www.pa.gov/agencies/dgs/submit-proposals-and-bids-for-commonwealth-projects"
)

WEBPROCURE_API_URL = "https://webprocure.proactiscloud.com/wp-full-text-search"
WEBPROCURE_HOST = "webprocure.proactiscloud.com"
WEBPROCURE_CA_SHA256 = "4bcc5e234fe81ede4eaf883aa19c31335b0b26e85e066b9945e4cb6153eb20c2"
MAX_JSON_BYTES = 12_000_000
EMAIL_PATTERN = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


@dataclass(frozen=True)
class WebProcureConfig:
    source_id: str
    source_url: str
    state: str
    jurisdiction: str
    owner: str
    customer_id: str
    organization_id: str
    coverage_field: str


WEBPROCURE_SOURCES = (
    WebProcureConfig(
        CONNECTICUT_SOURCE_ID,
        CONNECTICUT_SOURCE_URL,
        "CT",
        "Connecticut",
        "Connecticut Department of Administrative Services",
        "51",
        "-1",
        "procurement",
    ),
    WebProcureConfig(
        RHODE_ISLAND_SOURCE_ID,
        RHODE_ISLAND_SOURCE_URL,
        "RI",
        "Rhode Island",
        "Rhode Island Department of Transportation",
        "46",
        "130573",
        "dotBidding",
    ),
)


def portal_source_ids() -> set[str]:
    return {
        *(config.source_id for config in WEBPROCURE_SOURCES),
        MASSACHUSETTS_SOURCE_ID,
        NEW_HAMPSHIRE_SOURCE_ID,
        VERMONT_SOURCE_ID,
        PENNSYLVANIA_SOURCE_ID,
    }


def portal_source_coverage() -> dict[str, tuple[tuple[str, ...], str]]:
    return {
        CONNECTICUT_SOURCE_ID: (("CT",), "procurement"),
        RHODE_ISLAND_SOURCE_ID: (("RI",), "dotBidding"),
        MASSACHUSETTS_SOURCE_ID: (("MA",), "procurement"),
        NEW_HAMPSHIRE_SOURCE_ID: (("NH",), "planning"),
        VERMONT_SOURCE_ID: (("VT",), "planning"),
        PENNSYLVANIA_SOURCE_ID: (("PA",), "procurement"),
    }


def portal_warning_prefixes() -> tuple[str, ...]:
    return (
        "CTsource public bid board:",
        "RIDOT public bid board:",
        "Massachusetts DCR construction bids:",
        "NHDOT project service:",
        "VTrans project service:",
        "Pennsylvania DGS construction projects:",
    )


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", unescape(str(value or ""))).strip()


@lru_cache(maxsize=1)
def _webprocure_ssl_context() -> ssl.SSLContext:
    """Complete WebProcure's currently incomplete public certificate chain."""

    certificate_path = (
        Path(__file__).resolve().parent.parent
        / "certificates"
        / "ThawteTLSRSACAG1.crt.pem"
    )
    certificate_pem = certificate_path.read_text(encoding="ascii")
    certificate_der = ssl.PEM_cert_to_DER_cert(certificate_pem)
    actual_sha256 = hashlib.sha256(certificate_der).hexdigest()
    if not hmac.compare_digest(actual_sha256, WEBPROCURE_CA_SHA256):
        raise RuntimeError("Bundled WebProcure intermediate certificate failed validation")

    context = ssl.create_default_context()
    context.load_verify_locations(cafile=str(certificate_path))
    return context


def _iso_from_epoch(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _official_document(name: str, url: str) -> dict[str, str]:
    return {
        "name": name,
        "kind": "solicitation",
        "url": url,
        "access": "public",
        "indexStatus": "metadata-only",
    }


def fetch_public_json(url: str, timeout_seconds: int = 45) -> dict[str, Any]:
    allowed_hosts = {
        "webprocure.proactiscloud.com",
        "maps.dot.nh.gov",
        "maps.vtrans.vermont.gov",
    }
    hostname = urlparse(url).hostname
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "BidAtlas/1.0 public-construction-index"},
    )
    ssl_context = _webprocure_ssl_context() if hostname == WEBPROCURE_HOST else None
    try:
        with urlopen(request, timeout=timeout_seconds, context=ssl_context) as response:
            if urlparse(response.geturl()).hostname not in allowed_hosts:
                raise ValueError("Public data service redirected to an unexpected host")
            payload = response.read(MAX_JSON_BYTES + 1)
            if len(payload) > MAX_JSON_BYTES:
                raise ValueError("Public data response exceeded the response-size limit")
    except HTTPError as error:
        raise RuntimeError(f"Public data request returned HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError("Public data service could not be reached") from error
    value = json.loads(payload.decode("utf-8", errors="replace"))
    if not isinstance(value, dict):
        raise ValueError("Public data service returned an unexpected response")
    if value.get("error"):
        raise ValueError("Public data service returned an application error")
    return value


def _webprocure_url(config: WebProcureConfig, bid_id: Any) -> str:
    query = urlencode({"customerid": config.customer_id, "oid": config.organization_id})
    return (
        "https://webprocure.proactiscloud.com/wp-web-public/"
        f"#/bidboard/bid/{bid_id}?{query}"
    )


def _contact_from_text(value: Any, source_url: str) -> list[dict[str, str]]:
    text = str(value or "")
    contacts: list[dict[str, str]] = []
    seen: set[str] = set()
    for email in EMAIL_PATTERN.findall(text):
        normalized = email.rstrip(".,;:").lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        name = lines[0] if lines and normalized not in lines[0].lower() else "Published project contact"
        contacts.append(
            {
                "name": name[:200],
                "role": "published contact",
                "participantType": "person",
                "organization": "",
                "email": normalized,
                "phone": "",
                "sourceUrl": source_url,
            }
        )
    return contacts


def fetch_webprocure_source(
    config: WebProcureConfig,
    fetch_html: Callable[[str], str],
    fetch_json: Callable[[str], dict[str, Any]] = fetch_public_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[SourceRefreshResult, list[str]]:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    wrapper_html = fetch_html(config.source_url)
    if f"'_customerid', {config.customer_id}" not in wrapper_html:
        raise ValueError("official page no longer identifies the expected public bid board")

    warnings: list[str] = []
    records: list[dict[str, Any]] = []
    expected_hits: int | None = None
    for offset in range(0, 500, 10):
        params = {
            "customerid": config.customer_id,
            "q": "*",
            "from": str(offset),
            "sort": "r",
            "f": "ps=Open",
            "oids": "" if config.organization_id == "-1" else config.organization_id,
            "oid": config.organization_id,
        }
        payload = fetch_json(f"{WEBPROCURE_API_URL}/search/sols?{urlencode(params)}")
        page_records = payload.get("records")
        if not isinstance(page_records, list):
            raise ValueError("public bid board response did not include records")
        records.extend(record for record in page_records if isinstance(record, dict))
        expected_hits = int(payload.get("hits") or 0)
        if len(records) >= expected_hits or not page_records:
            break
    complete = expected_hits is not None and len(records) >= expected_hits
    if not complete:
        warnings.append(
            f"{config.jurisdiction} public bid board exceeded the guarded 500-record limit"
        )

    projects: list[dict[str, Any]] = []
    for record in records:
        bid_id = record.get("bidid")
        title = _clean_text(record.get("title"))
        if not bid_id or not title:
            continue
        source_url = _webprocure_url(config, bid_id)
        deadline = _iso_from_epoch(record.get("openDate"))
        if deadline and deadline < current_date.isoformat():
            continue
        description = _clean_text(record.get("description"))
        creator = record.get("creatorOrg") if isinstance(record.get("creatorOrg"), dict) else {}
        agency = _clean_text(creator.get("name")) or config.owner
        bid_number = _clean_text(record.get("bidNumber")) or str(bid_id)
        project: dict[str, Any] = {
            "id": f"{config.source_id}:{bid_id}",
            "sourceId": config.source_id,
            "sourceRecordId": bid_number,
            "title": title,
            "summary": description or title,
            "stage": "bidding",
            "status": _clean_text(
                (record.get("orgBidClassType") or {}).get("description")
                if isinstance(record.get("orgBidClassType"), dict)
                else "Open"
            ) or "Open",
            "agency": agency,
            "state": config.state,
            "postedAt": _iso_from_epoch(record.get("startDate") or record.get("statusDate")),
            "updatedAt": checked_at,
            "bidDate": deadline,
            "bidDateTimeZone": "America/New_York",
            "sourceName": f"{config.jurisdiction} Public Bid Board",
            "sourceUrl": source_url,
            "provenance": "live-public-portal",
            "confidence": "official",
            "documents": [_official_document(f"Public bid notice {bid_number}", source_url)],
            "participants": [],
            "searchableFields": [bid_number, title, description, agency, config.jurisdiction],
            "documentTextIndexed": False,
        }
        if score_project(project)["score"] < 8:
            continue
        try:
            detail_url = (
                f"{WEBPROCURE_API_URL}/soldetail/{bid_id}?"
                + urlencode({"customerid": config.customer_id, "oid": config.organization_id})
            )
            detail = fetch_json(detail_url)
            detail_records = detail.get("records") or []
            detailed = detail_records[0] if detail_records else record
        except Exception:
            detailed = record
            warnings.append(f"{config.jurisdiction} bid {bid_number}: contact detail was unavailable")
        contact_text = "\n".join(
            str(contact.get("bidContactDetail", {}).get("contactinfo") or "")
            for contact in detailed.get("bidContacts") or []
            if isinstance(contact, dict)
        )
        project["participants"] = _contact_from_text(
            f"{contact_text}\n{description}",
            source_url,
        )
        projects.append(project)

    source = {
        "id": config.source_id,
        "name": f"{config.jurisdiction} Public Canopy Opportunities",
        "owner": config.owner,
        "level": "state",
        "sourceClass": "procurement",
        "stages": ["bidding"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "qualified projects",
        "loadedCount": len(projects),
        "snapshotComplete": complete,
        "lastChecked": checked_at,
        "url": config.source_url,
        "jurisdiction": config.jurisdiction,
        "stateCode": config.state,
        "coverageField": config.coverage_field,
        "note": "Official state-embedded public bid board, narrowed to canopy-relevant records after retrieving the complete open board.",
    }
    return SourceRefreshResult(config.source_id, projects, source), warnings


def parse_massachusetts_dcr_projects(
    source_html: str,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> SourceRefreshResult:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    parser = HtmlTableParser()
    parser.feed(source_html)
    projects: list[dict[str, Any]] = []
    for row in parser.rows:
        if len(row) != 3 or not re.fullmatch(r"[A-Z]\d{2}-[\w.-]+", row[0].text, re.I):
            continue
        try:
            deadline = datetime.strptime(row[2].text.strip(), "%m/%d/%Y").date()
        except ValueError:
            continue
        if deadline < current_date:
            continue
        record_id = row[0].text.strip().upper()
        title = _clean_text(row[1].text)
        projects.append(
            {
                "id": f"{MASSACHUSETTS_SOURCE_ID}:{record_id}",
                "sourceId": MASSACHUSETTS_SOURCE_ID,
                "sourceRecordId": record_id,
                "title": title,
                "summary": title,
                "stage": "bidding",
                "status": "Bid responses sought",
                "agency": "Massachusetts Department of Conservation and Recreation",
                "state": "MA",
                "updatedAt": checked_at,
                "bidDate": deadline.isoformat(),
                "bidDateTimeZone": "America/New_York",
                "sourceName": "Massachusetts DCR Construction Contracts",
                "sourceUrl": MASSACHUSETTS_SOURCE_URL,
                "provenance": "live-public-page",
                "confidence": "official",
                "documents": [_official_document(f"Official DCR listing {record_id}", MASSACHUSETTS_SOURCE_URL)],
                "participants": [
                    {
                        "name": "Robert Boncore",
                        "role": "Director of Contracts and Procurement",
                        "participantType": "person",
                        "organization": "Massachusetts Department of Conservation and Recreation",
                        "email": "robert.boncore@mass.gov",
                        "phone": "",
                        "sourceUrl": MASSACHUSETTS_SOURCE_URL,
                    }
                ],
                "searchableFields": [record_id, title, "Massachusetts"],
                "documentTextIndexed": False,
            }
        )
    source = {
        "id": MASSACHUSETTS_SOURCE_ID,
        "name": "Massachusetts DCR Construction Contracts",
        "owner": "Massachusetts Department of Conservation and Recreation",
        "level": "state",
        "sourceClass": "procurement",
        "stages": ["bidding"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "projects",
        "loadedCount": len(projects),
        "snapshotComplete": True,
        "lastChecked": checked_at,
        "url": MASSACHUSETTS_SOURCE_URL,
        "jurisdiction": "Massachusetts",
        "stateCode": "MA",
        "coverageField": "procurement",
        "note": "Official DCR construction contracts currently seeking bid responses.",
    }
    return SourceRefreshResult(MASSACHUSETTS_SOURCE_ID, projects, source)


def _arcgis_features(
    layer_url: str,
    where: str,
    fetch_json: Callable[[str], dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool]:
    features: list[dict[str, Any]] = []
    complete = True
    for offset in range(0, 5_000, 1_000):
        params = {
            "where": where,
            "outFields": "*",
            "returnGeometry": "false",
            "f": "json",
            "resultOffset": str(offset),
            "resultRecordCount": "1000",
        }
        payload = fetch_json(f"{layer_url}/query?{urlencode(params)}")
        page = payload.get("features")
        if not isinstance(page, list):
            raise ValueError("ArcGIS response did not include features")
        features.extend(
            feature["attributes"]
            for feature in page
            if isinstance(feature, dict) and isinstance(feature.get("attributes"), dict)
        )
        if not payload.get("exceededTransferLimit"):
            break
    else:
        complete = False
    return features, complete


def fetch_new_hampshire_projects(
    fetch_json: Callable[[str], dict[str, Any]] = fetch_public_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> SourceRefreshResult:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    records, complete = _arcgis_features(
        NEW_HAMPSHIRE_SOURCE_URL,
        "IS_CURRENT = 'YES' AND INTERNET_DISPLAY = 'YES' AND PROJECT_TYPE <> 'Completed'",
        fetch_json,
    )
    projects: list[dict[str, Any]] = []
    for record in records:
        record_id = _clean_text(record.get("PROJ_NUMBER"))
        description = _clean_text(record.get("PROJ_DESCRIPTION"))
        title = " - ".join(value for value in (_clean_text(record.get("PROJ_NAME")), description) if value)
        if not record_id or not title:
            continue
        bid_date = _iso_from_epoch(record.get("BID_DATE"))
        project_type = _clean_text(record.get("PROJECT_TYPE")).casefold()
        if bid_date and bid_date >= current_date.isoformat():
            stage = "bidding"
        elif project_type == "construction":
            stage = "construction"
        elif project_type == "design":
            stage = "design"
        else:
            stage = "planning"
        project_url = _clean_text(record.get("PROJECT_INFO"))
        project_host = urlparse(project_url).hostname or ""
        if not project_url.startswith("https://") or not project_host.endswith("nh.gov"):
            project_url = NEW_HAMPSHIRE_SOURCE_URL
        documents = [_official_document(f"NHDOT project record {record_id}", project_url)]
        plan_url = _clean_text(record.get("PROJECT_PLANS"))
        plan_host = urlparse(plan_url).hostname or ""
        if plan_url.startswith("https://") and plan_host.endswith("nh.gov"):
            documents.append(_official_document(f"NHDOT project plans {record_id}", plan_url))
        project: dict[str, Any] = {
            "id": f"{NEW_HAMPSHIRE_SOURCE_ID}:{record_id}",
            "sourceId": NEW_HAMPSHIRE_SOURCE_ID,
            "sourceRecordId": record_id,
            "title": title,
            "summary": description,
            "stage": stage,
            "status": _clean_text(record.get("PROJECT_TYPE")) or "Current",
            "agency": "New Hampshire Department of Transportation",
            "city": _clean_text(record.get("PROJ_NAME")),
            "state": "NH",
            "postedAt": _iso_from_epoch(record.get("AD_DATE")),
            "updatedAt": checked_at,
            "bidDate": bid_date,
            "bidDateTimeZone": "America/New_York",
            "sourceName": "NHDOT Current Project Pipeline",
            "sourceUrl": project_url,
            "provenance": "live-public-api",
            "confidence": "official",
            "documents": documents,
            "participants": [
                {
                    "name": _clean_text(record.get("CONTACT_NAME")) or "NHDOT project contact",
                    "role": "project contact",
                    "participantType": "person",
                    "organization": "New Hampshire Department of Transportation",
                    "email": "",
                    "phone": _clean_text(record.get("CONTACT_PHONE")),
                    "sourceUrl": project_url,
                }
            ],
            "searchableFields": [record_id, title, description, "New Hampshire"],
            "documentTextIndexed": False,
        }
        if score_project(project)["score"] >= 8:
            projects.append(project)
    source = {
        "id": NEW_HAMPSHIRE_SOURCE_ID,
        "name": "NHDOT Canopy-Relevant Project Pipeline",
        "owner": "New Hampshire Department of Transportation",
        "level": "state",
        "sourceClass": "planning",
        "stages": ["planning", "design", "bidding", "construction"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "qualified projects",
        "loadedCount": len(projects),
        "snapshotComplete": complete,
        "lastChecked": checked_at,
        "url": NEW_HAMPSHIRE_SOURCE_URL,
        "jurisdiction": "New Hampshire",
        "stateCode": "NH",
        "coverageField": "planning",
        "note": "Official NHDOT current-project service narrowed to canopy-relevant planning through construction records.",
    }
    return SourceRefreshResult(NEW_HAMPSHIRE_SOURCE_ID, projects, source)


def _manager_name(value: Any) -> str:
    text = _clean_text(value)
    if "," not in text:
        return text
    last, first = (part.strip() for part in text.split(",", 1))
    return f"{first} {last}".strip()


def fetch_vermont_projects(
    fetch_html: Callable[[str], str],
    fetch_json: Callable[[str], dict[str, Any]] = fetch_public_json,
    *,
    fetched_at: str | None = None,
) -> SourceRefreshResult:
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    records_by_pin: dict[str, dict[str, Any]] = {}
    complete = True
    for layer in (1, 2):
        records, layer_complete = _arcgis_features(
            f"{VERMONT_SOURCE_URL}/{layer}",
            "1=1",
            fetch_json,
        )
        complete = complete and layer_complete
        for record in records:
            pin = _clean_text(record.get("PIN"))
            if pin:
                records_by_pin.setdefault(pin, record)

    projects: list[dict[str, Any]] = []
    for pin, record in records_by_pin.items():
        local_name = _clean_text(record.get("LocalName"))
        project_name = _clean_text(record.get("ProjectName"))
        project_number = _clean_text(record.get("ProjectNumber"))
        description = _clean_text(record.get("Description"))
        title = local_name or " - ".join(value for value in (project_name, project_number) if value)
        status = _clean_text(record.get("Status"))
        stage = {
            "planned": "planning",
            "development": "design",
            "construction": "construction",
            "closing": "construction",
        }.get(status.casefold(), "planning")
        factsheet_url = f"https://resources.vtrans.vermont.gov/FactSheet/default.aspx?pin={pin}"
        project: dict[str, Any] = {
            "id": f"{VERMONT_SOURCE_ID}:{pin}",
            "sourceId": VERMONT_SOURCE_ID,
            "sourceRecordId": project_number or pin,
            "title": title,
            "summary": description or _clean_text(record.get("OrigRemarks")),
            "stage": stage,
            "status": status or "Current",
            "agency": "Vermont Agency of Transportation",
            "city": project_name,
            "state": "VT",
            "updatedAt": checked_at,
            "sourceName": "VTrans Active Project Pipeline",
            "sourceUrl": factsheet_url,
            "provenance": "live-public-api",
            "confidence": "official",
            "documents": [_official_document(f"VTrans project factsheet {pin}", factsheet_url)],
            "participants": [],
            "searchableFields": [
                pin,
                project_number,
                title,
                description,
                _clean_text(record.get("OrigRemarks")),
                _clean_text(record.get("CurrSteps")),
                _clean_text(record.get("NextSteps")),
                "Vermont",
            ],
            "documentTextIndexed": False,
        }
        if score_project(project)["score"] < 8:
            continue
        participants: list[dict[str, str]] = []
        try:
            factsheet = fetch_html(factsheet_url)
            emails = [
                email.lower()
                for email in EMAIL_PATTERN.findall(factsheet)
                if not email.lower().startswith("aot.caddgisweb")
            ]
        except Exception:
            emails = []
        manager = _manager_name(record.get("ProjMan")) or "VTrans project manager"
        participants.append(
            {
                "name": manager,
                "role": "project manager",
                "participantType": "person",
                "organization": "Vermont Agency of Transportation",
                "email": emails[0] if emails else "",
                "phone": "",
                "sourceUrl": factsheet_url,
            }
        )
        for role, value in (("consultant", record.get("Consultant")), ("contractor", record.get("Contractor"))):
            name = _clean_text(value)
            if name:
                participants.append(
                    {
                        "name": name,
                        "role": role,
                        "participantType": "organization",
                        "organization": name,
                        "email": "",
                        "phone": "",
                        "sourceUrl": factsheet_url,
                    }
                )
        project["participants"] = participants
        projects.append(project)
    source = {
        "id": VERMONT_SOURCE_ID,
        "name": "VTrans Canopy-Relevant Active Project Pipeline",
        "owner": "Vermont Agency of Transportation",
        "level": "state",
        "sourceClass": "planning",
        "stages": ["planning", "design", "construction"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "qualified projects",
        "loadedCount": len(projects),
        "snapshotComplete": complete,
        "lastChecked": checked_at,
        "url": VERMONT_SOURCE_URL,
        "jurisdiction": "Vermont",
        "stateCode": "VT",
        "coverageField": "planning",
        "note": "Official VTrans active-project service narrowed to canopy-relevant records, with published factsheet contacts when available.",
    }
    return SourceRefreshResult(VERMONT_SOURCE_ID, projects, source)


class _ListParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_item = False
        self.parts: list[str] = []
        self.items: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag == "li":
            self.in_item = True
            self.parts = []

    def handle_data(self, data: str) -> None:
        if self.in_item:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "li" and self.in_item:
            value = _clean_text(" ".join(self.parts))
            if value:
                self.items.append(value)
            self.in_item = False


def parse_pennsylvania_dgs_projects(
    source_html: str,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> SourceRefreshResult:
    del today
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    start = source_html.casefold().find("current projects bidding")
    end = source_html.casefold().find("awarded bids", start + 1)
    if start < 0 or end < 0:
        raise ValueError("current-project section was not found")
    parser = _ListParser()
    parser.feed(source_html[start:end])
    projects: list[dict[str, Any]] = []
    for title in parser.items:
        if not title.casefold().startswith("dgs "):
            continue
        record_id = title.split(" - ", 1)[0].strip()
        projects.append(
            {
                "id": f"{PENNSYLVANIA_SOURCE_ID}:{record_id}",
                "sourceId": PENNSYLVANIA_SOURCE_ID,
                "sourceRecordId": record_id,
                "title": title,
                "summary": title,
                "stage": "bidding",
                "status": "Current project bidding",
                "agency": "Pennsylvania Department of General Services",
                "state": "PA",
                "updatedAt": checked_at,
                "sourceName": "Pennsylvania DGS Current Projects Bidding",
                "sourceUrl": PENNSYLVANIA_SOURCE_URL,
                "provenance": "live-public-page",
                "confidence": "official",
                "documents": [_official_document(f"Official DGS project listing {record_id}", PENNSYLVANIA_SOURCE_URL)],
                "participants": [
                    {
                        "name": "Pennsylvania Department of General Services",
                        "role": "agency",
                        "participantType": "organization",
                        "organization": "Pennsylvania Department of General Services",
                        "sourceUrl": PENNSYLVANIA_SOURCE_URL,
                    }
                ],
                "searchableFields": [record_id, title, "Pennsylvania"],
                "documentTextIndexed": False,
            }
        )
    source = {
        "id": PENNSYLVANIA_SOURCE_ID,
        "name": "Pennsylvania DGS Current Projects Bidding",
        "owner": "Pennsylvania Department of General Services",
        "level": "state",
        "sourceClass": "procurement",
        "stages": ["bidding"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "projects",
        "loadedCount": len(projects),
        "snapshotComplete": True,
        "lastChecked": checked_at,
        "url": PENNSYLVANIA_SOURCE_URL,
        "jurisdiction": "Pennsylvania",
        "stateCode": "PA",
        "coverageField": "procurement",
        "note": "Official Pennsylvania DGS list of construction projects currently bidding; deadlines remain on the linked procurement system.",
    }
    return SourceRefreshResult(PENNSYLVANIA_SOURCE_ID, projects, source)


def fetch_portal_sources(
    fetch_html: Callable[[str], str],
    fetch_json: Callable[[str], dict[str, Any]] = fetch_public_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[list[SourceRefreshResult], list[str]]:
    results: list[SourceRefreshResult] = []
    warnings: list[str] = []
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    for config, label in zip(
        WEBPROCURE_SOURCES,
        ("CTsource public bid board", "RIDOT public bid board"),
        strict=True,
    ):
        try:
            result, source_warnings = fetch_webprocure_source(
                config,
                fetch_html,
                fetch_json,
                today=today,
                fetched_at=checked_at,
            )
            results.append(result)
            warnings.extend(f"{label}: {warning}" for warning in source_warnings)
        except Exception as error:
            warnings.append(f"{label}: {error}")

    static_parsers = (
        (
            MASSACHUSETTS_SOURCE_URL,
            parse_massachusetts_dcr_projects,
            "Massachusetts DCR construction bids",
        ),
        (
            PENNSYLVANIA_SOURCE_URL,
            parse_pennsylvania_dgs_projects,
            "Pennsylvania DGS construction projects",
        ),
    )
    for url, parser, label in static_parsers:
        try:
            result = parser(fetch_html(url), today=today, fetched_at=checked_at)
            if not result.projects:
                raise ValueError("the official page yielded no current project records")
            results.append(result)
        except Exception as error:
            warnings.append(f"{label}: {error}")

    try:
        results.append(fetch_new_hampshire_projects(fetch_json, today=today, fetched_at=checked_at))
    except Exception as error:
        warnings.append(f"NHDOT project service: {error}")
    try:
        results.append(fetch_vermont_projects(fetch_html, fetch_json, fetched_at=checked_at))
    except Exception as error:
        warnings.append(f"VTrans project service: {error}")
    return results, warnings
