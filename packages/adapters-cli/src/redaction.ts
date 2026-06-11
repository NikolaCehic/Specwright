export type RedactionProfile = "shared-log" | "operator";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SECRET_PATTERN =
  /\b(secret|token|password|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi;

export function sanitizeText(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(SECRET_PATTERN, "$1=[redacted]");
}

export function redactForEgress<T>(value: T, profile: RedactionProfile): T {
  return redactValue(value, profile) as T;
}

function redactValue(value: unknown, profile: RedactionProfile): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, profile));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sensitive =
    profile === "shared-log" &&
    (source.redactionClass === "restricted" ||
      source.redactionClass === "secret" ||
      source.redactionPolicy === "restricted" ||
      source.redactionPolicy === "secret");
  const hash = hashRef(source);
  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(source)) {
    if (
      sensitive &&
      ["value", "raw", "content", "text", "secret", "token", "password"].includes(
        key
      )
    ) {
      output[key] = hash === undefined ? "[redacted]" : `[redacted:${hash}]`;
      continue;
    }

    output[key] = redactValue(nested, profile);
  }

  return output;
}

function hashRef(value: Record<string, unknown>): string | undefined {
  for (const key of ["hash", "contentHash", "resultHash", "argsHash"]) {
    const candidate = value[key];

    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}
