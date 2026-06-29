import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planSourceObjectUpsert, sourceObjectConflictKey, type IncomingSourceObject, type PersistedSourceObject } from "../../src/ingestion/source-object.js";

const now = new Date("2026-06-29T10:00:00.000Z");

const incoming: IncomingSourceObject = {
  organizationId: "org_1",
  integrationId: "int_1",
  syncScopeId: "scope_1",
  provider: "github",
  objectType: "github.pull_request",
  externalId: "42",
  externalUrl: "https://github.com/acme/widgets/pull/42",
  rawJson: { id: 42, title: "Ship widgets", state: "open" },
  externalCreatedAt: new Date("2026-06-28T09:00:00.000Z"),
  externalUpdatedAt: new Date("2026-06-29T09:00:00.000Z"),
};

describe("source object upsert planning", () => {
  it("plans an insert for new objects", () => {
    const plan = planSourceObjectUpsert(incoming, undefined, now);

    assert.equal(plan.action, "insert");
    if (plan.action !== "insert") {
      throw new Error("expected insert plan");
    }
    assert.equal(plan.values.firstSeenAt, now);
    assert.equal(plan.values.lastSeenAt, now);
    assert.equal(plan.values.lastChangedAt, now);
    assert.equal(plan.values.sourceState, "active");
  });

  it("plans unchanged when content hash and source state match", () => {
    const insert = planSourceObjectUpsert(incoming, undefined, now);
    assert.equal(insert.action, "insert");
    if (insert.action !== "insert") {
      throw new Error("expected insert plan");
    }

    const existing: PersistedSourceObject = {
      ...insert.values,
      id: "source_1",
      createdAt: now,
      updatedAt: now,
    };

    const plan = planSourceObjectUpsert({ ...incoming, rawJson: { state: "open", title: "Ship widgets", id: 42 } }, existing, now);

    assert.equal(plan.action, "unchanged");
    if (plan.action !== "unchanged") {
      throw new Error("expected unchanged plan");
    }
    assert.equal(plan.existingId, "source_1");
    assert.equal(plan.values.lastSeenAt, now);
  });

  it("plans update when raw JSON changes", () => {
    const insert = planSourceObjectUpsert(incoming, undefined, now);
    assert.equal(insert.action, "insert");
    if (insert.action !== "insert") {
      throw new Error("expected insert plan");
    }

    const existing: PersistedSourceObject = {
      ...insert.values,
      id: "source_1",
      createdAt: now,
      updatedAt: now,
    };

    const changedAt = new Date("2026-06-29T11:00:00.000Z");
    const plan = planSourceObjectUpsert({ ...incoming, rawJson: { id: 42, title: "Ship widgets", state: "merged" } }, existing, changedAt);

    assert.equal(plan.action, "update");
    if (plan.action !== "update") {
      throw new Error("expected update plan");
    }
    assert.equal(plan.existingId, "source_1");
    assert.equal(plan.values.lastChangedAt, changedAt);
    assert.equal(plan.values.sourceState, "active");
  });

  it("builds a stable conflict key", () => {
    assert.equal(sourceObjectConflictKey(incoming), "org_1:int_1:scope_1:github:github.pull_request:42");
  });
});
