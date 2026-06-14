import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");
const checkerPath = join(rootDir, "scripts/check-package-dependencies.mjs");

describe("OPT-003B package dependency isolation", () => {
  test("current workspace has no dependency findings", () => {
    const result = runChecker(["--root", rootDir, "--json"]);

    expect(result.status).toBe(0);
    expect(result.json.packageCount).toBe(17);
    expect(result.json.blockingFindings).toEqual([]);
    expect(result.json.advisoryFindings).toEqual([]);
  });

  test("string-bound dynamic imports are production dependency evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "specwright-deps-"));

    try {
      await mkdir(join(tempRoot, "packages/app/src"), { recursive: true });
      await writeJson(join(tempRoot, "package.json"), {
        name: "fixture-root",
        private: true,
        workspaces: ["packages/*"]
      });
      await writeJson(join(tempRoot, "packages/app/package.json"), {
        name: "@fixture/app",
        type: "module",
        dependencies: {
          "@fixture/run-store": "workspace:*"
        }
      });
      await writeFile(
        join(tempRoot, "packages/app/src/index.ts"),
        [
          "export async function appendEvent() {",
          '  const moduleName = "@fixture/run-store";',
          "  return import(moduleName);",
          "}",
          "",
          "export async function recordSpan() {",
          '  const moduleName = "@fixture/trace-recorder";',
          "  return import(moduleName);",
          "}"
        ].join("\n")
      );

      const result = runChecker(["--root", tempRoot, "--json"]);

      expect(result.status).toBe(1);
      expect(result.json.blockingFindings).toContainEqual({
        package: "@fixture/app",
        code: "undeclared_production_import",
        dependency: "@fixture/trace-recorder",
        files: ["packages/app/src/index.ts"]
      });
      expect(result.json.advisoryFindings).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function runChecker(args: string[]) {
  const result = spawnSync("bun", [checkerPath, ...args], {
    cwd: rootDir,
    encoding: "utf8"
  });

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    json: JSON.parse(result.stdout)
  };
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
