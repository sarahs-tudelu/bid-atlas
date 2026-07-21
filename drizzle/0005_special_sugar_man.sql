CREATE TABLE `jurisdiction_discovery_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`jurisdiction_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`required_source_classes` text NOT NULL,
	`completed_source_classes` text NOT NULL,
	`current_source_class` text,
	`connector_family` text,
	`source_candidates_found` integer DEFAULT 0 NOT NULL,
	`connected_sources` integer DEFAULT 0 NOT NULL,
	`loaded_projects` integer DEFAULT 0 NOT NULL,
	`indexed_documents` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`next_run_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_started_at` text,
	`last_finished_at` text,
	`last_success_at` text,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`jurisdiction_id`) REFERENCES `jurisdictions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jurisdiction_discovery_jobs_jurisdiction_uidx` ON `jurisdiction_discovery_jobs` (`jurisdiction_id`);--> statement-breakpoint
CREATE INDEX `jurisdiction_discovery_jobs_due_idx` ON `jurisdiction_discovery_jobs` (`status`,`next_run_at`,`priority`);--> statement-breakpoint
CREATE INDEX `jurisdiction_discovery_jobs_lease_idx` ON `jurisdiction_discovery_jobs` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `jurisdiction_metrics` (
	`jurisdiction_id` text PRIMARY KEY NOT NULL,
	`loaded_projects` integer DEFAULT 0 NOT NULL,
	`planning_projects` integer DEFAULT 0 NOT NULL,
	`design_projects` integer DEFAULT 0 NOT NULL,
	`permitting_projects` integer DEFAULT 0 NOT NULL,
	`bidding_projects` integer DEFAULT 0 NOT NULL,
	`bid_opened_projects` integer DEFAULT 0 NOT NULL,
	`awarded_projects` integer DEFAULT 0 NOT NULL,
	`public_documents` integer DEFAULT 0 NOT NULL,
	`indexed_documents` integer DEFAULT 0 NOT NULL,
	`connected_source_classes` integer DEFAULT 0 NOT NULL,
	`required_source_classes` integer DEFAULT 7 NOT NULL,
	`last_project_at` text,
	`refreshed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`jurisdiction_id`) REFERENCES `jurisdictions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jurisdiction_metrics_projects_idx` ON `jurisdiction_metrics` (`loaded_projects`);--> statement-breakpoint
CREATE INDEX `jurisdiction_metrics_connection_idx` ON `jurisdiction_metrics` (`connected_source_classes`,`required_source_classes`);--> statement-breakpoint
CREATE TABLE `project_jurisdictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`jurisdiction_id` text NOT NULL,
	`relationship` text DEFAULT 'site' NOT NULL,
	`match_method` text NOT NULL,
	`confidence` real NOT NULL,
	`source_url` text,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`verified_at` text,
	`verified_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`jurisdiction_id`) REFERENCES `jurisdictions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_jurisdictions_relationship_uidx` ON `project_jurisdictions` (`project_id`,`jurisdiction_id`,`relationship`);--> statement-breakpoint
CREATE INDEX `project_jurisdictions_project_idx` ON `project_jurisdictions` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_jurisdictions_jurisdiction_idx` ON `project_jurisdictions` (`jurisdiction_id`);