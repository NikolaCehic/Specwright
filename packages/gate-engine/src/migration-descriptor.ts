import { z } from "zod";
import { CompatibilityClassSchema } from "./compatibility";
import { compareSemverStrings, SEMVER_PATTERN } from "./gate-contract-version";

export const ReplayImpactSchema = z.enum([
  "none",
  "replay_via_alias",
  "requires_new_verdict_event",
  "audit_gap_if_unmigrated"
]);

export type ReplayImpact = z.infer<typeof ReplayImpactSchema>;

export const MigrationDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    fromEvaluatorVersion: z.string().regex(SEMVER_PATTERN),
    toEvaluatorVersion: z.string().regex(SEMVER_PATTERN),
    class: CompatibilityClassSchema,
    affectedFixtures: z.array(z.string().trim().min(1)).min(1),
    rationale: z.string().trim().min(1),
    replayImpact: ReplayImpactSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      compareSemverStrings(value.toEvaluatorVersion, value.fromEvaluatorVersion) <
      0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "toEvaluatorVersion must be greater than or equal to fromEvaluatorVersion"
      });
    }

    if (new Set(value.affectedFixtures).size !== value.affectedFixtures.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "affectedFixtures must not contain duplicates"
      });
    }
  });

export type MigrationDescriptor = z.infer<typeof MigrationDescriptorSchema>;

export type MigrationDescriptorValidationResult =
  | { ok: true; descriptor: MigrationDescriptor }
  | { ok: false; reason: string };

export function validateMigrationDescriptor(
  value: unknown,
  options: {
    actualChangedFixtures?: readonly string[];
  } = {}
): MigrationDescriptorValidationResult {
  const parsed = MigrationDescriptorSchema.safeParse(value);

  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((issue) => issue.message).join("; ")
    };
  }

  if (options.actualChangedFixtures !== undefined) {
    const expected = normalizedFixtureIds(parsed.data.affectedFixtures);
    const actual = normalizedFixtureIds(options.actualChangedFixtures);

    if (!sameFixtureIds(expected, actual)) {
      return {
        ok: false,
        reason: `Descriptor ${parsed.data.id} affectedFixtures ${expected.join(", ")} do not match actual changed fixtures ${actual.join(", ")}.`
      };
    }
  }

  return { ok: true, descriptor: parsed.data };
}

function normalizedFixtureIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameFixtureIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
