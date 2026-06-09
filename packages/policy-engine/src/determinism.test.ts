import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluatePolicy,
  loadPolicyBundles,
  type FixturePolicyBundle,
  type PolicyRequest,
  type PolicyVerdict
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("policy verdict determinism", () => {
  test("reordered keys and undefined fields preserve the full verdict", async () => {
    const canonical = await loadFixture("fs-read-allowed-in-evidence");
    const reshapedRequest = addUndefinedFields(reverseObjectKeys(canonical.request));
    const reshapedPolicyBundle = addUndefinedPolicyBundleFields(
      reverseObjectKeys(canonical.policyBundle)
    );
    const reshapedLoad = loadPolicyBundles(reshapedPolicyBundle);

    expect(canonical.verdict).toEqual(canonical.expected);
    expect(reshapedLoad.ok).toBe(true);
    if (!reshapedLoad.ok) {
      throw new Error("Reshaped policy bundle failed load");
    }

    const reshapedVerdict = evaluatePolicy(
      reshapedRequest as PolicyRequest,
      reshapedLoad.bundles
    );

    expect(reshapedVerdict).toEqual(canonical.verdict);
    expect(reshapedVerdict.decisionHash).toBe(canonical.verdict.decisionHash);
  });

  test("fresh Bun process produces the same full verdict", async () => {
    const fixtureName = "fs-read-allowed-in-evidence";
    const fixtureDir = join(fixturesDir, fixtureName);
    const { verdict } = await loadFixture(fixtureName);
    const engineUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
    const script = `
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { evaluatePolicy, loadPolicyBundles } = await import(${JSON.stringify(engineUrl)});
      const fixtureDir = ${JSON.stringify(fixtureDir)};
      const request = JSON.parse(await readFile(join(fixtureDir, "request.json"), "utf8"));
      const policyBundle = JSON.parse(await readFile(join(fixtureDir, "policy-bundle.json"), "utf8"));
      const loadResult = loadPolicyBundles(policyBundle);
      if (!loadResult.ok) {
        throw new Error("fixture bundle failed load");
      }
      console.log(JSON.stringify(evaluatePolicy(request, loadResult.bundles)));
    `;
    const proc = Bun.spawn(["bun", "--eval", script], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe"
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(verdict);
  });
});

type FixtureInputs = {
  request: PolicyRequest;
  policyBundle: FixturePolicyBundle;
  expected: PolicyVerdict;
  verdict: PolicyVerdict;
};

async function loadFixture(fixtureName: string): Promise<FixtureInputs> {
  const fixtureDir = join(fixturesDir, fixtureName);
  const request = await readJson<PolicyRequest>(join(fixtureDir, "request.json"));
  const policyBundle = await readJson<FixturePolicyBundle>(
    join(fixtureDir, "policy-bundle.json")
  );
  const expected = await readJson<PolicyVerdict>(
    join(fixtureDir, "expected-verdict.json")
  );
  const loadResult = loadPolicyBundles(policyBundle);

  expect(loadResult.ok).toBe(true);
  if (!loadResult.ok) {
    throw new Error(`Fixture ${fixtureName} failed policy bundle load`);
  }

  return {
    request,
    policyBundle,
    expected,
    verdict: evaluatePolicy(request, loadResult.bundles)
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }

  if (isRecord(value)) {
    const reversed: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value).reverse()) {
      reversed[key] = reverseObjectKeys(entry);
    }

    return reversed;
  }

  return value;
}

function addUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(addUndefinedFields);
  }

  if (isRecord(value)) {
    const next: Record<string, unknown> = {
      droppedDuringV1Normalization: undefined
    };

    for (const [key, entry] of Object.entries(value)) {
      next[key] = addUndefinedFields(entry);
    }

    return next;
  }

  return value;
}

function addUndefinedPolicyBundleFields(value: unknown): unknown {
  const bundle = cloneRecord(value);

  bundle.droppedDuringV1Normalization = undefined;

  const toolPolicy = optionalRecord(bundle.toolPolicy);
  const fsReadPolicy = optionalRecord(toolPolicy?.["fs.read"]);
  if (fsReadPolicy !== undefined) {
    fsReadPolicy.droppedDuringV1Normalization = undefined;
  }

  return bundle;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected object value");
  }

  return structuredClone(value) as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
