import { createHash } from "node:crypto";
import { z } from "zod";

export const Sha256HashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "Expected sha256:<64 lowercase hex chars>");
export type Sha256Hash = z.infer<typeof Sha256HashSchema>;

export function hashString(value: string): Sha256Hash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashValue(value: unknown): Sha256Hash {
  return hashString(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value)) ?? "undefined";
}

function normalizeStable(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeStable);
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = normalizeStable((value as Record<string, unknown>)[key]);
    if (child !== undefined) {
      normalized[key] = child;
    }
  }

  return normalized;
}
