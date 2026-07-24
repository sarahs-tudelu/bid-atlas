from __future__ import annotations

import re
from typing import Any

from .canopy import score_project


MINIMUM_PRODUCT_SCORE = 8
MINIMUM_CANOPY_SCORE = MINIMUM_PRODUCT_SCORE
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PHONE_ALLOWED = re.compile(
    r"^[+\d()\s./-]*(?:(?:ext\.?|x)\s*\d+)?$",
    re.IGNORECASE,
)


def is_published_phone(value: Any) -> bool:
    """Accept plausible source-published telephone numbers without inventing digits."""

    phone = str(value or "").strip()
    digit_count = sum(character.isdigit() for character in phone)
    return 7 <= digit_count <= 15 and bool(PHONE_ALLOWED.fullmatch(phone))


def published_contacts(project: dict[str, Any]) -> list[dict[str, str]]:
    """Return unique email contacts explicitly published with the source record."""

    contacts: list[dict[str, str]] = []
    seen: set[str] = set()
    for participant in project.get("participants", []):
        email = str(participant.get("email") or "").strip().lower()
        if not EMAIL.fullmatch(email) or email in seen:
            continue
        seen.add(email)
        contacts.append(
            {
                "name": str(
                    participant.get("name") or participant.get("organization") or ""
                ).strip(),
                "email": email,
                "phone": str(participant.get("phone") or "").strip(),
                "role": str(participant.get("role") or "published contact").strip(),
            }
        )
    return contacts


def published_phone_contacts(project: dict[str, Any]) -> list[dict[str, str]]:
    """Return unique phone contacts explicitly published with the source record."""

    contacts: list[dict[str, str]] = []
    seen: set[str] = set()
    for participant in project.get("participants", []):
        phone = str(participant.get("phone") or "").strip()
        normalized_phone = "".join(character for character in phone if character.isdigit())
        if not is_published_phone(phone) or normalized_phone in seen:
            continue
        seen.add(normalized_phone)
        contacts.append(
            {
                "name": str(
                    participant.get("name") or participant.get("organization") or ""
                ).strip(),
                "email": str(participant.get("email") or "").strip().lower(),
                "phone": phone,
                "role": str(participant.get("role") or "published contact").strip(),
            }
        )
    return contacts


def is_contactable_product_project(
    project: dict[str, Any],
    fit: dict[str, Any] | None = None,
) -> bool:
    """Apply the visibility gate for actionable Tudelu product opportunities."""

    product_fit = fit or score_project(project)
    has_published_contact = bool(
        published_contacts(project) or published_phone_contacts(project)
    )
    return int(product_fit["score"]) >= MINIMUM_PRODUCT_SCORE and has_published_contact


def is_contactable_canopy_project(
    project: dict[str, Any],
    fit: dict[str, Any] | None = None,
) -> bool:
    """Backward-compatible name for the product-wide visibility gate."""

    return is_contactable_product_project(project, fit)
