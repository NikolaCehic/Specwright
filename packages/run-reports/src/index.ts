import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { getArtifactStorePaths, listArtifacts } from "@specwright/artifact-store";
import { getEvidenceStorePaths, listEvidence } from "@specwright/evidence-store";
import {
  getRunStorePaths,
  readEvents,
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

export const RUN_REPORTS_VERSION = "0.1.0";

export type GenerateRunReportOptions = {
  rootDir?: string | undefined;
  runId: string;
};

export type WriteRunReportOptions = GenerateRunReportOptions;

export type RunReport = {
  runId: string;
  summaryPath: string;
  markdown: string;
  missingInputs: string[];
};

type RunFacts = {
  events: RuntimeEvent[];
  trace?: TraceFile | undefined;
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
  evalFileVerdicts: EvalVerdict[];
  missingInputs: string[];
  paths: RunStorePaths;
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
  durationMs?: number | undefined;
  eventIds: string[];
};

export async function generateRunReport(
  options: GenerateRunReportOptions
): Promise<RunReport> {
  const facts = await loadRunFacts(options);
  const markdown = renderReport(facts);

  return {
    runId: options.runId,
    summaryPath: facts.paths.summaryPath,
    markdown,
    missingInputs: facts.missingInputs
  };
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
  const events = await readEvents({
    rootDir: options.rootDir,
    runId: options.runId
  });
  const missingInputs: string[] = [];
  const trace = await optional("trace.json", missingInputs, () =>
    readTrace({
      rootDir: options.rootDir,
      runId: options.runId
    })
  );
  const artifacts = await optionalIndexedRecords(
    "artifacts/index.jsonl",
    getArtifactStorePaths(options.rootDir, options.runId).indexPath,
    missingInputs,
    () =>
      listArtifacts({
        rootDir: options.rootDir,
        runId: options.runId
      })
  );
  const evidence = await optionalIndexedRecords(
    "evidence/index.jsonl",
    getEvidenceStorePaths(options.rootDir, options.runId).indexPath,
    missingInputs,
    () =>
      listEvidence({
        rootDir: options.rootDir,
        runId: options.runId
      })
  );
  const evalFileVerdicts = await optional("evals/*.json", missingInputs, () =>
    readEvalVerdictsFromFiles(paths.evalsDir)
  );

  return {
    events,
    trace,
    artifacts: artifacts ?? [],
    evidence: evidence ?? [],
    evalFileVerdicts: evalFileVerdicts ?? [],
    missingInputs,
    paths
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

function runStatusFromEvents(events: readonly RuntimeEvent[]) {
  if (events.some((event) => event.type === "run.failed")) {
    return "failed";
  }

  if (events.some((event) => event.type === "run.completed")) {
    return "completed";
  }

  return "running";
}

function phaseSummaries(events: readonly RuntimeEvent[], trace?: TraceFile) {
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

function gateSummaries(events: readonly RuntimeEvent[], trace?: TraceFile) {
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

function toolSummaries(events: readonly RuntimeEvent[], trace?: TraceFile) {
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
      durationMs: span.durationMs ?? existing?.durationMs,
      eventIds: uniqueStrings([...(existing?.eventIds ?? []), ...(span.eventIds ?? [])])
    });
  }

  return [...tools.values()].map((tool) => {
    const details = [
      tool.phase === undefined ? undefined : `phase ${tool.phase}`,
      tool.cacheStatus === undefined ? undefined : `cache ${tool.cacheStatus}`,
      tool.policyStatus === undefined ? undefined : `policy ${tool.policyStatus}`,
      tool.durationMs === undefined ? undefined : `${tool.durationMs}ms`
    ].filter((value): value is string => value !== undefined);

    return `- ${tool.toolId}: ${tool.status}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
  });
}

function evalSummaries(
  events: readonly RuntimeEvent[],
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
  events: readonly RuntimeEvent[],
  artifactRecords: readonly ArtifactRecord[]
) {
  const artifacts = new Map<string, {
    artifactId: string;
    artifactType: string;
    evidenceRefs: string[];
    uri?: string | undefined;
    claimLevel?: string | undefined;
  }>();

  for (const record of artifactRecords) {
    artifacts.set(record.artifactId, {
      artifactId: record.artifactId,
      artifactType: record.artifactType,
      evidenceRefs: record.evidenceRefs,
      uri: record.fileRef?.uri,
      claimLevel: record.claimLevel
    });
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
      artifact.uri,
      artifact.evidenceRefs.length === 0
        ? "no evidence refs"
        : `evidence ${artifact.evidenceRefs.join(", ")}`,
      artifact.claimLevel === undefined ? undefined : `claim ${artifact.claimLevel}`
    ].filter((value): value is string => value !== undefined);

    return `- ${artifact.artifactId} (${artifact.artifactType}): ${details.join(", ")}`;
  });
}

function evidenceSummaries(
  events: readonly RuntimeEvent[],
  evidenceRecords: readonly EvidenceRecord[]
) {
  const evidence = new Map<string, EvidenceRecord>();

  for (const record of evidenceRecords) {
    evidence.set(record.id, record);
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
    return `- ${record.id}: ${record.class}/${record.confidence}/${record.authority} - ${record.claim} (${sourceText})`;
  });
}

function decisionSummaries(events: readonly RuntimeEvent[]) {
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
    `- evals: ${facts.evalFileVerdicts.length} file verdict(s)`
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

function artifactRefFromEvent(event: RuntimeEvent) {
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

    const record = recordFromUnknown(candidate);
    const artifactId = stringValue(record.artifactId);
    const artifactType = stringValue(record.artifactType);

    if (artifactId !== undefined && artifactType !== undefined) {
      return {
        artifactId,
        artifactType,
        evidenceRefs: stringArray(record.evidenceRefs),
        uri: stringValue(record.uri),
        claimLevel: stringValue(record.claimLevel)
      };
    }
  }

  return undefined;
}

function evidenceRecordFromEvent(event: RuntimeEvent): EvidenceRecord | undefined {
  const payload = recordFromUnknown(event.payload);
  const candidates = [payload.evidence, payload.record, event.payload];

  for (const candidate of candidates) {
    const parsed = EvidenceRecordSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
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
