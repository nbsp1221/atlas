import assert from "node:assert/strict"
import test from "node:test"
import {
  ExecutionEngine,
  assertJson,
  defineCodeStep,
  resolveCodeSteps,
  type ExecutionStore,
  type StepSchema,
  type NodeHandler,
} from "../src/index"
import {
  automationGraphDefinitionSchema,
  type JsonValue,
} from "@workspace/domain/persistence"
const jsonSchema: StepSchema<JsonValue> = {
  safeParse(value) {
    return { success: true, data: value as JsonValue }
  },
}
function step(
  execute: (input: JsonValue) => JsonValue | Promise<JsonValue>,
  inputSchema = jsonSchema,
  outputSchema = jsonSchema
) {
  return defineCodeStep({
    id: "test",
    version: "1",
    inputSchema,
    outputSchema,
    inputJsonSchema: {},
    outputJsonSchema: {},
    validatorIdentity: "test",
    execute,
  })
}
async function run(handlers: NodeHandler[], input: JsonValue = "initial") {
  const rows: Array<{
    id: string
    input: JsonValue
    output?: JsonValue | null
    error?: JsonValue
    status: string
  }> = []
  const store = {
    async claimRun() {
      return {
        id: "run",
        created: true,
        automationVersionId: "v",
        status: "queued",
        output: null,
        error: null,
      }
    },
    async startRun() {},
    async completeRun() {},
    async failRun() {},
    async startNodeExecution(value: { input: JsonValue }) {
      const row = {
        id: String(rows.length),
        input: structuredClone(value.input),
        status: "running",
      }
      rows.push(row)
      return row
    },
    async completeNodeExecution(value: {
      id: string
      output: JsonValue | null
    }) {
      Object.assign(rows[Number(value.id)], {
        status: "succeeded",
        output: value.output,
      })
    },
    async failNodeExecution(id: string, error: JsonValue) {
      Object.assign(rows[Number(id)], { status: "failed", error })
    },
  } as unknown as ExecutionStore
  const graph = automationGraphDefinitionSchema.parse({
    schemaVersion: 1,
    entryNodeKey: "0",
    nodes: handlers.map((_, i) => ({ key: String(i), kind: "transform" })),
    edges: handlers.slice(1).map((_, i) => ({
      key: String(i),
      source: String(i),
      target: String(i + 1),
    })),
  })
  const engine = new ExecutionEngine({
    store,
    handlers: new Map(handlers.map((handler, i) => [String(i), handler])),
    modelInvoker: {
      async invoke() {
        throw new Error("forbidden")
      },
    },
  })
  const result = await engine.execute({
    automationId: "a",
    automationVersionId: "v",
    mode: "test",
    graph,
    input,
    connectionIdsByKey: {},
  })
  return { rows, result }
}
for (const value of [null, false, 0, "", []] as JsonValue[])
  test(`explicit output ${JSON.stringify(value)} reaches downstream and final output`, async () => {
    const { rows, result } = await run([
      step(() => value).handler,
      step((input) => input).handler,
    ])
    assert.equal(result.status, "succeeded")
    assert.deepEqual(rows[1].input, value)
    if (result.status === "succeeded") assert.deepEqual(result.output, value)
  })
test("omitted legacy output remains pass-through", async () => {
  const { rows } = await run([
    {
      async execute() {
        return {}
      },
    },
    step((input) => input).handler,
  ])
  assert.equal(rows[1].input, "initial")
})
const invalid = [
  undefined,
  () => 1,
  1n,
  NaN,
  Infinity,
  new Date(),
  { a: undefined },
  Object.assign([1], { extra: 2 }),
  Object.defineProperty([1], "hidden", { value: 2, enumerable: false }),
  Object.assign([1], { "01": 2 }),
  Object.assign([1], { "4294967295": 2 }),
  new (class extends Array<number> {})(1, 2),
  new Array(2),
  Object.defineProperty({}, "x", {
    get() {
      throw new Error("must not invoke getter")
    },
    enumerable: true,
  }),
  { [Symbol("x")]: 1 },
]
const cycle: Record<string, unknown> = {}
cycle.self = cycle
invalid.push(cycle)
for (const [index, value] of invalid.entries())
  test(`rejects non-JSON output ${index} and stops downstream`, async () => {
    assert.throws(() => assertJson(value))
    const { rows, result } = await run([
      step(() => value as JsonValue).handler,
      step(() => assert.fail("downstream")).handler,
    ])
    assert.equal(result.status, "failed")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, "failed")
    if (result.status === "failed") {
      assert.equal(result.error!.code, "invalid_step_output")
      assert.equal(result.error!.phase, "output")
      assert(Array.isArray(result.error!.issues))
    }
  })
const rejectingSchema: StepSchema<JsonValue> = {
  safeParse() {
    return {
      success: false,
      error: {
        issues: [
          { path: ["name"], code: "invalid_type", message: "Expected string" },
        ],
      },
    }
  },
}
for (const phase of ["input", "output"] as const)
  test(`${phase} validation failure is structured, non-retryable, and stops`, async () => {
    let called = 0
    const target = step(
      () => {
        called++
        return "bad"
      },
      phase === "input" ? rejectingSchema : jsonSchema,
      phase === "output" ? rejectingSchema : jsonSchema
    )
    const { result, rows } = await run([
      target.handler,
      step(() => assert.fail()).handler,
    ])
    assert.equal(called, phase === "input" ? 0 : 1)
    assert.equal(rows.length, 1)
    assert.equal(result.status, "failed")
    if (result.status === "failed")
      assert.deepEqual(result.error!.issues, [
        { path: "name", code: "invalid_type", message: "Expected string" },
      ])
  })
test("function exception records execute phase and prevents downstream", async () => {
  const { result, rows } = await run([
    step(() => {
      throw new Error("boom")
    }).handler,
    step(() => assert.fail()).handler,
  ])
  assert.equal(rows.length, 1)
  assert.equal(result.status, "failed")
  if (result.status === "failed") assert.equal(result.error!.phase, "execute")
})
test("parsed schema result is passed to callable and downstream", async () => {
  const parsed: StepSchema<JsonValue> = {
    safeParse() {
      return { success: true, data: "parsed" }
    },
  }
  const { rows } = await run([
    step(
      (input) => {
        assert.equal(input, "parsed")
        return "raw"
      },
      parsed,
      parsed
    ).handler,
    step((input) => input).handler,
  ])
  assert.equal(rows[1].input, "parsed")
})
test("exact identity fails closed for missing/version/source/hash changes and malformed graphs", () => {
  const registered = step((input) => input)
  const graph = automationGraphDefinitionSchema.parse({
    schemaVersion: 1,
    entryNodeKey: "a",
    nodes: [
      {
        key: "a",
        kind: "transform",
        config: { implementation: registered.metadata },
      },
    ],
    edges: [],
  })
  assert.equal(resolveCodeSteps(graph, [registered]).size, 1)
  for (const field of [
    "id",
    "version",
    "source",
    "sourceHash",
    "implementationHash",
    "inputSchema",
  ]) {
    const changed = structuredClone(graph)
    ;(changed.nodes[0].config.implementation as Record<string, JsonValue>)[
      field
    ] = "mismatch"
    assert.throws(() => resolveCodeSteps(changed, [registered]), /unavailable/)
  }
  assert.throws(() => resolveCodeSteps(graph, []), /unavailable/)
  assert.throws(
    () => resolveCodeSteps({ ...graph, entryNodeKey: undefined }, [registered]),
    /entry/
  )
  assert.throws(() =>
    resolveCodeSteps({ ...graph, entryNodeKey: "missing" }, [registered])
  )
})
