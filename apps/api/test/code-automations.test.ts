import assert from "node:assert/strict"
import test from "node:test"
import { emailSummaryAutomation } from "@workspace/automations"
import type { Database } from "@workspace/db"
import type {
  AutomationGraphDefinition,
  JsonObject,
} from "@workspace/domain/persistence"
import { codeAutomationRoutes } from "../src/http/routes/code-automations"
import { sha256Json } from "../src/lib/stable-json"
function database(
  graph = emailSummaryAutomation.definition,
  hash = sha256Json(graph)
) {
  let calls = 0
  const db = new Proxy(
    {
      select() {
        const data =
          calls++ === 0
            ? [{ id: "a", activeVersionId: "v" }]
            : [
                {
                  id: "v",
                  versionNumber: 1,
                  graphDefinition: graph,
                  definitionHash: hash,
                },
              ]
        const query = {
          from() {
            return query
          },
          where() {
            return query
          },
          async limit() {
            return data
          },
        }
        return query
      },
    },
    {
      get(target, key) {
        if (key !== "select")
          assert.fail(`Unexpected DB operation ${String(key)}`)
        return target.select
      },
    }
  ) as unknown as Database
  return db
}
const path = "/api/code-automations/email-summary/test-runs"
for (const [name, body] of [
  ["version required", { input: [] }],
  ["input required", { version: 1 }],
  ["version cannot be latest", { version: "latest", input: [] }],
  [
    "arbitrary module rejected",
    { version: 1, input: [], modulePath: "/tmp/payload.ts" },
  ],
  ["source rejected", { version: 1, input: [], source: "eval('x')" }],
] as const)
  test(name, async () => {
    const routes = codeAutomationRoutes(database())
    const response = await routes.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
  })
test("unknown automation is rejected before any DB access", async () => {
  const response = await codeAutomationRoutes({} as Database).request(
    "/api/code-automations/unknown/test-runs",
    {
      method: "POST",
      body: JSON.stringify({ version: 1, input: [] }),
      headers: { "content-type": "application/json" },
    }
  )
  assert.equal(response.status, 404)
})
test("invalid JSON rejected", async () => {
  const response = await codeAutomationRoutes({} as Database).request(path, {
    method: "POST",
    body: "{",
  })
  assert.equal(response.status, 400)
})
test("invalid initial input returns structured issues before creating a Run", async () => {
  const response = await codeAutomationRoutes(database()).request(path, {
    method: "POST",
    body: JSON.stringify({ version: 1, input: [{ id: "broken" }] }),
    headers: { "content-type": "application/json" },
  })
  assert.equal(response.status, 400)
  const data = await response.json()
  assert(
    data && typeof data === "object" && "error" in data && "issues" in data
  )
  assert(Array.isArray(data.issues))
  assert.equal(data.error, "invalid_step_input")
  assert(data.issues.length > 0)
})
for (const field of [
  "id",
  "version",
  "source",
  "sourceHash",
  "implementationHash",
  "inputSchema",
])
  test(`rejects stored implementation ${field} drift before Run`, async () => {
    const graph = structuredClone(emailSummaryAutomation.definition)
    ;(graph.nodes[0].config.implementation as JsonObject)[field] = "wrong"
    const response = await codeAutomationRoutes(database(graph)).request(path, {
      method: "POST",
      body: JSON.stringify({ version: 1, input: [] }),
      headers: { "content-type": "application/json" },
    })
    assert.equal(response.status, 409)
  })
for (const mutate of [
  (graph: AutomationGraphDefinition) => {
    graph.entryNodeKey = "missing"
  },
  (graph: AutomationGraphDefinition) => {
    graph.nodes.push(structuredClone(graph.nodes[0]))
  },
  (graph: AutomationGraphDefinition) => {
    graph.nodes[0].kind = "trigger"
  },
  (graph: AutomationGraphDefinition) => {
    graph.edges[0].target = "summarize"
  },
])
  test("rejects invalid graph structure before Run", async () => {
    const graph = structuredClone(emailSummaryAutomation.definition)
    mutate(graph)
    const response = await codeAutomationRoutes(database(graph)).request(path, {
      method: "POST",
      body: JSON.stringify({ version: 1, input: [] }),
      headers: { "content-type": "application/json" },
    })
    assert.equal(response.status, 409)
  })
test("stored graph hash mismatch fails closed", async () => {
  const response = await codeAutomationRoutes(
    database(emailSummaryAutomation.definition, "incorrect")
  ).request("/api/code-automations/email-summary/versions/1")
  assert.equal(response.status, 409)
})
test("inspect returns exact version, source metadata, schemas, graph, and fixture", async () => {
  const response = await codeAutomationRoutes(database()).request(
    "/api/code-automations/email-summary/versions/1"
  )
  assert.equal(response.status, 200)
  const value = await response.json()
  assert(
    value && typeof value === "object" && "version" in value && "graph" in value
  )
  assert(
    value.graph && typeof value.graph === "object" && "nodes" in value.graph
  )
  assert(Array.isArray(value.graph.nodes))
  assert.equal(value.version, 1)
  assert.equal(value.graph.nodes.length, 3)
  assert.equal(
    value.graph.nodes[0].config.implementation.source,
    emailSummaryAutomation.definition.nodes[0].config.implementation &&
      (
        emailSummaryAutomation.definition.nodes[0].config
          .implementation as JsonObject
      ).source
  )
})
