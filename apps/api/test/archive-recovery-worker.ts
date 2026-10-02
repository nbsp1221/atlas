import { PersistentArchiveMail } from "@workspace/automation-simulation"
import { createDatabase } from "@workspace/db"
import { executeEmailTriageTestRun } from "../src/composition/execute-email-triage-test-run"
import {
  recoverDueArchives,
  startArchiveRecoveryWorker,
} from "../src/composition/archive-recovery"
import { verificationDatabaseUrl } from "../../../scripts/verification-isolation.mjs"
import assert from "node:assert/strict"
const verificationRunId = process.env.VERIFICATION_RUN_ID
assert(verificationRunId)
assert.equal(
  process.env.DATABASE_URL,
  verificationDatabaseUrl("e2e", verificationRunId)
)
const { db, client } = createDatabase(process.env.DATABASE_URL!)
process.on(
  "message",
  async (command: {
    id: number
    op: string
    now: string
    input: Parameters<typeof executeEmailTriageTestRun>[1]
    runId?: string
    defer?: boolean
    policy?: NonNullable<
      Parameters<typeof executeEmailTriageTestRun>[2]
    >["policy"]
    crash?: string
    hold?: boolean
  }) => {
    if (command.op === "release") return
    try {
      const options = {
        now: () => new Date(command.now),
        random: () => 0,
        fixtureRoot: process.env.ATLAS_FAKE_MAILBOX_DIR,
      }
      let result: unknown
      if (command.op === "execute")
        result = await executeEmailTriageTestRun(db, command.input, {
          ...options,
          deferRecovery: command.defer,
          policy: command.policy,
        })
      else if (command.op === "fixture-get-overlap") {
        const mail = new PersistentArchiveMail(
          command.runId!,
          process.env.ATLAS_FAKE_MAILBOX_DIR,
          {
            afterReadSnapshot: async () => {
              process.send?.({ type: "holding" })
              await new Promise<void>((resolve) => {
                const released = (m: unknown) => {
                  if ((m as { op: string }).op === "release") {
                    process.off("message", released)
                    resolve()
                  }
                }
                process.on("message", released)
              })
            },
          }
        )
        result = await mail.get((await mail.snapshot()).messageId)
      } else if (command.op === "recover")
        result = await recoverDueArchives(
          db,
          {
            ...options,
            beforeDispatch: async (op) => {
              if (command.crash === `before-${op}`) process.exit(77)
              if (command.hold && op === "modify") {
                process.send?.({ type: "holding" })
                await new Promise<void>((resolve) => {
                  const released = (message: unknown) => {
                    if ((message as { op: string }).op === "release") {
                      process.off("message", released)
                      resolve()
                    }
                  }
                  process.on("message", released)
                })
              }
            },
            afterResult: async (op) => {
              if (command.crash === `after-result-${op}`) process.exit(77)
            },
            afterDispatch: async (op) => {
              if (command.crash === `after-${op}`) process.exit(77)
            },
          },
          command.runId
        )
      else if (command.op === "shutdown-loop") {
        const stop = startArchiveRecoveryWorker(db, options)
        await stop()
        result = { stopped: true }
      } else throw new Error("Unknown worker command")
      process.send?.({ id: command.id, result, pid: process.pid })
    } catch (error) {
      process.send?.({
        id: command.id,
        error: error instanceof Error ? error.stack : String(error),
      })
    }
  }
)
process.once("disconnect", () => void client.end().then(() => process.exit(0)))
process.once("SIGTERM", () => void client.end().then(() => process.exit(0)))
process.send?.({ ready: true, pid: process.pid })
