import { z } from "zod";
import {
  MetadataSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "./corpus";
import { Sha256HashSchema, hashString } from "./hash";
import { MemoryError } from "./errors";

const nonEmptyString = z.string().min(1);

export const MemoryDocumentSchema = z
  .object({
    id: nonEmptyString,
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    class: MemoryClassSchema,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    content: nonEmptyString,
    ingestTimestamp: z.string().datetime({ offset: true }).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((document, context) => {
    if (document.sourceHash !== hashString(document.content)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceHash must match document content"
      });
    }
  });
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

export function parseMemoryDocument(input: unknown): MemoryDocument {
  const parsed = MemoryDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_document",
      field: "document",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}
