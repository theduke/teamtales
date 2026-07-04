import type { DatabaseSync } from "node:sqlite";
import type { OrganizationDto } from "@teamtales/common/api";

import { createOrganizationWithOwner } from "../persistence/index.js";
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

export function createOrganizationService(
  database: DatabaseSync,
  input: CreateOrganizationServiceInput,
): CreateOrganizationServiceResult {
  const id = input.id ?? stableId("org", input.name);
  const ownerName = input.ownerName ?? input.ownerEmail ?? "Local Owner";
  const ownerId = input.ownerId ?? stableId("user", input.ownerEmail ?? ownerName);
  const membershipId = input.membershipId ?? stableId("membership", id, ownerId);

  const created = createOrganizationWithOwner(database, {
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
  });

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
