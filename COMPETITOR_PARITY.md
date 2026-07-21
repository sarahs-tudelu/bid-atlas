# BidAtlas bid-workflow benchmark

This benchmark uses current official product pages and knowledge bases. Competitor project totals are marketing claims, not a BidAtlas coverage denominator.

## Acquisition reality

The competitor inventory is not simply a mirror of public city feeds. ConstructConnect says its research operation contacts architects, planholders, and private owners in addition to collecting public projects. PlanHub combines research-team early-stage leads with projects and planrooms posted directly by general contractors. Their published inventory numbers also vary by product page and are not audited “every U.S. project” denominators.

True workflow parity therefore needs three acquisition loops:

1. official public-source ingestion for planning, permits, solicitations, documents, bid tabs, awards, and completion signals;
2. a reviewed human-research queue for sources and early/private leads that cannot be verified automatically; and
3. first-party uploads and updates from contractors, architects, owners, and agencies, with access controls for private planrooms.

Official references: [ConstructConnect Project Intelligence](https://www.constructconnect.com/products/project-intelligence), [PlanHub for general contractors](https://planhub.com/general-contractors/), [PlanHub Project Finder research workflow](https://knowledgebase.planhub.com/knowledge/-project-finder-for-general-contractors).

## ConstructConnect capabilities to match

- Project discovery with geography, trade, stage, date, scope, value, saved-search, and alert filters.
- Plans, specifications, addenda, document search, revision updates, and takeoff handoff.
- A stakeholder directory covering owners, architects, engineers, GCs, bidders, planholders, and awarded contractors.
- A bid board with deadlines, assignments, reminders, notes, custom stages, and win/loss tracking.
- Quote/bid submission with cost, scope, contact details, and attachments.
- GC bid management, invitations to bid, prequalification, bidder engagement, and coverage gaps.
- Digital takeoff, assemblies, estimating, branded proposals, collaboration, analytics, and CRM/accounting integrations.

Official references: [Project Intelligence](https://www.constructconnect.com/products/project-intelligence), [Bid Center](https://www.constructconnect.com/products/bid-center), [Bid Management](https://www.constructconnect.com/products/bid-management), [ConstructConnect Takeoff](https://www.constructconnect.com/products/constructconnect-takeoff), [Quick Bid](https://www.constructconnect.com/en/products/quick-bid).

## PlanHub capabilities to match

- Project Finder, early-stage leads, trade/region preferences, saved filters, and personalized matching.
- Keyword search inside project PDFs, plan rooms, classified documents, downloads, and update notifications.
- Owner, architect, designer, GC, subcontractor, and supplier directories.
- A staged Bid Board with assignments, due dates, reminders, bid values, outside-project imports, and won/lost tracking.
- A lightweight relationship CRM with contacts, tags, notes, tasks, files, interaction history, and win-rate context.
- Project/direct/group messaging and explicit-action Gmail/Outlook sending.
- PDF takeoff, estimation templates, cost items and assemblies, Bid Builder, attachments, multi-GC submission, and submission tracking.
- Market, competition, engagement, pipeline, and relationship analytics plus a licensed data API.

Official references: [Subcontractor platform](https://planhub.com/subcontractors/), [Premier workflow overview](https://knowledgebase.planhub.com/knowledge/premier-for-subcontractors-short-overview), [Takeoff and estimation](https://planhub.com/takeoff-and-estimation/), [PlanHub data API](https://planhub.com/api/).

## Current BidAtlas implementation status

Implemented foundations:

- official-source registry, truthful source health, lifecycle/freshness classification, and resumable ingestion/discovery queues;
- project/product/location/state/stage search with all/any/phrase matching, 10/25/50 paging, and shareable route state;
- separate plans/specifications/drawings/CAD workspace with rights-aware metadata, D1 FTS, content-addressed R2 storage, deduplication, private/workspace/public access boundaries, and internal extraction handoff;
- sourced stakeholder roles, conservative title-block contact parsing, missing-contact gaps, and optional credit-gated professional enrichment;
- estimating line items, commercial terms, recipient verification, release checklist, package export, and authenticated owner-isolated draft persistence;
- source and project deep links that resolve exact Seattle, Tempe, and Pittsburgh records without silently selecting an unrelated fallback.

Not yet parity:

- most state and local source candidates still require human review and a verified production adapter;
- no production OCR/native-CAD conversion farm, calibrated takeoff engine, revision overlay, or assemblies catalog;
- no contractor/architect/owner self-service planroom or human research operation for private and pre-public leads;
- no enabled outbound email or procurement-portal submission connector, invitations, reminders, assignment engine, or delivery receipt loop;
- no full cross-source entity reconciliation, saved-search alert runner, pipeline analytics, CRM/accounting sync, or audited national completeness.

These gaps are product work, source-by-source operations, and external authorization—not data that can be truthfully manufactured from public records.

## BidAtlas product sequence

1. **Discovery and documents** — truthful source coverage, lifecycle/product/location search, saved searches, alerts, versioned documents, and plan/spec extraction.
2. **Project CRM** — stakeholder graph, verified contact points, project roles, provenance, freshness, assignments, notes, tasks, and bid/no-bid pipeline.
3. **Quote and package builder** — reusable Tudelu products, quantities, pricing, scope, exclusions, alternates, lead time, validity, attachments, versions, and immutable package hashes.
4. **Reviewed delivery** — official submission rules, verified recipients, per-package approval, email/portal adapters, receipts, failures, follow-ups, opt-outs, and complete audit history.
5. **Takeoff and estimating** — calibrated PDF measurements, counts/areas/lengths, assemblies, labor/material/freight/waste/markup, revision overlays, and estimate-to-quote handoff.
6. **Analytics and integrations** — funnel and win rate, competition, product demand, territory, source coverage, CRM/accounting/email/calendar, and provider-neutral contact enrichment.

## Contact enrichment and outreach boundary

Apollo can optionally fill missing professional contact fields. It is not the system of record and cannot replace an agency's required submission portal. Every enriched value must preserve provider ID, source/evidence, retrieval time, match confidence, professional/personal classification, verification state, and license restrictions.

Enrichment consumes credits and therefore requires an explicit request. Personal email, personal phone, and waterfall enrichment are off by default. Any send requires a verified business recipient, a reviewed package, the correct allowed purpose, suppression checks, and action-time approval tied to the exact message, price, attachments, and destination.

Official references: [Apollo People Enrichment](https://docs.apollo.io/reference/people-enrichment), [FTC CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).
