import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendArtifact } from "@specwright/artifact-store";
import { appendEvidence } from "@specwright/evidence-store";
import {
  DEFAULT_REDACTION_PROFILE,
  EVENT_INTEGRITY_GENESIS_SEED,
  RUN_PACKAGE_VERSION_RECORD_VERSION,
  RUN_STORE_CURRENT_VERSION,
  appendEvent,
  computeIntegrity,
  createRun,
  getRunStorePaths,
  type HarnessSnapshot,
  type RedactionProfile
} from "@specwright/run-store";
import type {
  EvalVerdict,
  EvidenceRecord,
  RunInput,
  RuntimeEvent,
  SourceRef
} from "@specwright/schemas";
import {
  RuntimeEventSchema,
  runtimeEventContractForType
} from "@specwright/schemas";
import { recordTraceSpan, writeTrace } from "@specwright/trace-recorder";
import {
  assembleAuditBundle,
  auditBundleManifestBody,
  hashAuditBundleCanonical,
  parseAuditBundleChunk,
  parseBundleManifest,
  stableAuditBundleJson,
  verifyAuditBundle,
  type AuditBundleChunk,
  type BundleManifest
} from "./index";

const FIXED_TIME = "2026-06-12T12:00:00.000Z";
const GOLDEN_FIXTURE_PATH = join(
  import.meta.dir,
  "fixtures",
  "audit-bundle-golden.json"
);

const runInput = {
  task: "Create a source-bound frontend contract",
  harnessId: "default",
  host: {
    kind: "cli"
  }
} satisfies RunInput;

const harness = {
  id: "default",
  version: "0.0.0",
  specHash: "sha256:test"
} satisfies HarnessSnapshot;

const passedEval = {
  evalId: "source_fidelity",
  targetRef: "artifact:plan",
  status: "pass",
  severity: "blocking",
  findings: [],
  evidenceRefs: ["evidence:repo:package-json"],
  producedBy: {
    kind: "deterministic",
    ref: "test"
  }
} satisfies EvalVerdict;

const redactionProfile = {
  ...DEFAULT_REDACTION_PROFILE,
  id: "packet-04-audit-export-profile"
} satisfies RedactionProfile;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-audit-bundle-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("audit export bundle", () => {
  test("hashes canonical objects deterministically", () => {
    const left = {
      z: 1,
      a: {
        d: 4,
        c: [3, { b: 2, a: 1 }]
      }
    };
    const right = {
      a: {
        c: [3, { a: 1, b: 2 }],
        d: 4
      },
      z: 1
    };

    expect(stableAuditBundleJson(left)).toBe(stableAuditBundleJson(right));
    expect(hashAuditBundleCanonical(left)).toBe(hashAuditBundleCanonical(right));
    expect(hashAuditBundleCanonical(left)).not.toBe(
      hashAuditBundleCanonical({
        ...right,
        z: 2
      })
    );
  });

  test("assembles and verifies a tenant-scoped sealed bundle", async () => {
    await createFullyTracedRun("run-attestable");
    await createNonAttestableRun("run-non-attestable");

    const result = await assembleFixtureBundle("bundle-sealed", [
      "run-non-attestable",
      "run-attestable"
    ]);
    const manifest = result.manifest;

    expect(manifest.registryVersion).toBe("registry.scope-10.packet-04.v1");
    expect(manifest.redactionProfile).toBe(redactionProfile.id);
    expect(manifest.requester).toBe("auditor@example.invalid");
    expect(manifest.tenant).toBe("tenant-a");
    expect(manifest.scope).toBe("scope-10-packet-04");
    expect(manifest.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.eventRange).toEqual({
      firstSequence: 0,
      lastSequence: 9,
      eventCount: 19
    });
    expect(manifest.chunks.map((chunk) => chunk.runId)).toEqual([
      "run-attestable",
      "run-non-attestable"
    ]);
    expect(manifest.chunks.every((chunk) => chunk.eventRange.eventCount > 0)).toBe(
      true
    );

    const verification = await verifyAuditBundle(result.destinationPath);

    expect(verification).toEqual(
      expect.objectContaining({
        valid: true,
        failures: []
      })
    );
    expect(manifest.auditRecords).toContainEqual(
      expect.objectContaining({
        action: "export_sealed",
        requester: "auditor@example.invalid",
        manifestHash: manifest.manifestHash
      })
    );

    const chunks = await readBundleChunks(result.destinationPath, manifest);
    const nonAttestable = chunks.find(
      (chunk) => chunk.runId === "run-non-attestable"
    );
    const serializedBundle = [
      stableAuditBundleJson(manifest),
      ...chunks.map((chunk) => stableAuditBundleJson(chunk))
    ].join("\n");

    expect(nonAttestable?.attestation.status).toBe("non-attestable");
    expect(
      nonAttestable?.attestation.status === "non-attestable"
        ? nonAttestable.attestation.reasons.join("\n")
        : ""
    ).toContain("coverage");
    expect(serializedBundle).toContain("\"authority\":\"derived\"");
    expect(serializedBundle).toContain("\"claimLevel\":\"audit_export\"");
    expect(serializedBundle).toContain("\"tenant\":\"tenant-a\"");
    expect(serializedBundle).toContain("sha256:restricted-source-ref-content");
    expect(serializedBundle).not.toContain("sk_live_packet_04_secret");
  });

  test("matches the committed golden manifest hash and chunk bytes deterministically", async () => {
    await createStaticGoldenRun("golden-attestable", {
      trace: "complete"
    });
    await createStaticGoldenRun("golden-non-attestable", {
      trace: "empty",
      restrictedEvidence: true
    });

    const first = await assembleFixtureBundle("bundle-deterministic-a", [
      "golden-attestable",
      "golden-non-attestable"
    ]);
    const second = await assembleFixtureBundle("bundle-deterministic-b", [
      "golden-non-attestable",
      "golden-attestable"
    ]);
    const golden = await readGoldenFixture();

    expect(first.manifest.manifestHash).toBe(second.manifest.manifestHash);
    expect(first.manifest.chunks.map((chunk) => chunk.chunkHash)).toEqual(
      second.manifest.chunks.map((chunk) => chunk.chunkHash)
    );
    expect(first.manifest.manifestHash).toBe(golden.manifestHash);
    expect(first.manifest.chunks.map((chunk) => chunk.chunkHash)).toEqual(
      golden.chunkHashes
    );

    for (const descriptor of first.manifest.chunks) {
      const firstBytes = await readFile(
        join(first.destinationPath, descriptor.chunkPath),
        "utf8"
      );
      const secondBytes = await readFile(
        join(second.destinationPath, descriptor.chunkPath),
        "utf8"
      );

      expect(firstBytes).toBe(secondBytes);
    }
  });

  test("detects altered chunks and altered manifests", async () => {
    await createFullyTracedRun("run-attestable");
    const result = await assembleFixtureBundle("bundle-tamper", [
      "run-attestable"
    ]);
    const descriptor = result.manifest.chunks[0];

    if (descriptor === undefined) {
      throw new Error("Expected a chunk descriptor");
    }

    await writeFile(
      join(result.destinationPath, descriptor.chunkPath),
      `${await readFile(join(result.destinationPath, descriptor.chunkPath), "utf8")} `,
      "utf8"
    );

    const chunkTamper = await verifyAuditBundle(result.destinationPath);

    expect(chunkTamper.valid).toBe(false);
    expect(chunkTamper.failures).toContainEqual(
      expect.objectContaining({
        kind: "chunk_hash_mismatch",
        runId: "run-attestable"
      })
    );

    await createFullyTracedRun("run-attestable-manifest");
    const manifestResult = await assembleFixtureBundle("bundle-manifest-tamper", [
      "run-attestable-manifest"
    ]);
    const manifest = {
      ...manifestResult.manifest,
      registryVersion: "registry.scope-10.packet-04.backdated"
    } satisfies BundleManifest;

    await writeFile(
      join(manifestResult.destinationPath, "manifest.json"),
      stableAuditBundleJson(manifest),
      "utf8"
    );

    const manifestTamper = await verifyAuditBundle(
      manifestResult.destinationPath
    );

    expect(manifestTamper.valid).toBe(false);
    expect(manifestTamper.failures).toContainEqual(
      expect.objectContaining({
        kind: "manifest_hash_mismatch"
      })
    );
  });

  test("detects missing chunks, extra chunks, and clean certification over recorded gaps", async () => {
    await createNonAttestableRun("run-gap-for-verifier");
    const result = await assembleFixtureBundle("bundle-verifier-failures", [
      "run-gap-for-verifier"
    ]);
    const descriptor = result.manifest.chunks[0];

    if (descriptor === undefined) {
      throw new Error("Expected a chunk descriptor");
    }

    await writeFile(
      join(result.destinationPath, "chunks", "extra.json"),
      "{\"extra\":true}",
      "utf8"
    );

    const extraChunk = await verifyAuditBundle(result.destinationPath);

    expect(extraChunk.valid).toBe(false);
    expect(extraChunk.failures).toContainEqual(
      expect.objectContaining({
        kind: "extra_chunk",
        chunkPath: "chunks/extra.json"
      })
    );

    await rm(join(result.destinationPath, "chunks", "extra.json"));
    await rm(join(result.destinationPath, descriptor.chunkPath));

    const missingChunk = await verifyAuditBundle(result.destinationPath);

    expect(missingChunk.valid).toBe(false);
    expect(missingChunk.failures).toContainEqual(
      expect.objectContaining({
        kind: "missing_chunk",
        runId: "run-gap-for-verifier"
      })
    );

    await createNonAttestableRun("run-gap-certified-clean");
    const certifiedClean = await assembleFixtureBundle("bundle-certified-clean", [
      "run-gap-certified-clean"
    ]);
    const tamperedManifest = {
      ...certifiedClean.manifest,
      chunks: certifiedClean.manifest.chunks.map((chunk) => ({
        ...chunk,
        attestation: { status: "attestable" as const }
      }))
    };
    const recomputedManifest = {
      ...tamperedManifest,
      manifestHash: hashAuditBundleCanonical(
        auditBundleManifestBody(tamperedManifest)
      )
    };

    await writeFile(
      join(certifiedClean.destinationPath, "manifest.json"),
      stableAuditBundleJson(recomputedManifest),
      "utf8"
    );

    const verification = await verifyAuditBundle(certifiedClean.destinationPath);

    expect(verification.valid).toBe(false);
    expect(verification.failures).toContainEqual(
      expect.objectContaining({
        kind: "non_attestable_certified_clean",
        runId: "run-gap-certified-clean"
      })
    );
  });

  test("detects recomputed-hash tenant mismatches and invalid manifests", async () => {
    await createFullyTracedRun("run-verifier-tenant-mismatch");
    const result = await assembleFixtureBundle("bundle-tenant-mismatch", [
      "run-verifier-tenant-mismatch"
    ]);
    const descriptor = result.manifest.chunks[0];

    if (descriptor === undefined) {
      throw new Error("Expected a chunk descriptor");
    }

    const chunkPath = join(result.destinationPath, descriptor.chunkPath);
    const chunk = parseAuditBundleChunk(
      JSON.parse(await readFile(chunkPath, "utf8")) as unknown
    );
    const tamperedChunk = {
      ...chunk,
      trustLabels: {
        ...chunk.trustLabels,
        tenant: "tenant-b"
      }
    } satisfies AuditBundleChunk;
    const tamperedChunkHash = hashAuditBundleCanonical(tamperedChunk);
    const tamperedManifest = {
      ...result.manifest,
      chunks: result.manifest.chunks.map((chunkDescriptor) =>
        chunkDescriptor.runId === descriptor.runId
          ? {
              ...chunkDescriptor,
              chunkHash: tamperedChunkHash
            }
          : chunkDescriptor
      )
    };
    const resealedManifest = {
      ...tamperedManifest,
      manifestHash: hashAuditBundleCanonical(
        auditBundleManifestBody(tamperedManifest)
      )
    };

    await writeFile(chunkPath, stableAuditBundleJson(tamperedChunk), "utf8");
    await writeManifest(result.destinationPath, resealedManifest);

    const semanticMismatch = await verifyAuditBundle(result.destinationPath);

    expect(semanticMismatch.valid).toBe(false);
    expect(semanticMismatch.failures).toContainEqual(
      expect.objectContaining({
        kind: "unscoped_or_cross_tenant",
        runId: "run-verifier-tenant-mismatch"
      })
    );

    await writeFile(
      join(result.destinationPath, "manifest.json"),
      stableAuditBundleJson({
        ...resealedManifest,
        tenant: ""
      }),
      "utf8"
    );

    const invalidManifest = await verifyAuditBundle(result.destinationPath);

    expect(invalidManifest.valid).toBe(false);
    expect(invalidManifest.failures).toContainEqual(
      expect.objectContaining({
        kind: "invalid_manifest"
      })
    );
  });

  test("detects recomputed-hash event range forgery", async () => {
    await createFullyTracedRun("run-event-range-forgery");
    const result = await assembleFixtureBundle("bundle-event-range-forgery", [
      "run-event-range-forgery"
    ]);
    const forgedManifest = {
      ...result.manifest,
      eventRange: {
        firstSequence: 0,
        lastSequence: 999,
        eventCount: 1_000
      },
      chunks: result.manifest.chunks.map((descriptor) => ({
        ...descriptor,
        eventRange: {
          firstSequence: 0,
          lastSequence: 999,
          eventCount: 1_000
        }
      }))
    };
    const resealedManifest = {
      ...forgedManifest,
      manifestHash: hashAuditBundleCanonical(
        auditBundleManifestBody(forgedManifest)
      )
    };

    await writeManifest(result.destinationPath, resealedManifest);

    const verification = await verifyAuditBundle(result.destinationPath);

    expect(verification.valid).toBe(false);
    expect(verification.failures).toContainEqual(
      expect.objectContaining({
        kind: "event_range_mismatch",
        runId: "run-event-range-forgery"
      })
    );
  });

  test("discards interrupted exports without publishing a final bundle", async () => {
    await createFullyTracedRun("run-interrupted-a");
    await createFullyTracedRun("run-interrupted-b");
    const destinationPath = join(rootDir, "exports", "interrupted");

    await expect(
      assembleFixtureBundle("interrupted", [
        "run-interrupted-a",
        "run-interrupted-b"
      ], {
        destinationPath,
        hooks: {
          afterChunkWritten: (descriptor) => {
            if (descriptor.runId === "run-interrupted-a") {
              throw new Error("injected chunk sink failure");
            }
          }
        }
      })
    ).rejects.toMatchObject({
      code: "assembly_failed",
      auditRecords: [
        expect.objectContaining({
          action: "export_discarded",
          reasonCode: "assembly_failed"
        })
      ]
    });

    await expect(readdir(destinationPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
    const exportParent = await readdir(dirname(destinationPath));

    expect(exportParent.some((name) => name.includes(".staging."))).toBe(false);
  });

  test("refuses unscoped, unauthorized, duplicate, and cross-tenant exports before publishing chunks", async () => {
    await createFullyTracedRun("run-refusal");
    await createCrossTenantRun("run-cross-tenant");

    await expect(
      assembleFixtureBundle("bundle-unscoped", ["run-refusal"], {
        tenant: " "
      })
    ).rejects.toMatchObject({
      code: "unscoped_export",
      auditRecords: [
        expect.objectContaining({
          action: "export_denied",
          reasonCode: "unscoped_export"
        })
      ]
    });
    await expect(
      assembleFixtureBundle("bundle-unauthorized", ["run-refusal"], {
        requesterRoles: ["viewer"]
      })
    ).rejects.toMatchObject({
      code: "unauthorized_export"
    });
    await expect(
      assembleFixtureBundle("bundle-duplicate", ["run-refusal", "run-refusal"])
    ).rejects.toMatchObject({
      code: "duplicate_run"
    });
    await expect(
      assembleFixtureBundle("bundle-cross-tenant", ["run-cross-tenant"])
    ).rejects.toMatchObject({
      code: "cross_tenant_export"
    });

    await expect(readdir(join(rootDir, "exports", "bundle-unscoped"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readdir(join(rootDir, "exports", "bundle-cross-tenant"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

async function assembleFixtureBundle(
  name: string,
  runIds: readonly string[],
  overrides: Partial<Parameters<typeof assembleAuditBundle>[0]> = {}
) {
  return assembleAuditBundle({
    rootDir,
    destinationPath: join(rootDir, "exports", name),
    tenant: "tenant-a",
    scope: "scope-10-packet-04",
    requester: "auditor@example.invalid",
    requesterRoles: ["auditor"],
    runIds,
    registryVersion: "registry.scope-10.packet-04.v1",
    redactionProfile,
    generatedAt: FIXED_TIME,
    requestedAt: FIXED_TIME,
    ...overrides
  });
}

async function readBundleChunks(
  destinationPath: string,
  manifest: BundleManifest
) {
  const chunks = [];

  for (const descriptor of manifest.chunks) {
    chunks.push(
      parseAuditBundleChunk(
        JSON.parse(
          await readFile(join(destinationPath, descriptor.chunkPath), "utf8")
        ) as unknown
      )
    );
  }

  return chunks;
}

async function readGoldenFixture() {
  const parsed = JSON.parse(await readFile(GOLDEN_FIXTURE_PATH, "utf8")) as unknown;
  const record = typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : {};
  const manifestHash =
    typeof record.manifestHash === "string" ? record.manifestHash : "";
  const chunkHashes = Array.isArray(record.chunkHashes)
    ? record.chunkHashes.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  return {
    manifestHash,
    chunkHashes
  };
}

async function createStaticGoldenRun(
  runId: string,
  options: {
    trace: "complete" | "empty";
    restrictedEvidence?: boolean;
  }
) {
  const paths = getRunStorePaths(rootDir, runId);
  const events = staticRunEvents(runId, {
    restrictedEvidence: options.restrictedEvidence === true
  });

  await mkdir(paths.runDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(paths.evidenceDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
  await mkdir(paths.evalsDir, { recursive: true });
  await writeFile(
    paths.versionPath,
    `${JSON.stringify({
      recordVersion: RUN_PACKAGE_VERSION_RECORD_VERSION,
      version: RUN_STORE_CURRENT_VERSION
    })}\n`,
    "utf8"
  );
  await writeFile(
    paths.eventsPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8"
  );
  await writeFile(paths.decisionsPath, "", "utf8");
  await writeFile(paths.summaryPath, "", "utf8");
  await appendEvidence({
    rootDir,
    runId,
    record: sourceFact("evidence:repo:package-json")
  });

  if (options.restrictedEvidence === true) {
    await appendEvidence({
      rootDir,
      runId,
      record: restrictedEvidenceRecord()
    });
  }

  await writeEvalVerdictFile(runId);

  if (options.trace === "empty") {
    await writeTrace({
      rootDir,
      runId,
      trace: {
        runId,
        traceId: `trace-${runId}`,
        spans: [],
        metadata: {}
      }
    });
    return;
  }

  await recordGoldenTrace(runId, events);
}

function staticRunEvents(
  runId: string,
  options: { restrictedEvidence: boolean }
): RuntimeEvent[] {
  const baseEvents = [
    {
      id: `${runId}-event-run-started`,
      type: "run.started",
      payload: {
        input: runInput,
        harness,
        initialPhase: "created",
        budgets: {}
      }
    },
    {
      id: `${runId}-event-phase-entered`,
      type: "phase.entered",
      payload: {
        phase: "intake"
      }
    },
    {
      id: `${runId}-event-tool-requested`,
      type: "tool.requested",
      payload: {
        request: {
          toolId: "tool.fs.read",
          args: {
            path: "package.json"
          },
          reason: "Read package metadata",
          idempotencyKey: `read-package-${runId}`,
          requestedBy: {
            phase: "evidence"
          }
        }
      }
    },
    {
      id: `${runId}-event-tool-completed`,
      type: "tool.completed",
      payload: {
        request: {
          toolId: "tool.fs.read",
          requestedBy: {
            phase: "evidence"
          }
        },
        result: {
          toolCallId: `tool-call-${runId}`,
          status: "success",
          provenance: {
            toolId: "tool.fs.read",
            toolVersion: "0.1.0",
            adapterVersion: "0.1.0",
            argsHash: `sha256:${"a".repeat(64)}`,
            resultHash: `sha256:${"b".repeat(64)}`,
            decisionHash: `sha256:${"c".repeat(64)}`,
            cacheStatus: "bypass",
            traceId: `trace-${runId}`
          }
        }
      }
    },
    {
      id: `${runId}-event-gate-evaluated`,
      type: "gate.evaluated",
      payload: {
        gateId: "context_sufficiency",
        verdict: {
          gateId: "context_sufficiency",
          phase: "evidence",
          status: "pass",
          severity: "blocking",
          reasons: ["Required source context exists"],
          findings: [],
          evidenceRefs: ["evidence:repo:package-json"],
          obligations: [],
          evaluatedAt: "2026-05-29T00:00:04.000Z",
          evaluator: {
            kind: "deterministic",
            ref: "test"
          }
        },
        instruction: {
          kind: "continue",
          gateId: "context_sufficiency"
        }
      }
    },
    {
      id: `${runId}-event-evidence-recorded`,
      type: "evidence.recorded",
      payload: {
        evidence: sourceFact("evidence:repo:package-json")
      }
    },
    ...(options.restrictedEvidence
      ? [
          {
            id: `${runId}-event-restricted-evidence`,
            type: "evidence.recorded",
            payload: {
              evidence: restrictedEvidenceRecord()
            }
          }
        ]
      : []),
    {
      id: `${runId}-event-eval-completed`,
      type: "eval.completed",
      payload: {
        evalId: passedEval.evalId,
        verdict: passedEval
      }
    },
    {
      id: `${runId}-event-run-completed`,
      type: "run.completed",
      payload: {
        reason: "done"
      }
    }
  ];
  let previousHash = EVENT_INTEGRITY_GENESIS_SEED;
  const events: RuntimeEvent[] = [];

  for (const [index, input] of baseEvents.entries()) {
    const event = staticEvent({
      runId,
      id: input.id,
      type: input.type,
      sequence: index,
      timestamp: `2026-05-29T00:00:${String(index).padStart(2, "0")}.000Z`,
      payload: input.payload,
      prevHash: previousHash
    });

    if (event.integrity === undefined) {
      throw new Error(`Static event ${event.id} was not sealed`);
    }

    previousHash = event.integrity.hash;
    events.push(event);
  }

  return events;
}

function staticEvent(input: {
  runId: string;
  id: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload: unknown;
  prevHash: string;
}): RuntimeEvent {
  const contract = runtimeEventContractForType(input.type);

  if (contract === undefined) {
    throw new Error(`Unknown runtime event contract ${input.type}`);
  }

  const eventWithoutIntegrity = RuntimeEventSchema.parse({
    id: input.id,
    runId: input.runId,
    type: input.type,
    timestamp: input.timestamp,
    sequence: input.sequence,
    traceId: `trace-${input.runId}`,
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    schemaHash: contract.schemaHash,
    payload: input.payload
  });
  const integrity = computeIntegrity(eventWithoutIntegrity, input.prevHash);

  return RuntimeEventSchema.parse({
    ...eventWithoutIntegrity,
    integrity
  });
}

async function recordGoldenTrace(
  runId: string,
  events: readonly RuntimeEvent[]
) {
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-phase-${runId}`,
      kind: "phase",
      name: "intake",
      status: "success",
      startedAt: "2026-05-29T00:00:01.000Z",
      eventIds: [requiredEvent(events, "phase.entered").id],
      metadata: {
        phaseId: "intake"
      }
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-tool-${runId}`,
      kind: "tool",
      name: "tool.fs.read",
      status: "success",
      startedAt: "2026-05-29T00:00:02.000Z",
      durationMs: 12,
      eventIds: [
        requiredEvent(events, "tool.requested").id,
        requiredEvent(events, "tool.completed").id
      ],
      metadata: toolTraceMetadata(runId)
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-gate-${runId}`,
      kind: "gate",
      name: "context_sufficiency",
      status: "pass",
      startedAt: "2026-05-29T00:00:04.000Z",
      eventIds: [requiredEvent(events, "gate.evaluated").id],
      metadata: {
        gateId: "context_sufficiency",
        phaseId: "evidence",
        instruction: "continue"
      }
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-eval-${runId}`,
      kind: "eval",
      name: "source_fidelity",
      status: "pass",
      startedAt: "2026-05-29T00:00:07.000Z",
      eventIds: [requiredEvent(events, "eval.completed").id],
      metadata: {
        evalId: "source_fidelity",
        phaseId: "verification"
      }
    }
  });
}

async function createSuccessfulRun(runId: string) {
  await createRun({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    initialPhase: "created",
    timestamp: "2026-05-29T00:00:00.000Z"
  });
  const phaseEntered = await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-phase-entered`,
    type: "phase.entered",
    payload: {
      phase: "intake"
    },
    timestamp: "2026-05-29T00:00:01.000Z"
  });
  const toolRequested = await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-tool-requested`,
    type: "tool.requested",
    payload: {
      request: {
        toolId: "tool.fs.read",
        args: {
          path: "package.json"
        },
        reason: "Read package metadata",
        idempotencyKey: `read-package-${runId}`,
        requestedBy: {
          phase: "evidence"
        }
      }
    },
    timestamp: "2026-05-29T00:00:02.000Z"
  });
  const toolCompleted = await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-tool-completed`,
    type: "tool.completed",
    payload: {
      request: {
        toolId: "tool.fs.read",
        requestedBy: {
          phase: "evidence"
        }
      },
      result: {
        toolCallId: `tool-call-${runId}`,
        status: "success",
        provenance: {
          toolId: "tool.fs.read",
          toolVersion: "0.1.0",
          adapterVersion: "0.1.0",
          argsHash: `sha256:${"a".repeat(64)}`,
          resultHash: `sha256:${"b".repeat(64)}`,
          decisionHash: `sha256:${"c".repeat(64)}`,
          cacheStatus: "bypass",
          traceId: `trace-${runId}`
        }
      }
    },
    timestamp: "2026-05-29T00:00:03.000Z"
  });
  const gateEvaluated = await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-gate-evaluated`,
    type: "gate.evaluated",
    payload: {
      gateId: "context_sufficiency",
      verdict: {
        gateId: "context_sufficiency",
        phase: "evidence",
        status: "pass",
        severity: "blocking",
        reasons: ["Required source context exists"],
        findings: [],
        evidenceRefs: ["evidence:repo:package-json"],
        obligations: [],
        evaluatedAt: "2026-05-29T00:00:04.000Z",
        evaluator: {
          kind: "deterministic",
          ref: "test"
        }
      },
      instruction: {
        kind: "continue",
        gateId: "context_sufficiency"
      }
    },
    timestamp: "2026-05-29T00:00:04.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-artifact-recorded`,
    type: "artifact.recorded",
    payload: {
      artifact: {
        artifactId: "artifact-plan",
        artifactType: "plan",
        evidenceRefs: ["evidence:repo:package-json"],
        uri: "artifacts/plan.json"
      }
    },
    timestamp: "2026-05-29T00:00:05.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-evidence-recorded`,
    type: "evidence.recorded",
    payload: {
      evidence: sourceFact("evidence:repo:package-json")
    },
    timestamp: "2026-05-29T00:00:06.000Z"
  });
  const evalCompleted = await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-eval-completed`,
    type: "eval.completed",
    payload: {
      evalId: passedEval.evalId,
      verdict: passedEval
    },
    timestamp: "2026-05-29T00:00:07.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-run-completed`,
    type: "run.completed",
    payload: {
      reason: "done"
    },
    timestamp: "2026-05-29T00:00:08.000Z"
  });

  return {
    phaseEntered: phaseEntered.event,
    toolRequested: toolRequested.event,
    toolCompleted: toolCompleted.event,
    gateEvaluated: gateEvaluated.event,
    evalCompleted: evalCompleted.event
  };
}

async function createFullyTracedRun(
  runId: string,
  options: { includeArtifact?: boolean } = {}
) {
  const events = await createSuccessfulRun(runId);

  if (options.includeArtifact !== false) {
    await appendArtifact({
      rootDir,
      runId,
      record: {
        artifactId: "artifact-plan",
        artifactType: "plan",
        content: {
          steps: ["Read source files"]
        },
        evidenceRefs: ["evidence:repo:package-json"],
        claimLevel: "source_fact",
        producedBy: {
          phase: "planning",
          actionId: "record-plan",
          toolCallId: `tool-call-${runId}`
        },
        metadata: {}
      }
    });
  }
  await appendEvidence({
    rootDir,
    runId,
    record: sourceFact("evidence:repo:package-json")
  });
  await writeEvalVerdictFile(runId);

  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-phase-${runId}`,
      kind: "phase",
      name: "intake",
      status: "success",
      startedAt: "2026-05-29T00:00:01.000Z",
      eventIds: [events.phaseEntered.id],
      metadata: {
        phaseId: "intake"
      }
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-tool-${runId}`,
      kind: "tool",
      name: "tool.fs.read",
      status: "success",
      startedAt: "2026-05-29T00:00:02.000Z",
      durationMs: 12,
      eventIds: [events.toolRequested.id, events.toolCompleted.id],
      metadata: toolTraceMetadata(runId)
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-gate-${runId}`,
      kind: "gate",
      name: "context_sufficiency",
      status: "pass",
      startedAt: "2026-05-29T00:00:04.000Z",
      eventIds: [events.gateEvaluated.id],
      metadata: {
        gateId: "context_sufficiency",
        phaseId: "evidence",
        instruction: "continue"
      }
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "runtime-test",
    harnessSpecHash: "sha256:test",
    hostAdapter: "cli",
    span: {
      spanId: `span-eval-${runId}`,
      kind: "eval",
      name: "source_fidelity",
      status: "pass",
      startedAt: "2026-05-29T00:00:07.000Z",
      eventIds: [events.evalCompleted.id],
      metadata: {
        evalId: "source_fidelity",
        phaseId: "verification"
      }
    }
  });
}

async function createNonAttestableRun(runId: string) {
  await createSuccessfulRun(runId);
  await appendEvidence({
    rootDir,
    runId,
    record: restrictedEvidenceRecord()
  });
  await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-restricted-evidence`,
    type: "evidence.recorded",
    payload: {
      evidence: restrictedEvidenceRecord()
    },
    timestamp: "2026-05-29T00:00:09.000Z"
  });
  await writeTrace({
    rootDir,
    runId,
    trace: {
      runId,
      traceId: `trace-${runId}`,
      spans: [],
      metadata: {}
    }
  });
}

async function createCrossTenantRun(runId: string) {
  await createSuccessfulRun(runId);
  await appendEvent({
    rootDir,
    runId,
    id: `${runId}-event-cross-tenant`,
    type: "evidence.recorded",
    payload: {
      evidence: {
        ...sourceFact("evidence:tenant-b"),
        metadata: {
          tenantId: "tenant-b"
        }
      }
    },
    timestamp: "2026-05-29T00:00:09.000Z"
  });
}

function sourceFact(id: string): EvidenceRecord {
  return {
    id,
    class: "source_fact",
    claim: "The repository declares a runnable package.",
    sourceRefs: [
      {
        path: "package.json",
        locator: "scripts",
        authority: "repo",
        redactionClass: "operator",
        captureToolCallId: "tool-call-1"
      }
    ],
    confidence: "high",
    authority: "repo",
    redactionPolicy: "operator",
    createdBy: {
      phase: "evidence",
      actionId: "read-package-json",
      toolCallId: "tool-call-1"
    }
  };
}

function restrictedEvidenceRecord(): EvidenceRecord {
  const sourceRef = {
    path: "secrets.env",
    contentHash: "sha256:restricted-source-ref-content",
    authority: "repo",
    redactionClass: "restricted",
    captureToolCallId: "tool-call-restricted"
  } satisfies Exclude<SourceRef, string>;

  return {
    id: "evidence:restricted:packet-04",
    class: "source_fact",
    claim: "The restricted source includes sk_live_packet_04_secret.",
    sourceRefs: [sourceRef],
    confidence: "high",
    authority: "repo",
    redactionPolicy: "restricted",
    createdBy: {
      phase: "evidence",
      actionId: "record-restricted-packet-04",
      toolCallId: "tool-call-restricted"
    }
  };
}

function toolTraceMetadata(runId: string) {
  return {
    toolId: "tool.fs.read",
    toolVersion: "0.1.0",
    toolCallId: `tool-call-${runId}`,
    toolStatus: "success",
    cacheStatus: "bypass",
    policyStatus: "allow",
    phaseId: "evidence"
  };
}

function requiredEvent(
  events: readonly RuntimeEvent[],
  type: RuntimeEvent["type"]
) {
  const event = events.find((candidate) => candidate.type === type);

  if (event === undefined) {
    throw new Error(`Missing fixture event ${type}`);
  }

  return event;
}

async function writeEvalVerdictFile(runId: string) {
  const paths = getRunStorePaths(rootDir, runId);

  await mkdir(paths.evalsDir, { recursive: true });
  await writeFile(
    join(paths.evalsDir, "source_fidelity.json"),
    JSON.stringify(passedEval),
    "utf8"
  );
}

async function writeManifest(destinationPath: string, manifest: BundleManifest) {
  parseBundleManifest(manifest);
  await writeFile(
    join(destinationPath, "manifest.json"),
    stableAuditBundleJson(manifest),
    "utf8"
  );
}
