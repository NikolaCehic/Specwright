import { readFile } from "node:fs/promises";
import type {
  HarnessManifest,
  PolicyBundle,
  ToolDefinition
} from "@specwright/schemas";
import { z } from "zod";

const nonEmptyString = z.string().min(1);

const PolicyEffectGrantSchema = z.enum([
  "allow",
  "deny",
  "approval_required",
  "constrain",
  "obligate"
]);

const PolicyLayerGrantSchema = z.enum([
  "runtime_invariant",
  "host",
  "workspace",
  "harness",
  "phase",
  "capability",
  "run_mode",
  "approval"
]);

const VersionRangeSchema = nonEmptyString.refine(
  isSupportedVersionRange,
  "Unsupported capability grant versionRange"
);

export const CapabilityGrantIssuerSchema = z
  .object({
    registryId: nonEmptyString,
    authorityId: nonEmptyString
  })
  .strict();

export const CapabilityGrantSchema = z
  .object({
    grantId: nonEmptyString,
    packageId: nonEmptyString,
    versionRange: VersionRangeSchema.optional(),
    versionPins: z.array(nonEmptyString).optional(),
    allowedTools: z.array(nonEmptyString),
    allowedRequireApproval: z.array(nonEmptyString),
    allowedToolDefinitions: z.array(nonEmptyString),
    allowedPolicyEffects: z.array(PolicyEffectGrantSchema),
    allowedPolicyLayers: z.array(PolicyLayerGrantSchema),
    allowedRuntimeInvariantToolIds: z.array(nonEmptyString),
    issuer: CapabilityGrantIssuerSchema
  })
  .strict()
  .refine(
    (grant) =>
      grant.versionRange !== undefined ||
      (grant.versionPins !== undefined && grant.versionPins.length > 0),
    "Capability grant must declare versionRange or versionPins"
  );

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type CapabilityGrantIssuer = z.infer<typeof CapabilityGrantIssuerSchema>;

export const CapabilityGrantRegistrySchema = z
  .object({
    registryId: nonEmptyString,
    grants: z.array(CapabilityGrantSchema)
  })
  .strict();

export type CapabilityGrantRegistry = z.infer<
  typeof CapabilityGrantRegistrySchema
>;

export type GrantSource = {
  resolveGrant(
    packageId: string,
    version: string
  ): CapabilityGrant | undefined | Promise<CapabilityGrant | undefined>;
};

export type RequestedCapabilitySurface = {
  tools: string[];
  requireApproval: string[];
  toolDefinitions: string[];
  policyEffects: string[];
  policyLayers: string[];
  runtimeInvariantToolIds: string[];
};

export type CapabilityGrantSummary = {
  grantId: string;
  packageId: string;
  versionRange?: string;
  versionPins?: string[];
  issuer: CapabilityGrantIssuer;
};

export type GrantDenialReason =
  | "missing_grant"
  | "malformed_grant"
  | "grant_resolution_error"
  | "grant_not_applicable"
  | "capability_outside_grant";

export type GrantEvaluation = {
  granted: boolean;
  requested: RequestedCapabilitySurface;
  grant: CapabilityGrantSummary | undefined;
  grantedCapabilities: RequestedCapabilitySurface;
  overGrant: RequestedCapabilitySurface;
  deniedCapabilities: string[];
  denialReason: GrantDenialReason | undefined;
};

const CapabilitySurfaceSchema = z
  .object({
    tools: z.array(nonEmptyString),
    requireApproval: z.array(nonEmptyString),
    toolDefinitions: z.array(nonEmptyString),
    policyEffects: z.array(nonEmptyString),
    policyLayers: z.array(nonEmptyString),
    runtimeInvariantToolIds: z.array(nonEmptyString)
  })
  .strict();

const CapabilityGrantSummarySchema = z
  .object({
    grantId: nonEmptyString,
    packageId: nonEmptyString,
    versionRange: nonEmptyString.optional(),
    versionPins: z.array(nonEmptyString).optional(),
    issuer: CapabilityGrantIssuerSchema
  })
  .strict();

const GrantDenialReasonSchema = z.enum([
  "missing_grant",
  "malformed_grant",
  "grant_resolution_error",
  "grant_not_applicable",
  "capability_outside_grant"
]);

export const HarnessGrantEvaluatedEventSchema = z
  .object({
    type: z.literal("harness.grant.evaluated"),
    payload: z
      .object({
        packageId: nonEmptyString,
        version: nonEmptyString,
        verdict: z.enum(["allowed", "denied"]),
        requested: CapabilitySurfaceSchema,
        granted: CapabilitySurfaceSchema,
        overGrant: CapabilitySurfaceSchema,
        grant: CapabilityGrantSummarySchema.optional(),
        deniedCapabilities: z.array(nonEmptyString),
        denialReason: GrantDenialReasonSchema.optional(),
        failClosed: z.literal(true).optional()
      })
      .strict()
  })
  .strict();

export type HarnessGrantEvent = z.infer<typeof HarnessGrantEvaluatedEventSchema>;

type PlainRecord = Record<string, unknown>;

const RawCapabilityGrantRecordSchema = z
  .object({
    packageId: nonEmptyString,
    grantId: nonEmptyString.optional()
  })
  .passthrough();

const RawCapabilityGrantRegistrySchema = z
  .object({
    registryId: nonEmptyString,
    grants: z.array(RawCapabilityGrantRecordSchema)
  })
  .strict();

export class CapabilityGrantResolutionError extends Error {
  readonly reason: Exclude<GrantDenialReason, "capability_outside_grant">;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    reason: Exclude<GrantDenialReason, "capability_outside_grant">,
    message: string,
    context: {
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "CapabilityGrantResolutionError";
    this.reason = reason;
    this.details = context.details;

    if (context.cause !== undefined) {
      Object.assign(this, { cause: context.cause });
    }
  }
}

export class RegistryGrantSource implements GrantSource {
  readonly registryId: string;
  private readonly grantsByPackageId = new Map<string, PlainRecord[]>();

  constructor(input: unknown) {
    const parsed = RawCapabilityGrantRegistrySchema.safeParse(input);

    if (!parsed.success) {
      throw new CapabilityGrantResolutionError(
        "malformed_grant",
        `Capability grant registry index is invalid: ${parsed.error.message}`,
        {
          details: {
            schema: "RawCapabilityGrantRegistrySchema"
          },
          cause: parsed.error
        }
      );
    }

    this.registryId = parsed.data.registryId;

    for (const grant of parsed.data.grants) {
      const packageGrants = this.grantsByPackageId.get(grant.packageId) ?? [];
      packageGrants.push(grant);
      packageGrants.sort((left, right) =>
        stringValue(left.grantId)?.localeCompare(
          stringValue(right.grantId) ?? ""
        ) ?? 0
      );
      this.grantsByPackageId.set(grant.packageId, packageGrants);
    }
  }

  resolveGrant(packageId: string, version: string) {
    for (const grantRecord of this.grantsByPackageId.get(packageId) ?? []) {
      const grant = parseCapabilityGrant(grantRecord);

      if (grantAuthorizesVersion(grant, version)) {
        return CapabilityGrantSchema.parse(grant);
      }
    }

    return undefined;
  }
}

export async function loadCapabilityGrantRegistryFromFile(path: string) {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CapabilityGrantResolutionError(
      "malformed_grant",
      `Could not read capability grant registry ${path}`,
      {
        details: {
          path
        },
        cause: error
      }
    );
  }

  return new RegistryGrantSource(parsedJson);
}

export function parseCapabilityGrant(input: unknown): CapabilityGrant {
  const parsed = CapabilityGrantSchema.safeParse(input);

  if (!parsed.success) {
    throw new CapabilityGrantResolutionError(
      "malformed_grant",
      `Capability grant is invalid: ${parsed.error.message}`,
      {
        details: {
          schema: "CapabilityGrantSchema"
        },
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

export function grantAuthorizesVersion(
  grant: CapabilityGrant,
  version: string
) {
  return (
    (grant.versionPins ?? []).includes(version) ||
    (grant.versionRange !== undefined &&
      versionSatisfiesRange(version, grant.versionRange))
  );
}

export function extractRequestedSurface(input: {
  manifest: HarnessManifest;
  policies: readonly PolicyBundle[];
  tools: readonly ToolDefinition[];
}): RequestedCapabilitySurface {
  const tools = manifestToolReferences(input.manifest);
  const requireApproval = manifestRequireApprovalReferences(input.manifest);
  const toolDefinitions = input.tools.map((tool) => tool.id);
  const policyEffects: string[] = [];
  const policyLayers: string[] = [];
  const runtimeInvariantToolIds: string[] = [];

  for (const policy of input.policies) {
    for (const rule of policyRuleRecords(policy)) {
      const effect = stringValue(rule.effect);
      const layer = stringValue(rule.layer);

      if (effect !== undefined) {
        policyEffects.push(effect);
      }

      if (layer !== undefined) {
        policyLayers.push(layer);
      }
    }

    for (const invariant of runtimeInvariantRecords(policy)) {
      const effect = stringValue(invariant.effect);
      const layer = stringValue(invariant.layer);

      if (effect !== undefined) {
        policyEffects.push(effect);
      }

      if (layer !== undefined) {
        policyLayers.push(layer);
      }

      runtimeInvariantToolIds.push(...runtimeInvariantToolReferences(invariant));
    }
  }

  return normalizeSurface({
    tools,
    requireApproval,
    toolDefinitions,
    policyEffects,
    policyLayers,
    runtimeInvariantToolIds
  });
}

export function evaluateGrant(
  requested: RequestedCapabilitySurface,
  grant: CapabilityGrant
): GrantEvaluation {
  const normalizedRequested = normalizeSurface(requested);
  const grantedCapabilities = capabilitySurfaceFromGrant(grant);
  const overGrant = normalizeSurface({
    tools: difference(normalizedRequested.tools, grantedCapabilities.tools),
    requireApproval: difference(
      normalizedRequested.requireApproval,
      grantedCapabilities.requireApproval
    ),
    toolDefinitions: difference(
      normalizedRequested.toolDefinitions,
      grantedCapabilities.toolDefinitions
    ),
    policyEffects: difference(
      normalizedRequested.policyEffects,
      grantedCapabilities.policyEffects
    ),
    policyLayers: difference(
      normalizedRequested.policyLayers,
      grantedCapabilities.policyLayers
    ),
    runtimeInvariantToolIds: difference(
      normalizedRequested.runtimeInvariantToolIds,
      grantedCapabilities.runtimeInvariantToolIds
    )
  });
  const deniedCapabilities = deniedCapabilityNames(overGrant);

  return {
    granted: deniedCapabilities.length === 0,
    requested: normalizedRequested,
    grant: summarizeGrant(grant),
    grantedCapabilities,
    overGrant,
    deniedCapabilities,
    denialReason:
      deniedCapabilities.length === 0 ? undefined : "capability_outside_grant"
  };
}

export function buildGrantDeniedEvaluation(input: {
  requested: RequestedCapabilitySurface;
  grant?: CapabilityGrant;
  reason: GrantDenialReason;
  deniedCapabilities?: readonly string[];
}): GrantEvaluation {
  const requested = normalizeSurface(input.requested);
  const grantedCapabilities =
    input.grant === undefined
      ? emptySurface()
      : capabilitySurfaceFromGrant(input.grant);
  const overGrant =
    input.reason === "capability_outside_grant"
      ? normalizeSurface({
          tools: difference(requested.tools, grantedCapabilities.tools),
          requireApproval: difference(
            requested.requireApproval,
            grantedCapabilities.requireApproval
          ),
          toolDefinitions: difference(
            requested.toolDefinitions,
            grantedCapabilities.toolDefinitions
          ),
          policyEffects: difference(
            requested.policyEffects,
            grantedCapabilities.policyEffects
          ),
          policyLayers: difference(
            requested.policyLayers,
            grantedCapabilities.policyLayers
          ),
          runtimeInvariantToolIds: difference(
            requested.runtimeInvariantToolIds,
            grantedCapabilities.runtimeInvariantToolIds
          )
        })
      : requested;
  const deniedCapabilities =
    input.deniedCapabilities === undefined
      ? deniedCapabilityNames(overGrant)
      : sortedUnique(input.deniedCapabilities);

  return {
    granted: false,
    requested,
    grant:
      input.grant === undefined ? undefined : summarizeGrant(input.grant),
    grantedCapabilities,
    overGrant,
    deniedCapabilities:
      deniedCapabilities.length === 0
        ? [`grant:${input.reason}`]
        : deniedCapabilities,
    denialReason: input.reason
  };
}

export function buildGrantEvaluatedEvent(
  packageId: string,
  version: string,
  evaluation: GrantEvaluation
): HarnessGrantEvent {
  return HarnessGrantEvaluatedEventSchema.parse({
    type: "harness.grant.evaluated",
    payload: {
      packageId,
      version,
      verdict: evaluation.granted ? "allowed" : "denied",
      requested: evaluation.requested,
      granted: evaluation.grantedCapabilities,
      overGrant: evaluation.overGrant,
      ...(evaluation.grant === undefined ? {} : { grant: evaluation.grant }),
      deniedCapabilities: evaluation.deniedCapabilities,
      ...(evaluation.denialReason === undefined
        ? {}
        : { denialReason: evaluation.denialReason }),
      ...(evaluation.granted ? {} : { failClosed: true })
    }
  });
}

export function firstDeniedCapability(evaluation: GrantEvaluation) {
  return evaluation.deniedCapabilities[0] ?? "unknown";
}

const DEFAULT_CAPABILITY_GRANT_REGISTRY = {
  registryId: "specwright.local.capability-grants.v0",
  grants: [
    {
      grantId: "grant.specwright.default.0.1.0",
      packageId: "specwright.default",
      versionPins: ["0.1.0"],
      allowedTools: ["eval.run", "fs.list", "fs.read"],
      allowedRequireApproval: [],
      allowedToolDefinitions: ["eval.run", "fs.list", "fs.read"],
      allowedPolicyEffects: ["deny"],
      allowedPolicyLayers: ["runtime_invariant"],
      allowedRuntimeInvariantToolIds: [
        "fs.write",
        "git.branch",
        "git.commit",
        "git.push",
        "network.request",
        "network.write",
        "shell.exec"
      ],
      issuer: {
        registryId: "specwright.local.capability-grants.v0",
        authorityId: "specwright.registry.operator"
      }
    }
  ]
} satisfies CapabilityGrantRegistry;

export const DEFAULT_GRANT_SOURCE = new RegistryGrantSource(
  DEFAULT_CAPABILITY_GRANT_REGISTRY
);

function capabilitySurfaceFromGrant(
  grant: CapabilityGrant
): RequestedCapabilitySurface {
  return normalizeSurface({
    tools: grant.allowedTools,
    requireApproval: grant.allowedRequireApproval,
    toolDefinitions: grant.allowedToolDefinitions,
    policyEffects: grant.allowedPolicyEffects,
    policyLayers: grant.allowedPolicyLayers,
    runtimeInvariantToolIds: grant.allowedRuntimeInvariantToolIds
  });
}

function summarizeGrant(grant: CapabilityGrant): CapabilityGrantSummary {
  return {
    grantId: grant.grantId,
    packageId: grant.packageId,
    ...(grant.versionRange === undefined
      ? {}
      : { versionRange: grant.versionRange }),
    ...(grant.versionPins === undefined
      ? {}
      : { versionPins: sortedUnique(grant.versionPins) }),
    issuer: grant.issuer
  };
}

function normalizeSurface(
  surface: RequestedCapabilitySurface
): RequestedCapabilitySurface {
  return {
    tools: sortedUnique(surface.tools),
    requireApproval: sortedUnique(surface.requireApproval),
    toolDefinitions: sortedUnique(surface.toolDefinitions),
    policyEffects: sortedUnique(surface.policyEffects),
    policyLayers: sortedUnique(surface.policyLayers),
    runtimeInvariantToolIds: sortedUnique(surface.runtimeInvariantToolIds)
  };
}

function emptySurface(): RequestedCapabilitySurface {
  return {
    tools: [],
    requireApproval: [],
    toolDefinitions: [],
    policyEffects: [],
    policyLayers: [],
    runtimeInvariantToolIds: []
  };
}

function deniedCapabilityNames(surface: RequestedCapabilitySurface) {
  return [
    ...surface.tools.map((tool) => `tool:${tool}`),
    ...surface.requireApproval.map((tool) => `requireApproval:${tool}`),
    ...surface.toolDefinitions.map((tool) => `toolDefinition:${tool}`),
    ...surface.policyEffects.map((effect) => `policyEffect:${effect}`),
    ...surface.policyLayers.map((layer) => `policyLayer:${layer}`),
    ...surface.runtimeInvariantToolIds.map(
      (tool) => `runtimeInvariantTool:${tool}`
    )
  ];
}

function difference(requested: readonly string[], granted: readonly string[]) {
  const grantedSet = new Set(granted);

  return requested.filter((item) => !grantedSet.has(item));
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function manifestToolReferences(manifest: HarnessManifest): string[] {
  if (Array.isArray(manifest.tools)) {
    return refsFrom(manifest.tools);
  }

  if (isRecord(manifest.tools)) {
    return [
      ...stringArray(manifest.tools.allow),
      ...stringArray(manifest.tools.requireApproval)
    ];
  }

  return [];
}

function manifestRequireApprovalReferences(manifest: HarnessManifest): string[] {
  if (!isRecord(manifest.tools)) {
    return [];
  }

  return stringArray(manifest.tools.requireApproval);
}

function policyRuleRecords(policy: PolicyBundle): PlainRecord[] {
  if (!Array.isArray(policy.rules)) {
    return [];
  }

  return policy.rules.filter(isRecord);
}

function runtimeInvariantRecords(policy: PolicyBundle): PlainRecord[] {
  const runtimeInvariants = policy.runtimeInvariants;

  if (!Array.isArray(runtimeInvariants)) {
    return [];
  }

  return runtimeInvariants.filter(isRecord);
}

function runtimeInvariantToolReferences(invariant: PlainRecord): string[] {
  const match = isRecord(invariant.match) ? invariant.match : {};

  return [
    ...refsFrom(invariant.toolId),
    ...refsFrom(invariant.tool),
    ...refsFrom(invariant.tools),
    ...refsFrom(match.toolId),
    ...refsFrom(match.tool),
    ...refsFrom(match.tools)
  ];
}

function refsFrom(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(referenceId).filter((id): id is string => id !== undefined);
  }

  const id = referenceId(value);

  return id === undefined ? [] : [id];
}

function referenceId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["id", "ref", "tool", "toolId"]) {
    const valueAtKey = stringValue(value[key]);

    if (valueAtKey !== undefined) {
      return valueAtKey;
    }
  }

  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSupportedVersionRange(range: string) {
  if (range === "*") {
    return true;
  }

  return range.split(/\s+/u).every(isSupportedVersionComparator);
}

function isSupportedVersionComparator(comparator: string) {
  return /^(?:[<>]=?|=)?\d+\.\d+\.\d+$/u.test(comparator);
}

function versionSatisfiesRange(version: string, range: string) {
  if (range === "*") {
    return true;
  }

  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    return false;
  }

  return range.split(/\s+/u).every((comparator) =>
    versionSatisfiesComparator(version, comparator)
  );
}

function versionSatisfiesComparator(
  version: string,
  comparator: string
) {
  const match = comparator.match(
    /^(?<operator>[<>]=?|=)?(?<target>\d+\.\d+\.\d+)$/u
  );

  if (match?.groups === undefined) {
    return false;
  }

  const operator = match.groups.operator ?? "=";
  const target = match.groups.target;

  if (target === undefined) {
    return false;
  }

  const comparison = compareVersions(version, target);

  switch (operator) {
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "=":
      return comparison === 0;
    default:
      return false;
  }
}

function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;

    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function parseVersion(version: string) {
  return version.split(".").map((part) => Number(part));
}
