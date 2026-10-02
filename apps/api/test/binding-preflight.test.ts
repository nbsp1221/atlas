import assert from "node:assert/strict"
import test from "node:test"
import { emailTriageDefinition } from "@workspace/automations/email-triage"
import type { IntegrationDescriptor } from "@workspace/domain/integrations"
import type { AutomationGraphDefinition } from "@workspace/domain/persistence"
import {
  BindingPreflightError,
  preflightAutomationBindings,
  type BindingConnection,
  type BindingRepository,
  type InteractionChannelResolver,
} from "../src/composition/binding-preflight"

const registry = new Map<string, IntegrationDescriptor>([
  ["gmail", { key: "gmail", providerKey: "google" }],
  ["telegram", { key: "telegram", providerKey: "telegram" }],
])

const googleConnection: BindingConnection = {
  id: "google-id",
  key: "google-primary",
  providerKey: "google",
  credentialRef: null,
  grants: {},
  status: "disabled",
}

const telegramConnection: BindingConnection = {
  id: "telegram-id",
  key: "telegram-atlas-bot",
  providerKey: "telegram",
  credentialRef: null,
  grants: {},
  status: "disabled",
}

function repository(
  rows: BindingConnection[] = [googleConnection, telegramConnection]
): BindingRepository {
  return {
    async connectionsByKeys(keys) {
      return rows.filter((row) => keys.includes(row.key))
    },
  }
}

function resolver(
  value: {
    integrationKey: string
    connectionKey: string
  } = {
    integrationKey: "telegram",
    connectionKey: "telegram-atlas-bot",
  }
): InteractionChannelResolver {
  return {
    async resolve(key) {
      if (key !== "personal-notifications") {
        throw new Error("missing channel")
      }
      return value
    },
  }
}

function graph(): AutomationGraphDefinition {
  return structuredClone(emailTriageDefinition)
}

async function expectPreflightCode(
  code: string,
  operation: () => Promise<unknown>
) {
  await assert.rejects(
    operation,
    (error) => error instanceof BindingPreflightError && error.code === code,
    `expected BindingPreflightError(${code})`
  )
}

test("test mode resolves disabled credential-less fake bindings", async () => {
  const result = await preflightAutomationBindings({
    graph: graph(),
    mode: "test",
    repository: repository(),
    registry,
    interactionChannels: resolver(),
  })

  assert.deepEqual(result.connectionIdsByKey, {
    "google-primary": "google-id",
    "telegram-atlas-bot": "telegram-id",
  })
  assert.deepEqual(result.interactionChannelKeys, ["personal-notifications"])
})

test("rejects integrations that are not installed", async () => {
  const invalid = graph()
  const archive = invalid.nodes.find((node) => node.key === "archive_email")
  assert(archive)
  archive.config.integrationKey = "unknown-mail"

  await expectPreflightCode("integration_not_installed", () =>
    preflightAutomationBindings({
      graph: invalid,
      mode: "test",
      repository: repository(),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("rejects missing connections", async () => {
  await expectPreflightCode("connection_not_found", () =>
    preflightAutomationBindings({
      graph: graph(),
      mode: "test",
      repository: repository([telegramConnection]),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("rejects provider mismatches", async () => {
  await expectPreflightCode("provider_mismatch", () =>
    preflightAutomationBindings({
      graph: graph(),
      mode: "test",
      repository: repository([
        { ...googleConnection, providerKey: "telegram" },
        telegramConnection,
      ]),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("live mode requires active connections", async () => {
  await expectPreflightCode("connection_not_active", () =>
    preflightAutomationBindings({
      graph: graph(),
      mode: "live",
      repository: repository(),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("live mode requires credential references", async () => {
  await expectPreflightCode("connection_missing_credentials", () =>
    preflightAutomationBindings({
      graph: graph(),
      mode: "live",
      repository: repository([
        { ...googleConnection, status: "active" },
        { ...telegramConnection, status: "active" },
      ]),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("missing interaction channels become a stable preflight error", async () => {
  const missing: InteractionChannelResolver = {
    async resolve() {
      throw new Error("not configured")
    },
  }

  await expectPreflightCode("interaction_channel_not_found", () =>
    preflightAutomationBindings({
      graph: graph(),
      mode: "test",
      repository: repository(),
      registry,
      interactionChannels: missing,
    })
  )
})

test("rejects interaction channels bound to the wrong provider", async () => {
  await expectPreflightCode("provider_mismatch", () =>
    preflightAutomationBindings({
      graph: graph(),
      mode: "test",
      repository: repository(),
      registry,
      interactionChannels: resolver({
        integrationKey: "telegram",
        connectionKey: "google-primary",
      }),
    })
  )
})

test("live mode accepts active credentialed bindings", async () => {
  const result = await preflightAutomationBindings({
    assertCredentialUsable: async () => {},
    graph: graph(),
    mode: "live",
    repository: repository([
      {
        ...googleConnection,
        status: "active",
        credentialRef: "secret://google",
      },
      {
        ...telegramConnection,
        status: "active",
        credentialRef: "secret://telegram",
      },
    ]),
    registry,
    interactionChannels: resolver(),
  })

  assert.equal(result.connectionIdsByKey["google-primary"], "google-id")
  assert.equal(result.connectionIdsByKey["telegram-atlas-bot"], "telegram-id")
})

for (const [nodeKey, field, value] of [
  ["gmail_event", "triggerKey", null],
  ["archive_email", "actionKey", ""],
  ["verify_archive", "verificationKey", 42],
  ["notify_user", "interactionChannelKey", "   "],
  ["verify_delivery", "interactionChannelKey", null],
  ["verify_delivery", "verificationKey", ""],
] as const) {
  test(`rejects malformed ${nodeKey}.${field} before resolving bindings`, async () => {
    const invalid = graph()
    const node = invalid.nodes.find((candidate) => candidate.key === nodeKey)
    assert(node)
    node.config[field] = value
    await expectPreflightCode("invalid_node_binding", () =>
      preflightAutomationBindings({
        graph: invalid,
        mode: "live",
        repository: {
          async connectionsByKeys() {
            assert.fail("malformed bindings must fail before repository access")
          },
        },
        registry,
        interactionChannels: {
          async resolve() {
            assert.fail(
              "malformed bindings must fail before channel resolution"
            )
          },
        },
      })
    )
  })
}

for (const [nodeKey, field] of [
  ["gmail_event", "triggerKey"],
  ["archive_email", "actionKey"],
  ["verify_archive", "verificationKey"],
  ["verify_delivery", "verificationKey"],
] as const) {
  test(`rejects missing ${nodeKey}.${field}`, async () => {
    const invalid = graph()
    const node = invalid.nodes.find((candidate) => candidate.key === nodeKey)
    assert(node)
    delete node.config[field]
    await expectPreflightCode("invalid_node_binding", () =>
      preflightAutomationBindings({
        graph: invalid,
        mode: "test",
        repository: repository(),
        registry,
        interactionChannels: resolver(),
      })
    )
  })
}

test("rejects mixed external and channel bindings instead of choosing one", async () => {
  const invalid = graph()
  const archive = invalid.nodes.find((node) => node.key === "archive_email")
  assert(archive)
  archive.config.interactionChannelKey = "personal-notifications"
  await expectPreflightCode("invalid_node_binding", () =>
    preflightAutomationBindings({
      graph: invalid,
      mode: "test",
      repository: repository(),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("rejects an operation key for the wrong node kind", async () => {
  const invalid = graph()
  const archive = invalid.nodes.find((node) => node.key === "archive_email")
  assert(archive)
  archive.config.triggerKey = "message-received"
  await expectPreflightCode("invalid_node_binding", () =>
    preflightAutomationBindings({
      graph: invalid,
      mode: "test",
      repository: repository(),
      registry,
      interactionChannels: resolver(),
    })
  )
})

test("allows internal nodes that do not declare external binding fields", async () => {
  const internal: AutomationGraphDefinition = {
    schemaVersion: 2,
    nodes: [
      { key: "manual", kind: "trigger", config: {} },
      { key: "transform", kind: "action", config: { format: "json" } },
      { key: "check", kind: "verify", config: { expected: true } },
      { key: "choose", kind: "decision", config: {} },
      { key: "done", kind: "terminal", config: {} },
    ],
    edges: [],
  }
  const result = await preflightAutomationBindings({
    graph: internal,
    mode: "live",
    repository: repository([]),
    registry: new Map(),
    interactionChannels: {
      async resolve() {
        assert.fail("internal nodes must not resolve external channels")
      },
    },
  })
  assert.deepEqual(result, {
    connectionIdsByKey: {},
    interactionChannelKeys: [],
  })
})
