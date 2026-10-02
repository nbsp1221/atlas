import assert from "node:assert/strict"
import test from "node:test"
import {
  ExecutionEngine,
  ModelProviderError,
  type ExecutionStore,
  type ModelInvoker,
  type NodeExecutionContext,
} from "../src/index"
import { automationGraphDefinitionSchema } from "@workspace/domain/persistence"

test("provider retry stays inside one physical NodeExecution", async () => {
  const nodeRows: Array<{
    id: string
    nodeKey: string
    status: string
  }> = []
  const modelRows: Array<{
    id: string
    nodeExecutionId: string
    status: string
  }> = []
  let runStatus = "queued"
  let id = 0

  const store: ExecutionStore = {
    async claimRun() {
      return {
        id: "run-1",
        created: true,
        automationVersionId: "version",
        status: "queued",
        output: null,
        error: null,
      }
    },
    async startRun() {
      runStatus = "running"
    },
    async completeRun() {
      runStatus = "succeeded"
    },
    async failRun() {
      runStatus = "failed"
    },
    async startNodeExecution(input) {
      const row = {
        id: `node-${++id}`,
        nodeKey: input.nodeKey,
        status: "running",
      }
      nodeRows.push(row)
      return { id: row.id }
    },
    async completeNodeExecution(input) {
      const row = nodeRows.find((candidate) => candidate.id === input.id)!
      row.status = "succeeded"
    },
    async failNodeExecution(nodeId) {
      const row = nodeRows.find((candidate) => candidate.id === nodeId)!
      row.status = "failed"
    },
    async skipNodeExecution(nodeId) {
      const row = nodeRows.find((candidate) => candidate.id === nodeId)!
      row.status = "skipped"
    },
    async startModelInvocation(input) {
      const row = {
        id: `model-${++id}`,
        nodeExecutionId: input.nodeExecutionId,
        status: "running",
      }
      modelRows.push(row)
      return { id: row.id }
    },
    async completeModelInvocation(input) {
      modelRows.find((candidate) => candidate.id === input.id)!.status =
        "succeeded"
    },
    async failModelInvocation(input) {
      modelRows.find((candidate) => candidate.id === input.id)!.status =
        "failed"
    },
    async claimActionExecution() {
      throw new Error("not used")
    },
    async completeActionExecution() {
      throw new Error("not used")
    },
    async failActionExecution() {
      throw new Error("not used")
    },
    async completeActionVerification() {
      throw new Error("not used")
    },
  }

  let modelCalls = 0
  const model: ModelInvoker = {
    async invoke() {
      modelCalls += 1
      if (modelCalls === 1) {
        throw new ModelProviderError("429", true)
      }
      return { output: { route: "done" } }
    },
  }

  const graph = automationGraphDefinitionSchema.parse({
    schemaVersion: 1,
    nodes: [
      { key: "input", kind: "trigger", config: {} },
      { key: "decide", kind: "decision", config: {} },
      { key: "terminal", kind: "terminal", config: {} },
    ],
    edges: [
      { key: "next", source: "input", target: "decide" },
      { key: "done", source: "decide", target: "terminal" },
    ],
  })

  const engine = new ExecutionEngine({
    store,
    modelInvoker: model,
    handlers: new Map([
      [
        "input",
        {
          async execute(context: NodeExecutionContext) {
            return { output: context.input }
          },
        },
      ],
      [
        "decide",
        {
          async execute(context: NodeExecutionContext) {
            const response = await context.invokeModel({
              provider: "fake",
              model: "fake",
              parameters: {},
              input: context.input,
            })
            return { output: response.output, selectedEdgeKey: "done" }
          },
        },
      ],
      [
        "terminal",
        {
          async execute() {
            return { output: { done: true } }
          },
        },
      ],
    ]),
  })

  const result = await engine.execute({
    automationId: "automation",
    automationVersionId: "version",
    mode: "test",
    graph,
    input: { input: true },
    connectionIdsByKey: {},
  })

  assert.equal(result.status, "succeeded")
  assert.equal(runStatus, "succeeded")
  assert.equal(nodeRows.filter((row) => row.nodeKey === "decide").length, 1)
  assert.deepEqual(
    modelRows.map((row) => row.status),
    ["failed", "succeeded"]
  )
})
