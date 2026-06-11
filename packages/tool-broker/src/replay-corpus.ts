import { open, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FixturePolicyBundle } from "@specwright/policy-engine";
import {
  RuntimeEventSchema,
  ToolCallRequestSchema,
  ToolCallResultSchema,
  type RuntimeEventContract,
  type ToolCallResult
} from "@specwright/schemas";
import { createDefaultCapabilityRegistry, createToolBroker } from "./index";

export type ReplayExpectation = "compatible" | "incompatible";

export type ReplayFixture = {
  name: string;
  event: RuntimeEventContract;
  expectation: ReplayExpectation;
};

export type ReplayCorpusReport = {
  events: number;
  deterministicRehashes: number;
  versionIncompatibilities: number;
};

export async function loadReplayFixtures(
  replayRoot: string
): Promise<ReplayFixture[]> {
  const entries = (await readdir(replayRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const fixtures = await Promise.all(
    entries.sort().map(async (entry) => {
      const directory = resolve(replayRoot, entry);
      const metadata = await readJsonObject(resolve(directory, "metadata.json"));
      const event = RuntimeEventSchema.parse(
        await readJsonObject(resolve(directory, "event.json"))
      );

      return {
        name: entry,
        event,
        expectation: readReplayExpectation(metadata, "expectation")
      };
    })
  );

  if (fixtures.length === 0) {
    throw new Error(`No replay fixtures discovered under ${replayRoot}.`);
  }

  return fixtures;
}

export async function assertReplayCorpus(input: {
  replayRoot: string;
  workspaceRoot: string;
}): Promise<ReplayCorpusReport> {
  const fixtures = await loadReplayFixtures(input.replayRoot);
  let deterministicRehashes = 0;
  let versionIncompatibilities = 0;

  for (const fixture of fixtures) {
    if (fixture.expectation === "incompatible") {
      await expectReplayIncompatibility(fixture, input.workspaceRoot);
      versionIncompatibilities += 1;
      continue;
    }

    deterministicRehashes += await assertReplayEventCompatible(
      fixture.event,
      input.workspaceRoot
    );
  }

  return {
    events: fixtures.length,
    deterministicRehashes,
    versionIncompatibilities
  };
}

export async function assertReplayEventCompatible(
  event: RuntimeEventContract,
  workspaceRoot: string
) {
  if (event.type === "tool.requested") {
    const request = ToolCallRequestSchema.parse(event.payload.request);
    assertRequestedToolResolves(request.toolId);
    return 0;
  }

  if (event.type !== "tool.completed" && event.type !== "tool.denied") {
    throw new Error(`Replay fixture ${event.id} is not a tool.* event.`);
  }

  const payload = event.payload as {
    request?: unknown;
    result?: unknown;
  };
  const request = ToolCallRequestSchema.parse(payload.request);
  const result = ToolCallResultSchema.parse(payload.result);
  assertCurrentRegistryCompatibility(result);

  if (event.type === "tool.completed" && result.status === "success") {
    const rerun = await createToolBroker({
      workspaceRoot,
      runId: event.runId,
      policyBundle: allowPolicyBundle
    }).callTool(request, {
      cwd: workspaceRoot,
      runId: event.runId,
      traceId: event.traceId
    });
    const parsed = ToolCallResultSchema.parse(rerun);

    if (parsed.provenance.resultHash !== result.provenance.resultHash) {
      throw new Error(
        `Replay fixture ${event.id} recomputed resultHash ${parsed.provenance.resultHash} but recorded ${result.provenance.resultHash}.`
      );
    }

    return 1;
  }

  return 0;
}

export function assertCurrentRegistryCompatibility(result: ToolCallResult) {
  const definition = createDefaultCapabilityRegistry().resolve(
    result.provenance.toolId
  );

  if (definition === undefined) {
    throw new Error(
      `Replay result references unresolvable tool ${result.provenance.toolId}.`
    );
  }

  if (definition.version !== result.provenance.toolVersion) {
    throw new Error(
      `Replay result for ${result.provenance.toolId} is incompatible: recorded toolVersion ${result.provenance.toolVersion}, current ${definition.version}.`
    );
  }
}

export function assertRequestedToolResolves(toolId: string) {
  const definition = createDefaultCapabilityRegistry().resolve(toolId);

  if (definition === undefined) {
    throw new Error(
      `Replay request references unresolvable tool ${toolId}.`
    );
  }
}

async function expectReplayIncompatibility(
  fixture: ReplayFixture,
  workspaceRoot: string
) {
  try {
    await assertReplayEventCompatible(fixture.event, workspaceRoot);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.includes("incompatible")
    ) {
      return;
    }
    throw error;
  }

  throw new Error(
    `Replay fixture ${fixture.name} was expected to fail closed as incompatible.`
  );
}

async function readJsonObject(path: string) {
  const parsed = JSON.parse(await readTextFile(path)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed;
}

function readReplayExpectation(
  raw: Record<string, unknown>,
  key: string
): ReplayExpectation {
  const value = raw[key];
  if (value === "compatible" || value === "incompatible") {
    return value;
  }
  throw new Error(`${key} must be compatible or incompatible.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTextFile(path: string) {
  const fileStats = await stat(path);
  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(fileStats.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

const allowPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.replay.allow",
  description: "Allows deterministic filesystem replay calls.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fs.list": {
      default: "allow",
      risk: "low",
      reason: "fs.list replay is allowed.",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    },
    "fs.read": {
      default: "allow",
      risk: "low",
      reason: "fs.read replay is allowed.",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"],
      constraints: [
        {
          kind: "maxBytes",
          value: 64
        }
      ]
    }
  }
};
