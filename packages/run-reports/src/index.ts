import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { getArtifactStorePaths, listArtifacts } from "@specwright/artifact-store";
import { getEvidenceStorePaths, listEvidence } from "@specwright/evidence-store";
import {
  DEFAULT_REDACTION_PROFILE,
  getRunStorePaths,
  readEvents,
  redactForEgress,
  type RedactionEgressMode,
  type RedactionGrant,
  type RedactionProfile,
  type RunStorePaths
} from "@specwright/run-store";
import {
  ArtifactRecordSchema,
  EvalVerdictSchema,
  EvidenceRecordSchema,
  type ArtifactRecord,
  type EvalVerdict,
  type EvidenceRecord,
  type RuntimeEvent
} from "@specwright/schemas";
import { readTrace, type TraceFile, type TraceSpan } from "@specwright/trace-recorder";
import type { IntegrityMetric } from "./integrity-metrics";
import {
  reconcileEventsAndTrace,
  type ReconciliationResult
} from "./reconciliation";

export {
  computeIntegrityMetrics,
  type ComputeIntegrityMetricsInput,
  type IntegrityMetric,
  type IntegrityMetricClass,
  type SourceEventRange
} from "./integrity-metrics";
export {
  reconcileEventsAndTrace,
  type MandatoryCoverageRecord,
  type MandatoryCoverageStatus,
  type ReconcileEventsAndTraceInput,
  type ReconciliationGap,
  type ReconciliationGapKind,
  type ReconciliationMismatch,
  type ReconciliationResult,
  type ReconciliationVerdict
} from "./reconciliation";

export const RUN_REPORTS_VERSION = "0.1.0";

export type GenerateRunReportOptions = {
  rootDir?: string | undefined;
  runId: string;
  profile?: RedactionProfile;
  grant?: RedactionGrant;
  mode?: RedactionEgressMode;
};

export type WriteRunReportOptions = GenerateRunReportOptions;

export type RunReport = {
  runId: string;
  summaryPath: string;
  markdown: string;
  missingInputs: string[];
  reconciliation?: ReconciliationResult;
  integrityMetrics?: IntegrityMetric[];
};

type RunFacts = {
  authoritativeEvents: RuntimeEvent[];
  events: ReportEvent[];
  rawTrace?: TraceFile | undefined;
  trace?: TraceFile | undefined;
  artifacts: unknown[];
  evidence: unknown[];
  evalFileVerdicts: EvalVerdict[];
  missingInputs: string[];
  paths: RunStorePaths;
  redactionProfileId: string;
};

type ReportEvent = {
  id: string;
  runId: string;
  type: string;
  timestamp: string;
  sequence: number;
  traceId: string;
  contractId?: string;
  contractVersion?: string;
  schemaHash?: string;
  causationId?: string;
  correlationId?: string;
  integrity?: RuntimeEvent["integrity"];
  payload: unknown;
};

type GateSummary = {
  gateId: string;
  status: string;
  severity?: string | undefined;
  reasons: string[];
  instruction?: string | undefined;
};

type ToolSummary = {
  key: string;
  toolId: string;
  status: string;
  phase?: string | undefined;
  cacheStatus?: string | undefined;
  policyStatus?: string | undefined;
  argsHash?: string | undefined;
  resultHash?: string | undefined;
  durationMs?: number | undefined;
  eventIds: string[];
};

type EvidenceReportRecord = {
  id: string;
  class: string;
  claim: unknown;
  sourceRefs: unknown[];
  confidence: string;
  authority: string;
};

export async function generateRunReport(
  options: GenerateRunReportOptions
): Promise<RunReport> {
  const facts = await loadRunFacts(options);
  const markdown = renderReport(facts);
  const reconciliation = reconcileFacts(facts);

  return {
    runId: options.runId,
    summaryPath: facts.paths.summaryPath,
    markdown,
    missingInputs: facts.missingInputs,
    reconciliation,
    integrityMetrics: reconciliation.integrityMetrics
  };
}

export async function reconcileRun(
  options: GenerateRunReportOptions
): Promise<ReconciliationResult> {
  return reconcileFacts(await loadRunFacts(options));
}

export async function writeRunReport(
  options: WriteRunReportOptions
): Promise<RunReport> {
  const report = await generateRunReport(options);

  await writeSummary({
    rootDir: options.rootDir,
    runId: options.runId,
    markdown: report.markdown
  });

  return report;
}

export async function readRunSummary(
  options: GenerateRunReportOptions
): Promise<string> {
  const paths = getRunStorePaths(options.rootDir, options.runId);

  return readFile(paths.summaryPath, "utf8");
}

export async function writeSummary(options: GenerateRunReportOptions & {
  markdown: string;
}): Promise<string> {
  const paths = getRunStorePaths(options.rootDir, options.runId);

  await mkdir(dirname(paths.summaryPath), { recursive: true });
  await writeTextAtomic(paths.summaryPath, ensureTrailingNewline(options.markdown));

  return paths.summaryPath;
}

async function loadRunFacts(options: GenerateRunReportOptions): Promise<RunFacts> {
  const paths = getRunStorePaths(options.rootDir, options.runId);
  const redactionOptions = redactionOptionsFromReportOptions(options);
  const authoritativeEvents = await readEvents({
    rootDir: options.rootDir,
    runId: options.runId
  });
  const events = authoritativeEvents.map((event) =>
    redactReportEvent(event, redactionOptions)
  );
  const missingInputs: string[] = [];
  const rawTrace = await optional("trace.json", missingInputs, async () =>
    readTrace({
      rootDir: options.rootDir,
      runId: options.runId
    })
  );
  const trace =
    rawTrace === undefined ? undefined : redactTrace(rawTrace, redactionOptions);
  const artifacts = await optionalIndexedRecords(
    "artifacts/index.jsonl",
    getArtifactStorePaths(options.rootDir, options.runId).indexPath,
    missingInputs,
    async () =>
      (await listArtifacts({
        rootDir: options.rootDir,
        runId: options.runId
      })).map((artifact) => redactForEgress(artifact, redactionOptions))
  );
  const evidence = await optionalIndexedRecords(
    "evidence/index.jsonl",
    getEvidenceStorePaths(options.rootDir, options.runId).indexPath,
    missingInputs,
    async () =>
      (await listEvidence({
        rootDir: options.rootDir,
        runId: options.runId
      })).map((record) => redactForEgress(record, redactionOptions))
  );
  const evalFileVerdicts = await optional("evals/*.json", missingInputs, () =>
    readEvalVerdictsFromFiles(paths.evalsDir)
  );

  return {
    authoritativeEvents,
    events,
    rawTrace,
    trace,
    artifacts: artifacts ?? [],
    evidence: evidence ?? [],
    evalFileVerdicts: evalFileVerdicts ?? [],
    missingInputs,
    paths,
    redactionProfileId: (options.profile ?? DEFAULT_REDACTION_PROFILE).id
  };
}

function reconcileFacts(facts: RunFacts): ReconciliationResult {
  return reconcileEventsAndTrace({
    events: facts.authoritativeEvents,
    trace: facts.rawTrace,
    missingInputs: facts.missingInputs,
    schemaValidationFailures: 0
  });
}

function redactReportEvent(
  event: RuntimeEvent,
  options: RedactReportOptions
): ReportEvent {
  const redacted = redactForEgress(event, options);
  const record = recordFromUnknown(redacted);

  return {
    id: event.id,
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    sequence: event.sequence,
    traceId: event.traceId,
    ...(event.contractId === undefined ? {} : { contractId: event.contractId }),
    ...(event.contractVersion === undefined
      ? {}
      : { contractVersion: event.contractVersion }),
    ...(event.schemaHash === undefined ? {} : { schemaHash: event.schemaHash }),
    ...(event.causationId === undefined
      ? {}
      : { causationId: event.causationId }),
    ...(event.correlationId === undefined
      ? {}
      : { correlationId: event.correlationId }),
    ...(event.integrity === undefined ? {} : { integrity: event.integrity }),
    payload: record.payload
  };
}

function redactTrace(
  trace: TraceFile,
  options: RedactReportOptions
): TraceFile {
  const redacted = redactForEgress(trace, options);

  return traceFileFromUnknown(redacted, trace);
}

type RedactReportOptions = {
  profile?: RedactionProfile;
  grant?: RedactionGrant;
  mode?: RedactionEgressMode;
};

function redactionOptionsFromReportOptions(
  options: GenerateRunReportOptions
): RedactReportOptions {
  return {
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.grant === undefined ? {} : { grant: options.grant }),
    ...(options.mode === undefined ? {} : { mode: options.mode })
  };
}

function renderReport(facts: RunFacts) {
  const runStarted = facts.events.find((event) => event.type === "run.started");
  const runInput = recordFromUnknown(recordFromUnknown(runStarted?.payload).input);
  const harness = harnessFromFacts(facts);
  const status = runStatusFromEvents(facts.events);
  const phases = phaseSummaries(facts.events, facts.trace);
  const gates = gateSummaries(facts.events, facts.trace);
  const tools = toolSummaries(facts.events, facts.trace);
  const evals = evalSummaries(facts.events, facts.evalFileVerdicts, facts.trace);
  const artifacts = artifactSummaries(facts.events, facts.artifacts);
  const evidence = evidenceSummaries(facts.events, facts.evidence);
  const decisions = decisionSummaries(facts.events);
  const unknowns = unknownSummaries({
    evidence,
    artifacts,
    evals,
    gates,
    decisions
  });
  const relativeRunPackage = relative(facts.paths.rootDir, facts.paths.runDir);
  const lines: string[] = [];

  lines.push("# Run Summary");
  lines.push("");
  lines.push(`- Run: \`${facts.events[0]?.runId ?? facts.paths.runDir}\``);
  lines.push(`- Status: ${status}`);
  lines.push(`- Task: ${formatText(runInput.task)}`);
  lines.push(`- Harness: ${formatHarness(harness)}`);
  lines.push(`- Host: ${formatHost(recordFromUnknown(runInput.host))}`);
  lines.push(`- Replayable run package: \`${relativeRunPackage}\``);
  lines.push("");
  lines.push("## Phases Executed");
  lines.push(...bulletOrNone(phases, "No phase transitions were recorded."));
  lines.push("");
  lines.push("## Gates");
  lines.push(...bulletOrNone(gates, "No gate verdicts were recorded."));
  lines.push("");
  lines.push("## Tools");
  lines.push(...bulletOrNone(tools, "No tool calls were recorded."));
  lines.push("");
  lines.push("## Evals");
  lines.push(...bulletOrNone(evals, "No eval verdicts were recorded."));
  lines.push("");
  lines.push("## Artifacts");
  lines.push(...bulletOrNone(artifacts, "No artifacts were recorded."));
  lines.push("");
  lines.push("## Evidence And Unknowns");
  lines.push(...bulletOrNone(evidence, "No evidence records were available."));
  lines.push("");
  lines.push("## Decisions");
  lines.push(...bulletOrNone(decisions, "No human or runtime decisions were recorded."));
  lines.push("");
  lines.push("## What Remains Unknown");
  lines.push(...bulletOrNone(unknowns, "No unknowns were recorded."));
  lines.push("");
  lines.push("## Observability Inputs");
  lines.push(...observabilityLines(facts));

  return ensureTrailingNewline(lines.join("\n"));
}

function harnessFromFacts(facts: RunFacts) {
  const started = facts.events.find((event) => event.type === "run.started");
  const startedHarness = recordFromUnknown(recordFromUnknown(started?.payload).harness);
  const loaded = facts.events.find((event) => event.type === "harness.loaded");
  const loadedHarness = recordFromUnknown(recordFromUnknown(loaded?.payload).harness);
  const traceHarness =
    facts.trace?.harnessSpecHash === undefined
      ? {}
      : { specHash: facts.trace.harnessSpecHash };

  return {
    ...startedHarness,
    ...loadedHarness,
    ...traceHarness
  };
}

function runStatusFromEvents(events: readonly ReportEvent[]) {
  if (events.some((event) => event.type === "run.failed")) {
    return "failed";
  }

  if (events.some((event) => event.type === "run.completed")) {
    return "completed";
  }

  return "running";
}

function phaseSummaries(events: readonly ReportEvent[], trace?: TraceFile) {
  const eventPhases = events
    .filter(
      (event) =>
        event.type === "phase.entered" || event.type === "phase.transitioned"
    )
    .map((event) => {
      const payload = recordFromUnknown(event.payload);
      const phase = firstString(payload, ["phase", "toPhase", "to"]) ?? "unknown";
      return `- ${phase} (${event.type}, seq ${event.sequence})`;
    });
  const tracedPhases =
    trace?.spans
      .filter((span) => span.kind === "phase")
      .map((span) => `- ${span.name}: ${span.status}${durationSuffix(span)}`) ??
    [];

  return uniqueLines([...eventPhases, ...tracedPhases]);
}

function gateSummaries(events: readonly ReportEvent[], trace?: TraceFile) {
  const gates = new Map<string, GateSummary>();

  for (const event of events) {
    if (event.type !== "gate.evaluated") {
      continue;
    }

    const payload = recordFromUnknown(event.payload);
    const verdict = recordFromUnknown(payload.verdict ?? event.payload);
    const gateId =
      stringValue(verdict.gateId) ??
      stringValue(payload.gateId) ??
      `gate.seq.${event.sequence}`;
    gates.set(gateId, {
      gateId,
      status: stringValue(verdict.status) ?? "unknown",
      severity: stringValue(verdict.severity),
      reasons: stringArray(verdict.reasons),
      instruction: stringValue(recordFromUnknown(payload.instruction).kind),
    });
  }

  for (const span of trace?.spans ?? []) {
    if (span.kind !== "gate") {
      continue;
    }

    const gateId = stringValue(span.metadata.gateId) ?? span.name;
    const existing = gates.get(gateId);

    if (existing === undefined) {
      gates.set(gateId, {
        gateId,
        status: span.status,
        reasons: [],
        instruction: undefined
      });
    }
  }

  return [...gates.values()].map((gate) => {
    const details = [
      gate.severity,
      gate.instruction === undefined ? undefined : `instruction ${gate.instruction}`,
      gate.reasons.length === 0 ? undefined : gate.reasons.join("; ")
    ].filter((value): value is string => value !== undefined);

    return `- ${gate.gateId}: ${gate.status}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
  });
}

function toolSummaries(events: readonly ReportEvent[], trace?: TraceFile) {
  const tools = new Map<string, ToolSummary>();

  for (const event of events) {
    if (
      event.type !== "tool.requested" &&
      event.type !== "tool.authorized" &&
      event.type !== "tool.denied" &&
      event.type !== "tool.completed"
    ) {
      continue;
    }

    const payload = recordFromUnknown(event.payload);
    const request = recordFromUnknown(payload.request);
    const result = recordFromUnknown(payload.result);
    const provenance = recordFromUnknown(result.provenance);
    const toolCallId = stringValue(result.toolCallId);
    const toolId =
      stringValue(request.toolId) ??
      stringValue(provenance.toolId) ??
      `tool.seq.${event.sequence}`;
    const key = toolCallId ?? stringValue(request.idempotencyKey) ?? toolId;
    const existing = tools.get(key);
    const argsHash =
      redactedReferenceHash(request.args) ??
      stringValue(provenance.argsHash) ??
      existing?.argsHash;
    const resultHash =
      redactedReferenceHash(result.output) ??
      redactedReferenceHash(result.result) ??
      stringValue(provenance.resultHash) ??
      existing?.resultHash;
    const eventIds = [...(existing?.eventIds ?? []), event.id];

    tools.set(key, {
      key,
      toolId,
      status:
        stringValue(result.status) ??
        (event.type === "tool.requested" ? "requested" : event.type.replace("tool.", "")),
      phase:
        stringValue(recordFromUnknown(request.requestedBy).phase) ??
        existing?.phase,
      cacheStatus:
        stringValue(provenance.cacheStatus) ??
        existing?.cacheStatus,
      policyStatus:
        stringValue(payload.policyStatus) ??
        existing?.policyStatus,
      argsHash,
      resultHash,
      durationMs: existing?.durationMs,
      eventIds
    });
  }

  for (const span of trace?.spans ?? []) {
    if (span.kind !== "tool") {
      continue;
    }

    const toolCallId = stringValue(span.metadata.toolCallId);
    const toolId = stringValue(span.metadata.toolId) ?? span.name;
    const key = toolCallId ?? toolId;
    const existing = tools.get(key);
    const argsHash =
      redactedReferenceHash(span.metadata.args) ??
      stringValue(span.metadata.argsHash) ??
      existing?.argsHash;
    const resultHash =
      redactedReferenceHash(span.metadata.output) ??
      redactedReferenceHash(span.metadata.result) ??
      stringValue(span.metadata.resultHash) ??
      existing?.resultHash;

    tools.set(key, {
      key,
      toolId,
      status: span.status,
      phase: stringValue(span.metadata.phaseId) ?? existing?.phase,
      cacheStatus:
        stringValue(span.metadata.cacheStatus) ??
        existing?.cacheStatus,
      policyStatus:
        stringValue(span.metadata.policyStatus) ??
        existing?.policyStatus,
      argsHash,
      resultHash,
      durationMs: span.durationMs ?? existing?.durationMs,
      eventIds: uniqueStrings([...(existing?.eventIds ?? []), ...(span.eventIds ?? [])])
    });
  }

  return [...tools.values()].map((tool) => {
    const details = [
      tool.phase === undefined ? undefined : `phase ${tool.phase}`,
      tool.cacheStatus === undefined ? undefined : `cache ${tool.cacheStatus}`,
      tool.policyStatus === undefined ? undefined : `policy ${tool.policyStatus}`,
      tool.argsHash === undefined ? undefined : `args ${tool.argsHash}`,
      tool.resultHash === undefined ? undefined : `result ${tool.resultHash}`,
      tool.durationMs === undefined ? undefined : `${tool.durationMs}ms`
    ].filter((value): value is string => value !== undefined);

    return `- ${tool.toolId}: ${tool.status}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
  });
}

function evalSummaries(
  events: readonly ReportEvent[],
  fileVerdicts: readonly EvalVerdict[],
  trace?: TraceFile
) {
  const evals = new Map<string, EvalVerdict>();

  for (const event of events) {
    if (event.type !== "eval.completed") {
      continue;
    }

    const verdict = evalVerdictFromUnknown(event.payload);

    if (verdict !== undefined) {
      evals.set(verdict.evalId, verdict);
    }
  }

  for (const verdict of fileVerdicts) {
    evals.set(verdict.evalId, verdict);
  }

  const lines = [...evals.values()].map((verdict) => {
    const findingText =
      verdict.findings.length === 0
        ? undefined
        : `${verdict.findings.length} finding(s)`;
    const evidenceText =
      verdict.evidenceRefs.length === 0
        ? undefined
        : `evidence ${verdict.evidenceRefs.join(", ")}`;
    const details = [verdict.severity, `target ${verdict.targetRef}`, findingText, evidenceText];

    return `- ${verdict.evalId}: ${verdict.status} (${details.filter(Boolean).join(", ")})`;
  });
  const traced =
    trace?.spans
      .filter((span) => span.kind === "eval" && !evals.has(stringValue(span.metadata.evalId) ?? span.name))
      .map((span) => `- ${stringValue(span.metadata.evalId) ?? span.name}: ${span.status}${durationSuffix(span)}`) ??
    [];

  return [...lines, ...traced];
}

function artifactSummaries(
  events: readonly ReportEvent[],
  artifactRecords: readonly unknown[]
) {
  const artifacts = new Map<string, {
    artifactId: string;
    artifactType: string;
    evidenceRefs: string[];
    uri?: unknown;
    claimLevel?: string | undefined;
  }>();

  for (const record of artifactRecords) {
    const artifact = artifactSummaryFromUnknown(record);

    if (artifact !== undefined) {
      artifacts.set(artifact.artifactId, artifact);
    }
  }

  for (const event of events) {
    if (event.type !== "artifact.recorded") {
      continue;
    }

    const artifact = artifactRefFromEvent(event);

    if (artifact === undefined) {
      continue;
    }

    const existing = artifacts.get(artifact.artifactId);

    artifacts.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      evidenceRefs: uniqueStrings([
        ...(existing?.evidenceRefs ?? []),
        ...artifact.evidenceRefs
      ]),
      uri: existing?.uri ?? artifact.uri,
      claimLevel: existing?.claimLevel ?? artifact.claimLevel
    });
  }

  return [...artifacts.values()].map((artifact) => {
    const details = [
      formatEgressValue(artifact.uri),
      artifact.evidenceRefs.length === 0
        ? "no evidence refs"
        : `evidence ${artifact.evidenceRefs.join(", ")}`,
      artifact.claimLevel === undefined ? undefined : `claim ${artifact.claimLevel}`
    ].filter((value): value is string => value !== undefined);

    return `- ${artifact.artifactId} (${artifact.artifactType}): ${details.join(", ")}`;
  });
}

function evidenceSummaries(
  events: readonly ReportEvent[],
  evidenceRecords: readonly unknown[]
) {
  const evidence = new Map<string, EvidenceReportRecord>();

  for (const record of evidenceRecords) {
    const summary = evidenceReportRecordFromUnknown(record);

    if (summary !== undefined) {
      evidence.set(summary.id, summary);
    }
  }

  for (const event of events) {
    if (event.type !== "evidence.recorded") {
      continue;
    }

    const record = evidenceRecordFromEvent(event);

    if (record !== undefined) {
      evidence.set(record.id, record);
    }
  }

  return [...evidence.values()].map((record) => {
    const sourceText =
      record.sourceRefs.length === 0
        ? "no source refs"
        : `${record.sourceRefs.length} source ref(s)`;
    return `- ${record.id}: ${record.class}/${record.confidence}/${record.authority} - ${formatEgressValue(record.claim) ?? "unknown"} (${sourceText})`;
  });
}

function decisionSummaries(events: readonly ReportEvent[]) {
  return events
    .filter(
      (event) =>
        event.type === "decision.recorded" ||
        event.type === "human.answer_recorded" ||
        event.type === "human.input_requested" ||
        event.type === "policy.evaluated"
    )
    .map((event) => {
      const payload = recordFromUnknown(event.payload);
      const decision =
        stringValue(payload.decision) ??
        stringValue(payload.status) ??
        stringValue(recordFromUnknown(payload.verdict).status) ??
        event.type;
      const subject =
        stringValue(payload.decisionId) ??
        stringValue(payload.approvalId) ??
        stringValue(payload.questionId) ??
        stringValue(payload.requestId) ??
        `seq ${event.sequence}`;

      return `- ${event.type}: ${subject} -> ${decision}`;
    });
}

function unknownSummaries(input: {
  evidence: readonly string[];
  artifacts: readonly string[];
  evals: readonly string[];
  gates: readonly string[];
  decisions: readonly string[];
}) {
  const unknowns: string[] = [];

  for (const line of input.evidence) {
    if (line.includes(": unknown/") || line.includes(": assumption/")) {
      unknowns.push(line.replace(/^- /, "- evidence "));
    }
  }

  for (const line of input.artifacts) {
    if (line.includes("claim unknown") || line.includes("claim assumption")) {
      unknowns.push(line.replace(/^- /, "- artifact "));
    }
  }

  for (const line of input.evals) {
    if (line.includes(": fail") || line.includes(": needs_review")) {
      unknowns.push(line.replace(/^- /, "- eval "));
    }
  }

  for (const line of input.gates) {
    if (line.includes(": fail") || line.includes(": needs_review")) {
      unknowns.push(line.replace(/^- /, "- gate "));
    }
  }

  for (const line of input.decisions) {
    if (line.includes("human.input_requested")) {
      unknowns.push(line.replace(/^- /, "- pending "));
    }
  }

  return uniqueLines(unknowns);
}

function observabilityLines(facts: RunFacts) {
  const lines = [
    `- events.jsonl: ${facts.events.length} event(s)`,
    `- trace.json: ${facts.trace === undefined ? "missing" : `${facts.trace.spans.length} span(s)`}`,
    `- artifacts: ${facts.artifacts.length} record(s)`,
    `- evidence: ${facts.evidence.length} record(s)`,
    `- evals: ${facts.evalFileVerdicts.length} file verdict(s)`,
    `- redaction profile: ${facts.redactionProfileId}`
  ];

  if (facts.missingInputs.length > 0) {
    lines.push(`- missing optional inputs: ${facts.missingInputs.join(", ")}`);
  }

  return lines;
}

async function readEvalVerdictsFromFiles(evalsDir: string) {
  const entries = await readdir(evalsDir, { withFileTypes: true });
  const verdicts: EvalVerdict[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const raw = await readFile(join(evalsDir, entry.name), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const verdict = evalVerdictFromUnknown(parsed);

    if (verdict !== undefined) {
      verdicts.push(verdict);
    }
  }

  return verdicts;
}

async function optional<TValue>(
  label: string,
  missingInputs: string[],
  read: () => Promise<TValue>
): Promise<TValue | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      missingInputs.push(label);
      return undefined;
    }

    throw error;
  }
}

async function optionalIndexedRecords<TValue>(
  label: string,
  indexPath: string,
  missingInputs: string[],
  read: () => Promise<TValue>
): Promise<TValue | undefined> {
  try {
    await readFile(indexPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      missingInputs.push(label);
      return undefined;
    }

    throw error;
  }

  return read();
}

function evalVerdictFromUnknown(value: unknown): EvalVerdict | undefined {
  const payload = recordFromUnknown(value);
  const candidates = [payload.verdict, payload.result, value];

  for (const candidate of candidates) {
    const parsed = EvalVerdictSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function artifactRefFromEvent(event: ReportEvent) {
  const payload = recordFromUnknown(event.payload);
  const candidates = [payload.artifact, payload.artifactRef, payload.ref, event.payload];

  for (const candidate of candidates) {
    const parsedRecord = ArtifactRecordSchema.safeParse(candidate);

    if (parsedRecord.success) {
      return {
        artifactId: parsedRecord.data.artifactId,
        artifactType: parsedRecord.data.artifactType,
        evidenceRefs: parsedRecord.data.evidenceRefs,
        uri: parsedRecord.data.fileRef?.uri,
        claimLevel: parsedRecord.data.claimLevel
      };
    }

    const artifact = artifactSummaryFromUnknown(candidate);

    if (artifact !== undefined) {
      return artifact;
    }
  }

  return undefined;
}

function evidenceRecordFromEvent(event: ReportEvent): EvidenceReportRecord | undefined {
  const payload = recordFromUnknown(event.payload);
  const candidates = [payload.evidence, payload.record, event.payload];

  for (const candidate of candidates) {
    const parsed = EvidenceRecordSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }

    const record = evidenceReportRecordFromUnknown(candidate);

    if (record !== undefined) {
      return record;
    }
  }

  return undefined;
}

function artifactSummaryFromUnknown(value: unknown) {
  const record = recordFromUnknown(value);
  const artifactId = stringValue(record.artifactId);
  const artifactType = stringValue(record.artifactType);

  if (artifactId === undefined || artifactType === undefined) {
    return undefined;
  }

  const fileRef = recordFromUnknown(record.fileRef);

  return {
    artifactId,
    artifactType,
    evidenceRefs: stringArray(record.evidenceRefs),
    uri: record.uri ?? fileRef.uri,
    claimLevel: stringValue(record.claimLevel)
  };
}

function evidenceReportRecordFromUnknown(
  value: unknown
): EvidenceReportRecord | undefined {
  const record = recordFromUnknown(value);
  const id = stringValue(record.id);
  const evidenceClass = stringValue(record.class);
  const confidence = stringValue(record.confidence);
  const authority = stringValue(record.authority);

  if (
    id === undefined ||
    evidenceClass === undefined ||
    confidence === undefined ||
    authority === undefined
  ) {
    return undefined;
  }

  return {
    id,
    class: evidenceClass,
    claim: record.claim,
    sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs : [],
    confidence,
    authority
  };
}

function bulletOrNone(lines: readonly string[], fallback: string) {
  return lines.length === 0 ? [`- ${fallback}`] : [...lines];
}

function durationSuffix(span: TraceSpan) {
  return span.durationMs === undefined ? "" : ` (${span.durationMs}ms)`;
}

function formatHarness(harness: Record<string, unknown>) {
  const id = stringValue(harness.id) ?? "unknown";
  const version = stringValue(harness.version);
  const specHash = stringValue(harness.specHash);
  const versionText = version === undefined ? "" : `@${version}`;
  const hashText = specHash === undefined ? "" : ` (${specHash})`;

  return `\`${id}${versionText}\`${hashText}`;
}

function formatHost(host: Record<string, unknown>) {
  const kind = stringValue(host.kind);
  const version = stringValue(host.version);

  if (kind === undefined) {
    return "unknown";
  }

  return version === undefined ? kind : `${kind}@${version}`;
}

function formatText(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function formatEgressValue(value: unknown) {
  const hash = redactedReferenceHash(value);

  if (hash !== undefined) {
    return hash;
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return undefined;
}

function redactedReferenceHash(value: unknown) {
  const record = recordFromUnknown(value);

  if (record.redacted !== true) {
    return undefined;
  }

  return stringValue(record.hash);
}

function traceFileFromUnknown(value: unknown, fallback: TraceFile): TraceFile {
  const record = recordFromUnknown(value);
  const spans = Array.isArray(record.spans)
    ? record.spans.map((span, index) =>
        traceSpanFromUnknown(span, fallback.spans[index])
      )
    : fallback.spans;

  return {
    runId: stringValue(record.runId) ?? fallback.runId,
    traceId: stringValue(record.traceId) ?? fallback.traceId,
    ...(record.runtimeVersion === undefined
      ? fallback.runtimeVersion === undefined
        ? {}
        : { runtimeVersion: fallback.runtimeVersion }
      : { runtimeVersion: stringValue(record.runtimeVersion) ?? fallback.runtimeVersion }),
    ...(record.harnessSpecHash === undefined
      ? fallback.harnessSpecHash === undefined
        ? {}
        : { harnessSpecHash: fallback.harnessSpecHash }
      : { harnessSpecHash: stringValue(record.harnessSpecHash) ?? fallback.harnessSpecHash }),
    ...(record.hostAdapter === undefined
      ? fallback.hostAdapter === undefined
        ? {}
        : { hostAdapter: fallback.hostAdapter }
      : { hostAdapter: stringValue(record.hostAdapter) ?? fallback.hostAdapter }),
    spans,
    metadata: recordFromUnknown(record.metadata)
  };
}

function traceSpanFromUnknown(
  value: unknown,
  fallback: TraceSpan | undefined
): TraceSpan {
  const record = recordFromUnknown(value);
  const fallbackMetadata = fallback?.metadata ?? {};
  const span: TraceSpan = {
    runId: stringValue(record.runId) ?? fallback?.runId ?? "unknown",
    traceId: stringValue(record.traceId) ?? fallback?.traceId ?? "unknown",
    spanId: stringValue(record.spanId) ?? fallback?.spanId ?? "unknown",
    kind: fallback?.kind ?? "phase",
    name: stringValue(record.name) ?? fallback?.name ?? "unknown",
    status: fallback?.status ?? "success",
    startedAt: stringValue(record.startedAt) ?? fallback?.startedAt ?? "unknown",
    metadata: {
      ...fallbackMetadata,
      ...recordFromUnknown(record.metadata)
    }
  };
  const parentSpanId = stringValue(record.parentSpanId) ?? fallback?.parentSpanId;
  const endedAt = stringValue(record.endedAt) ?? fallback?.endedAt;
  const durationMs =
    typeof record.durationMs === "number" ? record.durationMs : fallback?.durationMs;
  const eventIds = Array.isArray(record.eventIds)
    ? stringArray(record.eventIds)
    : fallback?.eventIds;

  if (parentSpanId !== undefined) {
    span.parentSpanId = parentSpanId;
  }

  if (endedAt !== undefined) {
    span.endedAt = endedAt;
  }

  if (durationMs !== undefined) {
    span.durationMs = durationMs;
  }

  if (eventIds !== undefined) {
    span.eventIds = eventIds;
  }

  return span;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = stringValue(record[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
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

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function uniqueLines(values: readonly string[]) {
  return [...new Set(values)];
}

function ensureTrailingNewline(value: string) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function writeTextAtomic(path: string, value: string) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, value, { flag: "wx" });
  await rename(tempPath, path);
}

function isNodeError(error: unknown): error is { code: string } {
  return recordFromUnknown(error).code !== undefined;
}
