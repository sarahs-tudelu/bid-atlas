from backend.app.services.state import WorkspaceStore
from backend.app.services.team_outreach import team_contact_summary, team_outreach_log


PROJECT = {
    "id": "source:project-1",
    "title": "Canopy replacement",
    "participants": [
        {
            "name": "Project Owner",
            "email": "owner@example.com",
            "role": "owner",
        }
    ],
}


def test_team_contact_summary_checks_every_tudelu_employee_and_deduplicates() -> None:
    store = WorkspaceStore(None)
    colleague = "colleague@tudelu.com"
    store.put(
        colleague,
        "outreach#source:project-1",
        {
            "projectId": PROJECT["id"],
            "status": "sent",
            "to": "owner@example.com",
            "subject": "Canopy introduction",
            "body": "Previously sent.",
            "sentAt": "2026-07-20T12:00:00+00:00",
            "sentBy": colleague,
            "senderEmail": colleague,
            "gmailMessageId": "gmail-message-1",
        },
    )
    store.put(
        colleague,
        "correspondence#gmail-message-1",
        {
            "messageId": "gmail-message-1",
            "projectId": PROJECT["id"],
            "direction": "sent",
            "to": "owner@example.com",
            "from": colleague,
            "subject": "Canopy introduction",
            "occurredAt": "2026-07-20T12:00:00+00:00",
        },
    )
    store.put(
        "outsider@example.com",
        "outreach#source:project-1",
        {
            "projectId": PROJECT["id"],
            "status": "sent",
            "to": "owner@example.com",
        },
    )

    summary = team_contact_summary(store, PROJECT)

    assert summary["priorContactCount"] == 1
    assert summary["priorContactedBy"] == [colleague]
    message = summary["history"][0]["messages"][0]
    assert message["id"] == "gmail-message-1"
    assert message["sentBy"] == colleague


def test_team_contact_summary_keeps_full_audit_totals_when_history_is_capped() -> None:
    store = WorkspaceStore(None)
    oldest_colleague = "oldest@tudelu.com"
    recent_colleague = "recent@tudelu.com"
    store.put(
        oldest_colleague,
        "outreach#oldest",
        {
            "projectId": PROJECT["id"],
            "status": "sent",
            "to": "owner@example.com",
            "sentAt": "2026-07-20T12:00:00+00:00",
        },
    )
    for index in range(50):
        store.put(
            recent_colleague,
            f"outreach#recent-{index}",
            {
                "projectId": PROJECT["id"],
                "status": "sent",
                "to": "owner@example.com",
                "sentAt": f"2026-07-21T12:{index:02d}:00+00:00",
            },
        )

    summary = team_contact_summary(store, PROJECT)

    assert summary["priorContactCount"] == 51
    assert summary["priorContactedBy"] == [oldest_colleague, recent_colleague]
    assert len(summary["history"]) == 50


def test_team_log_shows_own_drafts_and_only_sent_records_from_colleagues() -> None:
    store = WorkspaceStore(None)
    current = "current@tudelu.com"
    colleague = "colleague@tudelu.com"
    store.put(
        current,
        "outreach#own-draft",
        {"projectId": "own-draft", "status": "draft", "subject": "Mine"},
    )
    store.put(
        colleague,
        "outreach#team-sent",
        {
            "projectId": "team-sent",
            "status": "sent",
            "subject": "Sent",
            "body": "Internal sent copy",
            "sentAt": "2026-07-20T12:00:00+00:00",
        },
    )
    store.put(
        colleague,
        "outreach#private-draft",
        {"projectId": "private-draft", "status": "draft", "subject": "Private"},
    )

    history = team_outreach_log(store, current)

    assert {record["projectId"] for record in history} == {"own-draft", "team-sent"}
    team_record = next(record for record in history if record["projectId"] == "team-sent")
    assert team_record["sentBy"] == colleague
    assert "body" not in team_record
