CREATE TABLE `coverage_cells` (
	`id` text PRIMARY KEY NOT NULL,
	`jurisdiction_id` text NOT NULL,
	`source_class` text NOT NULL,
	`lifecycle_stage` text NOT NULL,
	`coverage_state` text NOT NULL,
	`source_id` text,
	`public_disclosure_rule` text,
	`last_assessed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`note` text,
	FOREIGN KEY (`jurisdiction_id`) REFERENCES `jurisdictions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_cells_uidx` ON `coverage_cells` (`jurisdiction_id`,`source_class`,`lifecycle_stage`);--> statement-breakpoint
CREATE INDEX `coverage_cells_state_idx` ON `coverage_cells` (`coverage_state`);--> statement-breakpoint
CREATE TABLE `dataset_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog` text NOT NULL,
	`publisher` text,
	`jurisdiction_name` text,
	`title` text NOT NULL,
	`description` text,
	`source_url` text NOT NULL,
	`api_url` text,
	`source_class` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`discovered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_verified_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dataset_candidates_catalog_uidx` ON `dataset_candidates` (`catalog`,`source_url`);--> statement-breakpoint
CREATE INDEX `dataset_candidates_status_idx` ON `dataset_candidates` (`status`,`source_class`);--> statement-breakpoint
CREATE TABLE `document_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`project_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`page_start` integer,
	`page_end` integer,
	`chunk_order` integer NOT NULL,
	`chunk_text` text NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_version_id`) REFERENCES `document_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_chunks_order_uidx` ON `document_chunks` (`extraction_id`,`chunk_order`);--> statement-breakpoint
CREATE INDEX `document_chunks_project_idx` ON `document_chunks` (`project_id`);--> statement-breakpoint
CREATE TABLE `document_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_version_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`extractor` text NOT NULL,
	`extractor_version` text NOT NULL,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`language` text,
	`pages` integer,
	`confidence` real,
	`text_object_key` text,
	`layout_object_key` text,
	`error` text,
	`indexed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_version_id`) REFERENCES `document_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extractions_version_uidx` ON `document_extractions` (`document_version_id`,`extractor`,`extractor_version`);--> statement-breakpoint
CREATE INDEX `document_extractions_status_idx` ON `document_extractions` (`status`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`source_version_id` text,
	`normalized_url` text NOT NULL,
	`content_hash` text,
	`object_key` text,
	`mime_type` text,
	`extension` text,
	`bytes` integer,
	`access_mode` text NOT NULL,
	`archive_policy` text NOT NULL,
	`retrieval_status` text NOT NULL,
	`authoritative` integer DEFAULT true NOT NULL,
	`posted_at` text,
	`retrieved_at` text,
	`supersedes_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_hash_uidx` ON `document_versions` (`document_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `document_versions_document_idx` ON `document_versions` (`document_id`);--> statement-breakpoint
CREATE TABLE `jurisdictions` (
	`id` text PRIMARY KEY NOT NULL,
	`census_government_id` text,
	`name` text NOT NULL,
	`government_type` text NOT NULL,
	`state` text,
	`fips` text,
	`parent_id` text,
	`active` integer DEFAULT true NOT NULL,
	`source_url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jurisdictions_census_uidx` ON `jurisdictions` (`census_government_id`);--> statement-breakpoint
CREATE INDEX `jurisdictions_state_type_idx` ON `jurisdictions` (`state`,`government_type`);--> statement-breakpoint
CREATE TABLE `portal_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_profile_id` text NOT NULL,
	`source_id` text,
	`portal_family` text NOT NULL,
	`jurisdiction_name` text NOT NULL,
	`registration_url` text NOT NULL,
	`login_url` text,
	`username_email` text,
	`credential_reference` text,
	`status` text DEFAULT 'not-started' NOT NULL,
	`verification_status` text DEFAULT 'not-started' NOT NULL,
	`terms_accepted_at` text,
	`last_checked_at` text,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`supplier_profile_id`) REFERENCES `supplier_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portal_accounts_profile_url_uidx` ON `portal_accounts` (`supplier_profile_id`,`registration_url`);--> statement-breakpoint
CREATE INDEX `portal_accounts_status_idx` ON `portal_accounts` (`status`,`verification_status`);--> statement-breakpoint
CREATE TABLE `portal_registration_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_account_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`required_fields` text NOT NULL,
	`blocking_reason` text,
	`next_action` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`portal_account_id`) REFERENCES `portal_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portal_registration_tasks_status_idx` ON `portal_registration_tasks` (`status`);--> statement-breakpoint
CREATE TABLE `project_identifiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`identifier_type` text NOT NULL,
	`identifier_value` text NOT NULL,
	`source_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_identifiers_uidx` ON `project_identifiers` (`identifier_type`,`identifier_value`);--> statement-breakpoint
CREATE INDEX `project_identifiers_project_idx` ON `project_identifiers` (`project_id`);--> statement-breakpoint
CREATE TABLE `supplier_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`legal_name` text NOT NULL,
	`website` text NOT NULL,
	`address_line_1` text NOT NULL,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`postal_code` text NOT NULL,
	`public_phone` text,
	`public_email` text,
	`products` text NOT NULL,
	`source_url` text,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_profiles_name_uidx` ON `supplier_profiles` (`legal_name`);--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD `trigger` text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD `pages_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD `cursor_before` text;--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD `cursor_after` text;--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD `snapshot_complete` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD `metrics` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `connector_version` text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `source_class` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `cursor` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `next_due_at` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `source_reported_total` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `snapshot_complete` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_complete_snapshot_at` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `project_fts` USING fts5(
	`project_id` UNINDEXED,
	`title`,
	`summary`,
	`agency`,
	`owner`,
	`address`,
	`city`,
	`county`,
	`state`,
	`participants`,
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE VIRTUAL TABLE `document_chunk_fts` USING fts5(
	`chunk_id` UNINDEXED,
	`project_id` UNINDEXED,
	`document_version_id` UNINDEXED,
	`chunk_text`,
	tokenize='unicode61 remove_diacritics 2'
);
