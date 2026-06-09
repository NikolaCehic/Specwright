import type { HashDigest } from "./decision-hash";
import { hashGateDefinition } from "./definition-hash";
import type { FixtureGateDefinition } from "./index";

export type GateDefinitionChangedSignal = {
  changed: true;
  gateId: string;
  from: HashDigest;
  to: HashDigest;
  signal: "gate.definition.changed";
};

export type GateDefinitionChangeResult =
  | { changed: false }
  | GateDefinitionChangedSignal;

export function detectDefinitionChange(input: {
  gateId: string;
  pinnedDefinitionHash: HashDigest;
  currentDefinition: FixtureGateDefinition;
}): GateDefinitionChangeResult {
  const currentDefinitionHash = hashGateDefinition(input.currentDefinition);

  return currentDefinitionHash === input.pinnedDefinitionHash
    ? { changed: false }
    : {
        changed: true,
        gateId: input.gateId,
        from: input.pinnedDefinitionHash,
        to: currentDefinitionHash,
        signal: "gate.definition.changed"
      };
}
