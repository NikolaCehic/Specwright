import { z } from "zod";
import type { CandidateChunk } from "../chunk";
import type { MemoryDocument } from "../document";
import { MemoryError } from "../errors";
import { hashValue } from "../hash";
import type { ChunkingStrategy } from "./index";

export const StructuralChunkingConfigSchema = z
  .object({
    parserId: z.literal("markdown-structural").default("markdown-structural"),
    parserVersion: z.string().min(1),
    granularity: z.enum(["section", "block"]).default("block")
  })
  .strict();
export type StructuralChunkingConfig = z.infer<
  typeof StructuralChunkingConfigSchema
>;

interface LineRecord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface BlockRecord {
  readonly lines: LineRecord[];
  readonly kind: string;
  readonly sectionPath: string[];
}

function parseConfig(config: unknown): StructuralChunkingConfig {
  const parsed = StructuralChunkingConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_document",
      field: "structural.config",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export const StructuralChunkingStrategy = {
  id: "structural",
  configSchema: StructuralChunkingConfigSchema,
  version(config: unknown) {
    const parsed = parseConfig(config);
    return hashValue({
      strategy: "structural",
      parserId: parsed.parserId,
      parserVersion: parsed.parserVersion,
      granularity: parsed.granularity
    });
  },
  chunk(document: MemoryDocument, config: unknown): CandidateChunk[] {
    const parsed = parseConfig(config);
    const blocks = collectBlocks(document.content);
    const candidates =
      parsed.granularity === "section"
        ? chunksBySection(document.content, blocks)
        : chunksByBlock(document.content, blocks);

    if (candidates.length === 0) {
      throw new MemoryError({
        code: "invalid_document",
        field: "content",
        condition: "empty_structure",
        message: "Document content produced no structural chunks"
      });
    }

    return candidates;
  }
} satisfies ChunkingStrategy<StructuralChunkingConfig>;

function collectLines(text: string): LineRecord[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines: LineRecord[] = [];
  let offset = 0;

  for (const rawLine of normalized.split("\n")) {
    const start = offset;
    const end = start + rawLine.length;
    lines.push({ text: rawLine, start, end });
    offset = end + 1;
  }

  return lines;
}

function collectBlocks(text: string): BlockRecord[] {
  const lines = collectLines(text);
  const sectionStack: string[] = [];
  const blocks: BlockRecord[] = [];
  let current: LineRecord[] = [];
  let currentKind = "paragraph";
  let inFence = false;

  const flush = () => {
    const nonBlank = current.filter((line) => line.text.trim().length > 0);
    if (nonBlank.length > 0) {
      blocks.push({
        lines: nonBlank,
        kind: currentKind,
        sectionPath: [...sectionStack]
      });
    }
    current = [];
    currentKind = "paragraph";
  };

  for (const line of lines) {
    const trimmed = line.text.trim();
    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    const fence = /^```/u.test(trimmed);
    const listItem = /^[-*+]\s+|\d+\.\s+/u.test(trimmed);

    if (!inFence && heading !== null) {
      flush();
      const level = heading[1]?.length ?? 1;
      sectionStack.splice(level - 1);
      sectionStack[level - 1] = heading[2] ?? "";
      blocks.push({
        lines: [line],
        kind: "heading",
        sectionPath: [...sectionStack]
      });
      continue;
    }

    if (fence) {
      if (!inFence) {
        flush();
        inFence = true;
        currentKind = "code";
        current = [line];
        continue;
      }

      current.push(line);
      flush();
      inFence = false;
      continue;
    }

    if (inFence) {
      current.push(line);
      continue;
    }

    if (trimmed.length === 0) {
      flush();
      continue;
    }

    const nextKind = listItem ? "list" : "paragraph";
    if (current.length > 0 && currentKind !== nextKind) {
      flush();
    }
    currentKind = nextKind;
    current.push(line);
  }

  flush();
  return blocks;
}

function chunksByBlock(text: string, blocks: readonly BlockRecord[]): CandidateChunk[] {
  return blocks.map((block) => chunkFromLines(text, block.lines, block));
}

function chunksBySection(
  text: string,
  blocks: readonly BlockRecord[]
): CandidateChunk[] {
  const sections = new Map<string, BlockRecord[]>();
  const order: string[] = [];

  for (const block of blocks) {
    const key =
      block.sectionPath.length === 0 ? "__root__" : block.sectionPath.join(" > ");
    if (!sections.has(key)) {
      sections.set(key, []);
      order.push(key);
    }
    sections.get(key)?.push(block);
  }

  return order.map((key) => {
    const sectionBlocks = sections.get(key) ?? [];
    const lines = sectionBlocks.flatMap((block) => block.lines);
    const firstBlock = sectionBlocks[0];
    if (firstBlock === undefined) {
      throw new MemoryError({
        code: "invalid_chunk",
        field: "section",
        condition: "empty",
        message: "Structural section unexpectedly contained no blocks"
      });
    }
    return chunkFromLines(text, lines, {
      kind: "section",
      sectionPath: firstBlock.sectionPath
    });
  });
}

function chunkFromLines(
  text: string,
  lines: readonly LineRecord[],
  block: Pick<BlockRecord, "kind" | "sectionPath">
): CandidateChunk {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) {
    throw new MemoryError({
      code: "invalid_chunk",
      field: "structural.lines",
      condition: "empty",
      message: "Cannot create structural chunk from no lines"
    });
  }

  const span = {
    start: first.start,
    end: last.end
  };

  return {
    text: text.slice(span.start, span.end),
    span,
    metadata: {
      structuralKind: block.kind,
      sectionPath: block.sectionPath
    }
  };
}
