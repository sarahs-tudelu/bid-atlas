CREATE TABLE `project_opportunity_verifications` (
	`project_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`opportunity_type` text NOT NULL,
	`verification_status` text NOT NULL,
	`accepting_bids` integer DEFAULT false NOT NULL,
	`submission_url` text,
	`evidence` text NOT NULL,
	`verified_at` text,
	`verified_by` text,
	`last_checked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `source_posting_candidates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_opportunity_verifications_candidate_uidx` ON `project_opportunity_verifications` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `project_opportunity_verifications_status_idx` ON `project_opportunity_verifications` (`verification_status`,`accepting_bids`);--> statement-breakpoint
CREATE TABLE `source_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`owner_key` text NOT NULL,
	`name` text NOT NULL,
	`publisher` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`city` text,
	`state` text,
	`source_type` text NOT NULL,
	`feed_url` text NOT NULL,
	`feed_format` text DEFAULT 'auto' NOT NULL,
	`cadence_minutes` integer DEFAULT 1440 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`next_due_at` text,
	`last_checked_at` text,
	`last_success_at` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_monitors_source_uidx` ON `source_monitors` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_monitors_owner_feed_uidx` ON `source_monitors` (`owner_key`,`feed_url`);--> statement-breakpoint
CREATE INDEX `source_monitors_due_idx` ON `source_monitors` (`status`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `source_monitors_owner_idx` ON `source_monitors` (`owner_key`,`updated_at`);--> statement-breakpoint
CREATE TABLE `source_posting_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`project_id` text,
	`source_record_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`source_url` text NOT NULL,
	`publisher` text NOT NULL,
	`city` text,
	`state` text,
	`posted_at` text,
	`bid_date` text,
	`document_url` text,
	`document_name` text,
	`contact_name` text,
	`contact_email` text,
	`contact_phone` text,
	`submission_url` text,
	`trade_tags` text NOT NULL,
	`opportunity_type` text NOT NULL,
	`status` text DEFAULT 'needs-review' NOT NULL,
	`readiness_reasons` text NOT NULL,
	`evidence` text NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reviewed_at` text,
	`reviewed_by` text,
	FOREIGN KEY (`monitor_id`) REFERENCES `source_monitors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_posting_candidates_record_uidx` ON `source_posting_candidates` (`monitor_id`,`source_record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_posting_candidates_project_uidx` ON `source_posting_candidates` (`project_id`);--> statement-breakpoint
CREATE INDEX `source_posting_candidates_monitor_status_idx` ON `source_posting_candidates` (`monitor_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `source_posting_candidates_bid_date_idx` ON `source_posting_candidates` (`status`,`bid_date`);