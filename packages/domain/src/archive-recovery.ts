import type { JsonObject } from "./persistence"

export type ArchiveOperation = "modify" | "get"
export type ArchiveRecoveryState = "pending" | "observed" | "stopped"
export type ArchiveRecoveryPolicy = {
  maxWrites: number
  maxReads: number
  deadlineMs: number
  baseDelayMs: number
  maxDelayMs: number
}
export type ArchiveRecoveryRecord = {
  actionExecutionId: string
  messageId: string
  initialRevision: string
  state: ArchiveRecoveryState
  nextOperation: ArchiveOperation
  nextAttemptAt: Date | null
  writeNotBeforeAt: Date | null
  deadlineAt: Date
  policy: ArchiveRecoveryPolicy
  writeAttempts: number
  readAttempts: number
  inFlightOperation: ArchiveOperation | null
  inFlightAttempt: number | null
  writeRetryAllowed: boolean
  lastWriteOutcome: "acknowledged" | "failed" | "unknown" | null
  lastOutcome: JsonObject | null
  createdAt: Date
  updatedAt: Date
}
export type ArchiveAttemptEvent = {
  id: string
  actionExecutionId: string
  sequence: number
  operation: ArchiveOperation | "stop"
  phase: "started" | "result" | "interrupted"
  attempt: number
  evidence: JsonObject
  createdAt: Date
}
