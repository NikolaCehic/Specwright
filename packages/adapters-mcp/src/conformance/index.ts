import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, type RuntimeApi } from "@specwright/runtime";
import { getRunStorePaths, materializeRunState, readEvents } from "@specwright/run-store";

export type McpConformanceBucket =
  | "contract"
  | "determinism-replay"
  | "fail-closed"
  | "security-abuse"
  | "observability-audit"
  | "migration-compat"
  | "operability";

export type McpConformanceCase = {
  id: string;
  bucket: McpConformanceBucket;
  page10Row: string;
  evidence: string;
  seed: boolean;
  upstreamPacket?: 1 | 2 | 3 | 4 | 5 | undefined;
};

export const PAGE10_CONFORMANCE_CASES = [
  c("contract.tool-runtime-1to1", "contract", "Every MCP tool maps 1:1 to a stable RuntimeApi operation", "packages/adapters-mcp/src/index.test.ts registers exactly eleven enabled runtime-backed tools"),
  c("contract.magic-tool-unregistrable", "contract", "No magic tool is registrable", "packages/adapters-mcp/src/index.test.ts rejects magic and stale catalog registrations"),
  c("contract.resources-read-only", "contract", "resources/read is read-only", "packages/adapters-mcp/src/index.test.ts resources/write is unregistered and performs zero runtime calls"),
  c("contract.prompts-runtime-actions", "contract", "MCP prompts produce only runtime action descriptors", "packages/adapters-mcp/src/index.test.ts every prompts/get output validates as a runtime action descriptor"),
  c("contract.cli-parity", "contract", "CLI parity preserved", "packages/adapters-mcp/src/index.test.ts CLI parity for startRun proves shared runtime semantics"),
  c("contract.trust-labels", "contract", "Trust labels survive protocol mapping", "packages/adapters-mcp/src/index.test.ts trust labels survive evidence, eval, and artifact resource serialization"),

  c("determinism.event-sourced-mutations", "determinism-replay", "MCP-originated mutations are event-sourced", "packages/adapters-mcp/src/conformance.test.ts real-runtime startRun appends run.started/harness.loaded/phase.entered events", true),
  c("determinism.event-derived-projections", "determinism-replay", "Projections are event-derived", "packages/adapters-mcp/src/conformance.test.ts resource state equals materializeRunState over the append-only log"),
  c("determinism.replay-equivalence", "determinism-replay", "Replay reproduces MCP-driven runs", "packages/adapters-mcp/src/conformance.test.ts MCP replay state equals materialized state"),
  c("determinism.idempotent-retry", "determinism-replay", "Idempotent retries do not duplicate effects", "packages/adapters-mcp/src/conformance.test.ts real-runtime idempotent MCP tool retry returns cached result without duplicate runtime events"),
  c("determinism.cache-advisory", "determinism-replay", "Cached projections are advisory", "packages/adapters-mcp/src/index.test.ts repeated canonical reads are byte-identical and project from runtime reads"),

  c("fail.invalid-args", "fail-closed", "Invalid args fail closed", "packages/adapters-mcp/src/index.test.ts unknown, disabled, and invalid calls fail closed with zero runtime calls"),
  c("fail.stale-state", "fail-closed", "Stale state is rejected", "packages/adapters-mcp/src/observability/packet05.test.ts stale-state metric and expectedLastEventId audit coverage"),
  c("fail.policy-denial", "fail-closed", "Policy denial is relayed, never bypassed", "packages/adapters-mcp/src/index.test.ts runtime policy denial and approval_required are surfaced without laundering"),
  c("fail.policy-error", "fail-closed", "Policy fault fails closed", "packages/adapters-mcp/src/index.test.ts policy_error outcome surfaces as a denial"),
  c("fail.approval-not-auto", "fail-closed", "Approval is never auto-satisfied", "packages/adapters-mcp/src/index.test.ts approval_required is returned as an error with approvalId"),
  c("fail.approval-terminal", "fail-closed", "Approval timeout/rejection is terminal", "packages/adapters-mcp/src/index.test.ts disabled record_approval remains unavailable until runtime exports it"),
  c("fail.partial-write", "fail-closed", "Partial-write fails closed", "packages/adapters-mcp/src/observability/packet05.test.ts side-effecting operations fail closed on audit and span partial writes"),
  c("fail.no-silent-partial-mutation", "fail-closed", "No silent partial mutation", "packages/adapters-mcp/src/observability/packet05.test.ts mutating tools fail closed when post-mutation runtime events cannot be read"),

  c("security.confused-deputy", "security-abuse", "Confused-deputy prevented", "packages/adapters-mcp/src/index.test.ts secure callTool binds composed principal context and strips caller toolContext tokens"),
  c("security.no-token-passthrough", "security-abuse", "No token passthrough", "packages/adapters-mcp/src/external-capability.test.ts external transport receives brokered args without raw credentials"),
  c("security.external-non-authoritative", "security-abuse", "External output is non-authoritative", "packages/adapters-mcp/src/external-capability.test.ts external output is classified as external_observation"),
  c("security.drift-quarantined", "security-abuse", "Rug-pull/drift quarantined", "packages/adapters-mcp/src/external-capability.test.ts output_invalid quarantines external capability"),
  c("security.duplicate-tool", "security-abuse", "No cross-server shadowing", "packages/adapters-mcp/src/external-capability.test.ts duplicate capability registration is rejected"),
  c("security.tenant-isolation", "security-abuse", "Tenant isolation holds", "packages/adapters-mcp/src/index.test.ts tenant resolver denies cross-tenant resources without runtime lookup"),
  c("security.path-containment", "security-abuse", "Path containment holds", "packages/tool-broker/src/containment.test.ts broker rejects path_outside_workspace and MCP adds no path resolution"),
  c("security.subject-spoof", "security-abuse", "Subject spoof rejected", "packages/adapters-mcp/src/index.test.ts malformed and unverifiable subject claims fail closed"),
  c("security.error-oracle", "security-abuse", "Error oracle closed", "packages/adapters-mcp/src/index.test.ts secure runtime throws use safe error contract without secrets, paths, or stacks"),
  c("security.redaction-not-relaxable", "security-abuse", "Redaction cannot be relaxed", "packages/adapters-mcp/src/index.test.ts default egress redaction hashes restricted nested values"),
  c("security.mass-exfiltration-bounded", "security-abuse", "Mass-exfiltration bounded", "packages/adapters-mcp/src/limits.test.ts rate/list/page/projection limits bound broad reads"),

  c("observability.span-coverage", "observability-audit", "MCP span coverage", "packages/adapters-mcp/src/observability/packet05.test.ts tools/call writes parent span and child link"),
  c("observability.correlation-spine", "observability-audit", "Correlation spine intact", "packages/adapters-mcp/src/observability/packet05.test.ts four-way correlation by request trace run and event"),
  c("observability.principal-durable", "observability-audit", "Principal is durable", "packages/adapters-mcp/src/observability/packet05.test.ts session opened/request records include principal"),
  c("observability.effects-attributable", "observability-audit", "Every effect is attributable", "packages/adapters-mcp/src/observability/packet05.test.ts action dispatched records event ids and runtime operation"),
  c("observability.authorization-auditable", "observability-audit", "Authorization is auditable", "packages/adapters-mcp/src/observability/packet05.test.ts denied and approval-required outcomes persist policyDecisionRef"),
  c("observability.external-recorded", "observability-audit", "External invocations recorded", "packages/adapters-mcp/src/observability/packet05.test.ts mcp.external.invoked captures server id pinned version and hashes"),
  c("observability.provenance-gap", "observability-audit", "Provenance gaps are flagged", "packages/adapters-mcp/src/observability/packet05.test.ts side-effecting operations emit mcp.provenance_gap"),
  c("observability.integrity-bound-export", "observability-audit", "Audit export is integrity-bound", "packages/adapters-mcp/src/observability/packet05.test.ts buildMcpAuditExport bundles records, spans, and hashes"),

  c("migration.contracts-versioned", "migration-compat", "Tool/resource/prompt contracts are versioned", "packages/adapters-mcp/src/versioning.test.ts every descriptor carries contract id version and compatibility class", true),
  c("migration.protocol-negotiation", "migration-compat", "Protocol-version negotiation is explicit", "packages/adapters-mcp/src/versioning.test.ts unsupported client protocol version rejected with supported range", true),
  c("migration.breaking-change-note", "migration-compat", "Breaking contract changes carry migration", "packages/adapters-mcp/src/versioning.test.ts migration-required request returns contract id version and migration note", true),
  c("migration.historical-replay", "migration-compat", "Historical MCP-driven runs replay", "packages/adapters-mcp/src/conformance.test.ts MCP-created run replays or is explicitly migrated under the current registry"),
  c("migration.deprecation-window", "migration-compat", "Deprecation honors notice window", "packages/adapters-mcp/src/versioning.test.ts deprecated contract remains listed with deprecation metadata", true),

  c("operability.limits-enforced", "operability", "Limits are enforced, not best-effort", "packages/adapters-mcp/src/limits.test.ts every configured limit yields deny/backpressure", true),
  c("operability.load-shed", "operability", "Load is shed, not dropped", "packages/adapters-mcp/src/limits.test.ts side-effecting over-limit request does not call RuntimeApi mutation"),
  c("operability.tenant-before-resolution", "operability", "Tenancy is enforced before resolution", "packages/adapters-mcp/src/index.test.ts cross-tenant resource denied before runtime lookup"),
  c("operability.external-manifest-pinned", "operability", "External-server manifests are pinned", "packages/adapters-mcp/src/external-capability.test.ts manifest requires pinned external server version"),
  c("operability.runbooks-exist", "operability", "Runbooks exist", "packages/adapters-mcp/src/conformance.test.ts registry maps page-8 failure classes to runnable failure cases"),
  c("operability.gateway-stateless", "operability", "Gateway scales statelessly", "packages/adapters-mcp/src/limits.test.ts clearing operational state loses no runtime state and authorizes no prior denial", true),
  c("operability.change-governance", "operability", "Change governance enforced", "packages/adapters-mcp/src/conformance.test.ts guard requires every seed acceptance check and page-10 row")
] as const satisfies readonly McpConformanceCase[];

export const PAGE10_SEED_CASE_IDS = [
  "migration.protocol-negotiation",
  "migration.deprecation-window",
  "operability.limits-enforced",
  "determinism.event-sourced-mutations",
  "migration.contracts-versioned",
  "operability.gateway-stateless"
] as const;

export const PAGE8_FAILURE_CLASS_COUNT = 26;

export const FIXED_CONFORMANCE_NOW = "2026-05-29T00:00:00.000Z";

export type RealRuntimeConformanceHarness = {
  tempRoot: string;
  appDir: string;
  runtime: RuntimeApi;
  cleanup(): Promise<void>;
  groundTruth(runId: string): Promise<{
    paths: ReturnType<typeof getRunStorePaths>;
    events: Awaited<ReturnType<typeof readEvents>>;
    state: Awaited<ReturnType<typeof materializeRunState>>;
  }>;
};

export async function createRealRuntimeConformanceHarness(): Promise<RealRuntimeConformanceHarness> {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const fixtureSourceDir = join(repoRoot, "fixtures/simple-app");
  const tempRoot = await mkdtemp(join(tmpdir(), "specwright-mcp-conformance-"));
  const appDir = join(tempRoot, "simple-app");

  await cp(fixtureSourceDir, appDir, { recursive: true });

  return {
    tempRoot,
    appDir,
    runtime: createRuntime({
      now: () => FIXED_CONFORMANCE_NOW
    }),
    cleanup() {
      return rm(tempRoot, { recursive: true, force: true });
    },
    async groundTruth(runId: string) {
      return {
        paths: getRunStorePaths(appDir, runId),
        events: await readEvents({ rootDir: appDir, runId }),
        state: await materializeRunState({ rootDir: appDir, runId })
      };
    }
  };
}

export function conformanceSummary() {
  const counts = new Map<McpConformanceBucket, number>();

  for (const item of PAGE10_CONFORMANCE_CASES) {
    counts.set(item.bucket, (counts.get(item.bucket) ?? 0) + 1);
  }

  return counts;
}

function c(
  id: string,
  bucket: McpConformanceBucket,
  page10Row: string,
  evidence: string,
  seed = false,
  upstreamPacket?: 1 | 2 | 3 | 4 | 5
): McpConformanceCase {
  return {
    id,
    bucket,
    page10Row,
    evidence,
    seed,
    ...(upstreamPacket === undefined ? {} : { upstreamPacket })
  };
}
