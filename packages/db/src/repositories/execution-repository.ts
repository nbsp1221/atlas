import { and, eq, sql } from "drizzle-orm"
import type {
  ExecutionStore,
  StoredActionClaim,
} from "@workspace/automation-runtime"
import type { JsonObject } from "@workspace/domain/persistence"
import type { Database } from "./read-repository"
import {
  actionExecutions,
  modelInvocations,
  nodeExecutions,
  runs,
} from "../schema"

export function createExecutionRepository(db: Database): ExecutionStore {
  return {
    async claimRun(input) {
      if (
        input.idempotencyKey !== undefined &&
        (!input.idempotencyKey.trim() ||
          input.idempotencyKey !== input.idempotencyKey.trim())
      ) {
        throw new Error("Run idempotency key must be nonempty and canonical")
      }
      if (input.idempotencyKey !== undefined && input.mode === "replay") {
        throw new Error("Replay cannot claim an event idempotency key")
      }
      const insertion = db.insert(runs).values({
        automationId: input.automationId,
        automationVersionId: input.automationVersionId,
        mode: input.mode,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        triggerSnapshot: input.triggerSnapshot,
        triggerIntegrationKey: input.triggerIntegrationKey,
        triggerConnectionId: input.triggerConnectionId,
        inputSnapshot: input.input,
        createdAt: input.createdAt,
      })
      // PostgreSQL owns admission across processes. Do not perform a
      // check-then-insert or an upsert that rewrites the original evidence.
      const [created] = await (input.idempotencyKey === undefined
        ? insertion.returning()
        : insertion
            .onConflictDoNothing({
              target: [runs.automationId, runs.idempotencyKey],
              where:
                input.mode === "live"
                  ? sql`${runs.mode} = 'live' and ${runs.idempotencyKey} is not null`
                  : sql`${runs.mode} = 'test' and ${runs.idempotencyKey} is not null`,
            })
            .returning())
      if (created) {
        return {
          id: created.id,
          created: true,
          automationVersionId: created.automationVersionId,
          status: created.status,
          output: created.outputSnapshot,
          error: created.error,
        }
      }
      // Separate statement after ON CONFLICT waits for the winner: under the
      // normal READ COMMITTED boundary its committed row is now visible.
      const [existing] = await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.automationId, input.automationId),
            eq(runs.mode, input.mode),
            eq(runs.idempotencyKey, input.idempotencyKey!)
          )
        )
        .limit(1)
      if (!existing)
        throw new Error("Run claim conflicted but existing row was not found")
      return {
        id: existing.id,
        created: false,
        automationVersionId: existing.automationVersionId,
        status: existing.status,
        output: existing.outputSnapshot,
        error: existing.error,
      }
    },

    async startRun(runId, startedAt) {
      await db
        .update(runs)
        .set({ status: "running", startedAt })
        .where(eq(runs.id, runId))
    },

    async completeRun(runId, output, finishedAt) {
      await db
        .update(runs)
        .set({
          status: "succeeded",
          outputSnapshot: output,
          finishedAt,
          error: null,
        })
        .where(eq(runs.id, runId))
    },

    async failRun(runId, error, finishedAt) {
      await db
        .update(runs)
        .set({ status: "failed", error, finishedAt })
        .where(eq(runs.id, runId))
    },

    async startNodeExecution(input) {
      const [node] = await db
        .insert(nodeExecutions)
        .values({
          runId: input.runId,
          sequence: input.sequence,
          nodeKey: input.nodeKey,
          nodeKind: input.nodeKind,
          status: "running",
          retryOfNodeExecutionId: input.retryOfNodeExecutionId,
          inputSnapshot: input.input,
          startedAt: input.startedAt,
        })
        .returning({ id: nodeExecutions.id })

      return node
    },

    async completeNodeExecution(input) {
      await db
        .update(nodeExecutions)
        .set({
          status: "succeeded",
          outputSnapshot: input.output,
          selectedEdgeKey: input.selectedEdgeKey,
          finishedAt: input.finishedAt,
          error: null,
        })
        .where(eq(nodeExecutions.id, input.id))
    },

    async failNodeExecution(id, error, finishedAt) {
      await db
        .update(nodeExecutions)
        .set({ status: "failed", error, finishedAt })
        .where(eq(nodeExecutions.id, id))
    },

    async skipNodeExecution(id, output, finishedAt) {
      await db
        .update(nodeExecutions)
        .set({
          status: "skipped",
          outputSnapshot: output,
          finishedAt,
          error: null,
        })
        .where(eq(nodeExecutions.id, id))
    },

    async startModelInvocation(input) {
      const [invocation] = await db
        .insert(modelInvocations)
        .values({
          nodeExecutionId: input.nodeExecutionId,
          sequence: input.sequence,
          status: "running",
          connectionId: input.connectionId,
          modelProvider: input.request.provider,
          model: input.request.model,
          modelParameters: input.request.parameters,
          inputSnapshot: input.request.input,
          startedAt: input.startedAt,
        })
        .returning({ id: modelInvocations.id })

      return invocation
    },

    async completeModelInvocation(input) {
      await db
        .update(modelInvocations)
        .set({
          status: "succeeded",
          providerRequestId: input.response.providerRequestId,
          outputSnapshot: input.response.output,
          usageDetails: input.response.usageDetails,
          costDetails: input.response.costDetails,
          costUsd:
            input.response.costUsd === undefined
              ? null
              : input.response.costUsd.toFixed(12),
          durationMs: input.durationMs,
          finishedAt: input.finishedAt,
          error: null,
        })
        .where(eq(modelInvocations.id, input.id))
    },

    async failModelInvocation(input) {
      await db
        .update(modelInvocations)
        .set({
          status: "failed",
          providerRequestId: input.providerRequestId,
          error: input.error,
          durationMs: input.durationMs,
          finishedAt: input.finishedAt,
        })
        .where(eq(modelInvocations.id, input.id))
    },

    async claimActionExecution(input): Promise<StoredActionClaim> {
      const [created] = await db
        .insert(actionExecutions)
        .values({
          nodeExecutionId: input.nodeExecutionId,
          sequence: input.sequence,
          connectionId: input.connectionId,
          integrationKey: input.integrationKey,
          actionKey: input.actionKey,
          idempotencyKey: input.idempotencyKey,
          executionStatus: "running",
          verificationStatus: "pending",
          requestSnapshot: input.request,
          startedAt: input.startedAt,
        })
        .onConflictDoNothing({
          target: [
            actionExecutions.connectionId,
            actionExecutions.idempotencyKey,
          ],
        })
        .returning()

      if (created) {
        return {
          id: created.id,
          created: true,
          executionStatus: created.executionStatus,
          response: created.responseSnapshot,
          externalRef: created.externalRef,
        }
      }

      const [existing] = await db
        .select()
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.connectionId, input.connectionId),
            eq(actionExecutions.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1)

      if (!existing) {
        throw new Error(
          "Action claim conflicted but existing row was not found"
        )
      }

      return {
        id: existing.id,
        created: false,
        executionStatus: existing.executionStatus,
        response: existing.responseSnapshot,
        externalRef: existing.externalRef,
      }
    },

    async completeActionExecution(input) {
      await db
        .update(actionExecutions)
        .set({
          executionStatus: "succeeded",
          responseSnapshot: input.response,
          externalRef: input.externalRef,
          finishedAt: input.finishedAt,
          error: null,
        })
        .where(eq(actionExecutions.id, input.id))
    },

    async failActionExecution(input) {
      await db
        .update(actionExecutions)
        .set({
          executionStatus: input.status,
          error: input.error,
          finishedAt: input.finishedAt,
        })
        .where(eq(actionExecutions.id, input.id))
    },

    async completeActionVerification(input) {
      await db
        .update(actionExecutions)
        .set({
          verificationStatus: input.status,
          verificationEvidence: input.evidence,
          verifiedByNodeExecutionId: input.verifiedByNodeExecutionId,
          verifiedAt: input.verifiedAt,
        })
        .where(eq(actionExecutions.id, input.id))
    },
  }
}

export function databaseErrorEvidence(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      code: "database_error",
      name: error.name,
      message: error.message,
    }
  }
  return {
    code: "database_error",
    name: "UnknownDatabaseError",
    message: String(error),
  }
}
