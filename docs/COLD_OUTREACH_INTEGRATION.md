# Cold outreach integration

This document is the operating contract for BidAtlas marketing email. Read it with [`../README.md`](../README.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) before changing sender identity, delivery, reply routing, or provider integration.

## Adopted behavior

The ignored `tudelu-cold-outreach-main/` repository was treated as a reference implementation. BidAtlas reimplements these policies:

- the default cold-outreach mailbox is `outreach@tudelugroup.com`;
- the default prospect-facing identity is **Alex Turner**, with **Alex** as the signoff;
- the marketing identity is separate from the employee who owns a sales response;
- human responses are forwarded with the prospect as Reply-To;
- automatic replies are suppressed;
- repeat marketing contact to the same recipient has a 14-day cooldown; and
- provider events are deduplicated before forwarding.

BidAtlas does not import the reference repository's contacts, lead exports, campaigns, send history, CRM records, local database, mailbox credentials, OAuth material, or `.env` files. The entire reference directory is ignored by Git and excluded from Lambda assets.

## Sender and ownership policy

Marketing is the default `senderMode` returned by `GET /api/outreach/config` and the default in all generate/save/send request models.

| Mode | Visible sender/signature | Delivery provider | Response destination |
| --- | --- | --- | --- |
| `marketing` | Selected provider-authorized Tudelu marketing account; defaults to Alex Turner, `outreach@tudelugroup.com` | Connected Instantly account | Selected designated Tudelu sales owner |
| `employee` | Verified signed-in Tudelu employee | Gmail `users/me` | The employee's own mailbox |

The server, not React, authorizes these identities. `GET /api/outreach/config` returns only safe identity/status fields for the accounts visible to the server-held Instantly token. Generation and send revalidate a selected nondefault address against that provider account list, so a client cannot invent a marketing sender or arbitrary reply address. Current designated sales owners are:

- Jadalyn Gaines — `jadalyn.gaines@tudelu.com`
- Patrick May — `patrick.may@tudelu.com`
- Jessica Rigolosi — `jessica@tudelu.com`
- Abe Straus — `abe@tudelu.com`
- Shlomo Horowitz — `shlomo.h@tudelu.com`

When the signed-in user is one of these owners, that employee is preselected. Otherwise Jessica Rigolosi is the fallback. Changing this roster requires a code, test, and documentation change.

“Automatic marketing sender” means marketing is selected automatically when a draft opens and the confirmed send uses the designated account. It does not mean unattended bulk sending. A verified employee must still select a source-published recipient, review the editable message, and accept the sender/recipient confirmation.

## Drafting and personalization

Initial generation is deterministic and makes no Anthropic call. Marketing mode signs with the server-resolved selected account persona; employee mode signs as the verified employee. **Personalize with AI** is optional and sends Claude only bounded project facts and minimized prior-message snippets. FastAPI discards any model-supplied signature and appends the correct server-owned Tudelu signature.

Changing sender mode or marketing account regenerates the draft so the displayed signature cannot drift from the enforced provider identity. Save and send reload the admitted project and reject any recipient that is not a valid email published by the source.

## Send controls

Marketing send uses the Instantly email endpoint with the configured `eaccount`. Provider requests identify the server as `BidAtlas/1.0` instead of exposing Python's default `urllib` browser signature, which Instantly's Cloudflare boundary rejects. After provider success, BidAtlas stores:

- the normalized recipient and a hash-keyed route;
- project ID/title;
- employee who confirmed the send;
- provider-authorized marketing sender;
- selected sales reply owner; and
- send timestamp.

The shared system partition makes the cooldown and lock apply across every signed-in employee. A route sent within the prior 14 days returns `409`; a concurrent send to the same recipient also returns `409`. The lock is always removed after success or provider failure. No route or sent audit is created when delivery fails.

Marketing and employee sends share a team-level per-recipient conditional lock, preventing two employees or providers from sending concurrently to the same project owner. Employee sends do not create a marketing cooldown route, but their Gmail delivery audits participate in team-wide prior-contact history.

## Response routing

EventBridge runs `app.jobs.sync_marketing_replies.handler` every five minutes:

1. Exit without calling Instantly when no BidAtlas marketing routes exist.
2. Group routes by their recorded marketing sender and poll each applicable account over a bounded 30-day window and at most five 100-item pages.
3. Match a message to a route only when its sender equals the route recipient and its provider timestamp is at or after the recorded send.
4. Suppress provider-marked automatic replies and deterministic out-of-office/automatic-reply subjects or previews.
5. Forward a human response through the route's original sender account to that route's designated sales owner, set Reply-To to the original prospect, and include the original content through the provider.
6. Store a hash-keyed audit with a bounded snippet and provider ID. A successful or suppressed provider ID is not handled twice. A `forward-failed` record is eligible for retry.

This is response routing, not CRM creation. BidAtlas currently has no CRM mutation boundary.

## Secrets and AWS resources

Production uses the existing SSM SecureString `/tudelu-marketing/INSTANTLY_API_TOKEN`. CDK places only its parameter name in Lambda environment variables and grants exact-ARN `ssm:GetParameter` permission:

- the API Lambda reads it for marketing delivery and safe configured/unconfigured status;
- the reply-sync Lambda reads it for received-message polling and forwarding; and
- no browser response, log statement, stack output, or CloudFormation property contains the token value.

`BIDATLAS_MARKETING_SENDER` defaults to `outreach@tudelugroup.com`. It controls the fallback/default, while the remaining selectable identities are discovered from Instantly. Changing the default requires confirming that the account is connected in Instantly, then updating configuration, tests, and this document together.

## Release verification

Automated release checks cover:

- marketing defaults, account discovery, and selected-account signature;
- server-enforced provider-authorized sender and sales owner;
- selected Instantly account in the provider request;
- explicit BidAtlas provider-request identity;
- 14-day cooldown;
- employee Gmail selection and employee response ownership;
- human-reply forwarding; and
- automatic-reply suppression.

Production verification must be read-only with respect to recipients: inspect Lambda configuration, EventBridge state, and the connected provider account; invoke reply sync only after confirming the system route count is zero. Do not send a live test message unless a human supplies a controlled project and recipient.

## Future-change checklist

Any future sender, signature, roster, cooldown, delivery endpoint, reply classifier, storage, schedule, or secret change must update, in the same commit:

1. this document;
2. the end-to-end workflow and configuration sections in `README.md`;
3. the trust boundaries, sequence, persistence, and failure behavior in `ARCHITECTURE.md`;
4. backend and frontend contracts/tests; and
5. CDK configuration when runtime permissions or resources change.
