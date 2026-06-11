import { CliInputError, CliTimeoutError } from "./errors";

export const DEFAULT_DEADLINE_MS = 30_000;

export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new CliTimeoutError(message));
        }, deadlineMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function parsePositiveIntegerFlag(input: {
  value: string | undefined;
  flagName: string;
  defaultValue: number;
}): number {
  if (input.value === undefined) {
    return input.defaultValue;
  }

  if (!/^[1-9]\d*$/.test(input.value)) {
    throw new CliInputError(`--${input.flagName} must be a positive integer`);
  }

  return Number(input.value);
}
