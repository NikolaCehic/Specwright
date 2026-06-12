import type { ToolCallResult } from "@specwright/schemas";
import type { AdapterExecutionResult } from "@specwright/tool-broker";

export type ExternalMcpQuarantineKey = {
  serverId: string;
  toolName: string;
  version: string;
};

export type ExternalMcpQuarantineTrigger =
  | "output_invalid"
  | "external_timeout"
  | "external_failure"
  | "external_version_mismatch";

export type ExternalMcpQuarantineRecord = ExternalMcpQuarantineKey & {
  trigger: ExternalMcpQuarantineTrigger;
  failureCount: number;
};

export type ExternalMcpQuarantineStateOptions = {
  repeatedFailureThreshold?: number | undefined;
};

export class ExternalMcpQuarantineState {
  private readonly repeatedFailureThreshold: number;
  private readonly failures = new Map<string, number>();
  private readonly quarantined = new Map<string, ExternalMcpQuarantineRecord>();

  constructor(options: ExternalMcpQuarantineStateOptions = {}) {
    this.repeatedFailureThreshold = options.repeatedFailureThreshold ?? 2;
  }

  isQuarantined(key: ExternalMcpQuarantineKey) {
    return this.quarantined.has(keyFor(key));
  }

  get(key: ExternalMcpQuarantineKey) {
    return this.quarantined.get(keyFor(key));
  }

  recordAdapterResult(key: ExternalMcpQuarantineKey, result: AdapterExecutionResult) {
    if (result.status === "success") {
      this.failures.delete(keyFor(key));
      return this.get(key);
    }

    return this.recordErrorCode(key, result.error.code);
  }

  recordToolCallResult(key: ExternalMcpQuarantineKey, result: ToolCallResult) {
    if (result.status === "success") {
      this.failures.delete(keyFor(key));
      return this.get(key);
    }

    return this.recordErrorCode(key, result.error?.code ?? "external_failure");
  }

  recordErrorCode(key: ExternalMcpQuarantineKey, code: string) {
    const trigger = triggerForErrorCode(code);
    if (trigger === undefined) {
      return this.get(key);
    }

    const id = keyFor(key);
    const nextCount = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, nextCount);

    const shouldQuarantine =
      trigger === "output_invalid" ||
      trigger === "external_version_mismatch" ||
      nextCount >= this.repeatedFailureThreshold;

    if (!shouldQuarantine) {
      return this.get(key);
    }

    const record: ExternalMcpQuarantineRecord = {
      ...key,
      trigger,
      failureCount: nextCount
    };
    this.quarantined.set(id, record);
    return record;
  }

  lift(key: ExternalMcpQuarantineKey) {
    const id = keyFor(key);
    this.failures.delete(id);
    return this.quarantined.delete(id);
  }

  rePin(input: ExternalMcpQuarantineKey & { nextVersion: string }) {
    this.lift(input);
    this.failures.delete(keyFor(input));
    return {
      serverId: input.serverId,
      toolName: input.toolName,
      version: input.nextVersion
    } satisfies ExternalMcpQuarantineKey;
  }
}

export function createExternalMcpQuarantineState(
  options: ExternalMcpQuarantineStateOptions = {}
) {
  return new ExternalMcpQuarantineState(options);
}

export function externalMcpQuarantineKey(input: ExternalMcpQuarantineKey) {
  return keyFor(input);
}

function triggerForErrorCode(
  code: string
): ExternalMcpQuarantineTrigger | undefined {
  if (code === "output_invalid") {
    return "output_invalid";
  }

  if (code === "external_timeout" || code === "timeout") {
    return "external_timeout";
  }

  if (code === "external_version_mismatch") {
    return "external_version_mismatch";
  }

  if (
    code === "external_server_failed" ||
    code === "adapter_error" ||
    code === "external_transport_error"
  ) {
    return "external_failure";
  }

  return undefined;
}

function keyFor(key: ExternalMcpQuarantineKey) {
  return `${key.serverId}\u0000${key.toolName}\u0000${key.version}`;
}
