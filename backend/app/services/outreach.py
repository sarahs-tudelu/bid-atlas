from __future__ import annotations

import re
from typing import Any

from .canopy import score_project


EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def published_contacts(project: dict[str, Any]) -> list[dict[str, str]]:
    contacts: list[dict[str, str]] = []
    seen: set[str] = set()
    for participant in project.get("participants", []):
        email = str(participant.get("email") or "").strip().lower()
        if not EMAIL.fullmatch(email) or email in seen:
            continue
        seen.add(email)
        contacts.append(
            {
                "name": str(participant.get("name") or participant.get("organization") or "").strip(),
                "email": email,
                "phone": str(participant.get("phone") or "").strip(),
                "role": str(participant.get("role") or "published contact").strip(),
            }
        )
    return contacts


def generate_outreach_draft(project: dict[str, Any]) -> dict[str, Any]:
    contacts = published_contacts(project)
    contact = contacts[0] if contacts else {"name": "", "email": "", "phone": "", "role": ""}
    greeting_name = contact["name"].split()[0] if contact["name"] else "there"
    reference = str(project.get("sourceRecordId") or project.get("id") or "the project")
    title = str(project.get("title") or "this project").strip()
    location = ", ".join(
        str(value).strip()
        for value in (project.get("city") or project.get("county"), project.get("state"))
        if value
    )
    location_phrase = f" in {location}" if location else ""
    subject = f"Canopy support for {reference}"
    body = (
        f"Hi {greeting_name}, I’m reaching out from Tudelu about {title}{location_phrase}. "
        "We design and manufacture custom-engineered aluminum architectural canopies, covered walkways, and entrance systems with integrated drainage and finish options. "
        "Could you share the current drawings, addenda, and the preferred path for a specialty canopy manufacturer to support the project?"
    )
    return {
        "projectId": str(project["id"]),
        "projectTitle": title,
        "sourceRecordId": reference,
        "to": contact["email"],
        "contactName": contact["name"],
        "subject": subject,
        "body": body,
        "status": "draft",
        "contacts": contacts,
        "canopyFit": score_project(project),
    }


def validate_draft(value: dict[str, Any]) -> dict[str, Any]:
    project_id = str(value.get("projectId") or "").strip()
    recipient = str(value.get("to") or "").strip().lower()
    subject = str(value.get("subject") or "").strip()
    body = str(value.get("body") or "").strip()
    if not project_id or len(project_id) > 300:
        raise ValueError("projectId is required")
    if recipient and (len(recipient) > 254 or not EMAIL.fullmatch(recipient)):
        raise ValueError("A valid recipient email is required")
    if not subject or len(subject) > 300:
        raise ValueError("Subject is required and must be 300 characters or fewer")
    if not body or len(body) > 10_000:
        raise ValueError("Body is required and must be 10,000 characters or fewer")
    return {**value, "projectId": project_id, "to": recipient, "subject": subject, "body": body}
