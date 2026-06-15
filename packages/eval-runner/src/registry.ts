import { createHash } from "node:crypto";
import { z } from "zod";
import { EvalDefinitionSchema, type EvalDefinition } from "@specwright/schemas";
import type { FixtureEvalCheck, FixtureEvalDefinition } from "./index";

export const DEFAULT_HARNESS_PACKAGE_ID = "specwright.default@0.1.0";
export const TEST_FIXTURE_HARNESS_PACKAGE_ID = "specwright.eval-runner.fixtures@0.0.0";

export const DEFAULT_HARNESS_EVAL_DEFINITIONS = [
  {
    id: "artifact_schema_presence",
    sourcePath: "evals/artifact_schema_presence.yaml",
    description: "Ensure the plan artifact exists and exposes required schema fields.",
    type: "deterministic",
    datasetRef: {
      id: "specwright.default.artifact_schema_presence",
      version: "1.0.0",
      path: "packages/eval-runner/fixtures/default-datasets/artifact_schema_presence.json",
      contentId:
        "sha256:896633eb17fd58a9b965f322d233b90f7424be32f0306dd9c02bceb41590521b"
    },
    target: {
      artifactId: "plan"
    },
    artifactSchemas: ["plan"],
    requiredArtifacts: ["plan"],
    blocking: true,
    checks: [
      {
        id: "plan_required_fields",
        type: "schema",
        requiredFields: ["goal", "steps", "claims", "sections"]
      },
      {
        id: "plan_sections_required",
        type: "schema",
        path: "sections",
        requiredFields: ["goal", "evidence", "steps", "risks", "verification"]
      }
    ],
    onFail: {
      action: "create_repair_task"
    }
  },
  {
    id: "source_fidelity",
    sourcePath: "evals/source_fidelity.yaml",
    description: "Verify important plan claims are backed by recorded evidence.",
    type: "source_fidelity",
    datasetRef: {
      id: "specwright.default.source_fidelity",
      version: "1.0.0",
      path: "packages/eval-runner/fixtures/default-datasets/source_fidelity.json",
      contentId:
        "sha256:6961cf3d4ea30e9dfa998d2de6b9a567902a2dd2bde350ff4692d5cf885dd960"
    },
    target: {
      artifactId: "plan"
    },
    artifactSchemas: ["plan", "evidence-graph"],
    requiredArtifacts: ["plan", "evidence-graph"],
    claimsPath: "claims",
    blocking: true,
    checks: [
      {
        id: "important_claims_have_evidence",
        type: "source_fidelity",
        claimsPath: "claims",
        importantClaimLevels: [
          "source_fact",
          "derived_fact",
          "inference",
          "human_decision"
        ]
      }
    ],
    onFail: {
      action: "create_repair_task"
    }
  },
  {
    id: "completeness_required_sections",
    sourcePath: "evals/completeness_required_sections.yaml",
    description: "Ensure the plan includes the minimum reviewable planning sections.",
    type: "completeness",
    datasetRef: {
      id: "specwright.default.completeness_required_sections",
      version: "1.0.0",
      path: "packages/eval-runner/fixtures/default-datasets/completeness_required_sections.json",
      contentId:
        "sha256:05b4d7e14690dabf2351bfcc6f459d8db3e97c2ab2a602dd316b7476c3421e9c"
    },
    target: {
      artifactId: "plan"
    },
    artifactSchemas: ["plan"],
    requiredArtifacts: ["plan"],
    requiredSections: ["goal", "evidence", "steps", "risks", "verification"],
    sectionsPath: "sections",
    blocking: true,
    checks: [
      {
        id: "plan_sections_complete",
        type: "completeness",
        sectionsPath: "sections",
        requiredSections: ["goal", "evidence", "steps", "risks", "verification"]
      }
    ],
    onFail: {
      action: "create_repair_task"
    }
  }
] satisfies FixtureEvalDefinition[];

const Sha256HashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u);

export const EvalDefinitionKindSchema = z.enum([
  "schema",
  "presence",
  "artifact_schema",
  "completeness",
  "source_fidelity",
  "deterministic",
  "model_assisted",
  "model_graded",
  "visual",
  "browser",
  "human_review"
]);

export type EvalDefinitionKind = z.infer<typeof EvalDefinitionKindSchema>;

export const RegisteredEvalDefinitionSchema = z
  .object({
    definitionId: z.string().min(1),
    harnessPackageId: z.string().min(1),
    kind: EvalDefinitionKindSchema,
    contentHash: Sha256HashSchema,
    definition: EvalDefinitionSchema
  })
  .strict();

export type RegisteredEvalDefinition = z.infer<
  typeof RegisteredEvalDefinitionSchema
> & {
  definition: FixtureEvalDefinition;
};

export const EvalRegistryManifestSchema = z
  .object({
    schemaVersion: z.literal("specwright.eval-registry.v1"),
    harnessPackageId: z.string().min(1),
    entries: z.array(RegisteredEvalDefinitionSchema)
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();

    for (const [index, entry] of manifest.entries.entries()) {
      if (entry.harnessPackageId !== manifest.harnessPackageId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "harnessPackageId"],
          message: "entry harnessPackageId must match manifest harnessPackageId"
        });
      }

      if (ids.has(entry.definitionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "definitionId"],
          message: `duplicate eval definition id ${entry.definitionId}`
        });
      }

      ids.add(entry.definitionId);
    }
  });

export type EvalRegistryManifest = z.infer<typeof EvalRegistryManifestSchema> & {
  entries: RegisteredEvalDefinition[];
};

export type EvalDefinitionLintIssue = {
  code:
    | "eval.definition.kind_unknown"
    | "eval.definition.target_unresolvable"
    | "eval.definition.checks_malformed";
  message: string;
};

export type EvalDefinitionResolution =
  | {
      status: "resolved";
      definitionId: string;
      contentHash: string;
      definition: FixtureEvalDefinition;
    }
  | {
      status: "missing";
      definitionId: string;
    }
  | {
      status: "untrusted";
      definitionId: string;
      registeredContentHash: string;
      suppliedContentHash: string;
    };

const KNOWN_CHECK_KINDS = new Set([
  "schema",
  "presence",
  "artifact_schema",
  "completeness",
  "source_fidelity",
  "model_assisted",
  "model_graded",
  "visual",
  "browser",
  "human_review"
]);

export function canonicalizeEvalDefinition(
  definition: EvalDefinition
): string {
  return JSON.stringify(canonicalValue(definition));
}

export function hashEvalDefinition(definition: EvalDefinition): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeEvalDefinition(definition))
    .digest("hex")}`;
}

export function buildEvalRegistry(
  harnessPackageId: string,
  definitions: readonly FixtureEvalDefinition[]
): EvalRegistryManifest {
  const entries = definitions.map((definition) => {
    const issues = lintEvalDefinition(definition);

    if (issues.length > 0) {
      throw new Error(
        `Eval definition ${definition.id} failed registry lint: ${issues
          .map((issue) => issue.message)
          .join("; ")}`
      );
    }

    return {
      definitionId: definition.id,
      harnessPackageId,
      kind: classifyEvalDefinition(definition),
      contentHash: hashEvalDefinition(definition),
      definition
    };
  });

  return EvalRegistryManifestSchema.parse({
    schemaVersion: "specwright.eval-registry.v1",
    harnessPackageId,
    entries
  }) as EvalRegistryManifest;
}

export const DEFAULT_EVAL_REGISTRY = buildEvalRegistry(
  DEFAULT_HARNESS_PACKAGE_ID,
  DEFAULT_HARNESS_EVAL_DEFINITIONS
);

export function lintEvalDefinition(
  definition: FixtureEvalDefinition
): EvalDefinitionLintIssue[] {
  const issues: EvalDefinitionLintIssue[] = [];
  const kind = evalKind(definition);

  if (!isKnownKind(kind)) {
    issues.push({
      code: "eval.definition.kind_unknown",
      message: `unknown eval kind ${kind}`
    });
  }

  if (targetCandidates(definition).length === 0) {
    issues.push({
      code: "eval.definition.target_unresolvable",
      message: "eval definition must declare a resolvable target"
    });
  }

  if (!isUnsupportedEvalKind(kind)) {
    const checks = checksForDefinition(definition, kind);

    if (checks.length === 0) {
      issues.push({
        code: "eval.definition.checks_malformed",
        message: "deterministic eval definition must declare supported checks"
      });
    }

    for (const check of checks) {
      const checkType = normalizedCheckType(check, kind);

      if (!KNOWN_CHECK_KINDS.has(checkType)) {
        issues.push({
          code: "eval.definition.checks_malformed",
          message: `unsupported deterministic check type ${checkType}`
        });
      }

      if (isUnsupportedEvalKind(checkType)) {
        issues.push({
          code: "eval.definition.checks_malformed",
          message: `routed check type ${checkType} is not valid in deterministic eval ${definition.id}`
        });
      }
    }
  }

  return issues;
}

export function resolveFromRegistry(input: {
  registry: EvalRegistryManifest;
  harnessPackageId: string;
  definitionId: string;
  suppliedDefinition?: FixtureEvalDefinition | undefined;
}): EvalDefinitionResolution {
  if (input.registry.harnessPackageId !== input.harnessPackageId) {
    return {
      status: "missing",
      definitionId: input.definitionId
    };
  }

  const registered = input.registry.entries.find(
    (entry) => entry.definitionId === input.definitionId
  );

  if (registered === undefined) {
    return {
      status: "missing",
      definitionId: input.definitionId
    };
  }

  if (input.suppliedDefinition !== undefined) {
    const suppliedContentHash = hashEvalDefinition(input.suppliedDefinition);

    if (
      input.suppliedDefinition.id !== registered.definitionId ||
      suppliedContentHash !== registered.contentHash
    ) {
      return {
        status: "untrusted",
        definitionId: input.definitionId,
        registeredContentHash: registered.contentHash,
        suppliedContentHash
      };
    }
  }

  return {
    status: "resolved",
    definitionId: registered.definitionId,
    contentHash: registered.contentHash,
    definition: registered.definition
  };
}

export function classifyEvalDefinition(
  definition: FixtureEvalDefinition
): EvalDefinitionKind {
  const kind = evalKind(definition);

  if (kind === "deterministic") {
    const checkKinds = uniqueStrings(
      checksForDefinition(definition, kind).map((check) =>
        normalizedCheckType(check, kind)
      )
    );

    if (
      checkKinds.length > 0 &&
      checkKinds.every((checkKind) =>
        ["schema", "presence", "artifact_schema"].includes(checkKind)
      )
    ) {
      return "artifact_schema";
    }

    if (
      checkKinds.length > 0 &&
      checkKinds.every((checkKind) => checkKind === "completeness")
    ) {
      return "completeness";
    }

    if (
      checkKinds.length > 0 &&
      checkKinds.every((checkKind) => checkKind === "source_fidelity")
    ) {
      return "source_fidelity";
    }
  }

  return EvalDefinitionKindSchema.parse(kind);
}

export function checksForDefinition(
  definition: FixtureEvalDefinition,
  kind: string
): FixtureEvalCheck[] {
  const declaredChecks = Array.isArray(definition.checks)
    ? definition.checks.filter(isRecord).map((check, index) =>
        normalizeCheck(check, definition, kind, index)
      )
    : [];

  if (declaredChecks.length > 0) {
    return declaredChecks;
  }

  switch (kind) {
    case "schema":
    case "presence":
    case "artifact_schema":
      return [
        {
          id: `${definition.id}.schema`,
          type: "schema",
          requiredFields: uniqueStrings([
            ...stringArrayFrom(definition.requiredFields),
            ...schemaRequiredFields(definition.schema)
          ]),
          path: stringFrom(definition.path)
        }
      ];
    case "source_fidelity":
      return [
        {
          id: `${definition.id}.source_fidelity`,
          type: "source_fidelity",
          claimsPath: definition.claimsPath
        }
      ];
    case "completeness":
      return [
        {
          id: `${definition.id}.completeness`,
          type: "completeness",
          requiredSections: stringArrayFrom(definition.requiredSections),
          sectionsPath: definition.sectionsPath
        }
      ];
    case "deterministic":
      return [];
    default:
      return [];
  }
}

export function targetCandidates(definition: FixtureEvalDefinition): string[] {
  const target = definition.target;
  const values: string[] = [];

  values.push(...definedStrings([definition.targetRef, definition.artifactId]));

  if (typeof target === "string") {
    values.push(target);
  } else if (isRecord(target)) {
    values.push(
      ...definedStrings([
        stringFrom(target.ref),
        stringFrom(target.id),
        stringFrom(target.artifactId),
        stringFrom(target.artifactType)
      ])
    );
  }

  values.push(...refsFromHarnessReferences(definition.targetArtifacts));
  values.push(...refsFromHarnessReferences(definition.requiredArtifacts));
  values.push(...refsFromHarnessReferences(definition.artifacts));

  return uniqueStrings(values);
}

export function evalKind(definition: FixtureEvalDefinition): string {
  const metadata = isRecord(definition.metadata) ? definition.metadata : undefined;
  const explicit = firstString([
    definition.type,
    definition.evalType,
    definition.kind,
    definition.category,
    metadata?.type,
    metadata?.evalType
  ]);

  if (explicit !== undefined && normalizeKind(explicit) !== "deterministic") {
    return normalizeKind(explicit);
  }

  if (Array.isArray(definition.checks) && definition.checks.length > 0) {
    return "deterministic";
  }

  if (
    stringArrayFrom(definition.requiredFields).length > 0 ||
    schemaRequiredFields(definition.schema).length > 0
  ) {
    return "schema";
  }

  if (
    stringArrayFrom(definition.requiredSections).length > 0 ||
    definition.id.includes("completeness")
  ) {
    return "completeness";
  }

  if (
    definition.claimsPath !== undefined ||
    definition.id.includes("source_fidelity")
  ) {
    return "source_fidelity";
  }

  if (explicit !== undefined) {
    return normalizeKind(explicit);
  }

  return "deterministic";
}

export function isUnsupportedEvalKind(kind: string) {
  return new Set([
    "model_assisted",
    "model_graded",
    "visual",
    "browser",
    "human_review"
  ]).has(kind);
}

export function schemaRequiredFields(schema: unknown): string[] {
  if (!isRecord(schema)) {
    return [];
  }

  return stringArrayFrom(schema.required);
}

function normalizeCheck(
  check: Record<string, unknown>,
  definition: FixtureEvalDefinition,
  kind: string,
  index: number
): FixtureEvalCheck {
  return {
    ...check,
    id: stringFrom(check.id) ?? `${definition.id}.check.${index + 1}`,
    type: stringFrom(check.type) ?? kind
  };
}

function refsFromHarnessReferences(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }

    if (isRecord(item) && typeof item.id === "string") {
      return [item.id];
    }

    return [];
  });
}

function normalizedCheckType(check: FixtureEvalCheck, fallbackKind: string) {
  return normalizeKind(check.type ?? fallbackKind);
}

function isKnownKind(kind: string): kind is EvalDefinitionKind {
  return EvalDefinitionKindSchema.safeParse(kind).success;
}

function normalizeKind(value: string) {
  return value.trim().toLowerCase().replace(/[-. ]+/g, "_");
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort()) {
    const child = value[key];

    if (child !== undefined) {
      output[key] = canonicalValue(child);
    }
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
