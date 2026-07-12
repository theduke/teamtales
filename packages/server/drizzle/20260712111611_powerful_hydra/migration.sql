ALTER TABLE `sync_scopes` ADD `parent_scope_id` varchar(120);--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD `selection_mode` varchar(120) DEFAULT 'individual' NOT NULL;--> statement-breakpoint
-- Legacy rows were flat selections. Repository and team rows remain individual;
-- workspace/organization containers retain their historic broad-scope behavior.
UPDATE `sync_scopes` SET `selection_mode` = CASE
	WHEN `scope_type` IN ('github.organization', 'linear.workspace') THEN 'all'
	ELSE 'individual'
END;--> statement-breakpoint
CREATE UNIQUE INDEX `sync_scopes_integration_type_external_uq` ON `sync_scopes` (`integration_id`,`scope_type`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_scopes_hierarchy` ON `sync_scopes` (`integration_id`,`parent_scope_id`,`enabled`);--> statement-breakpoint
ALTER TABLE `sync_scopes` ADD CONSTRAINT `sync_scopes_parent_scope_id_sync_scopes_id_fkey` FOREIGN KEY (`parent_scope_id`) REFERENCES `sync_scopes`(`id`) ON DELETE CASCADE;
