import { describe, expect, test } from "bun:test";
import {
  ArtifactClaimSchema,
  ArtifactRecordSchema,
  EvidenceRecordSchema,
  RedactionClassSchema,
  SourceRefSchema,
  claimLevelRequiresEvidence,
  evidenceClassRequiresSourceRefs,
  isRedactionAtLeast,
  isSelfCitingEvidenceRef,
  isTrustedSourceAuthority,
  redactionClassAtLeast,
  redactionClassRank,
  type ArtifactRecord,
  type EvidenceRecord
} from "./index";
import validArtifactRecordFixture from "../test/fixtures/valid-artifact-record.json";
import validSourceFactEvidenceFixture from "../test/fixtures/valid-source-fact-evidence.json";

const validEvidence = validSourceFactEvidenceFixture as EvidenceRecord;
const validArtifact = validArtifactRecordFixture as ArtifactRecord;

describe("artifact and evidence authority contracts", () => {
  test("accepts a source fact with trusted source refs and redaction labels", () => {
    expect(EvidenceRecordSchema.parse(validEvidence)).toEqual(validEvidence);
    expect(SourceRefSchema.safeParse(validEvidence.sourceRefs[0]).success).toBe(
      true
    );
  });

  test("accepts an artifact with owned verified important claims", () => {
    expect(ArtifactRecordSchema.parse(validArtifact)).toEqual(validArtifact);
  });

  test("exports deterministic shared authority and evidence predicates", () => {
    expect(claimLevelRequiresEvidence("source_fact")).toBe(true);
    expect(claimLevelRequiresEvidence("assumption")).toBe(false);
    expect(evidenceClassRequiresSourceRefs("source_fact")).toBe(true);
    expect(evidenceClassRequiresSourceRefs("unknown")).toBe(false);
    expect(isTrustedSourceAuthority("repo")).toBe(true);
    expect(isTrustedSourceAuthority("model")).toBe(false);
    expect(redactionClassRank("model")).toBeLessThan(
      redactionClassRank("secret")
    );
    expect(redactionClassAtLeast("audit", "operator")).toBe(true);
    expect(isRedactionAtLeast("restricted", "audit")).toBe(true);
    expect(
      isSelfCitingEvidenceRef(validArtifact, "artifact:plan#importantClaims.0")
    ).toBe(true);
  });

  test("rejects source fact evidence without source refs", () => {
    expectInvalidEvidence(
      {
        ...validEvidence,
        sourceRefs: []
      },
      "source_fact evidence must include sourceRefs"
    );
  });

  test("rejects model or generated authority for source facts", () => {
    expectInvalidEvidence(
      {
        ...validEvidence,
        authority: "model"
      },
      "source_fact evidence cannot use model or generated authority"
    );
  });

  test("rejects source facts backed only by untrusted source refs", () => {
    expectInvalidEvidence(
      {
        ...validEvidence,
        sourceRefs: [
          {
            id: "model-output",
            locator: "message.0",
            authority: "generated",
            redactionClass: "model"
          }
        ]
      },
      "source_fact evidence sourceRefs must carry trusted authority"
    );
  });

  test("validates unknown and conflict records as first-class evidence", () => {
    const unknownEvidence = {
      ...validEvidence,
      id: "evidence:unknown:browser-layout",
      class: "unknown",
      claim: "The browser-rendered layout has not been inspected.",
      sourceRefs: [],
      confidence: "low",
      authority: "model",
      unknownReason: "No browser inspection was run."
    } satisfies EvidenceRecord;
    const conflictEvidence = {
      ...validEvidence,
      id: "evidence:conflict:route-name",
      class: "conflict",
      claim: "Two source files disagree about the route name.",
      confidence: "medium",
      conflictGroup: "route-name",
      sourceRefs: [
        validEvidence.sourceRefs[0],
        {
          id: "src/routes.ts",
          path: "src/routes.ts",
          locator: "routeName",
          authority: "repo",
          redactionClass: "operator"
        }
      ]
    } satisfies EvidenceRecord;

    expect(EvidenceRecordSchema.parse(unknownEvidence)).toEqual(
      unknownEvidence
    );
    expect(EvidenceRecordSchema.parse(conflictEvidence)).toEqual(
      conflictEvidence
    );
  });

  test("rejects unknown evidence without a question or gap", () => {
    const { unknownReason: _unknownReason, ...withoutReason } = {
      ...validEvidence,
      class: "unknown",
      sourceRefs: [],
      authority: "model"
    };

    expectInvalidEvidence(
      withoutReason,
      "unknown evidence must include unknownReason"
    );
  });

  test("rejects conflict evidence without group and cardinality", () => {
    const { conflictGroup: _conflictGroup, ...withoutGroup } = {
      ...validEvidence,
      class: "conflict",
      sourceRefs: [validEvidence.sourceRefs[0]]
    };

    expectInvalidEvidence(
      withoutGroup,
      "conflict evidence must include conflictGroup"
    );
    expectInvalidEvidence(
      withoutGroup,
      "conflict evidence must include at least two sourceRefs"
    );
  });

  test("rejects unsupported artifact and important claims", () => {
    expectInvalidArtifact(
      {
        ...validArtifact,
        evidenceRefs: []
      },
      "derived_fact artifact claims must include evidenceRefs"
    );
    expectInvalidArtifact(
      {
        ...validArtifact,
        importantClaims: [
          {
            ...validArtifact.importantClaims?.[0],
            evidenceRefs: []
          }
        ]
      },
      "source_fact important claims must include evidenceRefs"
    );
  });

  test("rejects artifact self-citation at record and important-claim refs", () => {
    expectInvalidArtifact(
      {
        ...validArtifact,
        evidenceRefs: ["artifact:plan#content"]
      },
      "Artifact plan cannot cite itself as evidence"
    );
    expectInvalidArtifact(
      {
        ...validArtifact,
        importantClaims: [
          {
            ...validArtifact.importantClaims?.[0],
            evidenceRefs: ["artifact:plan#importantClaims.0"]
          }
        ]
      },
      "Artifact plan cannot cite itself as evidence"
    );
  });

  test("rejects approval-shaped metadata that tries to upgrade source truth", () => {
    expectInvalidArtifact(
      {
        ...validArtifact,
        importantClaims: [
          {
            ...validArtifact.importantClaims?.[0],
            evidenceRefs: [],
            metadata: {
              approvalId: "approval:waive-evidence",
              decision: "approved"
            }
          }
        ]
      },
      "source_fact important claims must include evidenceRefs"
    );
  });

  test("preserves redaction labels and rejects unknown redaction classes", () => {
    expect(RedactionClassSchema.safeParse("restricted").success).toBe(true);
    expect(RedactionClassSchema.safeParse("public").success).toBe(false);
    expect(
      SourceRefSchema.safeParse({
        id: "package.json",
        path: "package.json",
        authority: "repo",
        redactionClass: "public"
      }).success
    ).toBe(false);
  });

  test("fails closed when source-ref authority or redaction is dropped", () => {
    expect(
      SourceRefSchema.safeParse({
        id: "package.json",
        path: "package.json",
        redactionClass: "operator"
      }).success
    ).toBe(false);
    expect(
      SourceRefSchema.safeParse({
        id: "package.json",
        path: "package.json",
        authority: "repo"
      }).success
    ).toBe(false);
  });

  test("contract validation is deterministic for the same invalid record", () => {
    const invalidRecord = {
      ...validEvidence,
      sourceRefs: []
    };
    const first = EvidenceRecordSchema.safeParse(invalidRecord);
    const second = EvidenceRecordSchema.safeParse(invalidRecord);

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    if (!first.success && !second.success) {
      expect(first.error.issues).toEqual(second.error.issues);
    }
  });
});

function expectInvalidEvidence(record: unknown, message: string) {
  const parsed = EvidenceRecordSchema.safeParse(record);

  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.map((issue) => issue.message)).toContain(
      message
    );
  }
}

function expectInvalidArtifact(record: unknown, message: string) {
  const parsed = ArtifactRecordSchema.safeParse(record);

  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.map((issue) => issue.message)).toContain(
      message
    );
  }
}
