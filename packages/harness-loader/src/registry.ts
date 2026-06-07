import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarnessLoaderError } from "./errors";
import {
  assertLifecycleTransition,
  type DryRunValidationEvidence,
  type PromotionApproval,
  type RegistryLifecycleState
} from "./lifecycle";
import {
  DEFAULT_HARNESS_LOADER_LIMITS,
  type HarnessLoaderLimitsInput
} from "./limits";
import { SnapshotCache } from "./cache";
import type {
  HarnessLoadRecord,
  LoadHarnessPackageOptions,
  ResolvedDependency,
  SourceFile
} from "./index";
import type { HarnessSnapshot } from "@specwright/schemas";

export type RegistryPackageKey = {
  packageId: string;
  version: string;
};

export type RegistryStoredBytes = {
  packageDir: string;
  files: readonly Pick<SourceFile, "relativePath" | "raw">[];
};

export type RegistryLifecycleRecord = RegistryPackageKey & {
  state: RegistryLifecycleState;
  specHash?: string | undefined;
  previousState?: RegistryLifecycleState | undefined;
  reason?: string | undefined;
  updatedAt: string;
};

export type RegistryPromotedVersion = RegistryPackageKey & {
  specHash: string;
  promotedAt: string;
  packageDir: string;
  snapshot: HarnessSnapshot;
  files: readonly Pick<SourceFile, "relativePath" | "raw">[];
  dependencies: readonly ResolvedDependency[];
  loadOptions?: Omit<LoadHarnessPackageOptions, "packageDir"> | undefined;
  limits?: HarnessLoaderLimitsInput | undefined;
};

export type RegistryStore = {
  putCandidate(input: RegistryPackageKey & { packageDir: string; stagedAt: string }): void;
  getCandidate(input: RegistryPackageKey): { packageDir: string; stagedAt: string } | undefined;
  putLifecycle(record: RegistryLifecycleRecord): void;
  getLifecycle(input: RegistryPackageKey): RegistryLifecycleRecord | undefined;
  putPromotedVersion(record: RegistryPromotedVersion): void;
  getPromotedVersion(input: RegistryPackageKey): RegistryPromotedVersion | undefined;
  findPromotedBySpecHash(specHash: string): RegistryPromotedVersion | undefined;
  listPromoted(packageId: string): RegistryPromotedVersion[];
  listAllPromoted(): RegistryPromotedVersion[];
};

export type HarnessRegistryLoaderInput = LoadHarnessPackageOptions & {
  limits?: HarnessLoaderLimitsInput | undefined;
};

export type HarnessRegistryLoader = (
  input: HarnessRegistryLoaderInput
) => Promise<HarnessLoadRecord>;

export type HarnessRegistryOptions = {
  store?: RegistryStore | undefined;
  cache: SnapshotCache;
  loader: HarnessRegistryLoader;
  now?(): Date | string;
};

export type StageCandidateInput = RegistryPackageKey & {
  packageDir: string;
};

export type PromoteInput = RegistryPackageKey & {
  approval?: PromotionApproval | undefined;
  packageDir?: string | undefined;
  loadOptions?: Omit<LoadHarnessPackageOptions, "packageDir"> | undefined;
  limits?: HarnessLoaderLimitsInput | undefined;
};

export type PreparedPromotion = {
  key: RegistryPackageKey;
  record: HarnessLoadRecord;
  approval: PromotionApproval;
  dryRunValidation: DryRunValidationEvidence;
  packageDir: string;
  loadOptions?: Omit<LoadHarnessPackageOptions, "packageDir"> | undefined;
  limits?: HarnessLoaderLimitsInput | undefined;
};

export class InMemoryRegistryStore implements RegistryStore {
  private readonly candidates = new Map<string, { packageDir: string; stagedAt: string }>();
  private readonly lifecycle = new Map<string, RegistryLifecycleRecord>();
  private readonly promoted = new Map<string, RegistryPromotedVersion>();
  private readonly bySpecHash = new Map<string, RegistryPromotedVersion>();

  putCandidate(input: RegistryPackageKey & { packageDir: string; stagedAt: string }) {
    this.candidates.set(registryKey(input), {
      packageDir: input.packageDir,
      stagedAt: input.stagedAt
    });
  }

  getCandidate(input: RegistryPackageKey) {
    return this.candidates.get(registryKey(input));
  }

  putLifecycle(record: RegistryLifecycleRecord) {
    this.lifecycle.set(registryKey(record), record);
  }

  getLifecycle(input: RegistryPackageKey) {
    return this.lifecycle.get(registryKey(input));
  }

  putPromotedVersion(record: RegistryPromotedVersion) {
    this.promoted.set(registryKey(record), record);
    this.bySpecHash.set(record.specHash, record);
  }

  getPromotedVersion(input: RegistryPackageKey) {
    return this.promoted.get(registryKey(input));
  }

  findPromotedBySpecHash(specHash: string) {
    return this.bySpecHash.get(specHash);
  }

  listPromoted(packageId: string) {
    return [...this.promoted.values()]
      .filter((record) => record.packageId === packageId)
      .sort((left, right) => left.promotedAt.localeCompare(right.promotedAt));
  }

  listAllPromoted() {
    return [...this.promoted.values()].sort(
      (left, right) =>
        left.packageId.localeCompare(right.packageId) ||
        left.version.localeCompare(right.version) ||
        left.promotedAt.localeCompare(right.promotedAt)
    );
  }
}

export class HarnessRegistry {
  private readonly store: RegistryStore;
  private readonly cache: SnapshotCache;
  private readonly loader: HarnessRegistryLoader;
  private readonly now: () => string;
  private readonly dependentSpecHashesByDependencyName = new Map<string, Set<string>>();

  constructor(options: HarnessRegistryOptions) {
    this.store = options.store ?? new InMemoryRegistryStore();
    this.cache = options.cache;
    this.loader = options.loader;
    this.now = () => normalizeTimestamp(options.now?.() ?? new Date());
  }

  stageCandidate(input: StageCandidateInput) {
    const existing = this.store.getLifecycle(input);

    if (existing?.state === "revoked") {
      throw new HarnessLoaderError(
        "invalid_lifecycle_transition",
        `Revoked harness package ${registryKey(input)} cannot be staged again`,
        undefined,
        {
          reason: "revoked_is_terminal"
        }
      );
    }

    const stagedAt = this.now();
    this.store.putCandidate({
      ...input,
      stagedAt
    });

    if (existing === undefined || existing.state === "candidate") {
      this.store.putLifecycle({
        ...input,
        state: "candidate",
        updatedAt: stagedAt
      });
    }

    return this.store.getLifecycle(input);
  }

  async promote(input: PromoteInput): Promise<RegistryPromotedVersion> {
    const prepared = await this.preparePromotion(input);
    this.commitPromotion(prepared);

    return this.store.getPromotedVersion(prepared.key) as RegistryPromotedVersion;
  }

  async promoteBatch(inputs: readonly PromoteInput[]) {
    const prepared: PreparedPromotion[] = [];

    for (const input of inputs) {
      prepared.push(await this.preparePromotion(input));
    }

    for (const promotion of prepared) {
      this.commitPromotion(promotion);
    }

    return prepared.map(
      (promotion) =>
        this.store.getPromotedVersion(promotion.key) as RegistryPromotedVersion
    );
  }

  deprecate(input: RegistryPackageKey & { reason?: string | undefined }) {
    return this.transition(input, "deprecated");
  }

  quarantine(input: RegistryPackageKey & { reason?: string | undefined }) {
    const record = this.transition(input, "quarantined");

    if (record.specHash !== undefined) {
      this.cache.delete(record.specHash);
    }

    return record;
  }

  revoke(input: RegistryPackageKey & { reason?: string | undefined }) {
    const record = this.transition(input, "revoked");

    if (record.specHash !== undefined) {
      this.cache.delete(record.specHash);
    }
    this.purgeDependentCacheEntries(input.packageId);

    return record;
  }

  async resolveCurrentTrusted(packageId: string) {
    const candidates = this.store
      .listPromoted(packageId)
      .filter(
        (record) =>
          this.store.getLifecycle(record)?.state === "trusted"
      );
    const current = candidates[candidates.length - 1];

    if (current === undefined) {
      throw new HarnessLoaderError(
        "version_not_resolvable",
        `No trusted harness package version is resolvable for ${packageId}`,
        undefined,
        {
          reason: "no_trusted_version",
          details: {
            packageId
          }
        }
      );
    }

    return this.resolveSnapshot(current.specHash);
  }

  async resolveSnapshot(specHash: string) {
    const cached = this.cache.get(specHash);

    if (cached !== undefined) {
      return cached;
    }

    const retained = this.store.findPromotedBySpecHash(specHash);

    if (retained === undefined) {
      throw new HarnessLoaderError(
        "version_not_resolvable",
        `Harness snapshot ${specHash} is not resolvable from retained registry bytes`,
        undefined,
        {
          reason: "spec_hash_not_found",
          details: {
            specHash
          }
        }
      );
    }

    const retainedPackageDir = await writeRetainedBytesToTempPackage(retained);
    let record: HarnessLoadRecord;

    try {
      record = await this.loader({
        packageDir: retainedPackageDir,
        ...(retained.loadOptions ?? {}),
        limits: retained.limits ?? DEFAULT_HARNESS_LOADER_LIMITS
      });
    } finally {
      await rm(retainedPackageDir, { recursive: true, force: true });
    }

    if (record.snapshot.specHash !== specHash) {
      throw new HarnessLoaderError(
        "version_not_resolvable",
        `Harness snapshot ${specHash} re-derived as ${record.snapshot.specHash}`,
        undefined,
        {
          reason: "retained_bytes_hash_mismatch",
          details: {
            requestedSpecHash: specHash,
            actualSpecHash: record.snapshot.specHash
          }
        }
      );
    }

    this.cache.put(record);
    const verified = this.cache.get(specHash);

    if (verified === undefined) {
      throw new HarnessLoaderError(
        "version_not_resolvable",
        `Harness snapshot ${specHash} could not be restored into cache`,
        undefined,
        {
          reason: "cache_restore_failed"
        }
      );
    }

    return verified;
  }

  getLifecycle(input: RegistryPackageKey) {
    return this.store.getLifecycle(input);
  }

  private async preparePromotion(input: PromoteInput): Promise<PreparedPromotion> {
    const candidate = this.store.getCandidate(input);

    if (candidate === undefined) {
      throw new HarnessLoaderError(
        "version_not_resolvable",
        `Candidate ${registryKey(input)} has no package bytes staged`,
        undefined,
        {
          reason: "candidate_not_staged"
        }
      );
    }

    if (
      input.packageDir !== undefined &&
      input.packageDir !== candidate.packageDir
    ) {
      throw new HarnessLoaderError(
        "invalid_lifecycle_transition",
        `Promotion of ${registryKey(input)} must use explicitly staged package bytes`,
        undefined,
        {
          reason: "staged_package_dir_mismatch",
          details: {
            stagedPackageDir: candidate.packageDir,
            attemptedPackageDir: input.packageDir
          }
        }
      );
    }

    const packageDir = candidate.packageDir;
    const approval = input.approval;

    if (approval === undefined) {
      throw new HarnessLoaderError(
        "promotion_unapproved",
        `Promotion of ${registryKey(input)} requires recorded approval`,
        undefined,
        {
          reason: "missing_recorded_approval"
        }
      );
    }

    if (
      input.loadOptions?.signature === undefined ||
      input.loadOptions.trustStore === undefined
    ) {
      throw new HarnessLoaderError(
        "promotion_unapproved",
        `Promotion of ${registryKey(input)} requires signature and trust-store evidence`,
        undefined,
        {
          reason: "missing_trust_verification"
        }
      );
    }

    const existingLifecycle = this.store.getLifecycle(input);
    const from = existingLifecycle?.state ?? "candidate";
    const record = await this.loader({
      packageDir,
      ...(input.loadOptions ?? {}),
      strict: input.loadOptions?.strict ?? true,
      limits: input.limits ?? DEFAULT_HARNESS_LOADER_LIMITS
    });

    if (record.snapshot.id !== input.packageId || record.snapshot.version !== input.version) {
      throw new HarnessLoaderError(
        "invalid_lifecycle_transition",
        `Loaded package identity ${record.snapshot.id}@${record.snapshot.version} does not match ${registryKey(input)}`,
        undefined,
        {
          reason: "package_identity_mismatch",
          details: {
            expected: input,
            actual: {
              packageId: record.snapshot.id,
              version: record.snapshot.version
            }
          }
        }
      );
    }

    const existingPromoted = this.store.getPromotedVersion(input);

    if (
      existingPromoted !== undefined &&
      existingPromoted.specHash !== record.snapshot.specHash
    ) {
      throw new HarnessLoaderError(
        "version_immutable",
        `Promoted harness package ${registryKey(input)} cannot be overwritten with different bytes`,
        undefined,
        {
          reason: "promoted_bytes_changed",
          details: {
            existingSpecHash: existingPromoted.specHash,
            attemptedSpecHash: record.snapshot.specHash
          }
        }
      );
    }

    const dryRunValidation: DryRunValidationEvidence = {
      status: "passed",
      specHash: record.snapshot.specHash,
      validatedAt: this.now()
    };

    assertLifecycleTransition({
      from,
      to: "trusted",
      evidence: {
        dryRunValidation,
        trust: record.trust,
        approval
      }
    });

    return {
      key: {
        packageId: input.packageId,
        version: input.version
      },
      record,
      approval,
      dryRunValidation,
      packageDir,
      ...(input.loadOptions === undefined ? {} : { loadOptions: input.loadOptions }),
      ...(input.limits === undefined ? {} : { limits: input.limits })
    };
  }

  private commitPromotion(prepared: PreparedPromotion) {
    const promotedAt = this.now();
    const record: RegistryPromotedVersion = {
      packageId: prepared.key.packageId,
      version: prepared.key.version,
      specHash: prepared.record.snapshot.specHash,
      promotedAt,
      packageDir: prepared.packageDir,
      snapshot: prepared.record.snapshot,
      files: prepared.record.loadedFiles.map((file) => ({
        relativePath: file.relativePath,
        raw: file.raw
      })),
      dependencies: [...prepared.record.dependencies.resolved],
      ...(prepared.loadOptions === undefined
        ? {}
        : { loadOptions: prepared.loadOptions }),
      ...(prepared.limits === undefined ? {} : { limits: prepared.limits })
    };

    this.store.putPromotedVersion(record);
    this.store.putLifecycle({
      ...prepared.key,
      state: "trusted",
      specHash: record.specHash,
      previousState: this.store.getLifecycle(prepared.key)?.state,
      updatedAt: promotedAt
    });
    this.cache.put(prepared.record);
    this.trackDependencyDependents(record);
  }

  private transition(
    input: RegistryPackageKey & { reason?: string | undefined },
    to: RegistryLifecycleState
  ) {
    const current = this.store.getLifecycle(input);

    if (current === undefined) {
      throw new HarnessLoaderError(
        "version_not_resolvable",
        `Harness package ${registryKey(input)} has no lifecycle record`,
        undefined,
        {
          reason: "lifecycle_record_missing"
        }
      );
    }

    assertLifecycleTransition({
      from: current.state,
      to,
      evidence: {
        reason: input.reason
      }
    });

    const next: RegistryLifecycleRecord = {
      packageId: input.packageId,
      version: input.version,
      state: to,
      specHash: current.specHash,
      previousState: current.state,
      reason: input.reason,
      updatedAt: this.now()
    };

    this.store.putLifecycle(next);

    return next;
  }

  private trackDependencyDependents(record: RegistryPromotedVersion) {
    for (const dependency of record.dependencies) {
      const dependents =
        this.dependentSpecHashesByDependencyName.get(dependency.name) ??
        new Set<string>();
      dependents.add(record.specHash);
      this.dependentSpecHashesByDependencyName.set(dependency.name, dependents);
    }
  }

  private purgeDependentCacheEntries(packageId: string) {
    const dependentSpecHashes = new Set<string>();
    const dependents = this.dependentSpecHashesByDependencyName.get(packageId);

    for (const specHash of dependents ?? []) {
      dependentSpecHashes.add(specHash);
    }

    for (const promoted of this.store.listAllPromoted()) {
      if (
        promoted.dependencies.some(
          (dependency) => dependency.name === packageId
        )
      ) {
        dependentSpecHashes.add(promoted.specHash);
      }
    }

    for (const specHash of dependentSpecHashes) {
      this.cache.delete(specHash);
    }
  }
}

function registryKey(input: RegistryPackageKey) {
  return `${input.packageId}@${input.version}`;
}

function normalizeTimestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

async function writeRetainedBytesToTempPackage(
  retained: RegistryPromotedVersion
) {
  const packageDir = await mkdtemp(join(tmpdir(), "specwright-retained-harness-"));

  for (const file of retained.files) {
    const target = join(packageDir, file.relativePath);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.raw);
  }

  return packageDir;
}
