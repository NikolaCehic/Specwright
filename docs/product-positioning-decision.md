# Product Positioning Decision

Status: accepted for downstream packet planning
Work unit: FEAT-016A-product-positioning-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation authority for the Specwright productization sequence

## Decision

Specwright is a governed agent workflow runtime: a strict, replayable harness runtime for source-grounded agent work that must be policy-controlled, evidence-bound, eval-checked, auditable, and portable across host surfaces.

Specwright is built primarily for product and platform engineering teams that are turning coding-agent or knowledge-work automation into production workflows. Governance, compliance, security, and operations stakeholders are first-class secondary users because their requirements shape the runtime guarantees: replay, audit, policy, approvals, tenant boundaries, retention, release compatibility, and traceable evidence.

The core promise is:

> Specwright turns agent work into runtime-owned, evidence-grounded, policy-governed, replayable workflows instead of loose scripts, prompt chains, or transcript-only automation.

## Primary Users

Primary:

- Product engineering teams building agent-assisted implementation, verification, documentation, and release workflows.
- Platform engineering teams providing shared governed agent infrastructure for many repositories, teams, or host surfaces.

Secondary:

- Governance, security, compliance, and operations stakeholders who need auditability, policy enforcement, retention, replay, and release evidence.
- Adapter, host, and framework authors who need stable runtime contracts for CLI, MCP, and future host integrations.

Not primary:

- Solo hobby users who only need a lightweight chatbot or prompt runner.
- Teams looking for unrestricted tool execution without runtime policy, replay, evidence, or audit obligations.

## Primary Use Cases

- Source-bound planning and implementation where claims, artifacts, and summaries trace back to evidence.
- Governed artifact generation with schema validation, evidence binding, and append-only run history.
- Eval-gated automation where quality checks, regression datasets, and repair instructions influence lifecycle state.
- Policy-controlled tool and capability execution through the broker boundary.
- CLI and MCP runtime control where adapters are thin clients and runtime behavior stays authoritative.
- Auditable agent runs with events, traces, reports, retention, tenant partitioning, and replayable run packages.
- Governed retrieval and memory quality checks where retrieved context is advisory unless promoted to evidence through explicit source rules.
- Release and rollout readiness for teams that need compatibility, provenance, and operational checks before treating agent workflows as product infrastructure.

## Non-Goals

Specwright is not:

- A chatbot.
- A prompt pack.
- A loose collection of tools.
- An ambient autonomous worker with unrestricted authority.
- A generic task-runner whose guarantees rely on convention rather than runtime contracts.
- A package-publishing, pricing, support, or hosted-service decision by itself.

## Alternatives Considered

| Alternative | Decision |
| --- | --- |
| Runtime platform | Partly accepted. Specwright is a runtime platform, but the public category must emphasize governed agent workflow behavior rather than generic platform breadth. |
| Harness workbench | Rejected as the primary category. It sounds exploratory and local-tool oriented; Specwright's direction is production runtime governance. |
| Enterprise agent governance layer | Partly accepted. Governance is central, but "layer" underplays lifecycle ownership, replay, adapters, evals, and durable run state. |
| Strict, replayable agent harness runtime | Accepted as the strongest current source-backed phrase and refined into "governed agent workflow runtime" for product planning. |

## Consequences

- Package taxonomy should preserve clear runtime planes: contracts, run storage, harness loading, policy, gates, brokered capabilities, evals, adapters, operations, memory, and reports. Public package decisions remain behind `G-PKG-001`.
- CLI command taxonomy should expose runtime-owned workflows and operational checks, not arbitrary script shortcuts. Public command decisions remain behind `G-CLI-001`.
- MCP and future host surfaces should remain thin runtime clients. MCP server packaging remains behind `G-MCP-001`; host command-pack decisions remain behind `G-HOST-001`.
- Documentation should teach governed source-grounded workflow first, then install, quickstart, command reference, adapter setup, troubleshooting, and examples. User-facing docs remain behind `G-DOCS-001`.
- Naming should converge on Specwright product language while preserving explicit migration policy for the legacy Archetype state directory. Naming migration remains behind `G-NAME-001`.
- Release compatibility, changelog, provenance, publish readiness, and package distribution remain behind `G-REL-001`, `FEAT-013A`, and package taxonomy gates.
- Hosted/team deployment, durable backend defaults, public server mode, support/SLA, and open-source/commercial boundary remain separate product decisions, not implied by this positioning record.

## Deferred Decisions

| Decision | Owner |
| --- | --- |
| Public package set, names, roles, metadata, and publish targets | `FEAT-001A` / `G-PKG-001` |
| Public CLI command map, output contracts, exit codes, config discovery, and docs policy | `FEAT-002A` / `G-CLI-001` |
| Full human-input RuntimeApi surface and adapter exposure | `FEAT-004A` / `G-RUNTIME-001` |
| MCP server package, binary, transport, auth, lifecycle, and host setup | `FEAT-005A` / `G-MCP-001` |
| Host command packs and install paths | `FEAT-006A` / `G-HOST-001` |
| Release compatibility, semantic versioning, changelog, migration notes, and release checklist | `FEAT-013A` / `G-REL-001` |
| Legacy Archetype state directory migration policy | `FEAT-014A` / `G-NAME-001` |
| Documentation and install UX source of truth | `FEAT-015A` / `G-DOCS-001` |
| Capability pack taxonomy and extension model | `FEAT-007A`, `FEAT-008A` / `G-CAPACK-001`, `G-SDK-001` |
| Durable backend targets, memory default posture, and public server mode | `FEAT-009A`, `FEAT-010A`, `FEAT-012A` / `G-CAP-002`, `G-MEM-001`, `G-SERVER-001` |
| CI authority, branch protection, release checks, and wiki status reconciliation | `OPT-001A`, `AUD-016A`, `AUD-017A` / `G-CI-001`, `G-GH-002`, `G-WIKI-001` |
| Open-source/commercial boundary, support/SLA posture, and first hosted/team deployment story | future product/business gate |

## Source Trace

| Claim | Source |
| --- | --- |
| Current strongest product phrase: "strict, replayable agent harness runtime for governed, source-grounded work" | `README.md` |
| Non-goals: not a chatbot, prompt pack, or loose collection of tools | `README.md` |
| Runtime invariants: runtime owns behavior, adapters are thin, capabilities are brokered, policy is deterministic, gates control lifecycle advancement, event logs are source of truth, artifacts are evidence-bound | `README.md`, Specwright Wiki `00-Maps/Home.md` |
| Product alternatives: runtime platform, harness workbench, enterprise agent governance layer | raw features log `F16`, Specwright Wiki `00-Maps/Questions-Backlog.md` |
| Needed user/product boundary decisions: primary users, packaging, open-source vs commercial, support/SLA, hosted/team deployment | raw features log `F16` |
| Decision should guide package names, command design, docs, and feature prioritization | `FEAT-EPIC-016`, `FEAT-TASK-016.1` through `FEAT-TASK-016.5` |

## Diff Boundary

This record does not approve or implement package, CLI, MCP, host, runtime API, release, CI, README, install-doc, wiki, pricing, support, or hosted-service changes. Those remain separate packets and gates.
