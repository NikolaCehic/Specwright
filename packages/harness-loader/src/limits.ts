import { Buffer } from "node:buffer";
import { z } from "zod";
import { HarnessLoaderError } from "./errors";
import type {
  HarnessLoadStageObserver,
  SourceFile
} from "./types";

const nonEmptyString = z.string().min(1);

export const HarnessLoaderLimitsSchema = z
  .object({
    limitsVersion: nonEmptyString,
    maxPackageBytes: z.number().int().positive(),
    maxFileCount: z.number().int().positive(),
    maxDefinitionsPerKind: z.number().int().positive(),
    maxPhaseGraphNodes: z.number().int().positive(),
    maxPhaseGraphEdges: z.number().int().nonnegative(),
    maxArtifactSchemaBytes: z.number().int().positive(),
    maxArtifactSchemaDepth: z.number().int().positive(),
    maxDependencyDepth: z.number().int().positive(),
    maxDependencyFanout: z.number().int().positive(),
    cacheMaxEntries: z.number().int().positive(),
    cacheTtlMs: z.number().int().positive()
  })
  .strict();

export type HarnessLoaderLimits = z.infer<typeof HarnessLoaderLimitsSchema>;
export type HarnessLoaderLimitsInput = Partial<HarnessLoaderLimits>;

export const DEFAULT_HARNESS_LOADER_LIMITS: HarnessLoaderLimits =
  HarnessLoaderLimitsSchema.parse({
    limitsVersion: "harness-loader-limits.v1",
    maxPackageBytes: 2_000_000,
    maxFileCount: 1_000,
    maxDefinitionsPerKind: 1_000,
    maxPhaseGraphNodes: 1_000,
    maxPhaseGraphEdges: 5_000,
    maxArtifactSchemaBytes: 500_000,
    maxArtifactSchemaDepth: 64,
    maxDependencyDepth: 16,
    maxDependencyFanout: 64,
    cacheMaxEntries: 256,
    cacheTtlMs: 60 * 60 * 1_000
  });

export type HarnessLoaderLimitViolation = {
  limit: keyof HarnessLoaderLimits;
  observed: number;
  allowed: number;
  path?: string;
};

export type HarnessPackageLimitSummary = {
  limitsVersion: string;
  fileCount: number;
  packageBytes: number;
  definitionCounts: Record<DefinitionKind, number>;
  phaseGraphNodes: number;
  phaseGraphEdges: number;
  maxArtifactSchemaBytesObserved: number;
  maxArtifactSchemaDepthObserved: number;
  dependencyDepthObserved: number;
  dependencyFanoutObserved: number;
};

export type HarnessPackageReadLimiter = {
  reserveFile(relativePath: string): void;
  observeFile(file: SourceFile): void;
};

type DefinitionKind =
  | "phases"
  | "gates"
  | "policies"
  | "tools"
  | "artifacts"
  | "evals"
  | "roles"
  | "prompts";

const definitionKinds = [
  "phases",
  "gates",
  "policies",
  "tools",
  "artifacts",
  "evals",
  "roles",
  "prompts"
] as const;

const definitionDirectories: Record<DefinitionKind, string> = {
  phases: "phases/",
  gates: "gates/",
  policies: "policies/",
  tools: "tools/",
  artifacts: "artifact-schemas/",
  evals: "evals/",
  roles: "roles/",
  prompts: "prompts/"
};

export function normalizeHarnessLoaderLimits(
  limits: HarnessLoaderLimitsInput | undefined
): HarnessLoaderLimits {
  return HarnessLoaderLimitsSchema.parse({
    ...DEFAULT_HARNESS_LOADER_LIMITS,
    ...(limits ?? {})
  });
}

export function createLimitStageObserver(input: {
  limits?: HarnessLoaderLimitsInput | undefined;
  observer?: HarnessLoadStageObserver | undefined;
}): HarnessLoadStageObserver {
  const limits = normalizeHarnessLoaderLimits(input.limits);

  return async (stage, metadata, operation) => {
    const value =
      input.observer === undefined
        ? await operation()
        : await input.observer(stage, metadata, operation);

    if (stage === "harness.fetch") {
      assertFetchedPackageWithinLimits(value, limits);
    }

    return value;
  };
}

export function createHarnessPackageReadLimiter(
  limitsInput?: HarnessLoaderLimitsInput
): HarnessPackageReadLimiter {
  const limits = normalizeHarnessLoaderLimits(limitsInput);
  let fileCount = 0;
  let packageBytes = 0;

  return {
    reserveFile(relativePath) {
      fileCount += 1;
      assertLimit("maxFileCount", fileCount, limits.maxFileCount, relativePath);
    },
    observeFile(file) {
      packageBytes += utf8ByteLength(file.raw);
      assertLimit(
        "maxPackageBytes",
        packageBytes,
        limits.maxPackageBytes,
        file.relativePath
      );
    }
  };
}

export function assertFetchedPackageWithinLimits(
  value: unknown,
  limitsInput?: HarnessLoaderLimitsInput
): HarnessPackageLimitSummary {
  const limits = normalizeHarnessLoaderLimits(limitsInput);
  const files = fetchedFiles(value);
  const summary = summarizePackageFiles(files, limits);

  assertLimit("maxFileCount", summary.fileCount, limits.maxFileCount);
  assertLimit("maxPackageBytes", summary.packageBytes, limits.maxPackageBytes);

  for (const [kind, count] of Object.entries(summary.definitionCounts)) {
    assertLimit("maxDefinitionsPerKind", count, limits.maxDefinitionsPerKind, kind);
  }

  assertLimit(
    "maxPhaseGraphNodes",
    summary.phaseGraphNodes,
    limits.maxPhaseGraphNodes
  );
  assertLimit(
    "maxPhaseGraphEdges",
    summary.phaseGraphEdges,
    limits.maxPhaseGraphEdges
  );
  assertLimit(
    "maxArtifactSchemaBytes",
    summary.maxArtifactSchemaBytesObserved,
    limits.maxArtifactSchemaBytes
  );
  assertLimit(
    "maxArtifactSchemaDepth",
    summary.maxArtifactSchemaDepthObserved,
    limits.maxArtifactSchemaDepth
  );
  assertLimit(
    "maxDependencyDepth",
    summary.dependencyDepthObserved,
    limits.maxDependencyDepth
  );
  assertLimit(
    "maxDependencyFanout",
    summary.dependencyFanoutObserved,
    limits.maxDependencyFanout
  );

  return summary;
}

function summarizePackageFiles(
  files: readonly SourceFile[],
  limits: HarnessLoaderLimits
): HarnessPackageLimitSummary {
  const definitionCounts = Object.fromEntries(
    definitionKinds.map((kind) => [kind, 0])
  ) as Record<DefinitionKind, number>;
  let phaseGraphNodes = 0;
  let phaseGraphEdges = 0;
  let maxArtifactSchemaBytesObserved = 0;
  let maxArtifactSchemaDepthObserved = 0;
  let dependencyDepthObserved = 0;
  let dependencyFanoutObserved = 0;

  for (const file of files) {
    const kind = kindForPath(file.relativePath);

    if (kind !== undefined) {
      definitionCounts[kind] += 1;
    }

    if (file.relativePath === "harness.yaml") {
      for (const inlineKind of definitionKinds) {
        definitionCounts[inlineKind] += countInlineDefinitions(file.raw, inlineKind);
      }
    }

    if (kind === "phases" || file.relativePath === "harness.yaml") {
      const graph = summarizePhaseGraph(file.raw);
      phaseGraphNodes += graph.nodes;
      phaseGraphEdges += graph.edges;
    }

    if (kind === "artifacts") {
      const bytes = utf8ByteLength(file.raw);
      maxArtifactSchemaBytesObserved = Math.max(
        maxArtifactSchemaBytesObserved,
        bytes
      );
      maxArtifactSchemaDepthObserved = Math.max(
        maxArtifactSchemaDepthObserved,
        jsonDepth(file.raw)
      );
    }

    if (file.relativePath === "harness.yaml") {
      const dependencies = summarizeDependencyLimits(file.raw);
      dependencyDepthObserved = Math.max(
        dependencyDepthObserved,
        dependencies.depth
      );
      dependencyFanoutObserved = Math.max(
        dependencyFanoutObserved,
        dependencies.fanout
      );
    }
  }

  return {
    limitsVersion: limits.limitsVersion,
    fileCount: files.length,
    packageBytes: files.reduce(
      (total, file) => total + utf8ByteLength(file.raw),
      0
    ),
    definitionCounts,
    phaseGraphNodes,
    phaseGraphEdges,
    maxArtifactSchemaBytesObserved,
    maxArtifactSchemaDepthObserved,
    dependencyDepthObserved,
    dependencyFanoutObserved
  };
}

function utf8ByteLength(value: string) {
  return Buffer.from(value, "utf8").length;
}

function fetchedFiles(value: unknown): readonly SourceFile[] {
  if (
    typeof value === "object" &&
    value !== null &&
    "loadedFiles" in value &&
    Array.isArray((value as { loadedFiles: unknown }).loadedFiles)
  ) {
    return (value as { loadedFiles: SourceFile[] }).loadedFiles;
  }

  throw new HarnessLoaderError(
    "resource_limit_exceeded",
    "Harness fetch stage did not expose loaded files for limit enforcement",
    undefined,
    {
      reason: "missing_loaded_files"
    }
  );
}

function assertLimit(
  limit: keyof HarnessLoaderLimits,
  observed: number,
  allowed: number,
  path?: string
) {
  if (observed <= allowed) {
    return;
  }

  const violation: HarnessLoaderLimitViolation = {
    limit,
    observed,
    allowed,
    ...(path === undefined ? {} : { path })
  };

  throw new HarnessLoaderError(
    "resource_limit_exceeded",
    `Harness package exceeded ${limit}: observed ${observed}, allowed ${allowed}`,
    undefined,
    {
      reason: String(limit),
      details: violation
    }
  );
}

function kindForPath(path: string): DefinitionKind | undefined {
  for (const kind of definitionKinds) {
    if (path.startsWith(definitionDirectories[kind])) {
      return kind;
    }
  }

  return undefined;
}

function countInlineDefinitions(raw: string, key: DefinitionKind): number {
  const lines = raw.split(/\r?\n/u);
  let inside = false;
  let baseIndent = 0;
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (!inside) {
      if (trimmed === `${key}:`) {
        inside = true;
        baseIndent = indent;
      }
      continue;
    }

    if (trimmed.length > 0 && indent <= baseIndent) {
      break;
    }

    if (trimmed.startsWith("- ")) {
      count += 1;
    }
  }

  return count;
}

function summarizePhaseGraph(raw: string) {
  const nodes = countYamlKey(raw, "id");
  const edges =
    countYamlValueReferences(raw, "next") +
    countYamlValueReferences(raw, "dependsOn") +
    countYamlValueReferences(raw, "after");

  return {
    nodes,
    edges
  };
}

function countYamlKey(raw: string, key: string) {
  const pattern = new RegExp(`(^|\\n)\\s*-?\\s*${key}:\\s*\\S+`, "gu");

  return [...raw.matchAll(pattern)].length;
}

function countYamlValueReferences(raw: string, key: string) {
  let count = 0;
  const lines = raw.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed.startsWith(`${key}:`)) {
      continue;
    }

    const value = trimmed.slice(key.length + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      count += value
        .slice(1, -1)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean).length;
      continue;
    }

    if (value.length > 0) {
      count += 1;
    }
  }

  return count;
}

function jsonDepth(raw: string): number {
  try {
    return depth(JSON.parse(raw));
  } catch {
    return 1;
  }
}

function depth(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length === 0 ? 1 : 1 + Math.max(...value.map(depth));
  }

  if (typeof value === "object" && value !== null) {
    const values = Object.values(value);

    return values.length === 0 ? 1 : 1 + Math.max(...values.map(depth));
  }

  return 1;
}

function summarizeDependencyLimits(raw: string) {
  const lines = raw.split(/\r?\n/u);
  let inDependencies = false;
  let baseIndent = 0;
  let fanout = 0;
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (!inDependencies) {
      if (trimmed === "dependencies:") {
        inDependencies = true;
        baseIndent = indent;
      }
      continue;
    }

    if (trimmed.length > 0 && indent <= baseIndent) {
      break;
    }

    if (trimmed.startsWith("- ")) {
      fanout += 1;
      depth = Math.max(depth, Math.max(1, Math.floor((indent - baseIndent) / 2)));
    }
  }

  return {
    depth,
    fanout
  };
}
