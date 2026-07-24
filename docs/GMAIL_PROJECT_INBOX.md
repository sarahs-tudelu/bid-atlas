# Gmail project inbox

This document defines BidAtlas’s employee-mailbox correspondence workflow. It applies only to a verified, signed-in `@tudelu.com` user’s connected Google account.

## Product behavior

- `/inbox` shows sent and received Gmail correspondence grouped into admitted project folders.
- An employee Gmail send from `/outreach` creates a `correspondence#<gmail-message-id>` record immediately.
- A scheduled Lambda and the **Sync Gmail now** action discover replies and other messages involving source-published project contacts.
- High-confidence messages are filed automatically. Ambiguous messages remain in **Needs assignment** and can be filed manually.
- The Project Workspace shows its ten newest correspondence records and filed attachments.
- Marketing-mailbox messages continue through the separate Instantly routing and reply-forwarding workflow. They are not presented as an employee’s Gmail inbox.

## OAuth and Gmail API boundary

The existing Google OAuth flow requests:

```text
openid
email
profile
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
```

No additional scope is required for this feature. `gmail.readonly` permits Gmail message and attachment reads, while `gmail.send` remains the employee outreach permission. Google classifies `gmail.readonly` as a restricted scope, so external distribution may require Google verification and the security review applicable to restricted data. BidAtlas currently restricts identity admission to verified `@tudelu.com` accounts.

The implementation uses:

- `users.messages.list` with bounded project-contact queries;
- `users.messages.get(format=full)` to read headers, Gmail snippet, labels, and MIME attachment descriptors;
- `users.threads.get(format=full)` for known project threads;
- `users.messages.attachments.get` when an attachment body is not inline;
- `users.messages.send` for explicitly confirmed employee outreach.

Official references:

- <https://developers.google.com/workspace/gmail/api/guides/list-messages>
- <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get>
- <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments>
- <https://developers.google.com/workspace/gmail/api/auth/scopes>

## Discovery limits

BidAtlas does not issue an unfiltered mailbox listing.

1. Build the email set from source-published contacts on the current admitted catalog.
2. Query contacts in groups of 12, with at most eight queries per account and 100 message references per query.
3. On first sync, search the prior 90 days.
4. On later syncs, start two days before the last successful checkpoint to tolerate delayed indexing and overlapping scheduled runs.
5. Fetch up to 100 known Gmail threads from existing employee outreach and correspondence records.
6. Fetch at most 250 messages per account per scheduled invocation; the synchronous browser action is capped at 50 to stay within the API response window.
7. Process at most 100 connected employee accounts per scheduled invocation.

These are safety and latency limits, not a completeness claim.

## Deterministic matching

Matching uses the following precedence:

1. **Gmail thread** — an existing employee outreach or manually/automatically assigned correspondence record already maps the thread to a project. Confidence: high.
2. **Project reference** — exactly one admitted project’s `sourceRecordId` appears in the subject or Gmail snippet. Confidence: high.
3. **Published contact** — the message involves a contact published on exactly one admitted project. Confidence: medium.
4. **Contact and title** — a contact appears on multiple projects, but one project has a unique overlap of at least two meaningful title tokens with the subject/snippet. Confidence: medium.
5. **Needs review** — multiple projects remain plausible or evidence is insufficient. The candidate project IDs are retained, but `projectId` remains empty.

`PUT /api/inbox/messages/{messageId}/project` validates the requested project against the current admitted catalog and writes `matchedBy=manual`. Later syncs preserve that assignment.

## Retained message data

Each owner-partitioned DynamoDB record stores:

- Gmail message ID and thread ID;
- project ID, title, and source record ID when assigned;
- bounded candidate project IDs and matching reason/confidence;
- From, To, Cc, Subject;
- Gmail internal timestamp and sent/received direction;
- a maximum 500-character Gmail snippet;
- Gmail label IDs;
- attachment name, MIME type, byte size, filing status, and private S3 object key;
- bounded attachment warnings;
- record update time.

BidAtlas does not persist the MIME body text, raw RFC 822 message, OAuth credentials in browser state, or an unfiltered mailbox index.

## Attachment filing

- Only messages discovered through the project-scoped process are eligible.
- Each file is limited to 20 MB.
- Filed bytes per message are limited to 30 MB.
- Names are reduced to a basename, unsafe characters are replaced, and the result is capped at 180 characters.
- Objects use `gmail/<sha256-owner-prefix>/<message-id>/<index>-<safe-name>`.
- The documents bucket blocks public access, enforces TLS, uses S3-managed encryption, enables versioning, and is retained if the stack is removed.
- Object keys are removed from the browser response.
- `GET /api/inbox/attachments/{messageId}/{index}` first validates the signed-in owner’s DynamoDB record, then returns a 307 redirect to a five-minute S3 presigned URL.

An oversize or failed attachment is skipped without discarding the correspondence. The UI displays the bounded warning.

## AWS runtime

`GmailInboxSyncFunction` runs every five minutes with:

- Python 3.12 x86-64;
- 1,024 MB memory;
- five-minute timeout;
- one-week CloudWatch log retention;
- read/write access to the workspace table and documents bucket;
- read access to the catalog bucket;
- parameter-specific `ssm:GetParameter` access to the Google client ID and client secret.

The job enumerates only `google#account` records, never logs an account email or token on failure, continues after an individual account error, and returns aggregate counters.

## API summary

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/inbox` | Owner-scoped messages, projects, counts, sync state, project/status/search paging |
| `POST` | `/api/inbox/sync` | Bounded sync for the signed-in employee |
| `PUT` | `/api/inbox/messages/{messageId}/project` | Manual assignment to an admitted project |
| `GET` | `/api/inbox/attachments/{messageId}/{index}` | Owner-checked, short-lived private download |

All routes require the normal signed session. The owner value always comes from `require_user`; no request field can select another employee partition.

## Operational checks

After deployment:

1. Confirm the stack output includes `GmailInboxSyncFunctionName`.
2. Confirm the EventBridge schedule is enabled.
3. Invoke the function once and inspect only aggregate result counts.
4. Open `/inbox` while signed in and run **Sync Gmail now**.
5. Verify a previously sent employee-Gmail outreach appears under its project.
6. Verify a test reply from a published contact appears under the same Gmail thread.
7. Verify an attachment downloads only while signed into the owner account.
8. Verify a message involving a contact shared by multiple projects stays in **Needs assignment** unless its reference/title disambiguates it.

Do not send a real email solely for a deployment smoke test without a human-approved project and recipient.
