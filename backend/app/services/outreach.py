from __future__ import annotations

from typing import Any

from ..config import settings
from .ai_outreach import generate_ai_email, tudelu_signature
from .canopy import score_project
from .qualification import EMAIL, published_contacts


def generate_outreach_draft(
    project: dict[str, Any],
    user: dict[str, Any],
    email_history: list[dict[str, Any]],
    *,
    personalize: bool = False,
    recipient: str = "",
) -> dict[str, Any]:
    contacts = published_contacts(project)
    if not contacts:
        raise ValueError("A published email contact is required for email outreach")
    normalized_recipient = recipient.strip().lower()
    contact = next(
        (item for item in contacts if item["email"] == normalized_recipient),
        contacts[0] if not normalized_recipient else None,
    )
    if contact is None:
        raise ValueError("Recipient must be an email address published with this project")
    reference = str(project.get("sourceRecordId") or project.get("id") or "the project")
    title = str(project.get("title") or "this project").strip()
    canopy_fit = score_project(project)
    if personalize:
        generated = generate_ai_email(
            {**project, "canopyFit": canopy_fit},
            user,
            contact,
            email_history,
        )
        generation = {"provider": "anthropic", "model": settings.anthropic_model}
    else:
        greeting_name = contact["name"].split()[0] if contact["name"] else "there"
        location = ", ".join(
            str(value).strip()
            for value in (project.get("city") or project.get("county"), project.get("state"))
            if value
        )
        location_phrase = f" in {location}" if location else ""
        body = (
            f"Hi {greeting_name}, I’m reaching out from Tudelu about {title}{location_phrase}. "
            "We design and manufacture custom-engineered aluminum architectural canopies, covered walkways, and entrance systems. "
            "Could you share the current drawings, addenda, and preferred path for a specialty canopy manufacturer to support the project?"
        )
        generated = {
            "subject": f"Canopy support for {reference}",
            "body": f"{body}\n\n{tudelu_signature(user)}",
        }
        generation = {"provider": "template"}
    return {
        "projectId": str(project["id"]),
        "projectTitle": title,
        "sourceRecordId": reference,
        "to": contact["email"],
        "contactName": contact["name"],
        "subject": generated["subject"],
        "body": generated["body"],
        "status": "draft",
        "contacts": contacts,
        "canopyFit": canopy_fit,
        "generation": generation,
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
    if "\r" in subject or "\n" in subject:
        raise ValueError("Subject cannot contain line breaks")
    if not body or len(body) > 10_000:
        raise ValueError("Body is required and must be 10,000 characters or fewer")
    return {**value, "projectId": project_id, "to": recipient, "subject": subject, "body": body}
