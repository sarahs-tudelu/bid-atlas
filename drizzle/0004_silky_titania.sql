CREATE TABLE `bid_activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_opportunity_id` text NOT NULL,
	`bid_package_id` text,
	`bid_recipient_id` text,
	`bid_submission_id` text,
	`contact_id` text,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`source_system` text NOT NULL,
	`source_event_id` text,
	`previous_status` text,
	`new_status` text,
	`payload` text,
	`payload_hash` text NOT NULL,
	`dedupe_key` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`bid_opportunity_id`) REFERENCES `bid_opportunities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bid_package_id`) REFERENCES `bid_packages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bid_recipient_id`) REFERENCES `bid_recipients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bid_submission_id`) REFERENCES `bid_submissions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_activity_events_dedupe_uidx` ON `bid_activity_events` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `bid_activity_events_source_uidx` ON `bid_activity_events` (`source_system`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `bid_activity_events_opportunity_idx` ON `bid_activity_events` (`bid_opportunity_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `bid_activity_events_package_idx` ON `bid_activity_events` (`bid_package_id`);--> statement-breakpoint
CREATE INDEX `bid_activity_events_submission_idx` ON `bid_activity_events` (`bid_submission_id`);--> statement-breakpoint
CREATE TABLE `bid_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_package_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`item_type` text DEFAULT 'product' NOT NULL,
	`master_format_code` text,
	`manufacturer` text,
	`sku` text,
	`description` text NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`unit_cost` real,
	`unit_price` real NOT NULL,
	`markup_percent` real,
	`amount` real NOT NULL,
	`taxable` integer DEFAULT false NOT NULL,
	`is_alternate` integer DEFAULT false NOT NULL,
	`alternate_group` text,
	`notes` text,
	`source_document_id` text,
	`source_page` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`bid_package_id`) REFERENCES `bid_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_line_items_number_uidx` ON `bid_line_items` (`bid_package_id`,`line_number`);--> statement-breakpoint
CREATE INDEX `bid_line_items_masterformat_idx` ON `bid_line_items` (`master_format_code`);--> statement-breakpoint
CREATE INDEX `bid_line_items_source_document_idx` ON `bid_line_items` (`source_document_id`);--> statement-breakpoint
CREATE TABLE `bid_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_profile_id` text NOT NULL,
	`project_id` text NOT NULL,
	`saved_search_id` text,
	`scope_key` text DEFAULT 'primary' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`fit_score` real,
	`project_title_snapshot` text NOT NULL,
	`project_stage_snapshot` text NOT NULL,
	`product_matches` text,
	`scope_summary` text,
	`decision` text DEFAULT 'undecided' NOT NULL,
	`decision_reason` text,
	`assigned_to` text,
	`bid_due_at` text,
	`expected_value` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`source_id` text,
	`source_url` text,
	`provenance` text,
	`confidence` real,
	`verified_at` text,
	`discovered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`supplier_profile_id`) REFERENCES `supplier_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_search_id`) REFERENCES `saved_searches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_opportunities_scope_uidx` ON `bid_opportunities` (`supplier_profile_id`,`project_id`,`scope_key`);--> statement-breakpoint
CREATE INDEX `bid_opportunities_pipeline_idx` ON `bid_opportunities` (`supplier_profile_id`,`status`,`bid_due_at`);--> statement-breakpoint
CREATE INDEX `bid_opportunities_project_idx` ON `bid_opportunities` (`project_id`);--> statement-breakpoint
CREATE INDEX `bid_opportunities_saved_search_idx` ON `bid_opportunities` (`saved_search_id`);--> statement-breakpoint
CREATE TABLE `bid_package_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_package_id` text NOT NULL,
	`document_id` text,
	`attachment_type` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text,
	`bytes` integer,
	`object_key` text,
	`source_url` text,
	`content_hash` text,
	`included` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`bid_package_id`) REFERENCES `bid_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_package_attachments_hash_uidx` ON `bid_package_attachments` (`bid_package_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `bid_package_attachments_package_idx` ON `bid_package_attachments` (`bid_package_id`,`attachment_type`);--> statement-breakpoint
CREATE INDEX `bid_package_attachments_document_idx` ON `bid_package_attachments` (`document_id`);--> statement-breakpoint
CREATE TABLE `bid_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_opportunity_id` text NOT NULL,
	`package_number` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`supersedes_package_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scope_description` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`direct_cost` real DEFAULT 0 NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`tax` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`valid_until` text,
	`cover_message` text,
	`assumptions` text,
	`exclusions` text,
	`terms` text,
	`requires_approval` integer DEFAULT true NOT NULL,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`approval_note` text,
	`content_hash` text,
	`finalized_at` text,
	`locked_at` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`bid_opportunity_id`) REFERENCES `bid_opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_packages_version_uidx` ON `bid_packages` (`bid_opportunity_id`,`package_number`,`version`);--> statement-breakpoint
CREATE INDEX `bid_packages_status_idx` ON `bid_packages` (`bid_opportunity_id`,`status`);--> statement-breakpoint
CREATE INDEX `bid_packages_approval_idx` ON `bid_packages` (`approval_status`);--> statement-breakpoint
CREATE TABLE `bid_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_package_id` text NOT NULL,
	`project_contact_id` integer,
	`contact_id` text,
	`organization_id` text,
	`portal_account_id` text,
	`recipient_role` text NOT NULL,
	`delivery_channel` text NOT NULL,
	`destination` text NOT NULL,
	`normalized_destination` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`verified_at` text,
	`verified_by` text,
	`consent_basis` text,
	`last_delivery_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`bid_package_id`) REFERENCES `bid_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_contact_id`) REFERENCES `project_contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`portal_account_id`) REFERENCES `portal_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_recipients_destination_uidx` ON `bid_recipients` (`bid_package_id`,`delivery_channel`,`normalized_destination`);--> statement-breakpoint
CREATE INDEX `bid_recipients_status_idx` ON `bid_recipients` (`bid_package_id`,`status`);--> statement-breakpoint
CREATE INDEX `bid_recipients_contact_idx` ON `bid_recipients` (`contact_id`);--> statement-breakpoint
CREATE TABLE `bid_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_package_id` text NOT NULL,
	`bid_recipient_id` text NOT NULL,
	`portal_account_id` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`delivery_channel` text NOT NULL,
	`provider_key` text NOT NULL,
	`external_submission_id` text,
	`idempotency_key` text NOT NULL,
	`approval_status` text NOT NULL,
	`approved_by` text NOT NULL,
	`approved_at` text NOT NULL,
	`approval_evidence_hash` text NOT NULL,
	`package_content_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`payload_object_key` text NOT NULL,
	`immutable_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`submitted_at` text NOT NULL,
	`transport_status` text NOT NULL,
	`acceptance_status` text DEFAULT 'unknown' NOT NULL,
	`receipt_reference` text,
	`receipt_url` text,
	`receipt_object_key` text,
	`receipt_hash` text,
	`receipt_captured_at` text,
	`response_code` text,
	`provider_response_hash` text,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`bid_package_id`) REFERENCES `bid_packages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bid_recipient_id`) REFERENCES `bid_recipients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portal_account_id`) REFERENCES `portal_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bid_submissions_idempotency_uidx` ON `bid_submissions` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `bid_submissions_attempt_uidx` ON `bid_submissions` (`bid_package_id`,`bid_recipient_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `bid_submissions_external_uidx` ON `bid_submissions` (`provider_key`,`external_submission_id`);--> statement-breakpoint
CREATE INDEX `bid_submissions_package_idx` ON `bid_submissions` (`bid_package_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `bid_submissions_status_idx` ON `bid_submissions` (`transport_status`,`acceptance_status`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_key` text NOT NULL,
	`organization_id` text,
	`contact_type` text DEFAULT 'person' NOT NULL,
	`display_name` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`job_title` text,
	`email` text,
	`normalized_email` text,
	`phone` text,
	`phone_extension` text,
	`linkedin_url` text,
	`city` text,
	`state` text,
	`country` text DEFAULT 'US' NOT NULL,
	`source_id` text,
	`source_record_id` text,
	`source_url` text,
	`provenance` text,
	`confidence` real,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`email_verification_status` text DEFAULT 'unknown' NOT NULL,
	`phone_verification_status` text DEFAULT 'unknown' NOT NULL,
	`verified_at` text,
	`verified_by` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_canonical_key_uidx` ON `contacts` (`canonical_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_source_record_uidx` ON `contacts` (`source_id`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `contacts_organization_idx` ON `contacts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `contacts_email_idx` ON `contacts` (`normalized_email`);--> statement-breakpoint
CREATE INDEX `contacts_verification_idx` ON `contacts` (`verification_status`);--> statement-breakpoint
CREATE TABLE `enrichment_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_key` text NOT NULL,
	`provider_request_id` text,
	`idempotency_key` text NOT NULL,
	`contact_id` text,
	`organization_id` text,
	`project_id` text,
	`requested_fields` text NOT NULL,
	`input_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`legal_basis` text,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`source_url` text,
	`provider_terms_version` text,
	`result_object_key` text,
	`result_hash` text,
	`result_summary` text,
	`result_confidence` real,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`cost` real,
	`requested_by` text,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`expires_at` text,
	`error` text,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrichment_requests_idempotency_uidx` ON `enrichment_requests` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `enrichment_requests_provider_uidx` ON `enrichment_requests` (`provider_key`,`provider_request_id`);--> statement-breakpoint
CREATE INDEX `enrichment_requests_status_idx` ON `enrichment_requests` (`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `enrichment_requests_contact_idx` ON `enrichment_requests` (`contact_id`);--> statement-breakpoint
CREATE INDEX `enrichment_requests_organization_idx` ON `enrichment_requests` (`organization_id`);--> statement-breakpoint
CREATE TABLE `outreach_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`suppression_key` text NOT NULL,
	`supplier_profile_id` text NOT NULL,
	`contact_id` text,
	`organization_id` text,
	`project_id` text,
	`channel` text NOT NULL,
	`destination_hash` text NOT NULL,
	`destination_masked` text,
	`scope` text DEFAULT 'global' NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`source_reference` text,
	`provenance` text,
	`status` text DEFAULT 'active' NOT NULL,
	`effective_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`supplier_profile_id`) REFERENCES `supplier_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_suppressions_key_uidx` ON `outreach_suppressions` (`suppression_key`);--> statement-breakpoint
CREATE INDEX `outreach_suppressions_destination_idx` ON `outreach_suppressions` (`destination_hash`,`channel`,`status`);--> statement-breakpoint
CREATE INDEX `outreach_suppressions_profile_idx` ON `outreach_suppressions` (`supplier_profile_id`,`status`);--> statement-breakpoint
CREATE INDEX `outreach_suppressions_contact_idx` ON `outreach_suppressions` (`contact_id`);--> statement-breakpoint
CREATE TABLE `project_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`organization_id` text,
	`role` text NOT NULL,
	`role_source_text` text,
	`relationship_status` text DEFAULT 'observed' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`is_decision_maker` integer DEFAULT false NOT NULL,
	`source_id` text,
	`source_record_id` text,
	`source_url` text,
	`provenance` text,
	`confidence` real,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`verified_at` text,
	`verified_by` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_contacts_role_uidx` ON `project_contacts` (`project_id`,`contact_id`,`role`);--> statement-breakpoint
CREATE INDEX `project_contacts_project_role_idx` ON `project_contacts` (`project_id`,`role`);--> statement-breakpoint
CREATE INDEX `project_contacts_contact_idx` ON `project_contacts` (`contact_id`);--> statement-breakpoint
CREATE INDEX `project_contacts_organization_idx` ON `project_contacts` (`organization_id`);--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_profile_id` text NOT NULL,
	`name` text NOT NULL,
	`query_text` text,
	`keywords` text NOT NULL,
	`match_mode` text DEFAULT 'any' NOT NULL,
	`stages` text NOT NULL,
	`states` text NOT NULL,
	`location_query` text,
	`project_types` text,
	`master_format_codes` text,
	`product_terms` text,
	`filters` text,
	`status` text DEFAULT 'active' NOT NULL,
	`alert_enabled` integer DEFAULT false NOT NULL,
	`alert_cadence_minutes` integer,
	`alert_destination` text,
	`next_run_at` text,
	`last_run_at` text,
	`last_result_count` integer,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`supplier_profile_id`) REFERENCES `supplier_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_searches_profile_name_uidx` ON `saved_searches` (`supplier_profile_id`,`name`);--> statement-breakpoint
CREATE INDEX `saved_searches_due_idx` ON `saved_searches` (`status`,`alert_enabled`,`next_run_at`);