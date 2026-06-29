import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ContentHash = `sha256:${string}`;

export function canonicalizeJson(value: JsonValue): string {
  return serializeCanonicalJson(value);
}

export function hashCanonicalJson(value: JsonValue): ContentHash {
  const canonical = canonicalizeJson(value);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}`;
}

function serializeCanonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot encode non-finite numbers");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${serializeCanonicalJson(nestedValue)}`)
      .join(",")}}`;
  }

  throw new TypeError(`Unsupported JSON value: ${String(value)}`);
}
