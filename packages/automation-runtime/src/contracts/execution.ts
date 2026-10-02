import type { ResourceRef } from "@workspace/domain/integrations"
import type {
  AutomationGraphDefinition,
  GraphNodeDefinition,
  JsonObject,
  JsonValue,
  RunMode,
} from "@workspace/domain/persistence"

export type ExecutionPolicy = {
  allowExternalActions: boolean
  maxModelRetries: number
  maxNodeRetries: number
  maxNodeExecutions: number
}

export const defaultExecutionPolicy: ExecutionPolicy = {
  allowExternalActions: false,
  maxModelRetries: 2,
  maxNodeRetries: 1,
  maxNodeExecutions: 100,
}

export type ExecuteAutomationInput = {
  automationId: string
  automationVersionId: string
  mode: RunMode
  graph: AutomationGraphDefinition
  input: JsonValue
  triggerSnapshot?: JsonValue
  triggerIntegrationKey?: string
  triggerConnectionKey?: string
  idempotencyKey?: string
  connectionIdsByKey: Record<string, string>
}

export type ExecutionResult = {
  runId: string
  automationVersionId: string
  admission: "created" | "duplicate"
} & (
  | { status: "succeeded"; output: JsonValue | null }
  | { status: "failed"; error: JsonObject | null }
  | { status: "queued" | "running" | "cancelled" }
)

export type NodeHandlerResult = {
  output?: JsonValue
  selectedEdgeKey?: string
}

export type ModelRequest = {
  connectionKey?: string
  provider: string
  model: string
  parameters: JsonObject
  input: JsonValue
}

export type ModelResponse = {
  output: JsonValue
  providerRequestId?: string
  usageDetails?: JsonObject
  costDetails?: JsonObject
  costUsd?: number
}

export type ActionResult = {
  response: JsonValue
  externalRef?: string
}

export type VerificationResult = {
  status: "verified" | "unverified" | "failed"
  evidence: JsonValue
}

export type PerformActionInput = {
  integrationKey: string
  connectionKey: string
  actionKey: string
  resource?: ResourceRef
  request: JsonValue
  perform: () => Promise<ActionResult>
}

export type PerformActionResult = ActionResult & {
  actionExecutionId: string
}

export type VerifyActionInput = {
  actionExecutionId: string
  verify: () => Promise<VerificationResult>
}

export type NodeExecutionContext = {
  readonly runId: string
  readonly nodeExecutionId: string
  readonly mode: RunMode
  readonly node: GraphNodeDefinition
  readonly graph: AutomationGraphDefinition
  readonly runInput: JsonValue
  readonly input: JsonValue
  outputOf(nodeKey: string): JsonValue | null
  invokeModel(request: ModelRequest): Promise<ModelResponse>
  performAction(input: PerformActionInput): Promise<PerformActionResult>
  verifyAction(input: VerifyActionInput): Promise<VerificationResult>
}

export type NodeHandler = {
  execute(context: NodeExecutionContext): Promise<NodeHandlerResult>
}

export type NodeHandlerRegistry = ReadonlyMap<string, NodeHandler>
