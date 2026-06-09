import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GateLifecycleInstructionSchema,
  GateVerdictSchema,
  type ToolCallRequest,
  type ToolCallResult,
  type GateVerdict
} from "@specwright/schemas";
import {
  evaluateGate,
  evaluateGateAsync,
  gateDecisionHashInput,
  hashDecision,
  type BrokerPort,
  type EvaluateGateRequest
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");
const decisionHashPattern = /^sha256:[0-9a-f]{64}$/;

const fixtureCases = [
  "context-sufficiency-pass",
  "context-sufficiency-missing-context",
  "missing-required-input",
  "artifact-schema-invalid",
  "eval-passed-failed",
  "policy-denial-blocks",
  "missing-gate-definition",
  "gate-definition-id-mismatch",
  "gate-definition-inline-rejected",
  "gate-kind-unknown",
  "gate-check-unsupported-type",
  "gate-onfail-malformed",
  "gate-onpass-malformed"
];
const modelAssistedFixtureCases = [
  {
    name: "model-assisted-deterministic-blocks",
    expectedCalls: 0
  },
  {
    name: "model-assisted-invalid-output",
    expectedCalls: 1
  },
  {
    name: "model-assisted-advisory-finding",
    expectedCalls: 1
  },
  {
    name: "model-assisted-cannot-raise-fail-to-pass",
    expectedCalls: 0
  },
  {
    name: "model-assisted-redacted-projection",
    expectedCalls: 1
  }
];
const onFailRemappingCases = [
  {
    name: "repair",
    onFail: {
      action: "create_repair_task",
      successGate: "model_assisted_review",
      allowedTools: ["fs.read"]
    }
  },
  {
    name: "approval",
    onFail: {
      action: "request_approval",
      approvalReason: "A human could approve this gate failure."
    }
  },
  {
    name: "clarification",
    onFail: {
      action: "pause_for_human",
      questionTemplate: "Can this model-assisted failure be clarified?"
    }
  }
];
const modelAssistedFailClosedCases: Array<{
  name: string;
  reason: string;
  outcome: "invalid_output" | "denied" | "error";
  expectedCalls: number;
  replay: () => ReplayBroker;
  mutateRequest?: (
    request: EvaluateGateRequest & {
      gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
    }
  ) => void;
}> = [
  {
    name: "missing broker",
    reason: "Model-assisted check model_review requires an injected broker",
    outcome: "error",
    expectedCalls: 0,
    replay: () => ({ calls: [] })
  },
  {
    name: "broker failure",
    reason: "Model-assisted check model_review broker call failed",
    outcome: "error",
    expectedCalls: 1,
    replay: () => createThrowingBroker()
  },
  {
    name: "broker denial",
    reason: "Denied by broker policy",
    outcome: "denied",
    expectedCalls: 1,
    replay: () =>
      createReplayBroker(
        modelToolResult("denied", "denied", {
          error: {
            code: "policy_denied",
            message: "Denied by broker policy",
            retryable: false
          }
        })
      )
  },
  {
    name: "failed broker result",
    reason: "Provider failed before output",
    outcome: "error",
    expectedCalls: 1,
    replay: () =>
      createReplayBroker(
        modelToolResult("failed", "failed", {
          error: {
            code: "provider_failed",
            message: "Provider failed before output",
            retryable: false
          }
        })
      )
  },
  {
    name: "absent output",
    reason: "Model-assisted check model_review returned absent or oversized output",
    outcome: "invalid_output",
    expectedCalls: 1,
    replay: () => createReplayBroker(modelToolResult("absent", "success"))
  },
  {
    name: "oversized output",
    reason: "Model-assisted check model_review returned absent or oversized output",
    outcome: "invalid_output",
    expectedCalls: 1,
    replay: () =>
      createReplayBroker(
        modelToolResult("oversized", "success", {
          output: {
            status: "clean",
            message: "x".repeat(4_000)
          }
        })
      )
  },
  {
    name: "invalid output schema",
    reason: "Model-assisted check model_review output failed outputSchema validation",
    outcome: "invalid_output",
    expectedCalls: 1,
    replay: () =>
      createReplayBroker(
        modelToolResult("invalid_schema", "success", {
          output: {
            status: "surprising"
          }
        })
      )
  },
  {
    name: "invalid projected input",
    reason: "Model-assisted check model_review context failed inputSchema validation",
    outcome: "invalid_output",
    expectedCalls: 0,
    replay: () =>
      createReplayBroker(
        modelToolResult("unused_projection_failure", "success", {
          output: {
            status: "clean"
          }
        })
      ),
    mutateRequest: (request) => {
      const modelCheck = modelAssistedCheckFor(request);

      modelCheck.allowedContextRefs = ["$.artifacts.summary.metadata"];
    }
  }
];
const mixedModelAssistedOrders = [
  {
    name: "after",
    order: "blocking_first"
  },
  {
    name: "before",
    order: "fail_closed_first"
  }
] as const;
const mixedModelAssistedFailClosedCases: Array<{
  name: string;
  reason: string;
  outcome: "invalid_output" | "denied" | "error";
  expectedCalls: number;
  replay: (
    order: (typeof mixedModelAssistedOrders)[number]["order"]
  ) => ReplayBroker;
  mutateRequest?: (
    request: EvaluateGateRequest & {
      gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
    }
  ) => void;
}> = [
  {
    name: "broker failure",
    reason: "Model-assisted check model_review broker call failed",
    outcome: "error",
    expectedCalls: 2,
    replay: (order) =>
      createSequenceReplayBroker(
        ...orderedModelResults(order, new Error("broker unavailable"))
      )
  },
  {
    name: "broker denial",
    reason: "Denied by broker policy",
    outcome: "denied",
    expectedCalls: 2,
    replay: (order) =>
      createSequenceReplayBroker(
        ...orderedModelResults(
          order,
          modelToolResult("mixed_denied", "denied", {
            error: {
              code: "policy_denied",
              message: "Denied by broker policy",
              retryable: false
            }
          })
        )
      )
  },
  {
    name: "failed broker result",
    reason: "Provider failed before output",
    outcome: "error",
    expectedCalls: 2,
    replay: (order) =>
      createSequenceReplayBroker(
        ...orderedModelResults(
          order,
          modelToolResult("mixed_failed", "failed", {
            error: {
              code: "provider_failed",
              message: "Provider failed before output",
              retryable: false
            }
          })
        )
      )
  },
  {
    name: "absent output",
    reason: "Model-assisted check model_review returned absent or oversized output",
    outcome: "invalid_output",
    expectedCalls: 2,
    replay: (order) =>
      createSequenceReplayBroker(
        ...orderedModelResults(order, modelToolResult("mixed_absent", "success"))
      )
  },
  {
    name: "oversized output",
    reason: "Model-assisted check model_review returned absent or oversized output",
    outcome: "invalid_output",
    expectedCalls: 2,
    replay: (order) =>
      createSequenceReplayBroker(
        ...orderedModelResults(
          order,
          modelToolResult("mixed_oversized", "success", {
            output: {
              status: "clean",
              message: "x".repeat(4_000)
            }
          })
        )
      )
  },
  {
    name: "invalid output schema",
    reason: "Model-assisted check model_review output failed outputSchema validation",
    outcome: "invalid_output",
    expectedCalls: 2,
    replay: (order) =>
      createSequenceReplayBroker(
        ...orderedModelResults(
          order,
          modelToolResult("mixed_invalid_schema", "success", {
            output: {
              status: "surprising"
            }
          })
        )
      )
  },
  {
    name: "invalid projected input",
    reason: "Model-assisted check model_review context failed inputSchema validation",
    outcome: "invalid_output",
    expectedCalls: 1,
    replay: () => createSequenceReplayBroker(blockingModelToolResult()),
    mutateRequest: (request) => {
      const modelCheck = modelAssistedCheckFor(request);

      modelCheck.allowedContextRefs = ["$.artifacts.summary.metadata"];
    }
  }
];

type ReplayBroker = {
  broker?: BrokerPort;
  calls: ToolCallRequest[];
};

type ModelAssistedFixtureDefinition = {
  onFail?: unknown;
  checks?: Array<Record<string, unknown>>;
};

describe("gate engine fixtures", () => {
  for (const fixtureName of fixtureCases) {
    test(fixtureName, async () => {
      const fixtureDir = join(fixturesDir, fixtureName);
      const request = await readJson(join(fixtureDir, "request.json"));
      const expected = await readJson(join(fixtureDir, "expected-result.json"));

      const result = evaluateGate(request);

      expect(GateVerdictSchema.parse(result.verdict)).toEqual(result.verdict);
      expect(GateLifecycleInstructionSchema.parse(result.instruction)).toEqual(
        result.instruction
      );
      expect(result.verdict.decisionHash).toMatch(decisionHashPattern);
      expect(result.verdict.evaluator.kind).toBe("deterministic");
      expect(result).toEqual(expected);
      expect(evaluateGate(request)).toEqual(result);
      expect(recomputedDecisionHash(result.verdict)).toBe(
        expected.verdict.decisionHash
      );
    });
  }
});

describe("model-assisted gate engine fixtures", () => {
  for (const fixture of modelAssistedFixtureCases) {
    test(fixture.name, async () => {
      const fixtureDir = join(fixturesDir, fixture.name);
      const request = await readJson(join(fixtureDir, "request.json"));
      const expected = await readJson(join(fixtureDir, "expected-result.json"));
      const recordedResult = await readOptionalJson<ToolCallResult>(
        join(fixtureDir, "recorded-result.json")
      );
      const replay = createReplayBroker(recordedResult);

      const result = await evaluateGateAsync({
        ...request,
        broker: replay.broker
      });

      expect(GateVerdictSchema.parse(result.verdict)).toEqual(result.verdict);
      expect(GateLifecycleInstructionSchema.parse(result.instruction)).toEqual(
        result.instruction
      );
      expect(result.verdict.decisionHash).toMatch(decisionHashPattern);
      expect(result).toEqual(expected);
      expect(replay.calls).toHaveLength(fixture.expectedCalls);

      const replayAgain = createReplayBroker(recordedResult);
      expect(
        await evaluateGateAsync({
          ...request,
          broker: replayAgain.broker
        })
      ).toEqual(result);
      expect(recomputedDecisionHash(result.verdict)).toBe(
        expected.verdict.decisionHash
      );
    });
  }

  test("redacted projection contains only allowed context and no secrets", async () => {
    const fixtureDir = join(fixturesDir, "model-assisted-redacted-projection");
    const request = await readJson(join(fixtureDir, "request.json"));
    const recordedResult = await readJson(
      join(fixtureDir, "recorded-result.json")
    ) as ToolCallResult;
    const replay = createReplayBroker(recordedResult);

    await evaluateGateAsync({
      ...request,
      broker: replay.broker
    });

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.args).toEqual({
      context: {
        artifacts: {
          summary: {
            content: {
              text: "Only this text may reach the model."
            }
          }
        }
      },
      rubric: {
        ref: "rubric://verification/model-review@v1",
        hash: "sha256:rubricmodelreview000000000000000000000000000000000000000000000"
      },
      maxTokens: 200
    });
    expect(JSON.stringify(replay.calls[0]?.args)).not.toMatch(
      /apiToken|password|credential|private_notes|run-input-secret|artifact-secret|nested-secret|metadata-secret/
    );
  });

  for (const failClosedCase of modelAssistedFailClosedCases) {
    for (const onFailCase of onFailRemappingCases) {
      test(`${failClosedCase.name} cannot be remapped by ${onFailCase.name} onFail`, async () => {
        const request = await loadModelAssistedReviewRequest();
        const definition = definitionFor(request);
        const replay = failClosedCase.replay();

        definition.onFail = cloneJson(onFailCase.onFail);
        failClosedCase.mutateRequest?.(request);

        const result = await evaluateGateAsync({
          ...request,
          ...(replay.broker === undefined ? {} : { broker: replay.broker })
        });

        expect(result.verdict.status).toBe("fail");
        expect(result.verdict.requiredAction).toBe("fail_run");
        expect(result.instruction).toEqual({
          kind: "fail_run",
          gateId: request.gateId,
          reason: failClosedCase.reason
        });
        expect("repairTask" in result.instruction).toBe(false);
        expect("approvalRequest" in result.instruction).toBe(false);
        expect("question" in result.instruction).toBe(false);
        expect(replay.calls).toHaveLength(failClosedCase.expectedCalls);
        expect(result.modelAssisted?.calls[0]?.outcome).toBe(
          failClosedCase.outcome
        );
      });
    }
  }

  for (const failClosedCase of mixedModelAssistedFailClosedCases) {
    for (const orderCase of mixedModelAssistedOrders) {
      test(`${failClosedCase.name} forces fail_run with blocking model finding ${orderCase.name} fail-closed finding`, async () => {
        const request = await loadMixedModelAssistedReviewRequest(orderCase.order);
        const definition = definitionFor(request);
        const replay = failClosedCase.replay(orderCase.order);

        definition.onFail = cloneJson(onFailRemappingCases[0]?.onFail);
        failClosedCase.mutateRequest?.(request);

        const result = await evaluateGateAsync({
          ...request,
          ...(replay.broker === undefined ? {} : { broker: replay.broker })
        });

        expect(result.verdict.status).toBe("fail");
        expect(result.verdict.requiredAction).toBe("fail_run");
        expect(result.instruction).toEqual({
          kind: "fail_run",
          gateId: request.gateId,
          reason: failClosedCase.reason
        });
        expect(result.verdict.findings.map((finding) => finding.id)).toEqual([
          "model_review",
          "model_blocking"
        ]);
        expect("repairTask" in result.instruction).toBe(false);
        expect(replay.calls).toHaveLength(failClosedCase.expectedCalls);
        expect(result.modelAssisted?.calls.map((call) => call.outcome)).toEqual(
          expect.arrayContaining([failClosedCase.outcome, "success"])
        );
      });
    }
  }

  for (const orderCase of mixedModelAssistedOrders) {
    test(`missing broker forces fail_run with multiple model-assisted checks when fail-closed check is ${orderCase.name} blocking-capable check`, async () => {
      const request = await loadMixedModelAssistedReviewRequest(orderCase.order);
      const definition = definitionFor(request);

      definition.onFail = cloneJson(onFailRemappingCases[0]?.onFail);

      const result = await evaluateGateAsync(request);

      expect(result.verdict.status).toBe("fail");
      expect(result.verdict.requiredAction).toBe("fail_run");
      expect(result.instruction).toEqual({
        kind: "fail_run",
        gateId: request.gateId,
        reason: `Model-assisted check ${
          orderCase.order === "blocking_first" ? "model_blocking" : "model_review"
        } requires an injected broker`
      });
      expect(result.verdict.findings.map((finding) => finding.id)).toEqual(
        orderCase.order === "blocking_first"
          ? ["model_blocking", "model_review"]
          : ["model_review", "model_blocking"]
      );
      expect(result.modelAssisted?.calls.map((call) => call.outcome)).toEqual([
        "error",
        "error"
      ]);
    });
  }
});

describe("gate engine determinism", () => {
  test("ignores wall clock when evaluatedAt is not supplied", async () => {
    const request = await readJson(
      join(fixturesDir, "context-sufficiency-pass", "request.json")
    );
    const baseline = evaluateGate(request);
    const originalNow = Date.now;

    Date.now = () => 4_102_444_800_000;

    try {
      expect(evaluateGate(request)).toEqual(baseline);
    } finally {
      Date.now = originalNow;
    }
  });

  test("core deterministic path avoids external side effects and randomness", async () => {
    const sourceFiles = [
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "decision-hash.ts")
    ];
    const forbiddenPatterns = [
      /from\s+["']node:fs(?:\/promises)?["']/,
      /from\s+["']node:net["']/,
      /from\s+["']node:process["']/,
      /from\s+["']node:http["']/,
      /from\s+["']node:https["']/,
      /\bprocess\.env\b/,
      /\bDate\.now\b/,
      /\bnew\s+Date\s*\(/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bfetch\s*\(/,
      /\bToolBroker\b/,
      /\bproviderClient\b/,
      /\bmodelClient\b/
    ];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");

      for (const forbiddenPattern of forbiddenPatterns) {
        expect(source).not.toMatch(forbiddenPattern);
      }
    }
  });
});

describe("unsupported check defense in depth", () => {
  test("malformed model-assisted checks fail during definition resolution", () => {
    const request = {
      gateId: "model_assisted_backstop",
      phase: "verification",
      gateDefinitions: {
        model_assisted_backstop: {
          id: "model_assisted_backstop",
          phase: "verification",
          kind: "eval",
          required: true,
          checks: [
            {
              id: "model_assisted_check",
              type: "model_assisted"
            }
          ],
          onFail: {
            action: "fail_run"
          }
        }
      }
    } as unknown as EvaluateGateRequest;

    const result = evaluateGate(request);

    expect(result.verdict.status).toBe("fail");
    expect(result.verdict.requiredAction).toBe("fail_run");
    expect(result.verdict.findings[0]?.id).toBe(
      "gate.check.model_assisted_check.missing_modelTool"
    );
    expect(result.verdict.findings[0]?.message).toBe(
      "Gate definition model_assisted_backstop model-assisted check model_assisted_check must declare a non-empty modelTool"
    );
    expect(result.instruction).toEqual({
      kind: "fail_run",
      gateId: "model_assisted_backstop",
      reason:
        "Gate definition model_assisted_backstop model-assisted check model_assisted_check must declare a non-empty modelTool"
    });
  });

  test("sync entrypoint fails closed for model-assisted checks regardless of onFail", async () => {
    const request = await readJson(
      join(fixturesDir, "model-assisted-advisory-finding", "request.json")
    ) as EvaluateGateRequest & {
      gateDefinitions: Record<string, EvaluateGateRequest["gateDefinition"]>;
    };
    const definition = request.gateDefinitions[request.gateId] as Record<
      string,
      unknown
    >;

    definition.onFail = {
      action: "create_repair_task",
      successGate: request.gateId
    };

    const result = evaluateGate(request);

    expect(result.verdict.status).toBe("fail");
    expect(result.verdict.requiredAction).toBe("fail_run");
    expect(result.verdict.findings[0]).toMatchObject({
      id: "gate.check.model_review.requires_async_entrypoint",
      message: "Model-assisted gate check model_review requires evaluateGateAsync"
    });
    expect(result.instruction).toEqual({
      kind: "fail_run",
      gateId: "model_assisted_review",
      reason: "Model-assisted gate check model_review requires evaluateGateAsync"
    });
  });

  test("evaluateGateAsync rejects retry-shaped onInvalidOutput until behavior exists", async () => {
    const request = await readJson(
      join(fixturesDir, "model-assisted-advisory-finding", "request.json")
    ) as EvaluateGateRequest & {
      gateDefinitions: Record<string, { checks?: Array<Record<string, unknown>> }>;
    };
    const modelCheck = request.gateDefinitions[request.gateId]?.checks?.find(
      (check) => check.id === "model_review"
    );

    expect(modelCheck).toBeDefined();
    if (modelCheck === undefined) {
      return;
    }

    modelCheck.onInvalidOutput = {
      retry: 2
    };

    const result = await evaluateGateAsync(request as EvaluateGateRequest);

    expect(result.verdict.status).toBe("fail");
    expect(result.verdict.requiredAction).toBe("fail_run");
    expect(result.verdict.findings[0]?.id).toBe(
      "gate.check.model_review.invalid_onInvalidOutput"
    );
    expect(result.instruction).toEqual({
      kind: "fail_run",
      gateId: "model_assisted_review",
      reason:
        "Gate definition model_assisted_review model-assisted check model_review must declare onInvalidOutput as fail until retry behavior is implemented"
    });
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as never;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}

async function loadModelAssistedReviewRequest(): Promise<
  EvaluateGateRequest & {
    gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
  }
> {
  const request = await readJson(
    join(fixturesDir, "model-assisted-advisory-finding", "request.json")
  ) as EvaluateGateRequest & {
    gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
  };

  return cloneJson(request);
}

function definitionFor(
  request: EvaluateGateRequest & {
    gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
  }
): ModelAssistedFixtureDefinition {
  const definition = request.gateDefinitions[request.gateId];

  if (definition === undefined) {
    throw new Error(`Fixture request is missing gate ${request.gateId}`);
  }

  return definition;
}

function modelAssistedCheckFor(
  request: EvaluateGateRequest & {
    gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
  }
): Record<string, unknown> {
  const modelCheck = definitionFor(request).checks?.find(
    (check) => check.id === "model_review"
  );

  if (modelCheck === undefined) {
    throw new Error("Fixture request is missing model_review check");
  }

  return modelCheck;
}

async function loadMixedModelAssistedReviewRequest(
  order: (typeof mixedModelAssistedOrders)[number]["order"]
): Promise<
  EvaluateGateRequest & {
    gateDefinitions: Record<string, ModelAssistedFixtureDefinition>;
  }
> {
  const request = await loadModelAssistedReviewRequest();
  const definition = definitionFor(request);
  const failClosedCheck = modelAssistedCheckFor(request);
  const blockingCheck = {
    ...cloneJson(failClosedCheck),
    id: "model_blocking"
  };
  const deterministicChecks =
    definition.checks?.filter((check) => check.id !== "model_review") ?? [];

  definition.checks = order === "blocking_first"
    ? [...deterministicChecks, blockingCheck, failClosedCheck]
    : [...deterministicChecks, failClosedCheck, blockingCheck];

  return request;
}

function createReplayBroker(recordedResult: ToolCallResult | undefined): {
  broker: BrokerPort;
  calls: ToolCallRequest[];
} {
  const calls: ToolCallRequest[] = [];

  return {
    calls,
    broker: async (request) => {
      calls.push(request);

      if (recordedResult === undefined) {
        throw new Error("Replay broker was called without a recorded result");
      }

      return recordedResult;
    }
  };
}

function createSequenceReplayBroker(
  ...recordedResults: Array<ToolCallResult | Error>
): {
  broker: BrokerPort;
  calls: ToolCallRequest[];
} {
  const calls: ToolCallRequest[] = [];
  let index = 0;

  return {
    calls,
    broker: async (request) => {
      calls.push(request);

      const recordedResult = recordedResults[index];
      index += 1;

      if (recordedResult === undefined) {
        throw new Error("Replay broker was called without a recorded result");
      }

      if (recordedResult instanceof Error) {
        throw recordedResult;
      }

      return recordedResult;
    }
  };
}

function createThrowingBroker(): {
  broker: BrokerPort;
  calls: ToolCallRequest[];
} {
  const calls: ToolCallRequest[] = [];

  return {
    calls,
    broker: async (request) => {
      calls.push(request);
      throw new Error("broker unavailable");
    }
  };
}

function modelToolResult(
  name: string,
  status: ToolCallResult["status"],
  overrides: Partial<ToolCallResult> = {}
): ToolCallResult {
  return {
    toolCallId: `toolcall_model_review_${name}`,
    status,
    provenance: {
      toolId: "model.review",
      toolVersion: "1.0.0",
      argsHash: `sha256:recorded-${name}-args`,
      resultHash: `sha256:recorded-${name}-result`,
      cacheStatus: "miss",
      traceId: `trace_model_${name}`
    },
    ...overrides
  };
}

function blockingModelToolResult(): ToolCallResult {
  return modelToolResult("mixed_blocking", "success", {
    output: {
      status: "blocking",
      message: "Repair the model-identified blocking issue before continuing.",
      targetRef: "artifact:summary",
      evidenceRefs: ["evidence:summary"]
    }
  });
}

function orderedModelResults(
  order: (typeof mixedModelAssistedOrders)[number]["order"],
  failClosedResult: ToolCallResult | Error
): Array<ToolCallResult | Error> {
  const blockingResult = blockingModelToolResult();

  return order === "blocking_first"
    ? [blockingResult, failClosedResult]
    : [failClosedResult, blockingResult];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recomputedDecisionHash(verdict: GateVerdict) {
  const { decisionHash: _decisionHash, ...withoutDecisionHash } = verdict;

  return hashDecision(gateDecisionHashInput(withoutDecisionHash));
}
