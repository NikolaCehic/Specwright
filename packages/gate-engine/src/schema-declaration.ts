import { z, type ZodTypeAny } from "zod";

export function zodSchemaFromDeclaration(
  declaration: unknown
): ZodTypeAny | undefined {
  if (isZodSchema(declaration)) {
    return declaration;
  }

  if (!isRecord(declaration)) {
    return undefined;
  }

  if (hasOwn(declaration, "enum")) {
    if (!Array.isArray(declaration.enum)) {
      return undefined;
    }

    const values = declaration.enum.filter(isString);

    if (values.length !== declaration.enum.length || values.length === 0) {
      return undefined;
    }

    return z.enum(values as [string, ...string[]]);
  }

  if (typeof declaration.type !== "string") {
    return undefined;
  }

  switch (declaration.type) {
    case "object": {
      if (declaration.properties !== undefined && !isRecord(declaration.properties)) {
        return undefined;
      }

      if (declaration.required !== undefined && !isStringArray(declaration.required)) {
        return undefined;
      }

      const properties = declaration.properties ?? {};
      const required = new Set(declaration.required ?? []);
      const shape: Record<string, ZodTypeAny> = {};

      for (const requiredKey of required) {
        if (!hasOwn(properties, requiredKey)) {
          return undefined;
        }
      }

      for (const [key, childDeclaration] of Object.entries(properties)) {
        const child = zodSchemaFromDeclaration(childDeclaration);

        if (child === undefined) {
          return undefined;
        }

        shape[key] = required.has(key) ? child : child.optional();
      }

      const objectSchema = z.object(shape);

      return declaration.additionalProperties === false
        ? objectSchema.strict()
        : objectSchema.passthrough();
    }
    case "array": {
      if (declaration.items === undefined) {
        return z.array(z.unknown());
      }

      const itemSchema = zodSchemaFromDeclaration(declaration.items);

      return itemSchema === undefined ? undefined : z.array(itemSchema);
    }
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      return undefined;
  }
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return isRecord(value) && typeof value.safeParse === "function";
}
