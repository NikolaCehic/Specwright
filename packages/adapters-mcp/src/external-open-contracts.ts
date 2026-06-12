export const mcpPacket04OpenContractItems = [
  {
    id: "scope-06-tier-4-mcp-sanctioned-runner",
    summary:
      "ToolBroker registers kind 'mcp' at isolation tier 4, but current broker execution returns unsupported_isolation_tier before adapter invocation until a sanctioned tier-4 runner exists."
  },
  {
    id: "scope-01-external-observation-evidence-class",
    summary:
      "Shared schemas expose SourceAuthority.external, but EvidenceClass has no first-class external_observation member; Packet 04 records external_observation as adapter-local classification with evidenceClass unknown."
  },
  {
    id: "scope-05-mcp-external-invocation-audit-record",
    summary:
      "Packet 04 records serverId, pinned version, tool, argsHash, and resultHash on the external observation; durable mcp.external.invoked audit/span correlation belongs to Packet 05."
  }
] as const;
