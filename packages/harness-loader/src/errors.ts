export type HarnessLoaderErrorCode =
  | "cache_poisoned"
  | "compatibility_denied"
  | "dependency_unresolved"
  | "duplicate_id"
  | "grant_denied"
  | "invalid_artifact_schema"
  | "invalid_definition"
  | "invalid_graph"
  | "invalid_lifecycle_transition"
  | "invalid_loaded_at"
  | "invalid_manifest"
  | "invalid_prompt"
  | "missing_harness_manifest"
  | "missing_reference"
  | "parse_error"
  | "promotion_unapproved"
  | "resource_limit_exceeded"
  | "trust_rejected"
  | "unsupported_schema_version"
  | "version_immutable"
  | "version_not_resolvable";

export class HarnessLoaderError extends Error {
  readonly code: HarnessLoaderErrorCode;
  readonly reason: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: HarnessLoaderErrorCode,
    message: string,
    cause?: unknown,
    context: {
      reason?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = "HarnessLoaderError";
    this.code = code;
    this.reason = context.reason;
    this.details = context.details;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}
