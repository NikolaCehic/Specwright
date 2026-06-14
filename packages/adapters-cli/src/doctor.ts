import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CLI_VERSION } from "./constants";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  path?: string | undefined;
  operatorAction?: string | undefined;
};

export type DoctorReport = {
  rootDir: string;
  mode: "source-checkout";
  cliVersion: string;
  configDir: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: DoctorCheck[];
};

const CANONICAL_CONFIG_DIR = `.${"specwright"}`;

export async function runDoctor(input: { rootDir: string }): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const root = await safeStat(input.rootDir);

  if (root === undefined || root.isDirectory() === false) {
    checks.push({
      id: "root.exists",
      status: "fail",
      message: "Root directory is not readable.",
      path: input.rootDir,
      operatorAction: "Pass --root with an existing project or checkout directory."
    });

    return report(input.rootDir, checks);
  }

  checks.push({
    id: "root.exists",
    status: "pass",
    message: "Root directory is readable.",
    path: input.rootDir
  });

  await checkRootManifest(input.rootDir, checks);
  await checkCliManifest(input.rootDir, checks);
  await checkBuildArtifact({
    rootDir: input.rootDir,
    path: "packages/adapters-cli/dist/bin.js",
    id: "build.cli_bin",
    message: "CLI bin artifact is present.",
    missingMessage: "CLI bin artifact is missing."
  }, checks);
  await checkBuildArtifact({
    rootDir: input.rootDir,
    path: "packages/runtime/dist/index.js",
    id: "build.runtime_entrypoint",
    message: "Runtime entrypoint artifact is present.",
    missingMessage: "Runtime entrypoint artifact is missing."
  }, checks);
  await checkConfigDir(input.rootDir, checks);
  await checkLicense(input.rootDir, checks);

  return report(input.rootDir, checks);
}

async function checkRootManifest(rootDir: string, checks: DoctorCheck[]) {
  const manifestPath = join(rootDir, "package.json");
  const manifest = await readJson(manifestPath);

  if (manifest === undefined) {
    checks.push({
      id: "package.root_manifest",
      status: "warn",
      message: "No root package.json was found.",
      path: manifestPath,
      operatorAction:
        "Run doctor at the Specwright source checkout or a configured project root."
    });
    return;
  }

  checks.push({
    id: "package.root_manifest",
    status: manifest.name === "specwright" ? "pass" : "warn",
    message:
      manifest.name === "specwright"
        ? "Root package manifest identifies the Specwright source checkout."
        : "Root package manifest does not identify the Specwright source checkout.",
    path: manifestPath,
    ...(manifest.name === "specwright"
      ? {}
      : {
          operatorAction:
            "Use --root to point at the Specwright checkout until project config discovery is implemented."
        })
  });
}

async function checkCliManifest(rootDir: string, checks: DoctorCheck[]) {
  const manifestPath = join(rootDir, "packages/adapters-cli/package.json");
  const manifest = await readJson(manifestPath);

  if (manifest === undefined) {
    checks.push({
      id: "package.cli_manifest",
      status: "warn",
      message: "CLI package manifest was not found.",
      path: manifestPath,
      operatorAction:
        "Install the public CLI package or run doctor from a complete source checkout."
    });
    return;
  }

  checks.push({
    id: "package.cli_manifest",
    status: manifest.name === "@specwright/cli" ? "pass" : "fail",
    message:
      manifest.name === "@specwright/cli"
        ? "CLI package manifest uses the public package identity."
        : "CLI package manifest does not use the public package identity.",
    path: manifestPath,
    ...(manifest.name === "@specwright/cli"
      ? {}
      : {
          operatorAction:
            "Promote or repair the CLI package manifest before packaging."
        })
  });
}

async function checkBuildArtifact(
  input: {
    rootDir: string;
    path: string;
    id: string;
    message: string;
    missingMessage: string;
  },
  checks: DoctorCheck[]
) {
  const artifactPath = join(input.rootDir, input.path);
  const artifact = await safeStat(artifactPath);

  checks.push({
    id: input.id,
    status: artifact?.isFile() === true ? "pass" : "warn",
    message: artifact?.isFile() === true ? input.message : input.missingMessage,
    path: artifactPath,
    ...(artifact?.isFile() === true
      ? {}
      : { operatorAction: "Run bun run build before packaging or smoke testing." })
  });
}

async function checkConfigDir(rootDir: string, checks: DoctorCheck[]) {
  const configPath = join(rootDir, CANONICAL_CONFIG_DIR);
  const config = await safeStat(configPath);

  checks.push({
    id: "config.local_root",
    status: config?.isDirectory() === true ? "pass" : "warn",
    message:
      config?.isDirectory() === true
        ? "Local Specwright config directory is present."
        : "Local Specwright config directory is not present yet.",
    path: configPath,
    ...(config?.isDirectory() === true
      ? {}
      : {
          operatorAction:
            "Run init after the naming/config packet enables project config creation."
        })
  });
}

async function checkLicense(rootDir: string, checks: DoctorCheck[]) {
  const licensePath = join(rootDir, "LICENSE");
  const license = await safeStat(licensePath);

  checks.push({
    id: "package.license",
    status: license?.isFile() === true ? "pass" : "warn",
    message:
      license?.isFile() === true
        ? "Repository license file is present."
        : "Repository license file was not found.",
    path: licensePath,
    ...(license?.isFile() === true
      ? {}
      : { operatorAction: "Add or restore a repository license before release." })
  });
}

function report(rootDir: string, checks: DoctorCheck[]): DoctorReport {
  return {
    rootDir,
    mode: "source-checkout",
    cliVersion: CLI_VERSION,
    configDir: CANONICAL_CONFIG_DIR,
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length
    },
    checks
  };
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as { name?: unknown };
  } catch {
    return undefined;
  }
}
