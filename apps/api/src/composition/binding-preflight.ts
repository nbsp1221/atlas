import type { IntegrationDescriptor } from "@workspace/domain/integrations"
import {
  externalActionBindingSchema,
  externalTriggerBindingSchema,
  externalVerificationBindingSchema,
  interactionChannelBindingSchema,
} from "@workspace/domain/integrations"
import type {
  AutomationGraphDefinition,
  ConnectionStatus,
  JsonObject,
  RunMode,
} from "@workspace/domain/persistence"

export type BindingConnection = {
  id: string
  key: string
  providerKey: string
  credentialRef: string | null
  credentialId?: string | null
  grants: JsonObject
  status: ConnectionStatus
}

export type BindingRepository = {
  connectionsByKeys(keys: string[]): Promise<BindingConnection[]>
}

export type InteractionChannelResolver = {
  resolve(key: string): Promise<{
    integrationKey: string
    connectionKey: string
  }>
}

export class BindingPreflightError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "BindingPreflightError"
  }
}

function descriptorFor(
  registry: ReadonlyMap<string, IntegrationDescriptor>,
  integrationKey: string
) {
  const descriptor = registry.get(integrationKey)
  if (!descriptor) {
    throw new BindingPreflightError(
      "integration_not_installed",
      `Integration is not installed: ${integrationKey}`
    )
  }
  return descriptor
}

export async function preflightAutomationBindings(input: {
  graph: AutomationGraphDefinition
  mode: RunMode
  repository: BindingRepository
  registry: ReadonlyMap<string, IntegrationDescriptor>
  interactionChannels: InteractionChannelResolver
  assertCredentialUsable?: (
    connectionId: string,
    providerKey: string,
    requiredGrants: string[]
  ) => Promise<void>
}) {
  const requested = new Map<
    string,
    { integrationKey: string; connectionKey: string }
  >()
  const channelKeys = new Set<string>()

  for (const node of input.graph.nodes) {
    if ("modelConnectionKey" in node.config) {
      const connectionKey = node.config.modelConnectionKey,
        provider = node.config.modelProvider
      if (
        typeof connectionKey !== "string" ||
        !connectionKey.trim() ||
        typeof provider !== "string" ||
        !["openai", "anthropic"].includes(provider)
      )
        throw new BindingPreflightError(
          "invalid_model_binding",
          "Invalid model connection binding"
        )
      requested.set(`model-${provider}:${connectionKey}`, {
        integrationKey: `model-${provider}`,
        connectionKey,
      })
    }
    if (!["trigger", "action", "verify"].includes(node.kind)) continue

    const hasChannel = "interactionChannelKey" in node.config
    const hasExternal = [
      "integrationKey",
      "connectionKey",
      "triggerKey",
      "actionKey",
    ].some((key) => key in node.config)
    const hasVerification = "verificationKey" in node.config

    // Nodes with no binding fields may perform internal work. Once a node
    // declares an external/channel binding, malformed or mixed shapes fail closed.
    if (!hasChannel && !hasExternal && !hasVerification) continue
    const invalidBinding = () =>
      new BindingPreflightError(
        "invalid_node_binding",
        `Invalid ${node.kind} binding for node ${node.key}`
      )

    if (hasChannel) {
      const channel = interactionChannelBindingSchema.safeParse(node.config)
      const verificationKey = node.config.verificationKey
      if (
        node.kind === "trigger" ||
        hasExternal ||
        !channel.success ||
        (node.kind === "action" && hasVerification) ||
        (node.kind === "verify" &&
          (typeof verificationKey !== "string" || !verificationKey.trim()))
      ) {
        throw invalidBinding()
      }
      channelKeys.add(channel.data.interactionChannelKey)
      continue
    }

    const operationKey =
      node.kind === "trigger"
        ? "triggerKey"
        : node.kind === "action"
          ? "actionKey"
          : "verificationKey"
    if (
      ["triggerKey", "actionKey", "verificationKey"].some(
        (key) => key !== operationKey && key in node.config
      )
    ) {
      throw invalidBinding()
    }

    if (node.kind === "trigger") {
      const parsed = externalTriggerBindingSchema.safeParse(node.config)
      if (parsed.success) {
        requested.set(
          `${parsed.data.integrationKey}:${parsed.data.connectionKey}`,
          parsed.data
        )
      } else {
        throw invalidBinding()
      }
      continue
    }

    if (node.kind === "action") {
      const external = externalActionBindingSchema.safeParse(node.config)
      if (external.success) {
        requested.set(
          `${external.data.integrationKey}:${external.data.connectionKey}`,
          external.data
        )
        continue
      }

      throw invalidBinding()
    }

    if (node.kind === "verify") {
      const external = externalVerificationBindingSchema.safeParse(node.config)
      if (external.success) {
        requested.set(
          `${external.data.integrationKey}:${external.data.connectionKey}`,
          external.data
        )
        continue
      }

      throw invalidBinding()
    }
  }

  for (const key of channelKeys) {
    let channel
    try {
      channel = await input.interactionChannels.resolve(key)
    } catch {
      throw new BindingPreflightError(
        "interaction_channel_not_found",
        `Interaction channel not found: ${key}`
      )
    }
    requested.set(`${channel.integrationKey}:${channel.connectionKey}`, channel)
  }

  const connectionKeys = [
    ...new Set([...requested.values()].map((binding) => binding.connectionKey)),
  ]
  const rows = await input.repository.connectionsByKeys(connectionKeys)
  const byKey = new Map(rows.map((connection) => [connection.key, connection]))

  for (const binding of requested.values()) {
    const descriptor = descriptorFor(input.registry, binding.integrationKey)
    const connection = byKey.get(binding.connectionKey)

    if (!connection) {
      throw new BindingPreflightError(
        "connection_not_found",
        `Connection not found: ${binding.connectionKey}`
      )
    }

    if (connection.providerKey !== descriptor.providerKey) {
      throw new BindingPreflightError(
        "provider_mismatch",
        `Integration ${binding.integrationKey} requires provider ${descriptor.providerKey}, but ${binding.connectionKey} uses ${connection.providerKey}`
      )
    }

    if (input.mode === "live") {
      if (connection.status !== "active") {
        throw new BindingPreflightError(
          "connection_not_active",
          `Connection is not active: ${binding.connectionKey}`
        )
      }
      if (!connection.credentialId && !connection.credentialRef) {
        throw new BindingPreflightError(
          "connection_missing_credentials",
          `Connection has no credential reference: ${binding.connectionKey}`
        )
      }
      if (!input.assertCredentialUsable)
        throw new BindingPreflightError(
          "credential_resolver_unavailable",
          "Live credentials cannot be verified"
        )
      await input.assertCredentialUsable(
        connection.id,
        descriptor.providerKey,
        descriptor.requiredGrants ?? []
      )
    }
  }

  return {
    connectionIdsByKey: Object.fromEntries(
      rows.map((connection) => [connection.key, connection.id])
    ),
    interactionChannelKeys: [...channelKeys],
  }
}
