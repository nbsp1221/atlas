import { createArchiveRecoveryRepository, type Database } from "@workspace/db"
import { PersistentArchiveMail } from "@workspace/automation-simulation"
import {
  assertRecoverableArchiveBranch,
  processArchiveRecovery,
} from "@workspace/automations/email-triage"

export type ArchiveWorkerOptions = {
  now?: () => Date
  random?: () => number
  fixtureRoot?: string
  beforeDispatch?: (operation: "modify" | "get") => Promise<void>
  afterDispatch?: (operation: "modify" | "get") => Promise<void>
  afterResult?: (operation: "modify" | "get") => Promise<void>
}
export async function recoverDueArchives(
  db: Database,
  options: ArchiveWorkerOptions = {},
  runId?: string
) {
  const repository = createArchiveRecoveryRepository(db)
  const now = options.now ?? (() => new Date())
  const due = await repository.due(now(), runId)
  let claimed = 0
  for (const row of due) {
    await repository.withOwnership(
      row.actionExecutionId,
      async (store, context) => {
        claimed++
        const record = await store.read()
        if (record.state !== "pending") return
        try {
          assertRecoverableArchiveBranch(context.graph)
        } catch {
          await store.finish(
            "stopped",
            { code: "unsupported_stored_continuation" },
            now()
          )
          return
        }
        if (!context.connectionCompatible) {
          await store.finish(
            "stopped",
            { code: "connection_unavailable" },
            now()
          )
          return
        }
        await processArchiveRecovery({
          store,
          mail: new PersistentArchiveMail(context.runId, options.fixtureRoot),
          now,
          random: options.random ?? Math.random,
          beforeDispatch: options.beforeDispatch,
          afterDispatch: options.afterDispatch,
          afterResult: options.afterResult,
        })
      }
    )
  }
  return { claimed }
}
export function startArchiveRecoveryWorker(
  db: Database,
  options: ArchiveWorkerOptions = {}
) {
  let stopping = false
  let active: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    if (stopping) return
    active = recoverDueArchives(db, options)
      .catch((error) => console.error("Archive recovery worker:", error))
      .finally(() => {
        if (!stopping) {
          timer = setTimeout(tick, 250)
          timer.unref()
        }
      })
  }
  tick()
  return async () => {
    stopping = true
    if (timer) clearTimeout(timer)
    await active
  }
}
