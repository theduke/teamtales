import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalizeJson, hashCanonicalJson } from "../../src/ingestion/json.js";

describe("canonicalizeJson", () => {
  it("sorts object keys recursively", () => {
    assert.equal(
      canonicalizeJson({ z: true, a: { c: 3, b: [2, { d: "x", a: null }] } }),
      '{"a":{"b":[2,{"a":null,"d":"x"}],"c":3},"z":true}',
    );
  });

  it("produces the same hash for semantically equal JSON objects", () => {
    const left = hashCanonicalJson({ b: 2, a: { y: false, x: "value" } });
    const right = hashCanonicalJson({ a: { x: "value", y: false }, b: 2 });

    assert.equal(left, right);
    assert.match(left, /^sha256:[a-f0-9]{64}$/);
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non-finite/);
  });
});
