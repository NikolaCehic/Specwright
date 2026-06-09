import { z } from "zod";
import {
  GATE_CONTRACT_VERSION,
  GATE_ENGINE_EVALUATOR_VERSION,
  SEMVER_PATTERN
} from "./gate-contract-version";

export const GATE_ENGINE_EVALUATOR_IDENTITY_KIND = "gate-engine" as const;
export const GATE_ENGINE_EVALUATOR_ID = "specwright.gate-engine" as const;
export const LEGACY_V0_EVALUATOR_REF = "specwright.gate-engine.v0" as const;

export const GateEngineEvaluatorIdentitySchema = z
  .object({
    kind: z.literal(GATE_ENGINE_EVALUATOR_IDENTITY_KIND),
    id: z.literal(GATE_ENGINE_EVALUATOR_ID),
    version: z.string().regex(SEMVER_PATTERN),
    gateContractVersion: z.string().regex(SEMVER_PATTERN)
  })
  .strict();

export type GateEngineEvaluatorIdentity = z.infer<
  typeof GateEngineEvaluatorIdentitySchema
>;

export const DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY =
  GateEngineEvaluatorIdentitySchema.parse({
    kind: GATE_ENGINE_EVALUATOR_IDENTITY_KIND,
    id: GATE_ENGINE_EVALUATOR_ID,
    version: GATE_ENGINE_EVALUATOR_VERSION,
    gateContractVersion: GATE_CONTRACT_VERSION
  });

const preferredRefByIdentityKey = new Map<string, string>([
  [
    evaluatorIdentityKey(DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY),
    LEGACY_V0_EVALUATOR_REF
  ]
]);

const aliasedIdentityByRef = new Map<string, GateEngineEvaluatorIdentity>([
  [LEGACY_V0_EVALUATOR_REF, DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY]
]);

export const DEFAULT_GATE_ENGINE_EVALUATOR = serializeEvaluatorRef(
  DEFAULT_GATE_ENGINE_EVALUATOR_IDENTITY
);

export function serializeCanonicalEvaluatorRef(
  identity: GateEngineEvaluatorIdentity
): string {
  const parsed = GateEngineEvaluatorIdentitySchema.parse(identity);

  return `${parsed.kind}:${parsed.id}@${parsed.version}#gate-contract=${parsed.gateContractVersion}`;
}

export function serializeEvaluatorRef(
  identity: GateEngineEvaluatorIdentity
): string {
  const parsed = GateEngineEvaluatorIdentitySchema.parse(identity);

  return (
    preferredRefByIdentityKey.get(evaluatorIdentityKey(parsed)) ??
    serializeCanonicalEvaluatorRef(parsed)
  );
}

export function parseEvaluatorRef(
  ref: string
): GateEngineEvaluatorIdentity | undefined {
  const aliased = aliasedIdentityByRef.get(ref);

  if (aliased !== undefined) {
    return aliased;
  }

  const parsed = parseCanonicalEvaluatorRef(ref);

  if (parsed === undefined) {
    return undefined;
  }

  return GateEngineEvaluatorIdentitySchema.safeParse(parsed).success
    ? parsed
    : undefined;
}

function parseCanonicalEvaluatorRef(
  ref: string
): GateEngineEvaluatorIdentity | undefined {
  const match =
    /^(?<kind>[^:]+):(?<id>[^@]+)@(?<version>[^#]+)#gate-contract=(?<gateContractVersion>.+)$/.exec(
      ref
    );

  if (match?.groups === undefined) {
    return undefined;
  }

  const candidate = {
    kind: match.groups.kind,
    id: match.groups.id,
    version: match.groups.version,
    gateContractVersion: match.groups.gateContractVersion
  };

  const parsed = GateEngineEvaluatorIdentitySchema.safeParse(candidate);

  return parsed.success ? parsed.data : undefined;
}

function evaluatorIdentityKey(identity: GateEngineEvaluatorIdentity): string {
  return serializeCanonicalEvaluatorRef(identity);
}
