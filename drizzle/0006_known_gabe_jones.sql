CREATE TABLE `dataset_candidate_jurisdictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` text NOT NULL,
	`jurisdiction_id` text NOT NULL,
	`match_method` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence_url` text,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `dataset_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`jurisdiction_id`) REFERENCES `jurisdictions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dataset_candidate_jurisdictions_uidx` ON `dataset_candidate_jurisdictions` (`candidate_id`,`jurisdiction_id`);--> statement-breakpoint
CREATE INDEX `dataset_candidate_jurisdictions_candidate_idx` ON `dataset_candidate_jurisdictions` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `dataset_candidate_jurisdictions_jurisdiction_idx` ON `dataset_candidate_jurisdictions` (`jurisdiction_id`);