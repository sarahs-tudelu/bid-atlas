CREATE TABLE `document_blobs` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`mime_type` text NOT NULL,
	`extension` text,
	`storage_status` text DEFAULT 'ready' NOT NULL,
	`security_status` text DEFAULT 'unscanned' NOT NULL,
	`r2_etag` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_verified_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_blobs_object_key_uidx` ON `document_blobs` (`object_key`);--> statement-breakpoint
CREATE INDEX `document_blobs_security_idx` ON `document_blobs` (`security_status`,`storage_status`);--> statement-breakpoint
ALTER TABLE `document_versions` ADD `file_name` text;--> statement-breakpoint
ALTER TABLE `document_versions` ADD `ingestion_method` text DEFAULT 'source-link' NOT NULL;--> statement-breakpoint
ALTER TABLE `document_versions` ADD `processing_status` text DEFAULT 'metadata-only' NOT NULL;--> statement-breakpoint
ALTER TABLE `document_versions` ADD `processing_error` text;--> statement-breakpoint
ALTER TABLE `document_versions` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `discipline` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `sheet_numbers` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `keywords` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `visibility` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `license_code` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `license_url` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `redistribution_allowed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `provenance` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `ingestion_method` text DEFAULT 'source-link' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `processing_status` text DEFAULT 'metadata-only' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `processing_error` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `search_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `file_name` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `bytes` integer;--> statement-breakpoint
ALTER TABLE `documents` ADD `uploaded_by` text;--> statement-breakpoint
CREATE INDEX `documents_processing_idx` ON `documents` (`processing_status`);--> statement-breakpoint
CREATE INDEX `documents_visibility_idx` ON `documents` (`visibility`,`access_mode`,`redistribution_allowed`);--> statement-breakpoint
CREATE VIRTUAL TABLE `document_metadata_fts` USING fts5(
	`document_id` UNINDEXED,
	`project_id` UNINDEXED,
	`name`,
	`document_type`,
	`description`,
	`discipline`,
	`sheet_numbers`,
	`keywords`,
	`search_text`,
	`source_url`,
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO `document_metadata_fts` (
	`document_id`, `project_id`, `name`, `document_type`, `description`, `discipline`,
	`sheet_numbers`, `keywords`, `search_text`, `source_url`
)
SELECT
	`id`, `project_id`, `name`, `document_type`, `description`, coalesce(`discipline`, ''),
	coalesce(`sheet_numbers`, '[]'), coalesce(`keywords`, '[]'), `search_text`, `source_url`
FROM `documents`;--> statement-breakpoint
CREATE TRIGGER `documents_metadata_fts_insert` AFTER INSERT ON `documents` BEGIN
	INSERT INTO `document_metadata_fts` (
		`document_id`, `project_id`, `name`, `document_type`, `description`, `discipline`,
		`sheet_numbers`, `keywords`, `search_text`, `source_url`
	) VALUES (
		new.`id`, new.`project_id`, new.`name`, new.`document_type`, new.`description`,
		coalesce(new.`discipline`, ''), coalesce(new.`sheet_numbers`, '[]'),
		coalesce(new.`keywords`, '[]'), new.`search_text`, new.`source_url`
	);
END;--> statement-breakpoint
CREATE TRIGGER `documents_metadata_fts_update` AFTER UPDATE OF
	`project_id`, `name`, `document_type`, `description`, `discipline`, `sheet_numbers`,
	`keywords`, `search_text`, `source_url` ON `documents` BEGIN
	DELETE FROM `document_metadata_fts` WHERE `document_id` = old.`id`;
	INSERT INTO `document_metadata_fts` (
		`document_id`, `project_id`, `name`, `document_type`, `description`, `discipline`,
		`sheet_numbers`, `keywords`, `search_text`, `source_url`
	) VALUES (
		new.`id`, new.`project_id`, new.`name`, new.`document_type`, new.`description`,
		coalesce(new.`discipline`, ''), coalesce(new.`sheet_numbers`, '[]'),
		coalesce(new.`keywords`, '[]'), new.`search_text`, new.`source_url`
	);
END;--> statement-breakpoint
CREATE TRIGGER `documents_metadata_fts_delete` AFTER DELETE ON `documents` BEGIN
	DELETE FROM `document_metadata_fts` WHERE `document_id` = old.`id`;
END;
