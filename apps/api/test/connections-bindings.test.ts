import test from "node:test"
import assert from "node:assert/strict"
import {
  emailTriageDefinition,
  assertEmailTriageDefinitionSemantics,
} from "@workspace/automations/email-triage"
import { configureEmailTriageGraph } from "../src/connections/automation-bindings"
import { preflightAutomationBindings } from "../src/composition/binding-preflight"
import { installedIntegrations } from "../src/composition/integration-registry"
const mailbox = {
  id: "mailbox-id",
  key: "google-second",
  providerKey: "google",
  label: "Mail",
  status: "disabled",
  authState: "missing",
}
const model = {
  id: "model-id",
  key: "openai-one",
  providerKey: "openai",
  label: "Model",
  status: "active",
  authState: "unchecked",
}
test("reusable bindings create a distinct immutable graph, preserving operation semantics", () => {
  const original = JSON.stringify(emailTriageDefinition)
  const changed = configureEmailTriageGraph(
    emailTriageDefinition,
    mailbox,
    model,
    "chosen-model"
  )
  assert.equal(JSON.stringify(emailTriageDefinition), original)
  assert(
    changed.nodes
      .filter((n) => n.config.integrationKey === "gmail")
      .every((n) => n.config.connectionKey === mailbox.key)
  )
  assert.equal(
    changed.nodes.find((n) => n.key === "classify_email")?.config
      .modelConnectionKey,
    model.key
  )
  assert.equal(
    changed.nodes.find((n) => n.key === "archive_email")?.config.actionKey,
    "archive-message"
  )
  const incoherent = structuredClone(changed)
  incoherent.nodes.find(
    (n) => n.key === "verify_archive"
  )!.config.connectionKey = "other"
  assert.throws(
    () => assertEmailTriageDefinitionSemantics(incoherent),
    /same mailbox/
  )
  assert.throws(
    () =>
      configureEmailTriageGraph(
        emailTriageDefinition,
        { ...mailbox, providerKey: "telegram" },
        model,
        "x"
      ),
    /invalid_mailbox_connection/
  )
  const fake = configureEmailTriageGraph(changed, mailbox, null, "ignored")
  assert.equal(
    fake.nodes.find((n) => n.key === "classify_email")?.config.modelProvider,
    "testkit"
  )
  assert(
    !(
      "modelConnectionKey" in
      fake.nodes.find((n) => n.key === "classify_email")!.config
    )
  )
})
test("live preflight fails without credential resolver even when a reference exists", async () => {
  const graph = configureEmailTriageGraph(
    emailTriageDefinition,
    mailbox,
    model,
    "chosen-model"
  )
  const rows = [
    mailbox,
    model,
    {
      ...mailbox,
      id: "bot-id",
      key: "telegram-atlas-bot",
      providerKey: "telegram",
    },
  ].map((row) => ({
    ...row,
    status: "active" as const,
    credentialRef: "not-a-real-secret",
    grants: {},
  }))
  const input = {
    graph,
    mode: "live" as const,
    repository: { connectionsByKeys: async () => rows },
    registry: installedIntegrations,
    interactionChannels: {
      resolve: async () => ({
        integrationKey: "telegram",
        connectionKey: "telegram-atlas-bot",
      }),
    },
  }
  await assert.rejects(
    () => preflightAutomationBindings(input),
    /Live credentials cannot be verified/
  )
  const ids: string[] = []
  const result = await preflightAutomationBindings({
    ...input,
    assertCredentialUsable: async (id) => {
      ids.push(id)
    },
  })
  assert.equal(result.connectionIdsByKey[model.key], model.id)
  assert(ids.includes(model.id))
})
