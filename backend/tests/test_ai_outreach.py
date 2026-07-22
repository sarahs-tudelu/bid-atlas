from __future__ import annotations

import json

import pytest

import backend.app.services.ai_outreach as ai_outreach
import backend.app.services.outreach as outreach_service
from backend.app.services.ai_outreach import AnthropicGenerationError, generate_ai_email


USER = {"name": "Jessica Example", "email": "jessica@tudelu.com"}
CONTACT = {"name": "Morgan Lee", "email": "morgan@example.gov", "phone": "", "role": "buyer"}
PROJECT = {
    "id": "sam:123",
    "sourceRecordId": "W912-123",
    "title": "Architectural canopy replacement",
    "summary": "Replace two aluminum entrance canopies with integrated drainage.",
    "agency": "Example Agency",
    "state": "NJ",
    "stage": "bidding",
    "bidDate": "2026-08-01T17:00:00Z",
    "canopyFit": {"score": 42, "reasons": ["architectural canopy"]},
    "participants": [CONTACT],
}


def test_default_email_is_signed_without_calling_anthropic(monkeypatch) -> None:
    def unexpected_ai_call(*args, **kwargs):
        raise AssertionError("Anthropic must be opt-in")

    monkeypatch.setattr(outreach_service, "generate_ai_email", unexpected_ai_call)

    draft = outreach_service.generate_outreach_draft(PROJECT, USER, [])

    assert draft["generation"] == {"provider": "template"}
    assert "Architectural canopy replacement" in draft["body"]
    assert draft["body"].endswith(
        "Best regards,\nAlex\nBusiness Development | Tudelu\n"
        "718-782-7882\ntudelu.com"
    )


def test_employee_email_uses_verified_employee_signature() -> None:
    draft = outreach_service.generate_outreach_draft(
        PROJECT,
        USER,
        [],
        sender_mode="employee",
    )

    assert draft["senderEmail"] == USER["email"]
    assert draft["body"].endswith(
        "Best regards,\nJessica Example\nBusiness Development | Tudelu\n"
        "718-782-7882 ext. 116\ntudelu.com"
    )


def test_ai_email_uses_sam_style_context_and_enforces_signature(monkeypatch) -> None:
    captured: dict = {}

    monkeypatch.setattr(ai_outreach, "runtime_secret", lambda *args: "test-key")

    def fake_request(api_key: str, payload: dict) -> dict:
        captured.update({"api_key": api_key, "payload": payload})
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "subject": "Canopy replacement - W912-123",
                            "body": "Hi Morgan, I’m reaching out about the entrance canopy replacement. Could you share the current drawing set and addenda?",
                        }
                    ),
                }
            ]
        }

    monkeypatch.setattr(ai_outreach, "_anthropic_request", fake_request)
    history = [
        {
            "threadId": "provider-id-is-not-sent",
            "messages": [
                {
                    "id": "message-id-is-not-sent",
                    "from": "jessica@tudelu.com",
                    "to": "morgan@example.gov",
                    "subject": "Earlier canopy question",
                    "date": "2026-07-15",
                    "snippet": "The drawings will be posted with the next addendum.",
                    "body": "This full body must never reach the model.",
                }
            ],
        }
    ]

    draft = generate_ai_email(PROJECT, USER, CONTACT, history)

    assert captured["api_key"] == "test-key"
    assert captured["payload"]["model"] == "claude-sonnet-4-6"
    prompt = captured["payload"]["messages"][0]["content"][0]["text"]
    assert "cache_control" not in captured["payload"]["messages"][0]["content"][0]
    assert captured["payload"]["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "The drawings will be posted" in prompt
    assert "full body must never" not in prompt
    assert "provider-id-is-not-sent" not in prompt
    assert draft["subject"] == "Canopy replacement - W912-123"
    assert draft["body"].endswith(
        "Best regards,\nJessica Example\nBusiness Development | Tudelu\n"
        "718-782-7882 ext. 116\ntudelu.com"
    )


def test_ai_email_rejects_non_json_provider_output(monkeypatch) -> None:
    monkeypatch.setattr(ai_outreach, "runtime_secret", lambda *args: "test-key")
    monkeypatch.setattr(
        ai_outreach,
        "_anthropic_request",
        lambda *args: {"content": [{"type": "text", "text": "not json"}]},
    )

    with pytest.raises(AnthropicGenerationError, match="invalid email draft"):
        generate_ai_email(PROJECT, USER, CONTACT, [])
