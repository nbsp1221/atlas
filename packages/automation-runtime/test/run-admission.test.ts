import assert from "node:assert/strict"
import test from "node:test"
import { ExecutionEngine, type ExecutionStore } from "../src/index"
import type { RunStatus } from "@workspace/domain/persistence"

for (const status of [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as RunStatus[]) {
  test(`duplicate ${status} run is observation without any execution or mutation`, async () => {
    let claims = 0
    const store = new Proxy(
      {
        async claimRun() {
          claims += 1
          return {
            id: "original-run",
            created: false,
            automationVersionId: "original-version",
            status,
            output: { original: "output" },
            error:
              status === "failed" ? { code: "external_action_unknown" } : null,
          }
        },
      },
      {
        get(target, key, receiver) {
          if (key === "claimRun") return Reflect.get(target, key, receiver)
          assert.fail(`duplicate invoked store mutation ${String(key)}`)
        },
      }
    ) as unknown as ExecutionStore
    const engine = new ExecutionEngine({
      store,
      modelInvoker: {
        async invoke() {
          assert.fail("duplicate invoked model")
        },
      },
      handlers: new Map(),
    })
    const result = await engine.execute({
      automationId: "automation",
      automationVersionId: "newer-version",
      mode: "test",
      input: { different: "payload" },
      // A duplicate must return before graph traversal, even with no entry.
      graph: { schemaVersion: 1, nodes: [], edges: [] },
      idempotencyKey: "same-event",
      connectionIdsByKey: {},
    })
    assert.equal(claims, 1)
    assert.equal(result.runId, "original-run")
    assert.equal(result.automationVersionId, "original-version")
    assert.equal(result.status, status)
    assert.equal(result.admission, "duplicate")
    if (result.status === "succeeded")
      assert.deepEqual(result.output, { original: "output" })
    if (result.status === "failed")
      assert.deepEqual(result.error, { code: "external_action_unknown" })
  })
}
