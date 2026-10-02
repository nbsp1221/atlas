import assert from "node:assert/strict"
import test from "node:test"
import { emailTriageDefinition } from "@workspace/automations/email-triage"
import { fakeEmail } from "@workspace/automation-simulation"
import type { AutomationGraphDefinition } from "@workspace/domain/persistence"
import type { Database } from "@workspace/db"
import { executeEmailTriageTestRun } from "../src/composition/execute-email-triage-test-run"

// A read-only in-memory stand-in for the two Drizzle selects used to load the
// actual stored version. Any later DB access (including Run creation) fails.
// No PostgreSQL client is created and no DATABASE_URL is used.
function storedVersionDatabase(graphDefinition: AutomationGraphDefinition) {
  let selectCount = 0
  let unexpectedAccess = 0
  const rows = [
    [{ id: "automation-id", activeVersionId: "version-id" }],
    [{ id: "version-id", versionNumber: 7, graphDefinition }],
  ]
  const database = new Proxy(
    {
      select() {
        const result = rows[selectCount++]
        assert(result, "must reject before preflight connection lookups")
        const query = {
          from() {
            return query
          },
          where() {
            return query
          },
          async limit() {
            return result
          },
        }
        return query
      },
    },
    {
      get(target, property, receiver) {
        if (property === "select")
          return Reflect.get(target, property, receiver)
        unexpectedAccess += 1
        assert.fail(`must reject before database operation ${String(property)}`)
      },
    }
  )

  return {
    db: database as unknown as Database,
    assertNoExecution() {
      assert.equal(selectCount, 2, "must inspect the selected stored version")
      assert.equal(
        unexpectedAccess,
        0,
        "must not create a Run or execution evidence"
      )
    },
  }
}

const mutations: Array<{
  name: string
  mutate(graph: AutomationGraphDefinition): void
  message: RegExp
}> = [
  {
    name: "classifier route points to the wrong handler",
    mutate(graph) {
      const edge = graph.edges.find((candidate) => candidate.key === "archive")
      assert(edge)
      edge.target = "report_spam"
    },
    message: /route archive must target archive_email/,
  },
  {
    name: "action identity claims delete instead of archive",
    mutate(graph) {
      const node = graph.nodes.find(
        (candidate) => candidate.key === "archive_email"
      )
      assert(node)
      node.config.actionKey = "delete-message"
    },
    message: /archive_email requires actionKey=archive-message/,
  },
  {
    name: "verification binding is missing after an action",
    mutate(graph) {
      const node = graph.nodes.find(
        (candidate) => candidate.key === "verify_archive"
      )
      assert(node)
      delete node.config.verificationKey
    },
    message: /verify_archive requires verificationKey=message-archived/,
  },
  {
    name: "channel binding is absent",
    mutate(graph) {
      const node = graph.nodes.find(
        (candidate) => candidate.key === "notify_user"
      )
      assert(node)
      delete node.config.interactionChannelKey
    },
    message:
      /notify_user requires interactionChannelKey=personal-notifications/,
  },
  {
    name: "stored graph has duplicate node keys",
    mutate(graph) {
      graph.nodes.push(structuredClone(graph.nodes[0]!))
    },
    message: /Duplicate node key/,
  },
]

for (const mutation of mutations) {
  for (const version of [undefined, 7]) {
    test(`rejects ${version === undefined ? "active" : "explicit"} stored version before Run creation: ${mutation.name}`, async () => {
      const graph = structuredClone(emailTriageDefinition)
      mutation.mutate(graph)
      const database = storedVersionDatabase(graph)

      const result = await executeEmailTriageTestRun(database.db, {
        email: fakeEmail(),
        version,
        scenario: { route: "archive" },
      })

      assert.equal(result.kind, "binding_error")
      if (result.kind !== "binding_error") assert.fail("expected binding error")
      assert.equal(result.code, "invalid_automation_definition")
      assert.match(result.message, mutation.message)
      database.assertNoExecution()
    })
  }
}
