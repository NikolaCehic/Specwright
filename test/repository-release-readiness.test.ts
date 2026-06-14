import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");

const workflowRows = [
  {
    file: ".github/workflows/eval-runner-conformance.yml",
    name: "Eval Runner Conformance",
    jobName: "Eval runner conformance gate",
    requiredByBranchProtection: false,
    pathFiltered: true
  },
  {
    file: ".github/workflows/policy-validation.yml",
    name: "Policy Validation",
    jobName: "Policy validation",
    requiredByBranchProtection: true,
    pathFiltered: true
  },
  {
    file: ".github/workflows/specwright-ci.yml",
    name: "Specwright CI",
    jobName: "Root gates",
    requiredByBranchProtection: false,
    pathFiltered: false
  },
  {
    file: ".github/workflows/tool-broker-conformance.yml",
    name: "Tool Broker Conformance",
    jobName: "Broker conformance gate",
    requiredByBranchProtection: false,
    pathFiltered: true
  }
] as const;

const repositoryReleaseSnapshot = {
  observedAt: "2026-06-14",
  repository: "NikolaCehic/Specwright",
  defaultBranch: "main",
  mainSha: "b77c6b0be404e646d908d860409336a6d1f8c5e9",
  visibility: "PUBLIC",
  mainProtected: true,
  requiredStatusChecks: ["Policy validation"],
  requiredStatusChecksStrict: true,
  requiredPullRequestReviewsConfigured: false,
  enforceAdmins: false,
  requiredLinearHistory: false,
  allowForcePushes: false,
  allowDeletions: false,
  deleteBranchOnMerge: false,
  mergeMethodsAllowed: ["merge", "squash", "rebase"],
  openPrsBeforeAud016Pr: [
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81
  ],
  openIssueCount: 0,
  githubReleaseCount: 0,
  remoteHeadCountBeforeAud016Pr: 40,
  remoteTrackingCountBeforeAud016Pr: 40,
  mergedRemoteTrackingCountBeforeAud016Pr: 32,
  nonMergedRemoteTrackingBranchesBeforeAud016Pr: [
    "origin/codex/aud-004a-runtime-approval-decision-api",
    "origin/codex/aud-005a-installability-readiness-matrix",
    "origin/codex/aud-006a-source-cycle-inventory-guardrail",
    "origin/codex/aud-008a-unused-code-baseline-guardrail",
    "origin/codex/aud-011a-mcp-server-deployability-matrix",
    "origin/codex/aud-012a-runtime-capability-baseline-matrix",
    "origin/codex/aud-015a-naming-migration-inventory",
    "origin/codex/opt-003a-dependency-isolation-guardrail"
  ],
  originTagCount: 0,
  currentMainCheckRunCount: 0,
  currentMainCommitStatusCount: 0,
  currentMainCommitStatusState: "pending"
} as const;

const releaseReadinessGapOwners = [
  ["branch_cleanup", "OPT-EPIC-012/G-GH-001"],
  ["branch_protection_settings", "OPT-EPIC-014/G-GH-002/G-CI-001"],
  ["authoritative_ci", "OPT-EPIC-001/G-CI-001"],
  ["release_tags", "FEAT-EPIC-013/G-REL-001"],
  ["github_releases", "FEAT-EPIC-013/G-REL-001"],
  ["changelog_release_notes", "FEAT-EPIC-013/G-REL-001"],
  ["package_publishability", "AUD-005A/FEAT-EPIC-001/G-PKG-001"],
  ["package_provenance_publish_credentials", "FEAT-EPIC-013/G-REL-001"],
  ["compatibility_policy", "FEAT-EPIC-013/G-REL-001"],
  ["delete_branch_on_merge_policy", "OPT-EPIC-012/G-GH-001"]
] as const;

const releaseReadinessChecklist = [
  "default branch and protected branch state",
  "required checks and workflow trigger coverage",
  "open PR and issue state",
  "remote branch inventory and cleanup ownership",
  "local and origin tag inventory",
  "GitHub release inventory",
  "changelog and migration-note inventory",
  "package publishability and provenance ownership",
  "compatibility and release policy ownership"
] as const;

const remoteVerifierCommands = [
  "gh repo view NikolaCehic/Specwright --json defaultBranchRef,deleteBranchOnMerge,hasIssuesEnabled,hasWikiEnabled,isPrivate,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,visibility",
  "gh api repos/NikolaCehic/Specwright/branches/main",
  "gh api repos/NikolaCehic/Specwright/branches/main/protection",
  "gh workflow list --repo NikolaCehic/Specwright --all",
  "gh pr list --repo NikolaCehic/Specwright --state open --limit 100",
  "gh issue list --repo NikolaCehic/Specwright --state open --limit 100",
  "gh release list --repo NikolaCehic/Specwright --limit 100",
  "git ls-remote --heads origin",
  "git ls-remote --tags origin",
  "git branch -r",
  "git branch -r --merged origin/main",
  "git branch -r --no-merged origin/main",
  "gh api repos/NikolaCehic/Specwright/commits/<main-sha>/check-runs",
  "gh api repos/NikolaCehic/Specwright/commits/<main-sha>/status"
] as const;

describe("AUD-016A repository release readiness", () => {
  test("local release-readiness evidence remains explicit and non-mutating", async () => {
    const rootManifest = JSON.parse(
      await readFile(join(rootDir, "package.json"), "utf8")
    ) as { private?: boolean; scripts?: Record<string, string> };
    const workflowFiles = trackedFiles().filter((file) =>
      file.startsWith(".github/workflows/")
    );

    expect(rootManifest.private).toBe(true);
    expect(Object.keys(rootManifest.scripts ?? {}).sort()).toEqual([
      "build",
      "check:cycles",
      "check:deps",
      "check:pack",
      "check:unused",
      "ci",
      "proof:v0",
      "test",
      "test:all",
      "test:core",
      "typecheck",
      "typecheck:packages"
    ]);
    expect(localGitTags()).toEqual([]);
    expect(releaseDocumentCandidates()).toEqual([]);
    expect(operationReleaseSourceFiles()).toEqual([
      "packages/operations/src/release.test.ts",
      "packages/operations/src/release.ts"
    ]);
    expect(workflowFiles.sort()).toEqual(workflowRows.map((row) => row.file));

    for (const row of workflowRows) {
      const workflow = await readFile(join(rootDir, row.file), "utf8");

      expect(workflow).toContain(`name: ${row.name}`);
      expect(workflow).toContain(`name: ${row.jobName}`);
      expect(workflow).toContain("pull_request:");
      expect(workflow).toContain("push:");
      expect(workflow).toContain("branches:");
      expect(workflow).toContain("- main");
      if (row.pathFiltered) {
        expect(workflow).toContain("paths:");
      } else {
        expect(workflow).not.toContain("paths:");
      }
      expect(workflow).toContain("bun run build");
      expect(workflow).toContain("bun run typecheck");
    }

    expect(
      workflowRows
        .filter((row) => row.requiredByBranchProtection)
        .map((row) => row.jobName)
    ).toEqual(repositoryReleaseSnapshot.requiredStatusChecks);
  });

  test("remote release posture is captured as read-only verifier evidence", () => {
    expect(repositoryReleaseSnapshot).toMatchObject({
      repository: "NikolaCehic/Specwright",
      defaultBranch: "main",
      visibility: "PUBLIC",
      mainProtected: true,
      requiredStatusChecks: ["Policy validation"],
      requiredStatusChecksStrict: true,
      requiredPullRequestReviewsConfigured: false,
      allowForcePushes: false,
      allowDeletions: false,
      deleteBranchOnMerge: false,
      openIssueCount: 0,
      githubReleaseCount: 0,
      originTagCount: 0,
      currentMainCheckRunCount: 0,
      currentMainCommitStatusCount: 0,
      currentMainCommitStatusState: "pending"
    });
    expect(repositoryReleaseSnapshot.openPrsBeforeAud016Pr).toEqual([
      74,
      75,
      76,
      77,
      78,
      79,
      80,
      81
    ]);
    expect(repositoryReleaseSnapshot.remoteHeadCountBeforeAud016Pr).toBe(40);
    expect(repositoryReleaseSnapshot.remoteTrackingCountBeforeAud016Pr).toBe(40);
    expect(repositoryReleaseSnapshot.mergedRemoteTrackingCountBeforeAud016Pr)
      .toBe(32);
    expect(repositoryReleaseSnapshot.nonMergedRemoteTrackingBranchesBeforeAud016Pr)
      .toEqual([
        "origin/codex/aud-004a-runtime-approval-decision-api",
        "origin/codex/aud-005a-installability-readiness-matrix",
        "origin/codex/aud-006a-source-cycle-inventory-guardrail",
        "origin/codex/aud-008a-unused-code-baseline-guardrail",
        "origin/codex/aud-011a-mcp-server-deployability-matrix",
        "origin/codex/aud-012a-runtime-capability-baseline-matrix",
        "origin/codex/aud-015a-naming-migration-inventory",
        "origin/codex/opt-003a-dependency-isolation-guardrail"
      ]);
    expect(releaseReadinessChecklist).toHaveLength(9);
    expect(releaseReadinessGapOwners.every(([, owner]) => owner.length > 0))
      .toBe(true);
    expect(releaseReadinessGapOwners.map(([gap]) => gap)).toEqual([
      "branch_cleanup",
      "branch_protection_settings",
      "authoritative_ci",
      "release_tags",
      "github_releases",
      "changelog_release_notes",
      "package_publishability",
      "package_provenance_publish_credentials",
      "compatibility_policy",
      "delete_branch_on_merge_policy"
    ]);
    expect(remoteVerifierCommands.every(isReadOnlyVerifierCommand)).toBe(true);
  });

  if (process.env.SPECWRIGHT_RELEASE_READINESS_REMOTE === "1") {
    test("optional live remote verifier checks stay read-only", () => {
      const repository = ghJson([
        "repo",
        "view",
        "NikolaCehic/Specwright",
        "--json",
        "defaultBranchRef,deleteBranchOnMerge,isPrivate,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,visibility"
      ]) as {
        defaultBranchRef: { name: string };
        deleteBranchOnMerge: boolean;
        isPrivate: boolean;
        mergeCommitAllowed: boolean;
        rebaseMergeAllowed: boolean;
        squashMergeAllowed: boolean;
        visibility: string;
      };
      const mainBranch = ghJson([
        "api",
        "repos/NikolaCehic/Specwright/branches/main",
        "--jq",
        "{name: .name, protected: .protected, commitSha: .commit.sha}"
      ]) as { name: string; protected: boolean; commitSha: string };
      const protection = ghJson([
        "api",
        "repos/NikolaCehic/Specwright/branches/main/protection",
        "--jq",
        "{required_status_checks: .required_status_checks, required_pull_request_reviews: .required_pull_request_reviews, allow_force_pushes: .allow_force_pushes.enabled, allow_deletions: .allow_deletions.enabled}"
      ]) as {
        required_status_checks: { contexts: string[]; strict: boolean };
        required_pull_request_reviews: unknown;
        allow_force_pushes: boolean;
        allow_deletions: boolean;
      };
      const openPrs = ghJson([
        "pr",
        "list",
        "--repo",
        "NikolaCehic/Specwright",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number"
      ]) as Array<{ number: number }>;
      const checkRuns = ghJson([
        "api",
        `repos/NikolaCehic/Specwright/commits/${mainBranch.commitSha}/check-runs`,
        "--jq",
        "{total_count: .total_count}"
      ]) as { total_count: number };

      expect(repository.defaultBranchRef.name).toBe("main");
      expect(repository.visibility).toBe("PUBLIC");
      expect(repository.isPrivate).toBe(false);
      expect(repository.deleteBranchOnMerge).toBe(false);
      expect(repository.mergeCommitAllowed).toBe(true);
      expect(repository.squashMergeAllowed).toBe(true);
      expect(repository.rebaseMergeAllowed).toBe(true);
      expect(mainBranch).toMatchObject({
        name: "main",
        protected: true
      });
      expect(protection.required_status_checks.contexts).toEqual([
        "Policy validation"
      ]);
      expect(protection.required_status_checks.strict).toBe(true);
      expect(protection.required_pull_request_reviews).toBeNull();
      expect(protection.allow_force_pushes).toBe(false);
      expect(protection.allow_deletions).toBe(false);
      expect(openPrs.length).toBeGreaterThanOrEqual(
        repositoryReleaseSnapshot.openPrsBeforeAud016Pr.length
      );
      expect(remoteHeads().length).toBeGreaterThanOrEqual(
        repositoryReleaseSnapshot.remoteHeadCountBeforeAud016Pr
      );
      expect(remoteTags()).toEqual([]);
      expect(checkRuns.total_count).toBe(0);
    });
  } else {
    test.skip("optional live remote verifier checks stay read-only", () => {});
  }
});

function trackedFiles() {
  return commandOutput("git", ["ls-files"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function localGitTags() {
  return commandOutput("git", ["tag", "--list"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function releaseDocumentCandidates() {
  return trackedFiles()
    .filter((file) =>
      /(^|\/)(changelog|changes|release-notes|release_notes|releases)(\.md|\.txt)?$/i
        .test(file)
    )
    .sort((left, right) => left.localeCompare(right));
}

function operationReleaseSourceFiles() {
  return trackedFiles()
    .filter((file) => /^packages\/operations\/src\/release(\.test)?\.ts$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

function remoteHeads() {
  return commandOutput("git", ["ls-remote", "--heads", "origin"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function remoteTags() {
  return commandOutput("git", ["ls-remote", "--tags", "origin"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ghJson(args: string[]) {
  return JSON.parse(commandOutput("gh", args)) as unknown;
}

function commandOutput(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
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

function isReadOnlyVerifierCommand(command: string) {
  return [
    /^gh repo view /,
    /^gh api repos\/NikolaCehic\/Specwright\/(branches|commits)\//,
    /^gh workflow list /,
    /^gh pr list /,
    /^gh issue list /,
    /^gh release list /,
    /^git ls-remote /,
    /^git branch -r/,
    /^git tag --list$/
  ].some((pattern) => pattern.test(command));
}
