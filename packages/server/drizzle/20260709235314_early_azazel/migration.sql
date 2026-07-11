CREATE TABLE `activity_events` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`source_object_id` varchar(191),
	`provider` varchar(512) NOT NULL,
	`event_type` varchar(512) NOT NULL,
	`actor_person_id` varchar(191),
	`work_item_id` varchar(191),
	`repository_id` varchar(512),
	`linear_team_id` varchar(512),
	`linear_project_id` varchar(512),
	`occurred_at` varchar(40) NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`url` text,
	`metadata_json` text NOT NULL,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_run_steps` (
	`id` varchar(191) PRIMARY KEY,
	`ai_run_id` varchar(191) NOT NULL,
	`step_name` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`input_json` text,
	`output_json` text,
	`error` text,
	`started_at` varchar(40) NOT NULL,
	`finished_at` varchar(40),
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`run_type` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`model` varchar(512),
	`input_ref_type` varchar(512) NOT NULL,
	`input_ref_id` varchar(191) NOT NULL,
	`prompt_version` varchar(512) NOT NULL,
	`started_at` varchar(40) NOT NULL,
	`finished_at` varchar(40),
	`error` text,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analysis_highlights` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`analysis_run_id` varchar(191) NOT NULL,
	`work_item_id` varchar(191),
	`highlight_type` varchar(512) NOT NULL,
	`score` double NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`source_refs_json` text NOT NULL,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analysis_metrics` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`analysis_run_id` varchar(191) NOT NULL,
	`scope_type` varchar(512) NOT NULL,
	`scope_id` varchar(512) NOT NULL,
	`period_start` varchar(40) NOT NULL,
	`period_end` varchar(40) NOT NULL,
	`metric_name` varchar(512) NOT NULL,
	`metric_value` double NOT NULL,
	`dimensions_json` text NOT NULL,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analysis_report_contexts` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`analysis_run_id` varchar(191) NOT NULL,
	`scope_type` varchar(512) NOT NULL,
	`scope_id` varchar(512) NOT NULL,
	`period_start` varchar(40) NOT NULL,
	`period_end` varchar(40) NOT NULL,
	`context_json` text NOT NULL,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analysis_runs` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`scope_type` varchar(512) NOT NULL,
	`scope_id` varchar(512) NOT NULL,
	`period_start` varchar(40) NOT NULL,
	`period_end` varchar(40) NOT NULL,
	`status` varchar(512) NOT NULL,
	`started_at` varchar(40) NOT NULL,
	`finished_at` varchar(40),
	`error` text,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` varchar(191) PRIMARY KEY,
	`user_id` varchar(191) NOT NULL,
	`name` varchar(512) NOT NULL,
	`token_prefix` varchar(512) NOT NULL,
	`token_hash` varchar(512) NOT NULL,
	`expires_at` varchar(40) NOT NULL,
	`revoked_at` varchar(40),
	`last_used_at` varchar(40),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `api_tokens_token_hash_uq` UNIQUE INDEX(`token_hash`),
	CONSTRAINT `api_tokens_user_prefix_uq` UNIQUE INDEX(`user_id`,`token_prefix`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` varchar(191) PRIMARY KEY,
	`user_id` varchar(191) NOT NULL,
	`token_hash` varchar(512) NOT NULL,
	`expires_at` varchar(40) NOT NULL,
	`revoked_at` varchar(40),
	`last_used_at` varchar(40),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `auth_sessions_token_hash_uq` UNIQUE INDEX(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`person_id` varchar(191),
	`provider` varchar(512) NOT NULL,
	`external_id` varchar(512) NOT NULL,
	`external_username` varchar(512),
	`external_email` varchar(512),
	`display_name` varchar(512),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `external_identities_natural_uq` UNIQUE INDEX(`organization_id`,`provider`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `integration_credentials` (
	`id` varchar(191) PRIMARY KEY,
	`integration_id` varchar(191) NOT NULL,
	`encrypted_secret` text NOT NULL,
	`secret_hint` varchar(512),
	`expires_at` varchar(40),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`provider` varchar(512) NOT NULL,
	`auth_type` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`display_name` varchar(512) NOT NULL,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `integrations_id_org_uq` UNIQUE INDEX(`id`,`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`role` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `organization_memberships_organization_user` UNIQUE INDEX(`organization_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` varchar(191) PRIMARY KEY,
	`name` varchar(512) NOT NULL,
	`slug` varchar(191) NOT NULL,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `organizations_slug_uq` UNIQUE INDEX(`slug`)
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`display_name` varchar(512) NOT NULL,
	`primary_email` varchar(512),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `people_id_org_uq` UNIQUE INDEX(`id`,`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `report_artifacts` (
	`id` varchar(191) PRIMARY KEY,
	`report_id` varchar(191) NOT NULL,
	`artifact_type` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`title` text NOT NULL,
	`body_markdown` text,
	`structured_json` text,
	`asset_url` text,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_inputs` (
	`id` varchar(191) PRIMARY KEY,
	`report_id` varchar(191) NOT NULL,
	`input_type` varchar(512) NOT NULL,
	`input_id` varchar(191) NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_links` (
	`id` varchar(191) PRIMARY KEY,
	`parent_report_id` varchar(191) NOT NULL,
	`child_report_id` varchar(191) NOT NULL,
	`link_type` varchar(512) NOT NULL,
	`created_at` varchar(40) NOT NULL,
	CONSTRAINT `report_links_reports_type_uq` UNIQUE INDEX(`parent_report_id`,`child_report_id`,`link_type`)
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`analysis_report_context_id` varchar(191) NOT NULL,
	`report_type` varchar(512) NOT NULL,
	`scope_type` varchar(512) NOT NULL,
	`scope_id` varchar(512) NOT NULL,
	`period_start` varchar(40) NOT NULL,
	`period_end` varchar(40) NOT NULL,
	`status` varchar(512) NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body_markdown` text NOT NULL,
	`structured_json` text NOT NULL,
	`created_by_user_id` varchar(191),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_object_versions` (
	`id` varchar(191) PRIMARY KEY,
	`source_object_id` varchar(191) NOT NULL,
	`content_hash` varchar(512) NOT NULL,
	`raw_json` text NOT NULL,
	`seen_at` varchar(40) NOT NULL,
	`change_reason` text
);
--> statement-breakpoint
CREATE TABLE `source_objects` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`integration_id` varchar(191) NOT NULL,
	`sync_scope_id` varchar(191),
	`provider` varchar(512) NOT NULL,
	`object_type` varchar(512) NOT NULL,
	`external_id` varchar(512) NOT NULL,
	`external_url` text,
	`external_created_at` varchar(40),
	`external_updated_at` varchar(40),
	`external_deleted_at` varchar(40),
	`raw_json` text NOT NULL,
	`content_hash` varchar(512) NOT NULL,
	`first_seen_at` varchar(40) NOT NULL,
	`last_seen_at` varchar(40) NOT NULL,
	`last_changed_at` varchar(40) NOT NULL,
	`source_state` varchar(512) NOT NULL,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `source_objects_natural_uq` UNIQUE INDEX(`organization_id`,`integration_id`,`sync_scope_id`,`provider`,`object_type`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `source_webhook_events` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`integration_id` varchar(191) NOT NULL,
	`provider` varchar(512) NOT NULL,
	`event_type` varchar(512) NOT NULL,
	`external_delivery_id` varchar(512),
	`signature_valid` int NOT NULL,
	`raw_headers_json` text NOT NULL,
	`raw_body_json` text NOT NULL,
	`received_at` varchar(40) NOT NULL,
	`processed_at` varchar(40),
	`status` varchar(512) NOT NULL,
	`error` text,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`integration_id` varchar(191) NOT NULL,
	`sync_scope_id` varchar(191) NOT NULL,
	`provider` varchar(512) NOT NULL,
	`object_type` varchar(512) NOT NULL,
	`cursor_kind` varchar(512) NOT NULL,
	`cursor_value` text,
	`high_watermark` varchar(40),
	`last_success_at` varchar(40),
	`last_attempt_at` varchar(40),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `sync_cursors_scope_object_kind_uq` UNIQUE INDEX(`sync_scope_id`,`object_type`,`cursor_kind`)
);
--> statement-breakpoint
CREATE TABLE `sync_run_items` (
	`id` varchar(191) PRIMARY KEY,
	`sync_run_id` varchar(191) NOT NULL,
	`object_type` varchar(512) NOT NULL,
	`external_id` varchar(512),
	`action` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`error` text,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`integration_id` varchar(191) NOT NULL,
	`sync_scope_id` varchar(191),
	`provider` varchar(512) NOT NULL,
	`run_type` varchar(512) NOT NULL,
	`status` varchar(512) NOT NULL,
	`started_at` varchar(40) NOT NULL,
	`finished_at` varchar(40),
	`objects_fetched` int NOT NULL DEFAULT 0,
	`objects_inserted` int NOT NULL DEFAULT 0,
	`objects_updated` int NOT NULL DEFAULT 0,
	`objects_unchanged` int NOT NULL DEFAULT 0,
	`objects_failed` int NOT NULL DEFAULT 0,
	`activity_events_emitted` int NOT NULL DEFAULT 0,
	`error` text,
	`created_at` varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_scopes` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`integration_id` varchar(191) NOT NULL,
	`provider` varchar(512) NOT NULL,
	`scope_type` varchar(512) NOT NULL,
	`external_id` varchar(512),
	`external_name` varchar(512) NOT NULL,
	`config_json` text NOT NULL,
	`enabled` int NOT NULL DEFAULT 1,
	`last_success_at` varchar(40),
	`last_attempt_at` varchar(40),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `sync_scopes_id_org_uq` UNIQUE INDEX(`id`,`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(191) PRIMARY KEY,
	`display_name` varchar(512) NOT NULL,
	`primary_email` varchar(512),
	`password_hash` text,
	`password_salt` text,
	`password_scrypt_n` int,
	`password_scrypt_r` int,
	`password_scrypt_p` int,
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `users_primary_email_uq` UNIQUE INDEX(`primary_email`)
);
--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` varchar(191) PRIMARY KEY,
	`organization_id` varchar(191) NOT NULL,
	`source_object_id` varchar(191),
	`provider` varchar(512) NOT NULL,
	`source_type` varchar(512) NOT NULL,
	`external_id` varchar(512) NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`url` text,
	`status` varchar(512) NOT NULL,
	`work_type` varchar(512) NOT NULL,
	`created_at_source` varchar(40),
	`updated_at_source` varchar(40),
	`started_at` varchar(40),
	`completed_at` varchar(40),
	`created_at` varchar(40) NOT NULL,
	`updated_at` varchar(40) NOT NULL,
	CONSTRAINT `work_items_natural_uq` UNIQUE INDEX(`organization_id`,`provider`,`source_type`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_id_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_integrations_organization_provider` ON `integrations` (`organization_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_sync_scopes_integration` ON `sync_scopes` (`integration_id`,`provider`,`enabled`);--> statement-breakpoint
ALTER TABLE `ai_run_steps` ADD CONSTRAINT `ai_run_steps_ai_run_id_ai_runs_id_fkey` FOREIGN KEY (`ai_run_id`) REFERENCES `ai_runs`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `integration_credentials` ADD CONSTRAINT `integration_credentials_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `organization_memberships` ADD CONSTRAINT `organization_memberships_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `organization_memberships` ADD CONSTRAINT `organization_memberships_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `report_artifacts` ADD CONSTRAINT `report_artifacts_report_id_reports_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `report_links` ADD CONSTRAINT `report_links_parent_report_id_reports_id_fkey` FOREIGN KEY (`parent_report_id`) REFERENCES `reports`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `report_links` ADD CONSTRAINT `report_links_child_report_id_reports_id_fkey` FOREIGN KEY (`child_report_id`) REFERENCES `reports`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `source_object_versions` ADD CONSTRAINT `source_object_versions_source_object_id_source_objects_id_fkey` FOREIGN KEY (`source_object_id`) REFERENCES `source_objects`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD CONSTRAINT `sync_cursors_sync_scope_id_sync_scopes_id_fkey` FOREIGN KEY (`sync_scope_id`) REFERENCES `sync_scopes`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_run_items` ADD CONSTRAINT `sync_run_items_sync_run_id_sync_runs_id_fkey` FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_organization_id_organizations_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_integration_id_integrations_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE;