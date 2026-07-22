from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from html import unescape
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from .canopy import NORTHEAST_STATES, score_project
from .new_jersey import (
    DPMC_SOURCE_ID,
    NJDOT_SOURCE_ID,
    HtmlTableParser,
    fetch_new_jersey_sources,
)
from .northeast_portals import (
    fetch_portal_sources,
    portal_source_coverage,
    portal_source_ids,
    portal_warning_prefixes,
)
from .source_refresh import SourceRefreshResult


MAINE_DOT_SOURCE_ID = "maine-dot-current-construction-bids"
MAINE_DOT_SOURCE_URL = "https://www.maine.gov/dot/doing-business/bid-opportunities"
NEW_YORK_DOT_SOURCE_ID = "new-york-dot-construction-contracts"
NEW_YORK_DOT_SOURCE_URL = "https://www.dot.ny.gov/doing-business/opportunities/const-notices"
SAM_SOURCE_URL = "https://sam.gov/search/?index=opp"
SAM_API_URL = "https://api.sam.gov/opportunities/v2/search"

STATIC_SOURCE_IDS = {
    DPMC_SOURCE_ID,
    NJDOT_SOURCE_ID,
    MAINE_DOT_SOURCE_ID,
    NEW_YORK_DOT_SOURCE_ID,
    *portal_source_ids(),
}
SAM_QUERIES = (
    "canopy",
    "canopies",
    "awning",
    "covered walkway",
    "shade structure",
    "passenger shelter",
    "entrance renovation",
)
MAX_SOURCE_BYTES = 5_000_000
MAX_SAM_BYTES = 10_000_000


def sam_source_id(state: str) -> str:
    return f"sam-gov-canopy-{state.casefold()}"


def configured_source_ids(sam_enabled: bool) -> set[str]:
    source_ids = set(STATIC_SOURCE_IDS)
    if sam_enabled:
        source_ids.update(sam_source_id(state) for state in NORTHEAST_STATES)
    return source_ids


def northeast_source_coverage(sam_enabled: bool) -> dict[str, tuple[tuple[str, ...], str]]:
    coverage = {
        DPMC_SOURCE_ID: (("NJ",), "procurement"),
        NJDOT_SOURCE_ID: (("NJ",), "dotBidding"),
        MAINE_DOT_SOURCE_ID: (("ME",), "dotBidding"),
        NEW_YORK_DOT_SOURCE_ID: (("NY",), "dotBidding"),
        **portal_source_coverage(),
    }
    if sam_enabled:
        coverage.update(
            {
                sam_source_id(state): ((state,), "federalProcurement")
                for state in NORTHEAST_STATES
            }
        )
    return coverage


def northeast_warning_prefixes() -> tuple[str, ...]:
    return (
        "NJ DPMC construction advertisements:",
        "NJDOT current advertised projects:",
        "MaineDOT current construction bids:",
        "NYSDOT construction contract documents:",
        "SAM.gov ",
        *portal_warning_prefixes(),
    )


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value)).strip()


def _parse_date(value: Any) -> date | None:
    text = _clean_text(str(value or ""))
    iso_match = re.search(r"\d{4}-\d{2}-\d{2}", text)
    if iso_match:
        try:
            return date.fromisoformat(iso_match.group(0))
        except ValueError:
            pass
    for pattern, date_format in (
        (r"\d{1,2}/\d{1,2}/\d{4}", "%m/%d/%Y"),
        (r"[A-Z][a-z]+ \d{1,2}, \d{4}", "%B %d, %Y"),
    ):
        match = re.search(pattern, text)
        if not match:
            continue
        try:
            return datetime.strptime(match.group(0), date_format).date()
        except ValueError:
            continue
    return None


def _official_link(base_url: str, href: str, allowed_hosts: set[str]) -> str | None:
    resolved = urljoin(base_url, href.strip())
    parsed = urlparse(resolved)
    if parsed.scheme != "https" or parsed.hostname not in allowed_hosts:
        return None
    return resolved


def fetch_official_html(url: str, timeout_seconds: int = 30) -> str:
    expected_host = urlparse(url).hostname
    user_agent = "curl/8.0" if expected_host == "www.mass.gov" else (
        "Mozilla/5.0 (compatible; BidAtlas/1.0; public construction index)"
    )
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": user_agent,
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        if urlparse(response.geturl()).hostname != expected_host:
            raise ValueError("Official source redirected to an unexpected host")
        payload = response.read(MAX_SOURCE_BYTES + 1)
        if len(payload) > MAX_SOURCE_BYTES:
            raise ValueError("Official source exceeded the response-size limit")
        charset = response.headers.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def _source_document(name: str, url: str) -> dict[str, str]:
    return {
        "name": name,
        "kind": "solicitation",
        "url": url,
        "access": "public",
        "indexStatus": "metadata-only",
    }


def parse_maine_dot_projects(
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
        if len(row) < 6:
            continue
        deadline = _parse_date(row[0].text)
        posted_at = _parse_date(row[5].text)
        status = _clean_text(row[4].text)
        record_id = _clean_text(row[1].text)
        detail_url = next(
            (
                url
                for href, _ in row[1].links
                if (url := _official_link(
                    MAINE_DOT_SOURCE_URL,
                    href,
                    {"maine.gov", "www.maine.gov"},
                ))
            ),
            None,
        )
        if not deadline or not record_id or not detail_url:
            continue
        normalized_status = status.casefold()
        if "cancel" in normalized_status:
            stage = "cancelled"
        elif "award" in normalized_status:
            stage = "awarded"
        elif deadline >= current_date:
            stage = "bidding"
        else:
            stage = "bid-opened"
        summary = _clean_text(row[3].text)
        city = _clean_text(row[2].text)
        projects.append(
            {
                "id": f"{MAINE_DOT_SOURCE_ID}:{record_id}",
                "sourceId": MAINE_DOT_SOURCE_ID,
                "sourceRecordId": record_id,
                "title": summary or f"MaineDOT construction project {record_id}",
                "summary": summary,
                "stage": stage,
                "status": status or "Published",
                "agency": "Maine Department of Transportation",
                "city": city,
                "state": "ME",
                "postedAt": posted_at.isoformat() if posted_at else None,
                "updatedAt": checked_at,
                "bidDate": deadline.isoformat(),
                "bidDateTimeZone": "America/New_York",
                "sourceName": "MaineDOT Current Construction Bid Projects",
                "sourceUrl": detail_url,
                "provenance": "live-public-page",
                "confidence": "official",
                "documents": [_source_document(f"Official MaineDOT bid page {record_id}", detail_url)],
                "participants": [
                    {
                        "name": "Maine Department of Transportation",
                        "role": "agency",
                        "participantType": "organization",
                        "organization": "Maine Department of Transportation",
                        "sourceUrl": detail_url,
                    }
                ],
                "searchableFields": [record_id, summary, city, "Maine"],
                "documentTextIndexed": False,
            }
        )

    source = {
        "id": MAINE_DOT_SOURCE_ID,
        "name": "MaineDOT Current Construction Bid Projects",
        "owner": "Maine Department of Transportation",
        "level": "state",
        "sourceClass": "procurement",
        "stages": ["bidding", "bid-opened", "awarded", "cancelled"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "projects",
        "loadedCount": len(projects),
        "snapshotComplete": True,
        "lastChecked": checked_at,
        "url": MAINE_DOT_SOURCE_URL,
        "jurisdiction": "Maine",
        "stateCode": "ME",
        "coverageField": "dotBidding",
        "note": "Official MaineDOT current construction bid table with WIN, municipality, scope, status, and bid date.",
    }
    return SourceRefreshResult(MAINE_DOT_SOURCE_ID, projects, source)


def parse_new_york_dot_projects(
    source_html: str,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> SourceRefreshResult:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    parser = HtmlTableParser("myTable")
    parser.feed(source_html)
    projects: list[dict[str, Any]] = []

    for row in parser.rows:
        if len(row) < 2:
            continue
        deadline = _parse_date(row[1].text)
        record_match = re.search(r"\bD\d{6}\b", row[0].text, re.I)
        if not deadline or deadline < current_date or not record_match:
            continue
        record_id = record_match.group(0).upper()
        detail_url = next(
            (
                url
                for href, link_text in row[0].links
                if record_id.casefold() in link_text.casefold()
                and (url := _official_link(
                    NEW_YORK_DOT_SOURCE_URL,
                    href,
                    {"dot.ny.gov", "www.dot.ny.gov"},
                ))
            ),
            None,
        )
        if not detail_url:
            continue
        title = f"NYSDOT construction contract {record_id}"
        projects.append(
            {
                "id": f"{NEW_YORK_DOT_SOURCE_ID}:{record_id}",
                "sourceId": NEW_YORK_DOT_SOURCE_ID,
                "sourceRecordId": record_id,
                "title": title,
                "summary": f"Official NYSDOT construction contract documents advertised for letting on {deadline.isoformat()}.",
                "stage": "bidding",
                "status": "Advertised",
                "agency": "New York State Department of Transportation",
                "state": "NY",
                "updatedAt": checked_at,
                "bidDate": deadline.isoformat(),
                "bidDateTimeZone": "America/New_York",
                "sourceName": "NYSDOT Construction Contract Documents",
                "sourceUrl": detail_url,
                "provenance": "live-public-page",
                "confidence": "official",
                "documents": [_source_document(f"Official NYSDOT contract documents {record_id}", detail_url)],
                "participants": [
                    {
                        "name": "New York State Department of Transportation",
                        "role": "agency",
                        "participantType": "organization",
                        "organization": "New York State Department of Transportation",
                        "sourceUrl": detail_url,
                    }
                ],
                "searchableFields": [record_id, title, "New York"],
                "documentTextIndexed": False,
            }
        )

    source = {
        "id": NEW_YORK_DOT_SOURCE_ID,
        "name": "NYSDOT Construction Contract Documents",
        "owner": "New York State Department of Transportation",
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
        "url": NEW_YORK_DOT_SOURCE_URL,
        "jurisdiction": "New York",
        "stateCode": "NY",
        "coverageField": "dotBidding",
        "note": "Official NYSDOT currently advertised construction contract document routes and letting dates.",
    }
    return SourceRefreshResult(NEW_YORK_DOT_SOURCE_ID, projects, source)


def fetch_sam_json(url: str, timeout_seconds: int = 45) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "BidAtlas/1.0 public-construction-index",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            if urlparse(response.geturl()).hostname != "api.sam.gov":
                raise ValueError("SAM.gov redirected to an unexpected host")
            payload = response.read(MAX_SAM_BYTES + 1)
            if len(payload) > MAX_SAM_BYTES:
                raise ValueError("SAM.gov response exceeded the response-size limit")
    except HTTPError as error:
        raise RuntimeError(f"SAM.gov request returned HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError("SAM.gov request could not be reached") from error
    value = json.loads(payload.decode("utf-8", errors="replace"))
    if not isinstance(value, dict):
        raise ValueError("SAM.gov returned an unexpected response")
    return value


def _nested_name(value: Any, *, prefer_code: bool = False) -> str:
    if not isinstance(value, dict):
        return _clean_text(str(value or ""))
    keys = ("code", "name") if prefer_code else ("name", "code")
    return next((_clean_text(str(value.get(key) or "")) for key in keys if value.get(key)), "")


def _sam_contact(record: dict[str, Any]) -> list[dict[str, str]]:
    contacts: list[dict[str, str]] = []
    for contact in record.get("pointOfContact") or []:
        if not isinstance(contact, dict):
            continue
        email = _clean_text(str(contact.get("email") or "")).lower()
        if email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            email = ""
        contacts.append(
            {
                "name": _clean_text(str(contact.get("fullName") or contact.get("title") or "Contracting Officer")),
                "role": _clean_text(str(contact.get("type") or "published contact")),
                "participantType": "person",
                "organization": _clean_text(str(record.get("subTier") or record.get("department") or "")),
                "email": email,
                "phone": _clean_text(str(contact.get("phone") or "")),
                "sourceUrl": _clean_text(str(record.get("uiLink") or SAM_SOURCE_URL)),
            }
        )
    return contacts


def _normalize_sam_project(record: dict[str, Any], state: str, checked_at: str) -> dict[str, Any] | None:
    notice_id = _clean_text(str(record.get("noticeId") or ""))
    title = _clean_text(str(record.get("title") or ""))
    if not notice_id or not title:
        return None
    place = record.get("placeOfPerformance") if isinstance(record.get("placeOfPerformance"), dict) else {}
    record_state = _nested_name(place.get("state"), prefer_code=True).upper() or state
    if record_state != state:
        return None
    deadline = _parse_date(record.get("responseDeadLine"))
    posted = _parse_date(record.get("postedDate"))
    ui_link = _official_link(
        SAM_SOURCE_URL,
        _clean_text(str(record.get("uiLink") or f"https://sam.gov/opp/{notice_id}/view")),
        {"sam.gov", "www.sam.gov"},
    ) or f"https://sam.gov/opp/{notice_id}/view"
    agency = _clean_text(str(record.get("subTier") or record.get("department") or "Federal agency"))
    solicitation = _clean_text(str(record.get("solicitationNumber") or notice_id))
    project: dict[str, Any] = {
        "id": f"{sam_source_id(state)}:{notice_id}",
        "sourceId": sam_source_id(state),
        "sourceRecordId": solicitation,
        "title": title,
        "summary": title,
        "stage": "bidding",
        "status": _clean_text(str(record.get("type") or "Active federal opportunity")),
        "agency": agency,
        "city": _nested_name(place.get("city")),
        "state": state,
        "postedAt": posted.isoformat() if posted else None,
        "updatedAt": checked_at,
        "bidDate": deadline.isoformat() if deadline else None,
        "bidDateTimeZone": "America/New_York",
        "sourceName": f"SAM.gov Canopy Opportunities - {state}",
        "sourceUrl": ui_link,
        "provenance": "live-public-api",
        "confidence": "official",
        "documents": [_source_document(f"Official SAM.gov notice {solicitation}", ui_link)],
        "participants": _sam_contact(record),
        "searchableFields": [
            solicitation,
            agency,
            _clean_text(str(record.get("department") or "")),
            _clean_text(str(record.get("fullParentPathName") or "")),
            _clean_text(str(record.get("naicsCode") or "")),
            _clean_text(str(record.get("classificationCode") or "")),
        ],
        "naicsCode": _clean_text(str(record.get("naicsCode") or "")),
        "documentTextIndexed": False,
    }
    return project if score_project(project)["score"] >= 6 else None


def fetch_sam_state(
    state: str,
    api_key: str,
    fetch_json: Callable[[str], dict[str, Any]] = fetch_sam_json,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[SourceRefreshResult | None, list[str]]:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    records: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    successful_queries = 0
    complete = True

    for query in SAM_QUERIES:
        params: list[tuple[str, str]] = [
            ("api_key", api_key),
            ("postedFrom", (current_date - timedelta(days=364)).strftime("%m/%d/%Y")),
            ("postedTo", current_date.strftime("%m/%d/%Y")),
            ("limit", "100"),
            ("offset", "0"),
            ("status", "active"),
            ("state", state),
            ("title", query),
        ]
        params.extend(("ptype", item) for item in ("p", "o", "k", "r"))
        try:
            payload = fetch_json(f"{SAM_API_URL}?{urlencode(params)}")
            page_records = payload.get("opportunitiesData")
            if not isinstance(page_records, list):
                raise ValueError("response did not contain an opportunitiesData list")
            successful_queries += 1
            if int(payload.get("totalRecords") or 0) > len(page_records):
                complete = False
                warnings.append(f"SAM.gov {state}: {query!r} results exceeded the guarded page limit")
            for record in page_records:
                if isinstance(record, dict) and record.get("noticeId"):
                    records.setdefault(str(record["noticeId"]), record)
        except Exception as error:
            complete = False
            warnings.append(f"SAM.gov {state}: {query!r} query failed: {error}")

    if successful_queries == 0:
        return None, warnings

    projects = [
        project
        for record in records.values()
        if (project := _normalize_sam_project(record, state, checked_at)) is not None
        and (not project.get("bidDate") or str(project["bidDate"]) >= current_date.isoformat())
    ]
    projects.sort(key=lambda project: (-score_project(project)["score"], str(project.get("bidDate") or "9999-12-31")))
    source = {
        "id": sam_source_id(state),
        "name": f"SAM.gov Canopy Opportunities - {state}",
        "owner": "U.S. General Services Administration",
        "level": "federal",
        "sourceClass": "procurement",
        "stages": ["bidding"],
        "status": "live",
        "access": "api-key",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "qualified projects",
        "loadedCount": len(projects),
        "snapshotComplete": complete,
        "lastChecked": checked_at,
        "url": SAM_SOURCE_URL,
        "jurisdiction": state,
        "stateCode": state,
        "coverageField": "federalProcurement",
        "note": "Official SAM.gov active opportunities filtered by place of performance and canopy relevance. This is federal, not statewide procurement coverage.",
    }
    return SourceRefreshResult(sam_source_id(state), projects, source), warnings


def fetch_northeast_sources(
    *,
    sam_api_key: str = "",
    fetch_html: Callable[[str], str] = fetch_official_html,
    fetch_json: Callable[[str], dict[str, Any]] = fetch_sam_json,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[list[SourceRefreshResult | Any], list[str]]:
    """Refresh every independent source without letting one portal stop the region."""

    results: list[SourceRefreshResult | Any] = []
    warnings: list[str] = []
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    nj_results, nj_warnings = fetch_new_jersey_sources(
        fetch_html,
        today=today,
        fetched_at=checked_at,
    )
    results.extend(nj_results)
    warnings.extend(nj_warnings)

    static_parsers = (
        (
            MAINE_DOT_SOURCE_URL,
            parse_maine_dot_projects,
            "MaineDOT current construction bids",
        ),
        (
            NEW_YORK_DOT_SOURCE_URL,
            parse_new_york_dot_projects,
            "NYSDOT construction contract documents",
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

    portal_results, portal_warnings = fetch_portal_sources(
        fetch_html,
        today=today,
        fetched_at=checked_at,
    )
    results.extend(portal_results)
    warnings.extend(portal_warnings)

    if sam_api_key:
        with ThreadPoolExecutor(max_workers=min(6, len(NORTHEAST_STATES))) as executor:
            futures = {
                executor.submit(
                    fetch_sam_state,
                    state,
                    sam_api_key,
                    fetch_json,
                    today=today,
                    fetched_at=checked_at,
                ): state
                for state in NORTHEAST_STATES
            }
            for future in as_completed(futures):
                state_result, state_warnings = future.result()
                if state_result:
                    results.append(state_result)
                warnings.extend(state_warnings)
    return results, warnings
