import assert from "node:assert/strict"
import { serve } from "@hono/node-server"
import { createDatabase } from "@workspace/db"
import { Hono } from "hono"
import { verificationDatabaseUrl } from "../../../scripts/verification-isolation.mjs"
import { emailTriageTestRunRoutes } from "../src/http/routes/email-triage-test-runs"

// No canonical fallback, fixed-port reuse, external adapters, or credentials.
// The runner owns this freshly created database; both children use it.
const runId = process.env.VERIFICATION_RUN_ID
assert(runId, "Owned verification run ID is required")
const databaseUrl = verificationDatabaseUrl("e2e", runId)
assert.equal(process.env.DATABASE_URL, databaseUrl)
assert(process.send, "This fixture must be started by its isolated parent")

const { db, client } = createDatabase(databaseUrl)
const app = new Hono()
app.route("/", emailTriageTestRunRoutes(db))
app.onError((error, context) => {
  console.error(error)
  return context.json({ error: "internal_error" }, 500)
})

// Kernel-assigned loopback ports cannot attach to an existing API process.
const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
  (address) => {
    process.send?.({
      type: "ready",
      pid: process.pid,
      url: `http://127.0.0.1:${address.port}`,
      runId,
    })
  }
)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    if ("closeIdleConnections" in server) server.closeIdleConnections()
  })
  await client.end()
  if (process.connected) process.disconnect()
}

process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "shutdown"
  ) {
    void shutdown()
  }
})
process.once("disconnect", () => {
  void shutdown()
})
process.once("SIGINT", () => {
  void shutdown()
})
process.once("SIGTERM", () => {
  void shutdown()
})
