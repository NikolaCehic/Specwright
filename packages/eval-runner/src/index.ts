import {
  EvalVerdictSchema,
  type EvalDefinition,
  type EvalFinding,
  type EvalSeverity,
  type EvalVerdict
} from "@specwright/schemas";
import {
  DEFAULT_EVAL_REGISTRY,
  DEFAULT_HARNESS_PACKAGE_ID,
  buildEvalRegistry,
  checksForDefinition,
  evalKind,
  isUnsupportedEvalKind,
  resolveFromRegistry,
  schemaRequiredFields,
  targetCandidates,
  type EvalRegistryManifest,
  type EvalDefinitionResolution
} from "./registry";

export const DEFAULT_EVAL_RUNNER_EVALUATOR = "specwright.eval-runner.v0";

export type EvalArtifactSnapshot = {
  artifactId?: string;
  id?: string;
  artifactType?: string;
  content?: unknown;
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
} & Record<string, unknown>;

export type EvalEvidenceSnapshot = Record<string, unknown>;

export type EvalRunnerInput = {
  artifacts?:
    | Record<string, EvalArtifactSnapshot>
    | readonly EvalArtifactSnapshot[]
    | undefined;
  evidence?: EvalEvidenceSnapshot | undefined;
};

export type FixtureEvalCheck = {
  id?: string | undefined;
  type?: string | undefined;
  message?: string | undefined;
  severity?: EvalSeverity | undefined;
  targetRef?: string | undefined;
  path?: string | undefined;
  evidenceRefs?: string[] | undefined;
  repairHint?: string | undefined;
  requiredFields?: string[] | undefined;
  required?: string[] | undefined;
  fields?: string[] | undefined;
  requiredSections?: string[] | undefined;
  sections?: string[] | undefined;
  claimsPath?: string | undefined;
  sectionsPath?: string | undefined;
  importantClaimLevels?: string[] | undefined;
} & Record<string, unknown>;

export type FixtureEvalDefinition = EvalDefinition & {
  type?: string;
  kind?: string;
  evalType?: string;
  category?: string;
  target?:
    | string
    | {
        id?: string;
        ref?: string;
        artifactId?: string;
        artifactType?: string;
      };
  targetRef?: string | undefined;
  artifactId?: string | undefined;
  severity?: EvalSeverity | undefined;
  required?: boolean | undefined;
  blocking?: boolean | undefined;
  enabled?: boolean | undefined;
  skip?: boolean | undefined;
  checks?: FixtureEvalCheck[] | undefined;
  requiredFields?: string[] | undefined;
  requiredSections?: string[] | undefined;
  claimsPath?: string | undefined;
  sectionsPath?: string | undefined;
  unsupportedStatus?: EvalVerdict["status"] | undefined;
} & Record<string, unknown>;

export type RunEvalRequest = {
  harnessPackageId?: string | undefined;
  evalRegistry?: EvalRegistryManifest | undefined;
  evalId?: string | undefined;
  evalDefinition?: FixtureEvalDefinition | undefined;
  evalDefinitions?:
    | readonly FixtureEvalDefinition[]
    | Record<string, FixtureEvalDefinition>
    | undefined;
  input?: EvalRunnerInput | undefined;
  evaluatorRef?: string | undefined;
};

export type RunEvalsRequest = Omit<RunEvalRequest, "evalDefinition"> & {
  evalDefinitions?:
    | readonly FixtureEvalDefinition[]
    | Record<string, FixtureEvalDefinition>;
};

type ResolvedArtifact = {
  ref: string;
  artifact: EvalArtifactSnapshot;
  content: unknown;
  evidenceRefs: string[];
};

type CheckEvaluation =
  | {
      status: "pass";
      evidenceRefs: string[];
    }
  | {
      status: "fail";
      finding: EvalFinding;
      evidenceRefs: string[];
    }
  | {
      status: "needs_review";
      finding: EvalFinding;
      evidenceRefs: string[];
    };

export function runEval(request: RunEvalRequest): EvalVerdict {
  const resolution = resolveEvalDefinition(request);
  const definition = resolution.status === "resolved" ? resolution.definition : undefined;
  const evalId = request.evalId ?? request.evalDefinition?.id ?? resolution.definitionId;
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_EVAL_RUNNER_EVALUATOR;

  if (resolution.status === "untrusted") {
    return buildVerdict({
      evalId,
      targetRef: `eval:${evalId}`,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: `Eval definition ${evalId} does not match the governed registry entry`,
          code: "eval.definition.untrusted",
          targetRef: `eval:${evalId}`,
          severity: "blocking",
          repairHint:
            "Use the eval definition signed into the loaded harness package registry.",
          metadata: {
            registeredContentHash: resolution.registeredContentHash,
            suppliedContentHash: resolution.suppliedContentHash
          }
        })
      ],
      evidenceRefs: [],
      evaluatorRef
    });
  }

  if (definition === undefined) {
    return buildVerdict({
      evalId,
      targetRef: `eval:${evalId}`,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: `Eval definition ${evalId} is missing`,
          code: "eval.definition.missing",
          targetRef: `eval:${evalId}`,
          severity: "blocking",
          repairHint: "Provide a declared eval definition before running it."
        })
      ],
      evidenceRefs: [],
      evaluatorRef
    });
  }

  const severity = evalSeverity(definition);
  const target = resolveTargetArtifact(definition, request.input);
  const targetRef = target?.ref ?? targetRefFromDefinition(definition) ?? `eval:${evalId}`;

  if (definition.skip === true || definition.enabled === false) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "skipped",
      severity,
      findings: [],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef
    });
  }

  const kind = evalKind(definition);

  if (isUnsupportedEvalKind(kind)) {
    const status = unsupportedStatus(definition);
    return buildVerdict({
      evalId,
      targetRef,
      status,
      severity,
      findings:
        status === "skipped"
          ? []
          : [
              makeFinding({
                message: `Eval type ${kind} requires capabilities outside the deterministic EvalRunner slice`,
                code: "eval.type.unsupported",
                targetRef,
                severity,
                repairHint:
                  "Route this eval through an explicit ToolBroker-backed or human review path."
              })
            ],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef
    });
  }

  const checks = checksForDefinition(definition, kind);

  if (checks.length === 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: [
        makeFinding({
          message: "Eval definition does not declare deterministic checks",
          code: "eval.checks.missing",
          targetRef,
          severity,
          repairHint:
            "Declare schema, source_fidelity, or completeness checks for deterministic execution."
        })
      ],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef
    });
  }

  const evaluations = checks.map((check) =>
    evaluateCheck(check, definition, target, request.input, severity)
  );
  const failed = evaluations.filter(
    (evaluation): evaluation is Extract<CheckEvaluation, { status: "fail" }> =>
      evaluation.status === "fail"
  );
  const needsReview = evaluations.filter(
    (
      evaluation
    ): evaluation is Extract<CheckEvaluation, { status: "needs_review" }> =>
      evaluation.status === "needs_review"
  );
  const evidenceRefs = uniqueStrings([
    ...(target?.evidenceRefs ?? []),
    ...evaluations.flatMap((evaluation) => evaluation.evidenceRefs)
  ]);

  if (failed.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "fail",
      severity,
      findings: failed.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef
    });
  }

  if (needsReview.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: needsReview.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef
    });
  }

  return buildVerdict({
    evalId,
    targetRef,
    status: "pass",
    severity,
    findings: [],
    evidenceRefs,
    evaluatorRef
  });
}

export function runEvals(request: RunEvalsRequest): EvalVerdict[] {
  const registry = registryForRequest(request);
  const definitions = registry.entries.map((entry) => entry.definition);

  return definitions.map((definition) =>
    runEval({
      evalDefinition: definition,
      evalDefinitions: definitions,
      evalRegistry: registry,
      harnessPackageId: registry.harnessPackageId,
      input: request.input,
      evaluatorRef: request.evaluatorRef
    })
  );
}

function evaluateCheck(
  check: FixtureEvalCheck,
  definition: FixtureEvalDefinition,
  target: ResolvedArtifact | undefined,
  input: EvalRunnerInput | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  const type = normalizeKind(check.type ?? evalKind(definition));

  switch (type) {
    case "schema":
    case "presence":
    case "artifact_schema":
      return evaluateSchemaPresenceCheck(check, target, severity);
    case "source_fidelity":
      return evaluateSourceFidelityCheck(check, target, input, severity);
    case "completeness":
      return evaluateCompletenessCheck(check, target, severity);
    case "model_assisted":
    case "model_graded":
    case "visual":
    case "browser":
    case "human_review":
      return needsReviewForCheck(
        check,
        target,
        severity,
        `Eval check type ${type} is not supported by the deterministic EvalRunner slice`
      );
    default:
      return needsReviewForCheck(
        check,
        target,
        severity,
        `Eval check type ${type} is not supported`
      );
  }
}

function evaluateSchemaPresenceCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  if (target === undefined) {
    return missingTargetEvaluation(check, severity);
  }

  const requiredFields = uniqueStrings([
    ...stringArrayFrom(check.requiredFields),
    ...stringArrayFrom(check.required),
    ...stringArrayFrom(check.fields),
    ...schemaRequiredFields(check.schema)
  ]);
  const scopes = scopedValues(target.content, check.path);
  const missingFields = requiredFields.filter((field) =>
    scopes.length === 0
      ? true
      : scopes.some((scope) => !fieldPresent(scope, field))
  );

  if (missingFields.length > 0) {
    return {
      status: "fail",
      finding: makeFinding({
        message: `Artifact is missing required fields: ${missingFields.join(", ")}`,
        code: "artifact.required_fields.missing",
        targetRef: check.targetRef ?? target.ref,
        path: check.path,
        severity: check.severity ?? severity,
        evidenceRefs: check.evidenceRefs,
        repairHint:
          check.repairHint ??
          "Add the required fields or adjust the artifact schema."
      }),
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  return {
    status: "pass",
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function evaluateSourceFidelityCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  input: EvalRunnerInput | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  if (target === undefined) {
    return missingTargetEvaluation(check, severity);
  }

  const claimsPath = check.claimsPath ?? check.path ?? "claims";
  const claimValues = scopedValues(target.content, claimsPath).flatMap((value) =>
    Array.isArray(value) ? value : [value]
  );
  const claims = claimValues.filter(isRecord);

  if (claims.length === 0) {
    return {
      status: "fail",
      finding: makeFinding({
        message: "Source fidelity eval found no structured claims",
        code: "claims.missing",
        targetRef: check.targetRef ?? target.ref,
        path: normalizeDisplayPath(claimsPath),
        severity: check.severity ?? severity,
        evidenceRefs: check.evidenceRefs,
        repairHint:
          check.repairHint ??
          "Add structured claims with claim level and evidenceRefs."
      }),
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  const importantLevels = importantClaimLevels(check);
  const findings: EvalFinding[] = [];
  const evidenceRefs: string[] = [...(check.evidenceRefs ?? [])];

  claims.forEach((claim, index) => {
    if (!isImportantClaim(claim, importantLevels)) {
      return;
    }

    const refs = evidenceRefsForValue(claim);
    evidenceRefs.push(...refs);
    const path = `${normalizeDisplayPath(claimsPath)}[${index}]`;

    if (refs.length === 0) {
      findings.push(
        makeFinding({
          message: `Important claim ${claimLabel(claim, index)} lacks evidenceRefs`,
          code: "claim.evidence_refs.missing",
          targetRef: check.targetRef ?? target.ref,
          path,
          severity: check.severity ?? severity,
          repairHint:
            check.repairHint ??
            "Attach evidenceRefs or lower the claim to an assumption/unknown."
        })
      );
      return;
    }

    if (input?.evidence === undefined) {
      return;
    }

    const missingRefs = refs.filter((ref) => !hasEvidenceRef(input.evidence, ref));

    if (missingRefs.length > 0) {
      findings.push(
        makeFinding({
          message: `Important claim ${claimLabel(
            claim,
            index
          )} references missing evidence: ${missingRefs.join(", ")}`,
          code: "claim.evidence.missing",
          targetRef: check.targetRef ?? target.ref,
          path,
          severity: check.severity ?? severity,
          evidenceRefs: refs,
          repairHint:
            check.repairHint ??
            "Record the referenced evidence or replace the claim evidenceRefs."
        })
      );
    }
  });

  if (findings.length > 0) {
    return {
      status: "fail",
      finding: mergeFindings(findings, {
        message: `${findings.length} important claim(s) lack required evidence`,
        code: "source_fidelity.failed",
        targetRef: check.targetRef ?? target.ref,
        path: normalizeDisplayPath(claimsPath),
        severity: check.severity ?? severity
      }),
      evidenceRefs: uniqueStrings(evidenceRefs)
    };
  }

  return {
    status: "pass",
    evidenceRefs: uniqueStrings(evidenceRefs)
  };
}

function evaluateCompletenessCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  if (target === undefined) {
    return missingTargetEvaluation(check, severity);
  }

  const requiredSections = uniqueStrings([
    ...stringArrayFrom(check.requiredSections),
    ...stringArrayFrom(check.sections)
  ]);
  const sectionsPath = check.sectionsPath ?? check.path ?? "sections";
  const sectionScopes = scopedValues(target.content, sectionsPath);
  const missingSections = requiredSections.filter(
    (section) => !sectionPresent(target.content, sectionScopes, section)
  );

  if (missingSections.length > 0) {
    return {
      status: "fail",
      finding: makeFinding({
        message: `Artifact is missing required sections: ${missingSections.join(", ")}`,
        code: "artifact.sections.missing",
        targetRef: check.targetRef ?? target.ref,
        path: normalizeDisplayPath(sectionsPath),
        severity: check.severity ?? severity,
        evidenceRefs: check.evidenceRefs,
        repairHint:
          check.repairHint ??
          "Add the missing sections before this artifact can pass completeness."
      }),
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  return {
    status: "pass",
    evidenceRefs: check.evidenceRefs ?? []
  };
}

export function resolveEvalDefinition(
  request: RunEvalRequest
): EvalDefinitionResolution {
  const definitionId =
    request.evalId ?? request.evalDefinition?.id ?? "unknown_eval";
  const registry = registryForRequest(request);

  return resolveFromRegistry({
    registry,
    harnessPackageId: request.harnessPackageId ?? registry.harnessPackageId,
    definitionId,
    suppliedDefinition: request.evalDefinition
  });
}

function registryForRequest(request: RunEvalRequest): EvalRegistryManifest {
  if (request.evalRegistry !== undefined) {
    return request.evalRegistry;
  }

  const harnessPackageId = request.harnessPackageId ?? DEFAULT_HARNESS_PACKAGE_ID;

  if (harnessPackageId === DEFAULT_EVAL_REGISTRY.harnessPackageId) {
    return DEFAULT_EVAL_REGISTRY;
  }

  return buildEvalRegistry(harnessPackageId, []);
}

function resolveTargetArtifact(
  definition: FixtureEvalDefinition,
  input: EvalRunnerInput | undefined
): ResolvedArtifact | undefined {
  const entries = artifactEntries(input?.artifacts);

  if (entries.length === 0) {
    return undefined;
  }

  const candidates = targetCandidates(definition);

  for (const candidate of candidates) {
    const normalized = normalizeTargetId(candidate);
    const matched = entries.find(([key, artifact]) =>
      artifactMatchesCandidate(key, artifact, normalized)
    );

    if (matched !== undefined) {
      const [key, artifact] = matched;
      return resolvedArtifact(key, artifact);
    }
  }

  if (candidates.length === 0 && entries.length === 1) {
    const [key, artifact] = entries[0] as [string, EvalArtifactSnapshot];
    return resolvedArtifact(key, artifact);
  }

  return undefined;
}

function artifactEntries(
  artifacts:
    | Record<string, EvalArtifactSnapshot>
    | readonly EvalArtifactSnapshot[]
    | undefined
): Array<[string, EvalArtifactSnapshot]> {
  if (artifacts === undefined) {
    return [];
  }

  if (Array.isArray(artifacts)) {
    return artifacts.map((artifact, index) => [
      artifact.artifactId ?? artifact.id ?? String(index),
      artifact
    ]);
  }

  return Object.entries(artifacts).filter(
    (entry): entry is [string, EvalArtifactSnapshot] => isRecord(entry[1])
  );
}

function resolvedArtifact(
  key: string,
  artifact: EvalArtifactSnapshot
): ResolvedArtifact {
  return {
    ref: targetRefForArtifact(key, artifact),
    artifact,
    content: artifact.content ?? artifact,
    evidenceRefs: stringArrayFrom(artifact.evidenceRefs)
  };
}

function artifactMatchesCandidate(
  key: string,
  artifact: EvalArtifactSnapshot,
  candidate: string
) {
  return [
    key,
    artifact.id,
    artifact.artifactId,
    artifact.artifactType,
    targetRefForArtifact(key, artifact)
  ]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeTargetId)
    .includes(candidate);
}

function targetRefFromDefinition(
  definition: FixtureEvalDefinition
): string | undefined {
  const candidates = targetCandidates(definition);
  const first = candidates[0];

  if (first === undefined) {
    return undefined;
  }

  return first.startsWith("artifact:") || first.startsWith("eval:")
    ? first
    : `artifact:${first}`;
}

function targetRefForArtifact(key: string, artifact: EvalArtifactSnapshot) {
  const id = artifact.artifactId ?? artifact.id ?? key;

  return id.startsWith("artifact:") ? id : `artifact:${id}`;
}

function unsupportedStatus(definition: FixtureEvalDefinition): EvalVerdict["status"] {
  return definition.unsupportedStatus === "fail" ||
    definition.unsupportedStatus === "skipped" ||
    definition.unsupportedStatus === "needs_review"
    ? definition.unsupportedStatus
    : "needs_review";
}

function evalSeverity(definition: FixtureEvalDefinition): EvalSeverity {
  if (definition.severity === "advisory" || definition.severity === "blocking") {
    return definition.severity;
  }

  return definition.blocking === false || definition.required === false
    ? "advisory"
    : "blocking";
}

function missingTargetEvaluation(
  check: FixtureEvalCheck,
  severity: EvalSeverity
): CheckEvaluation {
  return {
    status: "fail",
    finding: makeFinding({
      message: "Eval target artifact is missing",
      code: "eval.target.missing",
      targetRef: check.targetRef,
      severity: check.severity ?? severity,
      evidenceRefs: check.evidenceRefs,
      repairHint:
        check.repairHint ??
        "Provide the target artifact declared by this eval definition."
    }),
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function needsReviewForCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  severity: EvalSeverity,
  message: string
): CheckEvaluation {
  return {
    status: "needs_review",
    finding: makeFinding({
      message,
      code: "eval.check.unsupported",
      targetRef: check.targetRef ?? target?.ref,
      severity: check.severity ?? severity,
      evidenceRefs: check.evidenceRefs,
      repairHint:
        check.repairHint ??
        "Use a supported deterministic check or route this eval to review."
    }),
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function buildVerdict(input: {
  evalId: string;
  targetRef: string;
  status: EvalVerdict["status"];
  severity: EvalSeverity;
  findings: EvalFinding[];
  evidenceRefs: string[];
  evaluatorRef: string;
}): EvalVerdict {
  return EvalVerdictSchema.parse({
    evalId: input.evalId,
    targetRef: input.targetRef,
    status: input.status,
    severity: input.severity,
    findings: input.findings,
    evidenceRefs: uniqueStrings(input.evidenceRefs),
    producedBy: {
      kind: "deterministic",
      ref: input.evaluatorRef
    }
  });
}

function makeFinding(input: {
  message: string;
  code?: string | undefined;
  targetRef?: string | undefined;
  path?: string | undefined;
  severity?: EvalSeverity | undefined;
  evidenceRefs?: string[] | undefined;
  repairHint?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): EvalFinding {
  const finding: EvalFinding = {
    message: input.message
  };

  if (input.code !== undefined) {
    finding.code = input.code;
  }

  if (input.targetRef !== undefined) {
    finding.targetRef = input.targetRef;
  }

  if (input.path !== undefined) {
    finding.path = input.path;
  }

  if (input.severity !== undefined) {
    finding.severity = input.severity;
  }

  if (input.evidenceRefs !== undefined) {
    const evidenceRefs = uniqueStrings(input.evidenceRefs);

    if (evidenceRefs.length > 0) {
      finding.evidenceRefs = evidenceRefs;
    }
  }

  if (input.repairHint !== undefined) {
    finding.repairHint = input.repairHint;
  }

  if (input.metadata !== undefined) {
    finding.metadata = input.metadata;
  }

  return finding;
}

function mergeFindings(
  findings: readonly EvalFinding[],
  summary: {
    message: string;
    code: string;
    targetRef: string;
    path: string;
    severity: EvalSeverity;
  }
): EvalFinding {
  return makeFinding({
    ...summary,
    evidenceRefs: uniqueStrings(
      findings.flatMap((finding) => finding.evidenceRefs ?? [])
    ),
    metadata: {
      findings
    }
  });
}

function scopedValues(root: unknown, path: string | undefined): unknown[] {
  if (path === undefined || path.length === 0) {
    return [root];
  }

  return readPathValues(root, normalizeJsonPath(path));
}

function readPathValues(root: unknown, path: string): unknown[] {
  if (path === "$") {
    return [root];
  }

  if (!path.startsWith("$.")) {
    return [];
  }

  const segments = path.slice(2).split(".");

  return segments.reduce<unknown[]>((currentValues, segment) => {
    const wildcard = segment.endsWith("[*]");
    const key = wildcard ? segment.slice(0, -3) : segment;
    const nextValues: unknown[] = [];

    for (const value of currentValues) {
      if (!isRecord(value)) {
        continue;
      }

      const child = value[key];

      if (wildcard) {
        if (Array.isArray(child)) {
          nextValues.push(...child);
        }
      } else {
        nextValues.push(child);
      }
    }

    return nextValues;
  }, [root]);
}

function fieldPresent(target: unknown, field: string): boolean {
  const values = field.includes(".")
    ? readPathValues(target, normalizeJsonPath(field))
    : isRecord(target)
      ? [target[field]]
      : [];

  return values.length > 0 && values.every(isPresent);
}

function sectionPresent(
  root: unknown,
  sectionScopes: readonly unknown[],
  section: string
): boolean {
  for (const scope of sectionScopes) {
    if (sectionPresentInValue(scope, section)) {
      return true;
    }
  }

  return fieldPresent(root, section);
}

function sectionPresentInValue(value: unknown, section: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => sectionPresentInValue(item, section));
  }

  if (typeof value === "string") {
    return value === section;
  }

  if (!isRecord(value)) {
    return false;
  }

  if (fieldPresent(value, section)) {
    return true;
  }

  return ["id", "key", "name", "title", "heading"].some(
    (field) => value[field] === section && isPresent(value)
  );
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function isImportantClaim(
  claim: Record<string, unknown>,
  importantLevels: readonly string[]
) {
  if (
    claim.important === true ||
    claim.required === true ||
    claim.requiresEvidence === true ||
    claim.importance === "important"
  ) {
    return true;
  }

  const level = firstString([
    claim.level,
    claim.kind,
    claim.class,
    claim.claimLevel
  ]);

  return level !== undefined && importantLevels.includes(normalizeKind(level));
}

function importantClaimLevels(check: FixtureEvalCheck): string[] {
  const configured = stringArrayFrom(check.importantClaimLevels).map(normalizeKind);

  if (configured.length > 0) {
    return configured;
  }

  return ["source_fact", "derived_fact", "inference", "human_decision"];
}

function claimLabel(claim: Record<string, unknown>, index: number) {
  return (
    firstString([claim.id, claim.claim, claim.text, claim.statement]) ??
    `#${index + 1}`
  );
}

function evidenceRefsForValue(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return uniqueStrings([
    ...stringArrayFrom(value.evidenceRefs),
    ...stringArrayFrom(value.evidence)
  ]);
}

function hasEvidenceRef(
  evidence: EvalEvidenceSnapshot | undefined,
  ref: string
) {
  if (evidence === undefined) {
    return true;
  }

  return collectEvidenceRefs(evidence).has(ref);
}

function collectEvidenceRefs(value: unknown, depth = 0): Set<string> {
  const refs = new Set<string>();

  if (depth > 6) {
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectEvidenceRefs(item, depth + 1)) {
        refs.add(ref);
      }
    }

    return refs;
  }

  if (!isRecord(value)) {
    return refs;
  }

  for (const key of ["id", "ref", "evidenceRef"]) {
    const ref = value[key];

    if (typeof ref === "string" && ref.length > 0) {
      refs.add(ref);
    }
  }

  for (const ref of stringArrayFrom(value.evidenceRefs)) {
    refs.add(ref);
  }

  const rawRefs = value.refs;

  if (isRecord(rawRefs)) {
    for (const ref of Object.keys(rawRefs)) {
      refs.add(ref);
    }
  } else {
    for (const ref of stringArrayFrom(rawRefs)) {
      refs.add(ref);
    }
  }

  for (const key of ["items", "records", "sources"]) {
    for (const ref of collectEvidenceRefs(value[key], depth + 1)) {
      refs.add(ref);
    }
  }

  return refs;
}

function normalizeJsonPath(path: string) {
  if (path === "$" || path.startsWith("$.")) {
    return path;
  }

  return `$.${path}`;
}

function normalizeDisplayPath(path: string) {
  return normalizeJsonPath(path);
}

function normalizeKind(value: string) {
  return value.trim().toLowerCase().replace(/[-. ]+/g, "_");
}

function normalizeTargetId(value: string) {
  return value.startsWith("artifact:") ? value.slice("artifact:".length) : value;
}

function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function definedStrings(values: readonly unknown[]): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function firstString(values: readonly unknown[]): string | undefined {
  return definedStrings(values)[0];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
