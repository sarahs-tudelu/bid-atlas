CREATE INDEX `jurisdictions_name_idx` ON `jurisdictions` (`name`);--> statement-breakpoint
CREATE INDEX `jurisdictions_state_city_idx` ON `jurisdictions` (`state`,`city`);