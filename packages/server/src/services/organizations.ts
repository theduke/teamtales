import type { DbExecutor, MySqlTransaction } from "../db/mysql.js";
import type { OrganizationDto } from "@teamtales/common/api";

import {
  createOrganizationWithOwner,
  createOrganizationWithOwnerInTransaction,
} from "../persistence/index.js";
import { stableId, slugify } from "./ids.js";

export interface CreateOrganizationServiceInput {
  id?: string;
  name: string;
  slug?: string;
  ownerId?: string;
  ownerName?: string;
  ownerEmail?: string;
  membershipId?: string;
}

export interface CreateOrganizationServiceResult {
  organization: OrganizationDto;
  ownerUserId: string;
  ownerMembershipId: string;
}

export async function createOrganizationService(
  database: DbExecutor,
  input: CreateOrganizationServiceInput,
): Promise<CreateOrganizationServiceResult> {
  return mapCreatedOrganization(
    await createOrganizationWithOwner(database, organizationCreateInput(input)),
  );
}

export async function createOrganizationServiceInTransaction(
  transaction: MySqlTransaction,
  input: CreateOrganizationServiceInput,
): Promise<CreateOrganizationServiceResult> {
  return mapCreatedOrganization(
    await createOrganizationWithOwnerInTransaction(transaction, organizationCreateInput(input)),
  );
}

function organizationCreateInput(input: CreateOrganizationServiceInput) {
  const id = input.id ?? stableId("org", input.name);
  const ownerName = input.ownerName ?? input.ownerEmail ?? "Local Owner";
  const ownerId = input.ownerId ?? stableId("user", input.ownerEmail ?? ownerName);
  const membershipId = input.membershipId ?? stableId("membership", id, ownerId);
  return {
    organization: {
      id,
      name: input.name,
      slug: input.slug ?? slugify(input.name),
    },
    owner: {
      id: ownerId,
      displayName: ownerName,
      primaryEmail: input.ownerEmail ?? null,
    },
    membershipId,
  };
}

function mapCreatedOrganization(
  created: Awaited<ReturnType<typeof createOrganizationWithOwner>>,
): CreateOrganizationServiceResult {
  return {
    organization: {
      id: created.organization.id,
      name: created.organization.name,
      slug: created.organization.slug,
    },
    ownerUserId: created.owner.id,
    ownerMembershipId: created.membership.id,
  };
}
