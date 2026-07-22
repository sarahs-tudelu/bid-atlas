CREATE TABLE `project_research_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`research_job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`finding_type` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`data` text NOT NULL,
	`source_id` text,
	`source_url` text NOT NULL,
	`source_label` text,
	`evidence` text NOT NULL,
	`provenance` text NOT NULL,
	`confidence` real NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`research_job_id`) REFERENCES `project_research_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_research_findings_dedupe_uidx` ON `project_research_findings` (`research_job_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `project_research_findings_project_idx` ON `project_research_findings` (`project_id`,`category`);--> statement-breakpoint
CREATE INDEX `project_research_findings_job_idx` ON `project_research_findings` (`research_job_id`);--> statement-breakpoint
CREATE TABLE `project_research_gaps` (
	`id` text PRIMARY KEY NOT NULL,
	`research_job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`gap_type` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`message` text NOT NULL,
	`next_action` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`research_job_id`) REFERENCES `project_research_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_research_gaps_type_uidx` ON `project_research_gaps` (`research_job_id`,`gap_type`);--> statement-breakpoint
CREATE INDEX `project_research_gaps_project_idx` ON `project_research_gaps` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_research_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`research_job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`finding_id` text,
	`handoff_type` text NOT NULL,
	`status` text DEFAULT 'awaiting-extractor' NOT NULL,
	`source_url` text NOT NULL,
	`detail` text NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`research_job_id`) REFERENCES `project_research_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `project_research_findings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_research_handoffs_source_uidx` ON `project_research_handoffs` (`research_job_id`,`handoff_type`,`source_url`);--> statement-breakpoint
CREATE INDEX `project_research_handoffs_status_idx` ON `project_research_handoffs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `project_research_handoffs_project_idx` ON `project_research_handoffs` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_research_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`cache_key` text NOT NULL,
	`visibility` text DEFAULT 'workspace' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_by` text NOT NULL,
	`trigger` text DEFAULT 'project-open' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`fresh_until` text,
	`next_retry_at` text,
	`lease_owner` text,
	`lease_expires_at` text,
	`public_approved_at` text,
	`public_approved_by` text,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_research_jobs_cache_uidx` ON `project_research_jobs` (`cache_key`);--> statement-breakpoint
CREATE INDEX `project_research_jobs_project_idx` ON `project_research_jobs` (`project_id`,`visibility`);--> statement-breakpoint
CREATE INDEX `project_research_jobs_due_idx` ON `project_research_jobs` (`status`,`next_retry_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `project_research_jobs_fresh_idx` ON `project_research_jobs` (`fresh_until`);--> statement-breakpoint
CREATE TABLE `project_research_source_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`research_job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text,
	`source_url` text NOT NULL,
	`final_url` text,
	`status` text NOT NULL,
	`http_status` integer,
	`content_type` text,
	`bytes_read` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	FOREIGN KEY (`research_job_id`) REFERENCES `project_research_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_research_attempts_job_idx` ON `project_research_source_attempts` (`research_job_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `project_research_attempts_project_idx` ON `project_research_source_attempts` (`project_id`,`status`);