import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const wikiRoot = "/Users/nikolacehic/Desktop/Specwright-Wiki";
const buildPacketDir = `${wikiRoot}/09-Roadmap/Build-Packets`;

const expectedBuildPacketFiles = [
  "09-Roadmap/Build-Packets/01-01-Contract-Inventory-And-Taxonomy.md",
  "09-Roadmap/Build-Packets/01-02-Typed-Event-Contract-Authority.md",
  "09-Roadmap/Build-Packets/01-03-Artifact-And-Evidence-Authority-Contracts.md",
  "09-Roadmap/Build-Packets/01-04-Lifecycle-Decision-Contract-Alignment.md",
  "09-Roadmap/Build-Packets/01-05-Contract-Registry-Generation-And-Compatibility.md",
  "09-Roadmap/Build-Packets/02-01-Event-Integrity-Chain-And-Verification.md",
  "09-Roadmap/Build-Packets/02-02-Checkpointed-Projection-And-Bounded-Replay.md",
  "09-Roadmap/Build-Packets/02-03-Redaction-Enforcing-Read-Egress.md",
  "09-Roadmap/Build-Packets/02-04-Store-Administration-Audit-And-Dual-Control-Operations.md",
  "09-Roadmap/Build-Packets/02-05-Run-Package-Version-Migration-Path.md",
  "09-Roadmap/Build-Packets/02-06-Retention-Sealing-And-Archival-With-Legal-Hold.md",
  "09-Roadmap/Build-Packets/03-01-Trust-Verification-And-Package-Signing.md",
  "09-Roadmap/Build-Packets/03-02-Capability-Grant-Enforcement.md",
  "09-Roadmap/Build-Packets/03-03-Dependency-Resolution-And-Pinning.md",
  "09-Roadmap/Build-Packets/03-04-Compatibility-Matrix-And-Schema-Version-Migration.md",
  "09-Roadmap/Build-Packets/03-05-Load-Observability-And-Provenance-Emission.md",
  "09-Roadmap/Build-Packets/03-06-Registry-Lifecycle-Limits-And-Operator-Runbooks.md",
  "09-Roadmap/Build-Packets/03-07-Scope-03-Closure-Remediation-And-Enterprise-Verification.md",
  "09-Roadmap/Build-Packets/04-01-Bundle-Load-Hardening-And-Validation.md",
  "09-Roadmap/Build-Packets/04-02-Policy-Trace-Span-And-Audit-Event-Emission.md",
  "09-Roadmap/Build-Packets/04-03-Layered-Policy-Domains-Scopes-And-Budgets-Conformance.md",
  "09-Roadmap/Build-Packets/04-04-Determinism-Decision-Hash-And-Replay-Equivalence.md",
  "09-Roadmap/Build-Packets/04-05-Fail-Closed-And-Abuse-Case-Fixture-Corpus.md",
  "09-Roadmap/Build-Packets/04-06-CI-Policy-Validation-And-Governance-Gates.md",
  "09-Roadmap/Build-Packets/05-01-Gate-Definition-Language-And-Loader-Conformance.md",
  "09-Roadmap/Build-Packets/05-02-Deterministic-Check-Engine-Hardening-And-Decision-Hash.md",
  "09-Roadmap/Build-Packets/05-03-Constrained-Model-Assisted-Check-Pathway.md",
  "09-Roadmap/Build-Packets/05-04-Bounded-Repair-Task-And-Human-Review-Instruction-Emission.md",
  "09-Roadmap/Build-Packets/05-05-Verdict-Audit-Provenance-And-Replay-Linkage.md",
  "09-Roadmap/Build-Packets/05-06-Versioning-Migration-And-Golden-Fixture-Governance.md",
  "09-Roadmap/Build-Packets/06-01-Capability-Registry-And-Tool-Definition-Contracts.md",
  "09-Roadmap/Build-Packets/06-02-Staged-Invocation-Protocol-Approval-Coordination-And-Limits.md",
  "09-Roadmap/Build-Packets/06-03-Output-Validation-Redaction-And-Provenance-Recording.md",
  "09-Roadmap/Build-Packets/06-04-Brokered-Cache-Eligibility-Keys-And-Re-Validation.md",
  "09-Roadmap/Build-Packets/06-05-Isolation-Tiers-And-Adapter-Sandboxing.md",
  "09-Roadmap/Build-Packets/06-06-Broker-Conformance-Replay-And-Governance-Gates.md",
  "09-Roadmap/Build-Packets/07-01-Eval-Registry-And-Definition-Governance.md",
  "09-Roadmap/Build-Packets/07-02-Deterministic-Verdict-Integrity-And-Decision-Hash.md",
  "09-Roadmap/Build-Packets/07-03-Constrained-Model-Assisted-Grading.md",
  "09-Roadmap/Build-Packets/07-04-Datasets-Graders-And-Trace-Based-Regression.md",
  "09-Roadmap/Build-Packets/07-05-Eval-Event-Emission-Spans-And-Repair-Provenance.md",
  "09-Roadmap/Build-Packets/07-06-Eval-Runner-Conformance-And-Fail-Closed-Suite.md",
  "09-Roadmap/Build-Packets/08-01-Exit-Code-And-Error-Record-Contract.md",
  "09-Roadmap/Build-Packets/08-02-Machine-Readable-Output-Contract-And-Versioning.md",
  "09-Roadmap/Build-Packets/08-03-Identity-Authorization-Pre-Flight-And-Redaction-Egress.md",
  "09-Roadmap/Build-Packets/08-04-Approval-And-Clarification-Commands.md",
  "09-Roadmap/Build-Packets/08-05-CI-Fail-Closed-Behavior-And-Invocation-Telemetry.md",
  "09-Roadmap/Build-Packets/08-06-Adapter-Parity-Conformance-Suite.md",
  "09-Roadmap/Build-Packets/09-01-MCP-Protocol-Surface-And-RuntimeApi-Tool-Mapping.md",
  "09-Roadmap/Build-Packets/09-02-Read-Only-Resources-And-Runtime-Action-Prompts.md",
  "09-Roadmap/Build-Packets/09-03-Authentication-Authorization-Composition-And-Egress-Redaction.md",
  "09-Roadmap/Build-Packets/09-04-External-MCP-Server-Mediation-Through-The-Broker.md",
  "09-Roadmap/Build-Packets/09-05-MCP-Observability-Audit-And-Provenance-Correlation.md",
  "09-Roadmap/Build-Packets/09-06-MCP-Conformance-Versioning-And-Operability-Harness.md",
  "09-Roadmap/Build-Packets/10-01-Mandatory-Span-Coverage-And-Trace-Attribution.md",
  "09-Roadmap/Build-Packets/10-02-Trace-To-Event-Reconciliation-And-Integrity-Metrics.md",
  "09-Roadmap/Build-Packets/10-03-Redaction-And-Tenant-Scoped-Egress-Enforcement.md",
  "09-Roadmap/Build-Packets/10-04-Audit-Export-Bundle-And-Integrity-Sealing.md",
  "09-Roadmap/Build-Packets/10-05-Retention-Erasure-And-Legal-Hold-Governance.md",
  "09-Roadmap/Build-Packets/10-06-Tenancy-Partitioning-And-Release-Compatibility-Gate.md",
  "09-Roadmap/Build-Packets/11-01-Corpus-Chunking-And-Chunk-Store.md",
  "09-Roadmap/Build-Packets/11-02-Lexical-BM25-And-Proximity-Index.md",
  "09-Roadmap/Build-Packets/11-03-Embedding-And-Vector-ANN-Index.md",
  "09-Roadmap/Build-Packets/11-04-Hybrid-Fusion-Ranking-Rerank-And-MMR.md",
  "09-Roadmap/Build-Packets/11-05-Retrieval-Quality-Eval-Datasets-And-Graders.md",
  "09-Roadmap/Build-Packets/11-06-Broker-Capability-Wiring-Policy-Redaction-And-Tenant-Isolation.md"
] as const;

const wikiStatusSnapshot = {
  observedAt: "2026-06-14",
  buildPacketFileCount: 66,
  proposedStatusCount: 66,
  terminalStatusCount: 0,
  wikiHasLocalGitRepository: false,
  mergedPullRequestCount: 72
} as const;

const staleStatusExamples = [
  {
    packet: "11-03",
    file: "09-Roadmap/Build-Packets/11-03-Embedding-And-Vector-ANN-Index.md",
    currentWikiStatus: "proposed",
    proposedReconciledStatus: "merged",
    confidence: "high",
    pullRequest: 63,
    mergedAt: "2026-06-12T23:18:08Z",
    mergeCommit: "a1fee11378f3e6622af0e2e2b610b29b2980ca98",
    headRefName: "scope-11/packet-03-embedding-and-vector-ann-index",
    logNeedles: ["Scope 11 Packet 03 merged", "Scope 11's six implementation packets are now complete and merged"]
  },
  {
    packet: "11-06",
    file: "09-Roadmap/Build-Packets/11-06-Broker-Capability-Wiring-Policy-Redaction-And-Tenant-Isolation.md",
    currentWikiStatus: "proposed",
    proposedReconciledStatus: "merged",
    confidence: "high",
    pullRequest: 66,
    mergedAt: "2026-06-13T01:28:00Z",
    mergeCommit: "401813a51ee8edd9922074dab9a14498e37265ae",
    headRefName: "scope-11/packet-06-broker-capability-wiring-policy-redaction-and-tenant-isolation",
    logNeedles: ["Scope 11 Packet 06 merged", "Scope 11's six implementation packets are now complete and merged"]
  }
] as const;

const terminalStatusTaxonomy = [
  "proposed",
  "pending",
  "merged",
  "complete",
  "superseded",
  "abandoned",
  "blocked",
  "unknown"
] as const;

const specialCaseRules = [
  {
    case: "non_packet_pr",
    rule: "Exclude from packet status reconciliation unless a packet page or log entry names it."
  },
  {
    case: "scope_08_broad_pr",
    rule: "Do not fan one broad PR across six packet pages until G-WIKI-001 accepts a mapping rule."
  },
  {
    case: "local_wiki_without_git",
    rule: "Prefer a repo-local detector or explicit reconciliation artifact before frontmatter rewrites."
  }
] as const;

const reconciliationCadence = [
  "post_merge_packet_review",
  "release_readiness_review",
  "manual_planning_audit"
] as const;

const futureOwners = [
  ["status_authority", "G-WIKI-001"],
  ["terminal_taxonomy", "G-WIKI-001/OPT-EPIC-013"],
  ["frontmatter_rewrites", "G-WIKI-001"],
  ["append_only_log_policy", "G-WIKI-001"],
  ["post_merge_workflow", "OPT-EPIC-013/G-CI-001"],
  ["scope_08_mapping_rule", "G-WIKI-001"]
] as const;

describe("AUD-017A wiki status reconciliation", () => {
  test("build-packet inventory snapshot covers every central page", () => {
    expect(expectedBuildPacketFiles).toHaveLength(
      wikiStatusSnapshot.buildPacketFileCount
    );
    expect(new Set(expectedBuildPacketFiles).size).toBe(
      expectedBuildPacketFiles.length
    );
    expect([...expectedBuildPacketFiles].sort()).toEqual(expectedBuildPacketFiles);
    expect(wikiStatusSnapshot).toMatchObject({
      buildPacketFileCount: 66,
      proposedStatusCount: 66,
      terminalStatusCount: 0,
      wikiHasLocalGitRepository: false,
      mergedPullRequestCount: 72
    });
    expect(expectedBuildPacketFiles[0]).toBe(
      "09-Roadmap/Build-Packets/01-01-Contract-Inventory-And-Taxonomy.md"
    );
    expect(expectedBuildPacketFiles.at(-1)).toBe(
      "09-Roadmap/Build-Packets/11-06-Broker-Capability-Wiring-Policy-Redaction-And-Tenant-Isolation.md"
    );
  });

  test("stale examples and reconciliation rules are evidence-backed", () => {
    expect(staleStatusExamples.map((row) => row.file)).toEqual([
      "09-Roadmap/Build-Packets/11-03-Embedding-And-Vector-ANN-Index.md",
      "09-Roadmap/Build-Packets/11-06-Broker-Capability-Wiring-Policy-Redaction-And-Tenant-Isolation.md"
    ]);
    expect(staleStatusExamples.every((row) => row.currentWikiStatus === "proposed"))
      .toBe(true);
    expect(
      staleStatusExamples.every(
        (row) =>
          row.proposedReconciledStatus === "merged" &&
          row.confidence === "high" &&
          row.mergeCommit.length === 40 &&
          row.logNeedles.length >= 2
      )
    ).toBe(true);
    expect(terminalStatusTaxonomy).toEqual([
      "proposed",
      "pending",
      "merged",
      "complete",
      "superseded",
      "abandoned",
      "blocked",
      "unknown"
    ]);
    expect(specialCaseRules.map((row) => row.case)).toEqual([
      "non_packet_pr",
      "scope_08_broad_pr",
      "local_wiki_without_git"
    ]);
    expect(reconciliationCadence).toEqual([
      "post_merge_packet_review",
      "release_readiness_review",
      "manual_planning_audit"
    ]);
    expect(futureOwners.every(([, owner]) => owner.length > 0)).toBe(true);
  });

  if (process.env.SPECWRIGHT_WIKI_RECONCILIATION_LIVE === "1") {
    test("optional live wiki and GitHub verifier remains read-only", async () => {
      const liveFiles = liveBuildPacketFiles();
      const log = await readFile(`${wikiRoot}/log.md`, "utf8");
      const mergedPullRequests = ghJson([
        "pr",
        "list",
        "--repo",
        "NikolaCehic/Specwright",
        "--state",
        "merged",
        "--limit",
        "200",
        "--json",
        "number,title,headRefName,baseRefName,mergedAt,mergeCommit"
      ]) as Array<{ number: number }>;

      expect(existsSync(`${wikiRoot}/.git`)).toBe(false);
      expect(liveFiles).toEqual(expectedBuildPacketFiles);
      expect(statusCount("proposed")).toBe(66);
      expect(statusCount("(complete|completed|merged)")).toBe(0);
      expect(mergedPullRequests.length).toBeGreaterThanOrEqual(
        wikiStatusSnapshot.mergedPullRequestCount
      );

      for (const example of staleStatusExamples) {
        const packet = await readFile(`${wikiRoot}/${example.file}`, "utf8");
        const pullRequest = ghJson([
          "pr",
          "view",
          String(example.pullRequest),
          "--repo",
          "NikolaCehic/Specwright",
          "--json",
          "number,title,headRefName,baseRefName,mergedAt,mergeCommit"
        ]) as {
          number: number;
          headRefName: string;
          mergedAt: string;
          mergeCommit: { oid: string };
        };

        expect(packet).toContain("status: proposed");
        expect(pullRequest).toMatchObject({
          number: example.pullRequest,
          headRefName: example.headRefName,
          mergedAt: example.mergedAt,
          mergeCommit: { oid: example.mergeCommit }
        });

        for (const needle of example.logNeedles) {
          expect(log).toContain(needle);
        }
      }
    });
  } else {
    test.skip("optional live wiki and GitHub verifier remains read-only", () => {});
  }
});

function liveBuildPacketFiles() {
  return commandOutput("find", [
    buildPacketDir,
    "-type",
    "f",
    "-name",
    "*.md",
    "-print"
  ])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => file.replace(`${wikiRoot}/`, ""))
    .sort((left, right) => left.localeCompare(right));
}

function statusCount(statusPattern: string) {
  const result = spawnSync("rg", [
    "-l",
    `^status: ${statusPattern}$`,
    buildPacketDir
  ], {
    encoding: "utf8"
  });

  if (result.status === 1) {
    return 0;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `rg -l ^status: ${statusPattern}$ ${buildPacketDir} exited with status ${result.status}.`
    );
  }

  const output = result.stdout.trim();

  return output.length === 0 ? 0 : output.split(/\r?\n/).length;
}

function ghJson(args: string[]) {
  return JSON.parse(commandOutput("gh", args)) as unknown;
}

function commandOutput(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `${command} ${args.join(" ")} exited with status ${result.status}.`
    );
  }

  return result.stdout.trim();
}
