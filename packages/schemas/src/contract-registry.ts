import { z } from "zod";
import type { ZodTypeAny } from "zod";

export const ContractFamilySchema = z.enum([
  "identity",
  "lifecycle",
  "event",
  "harness",
  "capability",
  "governance",
  "verification",
  "evidence",
  "artifact",
  "observability",
  "adapter",
  "compatibility"
]);
export type ContractFamily = z.infer<typeof ContractFamilySchema>;

export const ContractCompatibilityClassSchema = z.enum([
  "patch-compatible",
  "additive-compatible",
  "forward-compatible",
  "backward-compatible",
  "migration-required",
  "breaking"
]);
export type ContractCompatibilityClass = z.infer<
  typeof ContractCompatibilityClassSchema
>;

export const ContractStatusSchema = z.enum(["public", "internal"]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

export const ContractDurabilitySchema = z.enum([
  "durable",
  "derived",
  "transient",
  "embedded"
]);
export type ContractDurability = z.infer<typeof ContractDurabilitySchema>;

export const ContractRegistryRecordSchema = z
  .object({
    id: z.string().min(1),
    exportName: z.string().min(1),
    family: ContractFamilySchema,
    secondaryFamily: z.union([ContractFamilySchema, z.literal("none")]),
    owner: z.string().min(1),
    version: z.string().min(1),
    schemaFormat: z.literal("zod"),
    canonicalHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    compatibilityClass: ContractCompatibilityClassSchema,
    status: ContractStatusSchema,
    durability: ContractDurabilitySchema,
    redaction: z
      .object({
        defaultClass: z.enum([
          "model",
          "adapter",
          "operator",
          "audit",
          "restricted",
          "secret"
        ]),
        fields: z.array(
          z
            .object({
              path: z.string().min(1),
              class: z.enum([
                "model",
                "adapter",
                "operator",
                "audit",
                "restricted",
                "secret"
              ])
            })
            .strict()
        )
      })
      .strict(),
    authority: z
      .object({
        semantics: z.string().min(1),
        ownerReviewGroup: z.string().min(1)
      })
      .strict(),
    extensionPoints: z.array(z.string().min(1)),
    migrationDescriptors: z.array(z.string().min(1)),
    generatedArtifacts: z
      .object({
        validator: z.string().min(1),
        type: z.string().min(1),
        jsonSchema: z.string().min(1),
        fixture: z.string().min(1),
        negativeFixture: z.string().min(1),
        replayFixture: z.string().min(1).optional()
      })
      .strict(),
    conformanceFixtures: z.array(z.string().min(1)),
    notes: z.string().min(1)
  })
  .strict();
export type ContractRegistryRecord = z.infer<
  typeof ContractRegistryRecordSchema
>;

export type ContractLookupResult = {
  record: ContractRegistryRecord;
  validator: ZodTypeAny;
};

export function contractRegistryKey(id: string, version: string) {
  return `${id}@${version}`;
}
