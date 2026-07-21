ALTER TABLE `jurisdictions` ADD `registry_kind` text DEFAULT 'independent-government' NOT NULL;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `fips_state` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `fips_county` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `fips_place` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `address_line_1` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `address_line_2` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `city` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `postal_code` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `website` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `political_code` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `function_name` text;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `population` integer;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `population_year` integer;--> statement-breakpoint
ALTER TABLE `jurisdictions` ADD `county_area_name` text;