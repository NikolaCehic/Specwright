import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HASH_ALGO_VERSION,
  hashJson,
  loadPolicyBundles,
  replayPolicyDecision,
  verifyDecisionHash,
  type PolicyDecisionReplayRecord,
  type PolicyReplayDivergenceClass
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("policy decision replay", () => {
  test("faithful recorded decision is equivalent", async () => {
    const { recorded, recordedDecision } = await replayRecord(
      "replay-equivalent-fs-read"
    );
    const result = replayPolicyDecision(recorded);

    expect(result).toEqual(verifyDecisionHash(recorded));
    expect(result.equivalent).toBe(true);
    expect(result.divergenceClass).toBe("equivalent");
    expect(result.status).toBe("allow");
    expect(result.hashAlgoVersion).toBe(HASH_ALGO_VERSION);
    expect(result.storedHash).toBe(recordedDecision.storedDecisionHash);
    expect(result.recomputedHash).toBe(recordedDecision.storedDecisionHash);
    expect(result.requestHash).toBe(recordedDecision.requestHash);
    expect(result.policyBundleHash).toBe(recordedDecision.policyBundleHash);
  });

  test("changed stored hash and input drift are hash mismatches", async () => {
    for (const fixtureName of [
      "replay-changed-stored-hash",
      "replay-input-drift"
    ]) {
      const { recorded, recordedDecision } = await replayRecord(fixtureName);
      const result = replayPolicyDecision(recorded);

      expect(recordedDecision.expectedDivergenceClass).toBe("hash_mismatch");
      expect(result.equivalent).toBe(false);
      expect(result.divergenceClass).toBe("hash_mismatch");
      expect(result.recomputedHash).not.toBe(result.storedHash);
    }
  });

  test("invalid recorded request or bundle is unverifiable", async () => {
    const { recorded } = await replayRecord("replay-equivalent-fs-read");
    const invalidRequest = replayPolicyDecision({
      ...recorded,
      request: {
        requestId: "",
        runId: "run_policy_fixture",
        phase: "evidence",
        action: {
          kind: "tool_call"
        }
      }
    });
    const invalidBundle = replayPolicyDecision({
      ...recorded,
      bundles: {
        id: ""
      }
    });

    expect(invalidRequest.equivalent).toBe(false);
    expect(invalidRequest.divergenceClass).toBe("unverifiable");
    expect(invalidRequest.status).toBe("unverifiable");
    expect(invalidBundle.equivalent).toBe(false);
    expect(invalidBundle.divergenceClass).toBe("unverifiable");
    expect(invalidBundle.status).toBe("unverifiable");
  });

  test("unknown hash version is unreplayable", async () => {
    const { recorded } = await replayRecord("replay-equivalent-fs-read");
    const result = replayPolicyDecision({
      ...recorded,
      hashAlgoVersion: "future"
    });

    expect(result.equivalent).toBe(false);
    expect(result.divergenceClass).toBe("unreplayable");
    expect(result.status).toBe("unreplayable");
    expect(result.recomputedHash).toBeNull();
  });

  test("missing or unpinned bundle input is unreplayable", async () => {
    const equivalent = await replayRecord("replay-equivalent-fs-read");
    const unpinned = await replayRecord("replay-unpinned-bundle");
    const missingBundle = replayPolicyDecision({
      ...equivalent.recorded,
      bundles: undefined
    });
    const unpinnedBundle = replayPolicyDecision(unpinned.recorded);

    expect(missingBundle.equivalent).toBe(false);
    expect(missingBundle.divergenceClass).toBe("unreplayable");
    expect(missingBundle.status).toBe("unreplayable");
    expect(unpinned.recordedDecision.expectedDivergenceClass).toBe(
      "unreplayable"
    );
    expect(unpinnedBundle.equivalent).toBe(false);
    expect(unpinnedBundle.divergenceClass).toBe("unreplayable");
    expect(unpinnedBundle.status).toBe("unreplayable");
  });

  test("recorded request and bundle hashes are real engine hashes", async () => {
    const { request, policyBundle, recordedDecision } = await replayInputs(
      "replay-equivalent-fs-read"
    );
    const loadResult = loadPolicyBundles(policyBundle);

    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) {
      throw new Error("Replay equivalent fixture failed bundle load");
    }

    expect(recordedDecision.requestHash).toBe(hashJson(request));
    expect(recordedDecision.policyBundleHash).toBe(hashJson(loadResult.bundles));
  });
});

type ReplayRecordedDecision = {
  sourceFixture: string;
  hashAlgoVersion?: string;
  requestHash?: string;
  policyBundleHash?: string;
  storedDecisionHash: string;
  expectedDivergenceClass: PolicyReplayDivergenceClass;
};

async function replayRecord(fixtureName: string) {
  const { request, policyBundle, recordedDecision } = await replayInputs(
    fixtureName
  );
  const recorded: PolicyDecisionReplayRecord = {
    request,
    bundles: policyBundle,
    storedDecisionHash: recordedDecision.storedDecisionHash,
    hashAlgoVersion: recordedDecision.hashAlgoVersion,
    requestHash: recordedDecision.requestHash,
    policyBundleHash: recordedDecision.policyBundleHash
  };

  return { recorded, recordedDecision };
}

async function replayInputs(fixtureName: string) {
  const fixtureDir = join(fixturesDir, fixtureName);
  const request = await readJson(join(fixtureDir, "request.json"));
  const policyBundle = await readJson(join(fixtureDir, "policy-bundle.json"));
  const recordedDecision = await readJson<ReplayRecordedDecision>(
    join(fixtureDir, "recorded-decision.json")
  );

  return { request, policyBundle, recordedDecision };
}

async function readJson<TValue = unknown>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
