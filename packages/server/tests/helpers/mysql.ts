import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { openDatabase, type OpenDatabaseResult } from "../../src/db/index.js";
import { organizations, users } from "../../src/db/schema.js";

export const testDatabaseUrl = process.env.TEAMTALES_TEST_DATABASE_URL;
export const mysqlTestOptions = { skip: !testDatabaseUrl } as const;

export function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export async function openTestDatabase(): Promise<OpenDatabaseResult> {
  if (!testDatabaseUrl) throw new Error("TEAMTALES_TEST_DATABASE_URL is required");
  return openDatabase({ env: { DATABASE_URL: testDatabaseUrl }, runMigrations: true });
}

export async function cleanupOrganization(opened: OpenDatabaseResult, organizationId: string, userIds: string[] = []): Promise<void> {
  await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
  for (const userId of userIds) await opened.db.delete(users).where(eq(users.id, userId));
}
