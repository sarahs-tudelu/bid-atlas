from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Iterable, Literal


OrganizationType = Literal["all", "architect", "developer", "owner", "installer"]
ProductType = Literal["all", "canopies", "pergolas", "partition-walls"]

_EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_SUPPORTED_TYPES = {"architect", "developer", "owner", "installer"}
_SUPPORTED_PRODUCTS = {"canopies", "pergolas", "partition-walls"}
_SUPPORTED_STATES = {"CT", "NJ", "NY"}
_TYPE_ORDER = {
    "architect": 0,
    "developer": 1,
    "owner": 2,
    "installer": 3,
}


def has_published_contact(organization: dict) -> bool:
    """Return true only when a directory record contains a usable public contact."""

    email = str(organization.get("email") or "").strip()
    if email and _EMAIL_PATTERN.fullmatch(email):
        return True

    phone = str(organization.get("phone") or "").strip()
    digit_count = len(re.sub(r"\D", "", phone))
    return 7 <= digit_count <= 15


class PartnerDirectory:
    """Curated, source-backed tri-state design and project-partner directory."""

    def __init__(self, path: Path | Iterable[Path]) -> None:
        self.paths = [path] if isinstance(path, Path) else list(path)
        self.path = self.paths[0] if self.paths else Path()
        self.generated_at = ""
        self.verified_at = ""
        self.organizations: list[dict] = []
        self._load()

    def _load(self) -> None:
        seen_ids: set[str] = set()
        for path in self.paths:
            if not path.exists():
                continue

            payload = json.loads(path.read_text(encoding="utf-8"))
            generated_at = str(payload.get("generatedAt") or "")
            verified_at = str(payload.get("verifiedAt") or "")
            self.generated_at = max(self.generated_at, generated_at)
            self.verified_at = max(self.verified_at, verified_at)

            for raw in payload.get("organizations", []):
                if not isinstance(raw, dict):
                    continue
                organization_id = str(raw.get("id") or "").strip()
                organization_type = str(raw.get("organizationType") or "").strip().lower()
                state = str(raw.get("state") or "").strip().upper()
                source_url = str(raw.get("sourceUrl") or "").strip()
                if (
                    not organization_id
                    or organization_id in seen_ids
                    or organization_type not in _SUPPORTED_TYPES
                    or state not in _SUPPORTED_STATES
                    or not source_url.startswith("http")
                    or not has_published_contact(raw)
                ):
                    continue

                products = [
                    product
                    for product in raw.get("productTypes", [])
                    if product in _SUPPORTED_PRODUCTS
                ]
                organization = {
                    **raw,
                    "id": organization_id,
                    "organizationType": organization_type,
                    "state": state,
                    "productTypes": products,
                }
                seen_ids.add(organization_id)
                self.organizations.append(organization)

        self.organizations.sort(
            key=lambda item: (
                0 if item.get("priorityRank") else 1,
                int(item.get("priorityRank") or 999),
                _TYPE_ORDER[item["organizationType"]],
                str(item.get("name") or "").casefold(),
            )
        )

    def organization(self, organization_id: str) -> dict | None:
        normalized_id = organization_id.removeprefix("prospect:")
        return next(
            (
                organization
                for organization in self.organizations
                if organization["id"] == normalized_id
            ),
            None,
        )

    def outreach_project(self, prospect_id: str) -> dict | None:
        organization = self.organization(prospect_id)
        if organization is None:
            return None

        contact_name = str(organization.get("contactName") or organization["name"])
        fit_reasons = [
            str(reason)
            for reason in organization.get("fitReasons", [])
            if str(reason).strip()
        ]
        sectors = [
            str(sector)
            for sector in organization.get("sectors", [])
            if str(sector).strip()
        ]
        source_url = str(organization.get("sourceUrl") or "")
        return {
            "id": f"prospect:{organization['id']}",
            "sourceId": "tri-state-prospect-directory",
            "sourceRecordId": organization["id"],
            "recordType": "prospect",
            "title": organization["name"],
            "summary": " ".join(fit_reasons),
            "stage": "prospecting",
            "status": organization.get("researchGroup") or "Research prospect",
            "agency": organization["name"],
            "address": organization.get("address") or "",
            "city": organization.get("city") or "",
            "state": organization.get("state") or "",
            "postalCode": organization.get("postalCode") or "",
            "sourceName": organization.get("sourceLabel") or "Prospect research",
            "sourceUrl": source_url,
            "productTypes": organization.get("productTypes", []),
            "prospectFitReasons": fit_reasons,
            "prospectSectors": sectors,
            "prospectPriorityRank": organization.get("priorityRank"),
            "prospectOrganizationType": organization["organizationType"],
            "participants": [
                {
                    "name": contact_name,
                    "organization": organization["name"],
                    "role": organization.get("contactRole") or "Published contact",
                    "email": organization.get("email") or "",
                    "phone": organization.get("phone") or "",
                    "sourceUrl": source_url,
                }
            ],
            "documents": [
                {
                    "name": "Published prospect source",
                    "url": source_url,
                    "kind": "source",
                }
            ],
            "searchableFields": [
                organization["name"],
                contact_name,
                organization.get("contactRole") or "",
                *sectors,
                *fit_reasons,
            ],
        }

    def search(
        self,
        *,
        query: str = "",
        organization_type: OrganizationType = "all",
        product: ProductType = "all",
        page: int = 1,
        limit: int = 25,
    ) -> dict:
        normalized_query = query.strip().casefold()
        safe_page = max(page, 1)
        safe_limit = min(max(limit, 1), 100)

        matches: list[dict] = []
        for organization in self.organizations:
            if (
                organization_type != "all"
                and organization["organizationType"] != organization_type
            ):
                continue
            if product != "all" and product not in organization.get("productTypes", []):
                continue
            if normalized_query and normalized_query not in self._search_text(organization):
                continue
            matches.append(organization)

        total = len(matches)
        total_pages = max(math.ceil(total / safe_limit), 1)
        if safe_page > total_pages:
            safe_page = total_pages
        start = (safe_page - 1) * safe_limit
        end = start + safe_limit

        return {
            "organizations": matches[start:end],
            "summary": {
                "directoryTotal": len(self.organizations),
                "architects": sum(
                    item["organizationType"] == "architect"
                    for item in self.organizations
                ),
                "developers": sum(
                    item["organizationType"] == "developer"
                    for item in self.organizations
                ),
                "owners": sum(
                    item["organizationType"] == "owner"
                    for item in self.organizations
                ),
                "installers": sum(
                    item["organizationType"] == "installer"
                    for item in self.organizations
                ),
                "emailReady": sum(bool(item.get("email")) for item in self.organizations),
                "phoneOnly": sum(
                    not item.get("email") and bool(item.get("phone"))
                    for item in self.organizations
                ),
                "contactPolicy": "Published email or phone required",
            },
            "meta": {
                "page": safe_page,
                "pageSize": safe_limit,
                "totalPages": total_pages,
                "total": total,
                "generatedAt": self.generated_at,
                "verifiedAt": self.verified_at,
                "sourceMode": "curated-official-contact-directory",
            },
        }

    @staticmethod
    def _search_text(organization: dict) -> str:
        values = [
            organization.get("name"),
            organization.get("contactName"),
            organization.get("contactRole"),
            organization.get("practiceType"),
            organization.get("researchGroup"),
            organization.get("city"),
            organization.get("state"),
            organization.get("county"),
            *organization.get("sectors", []),
            *organization.get("fitReasons", []),
        ]
        return " ".join(str(value or "") for value in values).casefold()
