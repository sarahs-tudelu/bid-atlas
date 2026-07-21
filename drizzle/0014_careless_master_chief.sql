CREATE TABLE `integration_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_secret` text NOT NULL,
	`iv` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_credentials_owner_provider_uidx` ON `integration_credentials` (`owner_key`,`provider`);--> statement-breakpoint
CREATE INDEX `integration_credentials_owner_idx` ON `integration_credentials` (`owner_key`);