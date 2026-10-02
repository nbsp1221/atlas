import assert from "node:assert/strict"
import test from "node:test"
import {
  assertEmailTriageDefinitionSemantics,
  emailTriageDefinition,
} from "../src/email-triage"

test("Email Triage exposes only predefined classifier routes", () => {
  const routes = emailTriageDefinition.edges
    .filter((edge) => edge.source === "classify_email")
    .map((edge) => edge.key)
    .sort()

  assert.deepEqual(routes, ["archive", "no_action", "notify", "spam"])

  const classifier = emailTriageDefinition.nodes.find(
    (node) => node.key === "classify_email"
  )
  assert(classifier)
  assert.equal(classifier.kind, "decision")
  assert.equal(typeof classifier.config.modelProvider, "string")
  assert.equal(typeof classifier.config.model, "string")

  assert.equal(emailTriageDefinition.schemaVersion, 2)
  const trigger = emailTriageDefinition.nodes.find(
    (node) => node.key === "gmail_event"
  )
  assert(trigger)
  assert.deepEqual(
    {
      integrationKey: trigger.config.integrationKey,
      connectionKey: trigger.config.connectionKey,
      triggerKey: trigger.config.triggerKey,
    },
    {
      integrationKey: "gmail",
      connectionKey: "google-primary",
      triggerKey: "message-received",
    }
  )

  const archive = emailTriageDefinition.nodes.find(
    (node) => node.key === "archive_email"
  )
  assert(archive)
  assert.equal(archive.config.integrationKey, "gmail")
  assert.equal(archive.config.connectionKey, "google-primary")
  assert.equal(archive.config.actionKey, "archive-message")

  const notify = emailTriageDefinition.nodes.find(
    (node) => node.key === "notify_user"
  )
  assert(notify)
  assert.equal(notify.config.interactionChannelKey, "personal-notifications")

  const serialized = JSON.stringify(emailTriageDefinition)
  assert.equal(serialized.includes("gmail-primary"), false)
  assert.equal(serialized.includes("telegram-personal"), false)
})

test("Email Triage rejects graph bindings that lie about handler behavior", () => {
  const invalid = structuredClone(emailTriageDefinition)
  const archive = invalid.nodes.find((node) => node.key === "archive_email")
  assert(archive)
  archive.config.actionKey = "delete-message"

  assert.throws(
    () => assertEmailTriageDefinitionSemantics(invalid),
    /archive_email requires actionKey=archive-message/
  )
})

test("Email Triage rejects route-to-handler drift", () => {
  const invalid = structuredClone(emailTriageDefinition)
  const archiveRoute = invalid.edges.find((edge) => edge.key === "archive")
  assert(archiveRoute)
  archiveRoute.target = "report_spam"

  assert.throws(
    () => assertEmailTriageDefinitionSemantics(invalid),
    /route archive must target archive_email/
  )
})
