import assert from "node:assert/strict"
import test from "node:test"
import {
  ExecutionEngine,
  ExecutionSuspendedError,
  type ExecutionStore,
} from "../src/index"
import { automationGraphDefinitionSchema } from "@workspace/domain/persistence"

for (const suspended of [true, false]) {
  test(
    suspended
      ? "persisted continuation suspension leaves exactly one running node and run without replay"
      : "an ordinary error with suspension wording still fails the node and run",
    async () => {
      const calls: string[] = []
      let handlerCalls = 0
      let runStatus = "queued"
      let nodeStatus = "missing"
      const operations = {
        async claimRun() {
          calls.push("claimRun")
          return {
            id: "original-run",
            created: true,
            automationVersionId: "stored-version",
            status: "queued",
            output: null,
            error: null,
          }
        },
        async startRun(id: string) {
          assert.equal(id, "original-run")
          calls.push("startRun")
          runStatus = "running"
        },
        async startNodeExecution(input: {
          runId: string
          nodeKey: string
          sequence: number
          retryOfNodeExecutionId?: string
        }) {
          assert.equal(input.runId, "original-run")
          assert.equal(input.nodeKey, "archive")
          assert.equal(input.sequence, 1)
          assert.equal(input.retryOfNodeExecutionId, undefined)
          calls.push("startNodeExecution")
          nodeStatus = "running"
          return { id: "original-node" }
        },
        async failNodeExecution(id: string) {
          assert.equal(id, "original-node")
          calls.push("failNodeExecution")
          nodeStatus = "failed"
        },
        async failRun(id: string) {
          assert.equal(id, "original-run")
          calls.push("failRun")
          runStatus = "failed"
        },
      }
      const store = new Proxy(operations, {
        get(target, key, receiver) {
          if (key in target) return Reflect.get(target, key, receiver)
          assert.fail(`suspension must not invoke ${String(key)}`)
        },
      }) as unknown as ExecutionStore
      const engine = new ExecutionEngine({
        store,
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        policy: { maxNodeRetries: 3, allowExternalActions: true },
        modelInvoker: {
          async invoke() {
            assert.fail("must not rerun a classifier")
          },
        },
        handlers: new Map([
          [
            "archive",
            {
              async execute() {
                handlerCalls++
                if (suspended) throw new ExecutionSuspendedError()
                throw new Error("Execution has a persisted continuation")
              },
            },
          ],
          [
            "verify",
            {
              async execute() {
                assert.fail("must not advance to verification")
              },
            },
          ],
        ]),
      })
      const result = await engine.execute({
        automationId: "automation",
        automationVersionId: "stored-version",
        mode: "test",
        input: { messageId: "message-original" },
        connectionIdsByKey: {},
        graph: automationGraphDefinitionSchema.parse({
          schemaVersion: 1,
          entryNodeKey: "archive",
          nodes: [
            { key: "archive", kind: "action" },
            { key: "verify", kind: "verify" },
          ],
          edges: [
            { key: "archive_verify", source: "archive", target: "verify" },
          ],
        }),
      })
      assert.equal(handlerCalls, 1)
      assert.equal(result.runId, "original-run")
      assert.equal(result.automationVersionId, "stored-version")
      assert.equal(result.admission, "created")
      assert.equal(result.status, suspended ? "running" : "failed")
      assert.equal(runStatus, suspended ? "running" : "failed")
      assert.equal(nodeStatus, suspended ? "running" : "failed")
      assert.deepEqual(calls, [
        "claimRun",
        "startRun",
        "startNodeExecution",
        ...(suspended ? [] : ["failNodeExecution", "failRun"]),
      ])
    }
  )
}
