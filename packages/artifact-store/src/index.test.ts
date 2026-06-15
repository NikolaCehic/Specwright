import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendArtifact,
  ArtifactStore,
  ArtifactStoreError,
  getArtifactStorePaths,
  listArtifacts,
  production_ARTIFACT_FILENAMES,
  readArtifact,
  type ArtifactRecordInput
} from "./index";
import type { ArtifactType } from "@specwright/schemas";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-artifact-store-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("artifact store", () => {
  test("records and reads each production artifact type", async () => {
    const runId = "run-artifacts";
    const stored: string[] = [];

    for (const artifactType of productionArtifactTypes) {
      const artifactId = `artifact-${artifactType}`;
      const content =
        artifactType === "summary"
          ? "# Summary\n\nAll required artifacts were recorded.\n"
          : {
              artifactType,
              ok: true
            };

      const artifact = await appendArtifact({
        rootDir,
        runId,
        record: artifactRecord({
          artifactId,
          artifactType,
          content
        })
      });

      expect(artifact.fileRef?.uri).toBe(
        `artifacts/${production_ARTIFACT_FILENAMES[artifactType]}`
      );
      expect(await readArtifact({ rootDir, runId, artifactId })).toEqual(
        artifact
      );
      stored.push(artifactId);
    }

    expect(
      (await listArtifacts({ rootDir, runId })).map(
        (artifact) => artifact.artifactId
      )
    ).toEqual(stored);
  });

  test("records artifact metadata with evidence refs and producedBy", async () => {
    const producedBy = {
      phase: "planning",
      actionId: "write-plan",
      toolCallId: "tool-call-plan"
    };
    const artifact = await new ArtifactStore({
      rootDir,
      runId: "run-metadata"
    }).append(
      artifactRecord({
        artifactId: "plan-metadata",
        artifactType: "plan",
        content: {
          steps: ["read sources"]
        },
        evidenceRefs: ["evidence:repo:package-json"],
        producedBy,
        metadata: {
          note: "kept"
        }
      })
    );

    expect(artifact.metadata).toMatchObject({
      note: "kept",
      evidenceRefs: ["evidence:repo:package-json"],
      producedBy
    });
  });

  test("rejects unsupported important claims without evidence", async () => {
    const error = await captureError(() =>
      appendArtifact({
        rootDir,
        runId: "run-unsupported-claim",
        record: artifactRecord({
          artifactId: "plan-unsupported-claim",
          artifactType: "plan",
          content: {
            steps: ["invent requirement"]
          },
          evidenceRefs: [],
          claimLevel: "assumption",
          importantClaims: [
            {
              claim: "The app requires dashboard filtering.",
              claimLevel: "source_fact",
              evidenceRefs: [],
              confidence: "high",
              authority: "repo"
            }
          ]
        })
      })
    );

    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe("unsupported_claim");
  });

  test("generated artifact cannot cite itself as evidence", async () => {
    const error = await captureError(() =>
      appendArtifact({
        rootDir,
        runId: "run-self-citation",
        record: artifactRecord({
          artifactId: "self-plan",
          artifactType: "plan",
          content: {
            steps: ["cite self"]
          },
          evidenceRefs: ["artifact:self-plan"],
          claimLevel: "source_fact"
        })
      })
    );

    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe(
      "generated_self_citation"
    );
  });

  test("important claims cannot cite their owning artifact as evidence", async () => {
    const paths = getArtifactStorePaths(rootDir, "run-claim-self-citation");
    const error = await captureError(() =>
      appendArtifact({
        rootDir,
        runId: "run-claim-self-citation",
        record: artifactRecord({
          artifactId: "plan-claim-self",
          artifactType: "plan",
          content: {
            steps: ["cite important claim self"]
          },
          evidenceRefs: ["evidence:repo:package-json"],
          claimLevel: "derived_fact",
          importantClaims: [
            {
              claim: "The plan is proof of its own source facts.",
              claimLevel: "source_fact",
              evidenceRefs: ["artifact:plan-claim-self#importantClaims.0"],
              confidence: "high",
              authority: "repo"
            }
          ]
        })
      })
    );

    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe(
      "generated_self_citation"
    );
    await expect(readFile(paths.indexPath, "utf8")).rejects.toThrow();
  });

  test("source_fact important claims cannot use model authority", async () => {
    const error = await captureError(() =>
      appendArtifact({
        rootDir,
        runId: "run-source-fact-model-authority",
        record: artifactRecord({
          artifactId: "plan-model-authority",
          artifactType: "plan",
          content: {
            steps: ["promote model text"]
          },
          importantClaims: [
            {
              claim: "A model statement is a source fact.",
              claimLevel: "source_fact",
              evidenceRefs: ["evidence:repo:package-json"],
              confidence: "high",
              authority: "model"
            }
          ]
        })
      })
    );

    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe("unsupported_claim");
    expect((error as ArtifactStoreError).message).toBe(
      "source_fact claims cannot use model or generated authority"
    );
  });

  test("unknown important claims can be recorded without evidence refs", async () => {
    const artifact = await appendArtifact({
      rootDir,
      runId: "run-unknown-claim",
      record: artifactRecord({
        artifactId: "plan-unknown-claim",
        artifactType: "plan",
        content: {
          steps: ["record the gap"]
        },
        claimLevel: "assumption",
        importantClaims: [
          {
            claim: "The browser-rendered layout remains unknown.",
            claimLevel: "unknown",
            evidenceRefs: [],
            confidence: "low",
            authority: "model"
          }
        ]
      })
    });

    expect(artifact.importantClaims?.[0]).toMatchObject({
      owningArtifactId: "plan-unknown-claim",
      fieldPath: "importantClaims.0",
      verificationStatus: "unverified",
      redactionPolicy: "operator"
    });
  });

  test("writes canonical content under artifacts", async () => {
    const artifact = await appendArtifact({
      rootDir,
      runId: "run-content",
      record: artifactRecord({
        artifactId: "source-inventory-content",
        artifactType: "source-inventory",
        content: {
          files: ["package.json"]
        }
      })
    });
    const paths = getArtifactStorePaths(rootDir, "run-content");
    const raw = await readFile(
      join(paths.artifactsDir, "source-inventory.json"),
      "utf8"
    );

    expect(artifact.fileRef?.uri).toBe("artifacts/source-inventory.json");
    expect(JSON.parse(raw)).toEqual({
      files: ["package.json"]
    });
  });
});

const productionArtifactTypes = [
  "run-input",
  "source-inventory",
  "evidence-graph",
  "plan",
  "eval-report",
  "summary"
] satisfies ArtifactType[];

function artifactRecord(
  overrides: Partial<ArtifactRecordInput> & {
    artifactId: string;
    artifactType: ArtifactType;
    content: unknown;
  }
): ArtifactRecordInput {
  return {
    artifactId: overrides.artifactId,
    artifactType: overrides.artifactType,
    content: overrides.content,
    evidenceRefs: overrides.evidenceRefs ?? ["evidence:repo:package-json"],
    claimLevel: overrides.claimLevel ?? "source_fact",
    importantClaims: overrides.importantClaims,
    producedBy: overrides.producedBy ?? {
      phase: "planning",
      actionId: "record-artifact"
    },
    metadata: overrides.metadata ?? {}
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
