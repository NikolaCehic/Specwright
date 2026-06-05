import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  CompatibilityClassSchema,
  type CompatibilityClass
} from "./classify";

const nonEmptyString = z.string().min(1);

export const LoaderBehaviorSchema = z.enum(["load", "migrate", "deny"]);
export type LoaderBehavior = z.infer<typeof LoaderBehaviorSchema>;

export const CompatibilityMatrixRowSchema = z
  .object({
    id: nonEmptyString,
    runtimeVersion: nonEmptyString,
    harnessSchemaVersion: nonEmptyString,
    packageVersionRange: nonEmptyString,
    supportClass: CompatibilityClassSchema,
    loaderBehavior: LoaderBehaviorSchema
  })
  .strict();

export type CompatibilityMatrixRow = z.infer<
  typeof CompatibilityMatrixRowSchema
>;

export const CompatibilityMatrixSchema = z
  .object({
    matrixId: nonEmptyString,
    rows: z.array(CompatibilityMatrixRowSchema).min(1)
  })
  .strict();

export type CompatibilityMatrix = z.infer<typeof CompatibilityMatrixSchema>;

export type MatrixLookupInput = {
  runtimeVersion: string;
  harnessSchemaVersion: string;
  packageVersion: string;
};

export class CompatibilityMatrixError extends Error {
  readonly reason: "malformed_matrix" | "no_matrix_cell" | "ambiguous_matrix_cell";
  readonly details: Record<string, unknown> | undefined;

  constructor(
    reason: "malformed_matrix" | "no_matrix_cell" | "ambiguous_matrix_cell",
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CompatibilityMatrixError";
    this.reason = reason;
    this.details = details;
  }
}

export const DEFAULT_RUNTIME_VERSION = "current";

export const DEFAULT_COMPATIBILITY_MATRIX: CompatibilityMatrix =
  CompatibilityMatrixSchema.parse({
    matrixId: "specwright.harness-loader.compatibility.v1",
    rows: [
      {
        id: "current-v0-load",
        runtimeVersion: DEFAULT_RUNTIME_VERSION,
        harnessSchemaVersion: "specwright.harness.v0",
        packageVersionRange: "*",
        supportClass: "content-stable",
        loaderBehavior: "load"
      },
      {
        id: "historical-v0alpha-migrate",
        runtimeVersion: DEFAULT_RUNTIME_VERSION,
        harnessSchemaVersion: "specwright.harness.v0alpha",
        packageVersionRange: "*",
        supportClass: "migration-required",
        loaderBehavior: "migrate"
      }
    ]
  });

export async function loadCompatibilityMatrixFromFile(path: string) {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CompatibilityMatrixError(
      "malformed_matrix",
      `Could not read compatibility matrix ${path}`,
      { path, cause: error }
    );
  }

  const parsed = CompatibilityMatrixSchema.safeParse(parsedJson);

  if (!parsed.success) {
    throw new CompatibilityMatrixError(
      "malformed_matrix",
      `Compatibility matrix is invalid: ${parsed.error.message}`,
      {
        schema: "CompatibilityMatrixSchema",
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

export function lookupCompatibilityMatrix(
  matrix: CompatibilityMatrix,
  input: MatrixLookupInput
): CompatibilityMatrixRow {
  const parsedMatrix = CompatibilityMatrixSchema.parse(matrix);
  const matches = parsedMatrix.rows.filter(
    (row) =>
      row.runtimeVersion === input.runtimeVersion &&
      row.harnessSchemaVersion === input.harnessSchemaVersion &&
      packageVersionMatches(row.packageVersionRange, input.packageVersion)
  );

  const [match] = matches;

  if (match === undefined) {
    throw new CompatibilityMatrixError(
      "no_matrix_cell",
      `No compatibility matrix cell for ${input.runtimeVersion}/${input.harnessSchemaVersion}/${input.packageVersion}`,
      input
    );
  }

  if (matches.length > 1) {
    throw new CompatibilityMatrixError(
      "ambiguous_matrix_cell",
      `Multiple compatibility matrix cells for ${input.runtimeVersion}/${input.harnessSchemaVersion}/${input.packageVersion}`,
      {
        ...input,
        matches: matches.map((row) => row.id)
      }
    );
  }

  return match;
}

export function isLoadableCompatibilityClass(value: CompatibilityClass) {
  return (
    value === "content-stable" ||
    value === "patch-compatible" ||
    value === "additive-compatible" ||
    value === "replay-compatible"
  );
}

function packageVersionMatches(range: string, version: string) {
  return range === "*" || range === version || range === `=${version}`;
}
