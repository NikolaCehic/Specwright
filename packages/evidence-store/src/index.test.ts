import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvidence,
  EvidenceStore,
  EvidenceStoreError,
  getEvidenceStorePaths,
  listEvidence,
  readEvidence
} from "./index";
import type { EvidenceRecord } from "@specwright/schemas";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-evidence-store-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("evidence store", () => {
  test("records and reads evidence under the run package", async () => {
    const record = sourceFact("evidence:repo:package-json");

    await appendEvidence({
      rootDir,
      runId: "run-evidence",
      record
    });

    expect(
      await readEvidence({
        rootDir,
        runId: "run-evidence",
        evidenceId: record.id
      })
    ).toEqual(record);

    const paths = getEvidenceStorePaths(rootDir, "run-evidence");
    const rawIndex = await readFile(paths.indexPath, "utf8");

    expect(paths.evidenceDir).toContain(
      ".archetype/runs/run-evidence/evidence"
    );
    expect(rawIndex).toContain(record.id);
  });

  test("records source_fact evidence with source refs", async () => {
    const record = sourceFact("evidence:repo:app-layout");

    const stored = await new EvidenceStore({
      rootDir,
      runId: "run-source-fact"
    }).append(record);

    expect(stored.class).toBe("source_fact");
    expect(stored.sourceRefs).toEqual([
      {
        path: "app/layout.tsx",
        locator: "dependencies.next"
      }
    ]);
    expect(await listEvidence({ rootDir, runId: "run-source-fact" })).toEqual([
      record
    ]);
  });

  test("records assumptions without pretending they are source facts", async () => {
    const record = {
      id: "evidence:assumption:ui-default",
      class: "assumption",
      claim: "Use a compact dashboard layout until the user confirms otherwise.",
      sourceRefs: [],
      confidence: "low",
      authority: "model",
      createdBy: {
        phase: "planning",
        actionId: "assume-layout"
      }
    } satisfies EvidenceRecord;

    const stored = await appendEvidence({
      rootDir,
      runId: "run-assumption",
      record
    });

    expect(stored.class).toBe("assumption");
    expect(stored.sourceRefs).toEqual([]);
    expect(stored.authority).toBe("model");
  });

  test("rejects source facts without source refs", async () => {
    const error = await captureError(() =>
      appendEvidence({
        rootDir,
        runId: "run-reject",
        record: {
          ...sourceFact("evidence:repo:missing"),
          sourceRefs: []
        }
      })
    );

    expect(error).toBeInstanceOf(EvidenceStoreError);
    expect((error as EvidenceStoreError).code).toBe(
      "unsupported_source_fact"
    );
  });
});

function sourceFact(id: string): EvidenceRecord {
  return {
    id,
    class: "source_fact",
    claim: "The repository declares Next.js as a dependency.",
    sourceRefs: [
      {
        path: "app/layout.tsx",
        locator: "dependencies.next"
      }
    ],
    confidence: "high",
    authority: "repo",
    createdBy: {
      phase: "evidence",
      actionId: "read-package-json",
      toolCallId: "tool-call-1"
    }
  };
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
