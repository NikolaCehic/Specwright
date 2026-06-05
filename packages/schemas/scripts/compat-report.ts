import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompatibilityReport } from "../src/compatibility";
import type { HashManifestEntry } from "../src/compatibility";
import type { ContractRegistryRecord } from "../src/contract-registry";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const contractsRoot = join(packageRoot, "contracts");

const report = buildCompatibilityReport({
  registryVersion: "scope-01.packet-05",
  baselineRegistry: readJson<ContractRegistryRecord[]>(
    join(contractsRoot, "baseline", "registry.json")
  ),
  currentRegistry: readJson<ContractRegistryRecord[]>(
    join(contractsRoot, "registry.json")
  ),
  baselineManifest: readJson<HashManifestEntry[]>(
    join(contractsRoot, "baseline", "hash-manifest.json")
  ),
  currentManifest: readJson<HashManifestEntry[]>(
    join(contractsRoot, "hash-manifest.json")
  )
});

writeFileSync(
  join(contractsRoot, "compatibility-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8"
);

function readJson<TValue>(path: string): TValue {
  return JSON.parse(readFileSync(path, "utf8")) as TValue;
}
