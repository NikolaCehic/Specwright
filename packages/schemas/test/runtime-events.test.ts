import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVENT_PAYLOAD_SCHEMAS,
  KNOWN_RUNTIME_EVENT_TYPES,
  RUNTIME_EVENT_CONTRACTS,
  RuntimeEventSchema,
  isRuntimeEventType,
  runtimeEventContractForType,
  type RuntimeEvent
} from "../src/index";

const fixturesDir = fileURLToPath(
  new URL("../fixtures/events/", import.meta.url)
);

const cataloguedTypes = [
  "artifact.recorded",
  "decision.recorded",
  "eval.completed",
  "evidence.recorded",
  "gate.evaluated",
  "harness.loaded",
  "human.answer_recorded",
  "human.input_requested",
  "phase.entered",
  "phase.transitioned",
  "policy.evaluated",
  "run.completed",
  "run.failed",
  "run.started",
  "tool.authorized",
  "tool.completed",
  "tool.denied",
  "tool.requested"
] as const;

describe("runtime event contracts", () => {
  test("catalogues every runtime event type with a payload schema", () => {
    expect(KNOWN_RUNTIME_EVENT_TYPES).toEqual([...cataloguedTypes].sort());

    for (const type of cataloguedTypes) {
      expect(isRuntimeEventType(type), type).toBe(true);
      expect(EVENT_PAYLOAD_SCHEMAS[type], type).toBeDefined();
      const contract = runtimeEventContractForType(type);

      expect(contract?.contractId, type).toBe(`specwright.event.${type}`);
      expect(contract?.contractVersion, type).toBe("1");
      expect(contract?.schemaHash, type).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("parses historical events without metadata using additive defaults", () => {
    const events = readJsonlFixture("valid-historical-run.jsonl").map((event) =>
      RuntimeEventSchema.parse(event)
    );

    expect([...new Set(events.map((event) => event.type))].sort()).toEqual([
      ...cataloguedTypes
    ]);

    for (const event of events) {
      const contract = RUNTIME_EVENT_CONTRACTS[event.type];

      expect(event.contractId).toBe(contract.contractId);
      expect(event.contractVersion).toBe(contract.contractVersion);
      expect(event.schemaHash).toBe(contract.schemaHash);
    }
  });

  test("narrows payloads by discriminated event type", () => {
    const event = RuntimeEventSchema.parse(
      readJsonlFixture("valid-historical-run.jsonl")[0]
    );

    expect(taskFromRuntimeEvent(event)).toBe(
      "Validate every typed runtime event contract"
    );
  });

  test("rejects invalid payloads, unknown types, and unsupported versions", () => {
    expect(RuntimeEventSchema.safeParse(readJsonlFixture("invalid-payload.jsonl")[1]).success).toBe(false);
    expect(RuntimeEventSchema.safeParse(readJsonlFixture("unknown-type.jsonl")[1]).success).toBe(false);
    expect(RuntimeEventSchema.safeParse(readJsonlFixture("unsupported-version.jsonl")[1]).success).toBe(false);
  });
});

function taskFromRuntimeEvent(event: RuntimeEvent) {
  switch (event.type) {
    case "run.started":
      return event.payload.input.task;
    default:
      return undefined;
  }
}

function readJsonlFixture(name: string) {
  return readFileSync(`${fixturesDir}${name}`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}
