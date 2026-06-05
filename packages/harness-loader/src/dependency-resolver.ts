import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HarnessManifest } from "@specwright/schemas";
import { z } from "zod";

const nonEmptyString = z.string().min(1);
const sha256String = nonEmptyString.refine(
  (value) => /^sha256:[0-9a-f]{64}$/u.test(value),
  "Expected sha256:<64 lowercase hex chars>"
);

export const HarnessDependencyDeclarationSchema = z
  .object({
    name: nonEmptyString,
    versionRange: nonEmptyString,
    pinnedHash: sha256String.optional(),
    trustTier: nonEmptyString.optional()
  })
  .strict();

export type HarnessDependencyDeclaration = z.infer<
  typeof HarnessDependencyDeclarationSchema
>;

export const ResolvedDependencySchema = z
  .object({
    name: nonEmptyString,
    version: nonEmptyString,
    contentHash: sha256String,
    trustTier: nonEmptyString.optional()
  })
  .strict();

export type ResolvedDependency = z.infer<typeof ResolvedDependencySchema>;

export const ReviewedDependencyPinSchema = ResolvedDependencySchema.extend({
  content: z.string()
}).strict();

export type ReviewedDependencyPin = z.infer<
  typeof ReviewedDependencyPinSchema
>;

export const DependencyRegistrySchema = z
  .object({
    registryId: nonEmptyString,
    pins: z.array(ReviewedDependencyPinSchema)
  })
  .strict();

export type DependencyRegistry = z.infer<typeof DependencyRegistrySchema>;

export type HarnessDependencyResolver = {
  resolve(
    declarations: readonly HarnessDependencyDeclaration[],
    context: DependencyResolutionContext
  ): Promise<readonly ResolvedDependency[]> | readonly ResolvedDependency[];
};

export type DependencyResolutionContext = {
  packageId: string;
  packageVersion: string;
  strict: boolean;
  trustTier?: string;
};

export type DependencyResolution = {
  declarations: HarnessDependencyDeclaration[];
  resolved: ResolvedDependency[];
};

export type DependencyRejectReason =
  | "malformed_dependency_declaration"
  | "resolver_failed"
  | "dependency_unresolved"
  | "dependency_hash_mismatch"
  | "dependency_unpinned"
  | "dependency_range_not_pinned"
  | "dependency_conflict"
  | "dependency_trust_tier_violation"
  | "malformed_dependency_registry";

export class DependencyResolutionError extends Error {
  readonly reason: DependencyRejectReason;
  readonly dependencyName: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    reason: DependencyRejectReason,
    message: string,
    context: {
      dependencyName?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "DependencyResolutionError";
    this.reason = reason;
    this.dependencyName = context.dependencyName;
    this.details = context.details;

    if (context.cause !== undefined) {
      Object.assign(this, { cause: context.cause });
    }
  }
}

export const HarnessDependenciesPinnedEventSchema = z
  .object({
    type: z.literal("harness.dependencies.pinned"),
    payload: z
      .object({
        packageId: nonEmptyString,
        version: nonEmptyString,
        specHash: sha256String,
        dependencies: z.array(ResolvedDependencySchema)
      })
      .strict()
  })
  .strict();

export type HarnessDependencyEvent = z.infer<
  typeof HarnessDependenciesPinnedEventSchema
>;

export class FixtureBackedHarnessDependencyResolver
  implements HarnessDependencyResolver
{
  readonly registryId: string;
  private readonly pinsByName = new Map<string, ReviewedDependencyPin[]>();

  constructor(input: unknown) {
    const parsed = DependencyRegistrySchema.safeParse(input);

    if (!parsed.success) {
      throw new DependencyResolutionError(
        "malformed_dependency_registry",
        `Dependency registry is invalid: ${parsed.error.message}`,
        {
          details: {
            schema: "DependencyRegistrySchema"
          },
          cause: parsed.error
        }
      );
    }

    this.registryId = parsed.data.registryId;

    for (const pin of parsed.data.pins) {
      verifyReviewedPinHash(pin);
      const pins = this.pinsByName.get(pin.name) ?? [];
      pins.push(pin);
      pins.sort(comparePins);
      this.pinsByName.set(pin.name, pins);
    }
  }

  resolve(
    declarations: readonly HarnessDependencyDeclaration[],
    context: DependencyResolutionContext
  ) {
    return declarations.map((declaration) => {
      const pin = this.pinsByName
        .get(declaration.name)
        ?.find((candidate) =>
          versionRangeMatchesPinnedVersion(
            declaration.versionRange,
            candidate.version
          )
        );

      if (pin === undefined) {
        throw new DependencyResolutionError(
          "dependency_unresolved",
          `No reviewed dependency pin for ${declaration.name}@${declaration.versionRange}`,
          {
            dependencyName: declaration.name,
            details: {
              versionRange: declaration.versionRange
            }
          }
        );
      }

      assertResolverTrustTier(declaration, pin, context);

      return ResolvedDependencySchema.parse({
        name: pin.name,
        version: pin.version,
        contentHash: pin.contentHash,
        ...(pin.trustTier === undefined ? {} : { trustTier: pin.trustTier })
      });
    });
  }
}

export { FixtureBackedHarnessDependencyResolver as RegistryDependencyResolver };

export const DEFAULT_DEPENDENCY_RESOLVER =
  new FixtureBackedHarnessDependencyResolver({
    registryId: "specwright.local.dependencies.empty",
    pins: []
  });

export async function loadDependencyRegistryFromFile(path: string) {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new DependencyResolutionError(
      "malformed_dependency_registry",
      `Could not read dependency registry ${path}`,
      {
        details: { path },
        cause: error
      }
    );
  }

  return new FixtureBackedHarnessDependencyResolver(parsedJson);
}

export const loadFixtureDependencyResolverFromFile =
  loadDependencyRegistryFromFile;

export async function resolveAndPinDependencies(input: {
  manifest: HarnessManifest;
  resolver: HarnessDependencyResolver;
  strict: boolean;
}): Promise<DependencyResolution> {
  const declarations = parseDependencyDeclarations(input.manifest);

  if (declarations.length === 0) {
    return {
      declarations: [],
      resolved: []
    };
  }

  validateDeclarationsFailClosed(declarations, input.strict);

  let resolvedDependencies: readonly ResolvedDependency[];
  const packageTrustTier = manifestTrustTier(input.manifest);

  try {
    resolvedDependencies = await input.resolver.resolve(declarations, {
      packageId: input.manifest.id,
      packageVersion: input.manifest.version,
      strict: input.strict,
      ...(packageTrustTier === undefined ? {} : { trustTier: packageTrustTier })
    });
  } catch (error) {
    if (error instanceof DependencyResolutionError) {
      throw error;
    }

    throw new DependencyResolutionError(
      "resolver_failed",
      "Dependency resolver failed before returning reviewed pins",
      {
        cause: error
      }
    );
  }

  return verifyResolvedPins(
    declarations,
    resolvedDependencies,
    packageTrustTier
  );
}

export function parseDependencyDeclarations(
  manifest: HarnessManifest
): HarnessDependencyDeclaration[] {
  const rawDependencies = isRecord(manifest) ? manifest.dependencies : undefined;

  if (rawDependencies === undefined) {
    return [];
  }

  const parsed = z
    .array(HarnessDependencyDeclarationSchema)
    .safeParse(rawDependencies);

  if (!parsed.success) {
    throw new DependencyResolutionError(
      "malformed_dependency_declaration",
      `Harness dependency declarations are invalid: ${parsed.error.message}`,
      {
        details: {
          schema: "HarnessDependencyDeclarationSchema"
        },
        cause: parsed.error
      }
    );
  }

  return canonicalizeDeclarations(parsed.data);
}

export function canonicalizeResolvedDependencies(
  dependencies: readonly ResolvedDependency[]
): ResolvedDependency[] {
  return dependencies
    .map((dependency) => ResolvedDependencySchema.parse(dependency))
    .sort(compareResolvedDependencies);
}

export function buildDependenciesPinnedEvent(
  packageId: string,
  version: string,
  specHash: string,
  resolution: DependencyResolution
): HarnessDependencyEvent {
  return HarnessDependenciesPinnedEventSchema.parse({
    type: "harness.dependencies.pinned",
    payload: {
      packageId,
      version,
      specHash,
      dependencies: canonicalizeResolvedDependencies(resolution.resolved)
    }
  });
}

export function canonicalDependencyHashSegments(
  dependencies: readonly ResolvedDependency[]
) {
  return canonicalizeResolvedDependencies(dependencies).map(
    (dependency) =>
      `dependency\0${dependency.name}\0${dependency.version}\0${dependency.contentHash}`
  );
}

export function dependencyContentHash(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateDeclarationsFailClosed(
  declarations: readonly HarnessDependencyDeclaration[],
  strict: boolean
) {
  const seen = new Map<string, HarnessDependencyDeclaration>();

  for (const declaration of declarations) {
    const existing = seen.get(declaration.name);

    if (
      existing !== undefined &&
      (existing.versionRange !== declaration.versionRange ||
        existing.pinnedHash !== declaration.pinnedHash ||
        existing.trustTier !== declaration.trustTier)
    ) {
      throw new DependencyResolutionError(
        "dependency_conflict",
        `Conflicting dependency declarations for ${declaration.name}`,
        {
          dependencyName: declaration.name,
          details: {
            first: existing,
            second: declaration
          }
        }
      );
    }

    seen.set(declaration.name, declaration);

    if (strict && declaration.pinnedHash === undefined) {
      throw new DependencyResolutionError(
        "dependency_unpinned",
        `Dependency ${declaration.name} must declare pinnedHash in strict mode`,
        {
          dependencyName: declaration.name,
          details: {
            versionRange: declaration.versionRange
          }
        }
      );
    }

    if (strict && !isExactVersionRange(declaration.versionRange)) {
      throw new DependencyResolutionError(
        "dependency_range_not_pinned",
        `Dependency ${declaration.name} must use an exact version pin in strict mode`,
        {
          dependencyName: declaration.name,
          details: {
            versionRange: declaration.versionRange
          }
        }
      );
    }
  }
}

function verifyResolvedPins(
  declarations: readonly HarnessDependencyDeclaration[],
  dependencies: readonly ResolvedDependency[],
  packageTrustTier: string | undefined
): DependencyResolution {
  const dependenciesByName = new Map<string, ResolvedDependency>();

  for (const dependency of dependencies) {
    const parsedDependency = ResolvedDependencySchema.parse(dependency);
    const existing = dependenciesByName.get(parsedDependency.name);

    if (
      existing !== undefined &&
      (existing.version !== parsedDependency.version ||
        existing.contentHash !== parsedDependency.contentHash ||
        existing.trustTier !== parsedDependency.trustTier)
    ) {
      throw new DependencyResolutionError(
        "dependency_conflict",
        `Resolver returned conflicting pins for ${parsedDependency.name}`,
        {
          dependencyName: parsedDependency.name,
          details: {
            first: existing,
            second: parsedDependency
          }
        }
      );
    }

    dependenciesByName.set(parsedDependency.name, parsedDependency);
  }

  const resolved = declarations.map((declaration) => {
    const dependency = dependenciesByName.get(declaration.name);

    if (dependency === undefined) {
      throw new DependencyResolutionError(
        "dependency_unresolved",
        `Dependency ${declaration.name} was not returned by the resolver`,
        {
          dependencyName: declaration.name
        }
      );
    }

    const requiredTrustTier = declaration.trustTier ?? packageTrustTier;

    if (
      requiredTrustTier !== undefined &&
      dependency.trustTier !== requiredTrustTier
    ) {
      throw new DependencyResolutionError(
        "dependency_trust_tier_violation",
        `Dependency ${declaration.name} resolved outside trust tier ${requiredTrustTier}`,
        {
          dependencyName: declaration.name,
          details: {
            requiredTrustTier,
            resolvedTrustTier: dependency.trustTier
          }
        }
      );
    }

    if (
      declaration.pinnedHash !== undefined &&
      declaration.pinnedHash !== dependency.contentHash
    ) {
      throw new DependencyResolutionError(
        "dependency_hash_mismatch",
        `Dependency ${declaration.name} resolved to ${dependency.contentHash}, expected ${declaration.pinnedHash}`,
        {
          dependencyName: declaration.name,
          details: {
            expected: declaration.pinnedHash,
            actual: dependency.contentHash
          }
        }
      );
    }

    return dependency;
  });

  return {
    declarations: canonicalizeDeclarations(declarations),
    resolved: canonicalizeResolvedDependencies(resolved)
  };
}

function verifyReviewedPinHash(pin: ReviewedDependencyPin) {
  const actual = dependencyContentHash(pin.content);

  if (actual !== pin.contentHash) {
    throw new DependencyResolutionError(
      "dependency_hash_mismatch",
      `Reviewed dependency pin ${pin.name}@${pin.version} has content hash ${actual}, expected ${pin.contentHash}`,
      {
        dependencyName: pin.name,
        details: {
          expected: pin.contentHash,
          actual
        }
      }
    );
  }
}

function assertResolverTrustTier(
  declaration: HarnessDependencyDeclaration,
  pin: ReviewedDependencyPin,
  context: DependencyResolutionContext
) {
  const requiredTrustTier = declaration.trustTier ?? context.trustTier;

  if (requiredTrustTier === undefined || pin.trustTier === requiredTrustTier) {
    return;
  }

  throw new DependencyResolutionError(
    "dependency_trust_tier_violation",
    `Dependency ${declaration.name} resolved outside trust tier ${requiredTrustTier}`,
    {
      dependencyName: declaration.name,
      details: {
        requiredTrustTier,
        resolvedTrustTier: pin.trustTier
      }
    }
  );
}

function manifestTrustTier(manifest: HarnessManifest) {
  if (!isRecord(manifest.metadata)) {
    return undefined;
  }

  const trustTier = manifest.metadata.trustTier;

  return typeof trustTier === "string" && trustTier.length > 0
    ? trustTier
    : undefined;
}

function canonicalizeDeclarations(
  declarations: readonly HarnessDependencyDeclaration[]
): HarnessDependencyDeclaration[] {
  return [...declarations].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.versionRange.localeCompare(right.versionRange) ||
      (left.pinnedHash ?? "").localeCompare(right.pinnedHash ?? "")
  );
}

function compareResolvedDependencies(
  left: ResolvedDependency,
  right: ResolvedDependency
) {
  return (
    left.name.localeCompare(right.name) ||
    left.contentHash.localeCompare(right.contentHash) ||
    left.version.localeCompare(right.version)
  );
}

function comparePins(left: ReviewedDependencyPin, right: ReviewedDependencyPin) {
  return (
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.contentHash.localeCompare(right.contentHash)
  );
}

function versionRangeMatchesPinnedVersion(range: string, version: string) {
  return range === version || range === `=${version}`;
}

function isExactVersionRange(range: string) {
  return /^\d+\.\d+\.\d+$/u.test(range) || /^=\d+\.\d+\.\d+$/u.test(range);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
