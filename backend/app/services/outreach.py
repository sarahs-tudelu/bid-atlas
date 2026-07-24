from __future__ import annotations

from typing import Any

from ..config import settings
from .ai_outreach import generate_ai_email, tudelu_signature
from .canopy import project_product_matches, score_project
from .marketing_outreach import (
    default_sales_reply_owner,
    marketing_persona_for,
    sales_reply_owner,
)
from .qualification import EMAIL, published_contacts


def generate_outreach_draft(
    project: dict[str, Any],
    user: dict[str, Any],
    email_history: list[dict[str, Any]],
    *,
    personalize: bool = False,
    recipient: str = "",
    sender_mode: str = "marketing",
    marketing_sender_email: str = "",
    reply_owner_email: str = "",
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
    is_prospect = project.get("recordType") == "prospect"
    canopy_fit = score_project(project)
    product_matches = project_product_matches(project)
    declared_products = [
        str(product)
        for product in project.get("productTypes", [])
        if product in {"canopies", "pergolas", "partition-walls"}
    ]
    primary_product = (
        declared_products[0]
        if is_prospect and declared_products
        else product_matches[0]["id"]
        if product_matches
        else "canopies"
    )
    if sender_mode not in {"marketing", "employee"}:
        raise ValueError("Sender mode must be marketing or employee")
    if sender_mode == "marketing":
        draft_user = marketing_persona_for(marketing_sender_email)
        reply_owner = sales_reply_owner(reply_owner_email) or default_sales_reply_owner(
            str(user.get("email") or "")
        )
        sender_email = draft_user["email"]
    else:
        draft_user = user
        reply_owner = {
            "name": str(user.get("name") or "Tudelu employee"),
            "email": str(user.get("email") or "").strip().lower(),
        }
        sender_email = reply_owner["email"]
    if personalize:
        generated = generate_ai_email(
            {
                **project,
                "canopyFit": canopy_fit,
                "productMatches": product_matches,
            },
            draft_user,
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
        product_copy = {
            "pergolas": {
                "label": "Pergola",
                "capability": (
                    "We design and manufacture custom-engineered aluminum pergolas "
                    "and outdoor architectural systems."
                ),
                "role": "specialty pergola manufacturer",
            },
            "partition-walls": {
                "label": "Partition wall",
                "capability": (
                    "We design and manufacture custom-engineered partition systems, "
                    "including demountable, operable, glass, and acoustic wall solutions."
                ),
                "role": "specialty partition-system manufacturer",
            },
            "canopies": {
                "label": "Canopy",
                "capability": (
                    "We design and manufacture custom-engineered aluminum architectural "
                    "canopies, covered walkways, and entrance systems."
                ),
                "role": "specialty canopy manufacturer",
            },
        }[primary_product]
        if is_prospect:
            practice = str(
                project.get("prospectOrganizationType") or "organization"
            ).replace("-", " ")
            scope = {
                "pergolas": "pergola and outdoor-amenity",
                "partition-walls": "architectural partition",
                "canopies": "canopy and entrance-system",
            }[primary_product]
            body = (
                f"Hi {greeting_name}, I’m reaching out from Tudelu because {title}"
                f"{location_phrase} looks closely aligned with the architectural systems "
                f"we manufacture in Little Ferry, NJ. {product_copy['capability']} "
                f"Would you be open to a brief introduction about upcoming {scope} needs, "
                f"or point me to the right {practice} contact?"
            )
            generated = {
                "subject": f"Tudelu {product_copy['label'].lower()} capabilities for {title}",
                "body": f"{body}\n\n{tudelu_signature(draft_user)}",
            }
        else:
            body = (
                f"Hi {greeting_name}, I’m reaching out from Tudelu about {title}{location_phrase}. "
                f"{product_copy['capability']} "
                "Could you share the current drawings, addenda, and preferred path for a "
                f"{product_copy['role']} to support the project?"
            )
            generated = {
                "subject": f"{product_copy['label']} support for {reference}",
                "body": f"{body}\n\n{tudelu_signature(draft_user)}",
            }
        generation = {"provider": "template"}
    return {
        "projectId": str(project["id"]),
        "projectTitle": title,
        "sourceRecordId": reference,
        "recordType": "prospect" if is_prospect else "project",
        "sourceUrl": str(project.get("sourceUrl") or ""),
        "productTypes": declared_products,
        "prospectFitReasons": project.get("prospectFitReasons") or [],
        "prospectPriorityRank": project.get("prospectPriorityRank"),
        "prospectOrganizationType": project.get("prospectOrganizationType") or "",
        "to": contact["email"],
        "contactName": contact["name"],
        "subject": generated["subject"],
        "body": generated["body"],
        "status": "draft",
        "contacts": contacts,
        "canopyFit": canopy_fit,
        "generation": generation,
        "senderMode": sender_mode,
        "senderEmail": sender_email,
        "marketingSenderEmail": sender_email if sender_mode == "marketing" else "",
        "replyOwnerEmail": reply_owner["email"],
        "replyOwnerName": reply_owner["name"],
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
