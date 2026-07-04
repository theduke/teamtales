import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiResponseDto, JsonObject, JsonValue } from "@teamtales/common/api";

const maxJsonBytes = 1_048_576;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: JsonObject;

  constructor(status: number, code: string, message: string, details?: JsonObject) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxJsonBytes) {
      throw new HttpError(413, "request_too_large", "JSON request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function writeJson<T extends JsonValue>(response: ServerResponse, status: number, body: ApiResponseDto<T>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function writeData<T extends JsonValue>(response: ServerResponse, status: number, data: T): void {
  writeJson(response, status, { ok: true, data });
}

export function writeError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const details = error instanceof HttpError ? error.details : undefined;

  writeJson(response, status, {
    ok: false,
    error: {
      code,
      message: status >= 500 && code === "internal_error" ? "Unexpected server error." : message,
      ...(details === undefined ? {} : { details }),
    },
  });
}

export function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_request", `Missing required string field: ${key}.`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `Field must be a boolean: ${key}.`);
  }
  return value;
}

export function optionalJsonObject(record: Record<string, unknown>, key: string): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", `Field must be a JSON object: ${key}.`);
  }
  return value as JsonObject;
}
