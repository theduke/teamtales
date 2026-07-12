CREATE TABLE `provider_resources` (
	`id` varchar(120) PRIMARY KEY,
	`organization_id` varchar(120) NOT NULL,
	`integration_id` varchar(120) NOT NULL,
	`provider` varchar(120) NOT NULL,
	`resource_type` varchar(120) NOT NULL,
	`external_id` varchar(120) NOT NULL,
	`external_parent_id` varchar(120),
	`parent_resource_id` varchar(120),
	`display_name` varchar(120) NOT NULL,
	`external_url` text,
	`metadata_json` text NOT NULL DEFAULT ('{}'),
	`discovery_state` varchar(120) NOT NULL DEFAULT 'active',
	`discovered_at` varchar(40) NOT NULL,
	`last_seen_at` varchar(40) NOT NULL,
	`sync_status` varchar(120) NOT NULL DEFAULT 'idle',
	`current_sync_run_id` varchar(120),
	`last_sync_started_at` varchar(40),
	`last_sync_succeeded_at` varchar(40),
	`last_sync_failed_at` varchar(40),
	`last_sync_error` text,
	`next_attempt_at` varchar(40),
	`consecutive_failure_count` int NOT NULL DEFAULT 0,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `provider_resources_integration_type_external_uq` UNIQUE INDEX(`integration_id`,`resource_type`,`external_id`),
	CONSTRAINT `provider_resources_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `provider_resources_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`),
	CONSTRAINT `provider_resources_lIK7zKA0xY6b_fkey` FOREIGN KEY (`parent_resource_id`) REFERENCES `provider_resources`(`id`)
);
--> statement-breakpoint
INSERT INTO `provider_resources` (`id`, `organization_id`, `integration_id`, `provider`, `resource_type`, `external_id`, `display_name`, `discovered_at`, `last_seen_at`, `created_at`, `updated_at`)
SELECT CONCAT('provider_resource_', SUBSTRING(SHA2(CONCAT(`organization_id`, ':', `integration_id`, ':', `scope_type`, ':', COALESCE(`external_id`, `external_name`)), 256), 1, 64)), `organization_id`, `integration_id`, `provider`, `scope_type`, COALESCE(`external_id`, `external_name`), `external_name`, `created_at`, `updated_at`, `created_at`, `updated_at`
FROM `sync_scopes`
ON DUPLICATE KEY UPDATE `last_seen_at` = VALUES(`last_seen_at`), `updated_at` = VALUES(`updated_at`);
--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD `provider_resource_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `provider_resource_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `parent_sync_run_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `run_kind` varchar(120) DEFAULT 'resource' NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `queued_at` varchar(40);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `lease_expires_at` varchar(40);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `next_attempt_at` varchar(40);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `attempt` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `updated_at` varchar(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD `provider_resource_id` varchar(120);--> statement-breakpoint
UPDATE `sync_scopes` AS `scope`
JOIN `provider_resources` AS `resource` ON `resource`.`integration_id` = `scope`.`integration_id` AND `resource`.`resource_type` = `scope`.`scope_type` AND `resource`.`external_id` = COALESCE(`scope`.`external_id`, `scope`.`external_name`)
SET `scope`.`provider_resource_id` = `resource`.`id`;--> statement-breakpoint
CREATE INDEX `provider_resources_hierarchy_idx` ON `provider_resources` (`integration_id`,`parent_resource_id`,`discovery_state`);--> statement-breakpoint
CREATE INDEX `provider_resources_status_idx` ON `provider_resources` (`organization_id`,`integration_id`,`provider`,`resource_type`,`sync_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_cursors_resource_object_kind_uq` ON `sync_cursors` (`provider_resource_id`,`object_type`,`cursor_kind`);--> statement-breakpoint
CREATE INDEX `sync_runs_parent_status_idx` ON `sync_runs` (`parent_sync_run_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_resource_status_idx` ON `sync_runs` (`provider_resource_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_queue_idx` ON `sync_runs` (`status`,`next_attempt_at`,`queued_at`);--> statement-breakpoint
CREATE INDEX `sync_scopes_resource_idx` ON `sync_scopes` (`provider_resource_id`);--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD CONSTRAINT `sync_cursors_provider_resource_id_provider_resources_id_fkey` FOREIGN KEY (`provider_resource_id`) REFERENCES `provider_resources`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_provider_resource_id_provider_resources_id_fkey` FOREIGN KEY (`provider_resource_id`) REFERENCES `provider_resources`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_parent_sync_run_id_sync_runs_id_fkey` FOREIGN KEY (`parent_sync_run_id`) REFERENCES `sync_runs`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_provider_resource_id_provider_resources_id_fkey` FOREIGN KEY (`provider_resource_id`) REFERENCES `provider_resources`(`id`) ON DELETE SET NULL;
