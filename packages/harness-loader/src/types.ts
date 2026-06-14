import type { HarnessSnapshot } from "@specwright/schemas";
import type {
  HarnessTrustEvent,
  SignatureEnvelope,
  TrustStore,
  TrustVerdict
} from "./trust";
import type {
  GrantEvaluation,
  GrantSource,
  HarnessGrantEvent
} from "./capability-grant";
import type {
  DependencyResolution,
  HarnessDependencyEvent,
  HarnessDependencyResolver
} from "./dependency-resolver";
import type { CompatibilityAdmission } from "./compatibility/admission";
import type { CompatibilityMatrix } from "./compatibility/matrix";
import type { MigrationDescriptor } from "./compatibility/migration";

export type HarnessLoadStageKind =
  | "harness.fetch"
  | "harness.verify_trust"
  | "harness.parse"
  | "harness.validate"
  | "harness.resolve_deps"
  | "harness.compatibility"
  | "harness.grant_check"
  | "harness.freeze";

export type HarnessLoadStageObserver = <TValue>(
  stage: HarnessLoadStageKind,
  metadata: Record<string, unknown>,
  operation: () => TValue | Promise<TValue>
) => Promise<TValue>;

export type LoadHarnessPackageOptions = {
  packageDir: string;
  loadedAt?: Date | string;
  signature?: SignatureEnvelope;
  trustStore?: TrustStore;
  strict?: boolean;
  trustNow?: Date | string;
  onTrustEvent?(event: HarnessTrustEvent): void | Promise<void>;
  grantSource?: GrantSource;
  onGrantEvent?(event: HarnessGrantEvent): void | Promise<void>;
  dependencyResolver?: HarnessDependencyResolver;
  onDependencyEvent?(event: HarnessDependencyEvent): void | Promise<void>;
  runtimeVersion?: string;
  compatibilityMatrix?: CompatibilityMatrix;
  migrationDescriptor?: MigrationDescriptor;
  migrationTrustStore?: TrustStore;
  migrationNow?: Date | string;
  onLoadStage?: HarnessLoadStageObserver;
};

export type HarnessLoadRecord = {
  snapshot: HarnessSnapshot;
  loadedFiles: readonly SourceFile[];
  grant: GrantEvaluation;
  dependencies: DependencyResolution;
  compatibility: CompatibilityAdmission;
  trust?: TrustVerdict;
};

export type SourceFile = {
  absolutePath: string;
  relativePath: string;
  raw: string;
};
