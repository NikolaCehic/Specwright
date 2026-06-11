import { resolve } from "node:path";
import { CliAuthError, CliInputError } from "./errors";
import {
  isAuthenticated,
  type CliExecutionContext,
  type CliPrincipal
} from "./context";

export type CommandAuthority = "read" | "privileged" | "decision";

export function assertAuthorized(input: {
  command: string;
  authority: CommandAuthority;
  context: CliExecutionContext;
  runId?: string | undefined;
}): void {
  if (
    (input.authority === "privileged" || input.authority === "decision") &&
    !isAuthenticated(input.context.principal)
  ) {
    throw new CliAuthError(
      `${input.command} requires an authenticated principal`,
      { runId: input.runId }
    );
  }
}

export function canonicalizeAllowedPath(input: {
  value: string | undefined;
  flagName: string;
  context: CliExecutionContext;
}): string | undefined {
  if (input.value === undefined) {
    return undefined;
  }

  if (input.value.trim().length === 0) {
    throw new CliInputError(`--${input.flagName} cannot be empty`);
  }

  const canonical = resolve(input.value);
  const allowedRoots = input.context.tenant.allowedRoots;

  if (allowedRoots !== undefined && allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => pathInsideRoot(canonical, root));

    if (!allowed) {
      throw new CliAuthError(
        `--${input.flagName} is outside tenant ${input.context.tenant.id} allowed roots`
      );
    }
  }

  return canonical;
}

export function assertCanWidenRedaction(input: {
  principal: CliPrincipal;
  profile: string;
}): void {
  if (input.profile === "shared-log") {
    return;
  }

  if (
    !isAuthenticated(input.principal) ||
    !input.principal.roles.includes("redaction:read-restricted")
  ) {
    throw new CliAuthError(
      `redaction profile ${input.profile} requires redaction:read-restricted`
    );
  }
}

function pathInsideRoot(path: string, root: string): boolean {
  const canonicalRoot = resolve(root);
  return path === canonicalRoot || path.startsWith(`${canonicalRoot}/`);
}
