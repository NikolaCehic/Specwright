import { describe, expect, test } from "bun:test";
import { classifyCompatibility } from "./index";

describe("release compatibility classifier", () => {
  test("classifies patch, additive, migration-required, and breaking changes deterministically", () => {
    const additive = classifyCompatibility({
      deployedVersion: "0.1.0",
      candidateVersion: "0.1.1",
      changes: [
        {
          changeId: "optional-trace-field",
          kind: "optional-span-metadata",
          description: "Add optional release id metadata to trace spans"
        }
      ]
    });
    const repeated = classifyCompatibility({
      deployedVersion: "0.1.0",
      candidateVersion: "0.1.1",
      changes: [
        {
          changeId: "optional-trace-field",
          kind: "optional-span-metadata",
          description: "Add optional release id metadata to trace spans"
        }
      ]
    });
    const migration = classifyCompatibility({
      deployedVersion: "0.1.0",
      candidateVersion: "0.2.0",
      changes: [
        {
          changeId: "new-required-span",
          kind: "required-span-kind",
          description: "Require a new span kind for historical runs"
        }
      ]
    });
    const breaking = classifyCompatibility({
      deployedVersion: "0.1.0",
      candidateVersion: "1.0.0",
      changes: [
        {
          changeId: "weaken-tenancy",
          kind: "tenancy-isolation-weakening",
          description: "Allow implicit all-tenant scans"
        }
      ]
    });

    expect(additive).toEqual(repeated);
    expect(additive).toMatchObject({
      compatibilityClass: "additive-compatible",
      promotable: true
    });
    expect(migration).toMatchObject({
      compatibilityClass: "migration-required",
      promotable: false
    });
    expect(breaking).toMatchObject({
      compatibilityClass: "breaking",
      promotable: false
    });
  });

  test("blocks backward extensions outside declared extension points", () => {
    expect(
      classifyCompatibility({
        deployedVersion: "0.1.0",
        candidateVersion: "0.1.1",
        changes: [
          {
            changeId: "strict-old-reader",
            kind: "backward-extension",
            description: "Old operators cannot ignore the field"
          }
        ]
      })
    ).toMatchObject({
      compatibilityClass: "migration-required",
      promotable: false
    });
  });
});
