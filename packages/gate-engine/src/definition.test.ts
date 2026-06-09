import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateGateDefinition } from "./definition";
import { lintGateDefinitionFiles } from "./lint";

describe("gate definition validator", () => {
  test("default harness gate definitions lint clean", async () => {
    const result = await lintGateDefinitionFiles(
      join(import.meta.dir, "../../../harnesses/default/gates")
    );

    expect(result.checked).toBe(6);
    expect(result.issues).toEqual([]);
  });

  test.each([
    [
      "unknown kind",
      {
        id: "bad_kind",
        kind: "unknown",
        checks: []
      },
      "gate.kind.unknown"
    ],
    [
      "unknown check type",
      {
        id: "bad_check",
        kind: "exit",
        checks: [{ id: "unsupported_mode", type: "unsupported_mode" }]
      },
      "gate.check.unsupported_mode.unknown_type"
    ],
    [
      "malformed onFail",
      {
        id: "bad_onfail",
        kind: "exit",
        checks: [],
        onFail: { action: "create_repair_task", successGate: 42 }
      },
      "gate.onFail.malformed"
    ],
    [
      "malformed onPass",
      {
        id: "bad_onpass",
        kind: "exit",
        checks: [],
        onPass: { action: "transition_phase" }
      },
      "gate.onPass.malformed"
    ],
    [
      "model-assisted missing modelTool",
      {
        id: "bad_model_tool",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            modelTool: ""
          }
        ]
      },
      "gate.check.model_review.missing_modelTool"
    ],
    [
      "model-assisted malformed inputSchema",
      {
        id: "bad_input_schema",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            inputSchema: {
              type: "object",
              properties: {
                artifacts: {
                  type: "bogus"
                }
              }
            }
          }
        ]
      },
      "gate.check.model_review.invalid_inputSchema"
    ],
    [
      "model-assisted malformed outputSchema",
      {
        id: "bad_output_schema",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            outputSchema: {
              type: "object",
              required: ["status"],
              properties: {
                status: {
                  enum: []
                }
              }
            }
          }
        ]
      },
      "gate.check.model_review.invalid_outputSchema"
    ],
    [
      "model-assisted malformed rubric",
      {
        id: "bad_rubric",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            rubric: {
              ref: "",
              hash: 42
            }
          }
        ]
      },
      "gate.check.model_review.invalid_rubric"
    ],
    [
      "model-assisted malformed allowedContextRefs",
      {
        id: "bad_allowed_refs",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            allowedContextRefs: ["$.artifacts.summary.content", ""]
          }
        ]
      },
      "gate.check.model_review.invalid_allowedContextRefs"
    ],
    [
      "model-assisted malformed maxTokens",
      {
        id: "bad_max_tokens",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            maxTokens: 0
          }
        ]
      },
      "gate.check.model_review.invalid_maxTokens"
    ],
    [
      "model-assisted malformed onInvalidOutput",
      {
        id: "bad_on_invalid_output",
        kind: "eval",
        checks: [
          {
            ...validModelAssistedCheck(),
            onInvalidOutput: {
              retry: 2
            }
          }
        ]
      },
      "gate.check.model_review.invalid_onInvalidOutput"
    ]
  ])("%s", (_name, definition, findingId) => {
    const validation = validateGateDefinition(definition);

    expect(validation.ok).toBe(false);

    if (!validation.ok) {
      expect(validation.finding.id).toBe(findingId);
    }
  });
});

function validModelAssistedCheck() {
  return {
    id: "model_review",
    type: "model_assisted",
    modelTool: "model.review",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifacts"],
      properties: {
        artifacts: {
          type: "object",
          additionalProperties: false,
          required: ["summary"],
          properties: {
            summary: {
              type: "object",
              additionalProperties: false,
              required: ["content"],
              properties: {
                content: {
                  type: "object",
                  additionalProperties: false,
                  required: ["text"],
                  properties: {
                    text: {
                      type: "string"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "message"],
      properties: {
        status: {
          enum: ["clean", "review", "blocking"]
        },
        message: {
          type: "string"
        }
      }
    },
    rubric: {
      ref: "rubric://verification/model-review@v1",
      hash: "sha256:rubricmodelreview000000000000000000000000000000000000000000000"
    },
    allowedContextRefs: ["$.artifacts.summary.content"],
    maxTokens: 200,
    onInvalidOutput: "fail"
  };
}
