CREATE TABLE `linear_teams` (
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
	`linear_workspace_id` varchar(120),
	CONSTRAINT `linear_teams_integration_external_uq` UNIQUE INDEX(`integration_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `linear_workspaces` (
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
	CONSTRAINT `linear_workspaces_integration_external_uq` UNIQUE INDEX(`integration_id`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD `linear_workspace_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD `linear_team_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `linear_workspace_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `linear_team_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD `linear_workspace_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD `linear_team_id` varchar(120);--> statement-breakpoint
CREATE INDEX `linear_teams_workspace_idx` ON `linear_teams` (`integration_id`,`linear_workspace_id`,`discovery_state`);--> statement-breakpoint
CREATE INDEX `linear_teams_status_idx` ON `linear_teams` (`organization_id`,`integration_id`,`sync_status`);--> statement-breakpoint
CREATE INDEX `linear_workspaces_status_idx` ON `linear_workspaces` (`organization_id`,`integration_id`,`sync_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_cursors_linear_team_object_kind_uq` ON `sync_cursors` (`linear_team_id`,`object_type`,`cursor_kind`);--> statement-breakpoint
CREATE INDEX `sync_runs_linear_workspace_status_idx` ON `sync_runs` (`linear_workspace_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_linear_team_status_idx` ON `sync_runs` (`linear_team_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `sync_scopes_linear_workspace_idx` ON `sync_scopes` (`linear_workspace_id`);--> statement-breakpoint
CREATE INDEX `sync_scopes_linear_team_idx` ON `sync_scopes` (`linear_team_id`);--> statement-breakpoint
ALTER TABLE `linear_teams` ADD CONSTRAINT `linear_teams_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `linear_teams` ADD CONSTRAINT `linear_teams_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `linear_teams` ADD CONSTRAINT `linear_teams_linear_workspace_id_linear_workspaces_id_fkey` FOREIGN KEY (`linear_workspace_id`) REFERENCES `linear_workspaces`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `linear_workspaces` ADD CONSTRAINT `linear_workspaces_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `linear_workspaces` ADD CONSTRAINT `linear_workspaces_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD CONSTRAINT `sync_cursors_linear_workspace_id_linear_workspaces_id_fkey` FOREIGN KEY (`linear_workspace_id`) REFERENCES `linear_workspaces`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD CONSTRAINT `sync_cursors_linear_team_id_linear_teams_id_fkey` FOREIGN KEY (`linear_team_id`) REFERENCES `linear_teams`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_linear_workspace_id_linear_workspaces_id_fkey` FOREIGN KEY (`linear_workspace_id`) REFERENCES `linear_workspaces`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_linear_team_id_linear_teams_id_fkey` FOREIGN KEY (`linear_team_id`) REFERENCES `linear_teams`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_linear_workspace_id_linear_workspaces_id_fkey` FOREIGN KEY (`linear_workspace_id`) REFERENCES `linear_workspaces`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_linear_team_id_linear_teams_id_fkey` FOREIGN KEY (`linear_team_id`) REFERENCES `linear_teams`(`id`) ON DELETE SET NULL;