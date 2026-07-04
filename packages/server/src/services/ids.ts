import { createHash } from "node:crypto";

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "organization";
}
