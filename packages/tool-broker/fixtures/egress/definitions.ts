import type { FixturePolicyBundle } from "@specwright/policy-engine";
import { z } from "zod";
import {
  isolationTierForKind,
  type CapabilityAdapter,
  type CapabilityDefinition
} from "../../src/index";

export const EGRESS_FIXTURE_ADAPTER_VERSION = "0.6.3";
export const EGRESS_OUTPUT_INVALID_SECRET =
  "sk_live_packet_06_03_output_invalid_secret";
export const EGRESS_OUTPUT_TOKEN =
  "sk_live_packet_06_03_output_token_secret";
export const EGRESS_OUTPUT_CREDENTIAL =
  "credential-packet-06-03-secret-value";
export const EGRESS_OUTPUT_BEARER =
  "Bearer packet0603abcdefghijklmnopqrstuvwxyz1234567890";
export const EGRESS_ERROR_SECRET =
  "sk_live_packet_06_03_adapter_error_secret";

const EgressInputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().optional()
  })
  .strict();

const EgressValidOutputSchema = z
  .object({
    record: z
      .object({
        id: z.string().min(1),
        message: z.string()
      })
      .strict()
  })
  .strict();

const EgressSecretOutputSchema = z
  .object({
    account: z
      .object({
        name: z.string(),
        apiToken: z.string(),
        nested: z
          .object({
            credential: z.string()
          })
          .strict()
      })
      .strict(),
    notes: z.array(
      z
        .object({
          label: z.string(),
          value: z.string()
        })
        .strict()
    )
  })
  .strict();

const EgressInvalidOutputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().refine(() => false, {
      message: `Adapter output contained token ${EGRESS_OUTPUT_INVALID_SECRET}`
    })
  })
  .strict();

export function egressValidDefinition(): CapabilityDefinition {
  return fixtureDefinition({
    id: "fixture.egress.valid",
    outputSchema: EgressValidOutputSchema,
    adapter: fixtureAdapter("fixture/egress-valid", async () => ({
      status: "success",
      output: {
        record: {
          id: "record-valid",
          message: "schema-valid output"
        }
      }
    }))
  });
}

export function egressInvalidOutputDefinition(): CapabilityDefinition {
  return fixtureDefinition({
    id: "fixture.egress.invalid-output",
    outputSchema: EgressInvalidOutputSchema,
    adapter: fixtureAdapter("fixture/egress-invalid-output", async () => ({
      status: "success",
      output: {
        path: "external/source",
        content: EGRESS_OUTPUT_INVALID_SECRET
      }
    }))
  });
}

export function egressSecretDefinition(): CapabilityDefinition {
  return fixtureDefinition({
    id: "fixture.egress.secret-output",
    outputSchema: EgressSecretOutputSchema,
    adapter: fixtureAdapter("fixture/egress-secret-output", async () => ({
      status: "success",
      output: egressSecretRawOutput()
    }))
  });
}

export function egressErrorDefinition(): CapabilityDefinition {
  return fixtureDefinition({
    id: "fixture.egress.error",
    outputSchema: EgressValidOutputSchema,
    adapter: fixtureAdapter("fixture/egress-error", async () => {
      throw new Error(`Adapter failed with token=${EGRESS_ERROR_SECRET}`);
    })
  });
}

export function egressSecretRawOutput() {
  return {
    account: {
      name: "Acme External",
      apiToken: EGRESS_OUTPUT_TOKEN,
      nested: {
        credential: EGRESS_OUTPUT_CREDENTIAL
      }
    },
    notes: [
      {
        label: "authorization",
        value: EGRESS_OUTPUT_BEARER
      }
    ]
  };
}

export const egressAllowPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.egress-allow",
  description: "Allows packet 06-03 egress fixtures.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fixture.egress.valid": allowToolPolicy(),
    "fixture.egress.invalid-output": {
      ...allowToolPolicy(),
      obligations: [
        {
          kind: "redact",
          params: {
            paths: ["content"]
          }
        }
      ]
    },
    "fixture.egress.secret-output": {
      ...allowToolPolicy(),
      obligations: [
        {
          kind: "redact",
          params: {
            paths: ["account.nested.credential"]
          }
        },
        {
          kind: "mark_external_source",
          params: {
            source: "external://fixture-crm/customer-record"
          }
        }
      ]
    },
    "fixture.egress.error": allowToolPolicy()
  }
};

export const egressMissingRedactionDischargePolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.egress-missing-redaction-discharge",
  description: "Requires an unmatched redaction selector for fail-closed coverage.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fixture.egress.secret-output": {
      ...allowToolPolicy(),
      obligations: [
        {
          kind: "redact",
          params: {
            paths: ["account.missingToken"]
          }
        }
      ]
    }
  }
};

function fixtureDefinition(input: {
  id: string;
  outputSchema: z.ZodTypeAny;
  adapter: CapabilityAdapter;
}): CapabilityDefinition {
  return {
    id: input.id,
    kind: "filesystem",
    description: "Packet 06-03 egress fixture capability.",
    version: "0.6.3",
    inputSchema: EgressInputSchema,
    outputSchema: input.outputSchema,
    adapter: input.adapter,
    risk: "low",
    requestedScopes: ["workspace:read"],
    limits: {
      timeoutMs: 1_000,
      maxBytes: 4_096
    },
    cache: {
      enabled: false
    },
    isolationTier: isolationTierForKind("filesystem")
  };
}

function fixtureAdapter(
  id: string,
  execute: CapabilityAdapter["execute"]
): CapabilityAdapter {
  return {
    id,
    version: EGRESS_FIXTURE_ADAPTER_VERSION,
    kind: "filesystem",
    execute
  };
}

function allowToolPolicy() {
  return {
    default: "allow" as const,
    risk: "low" as const,
    reason: "Packet 06-03 egress fixture is allowed.",
    allowedPhases: ["evidence"],
    requiredScopes: ["workspace:read"],
    allowedScopes: ["workspace:read"]
  };
}
