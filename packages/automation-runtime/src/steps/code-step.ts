import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type {
  JsonObject,
  JsonValue,
  AutomationGraphDefinition,
} from "@workspace/domain/persistence"
import type { NodeHandler, NodeHandlerRegistry } from "../contracts/execution"
import { RuntimeError } from "../errors/runtime-errors"

export function codeHash(value: unknown): string {
  function stable(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stable)
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)])
      )
    return input
  }
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")
}

// Source identity is bounded to this adapter and self-contained registered
// callables. It is not a deployment/container or security-sandbox identity.
const adapterSourceHash = createHash("sha256")
  .update(readFileSync(new URL("./code-step.ts", import.meta.url), "utf8"))
  .digest("hex")

export type StepSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false
        error: {
          issues: readonly {
            path: readonly PropertyKey[]
            message: string
            code: string
          }[]
        }
      }
}
export type RegisteredCodeStep = {
  metadata: JsonObject
  handler: NodeHandler
  validateInput(value: unknown): JsonValue
}

export function assertJson(
  value: unknown,
  path = "$",
  seen = new Set<object>()
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || value === null || seen.has(value))
    throw new Error(`Non-JSON value at ${path}`)
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error(`Non-plain JSON object at ${path}`)
  seen.add(value)
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
    throw new Error(`Symbol key at ${path}`)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new Error(`Non-plain JSON array at ${path}`)
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index))
        throw new Error(`Sparse array at ${path}`)
      const property = Object.getOwnPropertyDescriptor(value, String(index))!
      if (!("value" in property) || !property.enumerable)
        throw new Error(`Non-JSON array property at ${path}`)
      assertJson(property.value, `${path}[${index}]`, seen)
    }
    if (
      Object.getOwnPropertyNames(value).some(
        (key) =>
          key !== "length" &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
      )
    )
      throw new Error(`Non-JSON array property at ${path}`)
  } else {
    for (const key of Object.getOwnPropertyNames(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)!
      if (!property.enumerable || !("value" in property))
        throw new Error(`Non-JSON property at ${path}.${key}`)
      assertJson(property.value, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

export function defineCodeStep<I, O>(options: {
  id: string
  version: string
  inputSchema: StepSchema<I>
  outputSchema: StepSchema<O>
  inputJsonSchema: JsonObject
  outputJsonSchema: JsonObject
  validatorIdentity: string
  // No captured values/imported helpers: callable must be self-contained.
  execute(input: I): O | Promise<O>
}): RegisteredCodeStep {
  const execute = options.execute
  const artifact = {
    id: options.id,
    version: options.version,
    source: execute.toString(),
    sourceLanguage: "javascript",
    sourceScope:
      "actual self-contained callable compiled from trusted TypeScript",
    adapterSourceHash,
    validatorIdentity: options.validatorIdentity,
    inputSchema: options.inputJsonSchema,
    outputSchema: options.outputJsonSchema,
  }
  const metadata: JsonObject = {
    ...artifact,
    sourceHash: createHash("sha256").update(artifact.source).digest("hex"),
    implementationHash: codeHash(artifact),
  }
  function validate<T>(
    schema: StepSchema<T>,
    value: unknown,
    phase: "input" | "output"
  ): T & JsonValue {
    try {
      assertJson(value)
    } catch (error) {
      throw new RuntimeError(
        `Invalid code step ${phase}`,
        `invalid_step_${phase}`,
        {
          phase,
          issues: [{ path: "$", code: "non_json", message: String(error) }],
        }
      )
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success)
      throw new RuntimeError(
        `Invalid code step ${phase}`,
        `invalid_step_${phase}`,
        {
          phase,
          ...(phase === "output" ? { attemptedOutput: value } : {}),
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            code: issue.code,
            message: issue.message,
          })),
        }
      )
    try {
      assertJson(parsed.data)
    } catch (error) {
      throw new RuntimeError(
        `Invalid parsed code step ${phase}`,
        `invalid_step_${phase}`,
        {
          phase,
          issues: [{ path: "$", code: "non_json", message: String(error) }],
        }
      )
    }
    return parsed.data as T & JsonValue
  }
  return {
    metadata,
    validateInput: (value) => validate(options.inputSchema, value, "input"),
    handler: {
      async execute(context) {
        const input = validate(options.inputSchema, context.input, "input")
        let output: unknown
        try {
          output = await execute(input)
        } catch (error) {
          throw new RuntimeError(
            error instanceof Error ? error.message : String(error),
            "code_step_failure",
            { phase: "execute" }
          )
        }
        return { output: validate(options.outputSchema, output, "output") }
      },
    },
  }
}

// Strict linear whole-value execution for this small registered-code contract.
// No per-item scheduler, external bindings, branching, or arbitrary imports.
export function resolveCodeSteps(
  graph: AutomationGraphDefinition,
  registered: readonly RegisteredCodeStep[]
): NodeHandlerRegistry {
  if (
    !graph.entryNodeKey ||
    graph.nodes.length === 0 ||
    graph.edges.length !== graph.nodes.length - 1
  )
    throw new Error("Code graph requires explicit entry and a linear chain")
  const handlers = new Map<string, NodeHandler>()
  const visited = new Set<string>()
  let key: string | undefined = graph.entryNodeKey
  while (key) {
    if (visited.has(key)) throw new Error("Code graph contains a cycle")
    visited.add(key)
    const node = graph.nodes.find((candidate) => candidate.key === key)
    if (
      !node ||
      node.kind !== "transform" ||
      Object.keys(node.config).join() !== "implementation"
    )
      throw new Error(
        "Code graph requires transform nodes with only an implementation binding"
      )
    const step = registered.find(
      (candidate) =>
        codeHash(candidate.metadata) === codeHash(node.config.implementation)
    )
    if (!step)
      throw new Error(`Exact code implementation unavailable for ${key}`)
    handlers.set(key, step.handler)
    const outgoing = graph.edges.filter((edge) => edge.source === key)
    if (outgoing.length > 1) throw new Error("Code graph cannot branch")
    key = outgoing[0]?.target
  }
  if (visited.size !== graph.nodes.length)
    throw new Error("Code graph contains unreachable nodes")
  return handlers
}
