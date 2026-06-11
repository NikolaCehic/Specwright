import { CliInputError } from "./errors";

export const DEFAULT_EVENT_LIMIT = 100;

export type BoundedRead<T> = {
  items: T[];
  truncated: boolean;
  shown: number;
  total: number;
};

export function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_EVENT_LIMIT;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliInputError("--limit must be a positive integer");
  }

  return Number(value);
}

export function boundRead<T>(items: readonly T[], limit: number): BoundedRead<T> {
  const bounded = items.slice(0, limit);

  return {
    items: bounded,
    truncated: bounded.length < items.length,
    shown: bounded.length,
    total: items.length
  };
}

export function truncationDiagnostic(input: {
  shown: number;
  total: number;
}) {
  return {
    code: "output_truncated",
    message: `Output truncated: showing ${input.shown} of ${input.total} events.`,
    shown: input.shown,
    total: input.total,
    truncated: true
  };
}
