import { resolve } from "node:path";

export type AssuranceLevel = "anonymous" | "low" | "medium" | "high";
export type PrincipalSource =
  | "anonymous"
  | "local"
  | "ci"
  | "service"
  | "delegated";

export type CliPrincipal = {
  id: string;
  source: PrincipalSource;
  assuranceLevel: AssuranceLevel;
  roles: string[];
};

export type CliTenantContext = {
  id: string;
  allowedRoots?: string[] | undefined;
};

export type CliExecutionContext = {
  principal: CliPrincipal;
  tenant: CliTenantContext;
  ci: boolean;
};

export type EnvironmentLike = Record<string, string | undefined>;

export type CliExecutionContextInput = {
  principal?: CliPrincipal | undefined;
  tenant?: CliTenantContext | undefined;
  ci?: boolean | undefined;
  env?: EnvironmentLike | undefined;
};

export const ANONYMOUS_PRINCIPAL: CliPrincipal = Object.freeze({
  id: "anonymous",
  source: "anonymous",
  assuranceLevel: "anonymous",
  roles: []
});

export function resolveExecutionContext(
  input: CliExecutionContextInput = {}
): CliExecutionContext {
  const env = input.env ?? {};
  const principal = input.principal ?? principalFromEnv(env);
  const tenant =
    input.tenant ??
    tenantFromEnv(env) ??
    ({ id: "anonymous", allowedRoots: undefined } satisfies CliTenantContext);

  return {
    principal,
    tenant: {
      ...tenant,
      allowedRoots: tenant.allowedRoots?.map((root) => resolve(root))
    },
    ci: input.ci ?? env.CI === "true"
  };
}

export function contextForProcess(env: EnvironmentLike): CliExecutionContext {
  const fallbackUser =
    env.SPECWRIGHT_ACTOR_ID ??
    env.GITHUB_ACTOR ??
    env.USER ??
    env.LOGNAME ??
    "local-operator";
  const tenantId = env.SPECWRIGHT_TENANT_ID ?? "local";
  const allowedRoots =
    env.SPECWRIGHT_ALLOWED_ROOTS === undefined ||
    env.SPECWRIGHT_ALLOWED_ROOTS.length === 0
      ? undefined
      : env.SPECWRIGHT_ALLOWED_ROOTS.split(":").filter((value) => value.length > 0);

  return resolveExecutionContext({
    env,
    principal: {
      id: fallbackUser,
      source: env.CI === "true" ? "ci" : "local",
      assuranceLevel: env.CI === "true" ? "medium" : "low",
      roles: rolesFromEnv(env)
    },
    tenant: {
      id: tenantId,
      allowedRoots
    },
    ci: env.CI === "true"
  });
}

export function isAuthenticated(principal: CliPrincipal): boolean {
  return principal.id !== "anonymous" && principal.source !== "anonymous";
}

function principalFromEnv(env: EnvironmentLike): CliPrincipal {
  const id =
    env.SPECWRIGHT_ACTOR_ID ??
    env.SPECWRIGHT_SERVICE_PRINCIPAL_ID ??
    env.GITHUB_ACTOR;

  if (id === undefined || id.trim().length === 0) {
    return ANONYMOUS_PRINCIPAL;
  }

  return {
    id,
    source:
      env.SPECWRIGHT_SERVICE_PRINCIPAL_ID !== undefined
        ? "service"
        : env.CI === "true"
          ? "ci"
          : "delegated",
    assuranceLevel:
      env.SPECWRIGHT_SERVICE_PRINCIPAL_ID !== undefined ? "high" : "medium",
    roles: rolesFromEnv(env)
  };
}

function tenantFromEnv(env: EnvironmentLike): CliTenantContext | undefined {
  const id = env.SPECWRIGHT_TENANT_ID;

  if (id === undefined || id.trim().length === 0) {
    return undefined;
  }

  return {
    id,
    allowedRoots:
      env.SPECWRIGHT_ALLOWED_ROOTS === undefined
        ? undefined
        : env.SPECWRIGHT_ALLOWED_ROOTS.split(":").filter(
            (value) => value.length > 0
          )
  };
}

function rolesFromEnv(env: EnvironmentLike): string[] {
  return (env.SPECWRIGHT_ROLES ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}
