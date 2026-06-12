import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { listArtifacts } from "@specwright/artifact-store";
import { listEvidence } from "@specwright/evidence-store";
import {
  DEFAULT_REDACTION_PROFILE,
  readEvents,
  type RedactionProfile
} from "@specwright/run-store";
import type { RuntimeEvent } from "@specwright/schemas";
import {
  getCoverageVerdict,
  readTrace,
  type CoverageVerdict,
  type TraceFile
} from "@specwright/trace-recorder";
import {
  assertEgressAllowed,
  enforceEgress,
  type EgressAuditRecord
} from "./egress";
import type { ReconciliationResult, SourceEventRange } from "./index";
import { RUN_REPORTS_VERSION, type RunReport } from "./index";

export const AUDIT_BUNDLE_FORMAT_VERSION = 1;
export const AUDIT_BUNDLE_MANIFEST_FILE = "manifest.json";
export const AUDIT_BUNDLE_CHUNKS_DIR = "chunks";

export type BundleEventRange = SourceEventRange;

export type BundleAttestation =
  | {
      status: "attestable";
    }
  | {
      status: "non-attestable";
      reasons: string[];
    };

export type ChunkDescriptor = {
  runId: string;
  chunkPath: string;
  chunkHash: `sha256:${string}`;
  eventRange: BundleEventRange;
  attestation: BundleAttestation;
};

export type AuditBundleTrustLabels = {
  authority: "derived";
  claimLevel: "audit_export";
  redactionClass: "operator";
  tenant: string;
  scope: string;
  runId: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  artifactRefs: string[];
  traceId?: string | undefined;
};

export type AuditBundleChunk = {
  formatVersion: typeof AUDIT_BUNDLE_FORMAT_VERSION;
  runId: string;
  tenant: string;
  scope: string;
  eventRange: BundleEventRange;
  report: {
    version: typeof RUN_REPORTS_VERSION;
    summaryPath: string;
    markdown: string;
    missingInputs: string[];
    egressAuditRecords: EgressAuditRecord[];
    egressRestrictions: RunReport["egressRestrictions"];
  };
  coverageVerdict?: CoverageVerdict | undefined;
  reconciliation?: ReconciliationResult | undefined;
  attestation: BundleAttestation;
  trustLabels: AuditBundleTrustLabels;
};

export type AuditBundleOperationAuditRecord = {
  recordKind: "audit_bundle_operation";
  action: "export_sealed" | "export_denied" | "export_discarded";
  requester?: string | undefined;
  tenant?: string | undefined;
  scope?: string | undefined;
  runIds: string[];
  eventRange?: BundleEventRange | undefined;
  registryVersion?: string | undefined;
  redactionProfile?: string | undefined;
  manifestHash?: `sha256:${string}` | undefined;
  reasonCode?: AuditBundleErrorCode | undefined;
  timestamp: string;
  message: string;
  subjectRefs: string[];
  subjectHashes: `sha256:${string}`[];
};

export type BundleManifest = {
  formatVersion: typeof AUDIT_BUNDLE_FORMAT_VERSION;
  registryVersion: string;
  redactionProfile: string;
  requester: string;
  tenant: string;
  scope: string;
  generatedAt: string;
  eventRange: BundleEventRange;
  chunks: ChunkDescriptor[];
  auditRecords: AuditBundleOperationAuditRecord[];
  manifestHash: `sha256:${string}`;
};

export type AuditBundleRequest = {
  rootDir?: string | undefined;
  destinationPath: string;
  tenant: string;
  scope: string;
  requester: string;
  requesterRoles: readonly string[];
  runIds: readonly string[];
  registryVersion: string;
  redactionProfile?: RedactionProfile | undefined;
  generatedAt?: Date | string | undefined;
  requestedAt?: Date | string | undefined;
  hooks?: AuditBundleAssemblyHooks | undefined;
};

export type AuditBundleAssemblyHooks = {
  afterChunkWritten?: (descriptor: ChunkDescriptor) => void | Promise<void>;
  beforeManifestWrite?: () => void | Promise<void>;
  beforePromote?: () => void | Promise<void>;
};

export type AuditBundleResult = {
  destinationPath: string;
  manifestPath: string;
  manifest: BundleManifest;
  chunks: ChunkDescriptor[];
  auditRecords: AuditBundleOperationAuditRecord[];
};

export type AuditBundleErrorCode =
  | "invalid_request"
  | "unscoped_export"
  | "unauthorized_export"
  | "duplicate_run"
  | "cross_tenant_export"
  | "missing_event_range"
  | "bundle_destination_exists"
  | "assembly_failed";

export class AuditBundleError extends Error {
  readonly code: AuditBundleErrorCode;
  readonly auditRecords: AuditBundleOperationAuditRecord[];

  constructor(
    code: AuditBundleErrorCode,
    message: string,
    auditRecords: AuditBundleOperationAuditRecord[] = []
  ) {
    super(message);
    this.name = "AuditBundleError";
    this.code = code;
    this.auditRecords = auditRecords;
  }
}

type NormalizedAuditBundleRequest = {
  rootDir?: string | undefined;
  destinationPath: string;
  tenant: string;
  scope: string;
  requester: string;
  requesterRoles: readonly string[];
  runIds: readonly string[];
  registryVersion: string;
  redactionProfile: RedactionProfile;
  generatedAt: string;
  requestedAt: string;
  hooks?: AuditBundleAssemblyHooks | undefined;
};

type PreparedRun = {
  runId: string;
  events: RuntimeEvent[];
  eventRange: BundleEventRange;
  trace?: TraceFile | undefined;
  artifacts: unknown[];
  evidence: unknown[];
};

type ManifestBody = Omit<
  BundleManifest,
  "generatedAt" | "auditRecords" | "manifestHash"
>;

export async function assembleAuditBundle(
  request: AuditBundleRequest
): Promise<AuditBundleResult> {
  const normalized = normalizeAuditBundleRequest(request);

  if (normalized instanceof AuditBundleError) {
    throw normalized;
  }

  await assertDestinationDoesNotExist(normalized);

  const preparedRuns: PreparedRun[] = [];

  for (const runId of normalized.runIds) {
    preparedRuns.push(await prepareRun(normalized, runId));
  }

  const destinationPath = resolve(normalized.destinationPath);
  const stagingPath = `${destinationPath}.staging.${randomUUID()}`;
  const chunkDescriptors: ChunkDescriptor[] = [];

  try {
    await mkdir(join(stagingPath, AUDIT_BUNDLE_CHUNKS_DIR), {
      recursive: true
    });

    for (const preparedRun of preparedRuns) {
      const chunk = await buildAuditBundleChunk(normalized, preparedRun);
      const chunkPath = join(
        AUDIT_BUNDLE_CHUNKS_DIR,
        `${safeChunkFileName(preparedRun.runId)}.json`
      );
      const chunkJson = stableAuditBundleJson(chunk);
      const chunkHash = hashAuditBundleCanonicalText(chunkJson);
      const descriptor: ChunkDescriptor = {
        runId: preparedRun.runId,
        chunkPath,
        chunkHash,
        eventRange: preparedRun.eventRange,
        attestation: chunk.attestation
      };

      await writeTextAtomic(join(stagingPath, chunkPath), chunkJson);
      chunkDescriptors.push(descriptor);
      await normalized.hooks?.afterChunkWritten?.(descriptor);
    }

    await normalized.hooks?.beforeManifestWrite?.();

    const manifestBody: ManifestBody = {
      formatVersion: AUDIT_BUNDLE_FORMAT_VERSION,
      registryVersion: normalized.registryVersion,
      redactionProfile: normalized.redactionProfile.id,
      requester: normalized.requester,
      tenant: normalized.tenant,
      scope: normalized.scope,
      eventRange: aggregateEventRange(
        preparedRuns.map((run) => run.eventRange)
      ),
      chunks: chunkDescriptors
    };
    const manifestHash = hashAuditBundleCanonical(manifestBody);
    const exportAuditRecord = operationAuditRecord({
      action: "export_sealed",
      request: normalized,
      eventRange: manifestBody.eventRange,
      manifestHash,
      message: `Audit export bundle sealed with manifest hash ${manifestHash}.`
    });
    const manifest: BundleManifest = {
      ...manifestBody,
      generatedAt: normalized.generatedAt,
      auditRecords: [exportAuditRecord],
      manifestHash
    };

    assertBundleManifest(manifest);
    await writeTextAtomic(
      join(stagingPath, AUDIT_BUNDLE_MANIFEST_FILE),
      stableAuditBundleJson(manifest)
    );
    await normalized.hooks?.beforePromote?.();
    await mkdir(dirname(destinationPath), { recursive: true });
    await rename(stagingPath, destinationPath);

    return {
      destinationPath,
      manifestPath: join(destinationPath, AUDIT_BUNDLE_MANIFEST_FILE),
      manifest,
      chunks: chunkDescriptors,
      auditRecords: [exportAuditRecord]
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });

    if (error instanceof AuditBundleError) {
      throw error;
    }

    const discardRecord = operationAuditRecord({
      action: "export_discarded",
      request: normalized,
      eventRange:
        preparedRuns.length === 0
          ? undefined
          : aggregateEventRange(preparedRuns.map((run) => run.eventRange)),
      reasonCode: "assembly_failed",
      message: errorMessage(error)
    });

    throw new AuditBundleError(
      "assembly_failed",
      `Audit bundle assembly failed and staging was discarded: ${errorMessage(error)}`,
      [discardRecord]
    );
  }
}

export function stableAuditBundleJson(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

export function hashAuditBundleCanonical(value: unknown): `sha256:${string}` {
  return hashAuditBundleCanonicalText(stableAuditBundleJson(value));
}

export function auditBundleManifestBody(
  manifest: BundleManifest
): ManifestBody {
  return {
    formatVersion: manifest.formatVersion,
    registryVersion: manifest.registryVersion,
    redactionProfile: manifest.redactionProfile,
    requester: manifest.requester,
    tenant: manifest.tenant,
    scope: manifest.scope,
    eventRange: manifest.eventRange,
    chunks: manifest.chunks
  };
}

export function parseBundleManifest(value: unknown): BundleManifest {
  const record = recordFromUnknown(value);
  const formatVersion = numberValue(record.formatVersion);
  const registryVersion = stringValue(record.registryVersion);
  const redactionProfile = stringValue(record.redactionProfile);
  const requester = stringValue(record.requester);
  const tenant = stringValue(record.tenant);
  const scope = stringValue(record.scope);
  const generatedAt = stringValue(record.generatedAt);
  const eventRange = parseEventRange(record.eventRange);
  const chunks = Array.isArray(record.chunks)
    ? record.chunks.map(parseChunkDescriptor)
    : undefined;
  const auditRecords = Array.isArray(record.auditRecords)
    ? record.auditRecords.map(parseOperationAuditRecord)
    : undefined;
  const manifestHash = hashValue(record.manifestHash);

  if (
    formatVersion !== AUDIT_BUNDLE_FORMAT_VERSION ||
    registryVersion === undefined ||
    redactionProfile === undefined ||
    requester === undefined ||
    tenant === undefined ||
    scope === undefined ||
    generatedAt === undefined ||
    eventRange === undefined ||
    chunks === undefined ||
    auditRecords === undefined ||
    manifestHash === undefined
  ) {
    throw new AuditBundleError(
      "invalid_request",
      "Audit bundle manifest is missing required fields."
    );
  }

  return {
    formatVersion: AUDIT_BUNDLE_FORMAT_VERSION,
    registryVersion,
    redactionProfile,
    requester,
    tenant,
    scope,
    generatedAt,
    eventRange,
    chunks,
    auditRecords,
    manifestHash
  };
}

export function parseAuditBundleChunk(value: unknown): AuditBundleChunk {
  const record = recordFromUnknown(value);
  const formatVersion = numberValue(record.formatVersion);
  const runId = stringValue(record.runId);
  const tenant = stringValue(record.tenant);
  const scope = stringValue(record.scope);
  const eventRange = parseEventRange(record.eventRange);
  const report = parseChunkReport(record.report);
  const coverageVerdict =
    record.coverageVerdict === undefined
      ? undefined
      : (record.coverageVerdict as CoverageVerdict);
  const reconciliation =
    record.reconciliation === undefined
      ? undefined
      : (record.reconciliation as ReconciliationResult);
  const attestation = parseAttestation(record.attestation);
  const trustLabels = parseTrustLabels(record.trustLabels);

  if (
    formatVersion !== AUDIT_BUNDLE_FORMAT_VERSION ||
    runId === undefined ||
    tenant === undefined ||
    scope === undefined ||
    eventRange === undefined ||
    report === undefined ||
    attestation === undefined ||
    trustLabels === undefined
  ) {
    throw new AuditBundleError(
      "invalid_request",
      "Audit bundle chunk is missing required fields."
    );
  }

  return {
    formatVersion: AUDIT_BUNDLE_FORMAT_VERSION,
    runId,
    tenant,
    scope,
    eventRange,
    report,
    ...(coverageVerdict === undefined ? {} : { coverageVerdict }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
    attestation,
    trustLabels
  };
}

function normalizeAuditBundleRequest(
  request: AuditBundleRequest
): NormalizedAuditBundleRequest | AuditBundleError {
  const tenant = request.tenant.trim();
  const scope = request.scope.trim();
  const requester = request.requester.trim();
  const registryVersion = request.registryVersion.trim();
  const runIds = [...request.runIds].map((runId) => runId.trim()).sort();
  const generatedAt = normalizeTimestamp(
    request.generatedAt ?? request.requestedAt
  );
  const requestedAt = normalizeTimestamp(request.requestedAt ?? generatedAt);
  const base = {
    tenant,
    scope,
    requester,
    runIds,
    registryVersion,
    redactionProfile:
      request.redactionProfile ?? DEFAULT_REDACTION_PROFILE,
    generatedAt,
    requestedAt,
    requesterRoles: [...request.requesterRoles].sort()
  };

  if (tenant.length === 0 || scope.length === 0) {
    return requestError(
      "unscoped_export",
      "Audit export requires a non-empty tenant and scope.",
      base
    );
  }

  if (requester.length === 0 || registryVersion.length === 0) {
    return requestError(
      "invalid_request",
      "Audit export requires requester and registryVersion.",
      base
    );
  }

  if (runIds.length === 0 || runIds.some((runId) => runId.length === 0)) {
    return requestError(
      "invalid_request",
      "Audit export requires at least one run id.",
      base
    );
  }

  const uniqueRunIds = new Set(runIds);

  if (uniqueRunIds.size !== runIds.length) {
    return requestError(
      "duplicate_run",
      "Audit export runIds must be unique.",
      base
    );
  }

  if (!hasExportRole(request.requesterRoles)) {
    return requestError(
      "unauthorized_export",
      "Audit export requires an auditor or operator role.",
      base
    );
  }

  return {
    ...(request.rootDir === undefined ? {} : { rootDir: request.rootDir }),
    destinationPath: request.destinationPath,
    tenant,
    scope,
    requester,
    requesterRoles: [...request.requesterRoles].sort(),
    runIds,
    registryVersion,
    redactionProfile:
      request.redactionProfile ?? DEFAULT_REDACTION_PROFILE,
    generatedAt,
    requestedAt,
    ...(request.hooks === undefined ? {} : { hooks: request.hooks })
  };
}

async function assertDestinationDoesNotExist(
  request: NormalizedAuditBundleRequest
) {
  try {
    await readdir(resolve(request.destinationPath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
  }

  const auditRecord = operationAuditRecord({
    action: "export_denied",
    request,
    reasonCode: "bundle_destination_exists",
    message: "Audit export destination already exists."
  });

  throw new AuditBundleError(
    "bundle_destination_exists",
    "Audit export destination already exists.",
    [auditRecord]
  );
}

async function prepareRun(
  request: NormalizedAuditBundleRequest,
  runId: string
): Promise<PreparedRun> {
  const events = await readEvents({
    rootDir: request.rootDir,
    runId
  });
  const eventRange = eventRangeFromEvents(events);

  if (eventRange.eventCount === 0) {
    const auditRecord = operationAuditRecord({
      action: "export_denied",
      request,
      reasonCode: "missing_event_range",
      message: `Run ${runId} has no authoritative event range.`
    });

    throw new AuditBundleError(
      "missing_event_range",
      `Run ${runId} has no authoritative event range.`,
      [auditRecord]
    );
  }

  const trace = await readOptionalTrace(request.rootDir, runId);
  const artifacts = await readOptionalProjection(() =>
    listArtifacts({
      rootDir: request.rootDir,
      runId
    })
  );
  const evidence = await readOptionalProjection(() =>
    listEvidence({
      rootDir: request.rootDir,
      runId
    })
  );
  const egress = enforceEgress(
    {
      events,
      ...(trace === undefined ? {} : { trace }),
      artifacts,
      evidence
    },
    {
      tenantScope: request.tenant,
      sink: "report",
      requester: request.requester,
      actor: request.requester,
      requestedAt: request.requestedAt,
      runId,
      ...(trace?.traceId === undefined ? {} : { traceId: trace.traceId }),
      subjectRefs: [`run:${runId}`, `audit-scope:${request.scope}`]
    },
    { profile: request.redactionProfile }
  );

  try {
    assertEgressAllowed(egress);
  } catch (error) {
    const auditRecord = operationAuditRecord({
      action: "export_denied",
      request,
      eventRange,
      reasonCode: "cross_tenant_export",
      message: errorMessage(error)
    });

    throw new AuditBundleError(
      "cross_tenant_export",
      `Run ${runId} cannot be exported under tenant ${request.tenant}: ${errorMessage(error)}`,
      [auditRecord]
    );
  }

  return {
    runId,
    events,
    eventRange,
    ...(trace === undefined ? {} : { trace }),
    artifacts,
    evidence
  };
}

async function buildAuditBundleChunk(
  request: NormalizedAuditBundleRequest,
  preparedRun: PreparedRun
): Promise<AuditBundleChunk> {
  const report = await generateReport({
    rootDir: request.rootDir,
    runId: preparedRun.runId,
    tenantScope: request.tenant,
    requester: request.requester,
    actor: request.requester,
    requestedAt: request.requestedAt,
    profile: request.redactionProfile
  });
  const reconciliation = report.reconciliation;
  const coverageVerdict =
    preparedRun.trace === undefined
      ? undefined
      : getCoverageVerdict({
          trace: preparedRun.trace,
          events: preparedRun.events
        });
  const attestation = attestationFromVerdicts({
    coverageVerdict,
    reconciliation,
    missingInputs: report.missingInputs
  });

  return {
    formatVersion: AUDIT_BUNDLE_FORMAT_VERSION,
    runId: preparedRun.runId,
    tenant: request.tenant,
    scope: request.scope,
    eventRange: preparedRun.eventRange,
    report: {
      version: RUN_REPORTS_VERSION,
      summaryPath: relative(
        resolve(request.rootDir ?? "."),
        report.summaryPath
      ),
      markdown: report.markdown,
      missingInputs: [...report.missingInputs].sort(),
      egressAuditRecords: report.egressAuditRecords ?? [],
      egressRestrictions: report.egressRestrictions ?? []
    },
    ...(coverageVerdict === undefined ? {} : { coverageVerdict }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
    attestation,
    trustLabels: trustLabelsForRun({
      request,
      preparedRun,
      report
    })
  };
}

function attestationFromVerdicts(input: {
  coverageVerdict?: CoverageVerdict | undefined;
  reconciliation?: ReconciliationResult | undefined;
  missingInputs: readonly string[];
}): BundleAttestation {
  const reasons: string[] = [];

  if (input.coverageVerdict === undefined) {
    reasons.push("coverage_verdict_unavailable");
  } else {
    if (!input.coverageVerdict.attributed) {
      reasons.push("trace_unattributed");
    }

    if (!input.coverageVerdict.complete) {
      reasons.push(
        ...input.coverageVerdict.gaps.map((gap) =>
          `coverage_${gap.reason}:${gap.message}`
        )
      );
    }
  }

  if (input.reconciliation === undefined) {
    reasons.push("reconciliation_unavailable");
  } else if (
    input.reconciliation.verdict !== "consistent" ||
    input.reconciliation.gaps.length > 0 ||
    input.reconciliation.mismatches.length > 0
  ) {
    reasons.push(
      `reconciliation_${input.reconciliation.verdict}`,
      ...input.reconciliation.gaps.map((gap) =>
        `gap_${gap.kind}:${gap.message}`
      ),
      ...input.reconciliation.mismatches.map((mismatch) =>
        `mismatch_${mismatch.kind}:${mismatch.message}`
      )
    );
  }

  if (input.missingInputs.includes("trace.json")) {
    reasons.push("missing_trace_input");
  }

  const uniqueReasons = uniqueStrings(reasons).sort();

  return uniqueReasons.length === 0
    ? { status: "attestable" }
    : { status: "non-attestable", reasons: uniqueReasons };
}

function trustLabelsForRun(input: {
  request: NormalizedAuditBundleRequest;
  preparedRun: PreparedRun;
  report: RunReport;
}): AuditBundleTrustLabels {
  return {
    authority: "derived",
    claimLevel: "audit_export",
    redactionClass: "operator",
    tenant: input.request.tenant,
    scope: input.request.scope,
    runId: input.preparedRun.runId,
    sourceRefs: [
      `events:${input.preparedRun.eventRange.firstSequence}-${input.preparedRun.eventRange.lastSequence}`,
      `report:${relative(
        resolve(input.request.rootDir ?? "."),
        input.report.summaryPath
      )}`
    ],
    evidenceRefs: evidenceRefsFromReport(input.report),
    artifactRefs: artifactRefsFromReport(input.report),
    ...(input.preparedRun.trace?.traceId === undefined
      ? {}
      : { traceId: input.preparedRun.trace.traceId })
  };
}

function evidenceRefsFromReport(report: RunReport): string[] {
  const refs = new Set<string>();

  for (const match of report.markdown.matchAll(/evidence:[A-Za-z0-9:_-]+/g)) {
    const ref = match[0];

    if (ref !== undefined) {
      refs.add(ref);
    }
  }

  return [...refs].sort();
}

function artifactRefsFromReport(report: RunReport): string[] {
  const refs = new Set<string>();

  for (const match of report.markdown.matchAll(/artifact-[A-Za-z0-9:_-]+/g)) {
    const ref = match[0];

    if (ref !== undefined) {
      refs.add(ref);
    }
  }

  return [...refs].sort();
}

function eventRangeFromEvents(events: readonly RuntimeEvent[]): BundleEventRange {
  if (events.length === 0) {
    return {
      firstSequence: 0,
      lastSequence: -1,
      eventCount: 0
    };
  }

  const sequences = events.map((event) => event.sequence);

  return {
    firstSequence: Math.min(...sequences),
    lastSequence: Math.max(...sequences),
    eventCount: events.length
  };
}

function aggregateEventRange(
  ranges: readonly BundleEventRange[]
): BundleEventRange {
  const nonEmpty = ranges.filter((range) => range.eventCount > 0);

  if (nonEmpty.length === 0) {
    return {
      firstSequence: 0,
      lastSequence: -1,
      eventCount: 0
    };
  }

  return {
    firstSequence: Math.min(...nonEmpty.map((range) => range.firstSequence)),
    lastSequence: Math.max(...nonEmpty.map((range) => range.lastSequence)),
    eventCount: nonEmpty.reduce((sum, range) => sum + range.eventCount, 0)
  };
}

function operationAuditRecord(input: {
  action: AuditBundleOperationAuditRecord["action"];
  request: Pick<
    NormalizedAuditBundleRequest,
    | "tenant"
    | "scope"
    | "requester"
    | "runIds"
    | "registryVersion"
    | "redactionProfile"
    | "requestedAt"
  >;
  eventRange?: BundleEventRange | undefined;
  manifestHash?: `sha256:${string}` | undefined;
  reasonCode?: AuditBundleErrorCode | undefined;
  message: string;
}): AuditBundleOperationAuditRecord {
  const subject = {
    action: input.action,
    tenant: input.request.tenant,
    scope: input.request.scope,
    runIds: input.request.runIds,
    eventRange: input.eventRange,
    manifestHash: input.manifestHash,
    reasonCode: input.reasonCode
  };

  return {
    recordKind: "audit_bundle_operation",
    action: input.action,
    requester: input.request.requester,
    tenant: input.request.tenant,
    scope: input.request.scope,
    runIds: [...input.request.runIds],
    ...(input.eventRange === undefined ? {} : { eventRange: input.eventRange }),
    registryVersion: input.request.registryVersion,
    redactionProfile: input.request.redactionProfile.id,
    ...(input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    timestamp: input.request.requestedAt,
    message: input.message,
    subjectRefs: [
      `tenant:${input.request.tenant}`,
      `scope:${input.request.scope}`,
      ...input.request.runIds.map((runId) => `run:${runId}`)
    ],
    subjectHashes: [hashAuditBundleCanonical(subject)]
  };
}

function requestError(
  code: AuditBundleErrorCode,
  message: string,
  request: {
    tenant: string;
    scope: string;
    requester: string;
    runIds: readonly string[];
    registryVersion: string;
    redactionProfile: RedactionProfile;
    requestedAt: string;
  }
): AuditBundleError {
  return new AuditBundleError(code, message, [
    operationAuditRecord({
      action: "export_denied",
      request,
      reasonCode: code,
      message
    })
  ]);
}

function assertBundleManifest(manifest: BundleManifest) {
  parseBundleManifest(manifest);
}

function parseChunkDescriptor(value: unknown): ChunkDescriptor {
  const record = recordFromUnknown(value);
  const runId = stringValue(record.runId);
  const chunkPath = stringValue(record.chunkPath);
  const chunkHash = hashValue(record.chunkHash);
  const eventRange = parseEventRange(record.eventRange);
  const attestation = parseAttestation(record.attestation);

  if (
    runId === undefined ||
    chunkPath === undefined ||
    chunkHash === undefined ||
    eventRange === undefined ||
    attestation === undefined
  ) {
    throw new AuditBundleError(
      "invalid_request",
      "Chunk descriptor is missing required fields."
    );
  }

  return {
    runId,
    chunkPath,
    chunkHash,
    eventRange,
    attestation
  };
}

function parseOperationAuditRecord(
  value: unknown
): AuditBundleOperationAuditRecord {
  const record = recordFromUnknown(value);
  const recordKind = stringValue(record.recordKind);
  const action = stringValue(record.action);
  const runIds = stringArray(record.runIds);
  const timestamp = stringValue(record.timestamp);
  const message = stringValue(record.message);
  const subjectRefs = stringArray(record.subjectRefs);
  const subjectHashes = stringArray(record.subjectHashes).flatMap((hash) =>
    isHash(hash) ? [hash] : []
  );

  if (
    recordKind !== "audit_bundle_operation" ||
    !isAuditAction(action) ||
    timestamp === undefined ||
    message === undefined ||
    subjectRefs.length === 0 ||
    subjectHashes.length === 0
  ) {
    throw new AuditBundleError(
      "invalid_request",
      "Audit bundle operation audit record is invalid."
    );
  }

  return {
    recordKind: "audit_bundle_operation",
    action,
    requester: stringValue(record.requester),
    tenant: stringValue(record.tenant),
    scope: stringValue(record.scope),
    runIds,
    eventRange: parseEventRange(record.eventRange),
    registryVersion: stringValue(record.registryVersion),
    redactionProfile: stringValue(record.redactionProfile),
    manifestHash: hashValue(record.manifestHash),
    reasonCode: parseAuditBundleErrorCode(record.reasonCode),
    timestamp,
    message,
    subjectRefs,
    subjectHashes
  };
}

function parseChunkReport(value: unknown): AuditBundleChunk["report"] | undefined {
  const record = recordFromUnknown(value);
  const version = stringValue(record.version);
  const summaryPath = stringValue(record.summaryPath);
  const markdown = stringValue(record.markdown);
  const missingInputs = stringArray(record.missingInputs);
  const egressAuditRecords = Array.isArray(record.egressAuditRecords)
    ? (record.egressAuditRecords as EgressAuditRecord[])
    : undefined;
  const egressRestrictions = Array.isArray(record.egressRestrictions)
    ? (record.egressRestrictions as RunReport["egressRestrictions"])
    : undefined;

  if (
    version !== RUN_REPORTS_VERSION ||
    summaryPath === undefined ||
    markdown === undefined ||
    egressAuditRecords === undefined ||
    egressRestrictions === undefined
  ) {
    return undefined;
  }

  return {
    version: RUN_REPORTS_VERSION,
    summaryPath,
    markdown,
    missingInputs,
    egressAuditRecords,
    egressRestrictions
  };
}

function parseTrustLabels(value: unknown): AuditBundleTrustLabels | undefined {
  const record = recordFromUnknown(value);
  const authority = stringValue(record.authority);
  const claimLevel = stringValue(record.claimLevel);
  const redactionClass = stringValue(record.redactionClass);
  const tenant = stringValue(record.tenant);
  const scope = stringValue(record.scope);
  const runId = stringValue(record.runId);
  const sourceRefs = stringArray(record.sourceRefs);
  const evidenceRefs = stringArray(record.evidenceRefs);
  const artifactRefs = stringArray(record.artifactRefs);

  if (
    authority !== "derived" ||
    claimLevel !== "audit_export" ||
    redactionClass !== "operator" ||
    tenant === undefined ||
    scope === undefined ||
    runId === undefined ||
    sourceRefs.length === 0
  ) {
    return undefined;
  }

  return {
    authority: "derived",
    claimLevel: "audit_export",
    redactionClass: "operator",
    tenant,
    scope,
    runId,
    sourceRefs,
    evidenceRefs,
    artifactRefs,
    traceId: stringValue(record.traceId)
  };
}

function parseAttestation(value: unknown): BundleAttestation | undefined {
  const record = recordFromUnknown(value);
  const status = stringValue(record.status);

  if (status === "attestable") {
    return { status };
  }

  if (status === "non-attestable") {
    const reasons = stringArray(record.reasons);

    return {
      status,
      reasons: reasons.length === 0 ? ["unspecified_gap"] : reasons
    };
  }

  return undefined;
}

function parseEventRange(value: unknown): BundleEventRange | undefined {
  const record = recordFromUnknown(value);
  const firstSequence = numberValue(record.firstSequence);
  const lastSequence = numberValue(record.lastSequence);
  const eventCount = numberValue(record.eventCount);

  if (
    firstSequence === undefined ||
    lastSequence === undefined ||
    eventCount === undefined
  ) {
    return undefined;
  }

  return {
    firstSequence,
    lastSequence,
    eventCount
  };
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStable);
  }

  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const normalizedValue = normalizeStable(value[key]);

      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
    }

    return normalized;
  }

  return value;
}

function hashAuditBundleCanonicalText(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function generateReport(input: {
  rootDir?: string | undefined;
  runId: string;
  tenantScope: string;
  requester: string;
  actor: string;
  requestedAt: string;
  profile: RedactionProfile;
}): Promise<RunReport> {
  const reportModule = await import("./index");

  return reportModule.generateRunReport(input);
}

async function readOptionalTrace(
  rootDir: string | undefined,
  runId: string
): Promise<TraceFile | undefined> {
  try {
    return await readTrace({
      rootDir,
      runId
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    return undefined;
  }
}

async function readOptionalProjection<TValue>(
  read: () => Promise<TValue[]>
): Promise<TValue[]> {
  try {
    return await read();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeTextAtomic(path: string, value: string) {
  const tempPath = `${path}.${randomUUID()}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, value, { flag: "wx" });
  await rename(tempPath, path);
}

function safeChunkFileName(runId: string) {
  return encodeURIComponent(runId);
}

function hasExportRole(roles: readonly string[]) {
  const roleSet = new Set(roles);

  return roleSet.has("auditor") || roleSet.has("operator");
}

function normalizeTimestamp(value: Date | string | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return new Date().toISOString();
}

function parseAuditBundleErrorCode(
  value: unknown
): AuditBundleErrorCode | undefined {
  if (
    value === "invalid_request" ||
    value === "unscoped_export" ||
    value === "unauthorized_export" ||
    value === "duplicate_run" ||
    value === "cross_tenant_export" ||
    value === "missing_event_range" ||
    value === "bundle_destination_exists" ||
    value === "assembly_failed"
  ) {
    return value;
  }

  return undefined;
}

function isAuditAction(
  value: string | undefined
): value is AuditBundleOperationAuditRecord["action"] {
  return (
    value === "export_sealed" ||
    value === "export_denied" ||
    value === "export_discarded"
  );
}

function hashValue(value: unknown): `sha256:${string}` | undefined {
  return typeof value === "string" && isHash(value) ? value : undefined;
}

function isHash(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
