import type {
  ActionExecutionStatus,
  JsonObject,
  JsonValue,
  RunMode,
  RunStatus,
  NodeKind,
  VerificationStatus,
} from "@workspace/domain/persistence"
import type { ModelRequest, ModelResponse } from "../contracts/execution"

export type StoredActionClaim = {
  id: string
  created: boolean
  executionStatus: ActionExecutionStatus
  response: JsonValue | null
  externalRef: string | null
}

export type StoredRunClaim = {
  id: string
  created: boolean
  automationVersionId: string
  status: RunStatus
  output: JsonValue | null
  error: JsonObject | null
}

export interface ExecutionStore {
  // Only the inserter may execute. A duplicate is observation, never a retry.
  claimRun(input: {
    automationId: string
    automationVersionId: string
    mode: RunMode
    input: JsonValue
    triggerSnapshot?: JsonValue
    triggerIntegrationKey?: string
    triggerConnectionId?: string
    idempotencyKey?: string
    createdAt: Date
  }): Promise<StoredRunClaim>

  startRun(runId: string, startedAt: Date): Promise<void>
  completeRun(
    runId: string,
    output: JsonValue | null,
    finishedAt: Date
  ): Promise<void>
  failRun(runId: string, error: JsonObject, finishedAt: Date): Promise<void>

  startNodeExecution(input: {
    runId: string
    sequence: number
    nodeKey: string
    nodeKind: NodeKind
    input: JsonValue
    startedAt: Date
    retryOfNodeExecutionId?: string
  }): Promise<{ id: string }>

  completeNodeExecution(input: {
    id: string
    output: JsonValue | null
    selectedEdgeKey?: string
    finishedAt: Date
  }): Promise<void>

  failNodeExecution(
    id: string,
    error: JsonObject,
    finishedAt: Date
  ): Promise<void>
  skipNodeExecution(
    id: string,
    output: JsonValue,
    finishedAt: Date
  ): Promise<void>

  startModelInvocation(input: {
    connectionId?: string
    nodeExecutionId: string
    sequence: number
    request: ModelRequest
    startedAt: Date
  }): Promise<{ id: string }>

  completeModelInvocation(input: {
    id: string
    response: ModelResponse
    durationMs: number
    finishedAt: Date
  }): Promise<void>

  failModelInvocation(input: {
    id: string
    error: JsonObject
    durationMs: number
    providerRequestId?: string
    finishedAt: Date
  }): Promise<void>

  claimActionExecution(input: {
    nodeExecutionId: string
    sequence: number
    connectionId: string
    integrationKey: string
    actionKey: string
    idempotencyKey: string
    request: JsonValue
    startedAt: Date
  }): Promise<StoredActionClaim>

  completeActionExecution(input: {
    id: string
    response: JsonValue
    externalRef?: string
    finishedAt: Date
  }): Promise<void>

  failActionExecution(input: {
    id: string
    status: "failed" | "unknown"
    error: JsonObject
    finishedAt: Date
  }): Promise<void>

  completeActionVerification(input: {
    id: string
    status: Exclude<VerificationStatus, "pending">
    evidence: JsonValue
    verifiedByNodeExecutionId: string
    verifiedAt: Date
  }): Promise<void>
}
