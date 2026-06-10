import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertCapabilityCoverage,
  assertJsonEqual,
  baselineEntryFromResult,
  loadConformanceFixtures,
  loadProvenanceBaseline,
  runConformanceGate,
  runConformanceFixture,
  type ProvenanceBaseline
} from "./conformance-runner";

const corpusRoot = resolve(import.meta.dir, "../fixtures/corpus");
const baselinePath = resolve(
  import.meta.dir,
  "../provenance-baseline.json"
);
const workspaceRoot = resolve(import.meta.dir, "../fixtures/workspace");

const shouldBless =
  process.env.SPECWRIGHT_BLESS_BROKER_CONFORMANCE === "1" ||
  process.argv.includes("--bless");

describe("broker conformance gate", () => {
  test("discovers fixtures and enforces golden provenance/status coverage", async () => {
    if (shouldBless) {
      await blessConformanceFixtures({
        corpusRoot,
        baselinePath,
        workspaceRoot
      });
    }

    const report = await runConformanceGate({
      corpusRoot,
      baselinePath,
      workspaceRoot
    });

    expect(report.fixtures).toBeGreaterThanOrEqual(12);
    expect(report.baselineEntries).toBe(report.fixtures);
    expect(report.capabilities).toBe(2);
    expect(report.coverageAssertions).toBe(6);
    expect(report.determinismGroups).toBeGreaterThanOrEqual(1);
    expect(report.repeatedResultHashAssertions).toBeGreaterThanOrEqual(1);
  });

  test("fails on corrupted golden provenance hash", async () => {
    const baseline = await loadProvenanceBaseline(baselinePath);
    const corrupted = cloneBaseline(baseline);
    const entry = corrupted["fs-read-allow"];

    expect(entry).toBeDefined();
    if (entry !== undefined) {
      entry.resultHash = "sha256:corrupted";
    }

    const fixtures = await loadConformanceFixtures(corpusRoot);
    const fixture = fixtures.find((item) => item.name === "fs-read-allow");

    expect(fixture).toBeDefined();
    if (fixture === undefined || fixture.expected === undefined) {
      throw new Error("fs-read-allow fixture is missing.");
    }

    expect(() =>
      assertJsonEqual(
        baselineEntryFromResult(fixture.expected),
        corrupted["fs-read-allow"],
        "corrupted baseline"
      )
    ).toThrow(/corrupted baseline/);
  });

  test("fails on flipped expected status", async () => {
    const fixtures = await loadConformanceFixtures(corpusRoot);
    const fixture = fixtures.find((item) => item.name === "fs-list-allow");

    expect(fixture?.expected?.status).toBe("success");
    if (fixture?.expected !== undefined) {
      const flipped = {
        ...fixture.expected,
        status: "failed"
      };

      expect(() =>
        assertJsonEqual(fixture.expected, flipped, "flipped fixture status")
      ).toThrow(/flipped fixture status/);
    }
  });

  test("fails coverage when a registry capability only has an allow fixture", async () => {
    const fixtures = await loadConformanceFixtures(corpusRoot);
    const fsListAllowOnly = fixtures.filter(
      (fixture) =>
        fixture.metadata.capabilityId !== "fs.list" ||
        fixture.metadata.coverage === "allow"
    );

    expect(() =>
      assertCapabilityCoverage(["fs.list", "fs.read"], fsListAllowOnly)
    ).toThrow(/missing deny conformance coverage/);
  });
});

function cloneBaseline(baseline: ProvenanceBaseline): ProvenanceBaseline {
  return JSON.parse(JSON.stringify(baseline)) as ProvenanceBaseline;
}

async function blessConformanceFixtures(input: {
  corpusRoot: string;
  baselinePath: string;
  workspaceRoot: string;
}) {
  const fixtures = await loadConformanceFixtures(input.corpusRoot, {
    allowMissingExpected: true
  });
  const baseline: ProvenanceBaseline = {};

  for (const fixture of fixtures) {
    const normalized = await runConformanceFixture({
      fixture,
      workspaceRoot: input.workspaceRoot
    });
    await writeJsonFile(resolve(fixture.directory, "expected.json"), normalized);
    baseline[fixture.name] = baselineEntryFromResult(normalized);
  }

  await writeJsonFile(input.baselinePath, sortRecord(baseline));
}

async function writeJsonFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stableJson(value)}\n`, "utf8");
}

function stableJson(value: unknown) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }

  return value;
}

function sortRecord<T>(record: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, T>;
}
