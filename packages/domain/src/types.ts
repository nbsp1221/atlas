import type {
  ArchiveRecoveryRecord,
  ArchiveAttemptEvent,
} from "./archive-recovery"
import type {
  ActionExecutionStatus,
  FeedbackVerdict,
  JsonValue,
  ModelInvocationStatus,
  NodeExecutionStatus,
  NodeKind,
  RunMode,
  RunStatus,
  VerificationStatus,
} from "./persistence"

export type AutomationNode = {
  id: string
  kind: NodeKind
  label: string
  key: string
  model?: string
  prompt?: string
  executions: number
  medianLatencyMs?: number
  costUsd?: number
  health: "healthy" | "attention" | "neutral"
  implementation?: JsonValue
  detail?: string
}

export type AutomationEdge = {
  id: string
  source: string
  target: string
  label?: string
}

export type AutomationGraph = {
  automationId: string
  version: number
  nodes: AutomationNode[]
  edges: AutomationEdge[]
}

export type Automation = {
  id: string
  name: string
  description: string
  version: number
  versionCreatedAt: string
  definitionHash: string
  model: string
  verifiedRate: number | null
  cost24hUsd: number
  runs24h: number
  status: "active" | "paused" | "archived"
  graph: AutomationGraph
}

export type RunVerification =
  "verified" | "unverified" | "completed" | "failed" | "pending"

export type RunListItem = {
  id: string
  automationId: string
  automationName: string
  occurredAt: string
  sender: string
  subject: string
  route: string
  model: string
  latencyMs: number
  verification: RunVerification
  mode: RunMode
}

export type RunNodeExecution = {
  id: string
  sequence: number
  nodeKey: string
  nodeKind: NodeKind
  status: NodeExecutionStatus
  retryOfNodeExecutionId: string | null
  selectedEdgeKey: string | null
  input: JsonValue
  output: JsonValue | null
  error: JsonValue | null
  startedAt: string
  finishedAt: string | null
  implementation: JsonValue | null
}

export type RunModelInvocation = {
  connectionId?: string | null
  id: string
  nodeExecutionId: string
  sequence: number
  status: ModelInvocationStatus
  modelProvider: string
  model: string
  modelParameters: JsonValue
  providerRequestId: string | null
  input: JsonValue
  output: JsonValue | null
  error: JsonValue | null
  usageDetails: JsonValue | null
  costDetails: JsonValue | null
  costUsd: number | null
  durationMs: number | null
  startedAt: string
  finishedAt: string | null
}

// Read models serialize dates while preserving the underlying recovery and
// immutable attempt identities. Older action fixtures may omit these fields.
export type RunArchiveRecovery = Omit<
  ArchiveRecoveryRecord,
  | "nextAttemptAt"
  | "writeNotBeforeAt"
  | "deadlineAt"
  | "createdAt"
  | "updatedAt"
> & {
  nextAttemptAt: string | null
  writeNotBeforeAt: string | null
  deadlineAt: string
  createdAt: string
  updatedAt: string
}

export type RunArchiveAttempt = Omit<ArchiveAttemptEvent, "createdAt"> & {
  createdAt: string
}

export type RunActionExecution = {
  id: string
  nodeExecutionId: string
  sequence: number
  connectionId: string
  integrationKey: string
  actionKey: string
  executionStatus: ActionExecutionStatus
  verificationStatus: VerificationStatus
  verifiedByNodeExecutionId: string | null
  externalRef: string | null
  request: JsonValue
  response: JsonValue | null
  verificationEvidence: JsonValue | null
  error: JsonValue | null
  startedAt: string
  finishedAt: string | null
  verifiedAt: string | null
  archiveRecovery?: RunArchiveRecovery | null
  archiveAttempts?: RunArchiveAttempt[]
}

export type RunFeedback = {
  id: string
  nodeExecutionId: string
  verdict: FeedbackVerdict
  expectedOutput: JsonValue | null
  note: string | null
  createdAt: string
  updatedAt: string
}

export type RunDetail = RunListItem & {
  mode: RunMode
  status: RunStatus
  automationVersion: number
  senderEmail: string
  body: string
  prompt: string
  reasonSummary: string
  usageDetails: Record<string, number>
  costUsd: number
  action: string
  execution: "running" | "succeeded" | "failed" | "unknown" | "none"
  evidence: string
  input: JsonValue
  output: JsonValue | null
  error: JsonValue | null
  definitionHash: string
  nodeExecutions: RunNodeExecution[]
  modelInvocations: RunModelInvocation[]
  actionExecutions: RunActionExecution[]
  feedback: RunFeedback[]
}

// Backward-compatible alias while callers migrate to list/detail terminology.
export type Run = RunDetail

export type Connection = {
  id: string
  label: string
  providerKey: string
  principalType: string | null
  principalId: string | null
  status: "connected" | "error" | "disabled" | "archived"
  lastCheckedAt: string | null
}

export type Overview = {
  runs24h: number
  failed24h: number
  verifiedOutcomes: number
  totalOutcomes: number
  cost24hUsd: number
  attentionCount: number
  costTrend: Array<{ bucket: string; cost: number }>
}
