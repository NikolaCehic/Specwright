import { z } from "zod";
import { SEMVER_PATTERN } from "./gate-contract-version";

export const CompatibilityClassSchema = z.enum([
  "patch-compatible",
  "additive-compatible",
  "forward-compatible",
  "backward-compatible",
  "migration-required",
  "breaking"
]);

export type CompatibilityClass = z.infer<typeof CompatibilityClassSchema>;

export const EngineChangelogEntrySchema = z
  .object({
    version: z.string().regex(SEMVER_PATTERN),
    class: CompatibilityClassSchema,
    summary: z.string().trim().min(1),
    verdictSemanticsChanged: z.boolean(),
    affectedFixtures: z.array(z.string().trim().min(1)),
    migrationDescriptorId: z.string().trim().min(1).optional()
  })
  .strict();

export type EngineChangelogEntry = z.infer<typeof EngineChangelogEntrySchema>;
