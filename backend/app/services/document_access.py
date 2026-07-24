from __future__ import annotations

from typing import Any


DRAWING_KINDS = {
    "architectural-drawings",
    "construction-drawings",
    "drawing",
    "drawings",
    "eplans",
    "plan-set",
    "plans",
}
PUBLIC_ACCESS = {"open", "public"}


def accessible_drawing_documents(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Return official drawing/plan routes that require no account or credentials."""

    drawings: list[dict[str, Any]] = []
    for document in project.get("documents", []):
        if not isinstance(document, dict):
            continue
        kind = str(document.get("kind") or "").strip().lower()
        access = str(document.get("access") or "").strip().lower()
        url = str(document.get("url") or "").strip()
        if kind in DRAWING_KINDS and access in PUBLIC_ACCESS and url.startswith("https://"):
            drawings.append(document)
    return drawings


def has_accessible_drawings(project: dict[str, Any]) -> bool:
    return bool(accessible_drawing_documents(project))
