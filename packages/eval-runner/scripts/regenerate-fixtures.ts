import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, type RunEvalRequest } from "../src/index";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const entries = await readdir(fixturesDir, { withFileTypes: true });
let regenerated = 0;

for (const entry of entries) {
  if (!entry.isDirectory() || entry.name === "registry") {
    continue;
  }

  const fixtureDir = join(fixturesDir, entry.name);
  const requestPath = join(fixtureDir, "request.json");
  const expectedPath = join(fixtureDir, "expected-verdict.json");

  const existingExpected = await readOptionalFile(expectedPath);

  if (existingExpected === undefined) {
    continue;
  }

  let request: RunEvalRequest;

  try {
    request = JSON.parse(await readFile(requestPath, "utf8")) as RunEvalRequest;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      continue;
    }

    throw error;
  }

  const verdict = runEval(request);

  await mkdir(fixtureDir, { recursive: true });
  await writeFile(expectedPath, `${JSON.stringify(verdict, null, 2)}\n`);
  regenerated += 1;
}

console.log(`Regenerated ${regenerated} eval-runner fixture verdicts.`);

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}
