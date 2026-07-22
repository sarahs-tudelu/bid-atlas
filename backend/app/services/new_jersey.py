from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from typing import Any, Callable
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from .source_refresh import merge_source_snapshot


DPMC_SOURCE_ID = "new-jersey-dpmc-construction-advertisements"
DPMC_SOURCE_URL = "https://www.nj.gov/treasury/dpmc/project_construction_advertisements.shtml"
NJDOT_SOURCE_ID = "new-jersey-dot-current-advertised-projects"
NJDOT_SOURCE_URL = "https://www.nj.gov/transportation/business/procurement/ConstrServ/curradvproj.shtm"

MAX_SOURCE_BYTES = 5_000_000
PROJECT_NUMBER = re.compile(r"\b([A-Z]\d{3,4}-\d{2})\b", re.IGNORECASE)
DP_NUMBER = re.compile(r"\bDP\s*(?:NO\.?|NUMBER)?\s*[:#-]?\s*(\d{4,6})\b", re.IGNORECASE)
MONEY = re.compile(r"\$?\s*([\d,]+(?:\.\d{1,2})?)")
DPMC_DATE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{4})\b")
NJDOT_DATE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{2})\b")

NJ_COUNTIES = (
    "Atlantic",
    "Bergen",
    "Burlington",
    "Camden",
    "Cape May",
    "Cumberland",
    "Essex",
    "Gloucester",
    "Hudson",
    "Hunterdon",
    "Mercer",
    "Middlesex",
    "Monmouth",
    "Morris",
    "Ocean",
    "Passaic",
    "Salem",
    "Somerset",
    "Sussex",
    "Union",
    "Warren",
)


@dataclass
class ParsedCell:
    text_parts: list[str] = field(default_factory=list)
    links: list[tuple[str, str]] = field(default_factory=list)

    @property
    def text(self) -> str:
        return _clean_text(" ".join(self.text_parts))


class HtmlTableParser(HTMLParser):
    """Small source-specific table parser with no third-party runtime dependency."""

    def __init__(self, table_id: str | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self.table_id = table_id
        self.table_depth = 0
        self.in_target_table = False
        self.in_row = False
        self.current_row: list[ParsedCell] = []
        self.current_cell: ParsedCell | None = None
        self.current_link_href: str | None = None
        self.current_link_text: list[str] = []
        self.rows: list[list[ParsedCell]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "table":
            if self.in_target_table:
                self.table_depth += 1
            elif self.table_id is None or attributes.get("id") == self.table_id:
                self.in_target_table = True
                self.table_depth = 1
            return
        if not self.in_target_table:
            return
        if tag == "tr":
            self.in_row = True
            self.current_row = []
        elif tag in {"td", "th"} and self.in_row:
            self.current_cell = ParsedCell()
        elif tag == "a" and self.current_cell is not None:
            self.current_link_href = attributes.get("href")
            self.current_link_text = []
        elif tag in {"br", "p", "div"} and self.current_cell is not None:
            self.current_cell.text_parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if not self.in_target_table:
            return
        if tag == "a" and self.current_cell is not None and self.current_link_href:
            self.current_cell.links.append(
                (self.current_link_href, _clean_text(" ".join(self.current_link_text)))
            )
            self.current_link_href = None
            self.current_link_text = []
        elif tag in {"td", "th"} and self.current_cell is not None:
            self.current_row.append(self.current_cell)
            self.current_cell = None
        elif tag == "tr" and self.in_row:
            if self.current_row:
                self.rows.append(self.current_row)
            self.current_row = []
            self.in_row = False
        elif tag == "table":
            self.table_depth -= 1
            if self.table_depth <= 0:
                self.in_target_table = False
                self.table_depth = 0

    def handle_data(self, data: str) -> None:
        if self.current_cell is None:
            return
        self.current_cell.text_parts.append(data)
        if self.current_link_href is not None:
            self.current_link_text.append(data)


@dataclass(frozen=True)
class NewJerseySourceResult:
    source_id: str
    projects: list[dict[str, Any]]
    source: dict[str, Any]


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _official_url(base_url: str, href: str) -> str | None:
    resolved = urljoin(base_url, href.strip())
    parsed = urlparse(resolved)
    if parsed.scheme != "https" or parsed.hostname not in {"nj.gov", "www.nj.gov"}:
        return None
    return resolved


def _date_value(value: str, pattern: re.Pattern[str], date_format: str) -> date | None:
    matches = pattern.findall(value)
    if not matches:
        return None
    try:
        return datetime.strptime(matches[-1], date_format).date()
    except ValueError:
        return None


def _money_value(value: str) -> int | None:
    if not value or value.casefold() == "n/a":
        return None
    match = MONEY.search(value)
    if not match:
        return None
    return round(float(match.group(1).replace(",", "")))


def _county_value(value: str) -> str | None:
    matches = [county for county in NJ_COUNTIES if re.search(rf"\b{re.escape(county)}\b", value, re.I)]
    return ", ".join(matches) if matches else None


def _source_document(name: str, url: str) -> dict[str, Any]:
    return {
        "name": name,
        "kind": "solicitation",
        "url": url,
        "access": "public",
        "indexStatus": "metadata-only",
    }


def _project(
    *,
    source_id: str,
    source_record_id: str,
    title: str,
    deadline: date,
    stage: str,
    status: str,
    agency: str,
    source_name: str,
    source_url: str,
    document_name: str,
    fetched_at: str,
    value: int | None = None,
) -> dict[str, Any]:
    county = _county_value(title)
    project: dict[str, Any] = {
        "id": f"{source_id}:{source_record_id}",
        "sourceId": source_id,
        "sourceRecordId": source_record_id,
        "title": title,
        "summary": title,
        "stage": stage,
        "status": status,
        "agency": agency,
        "state": "NJ",
        "bidDate": deadline.isoformat(),
        "bidDateTimeZone": "America/New_York",
        "updatedAt": fetched_at,
        "sourceName": source_name,
        "sourceUrl": source_url,
        "provenance": "live-public-page",
        "confidence": "official",
        "documents": [_source_document(document_name, source_url)],
        "participants": [
            {
                "name": agency,
                "role": "agency",
                "participantType": "organization",
                "organization": agency,
                "sourceUrl": source_url,
            }
        ],
        "searchableFields": [source_record_id, title, agency, county or "New Jersey"],
        "documentTextIndexed": False,
    }
    if county:
        project["county"] = county
    if value is not None:
        project["value"] = value
    return project


def parse_dpmc_projects(
    source_html: str,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> NewJerseySourceResult:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    parser = HtmlTableParser("example1")
    parser.feed(source_html)
    projects: list[dict[str, Any]] = []

    for row in parser.rows:
        if len(row) < 5:
            continue
        project_number_match = PROJECT_NUMBER.search(row[0].text)
        deadline = _date_value(row[3].text, DPMC_DATE, "%m/%d/%Y")
        if not project_number_match or deadline is None:
            continue
        project_number = project_number_match.group(1).upper()
        advertisement_url = next(
            (
                url
                for href, link_text in row[0].links
                if project_number.casefold() in link_text.casefold()
                and (url := _official_url(DPMC_SOURCE_URL, href))
            ),
            None,
        )
        if not advertisement_url:
            continue

        status_text = f"{row[0].text} {row[4].text}".casefold()
        if "cancel" in status_text:
            stage, status = "cancelled", "Cancelled"
        elif deadline >= current_date:
            stage, status = "bidding", "Advertised"
        elif "ntp date" in status_text:
            stage, status = "construction", "Notice to proceed posted"
        elif "award information" in status_text:
            stage, status = "awarded", "Award information posted"
        else:
            stage, status = "bid-opened", "Bid results posted"

        description = row[1].text
        if "sbe opportunity" in row[0].text.casefold():
            description = f"{description} (SBE opportunity)"
        projects.append(
            _project(
                source_id=DPMC_SOURCE_ID,
                source_record_id=project_number,
                title=description,
                deadline=deadline,
                stage=stage,
                status=status,
                agency="New Jersey Division of Property Management and Construction",
                source_name="NJ DPMC Contractor Project Advertisements",
                source_url=advertisement_url,
                document_name=f"Official DPMC advertisement {project_number}",
                fetched_at=checked_at,
                value=_money_value(row[2].text),
            )
        )

    source = {
        "id": DPMC_SOURCE_ID,
        "name": "NJ DPMC Contractor Project Advertisements",
        "owner": "New Jersey Division of Property Management and Construction",
        "level": "state",
        "sourceClass": "procurement",
        "stages": ["bidding", "bid-opened", "awarded", "construction", "cancelled"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "projects",
        "loadedCount": len(projects),
        "snapshotComplete": True,
        "lastChecked": checked_at,
        "url": DPMC_SOURCE_URL,
        "jurisdiction": "New Jersey",
        "stateCode": "NJ",
        "coverageField": "procurement",
        "note": "Official State construction advertisements with project number, scope, location, estimated cost, due-date revisions, and public advertisement PDFs.",
    }
    return NewJerseySourceResult(DPMC_SOURCE_ID, projects, source)


def parse_njdot_projects(
    source_html: str,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> NewJerseySourceResult:
    current_date = today or datetime.now(timezone.utc).date()
    checked_at = fetched_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    parser = HtmlTableParser()
    parser.feed(source_html)
    projects: list[dict[str, Any]] = []

    for row in parser.rows:
        if len(row) < 2:
            continue
        deadline = _date_value(row[0].text, NJDOT_DATE, "%m/%d/%y")
        if deadline is None:
            continue
        for href, link_text in row[1].links:
            advertisement_url = _official_url(NJDOT_SOURCE_URL, href)
            if not advertisement_url or not advertisement_url.lower().endswith(".pdf"):
                continue
            title = _clean_text(link_text)
            dp_match = DP_NUMBER.search(title) or DP_NUMBER.search(advertisement_url)
            if not dp_match or len(title) < 20:
                continue
            proposal_number = dp_match.group(1)
            stage = "bidding" if deadline >= current_date else "bid-opened"
            status = "Advertised" if stage == "bidding" else "Bid deadline passed"
            projects.append(
                _project(
                    source_id=NJDOT_SOURCE_ID,
                    source_record_id=proposal_number,
                    title=title,
                    deadline=deadline,
                    stage=stage,
                    status=status,
                    agency="New Jersey Department of Transportation",
                    source_name="NJDOT Current Advertised Projects",
                    source_url=advertisement_url,
                    document_name=f"Official NJDOT notice to contractors DP {proposal_number}",
                    fetched_at=checked_at,
                )
            )

    deduped = {project["id"]: project for project in projects}
    projects = list(deduped.values())
    source = {
        "id": NJDOT_SOURCE_ID,
        "name": "NJDOT Current Advertised Projects",
        "owner": "New Jersey Department of Transportation",
        "level": "state",
        "sourceClass": "procurement",
        "stages": ["bidding", "bid-opened"],
        "status": "live",
        "access": "open",
        "cadence": "Daily",
        "recordCount": len(projects),
        "recordCountUnit": "projects",
        "loadedCount": len(projects),
        "snapshotComplete": True,
        "lastChecked": checked_at,
        "url": NJDOT_SOURCE_URL,
        "jurisdiction": "New Jersey",
        "stateCode": "NJ",
        "coverageField": "dotBidding",
        "note": "Official NJDOT advertised construction projects and public Notice to Contractors PDFs. Bid Express remains the submission and amendment system of record.",
    }
    return NewJerseySourceResult(NJDOT_SOURCE_ID, projects, source)


def fetch_official_html(url: str, timeout_seconds: int = 20) -> str:
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "BidAtlas/1.0 public-construction-index",
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        final_url = response.geturl()
        if _official_url(url, final_url) != final_url:
            raise ValueError("New Jersey source redirected outside the official nj.gov host")
        payload = response.read(MAX_SOURCE_BYTES + 1)
        if len(payload) > MAX_SOURCE_BYTES:
            raise ValueError("New Jersey source exceeded the response-size limit")
        charset = response.headers.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def fetch_new_jersey_sources(
    fetch_html: Callable[[str], str] = fetch_official_html,
    *,
    today: date | None = None,
    fetched_at: str | None = None,
) -> tuple[list[NewJerseySourceResult], list[str]]:
    results: list[NewJerseySourceResult] = []
    warnings: list[str] = []
    parsers = (
        (DPMC_SOURCE_URL, parse_dpmc_projects, "NJ DPMC construction advertisements"),
        (NJDOT_SOURCE_URL, parse_njdot_projects, "NJDOT current advertised projects"),
    )
    for url, parser, name in parsers:
        try:
            result = parser(fetch_html(url), today=today, fetched_at=fetched_at)
            if not result.projects:
                raise ValueError("the official page yielded no valid project records")
            results.append(result)
        except Exception as error:  # The other official source should still refresh.
            warnings.append(f"{name}: {error}")
    return results, warnings


def merge_new_jersey_snapshot(
    snapshot: dict[str, Any],
    results: list[NewJerseySourceResult],
    *,
    warnings: list[str] | None = None,
    refreshed_at: str | None = None,
) -> dict[str, Any]:
    return merge_source_snapshot(
        snapshot,
        results,
        configured_source_ids={DPMC_SOURCE_ID, NJDOT_SOURCE_ID},
        source_coverage={
            DPMC_SOURCE_ID: (("NJ",), "procurement"),
            NJDOT_SOURCE_ID: (("NJ",), "dotBidding"),
        },
        warnings=warnings,
        warning_prefixes=(
            "NJ DPMC construction advertisements:",
            "NJDOT current advertised projects:",
        ),
        refreshed_at=refreshed_at,
    )


def compact_json(snapshot: dict[str, Any]) -> bytes:
    return json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
