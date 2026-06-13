import { hashValue } from "../hash";
import type { MemoryRedactionRecord } from "./schemas";

export type MemoryRedactionProfile = {
  readonly version: string;
  readonly additionalPatterns?: readonly RegExp[];
  readonly blockedPatterns?: readonly RegExp[];
};

export type MemoryRedactionResult = {
  readonly text: string;
  readonly redactions: MemoryRedactionRecord[];
  readonly blocked: boolean;
};

const SECRET_PATTERNS: readonly { classification: string; pattern: RegExp }[] = [
  {
    classification: "api_key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9_=-]{8,}\b/g
  },
  {
    classification: "api_key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g
  },
  {
    classification: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    classification: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
  },
  {
    classification: "jwt",
    pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    classification: "connection_string",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi
  },
  {
    classification: "private_key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  }
];

const ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|authorization|client[_-]?secret|database[_-]?url|connection[_-]?string)(\s*[:=]\s*)([^\s,;]+)/gi;

export function redactForIngest(
  text: string,
  profile: MemoryRedactionProfile,
  path = "document.content"
): MemoryRedactionResult {
  return redactText(text, profile, path);
}

export function redactForRetrieval(
  text: string,
  profile: MemoryRedactionProfile,
  path = "hit.content"
): MemoryRedactionResult {
  return redactText(text, profile, path);
}

export function rawSecretPresent(value: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function redactText(
  text: string,
  profile: MemoryRedactionProfile,
  path: string
): MemoryRedactionResult {
  let output = text;
  let blocked = false;
  const redactions: MemoryRedactionRecord[] = [];

  for (const { classification, pattern } of SECRET_PATTERNS) {
    output = replaceMatches(output, pattern, path, classification, redactions);
  }

  output = output.replace(
    ASSIGNMENT_PATTERN,
    (match, key: string, separator: string, secret: string) => {
      const hash = hashValue(secret);
      redactions.push({
        path: `${path}.${key}`,
        classification: "secret_assignment",
        hash
      });
      return `${key}${separator}${hash}`;
    }
  );

  for (const pattern of profile.additionalPatterns ?? []) {
    output = replaceMatches(output, pattern, path, "policy_redact", redactions);
  }

  for (const pattern of profile.blockedPatterns ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      blocked = true;
    }
  }

  return {
    text: output,
    redactions,
    blocked
  };
}

function replaceMatches(
  text: string,
  pattern: RegExp,
  path: string,
  classification: string,
  redactions: MemoryRedactionRecord[]
): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, (raw: string) => {
    const hash = hashValue(raw);
    redactions.push({
      path,
      classification,
      hash
    });
    return hash;
  });
}
