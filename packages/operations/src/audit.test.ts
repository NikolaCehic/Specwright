import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperationAuditRecord,
  buildOperationAuditRecord,
  hashOperationCanonical,
  readOperationAuditRecords
} from "./index";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-operations-audit-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("operations audit stream", () => {
  test("validates, appends, and reads per-tenant records", async () => {
    const record = buildOperationAuditRecord({
      action: "tenant_job_completed",
      outcome: "allowed",
      tenant: "tenant-a",
      actor: "operator-a",
      timestamp: "2026-06-12T12:00:00.000Z",
      reasonCode: "tenant_scoped_job",
      subjectRefs: ["job:report", "run:run-a"]
    });

    await appendOperationAuditRecord({ rootDir, record });

    const records = await readOperationAuditRecords({ rootDir, tenant: "tenant-a" });

    expect(records).toEqual([record]);
    expect(records[0]?.subjectHashes.every((hash) =>
      /^sha256:[0-9a-f]{64}$/.test(hash)
    )).toBe(true);
  });

  test("hashes canonical values deterministically", () => {
    expect(hashOperationCanonical({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe(
      hashOperationCanonical({ a: [1, { c: 3, d: 4 }], b: 2 })
    );
    expect(hashOperationCanonical({ a: 1 })).not.toBe(
      hashOperationCanonical({ a: 2 })
    );
  });

  test("rejects invalid tenant path segments", () => {
    expect(() =>
      buildOperationAuditRecord({
        action: "tenant_job_completed",
        outcome: "allowed",
        tenant: "../tenant-a",
        actor: "operator-a",
        timestamp: "2026-06-12T12:00:00.000Z",
        reasonCode: "tenant_scoped_job",
        subjectRefs: ["job:report"]
      })
    ).toThrow();
  });
});
