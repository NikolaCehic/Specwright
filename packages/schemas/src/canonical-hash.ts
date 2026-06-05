import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { ContractCompatibilityClass } from "./contract-registry";

export type CanonicalContractInput = {
  id: string;
  version: string;
  schema: ZodTypeAny;
  extensionPoints: readonly string[];
  authoritySemantics: string;
  redaction: unknown;
  compatibility: {
    class: ContractCompatibilityClass;
    durability: string;
  };
};

export function canonicalSchemaHash(input: CanonicalContractInput) {
  return `sha256:${sha256Hex(canonicalStringify(canonicalHashInput(input)))}`;
}

export function canonicalHashInput(input: CanonicalContractInput) {
  return sortValue({
    authoritySemantics: input.authoritySemantics,
    compatibility: input.compatibility,
    contractId: input.id,
    extensionPoints: [...input.extensionPoints].sort(),
    redaction: input.redaction,
    schema: describeZodSchema(input.schema),
    version: input.version
  });
}

export function canonicalStringify(value: unknown) {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(value: string) {
  return sha256Bytes(utf8Bytes(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (isPlainRecord(value)) {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }

    return sorted;
  }

  return value;
}

export function describeZodSchema(schema: ZodTypeAny): unknown {
  if (schema instanceof z.ZodString) {
    return {
      type: "string",
      checks: schema._def.checks
    };
  }

  if (schema instanceof z.ZodNumber) {
    return {
      type: "number",
      checks: schema._def.checks
    };
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }

  if (schema instanceof z.ZodUnknown) {
    return { type: "unknown" };
  }

  if (schema instanceof z.ZodLiteral) {
    return {
      type: "literal",
      value: schema._def.value
    };
  }

  if (schema instanceof z.ZodEnum) {
    return {
      type: "enum",
      values: [...schema._def.values]
    };
  }

  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      element: describeZodSchema(schema.element)
    };
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: "record",
      key: describeZodSchema(schema._def.keyType),
      value: describeZodSchema(schema._def.valueType)
    };
  }

  if (schema instanceof z.ZodUnion) {
    return {
      type: "union",
      options: schema._def.options.map((option: ZodTypeAny) =>
        describeZodSchema(option)
      )
    };
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    return {
      type: "discriminatedUnion",
      discriminator: schema.discriminator,
      options: [...schema.options].map((option) => describeZodSchema(option))
    };
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const fields: Record<string, unknown> = {};

    for (const key of Object.keys(shape).sort()) {
      fields[key] = describeZodSchema(shape[key]);
    }

    return {
      type: "object",
      unknownKeys: schema._def.unknownKeys,
      catchall: describeZodSchema(schema._def.catchall),
      fields
    };
  }

  if (schema instanceof z.ZodOptional) {
    return {
      type: "optional",
      inner: describeZodSchema(schema.unwrap())
    };
  }

  if (schema instanceof z.ZodDefault) {
    return {
      type: "default",
      inner: describeZodSchema(schema.removeDefault())
    };
  }

  if (schema instanceof z.ZodEffects) {
    return {
      type: "effects",
      effect: schema._def.effect.type,
      inner: describeZodSchema(schema.innerType())
    };
  }

  return {
    typeName: schema._def.typeName
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function utf8Bytes(value: string) {
  const bytes: number[] = [];

  for (const codePointText of value) {
    const codePoint = codePointText.codePointAt(0) ?? 0;

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }

  return new Uint8Array(bytes);
}

function sha256Bytes(message: Uint8Array) {
  const hashValues = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ];
  const constants = [
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2
  ];
  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  const words = new Array<number>(64).fill(0);

  padded.set(message);
  padded[message.length] = 0x80;

  for (let index = 0; index < 8; index += 1) {
    padded[paddedLength - 1 - index] = (bitLength / 2 ** (index * 8)) & 0xff;
  }

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        ((padded[wordOffset] ?? 0) << 24) |
        ((padded[wordOffset + 1] ?? 0) << 16) |
        ((padded[wordOffset + 2] ?? 0) << 8) |
        (padded[wordOffset + 3] ?? 0);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15] ?? 0, 7) ^
        rotateRight(words[index - 15] ?? 0, 18) ^
        ((words[index - 15] ?? 0) >>> 3);
      const s1 =
        rotateRight(words[index - 2] ?? 0, 17) ^
        rotateRight(words[index - 2] ?? 0, 19) ^
        ((words[index - 2] ?? 0) >>> 10);
      words[index] =
        ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hashValues;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temp1 =
        ((h ?? 0) + sigma1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>>
        0;
      const sigma0 = rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority =
        ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hashValues[0] = ((hashValues[0] ?? 0) + (a ?? 0)) >>> 0;
    hashValues[1] = ((hashValues[1] ?? 0) + (b ?? 0)) >>> 0;
    hashValues[2] = ((hashValues[2] ?? 0) + (c ?? 0)) >>> 0;
    hashValues[3] = ((hashValues[3] ?? 0) + (d ?? 0)) >>> 0;
    hashValues[4] = ((hashValues[4] ?? 0) + (e ?? 0)) >>> 0;
    hashValues[5] = ((hashValues[5] ?? 0) + (f ?? 0)) >>> 0;
    hashValues[6] = ((hashValues[6] ?? 0) + (g ?? 0)) >>> 0;
    hashValues[7] = ((hashValues[7] ?? 0) + (h ?? 0)) >>> 0;
  }

  return hashValues.flatMap((word) => [
    (word >>> 24) & 0xff,
    (word >>> 16) & 0xff,
    (word >>> 8) & 0xff,
    word & 0xff
  ]);
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}
