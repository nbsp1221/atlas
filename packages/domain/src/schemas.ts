import { z } from "zod"
import {
  actionExecutionStatusValues,
  feedbackVerdictValues,
  jsonValueSchema,
  jsonObjectSchema,
  modelInvocationStatusValues,
  nodeExecutionStatusValues,
  nodeKindValues,
  runModeValues,
  runStatusValues,
  verificationStatusValues,
} from "./persistence"

export const runVerificationSchema = z.enum([
  "verified",
  "unverified",
  "completed",
  "failed",
  "pending",
])

export const runListItemSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  automationName: z.string(),
  occurredAt: z.string(),
  sender: z.string(),
  subject: z.string(),
  route: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  verification: runVerificationSchema,
  mode: z.enum(runModeValues),
})

const nullableJsonValueSchema = jsonValueSchema.nullable()

export const runNodeExecutionSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  nodeKey: z.string(),
  nodeKind: z.enum(nodeKindValues),
  status: z.enum(nodeExecutionStatusValues),
  retryOfNodeExecutionId: z.string().nullable(),
  selectedEdgeKey: z.string().nullable(),
  input: jsonValueSchema,
  output: nullableJsonValueSchema,
  error: nullableJsonValueSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  implementation: nullableJsonValueSchema,
})

export const runModelInvocationSchema = z.object({
  connectionId: z.string().nullable().optional(),
  id: z.string(),
  nodeExecutionId: z.string(),
  sequence: z.number().int().positive(),
  status: z.enum(modelInvocationStatusValues),
  modelProvider: z.string(),
  model: z.string(),
  modelParameters: jsonValueSchema,
  providerRequestId: z.string().nullable(),
  input: jsonValueSchema,
  output: nullableJsonValueSchema,
  error: nullableJsonValueSchema,
  usageDetails: nullableJsonValueSchema,
  costDetails: nullableJsonValueSchema,
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
})

export const runArchiveRecoverySchema = z.object({
  actionExecutionId: z.string(),
  messageId: z.string(),
  initialRevision: z.string(),
  state: z.enum(["pending", "observed", "stopped"]),
  nextOperation: z.enum(["modify", "get"]),
  nextAttemptAt: z.string().nullable(),
  writeNotBeforeAt: z.string().nullable(),
  deadlineAt: z.string(),
  policy: z.object({
    maxWrites: z.number().int().nonnegative(),
    maxReads: z.number().int().nonnegative(),
    deadlineMs: z.number().int().positive(),
    baseDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
  }),
  writeAttempts: z.number().int().nonnegative(),
  readAttempts: z.number().int().nonnegative(),
  inFlightOperation: z.enum(["modify", "get"]).nullable(),
  inFlightAttempt: z.number().int().positive().nullable(),
  writeRetryAllowed: z.boolean(),
  lastWriteOutcome: z.enum(["acknowledged", "failed", "unknown"]).nullable(),
  lastOutcome: jsonObjectSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const runArchiveAttemptSchema = z.object({
  id: z.string(),
  actionExecutionId: z.string(),
  sequence: z.number().int().positive(),
  operation: z.enum(["modify", "get", "stop"]),
  phase: z.enum(["started", "result", "interrupted"]),
  attempt: z.number().int().nonnegative(),
  evidence: jsonObjectSchema,
  createdAt: z.string(),
})

export const runActionExecutionSchema = z.object({
  id: z.string(),
  nodeExecutionId: z.string(),
  sequence: z.number().int().positive(),
  connectionId: z.string(),
  integrationKey: z.string(),
  actionKey: z.string(),
  executionStatus: z.enum(actionExecutionStatusValues),
  verificationStatus: z.enum(verificationStatusValues),
  verifiedByNodeExecutionId: z.string().nullable(),
  externalRef: z.string().nullable(),
  request: jsonValueSchema,
  response: nullableJsonValueSchema,
  verificationEvidence: nullableJsonValueSchema,
  error: nullableJsonValueSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  archiveRecovery: runArchiveRecoverySchema.nullable().optional(),
  archiveAttempts: z.array(runArchiveAttemptSchema).optional(),
})

export const runFeedbackSchema = z.object({
  id: z.string(),
  nodeExecutionId: z.string(),
  verdict: z.enum(feedbackVerdictValues),
  expectedOutput: nullableJsonValueSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const runDetailSchema = runListItemSchema.extend({
  mode: z.enum(runModeValues),
  status: z.enum(runStatusValues),
  automationVersion: z.number().int().positive(),
  senderEmail: z.string(),
  body: z.string(),
  prompt: z.string(),
  reasonSummary: z.string(),
  usageDetails: z.record(z.string(), z.number()),
  costUsd: z.number(),
  action: z.string(),
  execution: z.enum(["running", "succeeded", "failed", "unknown", "none"]),
  evidence: z.string(),
  input: jsonValueSchema,
  output: nullableJsonValueSchema,
  error: nullableJsonValueSchema,
  definitionHash: z.string(),
  nodeExecutions: z.array(runNodeExecutionSchema),
  modelInvocations: z.array(runModelInvocationSchema),
  actionExecutions: z.array(runActionExecutionSchema),
  feedback: z.array(runFeedbackSchema),
})

export const runSchema = runDetailSchema

export const automationNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(nodeKindValues),
  label: z.string(),
  key: z.string(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  executions: z.number(),
  medianLatencyMs: z.number().optional(),
  costUsd: z.number().optional(),
  health: z.enum(["healthy", "attention", "neutral"]),
  implementation: jsonValueSchema.optional(),
  detail: z.string().optional(),
})

export const automationGraphSchema = z.object({
  automationId: z.string(),
  version: z.number(),
  nodes: z.array(automationNodeSchema),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      label: z.string().optional(),
    })
  ),
})

export const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number(),
  versionCreatedAt: z.string(),
  definitionHash: z.string(),
  model: z.string(),
  verifiedRate: z.number().nullable(),
  cost24hUsd: z.number(),
  runs24h: z.number(),
  status: z.enum(["active", "paused", "archived"]),
  graph: automationGraphSchema,
})

export const connectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  providerKey: z.string(),
  principalType: z.string().nullable(),
  principalId: z.string().nullable(),
  status: z.enum(["connected", "error", "disabled", "archived"]),
  lastCheckedAt: z.string().nullable(),
})

export const overviewSchema = z.object({
  runs24h: z.number(),
  failed24h: z.number(),
  verifiedOutcomes: z.number(),
  totalOutcomes: z.number(),
  cost24hUsd: z.number(),
  attentionCount: z.number(),
  costTrend: z.array(z.object({ bucket: z.string(), cost: z.number() })),
})
