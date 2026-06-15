import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GATE_ENGINE_EVALUATOR,
  DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY,
  CANONICAL_GATE_ENGINE_EVALUATOR_REF,
  parseEvaluatorRef,
  serializeCanonicalEvaluatorRef,
  serializeEvaluatorRef
} from "./evaluator-identity";

describe("gate evaluator identity", () => {
  test("default evaluator ref stays byte-stable through the canonical evaluator reference", () => {
    expect(DEFAULT_GATE_ENGINE_EVALUATOR).toBe(CANONICAL_GATE_ENGINE_EVALUATOR_REF);
    expect(serializeEvaluatorRef(DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY)).toBe(
      CANONICAL_GATE_ENGINE_EVALUATOR_REF
    );
  });

  test("canonical serialization is structured and parseable", () => {
    const canonical = serializeCanonicalEvaluatorRef(
      DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY
    );

    expect(canonical).toBe(
      "gate-engine:specwright.gate-engine@1.0.0#gate-contract=1.0.0"
    );
    expect(parseEvaluatorRef(canonical)).toEqual(
      DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY
    );
  });

  test("canonical evaluator references resolve to the structured 1.0.0 semantics", () => {
    expect(parseEvaluatorRef("gate-engine:specwright.gate-engine@1.0.0#gate-contract=1.0.0")).toEqual(
      DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY
    );
  });

  test("unknown evaluator refs fail closed on parse", () => {
    expect(parseEvaluatorRef("specwright.gate-engine@future")).toBeUndefined();
  });
});
