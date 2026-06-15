import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GateVerdictSchema } from "@specwright/schemas";
import { parseEvaluatorRef } from "./evaluator-identity";
import { evaluateGate, type EvaluateGateRequest } from "./index";

const fixtureDir = join(import.meta.dir, "../fixtures/recorded-verdict-replay");
const eventPointer = "runs/run-gates/events/gate.evaluated:context_sufficiency";

describe("recorded verdict replay", () => {
  test("replays a recorded verdict under the structured 1.0.0 evaluator semantics", async () => {
    const request = await readJson<EvaluateGateRequest>(join(fixtureDir, "request.json"));
    const expected = await readJson(join(fixtureDir, "expected-result.json"));
    const recordedVerdict = GateVerdictSchema.parse(
      await readJson(join(fixtureDir, "recorded-verdict.json"))
    );
    const replayed = replayRecordedVerdict({
      eventPointer,
      recordedVerdict,
      request
    });

    expect(replayed.ok).toBe(true);

    if (replayed.ok) {
      expect(replayed.identity.version).toBe("1.0.0");
      expect(replayed.result).toEqual(expected);
      expect(replayed.result.verdict).toEqual(recordedVerdict);
    }
  });

  test("fails closed when the recorded evaluator ref is unresolvable", async () => {
    const request = await readJson<EvaluateGateRequest>(join(fixtureDir, "request.json"));
    const recordedVerdict = GateVerdictSchema.parse(
      await readJson(join(fixtureDir, "recorded-verdict.json"))
    );
    const replayed = replayRecordedVerdict({
      eventPointer,
      recordedVerdict: {
        ...recordedVerdict,
        evaluator: {
          ...recordedVerdict.evaluator,
          ref: "specwright.gate-engine.unregistered"
        }
      },
      request
    });

    expect(replayed).toEqual({
      ok: false,
      eventPointer,
      evaluatorRef: "specwright.gate-engine.unregistered",
      reason: "Recorded evaluator ref is unresolvable."
    });
  });
});

function replayRecordedVerdict(input: {
  eventPointer: string;
  recordedVerdict: ReturnType<typeof GateVerdictSchema.parse>;
  request: EvaluateGateRequest;
}):
  | {
      ok: true;
      identity: NonNullable<
        ReturnType<typeof parseEvaluatorRef>
      >;
      result: ReturnType<typeof evaluateGate>;
    }
  | {
      ok: false;
      eventPointer: string;
      evaluatorRef: string;
      reason: string;
    } {
  const identity = parseEvaluatorRef(input.recordedVerdict.evaluator.ref);

  if (identity === undefined) {
    return {
      ok: false,
      eventPointer: input.eventPointer,
      evaluatorRef: input.recordedVerdict.evaluator.ref,
      reason: "Recorded evaluator ref is unresolvable."
    };
  }

  return {
    ok: true,
    identity,
    result: evaluateGate({
      ...input.request,
      evaluatorRef: input.recordedVerdict.evaluator.ref
    })
  };
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
