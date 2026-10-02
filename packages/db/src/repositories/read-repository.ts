import { and, desc, eq, gte, inArray } from "drizzle-orm"
import type { RunMode } from "@workspace/domain/persistence"
import type { createDatabase } from "../client"
import {
  actionExecutions,
  archiveRecoveries,
  archiveAttemptEvents,
  automationVersions,
  automations,
  connections,
  interactionChannels,
  modelInvocations,
  nodeExecutions,
  nodeFeedback,
  runs,
} from "../schema"

export type Database = ReturnType<typeof createDatabase>["db"]

async function evidenceForRunIds(db: Database, runIds: string[]) {
  if (runIds.length === 0) {
    return {
      nodes: [] as (typeof nodeExecutions.$inferSelect)[],
      models: [] as (typeof modelInvocations.$inferSelect)[],
      actions: [] as (typeof actionExecutions.$inferSelect)[],
      feedback: [] as (typeof nodeFeedback.$inferSelect)[],
      archiveRecoveries: [] as (typeof archiveRecoveries.$inferSelect)[],
      archiveAttempts: [] as (typeof archiveAttemptEvents.$inferSelect)[],
    }
  }

  const nodes = await db
    .select()
    .from(nodeExecutions)
    .where(inArray(nodeExecutions.runId, runIds))
    .orderBy(nodeExecutions.runId, nodeExecutions.sequence)

  const nodeIds = nodes.map((node) => node.id)
  if (nodeIds.length === 0) {
    return {
      nodes,
      models: [] as (typeof modelInvocations.$inferSelect)[],
      actions: [] as (typeof actionExecutions.$inferSelect)[],
      feedback: [] as (typeof nodeFeedback.$inferSelect)[],
      archiveRecoveries: [] as (typeof archiveRecoveries.$inferSelect)[],
      archiveAttempts: [] as (typeof archiveAttemptEvents.$inferSelect)[],
    }
  }

  const [models, actions, feedback] = await Promise.all([
    db
      .select()
      .from(modelInvocations)
      .where(inArray(modelInvocations.nodeExecutionId, nodeIds))
      .orderBy(modelInvocations.nodeExecutionId, modelInvocations.sequence),
    db
      .select()
      .from(actionExecutions)
      .where(inArray(actionExecutions.nodeExecutionId, nodeIds))
      .orderBy(actionExecutions.nodeExecutionId, actionExecutions.sequence),
    db
      .select()
      .from(nodeFeedback)
      .where(inArray(nodeFeedback.nodeExecutionId, nodeIds)),
  ])

  // Recovery belongs to the same logical action, never to a separate Run or
  // synthetic retry node. Restrict both evidence reads to these action IDs.
  const actionIds = actions.map((action) => action.id)
  const [recoveries, attempts] = actionIds.length
    ? await Promise.all([
        db
          .select()
          .from(archiveRecoveries)
          .where(inArray(archiveRecoveries.actionExecutionId, actionIds)),
        db
          .select()
          .from(archiveAttemptEvents)
          .where(inArray(archiveAttemptEvents.actionExecutionId, actionIds))
          .orderBy(
            archiveAttemptEvents.actionExecutionId,
            archiveAttemptEvents.sequence
          ),
      ])
    : [[], []]

  return {
    nodes,
    models,
    actions,
    feedback,
    archiveRecoveries: recoveries,
    archiveAttempts: attempts,
  }
}

export function createReadRepository(db: Database) {
  return {
    async listAutomations() {
      return db
        .select({
          automation: automations,
          version: automationVersions,
        })
        .from(automations)
        .leftJoin(
          automationVersions,
          eq(automations.activeVersionId, automationVersions.id)
        )
        .orderBy(automations.key)
    },

    async findAutomationByKey(key: string) {
      const [row] = await db
        .select({
          automation: automations,
          version: automationVersions,
        })
        .from(automations)
        .leftJoin(
          automationVersions,
          eq(automations.activeVersionId, automationVersions.id)
        )
        .where(eq(automations.key, key))
        .limit(1)

      return row ?? null
    },

    async findAutomationVersion(key: string, versionNumber?: number) {
      const [automation] = await db
        .select()
        .from(automations)
        .where(eq(automations.key, key))
        .limit(1)

      if (!automation) return null

      if (versionNumber === undefined) {
        if (!automation.activeVersionId) return { automation, version: null }
        const [version] = await db
          .select()
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.id, automation.activeVersionId),
              eq(automationVersions.automationId, automation.id)
            )
          )
          .limit(1)
        return { automation, version: version ?? null }
      }

      const [version] = await db
        .select()
        .from(automationVersions)
        .where(
          and(
            eq(automationVersions.automationId, automation.id),
            eq(automationVersions.versionNumber, versionNumber)
          )
        )
        .limit(1)

      return { automation, version: version ?? null }
    },

    async connectionsByKeys(keys: string[]) {
      if (keys.length === 0) return [] as (typeof connections.$inferSelect)[]
      return db.select().from(connections).where(inArray(connections.key, keys))
    },

    async connectionIdsByKeys(keys: string[]) {
      if (keys.length === 0) return {} as Record<string, string>
      const rows = await db
        .select({ id: connections.id, key: connections.key })
        .from(connections)
        .where(inArray(connections.key, keys))

      return Object.fromEntries(rows.map((row) => [row.key, row.id]))
    },

    async findInteractionChannelByKey(key: string) {
      const [channel] = await db
        .select()
        .from(interactionChannels)
        .where(eq(interactionChannels.key, key))
        .limit(1)
      return channel ?? null
    },

    async listConnections() {
      return db.select().from(connections).orderBy(connections.key)
    },

    async listRuns(limit = 100) {
      const rows = await db
        .select({
          run: runs,
          automation: automations,
          version: automationVersions,
        })
        .from(runs)
        .innerJoin(automations, eq(runs.automationId, automations.id))
        .innerJoin(
          automationVersions,
          eq(runs.automationVersionId, automationVersions.id)
        )
        .orderBy(desc(runs.createdAt))
        .limit(limit)

      const evidence = await evidenceForRunIds(
        db,
        rows.map((row) => row.run.id)
      )

      return { rows, ...evidence }
    },

    // Observation only. Missing rows never authorize execution; claimRun
    // still arbitrates concurrent first deliveries through the unique index.
    async findRunByIdempotencyKey(input: {
      automationKey: string
      mode: RunMode
      idempotencyKey: string
    }) {
      const [row] = await db
        .select({ run: runs, version: automationVersions })
        .from(runs)
        .innerJoin(automations, eq(runs.automationId, automations.id))
        .innerJoin(
          automationVersions,
          eq(runs.automationVersionId, automationVersions.id)
        )
        .where(
          and(
            eq(automations.key, input.automationKey),
            eq(runs.mode, input.mode),
            eq(runs.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1)
      return row ?? null
    },

    async findRun(id: string) {
      const [row] = await db
        .select({
          run: runs,
          automation: automations,
          version: automationVersions,
        })
        .from(runs)
        .innerJoin(automations, eq(runs.automationId, automations.id))
        .innerJoin(
          automationVersions,
          eq(runs.automationVersionId, automationVersions.id)
        )
        .where(eq(runs.id, id))
        .limit(1)

      if (!row) return null

      const evidence = await evidenceForRunIds(db, [id])
      return { ...row, ...evidence }
    },

    async runtimeForAutomation(automationId: string, since: Date) {
      const runRows = await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.automationId, automationId),
            eq(runs.mode, "live"),
            gte(runs.createdAt, since)
          )
        )
        .orderBy(desc(runs.createdAt))

      const evidence = await evidenceForRunIds(
        db,
        runRows.map((run) => run.id)
      )

      return { runs: runRows, ...evidence }
    },

    async overviewSince(since: Date) {
      const runRows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.mode, "live"), gte(runs.createdAt, since)))
        .orderBy(desc(runs.createdAt))

      const evidence = await evidenceForRunIds(
        db,
        runRows.map((run) => run.id)
      )

      return { runs: runRows, ...evidence }
    },
  }
}
