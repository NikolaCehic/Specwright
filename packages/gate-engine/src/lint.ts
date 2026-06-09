import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGateDefinition, type GateDefinitionFinding } from "./definition";

export type GateDefinitionLintIssue = {
  file: string;
  finding: GateDefinitionFinding;
};

export type GateDefinitionLintResult = {
  checked: number;
  issues: GateDefinitionLintIssue[];
};

type YamlLine = {
  indent: number;
  text: string;
};

type PlainRecord = Record<string, unknown>;

export async function lintGateDefinitionFiles(
  gatesDir = defaultHarnessGatesDir()
): Promise<GateDefinitionLintResult> {
  const entries = await readdir(gatesDir);
  const files = entries
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort();
  const issues: GateDefinitionLintIssue[] = [];

  for (const file of files) {
    const path = join(gatesDir, file);
    const definition = parseSimpleYaml(await readFile(path, "utf8"));
    const validation = validateGateDefinition(definition);

    if (!validation.ok) {
      issues.push({ file: path, finding: validation.finding });
    }
  }

  return {
    checked: files.length,
    issues
  };
}

export function defaultHarnessGatesDir() {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../harnesses/default/gates"
  );
}

export async function runGateDefinitionLintCli() {
  const result = await lintGateDefinitionFiles();

  if (result.issues.length === 0) {
    console.log(`Validated ${result.checked} gate definition(s)`);
    return;
  }

  for (const issue of result.issues) {
    console.error(
      `${issue.file}: ${issue.finding.id}: ${issue.finding.message}`
    );
  }

  process.exitCode = 1;
}

function parseSimpleYaml(source: string): unknown {
  const parser = new SimpleYamlParser(
    source
      .split(/\r?\n/u)
      .map(stripYamlComment)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .map((line) => ({
        indent: line.length - line.trimStart().length,
        text: line.trimStart()
      }))
  );
  const parsed = parser.parseBlock(0);
  parser.assertComplete();
  return parsed;
}

class SimpleYamlParser {
  private index = 0;

  constructor(private readonly lines: readonly YamlLine[]) {}

  parseBlock(indent: number): unknown {
    const line = this.peek();

    if (line === undefined || line.indent < indent) {
      return {};
    }

    if (line.text.startsWith("- ")) {
      return this.parseSequence(line.indent);
    }

    return this.parseMapping(line.indent);
  }

  assertComplete() {
    if (this.index < this.lines.length) {
      const line = this.lines[this.index];
      throw new Error(`Unexpected YAML line: ${line?.text ?? ""}`);
    }
  }

  private parseMapping(indent: number): PlainRecord {
    const output: PlainRecord = {};

    while (this.index < this.lines.length) {
      const line = this.peek();

      if (line === undefined || line.indent < indent) {
        break;
      }

      if (line.indent > indent) {
        throw new Error(`Unexpected indentation before ${line.text}`);
      }

      if (line.text.startsWith("- ")) {
        break;
      }

      this.consumePair(output, line.text, indent);
    }

    return output;
  }

  private parseSequence(indent: number): unknown[] {
    const output: unknown[] = [];

    while (this.index < this.lines.length) {
      const line = this.peek();

      if (line === undefined || line.indent < indent) {
        break;
      }

      if (line.indent > indent) {
        throw new Error(`Unexpected indentation before ${line.text}`);
      }

      if (!line.text.startsWith("- ")) {
        break;
      }

      const rest = line.text.slice(2).trim();
      this.index += 1;

      if (rest.length === 0) {
        output.push(this.parseIndentedChild(indent));
        continue;
      }

      if (looksLikePair(rest)) {
        const item: PlainRecord = {};
        this.consumePairText(item, rest, indent + 2);

        while (this.index < this.lines.length) {
          const next = this.peek();

          if (next === undefined || next.indent <= indent) {
            break;
          }

          if (next.text.startsWith("- ")) {
            throw new Error(`Sequence item needs a key before ${next.text}`);
          }

          this.consumePair(item, next.text, next.indent);
        }

        output.push(item);
        continue;
      }

      output.push(parseYamlScalar(rest));
    }

    return output;
  }

  private parseIndentedChild(parentIndent: number): unknown {
    const next = this.peek();

    if (next === undefined || next.indent <= parentIndent) {
      return null;
    }

    return this.parseBlock(next.indent);
  }

  private consumePair(output: PlainRecord, text: string, indent: number) {
    this.index += 1;
    this.consumePairText(output, text, indent);
  }

  private consumePairText(output: PlainRecord, text: string, indent: number) {
    const pair = splitYamlPair(text);

    if (pair === undefined) {
      throw new Error(`Expected YAML key/value pair at ${text}`);
    }

    output[pair.key] =
      pair.value.length === 0
        ? this.parseIndentedChild(indent)
        : parseYamlScalar(pair.value);
  }

  private peek() {
    return this.lines[this.index];
  }
}

function stripYamlComment(line: string) {
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === "\"" || char === "'") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }

    if (char === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }

  return line;
}

function splitYamlPair(text: string) {
  const colonIndex = text.indexOf(":");

  if (colonIndex <= 0) {
    return undefined;
  }

  return {
    key: unquoteString(text.slice(0, colonIndex).trim()),
    value: text.slice(colonIndex + 1).trim()
  };
}

function looksLikePair(text: string) {
  const colonIndex = text.indexOf(":");

  if (colonIndex <= 0) {
    return false;
  }

  const key = text.slice(0, colonIndex).trim();

  return /^["']?[$A-Z_a-z][-$.\w]*["']?$/u.test(key);
}

function parseYamlScalar(value: string): unknown {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null" || value === "~") {
    return null;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInline(value.slice(1, -1)).map(parseYamlScalar);
  }

  if (isQuoted(value)) {
    return unquoteString(value);
  }

  if (/^-?(0|[1-9]\d*)(\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  return value;
}

function splitInline(value: string) {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\"" || char === "'") {
      quote = quote === char ? undefined : quote ?? char;
    }

    if (quote === undefined) {
      if (char === "[" || char === "{") {
        depth += 1;
      }

      if (char === "]" || char === "}") {
        depth -= 1;
      }

      if (char === "," && depth === 0) {
        items.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim().length > 0) {
    items.push(current.trim());
  }

  return items;
}

function isQuoted(value: string) {
  return (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}

function unquoteString(value: string) {
  if (isQuoted(value)) {
    return value.slice(1, -1);
  }

  return value;
}

if (process.argv[1]?.endsWith("lint.ts") || process.argv[1]?.endsWith("lint.js")) {
  await runGateDefinitionLintCli();
}
