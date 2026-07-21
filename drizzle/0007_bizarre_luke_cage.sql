CREATE TABLE `coverage_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`jurisdiction_id` text NOT NULL,
	`source_class` text NOT NULL,
	`lifecycle_stage` text NOT NULL,
	`source_id` text NOT NULL,
	`evidence_state` text NOT NULL,
	`last_assessed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`note` text,
	FOREIGN KEY (`jurisdiction_id`) REFERENCES `jurisdictions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_evidence_uidx` ON `coverage_evidence` (`jurisdiction_id`,`source_class`,`lifecycle_stage`,`source_id`);--> statement-breakpoint
CREATE INDEX `coverage_evidence_source_state_idx` ON `coverage_evidence` (`source_id`,`evidence_state`);--> statement-breakpoint
CREATE INDEX `coverage_evidence_cell_idx` ON `coverage_evidence` (`jurisdiction_id`,`source_class`,`lifecycle_stage`);--> statement-breakpoint
INSERT INTO `coverage_evidence` (
	`id`, `jurisdiction_id`, `source_class`, `lifecycle_stage`, `source_id`,
	`evidence_state`, `last_assessed_at`, `note`
)
SELECT
	'coverage-evidence:migrated:' || `id`, `jurisdiction_id`, `source_class`,
	`lifecycle_stage`, `source_id`, `coverage_state`, `last_assessed_at`,
	'Backfilled from the pre-evidence coverage cell. ' || coalesce(`note`, '')
FROM `coverage_cells`
WHERE `source_id` IS NOT NULL;--> statement-breakpoint
UPDATE `coverage_cells`
SET `coverage_state`=COALESCE((
		SELECT CASE
			WHEN MAX(CASE WHEN `evidence`.`evidence_state`='connected'
								 AND `evidence_sources`.`status`='live'
								 AND `evidence_sources`.`last_success_at` IS NOT NULL
						   THEN 1 ELSE 0 END)=1 THEN 'connected'
			WHEN MAX(CASE WHEN `evidence`.`evidence_state`='credential-required'
						   THEN 1 ELSE 0 END)=1 THEN 'credential-required'
			ELSE 'partial'
		END
		FROM `coverage_evidence` AS `evidence`
		JOIN `sources` AS `evidence_sources` ON `evidence_sources`.`id`=`evidence`.`source_id`
		WHERE `evidence`.`jurisdiction_id`=`coverage_cells`.`jurisdiction_id`
		  AND `evidence`.`source_class`=`coverage_cells`.`source_class`
		  AND `evidence`.`lifecycle_stage`=`coverage_cells`.`lifecycle_stage`
	), 'not-connected'),
	`source_id`=NULL,
	`last_assessed_at`=CURRENT_TIMESTAMP,
	`note`='Aggregate state derived from per-source coverage evidence.'
WHERE EXISTS (
	SELECT 1 FROM `coverage_evidence` AS `migrated_evidence`
	WHERE `migrated_evidence`.`jurisdiction_id`=`coverage_cells`.`jurisdiction_id`
	  AND `migrated_evidence`.`source_class`=`coverage_cells`.`source_class`
	  AND `migrated_evidence`.`lifecycle_stage`=`coverage_cells`.`lifecycle_stage`
);
