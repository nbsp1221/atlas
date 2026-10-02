import { and, eq, lte, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import type {
  ArchiveRecoveryPolicy,
  ArchiveRecoveryRecord,
  ArchiveOperation,
  JsonObject,
} from "@workspace/domain/persistence"
import type { Database } from "./read-repository"
import {
  actionExecutions,
  archiveRecoveries,
  archiveAttemptEvents,
  automationVersions,
  connections,
  nodeExecutions,
  runs,
} from "../schema"

type EventInput = {
  operation: ArchiveOperation | "stop"
  phase: "started" | "result" | "interrupted"
  attempt: number
  evidence: JsonObject
  createdAt: Date
}

export function createArchiveRecoveryRepository(db: Database) {
  return {
    async enqueue(input: {
      runId: string
      nodeExecutionId: string
      connectionId: string
      messageId: string
      initialRevision: string
      policy: ArchiveRecoveryPolicy
      now: Date
    }) {
      return db.transaction(async (tx) => {
        const [node] = await tx
          .select()
          .from(nodeExecutions)
          .innerJoin(runs, eq(runs.id, nodeExecutions.runId))
          .where(
            and(
              eq(nodeExecutions.id, input.nodeExecutionId),
              eq(nodeExecutions.runId, input.runId)
            )
          )
        if (
          !node ||
          node.runs.mode !== "test" ||
          node.runs.status !== "running" ||
          node.node_executions.nodeKey !== "archive_email" ||
          node.node_executions.status !== "running"
        )
          throw new Error(
            "Archive recovery requires the admitted running test branch"
          )
        const [action] = await tx
          .insert(actionExecutions)
          .values({
            nodeExecutionId: input.nodeExecutionId,
            sequence: 1,
            connectionId: input.connectionId,
            integrationKey: "gmail",
            actionKey: "archive-message",
            idempotencyKey: `${input.runId}:archive_email:1`,
            executionStatus: "running",
            verificationStatus: "pending",
            requestSnapshot: { messageId: input.messageId },
            startedAt: input.now,
          })
          .returning()
        await tx.insert(archiveRecoveries).values({
          actionExecutionId: action.id,
          messageId: input.messageId,
          initialRevision: input.initialRevision,
          state: "pending",
          nextOperation: "modify",
          nextAttemptAt: input.now,
          deadlineAt: new Date(input.now.getTime() + input.policy.deadlineMs),
          policy: input.policy,
          createdAt: input.now,
          updatedAt: input.now,
        })
        return action.id
      })
    },
    async due(now: Date, runId?: string) {
      return db
        .select({ actionExecutionId: archiveRecoveries.actionExecutionId })
        .from(archiveRecoveries)
        .innerJoin(
          actionExecutions,
          eq(actionExecutions.id, archiveRecoveries.actionExecutionId)
        )
        .innerJoin(
          nodeExecutions,
          eq(nodeExecutions.id, actionExecutions.nodeExecutionId)
        )
        .where(
          and(
            eq(archiveRecoveries.state, "pending"),
            lte(archiveRecoveries.nextAttemptAt, now),
            runId ? eq(nodeExecutions.runId, runId) : undefined
          )
        )
        .orderBy(archiveRecoveries.nextAttemptAt)
        .limit(50)
    },
    async withOwnership<T>(
      actionId: string,
      work: (
        store: ReturnType<typeof lockedStore>,
        context: {
          runId: string
          graph: (typeof automationVersions.$inferSelect)["graphDefinition"]
          connectionCompatible: boolean
        }
      ) => Promise<T>
    ): Promise<T | null> {
      const session = db.createSessionClient()
      let locked = false
      let backendId: number | undefined
      const assertOwner = async () => {
        const [current] = await session`select pg_backend_pid() as pid`
        if (current.pid !== backendId)
          throw new Error(
            "Archive ownership session changed; refusing stale work"
          )
      }
      try {
        const [row] =
          await session`select pg_try_advisory_lock(hashtextextended(${actionId}, 734031)) as acquired, pg_backend_pid() as pid`
        locked = row.acquired === true
        backendId = row.pid
        if (!locked) return null
        const owned = Object.assign(drizzle(session), {
          createSessionClient: db.createSessionClient,
        })
        const [context] = await owned
          .select({
            runId: runs.id,
            mode: runs.mode,
            graph: automationVersions.graphDefinition,
            connectionProvider: connections.providerKey,
          })
          .from(actionExecutions)
          .innerJoin(
            nodeExecutions,
            eq(nodeExecutions.id, actionExecutions.nodeExecutionId)
          )
          .innerJoin(runs, eq(runs.id, nodeExecutions.runId))
          .innerJoin(
            automationVersions,
            eq(automationVersions.id, runs.automationVersionId)
          )
          .innerJoin(
            connections,
            eq(connections.id, actionExecutions.connectionId)
          )
          .where(eq(actionExecutions.id, actionId))
        if (!context || context.mode !== "test")
          throw new Error(
            "Archive recovery is restricted to persisted test actions"
          )
        return await work(lockedStore(owned, actionId, assertOwner), {
          ...context,
          connectionCompatible: context.connectionProvider === "google",
        })
      } finally {
        try {
          if (locked)
            await session`select pg_advisory_unlock(hashtextextended(${actionId}, 734031))`
        } finally {
          await session.end()
        }
      }
    },
  }
}

function lockedStore(
  db: Database,
  actionId: string,
  assertOwner: () => Promise<void>
) {
  async function read(): Promise<ArchiveRecoveryRecord> {
    await assertOwner()
    const [record] = await db
      .select()
      .from(archiveRecoveries)
      .where(eq(archiveRecoveries.actionExecutionId, actionId))
    if (!record) throw new Error("Missing persisted archive recovery")
    return record
  }
  const event = async (
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    value: EventInput
  ) => {
    const [last] = await tx
      .select({
        count: sql<number>`coalesce(max(${archiveAttemptEvents.sequence}),0)::integer`,
      })
      .from(archiveAttemptEvents)
      .where(eq(archiveAttemptEvents.actionExecutionId, actionId))
    await tx.insert(archiveAttemptEvents).values({
      actionExecutionId: actionId,
      sequence: last.count + 1,
      ...value,
    })
  }
  return {
    read,
    async isIntentCurrent() {
      await assertOwner()
      const [current] = await db
        .select({
          status: runs.status,
          nodeStatus: nodeExecutions.status,
          provider: connections.providerKey,
        })
        .from(actionExecutions)
        .innerJoin(
          nodeExecutions,
          eq(nodeExecutions.id, actionExecutions.nodeExecutionId)
        )
        .innerJoin(runs, eq(runs.id, nodeExecutions.runId))
        .innerJoin(
          connections,
          eq(connections.id, actionExecutions.connectionId)
        )
        .where(eq(actionExecutions.id, actionId))
      return (
        current?.status === "running" &&
        current.nodeStatus === "running" &&
        current.provider === "google"
      )
    },
    async interrupted(now: Date) {
      const record = await read()
      if (!record.inFlightOperation || !record.inFlightAttempt) return
      await db.transaction(async (tx) => {
        await event(tx, {
          operation: record.inFlightOperation!,
          phase: "interrupted",
          attempt: record.inFlightAttempt!,
          evidence: { code: "dispatch_interrupted", effect: "unknown" },
          createdAt: now,
        })
        await tx
          .update(archiveRecoveries)
          .set({
            inFlightOperation: null,
            inFlightAttempt: null,
            nextOperation: "get",
            nextAttemptAt: now,
            lastWriteOutcome:
              record.inFlightOperation === "modify"
                ? "unknown"
                : record.lastWriteOutcome,
            lastOutcome: { code: "dispatch_interrupted" },
            updatedAt: now,
          })
          .where(eq(archiveRecoveries.actionExecutionId, actionId))
        if (record.inFlightOperation === "modify")
          await tx
            .update(actionExecutions)
            .set({
              executionStatus: "unknown",
              error: { code: "dispatch_interrupted" },
              finishedAt: now,
            })
            .where(eq(actionExecutions.id, actionId))
      })
    },
    async reconcileBeforeRetry(now: Date) {
      await assertOwner()
      await db
        .update(archiveRecoveries)
        .set({ nextOperation: "get", nextAttemptAt: now, updatedAt: now })
        .where(
          and(
            eq(archiveRecoveries.actionExecutionId, actionId),
            eq(archiveRecoveries.state, "pending")
          )
        )
    },
    async start(operation: ArchiveOperation, now: Date) {
      const record = await read()
      if (
        record.state !== "pending" ||
        record.inFlightOperation ||
        now >= record.deadlineAt ||
        record.nextOperation !== operation ||
        !record.nextAttemptAt ||
        record.nextAttemptAt > now ||
        (operation === "modify" &&
          record.writeNotBeforeAt !== null &&
          now < record.writeNotBeforeAt)
      )
        throw new Error("Archive dispatch no longer eligible")
      const attempt =
        (operation === "modify" ? record.writeAttempts : record.readAttempts) +
        1
      if (
        attempt >
        (operation === "modify"
          ? record.policy.maxWrites
          : record.policy.maxReads)
      )
        throw new Error("Archive dispatch budget exhausted")
      await db.transaction(async (tx) => {
        await event(tx, {
          operation,
          phase: "started",
          attempt,
          evidence: { messageId: record.messageId },
          createdAt: now,
        })
        await tx
          .update(archiveRecoveries)
          .set({
            inFlightOperation: operation,
            inFlightAttempt: attempt,
            nextOperation: "get",
            nextAttemptAt: now,
            writeAttempts:
              operation === "modify" ? attempt : record.writeAttempts,
            readAttempts: operation === "get" ? attempt : record.readAttempts,
            updatedAt: now,
          })
          .where(eq(archiveRecoveries.actionExecutionId, actionId))
      })
      return read()
    },
    async result(input: {
      operation: ArchiveOperation
      evidence: JsonObject
      nextOperation: ArchiveOperation
      nextAttemptAt: Date
      writeOutcome?: "acknowledged" | "failed" | "unknown"
      writeRetryAllowed?: boolean
      writeNotBeforeAt?: Date
      terminal?: { state: "observed" | "stopped"; evidence: JsonObject }
      now: Date
    }) {
      const record = await read()
      if (
        record.inFlightOperation !== input.operation ||
        !record.inFlightAttempt
      )
        throw new Error("No owned dispatch result")
      await db.transaction(async (tx) => {
        await event(tx, {
          operation: input.operation,
          phase: "result",
          attempt: record.inFlightAttempt!,
          evidence: input.evidence,
          createdAt: input.now,
        })
        await tx
          .update(archiveRecoveries)
          .set({
            inFlightOperation: null,
            inFlightAttempt: null,
            nextOperation: input.nextOperation,
            nextAttemptAt: new Date(
              Math.min(
                input.nextAttemptAt.getTime(),
                record.deadlineAt.getTime()
              )
            ),
            writeNotBeforeAt: input.writeNotBeforeAt ?? record.writeNotBeforeAt,
            writeRetryAllowed:
              input.writeRetryAllowed ?? record.writeRetryAllowed,
            lastWriteOutcome: input.writeOutcome ?? record.lastWriteOutcome,
            lastOutcome: input.terminal
              ? { ...input.evidence, terminalDecision: input.terminal }
              : input.evidence,
            updatedAt: input.now,
          })
          .where(eq(archiveRecoveries.actionExecutionId, actionId))
        if (input.writeOutcome)
          await tx
            .update(actionExecutions)
            .set({
              executionStatus:
                input.writeOutcome === "acknowledged"
                  ? "succeeded"
                  : input.writeOutcome,
              responseSnapshot:
                input.writeOutcome === "acknowledged"
                  ? (input.evidence.response ?? input.evidence)
                  : null,
              error:
                input.writeOutcome === "acknowledged" ? null : input.evidence,
              finishedAt: input.now,
            })
            .where(eq(actionExecutions.id, actionId))
      })
    },
    async finish(
      state: "observed" | "stopped",
      evidence: JsonObject,
      now: Date
    ) {
      const record = await read()
      if (record.state !== "pending") return
      await db.transaction(async (tx) => {
        const [action] = await tx
          .select()
          .from(actionExecutions)
          .where(eq(actionExecutions.id, actionId))
        const [node] = await tx
          .select()
          .from(nodeExecutions)
          .where(eq(nodeExecutions.id, action.nodeExecutionId))
          .for("update")
        const [last] = await tx
          .select({
            sequence: sql<number>`max(${nodeExecutions.sequence})::integer`,
          })
          .from(nodeExecutions)
          .where(eq(nodeExecutions.runId, node.runId))
        const [currentRun] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, node.runId))
          .for("update")
        const [connection] = await tx
          .select()
          .from(connections)
          .where(eq(connections.id, action.connectionId))
          .for("update")
        if (
          currentRun.status !== "running" ||
          node.status !== "running" ||
          connection.providerKey !== "google"
        ) {
          state = "stopped"
          evidence = {
            code: "intent_superseded",
            runStatus: currentRun.status,
            nodeStatus: node.status,
            connectionCompatible: connection.providerKey === "google",
          }
        }
        const observed = state === "observed"
        const output = { status: observed ? "verified" : "failed", evidence }
        // Do not invent a graph continuation for cancelled or unsupported
        // historical intent; stop it without adding a verifier node.
        const canContinue =
          currentRun.status === "running" &&
          node.status === "running" &&
          connection.providerKey === "google" &&
          evidence.code !== "unsupported_stored_continuation"
        const [verifier] = canContinue
          ? await tx
              .insert(nodeExecutions)
              .values({
                runId: node.runId,
                sequence: last.sequence + 1,
                nodeKey: "verify_archive",
                nodeKind: "verify",
                status:
                  record.readAttempts === 0
                    ? "skipped"
                    : observed
                      ? "succeeded"
                      : "failed",
                inputSnapshot: { actionExecutionId: actionId },
                outputSnapshot: output,
                error: observed ? null : evidence,
                startedAt: now,
                finishedAt: now,
              })
              .returning()
          : []
        await tx
          .update(nodeExecutions)
          .set({
            status: observed ? "succeeded" : "failed",
            outputSnapshot: { actionExecutionId: actionId, outcome: state },
            error: observed ? null : evidence,
            finishedAt: now,
          })
          .where(
            and(
              eq(nodeExecutions.id, node.id),
              eq(nodeExecutions.status, "running")
            )
          )
        await tx
          .update(actionExecutions)
          .set({
            executionStatus:
              action.executionStatus === "running"
                ? "failed"
                : action.executionStatus,
            verificationStatus: observed ? "verified" : "failed",
            verificationEvidence: evidence,
            verifiedByNodeExecutionId: verifier?.id ?? null,
            verifiedAt: now,
            finishedAt: action.finishedAt ?? now,
          })
          .where(eq(actionExecutions.id, actionId))
        await tx
          .update(runs)
          .set({
            status: observed ? "succeeded" : "failed",
            outputSnapshot: output,
            error: observed ? null : evidence,
            finishedAt: now,
          })
          .where(and(eq(runs.id, node.runId), eq(runs.status, "running")))
        await event(tx, {
          operation: "stop",
          phase: "result",
          attempt: 0,
          evidence,
          createdAt: now,
        })
        await tx
          .update(archiveRecoveries)
          .set({
            state,
            nextAttemptAt: null,
            inFlightOperation: null,
            inFlightAttempt: null,
            lastOutcome: evidence,
            updatedAt: now,
          })
          .where(eq(archiveRecoveries.actionExecutionId, actionId))
      })
    },
  }
}
