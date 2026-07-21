DROP INDEX `bid_opportunities_scope_uidx`;--> statement-breakpoint
ALTER TABLE `bid_opportunities` ADD `owner_key` text DEFAULT 'legacy-workspace' NOT NULL;--> statement-breakpoint
CREATE INDEX `bid_opportunities_owner_project_idx` ON `bid_opportunities` (`owner_key`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bid_opportunities_scope_uidx` ON `bid_opportunities` (`supplier_profile_id`,`owner_key`,`project_id`,`scope_key`);--> statement-breakpoint
DROP INDEX `bid_packages_version_uidx`;--> statement-breakpoint
ALTER TABLE `bid_packages` ADD `owner_key` text DEFAULT 'legacy-workspace' NOT NULL;--> statement-breakpoint
UPDATE `bid_opportunities`
SET `owner_key`=coalesce((
  SELECT lower(trim(`packages`.`created_by`))
  FROM `bid_packages` `packages`
  WHERE `packages`.`bid_opportunity_id`=`bid_opportunities`.`id`
    AND `packages`.`created_by` IS NOT NULL
    AND length(trim(`packages`.`created_by`)) <= 254
    AND instr(trim(`packages`.`created_by`), '@') BETWEEN 2 AND 65
    AND instr(
      substr(
        trim(`packages`.`created_by`),
        instr(trim(`packages`.`created_by`), '@') + 1
      ),
      '@'
    ) = 0
    AND instr(
      substr(
        trim(`packages`.`created_by`),
        instr(trim(`packages`.`created_by`), '@') + 1
      ),
      '.'
    ) > 1
    AND trim(`packages`.`created_by`) NOT LIKE '% %'
    AND trim(`packages`.`created_by`) NOT LIKE '%..%'
  ORDER BY `packages`.`updated_at` DESC, `packages`.`id` DESC
  LIMIT 1
), 'legacy-workspace');--> statement-breakpoint
UPDATE `bid_packages`
SET `owner_key`=(
  SELECT `opportunities`.`owner_key`
  FROM `bid_opportunities` `opportunities`
  WHERE `opportunities`.`id`=`bid_packages`.`bid_opportunity_id`
)
WHERE EXISTS (
  SELECT 1
  FROM `bid_opportunities` `opportunities`
  WHERE `opportunities`.`id`=`bid_packages`.`bid_opportunity_id`
);--> statement-breakpoint
CREATE INDEX `bid_packages_owner_idx` ON `bid_packages` (`owner_key`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `bid_packages_version_uidx` ON `bid_packages` (`bid_opportunity_id`,`owner_key`,`package_number`,`version`);
