from __future__ import annotations

import re
from typing import Any

from .canopy import score_project


MINIMUM_CANOPY_SCORE = 8
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


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


def is_contactable_canopy_project(
    project: dict[str, Any],
    fit: dict[str, Any] | None = None,
) -> bool:
    """Apply the product-wide visibility gate for actionable Canopy opportunities."""

    canopy_fit = fit or score_project(project)
    return int(canopy_fit["score"]) >= MINIMUM_CANOPY_SCORE and bool(
        published_contacts(project)
    )
