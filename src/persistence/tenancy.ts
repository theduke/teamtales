import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "./sqlite.js";

export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserRecord {
  id: string;
  displayName: string;
  primaryEmail?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationMembershipRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: "active" | "inactive";
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateOrganizationInput {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  owner: {
    id: string;
    displayName: string;
    primaryEmail?: string | null;
  };
  membershipId: string;
}

export interface CreatedOrganizationResult {
  organization: OrganizationRecord;
  owner: UserRecord;
  membership: OrganizationMembershipRecord;
}

export function createOrganizationWithOwner(
  database: DatabaseSync,
  input: CreateOrganizationInput,
): CreatedOrganizationResult {
  return withTransaction(database, () => {
    database
      .prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .run(input.organization.id, input.organization.name, input.organization.slug);

    database
      .prepare(
        `INSERT INTO users (id, display_name, primary_email, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           primary_email = COALESCE(users.primary_email, excluded.primary_email),
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(input.owner.id, input.owner.displayName, input.owner.primaryEmail ?? null);

    database
      .prepare(
        `INSERT INTO organization_memberships (
          id, organization_id, user_id, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .run(input.membershipId, input.organization.id, input.owner.id, "owner", "active");

    return {
      organization: requireOrganization(database, input.organization.id),
      owner: requireUser(database, input.owner.id),
      membership: requireOrganizationMembership(database, input.organization.id, input.owner.id),
    };
  });
}

export function getOrganization(database: DatabaseSync, organizationId: string): OrganizationRecord | undefined {
  const row = database.prepare("SELECT * FROM organizations WHERE id = ?").get(organizationId);
  return row ? mapOrganization(row as Record<string, unknown>) : undefined;
}

export function requireOrganization(database: DatabaseSync, organizationId: string): OrganizationRecord {
  const organization = getOrganization(database, organizationId);
  if (!organization) {
    throw new Error(`Organization not found: ${organizationId}`);
  }
  return organization;
}

export function getUser(database: DatabaseSync, userId: string): UserRecord | undefined {
  const row = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  return row ? mapUser(row as Record<string, unknown>) : undefined;
}

export function requireUser(database: DatabaseSync, userId: string): UserRecord {
  const user = getUser(database, userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  return user;
}

export function getOrganizationMembership(
  database: DatabaseSync,
  organizationId: string,
  userId: string,
): OrganizationMembershipRecord | undefined {
  const row = database
    .prepare("SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ?")
    .get(organizationId, userId);
  return row ? mapMembership(row as Record<string, unknown>) : undefined;
}

export function requireOrganizationMembership(
  database: DatabaseSync,
  organizationId: string,
  userId: string,
): OrganizationMembershipRecord {
  const membership = getOrganizationMembership(database, organizationId, userId);
  if (!membership || membership.status !== "active") {
    throw new Error(`Active organization membership not found: ${organizationId}/${userId}`);
  }
  return membership;
}

export function requireOrganizationRole(
  database: DatabaseSync,
  organizationId: string,
  userId: string,
  allowedRoles: readonly OrganizationRole[],
): OrganizationMembershipRecord {
  const membership = requireOrganizationMembership(database, organizationId, userId);
  if (!allowedRoles.includes(membership.role)) {
    throw new Error(`User ${userId} is not authorized for organization ${organizationId}.`);
  }
  return membership;
}

export function requireIntegrationInOrganization(
  database: DatabaseSync,
  organizationId: string,
  integrationId: string,
): void {
  const row = database
    .prepare("SELECT id FROM integrations WHERE id = ? AND organization_id = ?")
    .get(integrationId, organizationId);
  if (!row) {
    throw new Error(`Integration not found in organization ${organizationId}: ${integrationId}`);
  }
}

function mapOrganization(row: Record<string, unknown>): OrganizationRecord {
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    slug: requiredString(row, "slug"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: requiredString(row, "id"),
    displayName: requiredString(row, "display_name"),
    primaryEmail: optionalString(row, "primary_email"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapMembership(row: Record<string, unknown>): OrganizationMembershipRecord {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    userId: requiredString(row, "user_id"),
    role: requiredString(row, "role") as OrganizationRole,
    status: requiredString(row, "status") as "active" | "inactive",
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column: ${key}`);
  }
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected nullable string column: ${key}`);
  }
  return value;
}
