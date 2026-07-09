import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const organizations = sqliteTable("organizations", {
  id: text().primaryKey(), name: text().notNull(), slug: text().notNull().unique(), ...timestamps,
});
export const users = sqliteTable("users", {
  id: text().primaryKey(), displayName: text("display_name").notNull(), primaryEmail: text("primary_email").unique(),
  passwordHash: text("password_hash"), passwordSalt: text("password_salt"),
  passwordScryptN: integer("password_scrypt_n"), passwordScryptR: integer("password_scrypt_r"),
  passwordScryptP: integer("password_scrypt_p"), ...timestamps,
});
export const authSessions = sqliteTable("auth_sessions", {
  id: text().primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"), lastUsedAt: text("last_used_at"), ...timestamps,
}, (table) => [index("auth_sessions_user_id_idx").on(table.userId), index("auth_sessions_expires_at_idx").on(table.expiresAt)]);
export const apiTokens = sqliteTable("api_tokens", {
  id: text().primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text().notNull(), tokenPrefix: text("token_prefix").notNull(), tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(), revokedAt: text("revoked_at"), lastUsedAt: text("last_used_at"), ...timestamps,
}, (table) => [uniqueIndex("api_tokens_user_prefix").on(table.userId, table.tokenPrefix), index("api_tokens_user_id_idx").on(table.userId), index("api_tokens_expires_at_idx").on(table.expiresAt)]);
export const organizationMemberships = sqliteTable("organization_memberships", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), role: text().notNull(), status: text().notNull(), ...timestamps,
}, (table) => [uniqueIndex("organization_memberships_organization_user").on(table.organizationId, table.userId)]);
export const integrations = sqliteTable("integrations", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), provider: text().notNull(), authType: text("auth_type").notNull(), status: text().notNull(), displayName: text("display_name").notNull(), ...timestamps,
}, (table) => [index("idx_integrations_organization_provider").on(table.organizationId, table.provider)]);
export const integrationCredentials = sqliteTable("integration_credentials", {
  id: text().primaryKey(), integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }), encryptedSecret: text("encrypted_secret").notNull(), secretHint: text("secret_hint"), expiresAt: text("expires_at"), ...timestamps,
});
export const syncScopes = sqliteTable("sync_scopes", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }), provider: text().notNull(), scopeType: text("scope_type").notNull(), externalId: text("external_id"), externalName: text("external_name").notNull(), configJson: text("config_json").notNull().default("{}"), enabled: integer().notNull().default(1), lastSuccessAt: text("last_success_at"), lastAttemptAt: text("last_attempt_at"), ...timestamps,
});
export const syncCursors = sqliteTable("sync_cursors", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull(), integrationId: text("integration_id").notNull(), syncScopeId: text("sync_scope_id").notNull().references(() => syncScopes.id, { onDelete: "cascade" }), provider: text().notNull(), objectType: text("object_type").notNull(), cursorKind: text("cursor_kind").notNull(), cursorValue: text("cursor_value"), highWatermark: text("high_watermark"), lastSuccessAt: text("last_success_at"), lastAttemptAt: text("last_attempt_at"), ...timestamps,
});
export const syncRuns = sqliteTable("sync_runs", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull(), integrationId: text("integration_id").notNull(), syncScopeId: text("sync_scope_id"), provider: text().notNull(), runType: text("run_type").notNull(), status: text().notNull(), startedAt: text("started_at").notNull(), finishedAt: text("finished_at"), objectsFetched: integer("objects_fetched").notNull().default(0), objectsInserted: integer("objects_inserted").notNull().default(0), objectsUpdated: integer("objects_updated").notNull().default(0), objectsUnchanged: integer("objects_unchanged").notNull().default(0), objectsFailed: integer("objects_failed").notNull().default(0), activityEventsEmitted: integer("activity_events_emitted").notNull().default(0), error: text(), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
export const sourceObjects = sqliteTable("source_objects", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull(), integrationId: text("integration_id").notNull(), syncScopeId: text("sync_scope_id"), provider: text().notNull(), objectType: text("object_type").notNull(), externalId: text("external_id").notNull(), externalUrl: text("external_url"), externalCreatedAt: text("external_created_at"), externalUpdatedAt: text("external_updated_at"), externalDeletedAt: text("external_deleted_at"), rawJson: text("raw_json").notNull(), contentHash: text("content_hash").notNull(), firstSeenAt: text("first_seen_at").notNull(), lastSeenAt: text("last_seen_at").notNull(), lastChangedAt: text("last_changed_at").notNull(), sourceState: text("source_state").notNull(), ...timestamps,
});
export const people = sqliteTable("people", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), displayName: text("display_name").notNull(), primaryEmail: text("primary_email"), ...timestamps });
export const workItems = sqliteTable("work_items", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), sourceObjectId: text("source_object_id"), provider: text().notNull(), sourceType: text("source_type").notNull(), externalId: text("external_id").notNull(), title: text().notNull(), description: text(), url: text(), status: text().notNull(), workType: text("work_type").notNull(), createdAtSource: text("created_at_source"), updatedAtSource: text("updated_at_source"), startedAt: text("started_at"), completedAt: text("completed_at"), ...timestamps });
export const activityEvents = sqliteTable("activity_events", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), sourceObjectId: text("source_object_id"), provider: text().notNull(), eventType: text("event_type").notNull(), actorPersonId: text("actor_person_id"), workItemId: text("work_item_id"), repositoryId: text("repository_id"), linearTeamId: text("linear_team_id"), linearProjectId: text("linear_project_id"), occurredAt: text("occurred_at").notNull(), title: text().notNull(), body: text(), url: text(), metadataJson: text("metadata_json").notNull().default("{}"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
export const analysisRuns = sqliteTable("analysis_runs", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), scopeType: text("scope_type").notNull(), scopeId: text("scope_id").notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(), status: text().notNull(), startedAt: text("started_at").notNull(), finishedAt: text("finished_at"), error: text(), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
export const analysisMetrics = sqliteTable("analysis_metrics", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), analysisRunId: text("analysis_run_id").notNull(), scopeType: text("scope_type").notNull(), scopeId: text("scope_id").notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(), metricName: text("metric_name").notNull(), metricValue: real("metric_value").notNull(), dimensionsJson: text("dimensions_json").notNull().default("{}"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
export const analysisHighlights = sqliteTable("analysis_highlights", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), analysisRunId: text("analysis_run_id").notNull(), workItemId: text("work_item_id"), highlightType: text("highlight_type").notNull(), score: real().notNull(), title: text().notNull(), reason: text().notNull(), sourceRefsJson: text("source_refs_json").notNull(), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
export const analysisReportContexts = sqliteTable("analysis_report_contexts", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), analysisRunId: text("analysis_run_id").notNull(), scopeType: text("scope_type").notNull(), scopeId: text("scope_id").notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(), contextJson: text("context_json").notNull(), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`) });
export const reports = sqliteTable("reports", { id: text().primaryKey(), organizationId: text("organization_id").notNull(), analysisReportContextId: text("analysis_report_context_id").notNull(), reportType: text("report_type").notNull(), scopeType: text("scope_type").notNull(), scopeId: text("scope_id").notNull(), periodStart: text("period_start").notNull(), periodEnd: text("period_end").notNull(), status: text().notNull(), title: text().notNull(), summary: text(), bodyMarkdown: text("body_markdown").notNull(), structuredJson: text("structured_json").notNull(), createdByUserId: text("created_by_user_id"), ...timestamps });
export const reportInputs = sqliteTable("report_inputs", { id: text().primaryKey(), reportId: text("report_id").notNull(), inputType: text("input_type").notNull(), inputId: text("input_id").notNull(), metadataJson: text("metadata_json").notNull().default("{}"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`) });

export const schema = { organizations, users, authSessions, apiTokens, organizationMemberships, integrations, integrationCredentials, syncScopes, syncCursors, syncRuns, sourceObjects, people, workItems, activityEvents, analysisRuns, analysisMetrics, analysisHighlights, analysisReportContexts, reports, reportInputs };
