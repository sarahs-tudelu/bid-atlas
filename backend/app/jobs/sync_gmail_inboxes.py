from __future__ import annotations

from typing import Any

import boto3

from ..config import settings
from ..services.catalog_provider import ProjectCatalogProvider
from ..services.gmail_inbox import sync_gmail_account
from ..services.state import WorkspaceStore


MAX_ACCOUNTS_PER_RUN = 100


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del event, context
    store = WorkspaceStore(settings.workspace_table)
    s3 = boto3.client("s3")
    catalog = ProjectCatalogProvider(
        settings.data_directory,
        bucket=settings.catalog_bucket,
        key=settings.catalog_key,
        refresh_seconds=0,
        s3_client=s3,
    ).get()
    accounts = store.list_google_accounts()[:MAX_ACCOUNTS_PER_RUN]
    synced = 0
    failed = 0
    stored_messages = 0
    filed_attachments = 0
    for owner, account in accounts:
        try:
            result = sync_gmail_account(
                owner,
                account,
                store,
                catalog,
                document_store=s3,
                documents_bucket=settings.documents_bucket,
            )
            synced += 1
            stored_messages += int(result["messagesStored"])
            filed_attachments += int(result["filedAttachments"])
        except Exception as error:
            failed += 1
            # Deliberately omit the mailbox address and tokens from operational logs.
            print(f"BidAtlas Gmail project-inbox sync failed for one account: {type(error).__name__}")
    return {
        "accountsReviewed": len(accounts),
        "accountsSynced": synced,
        "accountsFailed": failed,
        "messagesStored": stored_messages,
        "attachmentsFiled": filed_attachments,
    }
