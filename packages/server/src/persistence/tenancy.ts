import { and, eq, sql } from "drizzle-orm";

import { integrations, organizationMemberships, organizations, users } from "../db/schema.js";
import { type PersistenceDatabase, withTransaction } from "./database.js";
import type { MySqlTransaction } from "../db/mysql.js";

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
  organization: { id: string; name: string; slug: string };
  owner: { id: string; displayName: string; primaryEmail?: string | null };
  membershipId: string;
}

export interface CreatedOrganizationResult {
  organization: OrganizationRecord;
  owner: UserRecord;
  membership: OrganizationMembershipRecord;
}

export async function createOrganizationWithOwner(
  database: PersistenceDatabase,
  input: CreateOrganizationInput,
): Promise<CreatedOrganizationResult> {
  return withTransaction(database, (transaction) =>
    createOrganizationWithOwnerInTransaction(transaction, input),
  );
}

export async function createOrganizationWithOwnerInTransaction(
  transaction: MySqlTransaction,
  input: CreateOrganizationInput,
): Promise<CreatedOrganizationResult> {
  const now = new Date().toISOString();
  await transaction
    .insert(organizations)
    .values({ ...input.organization, createdAt: now, updatedAt: now });
  await transaction
    .insert(users)
    .values({
      id: input.owner.id,
      displayName: input.owner.displayName,
      primaryEmail: input.owner.primaryEmail ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        displayName: input.owner.displayName,
        primaryEmail: sql`coalesce(${users.primaryEmail}, values(primary_email))`,
        updatedAt: now,
      },
    });
  await transaction.insert(organizationMemberships).values({
    id: input.membershipId,
    organizationId: input.organization.id,
    userId: input.owner.id,
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return {
    organization: await requireOrganization(transaction, input.organization.id),
    owner: await requireUser(transaction, input.owner.id),
    membership: await requireOrganizationMembership(
      transaction,
      input.organization.id,
      input.owner.id,
    ),
  };
}

export async function getOrganization(
  database: PersistenceDatabase,
  organizationId: string,
): Promise<OrganizationRecord | undefined> {
  const [row] = await database
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ? mapOrganization(row) : undefined;
}

export async function requireOrganization(
  database: PersistenceDatabase,
  organizationId: string,
): Promise<OrganizationRecord> {
  const organization = await getOrganization(database, organizationId);
  if (!organization) throw new Error(`Organization not found: ${organizationId}`);
  return organization;
}

export async function getUser(
  database: PersistenceDatabase,
  userId: string,
): Promise<UserRecord | undefined> {
  const [row] = await database.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ? mapUser(row) : undefined;
}

export async function requireUser(
  database: PersistenceDatabase,
  userId: string,
): Promise<UserRecord> {
  const user = await getUser(database, userId);
  if (!user) throw new Error(`User not found: ${userId}`);
  return user;
}

export async function getOrganizationMembership(
  database: PersistenceDatabase,
  organizationId: string,
  userId: string,
): Promise<OrganizationMembershipRecord | undefined> {
  const [row] = await database
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  return row ? mapMembership(row) : undefined;
}

export async function requireOrganizationMembership(
  database: PersistenceDatabase,
  organizationId: string,
  userId: string,
): Promise<OrganizationMembershipRecord> {
  const membership = await getOrganizationMembership(database, organizationId, userId);
  if (!membership || membership.status !== "active") {
    throw new Error(`Active organization membership not found: ${organizationId}/${userId}`);
  }
  return membership;
}

export async function requireOrganizationRole(
  database: PersistenceDatabase,
  organizationId: string,
  userId: string,
  allowedRoles: readonly OrganizationRole[],
): Promise<OrganizationMembershipRecord> {
  const membership = await requireOrganizationMembership(database, organizationId, userId);
  if (!allowedRoles.includes(membership.role)) {
    throw new Error(`User ${userId} is not authorized for organization ${organizationId}.`);
  }
  return membership;
}

export async function requireIntegrationInOrganization(
  database: PersistenceDatabase,
  organizationId: string,
  integrationId: string,
): Promise<void> {
  const [row] = await database
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, organizationId)))
    .limit(1);
  if (!row)
    throw new Error(`Integration not found in organization ${organizationId}: ${integrationId}`);
}

function mapOrganization(row: typeof organizations.$inferSelect): OrganizationRecord {
  return row;
}

function mapUser(row: typeof users.$inferSelect): UserRecord {
  return row;
}

function mapMembership(
  row: typeof organizationMemberships.$inferSelect,
): OrganizationMembershipRecord {
  return {
    ...row,
    role: row.role as OrganizationRole,
    status: row.status as "active" | "inactive",
  };
}
