ALTER TABLE `dataset_candidates` ADD `portal_family` text;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `portal_confidence` real;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `portal_classifier_version` text;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `portal_evidence` text;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `portal_network_access_status` text DEFAULT 'disabled-until-reviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `portal_review_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `portal_connection_state` text DEFAULT 'not-connected' NOT NULL;--> statement-breakpoint
ALTER TABLE `dataset_candidates` ADD `classified_at` text;--> statement-breakpoint
CREATE INDEX `dataset_candidates_portal_review_idx` ON `dataset_candidates` (`portal_review_status`,`portal_family`);