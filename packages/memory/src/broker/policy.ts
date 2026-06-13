import type { FixturePolicyBundle } from "@specwright/policy-engine";
import type { MemoryCapabilityId } from "./schemas";

export type CreateMemoryPolicyBundleOptions = {
  readonly tenantId: string;
  readonly readCorpusIds?: readonly string[];
  readonly writeCorpusIds?: readonly string[];
  readonly adminCorpusIds?: readonly string[];
  readonly redactionProfileVersion?: string;
  readonly allowHighRiskMutations?: boolean;
  readonly allowedPhases?: readonly string[];
};

const DEFAULT_ALLOWED_PHASES = ["evidence", "analysis", "implementation"] as const;

export function createMemoryPolicyBundle(
  options: CreateMemoryPolicyBundleOptions
): FixturePolicyBundle {
  const allowedPhases = [...(options.allowedPhases ?? DEFAULT_ALLOWED_PHASES)];
  const redactionProfileVersion =
    options.redactionProfileVersion ?? "standard";

  return {
    id: `memory.policy.${options.tenantId}`,
    description:
      "Memory capability policy fixture for tenant/corpus grants and redaction obligations.",
    scopes: [
      "memory:read",
      "memory:write",
      "memory:admin",
      "embeddings:read",
      `memory:tenant:${options.tenantId}`
    ],
    toolPolicy: {
      "memory.ingest": mutationPolicy({
        toolId: "memory.ingest",
        requiredScopes: ["memory:write", `memory:tenant:${options.tenantId}`],
        allowMutation: options.allowHighRiskMutations === true,
        allowedPhases,
        redactionProfileVersion,
        corpusIds: options.writeCorpusIds ?? []
      }),
      "memory.search": readPolicy({
        toolId: "memory.search",
        requiredScopes: ["memory:read", `memory:tenant:${options.tenantId}`],
        allowedPhases,
        redactionProfileVersion,
        corpusIds: options.readCorpusIds ?? []
      }),
      "embeddings.search": readPolicy({
        toolId: "embeddings.search",
        requiredScopes: ["memory:read", "embeddings:read"],
        allowedPhases,
        redactionProfileVersion,
        corpusIds: options.readCorpusIds ?? []
      }),
      "memory.get": readPolicy({
        toolId: "memory.get",
        requiredScopes: ["memory:read", `memory:tenant:${options.tenantId}`],
        allowedPhases,
        redactionProfileVersion,
        corpusIds: options.readCorpusIds ?? []
      }),
      "memory.forget": mutationPolicy({
        toolId: "memory.forget",
        requiredScopes: ["memory:admin", `memory:tenant:${options.tenantId}`],
        allowMutation: options.allowHighRiskMutations === true,
        allowedPhases,
        redactionProfileVersion,
        corpusIds: options.adminCorpusIds ?? []
      })
    },
    rules: [
      {
        id: `memory.${options.tenantId}.tenant-grant`,
        layer: "workspace",
        effect: "constrain",
        reason: `Memory calls are constrained to tenant ${options.tenantId}.`,
        match: {
          actionKind: "tool_call",
          toolId: [
            "memory.ingest",
            "memory.search",
            "embeddings.search",
            "memory.get",
            "memory.forget"
          ]
        },
        constraints: [
          {
            kind: "memory.tenant",
            value: options.tenantId
          }
        ]
      }
    ]
  };
}

function readPolicy(input: {
  readonly toolId: MemoryCapabilityId;
  readonly requiredScopes: readonly string[];
  readonly allowedPhases: readonly string[];
  readonly redactionProfileVersion: string;
  readonly corpusIds: readonly string[];
}) {
  return {
    default: "allow" as const,
    risk: input.toolId === "memory.get" ? ("low" as const) : ("medium" as const),
    reason: `${input.toolId} is allowed for granted memory corpora.`,
    allowedPhases: [...input.allowedPhases],
    requiredScopes: [...input.requiredScopes],
    allowedScopes: [...input.requiredScopes],
    constraints: [
      {
        kind: "memory.corpus.grant",
        value: [...input.corpusIds].sort()
      },
      {
        kind: "redaction.profile",
        value: input.redactionProfileVersion
      },
      {
        kind: "maxTokens",
        value: 8_192
      }
    ],
    obligations: [
      {
        kind: "redact" as const,
        params: {
          paths: ["hits.content", "content"]
        }
      },
      {
        kind: "mark_external_source" as const,
        params: {
          source: "memory://brokered-retrieval"
        }
      }
    ]
  };
}

function mutationPolicy(input: {
  readonly toolId: "memory.ingest" | "memory.forget";
  readonly requiredScopes: readonly string[];
  readonly allowMutation: boolean;
  readonly allowedPhases: readonly string[];
  readonly redactionProfileVersion: string;
  readonly corpusIds: readonly string[];
}) {
  return {
    default: input.allowMutation ? ("allow" as const) : ("approval_required" as const),
    risk: "high" as const,
    reason: input.allowMutation
      ? `${input.toolId} is allowed for a tightly scoped service action.`
      : `${input.toolId} requires memory steward approval.`,
    approvalId: `approval.${input.toolId}.memory-steward`,
    allowedPhases: [...input.allowedPhases],
    requiredScopes: [...input.requiredScopes],
    allowedScopes: [...input.requiredScopes],
    constraints: [
      {
        kind: "memory.corpus.grant",
        value: [...input.corpusIds].sort()
      },
      {
        kind: "redaction.profile",
        value: input.redactionProfileVersion
      },
      {
        kind: "maxTokens",
        value: 8_192
      }
    ],
    obligations: [
      {
        kind: "redact" as const,
        params: {
          paths:
            input.toolId === "memory.ingest"
              ? ["documents.content"]
              : ["reason"]
        }
      }
    ]
  };
}
