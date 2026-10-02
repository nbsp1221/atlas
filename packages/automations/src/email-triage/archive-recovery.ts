import { emailTriageBindings, assertBindingValues } from "./bindings"
import type {
  ArchiveRecoveryPolicy,
  ArchiveRecoveryRecord,
  JsonObject,
  AutomationGraphDefinition,
} from "@workspace/domain/persistence"

// Engineering defaults for the fake-world proof, not a mail-retention policy.
export const defaultArchiveRecoveryPolicy: ArchiveRecoveryPolicy = {
  maxWrites: 3,
  maxReads: 6,
  deadlineMs: 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
}
export function validateArchiveRecoveryPolicy(policy: ArchiveRecoveryPolicy) {
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid archive recovery policy")
  if (
    policy.maxWrites > 10 ||
    policy.maxReads > 20 ||
    policy.deadlineMs > 300_000 ||
    policy.baseDelayMs > policy.maxDelayMs
  )
    throw new Error("Archive recovery policy exceeds bounded limits")
  return policy
}
export function assertRecoverableArchiveBranch(
  graph: AutomationGraphDefinition
) {
  const archive = graph.nodes.find((n) => n.key === "archive_email")
  const verify = graph.nodes.find((n) => n.key === "verify_archive")
  if (archive)
    assertBindingValues(
      archive.config,
      emailTriageBindings.archiveEmail,
      "recovery archive binding"
    )
  if (verify)
    assertBindingValues(
      verify.config,
      emailTriageBindings.verifyArchive,
      "recovery verify binding"
    )
  const edges = graph.edges.filter((e) => e.source === "archive_email")
  if (
    archive?.kind !== "action" ||
    archive.config.connectionKey !== verify?.config.connectionKey ||
    archive.config.integrationKey !== "gmail" ||
    archive.config.actionKey !== "archive-message" ||
    verify?.kind !== "verify" ||
    verify.config.verificationKey !== "message-archived" ||
    edges.length !== 1 ||
    edges[0].key !== "archive_verify" ||
    edges[0].target !== "verify_archive" ||
    graph.edges.some((e) => e.source === "verify_archive")
  )
    throw new Error(
      "Stored version has no supported terminal archive continuation"
    )
}
export class ArchiveProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly reason: string,
    readonly effect: "none" | "unknown" = "unknown",
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}
export function archiveFailure(error: unknown): JsonObject {
  if (error instanceof ArchiveProviderError) {
    const retryable =
      error.status === 429 ||
      [500, 502, 503, 504].includes(error.status ?? 0) ||
      (error.status === 403 &&
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(
          error.reason
        )) ||
      error.status === null
    return {
      code: error.reason,
      message: error.message,
      status: error.status,
      effect: error.effect,
      retryable,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: Math.max(0, error.retryAfterMs) }),
    }
  }
  return {
    code: "adapter_failure",
    message: error instanceof Error ? error.message : String(error),
    effect: "unknown",
    retryable: false,
  }
}
export type ArchiveMessageObservation = {
  messageId: string
  inInbox: boolean
  revision: string
}
export interface ArchiveRecoveryMailPort {
  modify(messageId: string): Promise<JsonObject>
  get(messageId: string): Promise<ArchiveMessageObservation>
}
export function archiveRetryAt(
  record: ArchiveRecoveryRecord,
  now: Date,
  random: () => number,
  retryAfterMs = 0
) {
  const failures = Math.max(0, record.writeAttempts + record.readAttempts - 1)
  const base = Math.min(
    record.policy.maxDelayMs,
    record.policy.baseDelayMs * 2 ** Math.min(failures, 20)
  )
  const jitter = Math.floor(base * 0.25 * Math.max(0, Math.min(1, random())))
  return new Date(now.getTime() + Math.max(base + jitter, retryAfterMs))
}
export type ArchiveDecision =
  | {
      kind: "schedule"
      operation: "modify" | "get"
      at: Date
      evidence: JsonObject
    }
  | { kind: "finish"; state: "observed" | "stopped"; evidence: JsonObject }
export function decideArchiveRead(
  record: ArchiveRecoveryRecord,
  observed: ArchiveMessageObservation,
  now: Date
): ArchiveDecision {
  if (
    observed.messageId !== record.messageId ||
    typeof observed.inInbox !== "boolean" ||
    typeof observed.revision !== "string" ||
    !observed.revision
  )
    return {
      kind: "finish",
      state: "stopped",
      evidence: { code: "invalid_message_observation" },
    }
  if (!observed.inInbox)
    return {
      kind: "finish",
      state: "observed",
      evidence: {
        code: "desired_state_observed",
        ...observed,
        causality: "not_established",
      },
    }
  if (observed.revision !== record.initialRevision)
    return {
      kind: "finish",
      state: "stopped",
      evidence: { code: "intent_superseded", ...observed },
    }
  if (record.writeRetryAllowed === false)
    return {
      kind: "finish",
      state: "stopped",
      evidence: { code: "write_retry_forbidden", ...observed },
    }
  if (record.lastWriteOutcome === "acknowledged")
    return {
      kind: "finish",
      state: "stopped",
      evidence: { code: "verification_mismatch", ...observed },
    }
  if (now >= record.deadlineAt)
    return {
      kind: "finish",
      state: "stopped",
      evidence: { code: "intent_deadline_exceeded", ...observed },
    }
  if (record.writeAttempts >= record.policy.maxWrites)
    return {
      kind: "finish",
      state: "stopped",
      evidence: { code: "write_budget_exhausted", ...observed },
    }
  return {
    kind: "schedule",
    operation: "modify",
    at: now,
    evidence: { code: "unchanged_intent_observed", ...observed },
  }
}

export interface ArchiveRecoveryStore {
  isIntentCurrent(): Promise<boolean>
  read(): Promise<ArchiveRecoveryRecord>
  interrupted(now: Date): Promise<void>
  reconcileBeforeRetry(now: Date): Promise<void>
  start(operation: "modify" | "get", now: Date): Promise<ArchiveRecoveryRecord>
  result(input: {
    operation: "modify" | "get"
    evidence: JsonObject
    nextOperation: "modify" | "get"
    nextAttemptAt: Date
    writeOutcome?: "acknowledged" | "failed" | "unknown"
    writeRetryAllowed?: boolean
    writeNotBeforeAt?: Date
    terminal?: { state: "observed" | "stopped"; evidence: JsonObject }
    now: Date
  }): Promise<void>
  finish(
    state: "observed" | "stopped",
    evidence: JsonObject,
    now: Date
  ): Promise<void>
}
// Caller owns one DB session lock. This is an archive-only continuation, not a
// graph replay. Each dispatch is committed before provider I/O.
export async function processArchiveRecovery(input: {
  store: ArchiveRecoveryStore
  mail: ArchiveRecoveryMailPort
  now: () => Date
  random: () => number
  beforeDispatch?: (operation: "modify" | "get") => Promise<void>
  afterDispatch?: (operation: "modify" | "get") => Promise<void>
  afterResult?: (operation: "modify" | "get") => Promise<void>
}) {
  let record = await input.store.read()
  if (record.state !== "pending") return
  const terminal = record.lastOutcome?.terminalDecision
  if (
    terminal &&
    typeof terminal === "object" &&
    !Array.isArray(terminal) &&
    (terminal.state === "observed" || terminal.state === "stopped") &&
    terminal.evidence &&
    typeof terminal.evidence === "object" &&
    !Array.isArray(terminal.evidence)
  ) {
    const current = await input.store.isIntentCurrent()
    await input.store.finish(
      current ? terminal.state : "stopped",
      current ? terminal.evidence : { code: "intent_superseded" },
      input.now()
    )
    return
  }
  if (record.inFlightOperation) await input.store.interrupted(input.now())
  let validatingDueRetry = false
  let retryValidated = false
  for (let step = 0; step < 5; step++) {
    record = await input.store.read()
    const now = input.now()
    if (record.state !== "pending" || !record.nextAttemptAt) return
    if (now >= record.deadlineAt) {
      await input.store.finish(
        "stopped",
        { code: "intent_deadline_exceeded", outcome: record.lastWriteOutcome },
        now
      )
      return
    }
    if (record.nextAttemptAt > now) return
    if (!(await input.store.isIntentCurrent())) {
      await input.store.finish("stopped", { code: "intent_superseded" }, now)
      return
    }
    const operation = record.nextOperation
    if (
      (operation === "modify" &&
        record.writeAttempts >= record.policy.maxWrites) ||
      (operation === "get" && record.readAttempts >= record.policy.maxReads)
    ) {
      await input.store.finish(
        "stopped",
        {
          code:
            operation === "modify"
              ? "write_budget_exhausted"
              : "read_budget_exhausted",
          outcome: record.lastWriteOutcome,
        },
        now
      )
      return
    }
    if (operation === "modify" && record.writeAttempts > 0 && !retryValidated) {
      // Never reuse an observation across a backoff wait/restart. Read the
      // exact target again under this ownership before spending a retry.
      await input.store.reconcileBeforeRetry(now)
      validatingDueRetry = true
      continue
    }
    record = await input.store.start(operation, now)
    await input.beforeDispatch?.(operation)
    if (
      !(await input.store.isIntentCurrent()) ||
      input.now() >= record.deadlineAt
    ) {
      await input.store.finish(
        "stopped",
        { code: "intent_superseded_before_dispatch" },
        input.now()
      )
      return
    }
    // Test hooks sit outside catch: an intentional process interruption must
    // leave dispatch evidence in flight, not masquerade as provider failure.
    let response: JsonObject | ArchiveMessageObservation
    try {
      response =
        operation === "modify"
          ? await input.mail.modify(record.messageId)
          : await input.mail.get(record.messageId)
    } catch (error) {
      const evidence = archiveFailure(error)
      const endedAt = input.now()
      const unknownWrite = operation === "modify" && evidence.effect !== "none"
      const retry = evidence.retryable === true
      const at = archiveRetryAt(
        record,
        endedAt,
        input.random,
        Number(evidence.retryAfterMs ?? 0)
      )
      const terminal =
        !retry && !unknownWrite
          ? {
              state: "stopped" as const,
              evidence: {
                ...evidence,
                code:
                  operation === "get"
                    ? "read_failed_permanently"
                    : "permanent_failure",
              },
            }
          : undefined
      await input.store.result({
        operation,
        evidence,
        terminal,
        nextOperation: "get",
        nextAttemptAt: unknownWrite || terminal ? endedAt : at,
        ...(operation === "modify"
          ? {
              writeRetryAllowed: retry,
              writeNotBeforeAt: at,
              writeOutcome: unknownWrite
                ? ("unknown" as const)
                : ("failed" as const),
            }
          : {}),
        now: endedAt,
      })
      await input.afterResult?.(operation)
      if (terminal) {
        await input.store.finish(terminal.state, terminal.evidence, endedAt)
        return
      }
      // Unknown modify gets immediate readback, even when the error cannot be
      // classified as transient. GET failures never permit a blind write.
      if (unknownWrite) continue
      return
    }
    await input.afterDispatch?.(operation)
    const endedAt = input.now()
    if (operation === "modify") {
      await input.store.result({
        operation,
        evidence: { code: "write_acknowledged", response },
        nextOperation: "get",
        nextAttemptAt: endedAt,
        writeOutcome: "acknowledged",
        now: endedAt,
      })
      await input.afterResult?.(operation)
      continue
    }
    let decision = decideArchiveRead(
      record,
      response as ArchiveMessageObservation,
      endedAt
    )
    if (!(await input.store.isIntentCurrent()))
      decision = {
        kind: "finish",
        state: "stopped",
        evidence: { code: "intent_superseded" },
      }
    if (decision.kind === "schedule") {
      retryValidated = true
      if (!validatingDueRetry)
        decision.at = archiveRetryAt(
          record,
          endedAt,
          input.random,
          Number(record.lastOutcome?.retryAfterMs ?? 0)
        )
      decision.at = new Date(
        Math.max(decision.at.getTime(), record.writeNotBeforeAt?.getTime() ?? 0)
      )
    }
    await input.store.result({
      operation,
      evidence: decision.evidence,
      terminal:
        decision.kind === "finish"
          ? { state: decision.state, evidence: decision.evidence }
          : undefined,
      nextOperation: decision.kind === "schedule" ? decision.operation : "get",
      nextAttemptAt: decision.kind === "schedule" ? decision.at : endedAt,
      now: endedAt,
    })
    await input.afterResult?.(operation)
    if (decision.kind === "finish") {
      await input.store.finish(decision.state, decision.evidence, endedAt)
      return
    }
  }
}
