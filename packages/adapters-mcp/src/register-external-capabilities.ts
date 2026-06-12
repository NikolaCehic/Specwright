import {
  CapabilityRegistry,
  createToolBroker,
  type ToolBrokerOptions
} from "@specwright/tool-broker";
import type { RuntimeOptions, RuntimeToolBrokerFactoryInput } from "@specwright/runtime";
import {
  createExternalMcpCapabilityDefinitions,
  type CreateExternalMcpCapabilityDefinitionsOptions
} from "./external-capability";

export type RegisterExternalMcpCapabilitiesOptions =
  CreateExternalMcpCapabilityDefinitionsOptions & {
    registry?: CapabilityRegistry | undefined;
  };

export function registerExternalMcpCapabilities(
  options: RegisterExternalMcpCapabilitiesOptions
) {
  const registry = options.registry ?? new CapabilityRegistry();
  const definitions = createExternalMcpCapabilityDefinitions(options);

  for (const definition of definitions) {
    registry.register(definition);
  }

  return {
    registry,
    definitions
  };
}

export type CreateExternalMcpBrokerFactoryOptions =
  RegisterExternalMcpCapabilitiesOptions & {
    policyBundle?: ToolBrokerOptions["policyBundle"] | undefined;
    cacheStore?: ToolBrokerOptions["cacheStore"] | undefined;
  };

export function createExternalMcpBrokerFactory(
  options: CreateExternalMcpBrokerFactoryOptions
) {
  const registered = registerExternalMcpCapabilities(options);

  return (input: RuntimeToolBrokerFactoryInput) => {
    const brokerOptions: ToolBrokerOptions = {
      workspaceRoot: input.workspaceRoot,
      runId: input.runId,
      registry: registered.registry
    };

    if (options.policyBundle !== undefined) {
      brokerOptions.policyBundle = options.policyBundle;
    }

    if (options.cacheStore !== undefined) {
      brokerOptions.cacheStore = options.cacheStore;
    }

    return createToolBroker(brokerOptions);
  };
}

export function withExternalMcpBrokerCapabilities(
  runtimeOptions: RuntimeOptions,
  options: CreateExternalMcpBrokerFactoryOptions
): RuntimeOptions {
  return {
    ...runtimeOptions,
    toolBroker: createExternalMcpBrokerFactory(options)
  };
}
