CREATE TABLE `github_organizations` (
	`id` varchar(120) PRIMARY KEY,
	`organization_id` varchar(120) NOT NULL,
	`integration_id` varchar(120) NOT NULL,
	`external_id` varchar(120) NOT NULL,
	`external_parent_id` varchar(120),
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
	CONSTRAINT `github_organizations_integration_external_uq` UNIQUE INDEX(`integration_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `github_repositories` (
	`id` varchar(120) PRIMARY KEY,
	`organization_id` varchar(120) NOT NULL,
	`integration_id` varchar(120) NOT NULL,
	`external_id` varchar(120) NOT NULL,
	`external_parent_id` varchar(120),
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
	`github_organization_id` varchar(120),
	CONSTRAINT `github_repositories_integration_external_uq` UNIQUE INDEX(`integration_id`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD `github_organization_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD `github_repository_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `github_organization_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `github_repository_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD `github_organization_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD `github_repository_id` varchar(120);--> statement-breakpoint
-- Preserve the legacy stable IDs and every lifecycle/status field while the
-- dedicated GitHub tables are introduced. Legacy rows are deliberately kept;
-- the local CLI verifies and removes them only after all references are safe.
INSERT INTO `github_organizations` (`id`, `organization_id`, `integration_id`, `external_id`, `external_parent_id`, `display_name`, `external_url`, `metadata_json`, `discovery_state`, `discovered_at`, `last_seen_at`, `sync_status`, `current_sync_run_id`, `last_sync_started_at`, `last_sync_succeeded_at`, `last_sync_failed_at`, `last_sync_error`, `next_attempt_at`, `consecutive_failure_count`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, `integration_id`, `external_id`, `external_parent_id`, `display_name`, `external_url`, `metadata_json`, `discovery_state`, `discovered_at`, `last_seen_at`, `sync_status`, `current_sync_run_id`, `last_sync_started_at`, `last_sync_succeeded_at`, `last_sync_failed_at`, `last_sync_error`, `next_attempt_at`, `consecutive_failure_count`, `created_at`, `updated_at`
FROM `provider_resources`
WHERE `provider` = 'github' AND `resource_type` = 'github.organization'
ON DUPLICATE KEY UPDATE `organization_id` = VALUES(`organization_id`), `integration_id` = VALUES(`integration_id`), `external_id` = VALUES(`external_id`), `external_parent_id` = VALUES(`external_parent_id`), `display_name` = VALUES(`display_name`), `external_url` = VALUES(`external_url`), `metadata_json` = VALUES(`metadata_json`), `discovery_state` = VALUES(`discovery_state`), `discovered_at` = VALUES(`discovered_at`), `last_seen_at` = VALUES(`last_seen_at`), `sync_status` = VALUES(`sync_status`), `current_sync_run_id` = VALUES(`current_sync_run_id`), `last_sync_started_at` = VALUES(`last_sync_started_at`), `last_sync_succeeded_at` = VALUES(`last_sync_succeeded_at`), `last_sync_failed_at` = VALUES(`last_sync_failed_at`), `last_sync_error` = VALUES(`last_sync_error`), `next_attempt_at` = VALUES(`next_attempt_at`), `consecutive_failure_count` = VALUES(`consecutive_failure_count`), `updated_at` = VALUES(`updated_at`);--> statement-breakpoint
INSERT INTO `github_repositories` (`id`, `organization_id`, `integration_id`, `external_id`, `external_parent_id`, `display_name`, `external_url`, `metadata_json`, `discovery_state`, `discovered_at`, `last_seen_at`, `sync_status`, `current_sync_run_id`, `last_sync_started_at`, `last_sync_succeeded_at`, `last_sync_failed_at`, `last_sync_error`, `next_attempt_at`, `consecutive_failure_count`, `created_at`, `updated_at`, `github_organization_id`)
SELECT repository.`id`, repository.`organization_id`, repository.`integration_id`, repository.`external_id`, repository.`external_parent_id`, repository.`display_name`, repository.`external_url`, repository.`metadata_json`, repository.`discovery_state`, repository.`discovered_at`, repository.`last_seen_at`, repository.`sync_status`, repository.`current_sync_run_id`, repository.`last_sync_started_at`, repository.`last_sync_succeeded_at`, repository.`last_sync_failed_at`, repository.`last_sync_error`, repository.`next_attempt_at`, repository.`consecutive_failure_count`, repository.`created_at`, repository.`updated_at`, organization.`id`
FROM `provider_resources` AS repository
LEFT JOIN `provider_resources` AS organization ON organization.`id` = repository.`parent_resource_id` AND organization.`provider` = 'github' AND organization.`resource_type` = 'github.organization'
WHERE repository.`provider` = 'github' AND repository.`resource_type` = 'github.repository'
ON DUPLICATE KEY UPDATE `organization_id` = VALUES(`organization_id`), `integration_id` = VALUES(`integration_id`), `external_id` = VALUES(`external_id`), `external_parent_id` = VALUES(`external_parent_id`), `display_name` = VALUES(`display_name`), `external_url` = VALUES(`external_url`), `metadata_json` = VALUES(`metadata_json`), `discovery_state` = VALUES(`discovery_state`), `discovered_at` = VALUES(`discovered_at`), `last_seen_at` = VALUES(`last_seen_at`), `sync_status` = VALUES(`sync_status`), `current_sync_run_id` = VALUES(`current_sync_run_id`), `last_sync_started_at` = VALUES(`last_sync_started_at`), `last_sync_succeeded_at` = VALUES(`last_sync_succeeded_at`), `last_sync_failed_at` = VALUES(`last_sync_failed_at`), `last_sync_error` = VALUES(`last_sync_error`), `next_attempt_at` = VALUES(`next_attempt_at`), `consecutive_failure_count` = VALUES(`consecutive_failure_count`), `updated_at` = VALUES(`updated_at`), `github_organization_id` = VALUES(`github_organization_id`);--> statement-breakpoint
UPDATE `sync_scopes` AS target JOIN `provider_resources` AS legacy ON legacy.`id` = target.`provider_resource_id`
SET target.`github_organization_id` = CASE WHEN legacy.`resource_type` = 'github.organization' THEN legacy.`id` ELSE target.`github_organization_id` END, target.`github_repository_id` = CASE WHEN legacy.`resource_type` = 'github.repository' THEN legacy.`id` ELSE target.`github_repository_id` END, target.`provider_resource_id` = NULL
WHERE legacy.`provider` = 'github';--> statement-breakpoint
UPDATE `sync_cursors` AS target JOIN `provider_resources` AS legacy ON legacy.`id` = target.`provider_resource_id`
SET target.`github_organization_id` = CASE WHEN legacy.`resource_type` = 'github.organization' THEN legacy.`id` ELSE target.`github_organization_id` END, target.`github_repository_id` = CASE WHEN legacy.`resource_type` = 'github.repository' THEN legacy.`id` ELSE target.`github_repository_id` END, target.`provider_resource_id` = NULL
WHERE legacy.`provider` = 'github';--> statement-breakpoint
UPDATE `sync_runs` AS target JOIN `provider_resources` AS legacy ON legacy.`id` = target.`provider_resource_id`
SET target.`github_organization_id` = CASE WHEN legacy.`resource_type` = 'github.organization' THEN legacy.`id` ELSE target.`github_organization_id` END, target.`github_repository_id` = CASE WHEN legacy.`resource_type` = 'github.repository' THEN legacy.`id` ELSE target.`github_repository_id` END, target.`provider_resource_id` = NULL
WHERE legacy.`provider` = 'github';--> statement-breakpoint
CREATE INDEX `github_organizations_status_idx` ON `github_organizations` (`organization_id`,`integration_id`,`sync_status`);--> statement-breakpoint
CREATE INDEX `github_repositories_organization_idx` ON `github_repositories` (`integration_id`,`github_organization_id`,`discovery_state`);--> statement-breakpoint
CREATE INDEX `github_repositories_status_idx` ON `github_repositories` (`organization_id`,`integration_id`,`sync_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_cursors_github_repository_object_kind_uq` ON `sync_cursors` (`github_repository_id`,`object_type`,`cursor_kind`);--> statement-breakpoint
CREATE INDEX `sync_runs_github_organization_status_idx` ON `sync_runs` (`github_organization_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_github_repository_status_idx` ON `sync_runs` (`github_repository_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `sync_scopes_github_organization_idx` ON `sync_scopes` (`github_organization_id`);--> statement-breakpoint
CREATE INDEX `sync_scopes_github_repository_idx` ON `sync_scopes` (`github_repository_id`);--> statement-breakpoint
ALTER TABLE `github_organizations` ADD CONSTRAINT `github_organizations_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `github_organizations` ADD CONSTRAINT `github_organizations_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `github_repositories` ADD CONSTRAINT `github_repositories_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `github_repositories` ADD CONSTRAINT `github_repositories_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `github_repositories` ADD CONSTRAINT `github_repositories_xOtgijQxtfL9_fkey` FOREIGN KEY (`github_organization_id`) REFERENCES `github_organizations`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD CONSTRAINT `sync_cursors_hiCh6hIXqquq_fkey` FOREIGN KEY (`github_organization_id`) REFERENCES `github_organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD CONSTRAINT `sync_cursors_github_repository_id_github_repositories_id_fkey` FOREIGN KEY (`github_repository_id`) REFERENCES `github_repositories`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_github_organization_id_github_organizations_id_fkey` FOREIGN KEY (`github_organization_id`) REFERENCES `github_organizations`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_github_repository_id_github_repositories_id_fkey` FOREIGN KEY (`github_repository_id`) REFERENCES `github_repositories`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_github_organization_id_github_organizations_id_fkey` FOREIGN KEY (`github_organization_id`) REFERENCES `github_organizations`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_github_repository_id_github_repositories_id_fkey` FOREIGN KEY (`github_repository_id`) REFERENCES `github_repositories`(`id`) ON DELETE SET NULL;
