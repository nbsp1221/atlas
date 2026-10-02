import {
  ExecutionEngine,
  resolveCodeSteps,
  codeHash,
} from "@workspace/automation-runtime"
import {
  emailSummaryAutomation,
  emailSummaryFixture,
  emailSummarySteps,
} from "@workspace/automations"
import {
  createReadRepository,
  createExecutionRepository,
  type Database,
} from "@workspace/db"
import {
  automationGraphDefinitionSchema,
  type JsonValue,
} from "@workspace/domain/persistence"
import { sha256Json } from "../lib/stable-json"

// Explicit trusted registrations. No client-supplied paths, code, or loaders.
const registrations = new Map([
  [
    emailSummaryAutomation.key,
    {
      automation: emailSummaryAutomation,
      steps: emailSummarySteps,
      fixture: emailSummaryFixture,
    },
  ],
])
export async function inspectCodeAutomation(
  db: Database,
  key: string,
  version: number
) {
  const registered = registrations.get(key)
  if (!registered) throw new CodeAutomationError("unregistered_automation", 404)
  const bundle = await createReadRepository(db).findAutomationVersion(
    key,
    version
  )
  if (!bundle?.version) throw new CodeAutomationError("version_not_found", 404)
  try {
    const graph = automationGraphDefinitionSchema.parse(
      bundle.version.graphDefinition
    )
    if (sha256Json(graph) !== bundle.version.definitionHash)
      throw new Error("Stored graph hash mismatch")
    const handlers = resolveCodeSteps(graph, registered.steps)
    // This endpoint tests known automations, not arbitrary newly authored graphs.
    if (codeHash(graph) !== codeHash(registered.automation.definition))
      throw new Error("Stored graph does not match the registered automation")
    return { bundle, graph, handlers, registered }
  } catch (error) {
    throw new CodeAutomationError(
      "invalid_code_definition",
      409,
      error instanceof Error ? error.message : String(error)
    )
  }
}
export class CodeAutomationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409,
    message = code
  ) {
    super(message)
  }
}
export async function executeCodeAutomation(
  db: Database,
  key: string,
  version: number,
  input: JsonValue
) {
  const selected = await inspectCodeAutomation(db, key, version)
  // Reject invalid initial payload before creating any Run/effects.
  const entry = selected.graph.nodes.find(
    (node) => node.key === selected.graph.entryNodeKey
  )!
  const implementation = selected.registered.steps.find(
    (step) => codeHash(step.metadata) === codeHash(entry.config.implementation)
  )!
  const validatedInput = implementation.validateInput(input)
  const engine = new ExecutionEngine({
    store: createExecutionRepository(db),
    handlers: selected.handlers,
    modelInvoker: {
      async invoke() {
        throw new Error("Code automation cannot invoke models")
      },
    },
    policy: { allowExternalActions: false, maxNodeRetries: 0 },
  })
  return engine.execute({
    automationId: selected.bundle.automation.id,
    automationVersionId: selected.bundle.version!.id,
    mode: "test",
    graph: selected.graph,
    input: validatedInput,
    connectionIdsByKey: {},
    triggerSnapshot: {
      source: "manual_json_test",
      environment: "trusted_in_process",
      entryNodeKey: selected.graph.entryNodeKey!,
    },
  })
}
