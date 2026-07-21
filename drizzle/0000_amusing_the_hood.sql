CREATE TABLE `coverage_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`government_id` text NOT NULL,
	`government_name` text NOT NULL,
	`government_type` text NOT NULL,
	`state` text,
	`lifecycle_stage` text NOT NULL,
	`coverage_state` text NOT NULL,
	`source_id` text,
	`public_disclosure_rule` text,
	`checked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`note` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_government_stage_uidx` ON `coverage_ledger` (`government_id`,`lifecycle_stage`);--> statement-breakpoint
CREATE INDEX `coverage_state_status_idx` ON `coverage_ledger` (`state`,`coverage_state`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`document_type` text NOT NULL,
	`source_url` text NOT NULL,
	`access_mode` text NOT NULL,
	`mime_type` text,
	`content_hash` text,
	`object_key` text,
	`published_at` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_source_url_uidx` ON `documents` (`project_id`,`source_url`);--> statement-breakpoint
CREATE INDEX `documents_project_idx` ON `documents` (`project_id`);--> statement-breakpoint
CREATE INDEX `documents_type_idx` ON `documents` (`document_type`);--> statement-breakpoint
CREATE TABLE `ingestion_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`records_read` integer DEFAULT 0 NOT NULL,
	`projects_created` integer DEFAULT 0 NOT NULL,
	`projects_updated` integer DEFAULT 0 NOT NULL,
	`documents_found` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ingestion_runs_source_started_idx` ON `ingestion_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_name` text NOT NULL,
	`display_name` text NOT NULL,
	`organization_type` text NOT NULL,
	`uei` text,
	`website` text,
	`city` text,
	`state` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_name_uidx` ON `organizations` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `project_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`event_type` text NOT NULL,
	`stage` text NOT NULL,
	`title` text NOT NULL,
	`occurred_at` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_events_project_idx` ON `project_events` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_events_occurred_idx` ON `project_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `project_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`role` text NOT NULL,
	`participation_status` text NOT NULL,
	`source_id` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_participants_role_uidx` ON `project_participants` (`project_id`,`organization_id`,`role`);--> statement-breakpoint
CREATE INDEX `project_participants_org_idx` ON `project_participants` (`organization_id`);--> statement-breakpoint
CREATE TABLE `project_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_url` text NOT NULL,
	`raw_hash` text,
	`confidence` text NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_record_uidx` ON `project_sources` (`source_id`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_key` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`agency` text NOT NULL,
	`owner_name` text,
	`architect_name` text,
	`engineer_name` text,
	`address` text,
	`city` text,
	`county` text,
	`state` text,
	`postal_code` text,
	`latitude` real,
	`longitude` real,
	`estimated_value` real,
	`posted_at` text,
	`bid_date` text,
	`award_date` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_canonical_key_uidx` ON `projects` (`canonical_key`);--> statement-breakpoint
CREATE INDEX `projects_stage_idx` ON `projects` (`stage`);--> statement-breakpoint
CREATE INDEX `projects_state_idx` ON `projects` (`state`);--> statement-breakpoint
CREATE INDEX `projects_bid_date_idx` ON `projects` (`bid_date`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`jurisdiction_id` text,
	`jurisdiction_name` text NOT NULL,
	`jurisdiction_level` text NOT NULL,
	`connector` text NOT NULL,
	`source_url` text NOT NULL,
	`access_mode` text NOT NULL,
	`cadence_minutes` integer NOT NULL,
	`status` text NOT NULL,
	`lifecycle_stages` text NOT NULL,
	`last_checked_at` text,
	`last_success_at` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sources_jurisdiction_idx` ON `sources` (`jurisdiction_id`);--> statement-breakpoint
CREATE INDEX `sources_status_idx` ON `sources` (`status`);