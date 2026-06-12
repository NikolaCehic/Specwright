export const OPERATIONS_VERSION = "0.1.0";

export {
  OPERATION_AUDIT_DIR,
  OPERATION_AUDIT_RECORD_VERSION,
  OperationAuditActionSchema,
  OperationAuditOutcomeSchema,
  OperationAuditRecordSchema,
  appendOperationAuditRecord,
  buildOperationAuditRecord,
  hashOperationCanonical,
  operationAuditPath,
  readOperationAuditRecords,
  stableOperationJson,
  type BuildOperationAuditRecordInput,
  type OperationAuditAction,
  type OperationAuditOutcome,
  type OperationAuditRecord
} from "./audit";

export {
  DEPLOYMENT_MODES,
  DeploymentModeSchema,
  GovernanceGrantSchema,
  TenantScopeSchema,
  TenantTaggedSeriesSchema,
  TenancyError,
  crossTenantQuery,
  partitionByTenant,
  requireTenantScope,
  runTenantScopedJob,
  tenantRootDir,
  type CrossTenantQueryOptions,
  type CrossTenantQueryResult,
  type DeploymentMode,
  type GovernanceGrant,
  type PartitionByTenantOptions,
  type RequireTenantScopeOptions,
  type RunTenantScopedJobOptions,
  type RunTenantScopedJobResult,
  type TenantPartition,
  type TenantScope,
  type TenantTaggedSeries,
  type TenancyErrorCode
} from "./tenancy";

export {
  COMPATIBILITY_CHANGE_KINDS,
  COMPATIBILITY_CLASSES,
  ClassifyCompatibilityInputSchema,
  CompatibilityChangeDescriptorSchema,
  CompatibilityClassSchema,
  classifyCompatibility,
  isCompatibilityClassPromotable,
  type ClassifyCompatibilityInput,
  type CompatibilityChangeDescriptor,
  type CompatibilityChangeKind,
  type CompatibilityClass,
  type CompatibilityClassification
} from "./compatibility";

export {
  OPERATIONS_RELEASE_DIR,
  OPERATIONS_RELEASE_STATE_VERSION,
  EvaluateReleaseOptionsSchema,
  HistoricalReplayFixtureSchema,
  ReleaseApprovalSchema,
  ReleaseError,
  ReleaseStateSchema,
  ReleaseVerdictSchema,
  ReplayFixtureResultSchema,
  evaluateRelease,
  promoteRelease,
  readTenantReleaseState,
  releaseStatePath,
  rollbackRelease,
  runHistoricalReplayFixture,
  type EvaluateReleaseOptions,
  type HistoricalReplayFixture,
  type ReleaseApproval,
  type ReleaseErrorCode,
  type ReleaseState,
  type ReleaseVerdict,
  type ReplayFixtureResult
} from "./release";
