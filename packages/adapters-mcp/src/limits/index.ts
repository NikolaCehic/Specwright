import {
  DEFAULT_FS_READ_MAX_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS
} from "@specwright/tool-broker";
import { z } from "zod";

export type AdapterToolCallRateLimit = {
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
};

export type AdapterLimits = {
  concurrentSessionsPerTenant: number;
  inflightRequestsPerSession: number;
  toolCallRate: AdapterToolCallRateLimit;
  resourceReadMaxBytes: number;
  resourceListMaxPageSize: number;
  requestPayloadMaxBytes: number;
  sessionIdleTimeoutMs: number;
  externalTimeoutMs: number;
};

export type AdapterLimitsInput = Partial<{
  concurrentSessionsPerTenant: number;
  inflightRequestsPerSession: number;
  toolCallRate: Partial<AdapterToolCallRateLimit>;
  resourceReadMaxBytes: number;
  resourceListMaxPageSize: number;
  requestPayloadMaxBytes: number;
  sessionIdleTimeoutMs: number;
  externalTimeoutMs: number;
}>;

export type AdapterLimitDecision =
  | {
      ok: true;
    }
  | {
      ok: false;
      code:
        | "session_limit_exceeded"
        | "backpressure"
        | "payload_too_large"
        | "projection_too_large"
        | "session_idle_timeout";
      message: string;
      retryable: boolean;
      retryAfterMs?: number | undefined;
      limit: string;
    };

export type AdapterRequestLease = {
  release(): void;
};

export type AdapterOperationalStateSnapshot = {
  sessions: Array<{
    sessionId: string;
    tenantId: string;
    inflight: number;
    lastSeenAtMs: number;
  }>;
  tenantSessionCounts: Array<{
    tenantId: string;
    count: number;
  }>;
  tokenBuckets: Array<{
    clientId: string;
    tokens: number;
    updatedAtMs: number;
  }>;
  authorityFree: true;
};

export const DEFAULT_ADAPTER_LIMITS = {
  concurrentSessionsPerTenant: 100,
  inflightRequestsPerSession: 16,
  toolCallRate: {
    capacity: 120,
    refillTokens: 120,
    refillIntervalMs: 60_000
  },
  resourceReadMaxBytes: DEFAULT_FS_READ_MAX_BYTES,
  resourceListMaxPageSize: 50,
  requestPayloadMaxBytes: 1_000_000,
  sessionIdleTimeoutMs: 5 * 60_000,
  externalTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS
} as const satisfies AdapterLimits;

const positiveInteger = z.number().int().positive();
const limitsInputSchema = z
  .object({
    concurrentSessionsPerTenant: positiveInteger.optional(),
    inflightRequestsPerSession: positiveInteger.optional(),
    toolCallRate: z
      .object({
        capacity: positiveInteger.optional(),
        refillTokens: positiveInteger.optional(),
        refillIntervalMs: positiveInteger.optional()
      })
      .strict()
      .optional(),
    resourceReadMaxBytes: positiveInteger.optional(),
    resourceListMaxPageSize: positiveInteger.optional(),
    requestPayloadMaxBytes: positiveInteger.optional(),
    sessionIdleTimeoutMs: positiveInteger.optional(),
    externalTimeoutMs: positiveInteger.optional()
  })
  .strict();

export class AdapterLimitConfigError extends Error {
  readonly code = "invalid_limit_config";

  constructor(message: string) {
    super(message);
    this.name = "AdapterLimitConfigError";
  }
}

export function parseAdapterLimits(input: AdapterLimitsInput | undefined): AdapterLimits {
  if (input === undefined) {
    return { ...DEFAULT_ADAPTER_LIMITS, toolCallRate: { ...DEFAULT_ADAPTER_LIMITS.toolCallRate } };
  }

  const parsed = limitsInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new AdapterLimitConfigError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")
    );
  }

  return {
    concurrentSessionsPerTenant:
      parsed.data.concurrentSessionsPerTenant ??
      DEFAULT_ADAPTER_LIMITS.concurrentSessionsPerTenant,
    inflightRequestsPerSession:
      parsed.data.inflightRequestsPerSession ??
      DEFAULT_ADAPTER_LIMITS.inflightRequestsPerSession,
    resourceReadMaxBytes:
      parsed.data.resourceReadMaxBytes ??
      DEFAULT_ADAPTER_LIMITS.resourceReadMaxBytes,
    resourceListMaxPageSize:
      parsed.data.resourceListMaxPageSize ??
      DEFAULT_ADAPTER_LIMITS.resourceListMaxPageSize,
    requestPayloadMaxBytes:
      parsed.data.requestPayloadMaxBytes ??
      DEFAULT_ADAPTER_LIMITS.requestPayloadMaxBytes,
    sessionIdleTimeoutMs:
      parsed.data.sessionIdleTimeoutMs ??
      DEFAULT_ADAPTER_LIMITS.sessionIdleTimeoutMs,
    externalTimeoutMs:
      parsed.data.externalTimeoutMs ?? DEFAULT_ADAPTER_LIMITS.externalTimeoutMs,
    toolCallRate: {
      capacity:
        parsed.data.toolCallRate?.capacity ??
        DEFAULT_ADAPTER_LIMITS.toolCallRate.capacity,
      refillTokens:
        parsed.data.toolCallRate?.refillTokens ??
        DEFAULT_ADAPTER_LIMITS.toolCallRate.refillTokens,
      refillIntervalMs:
        parsed.data.toolCallRate?.refillIntervalMs ??
        DEFAULT_ADAPTER_LIMITS.toolCallRate.refillIntervalMs
    }
  };
}

export function createAdapterLimitController(input?: AdapterLimitsInput) {
  return new AdapterLimitController(parseAdapterLimits(input));
}

export class AdapterLimitController {
  readonly limits: AdapterLimits;
  private readonly sessions = new Map<string, SessionState>();
  private readonly tokenBuckets = new Map<string, TokenBucketState>();

  constructor(limits: AdapterLimits) {
    this.limits = limits;
  }

  openSession(input: {
    sessionId: string;
    tenantId: string;
    nowMs?: number | undefined;
  }): AdapterLimitDecision {
    const nowMs = input.nowMs ?? Date.now();
    const existing = this.sessions.get(input.sessionId);

    if (existing !== undefined) {
      existing.lastSeenAtMs = nowMs;
      return { ok: true };
    }

    const activeForTenant = this.activeSessionsForTenant(input.tenantId);

    if (activeForTenant >= this.limits.concurrentSessionsPerTenant) {
      return {
        ok: false,
        code: "session_limit_exceeded",
        message: `Tenant ${input.tenantId} is at the configured MCP session limit.`,
        retryable: true,
        retryAfterMs: this.limits.sessionIdleTimeoutMs,
        limit: "concurrentSessionsPerTenant"
      };
    }

    this.sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      inflight: 0,
      lastSeenAtMs: nowMs
    });

    return { ok: true };
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  acquireRequest(input: {
    sessionId: string;
    tenantId: string;
    clientId: string;
    kind: "tool-call" | "read" | "list" | "prompt";
    payloadBytes: number;
    nowMs?: number | undefined;
  }): AdapterLimitDecision | AdapterRequestLease {
    const nowMs = input.nowMs ?? Date.now();

    if (input.payloadBytes > this.limits.requestPayloadMaxBytes) {
      return {
        ok: false,
        code: "payload_too_large",
        message: `MCP request payload is ${input.payloadBytes} bytes and exceeds the configured ${this.limits.requestPayloadMaxBytes} byte limit.`,
        retryable: false,
        limit: "requestPayloadMaxBytes"
      };
    }

    const existing = this.sessions.get(input.sessionId);

    if (existing !== undefined && nowMs - existing.lastSeenAtMs > this.limits.sessionIdleTimeoutMs) {
      this.closeSession(input.sessionId);
      return {
        ok: false,
        code: "session_idle_timeout",
        message: "MCP session exceeded the configured idle timeout and was closed.",
        retryable: true,
        retryAfterMs: 0,
        limit: "sessionIdleTimeoutMs"
      };
    }

    if (existing === undefined) {
      const opened = this.openSession({
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        nowMs
      });

      if (!opened.ok) {
        return opened;
      }
    }

    const session = this.sessions.get(input.sessionId);

    if (session === undefined) {
      return {
        ok: false,
        code: "backpressure",
        message: "MCP session state is unavailable.",
        retryable: true,
        retryAfterMs: 1000,
        limit: "session"
      };
    }

    if (session.inflight >= this.limits.inflightRequestsPerSession) {
      return {
        ok: false,
        code: "backpressure",
        message: "MCP session has reached the configured inflight request limit.",
        retryable: true,
        retryAfterMs: 1000,
        limit: "inflightRequestsPerSession"
      };
    }

    if (input.kind === "tool-call") {
      const rate = this.consumeToolToken(input.clientId, nowMs);

      if (!rate.ok) {
        return rate;
      }
    }

    session.inflight += 1;
    session.lastSeenAtMs = nowMs;
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        session.inflight = Math.max(0, session.inflight - 1);
      }
    };
  }

  checkResourceReadBytes(byteLength: number): AdapterLimitDecision {
    if (byteLength <= this.limits.resourceReadMaxBytes) {
      return { ok: true };
    }

    return {
      ok: false,
      code: "projection_too_large",
      message: `MCP resource projection is ${byteLength} bytes and exceeds the configured ${this.limits.resourceReadMaxBytes} byte limit.`,
      retryable: false,
      limit: "resourceReadMaxBytes"
    };
  }

  boundedPage<T>(items: readonly T[], request?: { cursor?: number; pageSize?: number }) {
    const cursor = Math.max(0, request?.cursor ?? 0);
    const requestedPageSize = request?.pageSize ?? this.limits.resourceListMaxPageSize;
    const pageSize = Math.min(requestedPageSize, this.limits.resourceListMaxPageSize);
    const page = items.slice(cursor, cursor + pageSize);
    const nextCursor = cursor + page.length < items.length ? cursor + page.length : undefined;

    return {
      page,
      pagination: {
        cursor,
        requestedPageSize,
        pageSize,
        maxPageSize: this.limits.resourceListMaxPageSize,
        bounded: requestedPageSize > this.limits.resourceListMaxPageSize,
        ...(nextCursor === undefined ? {} : { nextCursor })
      }
    };
  }

  snapshotOperationalState(): AdapterOperationalStateSnapshot {
    return {
      sessions: [...this.sessions.values()]
        .map((session) => ({ ...session }))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
      tenantSessionCounts: [...new Set([...this.sessions.values()].map((session) => session.tenantId))]
        .map((tenantId) => ({
          tenantId,
          count: this.activeSessionsForTenant(tenantId)
        }))
        .sort((left, right) => left.tenantId.localeCompare(right.tenantId)),
      tokenBuckets: [...this.tokenBuckets.entries()]
        .map(([clientId, bucket]) => ({
          clientId,
          tokens: bucket.tokens,
          updatedAtMs: bucket.updatedAtMs
        }))
        .sort((left, right) => left.clientId.localeCompare(right.clientId)),
      authorityFree: true
    };
  }

  clearOperationalState(): void {
    this.sessions.clear();
    this.tokenBuckets.clear();
  }

  private activeSessionsForTenant(tenantId: string) {
    return [...this.sessions.values()].filter(
      (session) => session.tenantId === tenantId
    ).length;
  }

  private consumeToolToken(clientId: string, nowMs: number): AdapterLimitDecision {
    const limit = this.limits.toolCallRate;
    const current =
      this.tokenBuckets.get(clientId) ??
      {
        tokens: limit.capacity,
        updatedAtMs: nowMs
      };
    const intervals = Math.floor(
      (nowMs - current.updatedAtMs) / limit.refillIntervalMs
    );
    const tokens = Math.min(
      limit.capacity,
      current.tokens + intervals * limit.refillTokens
    );
    const updatedAtMs =
      intervals > 0
        ? current.updatedAtMs + intervals * limit.refillIntervalMs
        : current.updatedAtMs;

    if (tokens < 1) {
      this.tokenBuckets.set(clientId, {
        tokens,
        updatedAtMs
      });

      return {
        ok: false,
        code: "backpressure",
        message: "MCP tool-call rate limit is exhausted.",
        retryable: true,
        retryAfterMs: Math.max(0, limit.refillIntervalMs - (nowMs - updatedAtMs)),
        limit: "toolCallRate"
      };
    }

    this.tokenBuckets.set(clientId, {
      tokens: tokens - 1,
      updatedAtMs
    });

    return { ok: true };
  }
}

export function measureMcpPayloadBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8ByteLength(text);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;

    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}

type SessionState = {
  sessionId: string;
  tenantId: string;
  inflight: number;
  lastSeenAtMs: number;
};

type TokenBucketState = {
  tokens: number;
  updatedAtMs: number;
};
