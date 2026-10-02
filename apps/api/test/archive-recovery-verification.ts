import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile } from "node:fs/promises"
import { eq, sql } from "drizzle-orm"
import {
  createDatabase,
  createReadRepository,
  archiveRecoveries,
  archiveAttemptEvents,
  actionExecutions,
  automationVersions,
  runs,
} from "@workspace/db"
import {
  fakeEmail,
  PersistentArchiveMail,
  type EmailTriageFakeScenario,
} from "@workspace/automation-simulation"
import { defaultArchiveRecoveryPolicy } from "@workspace/automations/email-triage"
import { runDetailReadModel } from "../src/read-models"
import {
  verificationDatabaseUrl,
  verificationEvidenceDirectory,
} from "../../../scripts/verification-isolation.mjs"
const verificationRunId = process.env.VERIFICATION_RUN_ID
assert(verificationRunId)
assert.equal(
  process.env.DATABASE_URL,
  verificationDatabaseUrl("e2e", verificationRunId)
)
assert(process.env.ATLAS_FAKE_MAILBOX_DIR)
const { db, client } = createDatabase(process.env.DATABASE_URL!)
const read = createReadRepository(db)
const children: ChildProcess[] = []
const reports: unknown[] = []
let sequence = 0
let clock = new Date()
const start = async () => {
  const child = fork(
    fileURLToPath(new URL("./archive-recovery-worker.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      env: process.env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }
  )
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Worker start timeout")),
      30000
    )
    child.once("message", (m) => {
      assert((m as { ready: boolean }).ready)
      clearTimeout(timer)
      resolve()
    })
    child.once("error", reject)
  })
  return child
}
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Worker stop timeout"))
    }, 10000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill("SIGTERM")
  })
}
const call = async (child: ChildProcess, command: Record<string, unknown>) =>
  new Promise<any>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Worker command timeout"))
    }, 20000)
    const onMessage = (raw: unknown) => {
      const m = raw as { id: number; result: unknown; error?: string }
      if (m.id !== id) return
      cleanup()
      m.error ? reject(new Error(m.error)) : resolve(m.result)
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`Worker exited ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }
    child.on("message", onMessage)
    child.once("exit", onExit)
    child.send({ ...command, id, now: clock.toISOString() })
  })
const scope = async (runId: string) => {
  const bundle = await read.findRun(runId)
  assert(bundle)
  assert.equal(bundle.models.length, 1)
  assert.equal(bundle.actions.length, 1)
  assert.equal(bundle.actions[0].actionKey, "archive-message")
  assert.equal(
    bundle.nodes.filter((n) => n.nodeKey === "classify_email").length,
    1
  )
  const [recovery] = await db
    .select()
    .from(archiveRecoveries)
    .where(eq(archiveRecoveries.actionExecutionId, bundle.actions[0].id))
  assert(recovery)
  const events = await db
    .select()
    .from(archiveAttemptEvents)
    .where(eq(archiveAttemptEvents.actionExecutionId, bundle.actions[0].id))
    .orderBy(archiveAttemptEvents.sequence)
  const fixture = await new PersistentArchiveMail(runId).snapshot()
  return { bundle, recovery, events, fixture }
}
let first: ChildProcess
const make = async (
  name: string,
  scenario: EmailTriageFakeScenario = {},
  opts: Record<string, unknown> = {}
) => {
  const input = {
    email: fakeEmail({ messageId: `recovery-${name}` }),
    scenario: { route: "archive", ...scenario },
    execution: {
      kind: "event",
      mailbox: {
        integrationKey: "gmail",
        resourceType: "mailbox",
        externalId: "archive-recovery-fixture",
      },
    },
  }
  const result = await call(first, { op: "execute", input, ...opts })
  assert.equal(result.kind, "executed")
  assert.equal(result.result.admission, "created")
  return { runId: result.result.runId as string, input, result }
}
const drain = async (runId: string, worker = first) => {
  for (let i = 0; i < 30; i++) {
    const current = await scope(runId)
    if (current.recovery.state !== "pending") return current
    assert(current.recovery.nextAttemptAt)
    clock = current.recovery.nextAttemptAt
    await call(worker, { op: "recover", runId })
  }
  throw new Error("Bounded recovery did not terminate")
}
const report = async (
  name: string,
  runId: string,
  expected: Record<string, unknown>
) => {
  const state = await scope(runId)
  reports.push({
    name,
    expected,
    actual: {
      run: state.bundle.run.status,
      execution: state.bundle.actions[0].executionStatus,
      verification: state.bundle.actions[0].verificationStatus,
      outcome: state.recovery.lastOutcome,
      writes: state.fixture.writes,
      reads: state.fixture.reads,
      modelInvocations: state.bundle.models.length,
    },
    ...state,
    readModel: runDetailReadModel(state.bundle),
    passed: true,
  })
  return state
}
try {
  first = await start()
  let item = await make("success")
  let state = await report("first success", item.runId, {
    writes: 1,
    reads: 1,
    state: "observed",
  })
  assert.equal(state.bundle.run.status, "succeeded")
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.fixture.reads, 1)
  item = await make("transient", {
    archiveWriteScript: ["transient-before", "success"],
  })
  state = await scope(item.runId)
  assert.equal(state.recovery.state, "pending")
  assert(state.recovery.nextAttemptAt!.getTime() - clock.getTime() >= 1000)
  state = await drain(item.runId)
  assert.equal(state.fixture.writes, 2)
  assert.equal(state.bundle.run.status, "succeeded")
  await report("before-effect transient", item.runId, {
    writes: 2,
    state: "observed",
  })
  item = await make("unknown-after", { archiveWriteScript: ["unknown-after"] })
  state = await report("unknown after effect", item.runId, {
    writes: 1,
    execution: "unknown",
    verification: "verified",
  })
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.bundle.actions[0].executionStatus, "unknown")
  assert.equal(state.recovery.lastOutcome?.code, "desired_state_observed")
  assert.equal(state.recovery.lastOutcome?.causality, "not_established")
  item = await make("restart-read", {
    archiveWriteScript: ["unknown-after"],
    archiveReadScript: ["transient", "success"],
  })
  state = await scope(item.runId)
  assert.equal(state.recovery.state, "pending")
  assert.equal(state.fixture.inInbox, false)
  const before = JSON.stringify(state.bundle.models)
  const oldPid = first.pid
  await stop(first)
  first = await start()
  assert.notEqual(first.pid, oldPid)
  state = await drain(item.runId)
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.fixture.reads, 2)
  assert.equal(JSON.stringify(state.bundle.models), before)
  await report("failed GET then process restart same fixture", item.runId, {
    writes: 1,
    reads: 2,
    oldPid,
    newPid: first.pid,
  })
  item = await make("present-retry", {
    archiveWriteScript: ["unknown-before", "success"],
  })
  state = await drain(item.runId)
  assert.equal(state.fixture.writes, 2)
  assert.equal(state.bundle.run.status, "succeeded")
  await report("present unchanged intent retries", item.runId, { writes: 2 })
  for (const error of ["permanent", "permission"] as const) {
    item = await make(error, { archiveWriteScript: [error] })
    state = await report(error, item.runId, {
      writes: 1,
      reads: 0,
      state: "stopped",
    })
    assert.equal(state.recovery.state, "stopped")
    assert.equal(state.fixture.writes, 1)
    assert.equal(state.fixture.reads, 0)
  }
  item = await make("rate", {
    archiveWriteScript: ["rate-limit", "success"],
    archiveRetryAfterMs: 7000,
  })
  state = await scope(item.runId)
  assert(state.recovery.nextAttemptAt!.getTime() - clock.getTime() >= 7000)
  await drain(item.runId)
  await report("rate reason plus Retry-After", item.runId, {
    minimumDelayMs: 7000,
    writes: 2,
  })
  item = await make("budget", {
    archiveWriteScript: [
      "transient-before",
      "transient-before",
      "transient-before",
    ],
  })
  state = await drain(item.runId)
  assert.equal(state.fixture.writes, 3)
  assert.equal(state.recovery.state, "stopped")
  await report("write budget exhausted", item.runId, {
    writes: 3,
    state: "stopped",
  })
  item = await make(
    "read-budget",
    {
      archiveWriteScript: ["unknown-after"],
      archiveReadScript: ["transient", "transient", "transient"],
    },
    { policy: { ...defaultArchiveRecoveryPolicy, maxReads: 2 } }
  )
  state = await drain(item.runId)
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.fixture.reads, 2)
  assert.equal(state.bundle.actions[0].executionStatus, "unknown")
  await report("GET failure stays unknown and bounded", item.runId, {
    writes: 1,
    reads: 2,
    state: "stopped",
  })
  item = await make("deadline", {
    archiveWriteScript: ["unknown-before", "success"],
  })
  state = await scope(item.runId)
  clock = state.recovery.deadlineAt
  await call(first, { op: "recover", runId: item.runId })
  state = await report("deadline forbids old intent write", item.runId, {
    writes: 1,
    state: "stopped",
  })
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.recovery.lastOutcome?.code, "intent_deadline_exceeded")
  item = await make("readd", {
    archiveWriteScript: ["unknown-after"],
    archiveReadScript: ["transient", "success"],
  })
  await new PersistentArchiveMail(item.runId).readdInbox()
  state = await drain(item.runId)
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.fixture.inInbox, true)
  assert.equal(state.recovery.lastOutcome?.code, "intent_superseded")
  await report("late re-add stops old intent", item.runId, {
    writes: 1,
    inInbox: true,
  })
  item = await make("pending-duplicate", {
    archiveWriteScript: ["unknown-before", "success"],
  })
  state = await scope(item.runId)
  const preserved = JSON.stringify(state)
  const repeated = await call(first, { op: "execute", input: item.input })
  assert.equal(repeated.result.runId, item.runId)
  assert.equal(repeated.result.admission, "duplicate")
  assert.equal(repeated.simulation, null)
  assert.equal(JSON.stringify(await scope(item.runId)), preserved)
  await drain(item.runId)
  await report("pending duplicate is observation only", item.runId, {
    sameRun: true,
    noDuplicateMutation: true,
  })
  item = await make("two-workers", {}, { defer: true })
  const second = await start()
  const owners = await Promise.all([
    call(first, { op: "recover", runId: item.runId }),
    call(second, { op: "recover", runId: item.runId }),
  ])
  state = await scope(item.runId)
  assert.equal(state.fixture.writes, 1)
  assert.equal(
    state.events.filter(
      (e) => e.operation === "modify" && e.phase === "started"
    ).length,
    1
  )
  await stop(second)
  await report("two processes no double dispatch", item.runId, {
    writes: 1,
    claims: owners,
  })
  item = await make("held-owner", {}, { defer: true })
  const competitor = await start()
  const held = new Promise<void>((resolve) => {
    const listener = (message: unknown) => {
      if ((message as { type: string }).type === "holding") {
        first.off("message", listener)
        resolve()
      }
    }
    first.on("message", listener)
  })
  const heldWork = call(first, { op: "recover", runId: item.runId, hold: true })
  await held
  const losing = await call(competitor, { op: "recover", runId: item.runId })
  assert.equal(losing.claimed, 0)
  first.send({ op: "release" })
  await heldWork
  await stop(competitor)
  state = await report(
    "active session ownership excludes competing process",
    item.runId,
    { writes: 1, competingClaims: 0 }
  )
  assert.equal(state.fixture.writes, 1)
  item = await make("cancelled-before-dispatch", {}, { defer: true })
  await db
    .update(runs)
    .set({ status: "cancelled", finishedAt: clock })
    .where(eq(runs.id, item.runId))
  await call(first, { op: "recover", runId: item.runId })
  state = await report("persisted cancellation prevents dispatch", item.runId, {
    writes: 0,
    run: "cancelled",
  })
  assert.equal(state.fixture.writes, 0)
  assert.equal(state.bundle.run.status, "cancelled")
  assert.equal(state.recovery.state, "stopped")
  for (const crash of ["before-modify", "after-modify", "after-get"]) {
    item = await make(`crash-${crash}`, {}, { defer: true })
    await assert.rejects(
      call(first, { op: "recover", runId: item.runId, crash }),
      /Worker exited 77/
    )
    first = await start()
    state = await scope(item.runId)
    const written = state.fixture.writes
    state = await drain(item.runId)
    assert.equal(state.bundle.run.status, "succeeded")
    assert(state.events.some((e) => e.phase === "interrupted"))
    assert.equal(state.fixture.writes, crash === "before-modify" ? 1 : written)
    await report(`process crash ${crash}`, item.runId, {
      writes: 1,
      interruptedEvidence: true,
    })
  }
  for (const terminalCase of [
    "permanent-get",
    "wrong-message",
    "desired-observed",
  ] as const) {
    item = await make(
      `terminal-${terminalCase}`,
      {
        archiveWriteScript: [
          terminalCase === "permanent-get" ? "unknown-after" : "success",
        ],
        archiveReadScript: [
          terminalCase === "permanent-get"
            ? "permanent"
            : terminalCase === "wrong-message"
              ? "wrong-message"
              : "success",
          "success",
        ],
      },
      { defer: true }
    )
    await assert.rejects(
      call(first, {
        op: "recover",
        runId: item.runId,
        crash: "after-result-get",
      }),
      /Worker exited 77/
    )
    state = await scope(item.runId)
    assert(state.recovery.lastOutcome?.terminalDecision)
    const callsBefore = {
      writes: state.fixture.writes,
      reads: state.fixture.reads,
    }
    first = await start()
    state = await drain(item.runId)
    assert.equal(state.fixture.writes, callsBefore.writes)
    assert.equal(state.fixture.reads, callsBefore.reads)
    assert.equal(
      state.recovery.state,
      terminalCase === "desired-observed" ? "observed" : "stopped"
    )
    await report(
      `committed ${terminalCase} decision survives finalization crash`,
      item.runId,
      { ...callsBefore, noFurtherIO: true }
    )
  }
  item = await make("terminal-changed-revision", {
    archiveWriteScript: ["unknown-after"],
    archiveReadScript: ["transient", "success"],
  })
  await new PersistentArchiveMail(item.runId).readdInbox()
  state = await scope(item.runId)
  clock = state.recovery.nextAttemptAt!
  await assert.rejects(
    call(first, {
      op: "recover",
      runId: item.runId,
      crash: "after-result-get",
    }),
    /Worker exited 77/
  )
  state = await scope(item.runId)
  const readCountBefore = state.fixture.reads
  first = await start()
  state = await drain(item.runId)
  assert.equal(state.fixture.reads, readCountBefore)
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.recovery.lastOutcome?.code, "intent_superseded")
  await report(
    "committed superseded decision survives finalization crash",
    item.runId,
    { writes: 1, reads: readCountBefore, noFurtherIO: true }
  )
  item = await make("overlapping-fixture-get")
  const snapshotHeld = new Promise<void>((resolve) => {
    const listener = (m: unknown) => {
      if ((m as { type: string }).type === "holding") {
        first.off("message", listener)
        resolve()
      }
    }
    first.on("message", listener)
  })
  const overlap = call(first, { op: "fixture-get-overlap", runId: item.runId })
  await snapshotHeld
  await new PersistentArchiveMail(item.runId).readdInbox()
  first.send({ op: "release" })
  const overlapObserved = await overlap
  assert.equal(overlapObserved.inInbox, true)
  state = await scope(item.runId)
  assert.equal(state.fixture.inInbox, true)
  assert.equal(state.fixture.revision, 3)
  assert.equal(state.fixture.reads, 2)
  assert.equal(state.fixture.writes, 1)
  await report(
    "cross-process GET counter cannot erase concurrent re-add",
    item.runId,
    { writes: 1, reads: 2, inInbox: true, revision: 3 }
  )
  item = await make("mismatch", { archiveWriteScript: ["mismatch"] })
  state = await report("verification mismatch not Verified", item.runId, {
    execution: "succeeded",
    verification: "failed",
    run: "failed",
  })
  assert.equal(state.bundle.actions[0].verificationStatus, "failed")
  assert.notEqual(runDetailReadModel(state.bundle).verification, "verified")
  item = await make("wrong-message", { archiveReadScript: ["wrong-message"] })
  state = await report("wrong message observation fails closed", item.runId, {
    state: "stopped",
  })
  assert.equal(state.recovery.state, "stopped")
  // A completed intent never repairs a later re-add, even on duplicate delivery.
  item = await make("completed-readd")
  await new PersistentArchiveMail(item.runId).readdInbox()
  await call(first, { op: "recover", runId: item.runId })
  await call(first, { op: "execute", input: item.input })
  state = await scope(item.runId)
  assert.equal(state.fixture.writes, 1)
  assert.equal(state.fixture.inInbox, true)
  await report("completed intent not reopened", item.runId, {
    writes: 1,
    inInbox: true,
  })
  // Both archive events and frozen intent policy are database-enforced immutable.
  state = await scope(item.runId)
  await assert.rejects(
    db
      .update(archiveAttemptEvents)
      .set({ evidence: { tampered: true } })
      .where(eq(archiveAttemptEvents.id, state.events[0].id)),
    /append-only|Failed query/
  )
  await assert.rejects(
    db
      .update(archiveRecoveries)
      .set({ messageId: "retargeted" })
      .where(
        eq(
          archiveRecoveries.actionExecutionId,
          state.recovery.actionExecutionId
        )
      ),
    /immutable|Failed query/
  )
  const versions = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(automationVersions)
  assert(versions[0].count > 0)
  assert.deepEqual(await call(first, { op: "shutdown-loop" }), {
    stopped: true,
  })
  const pending = await db
    .select()
    .from(archiveRecoveries)
    .where(eq(archiveRecoveries.state, "pending"))
  assert.equal(pending.length, 0)
  await mkdir(verificationEvidenceDirectory("archive-recovery"), {
    recursive: true,
  })
  await writeFile(
    `${verificationEvidenceDirectory("archive-recovery")}/matrix.json`,
    JSON.stringify(
      {
        proof:
          "real PostgreSQL + separate worker processes + same persistent fake mailbox files",
        database: process.env.DATABASE_URL?.split("/").at(-1),
        scenarios: reports,
      },
      null,
      2
    )
  )
  console.log(
    `Archive recovery PostgreSQL/process matrix: PASS (${reports.length} scenarios)`
  )
} finally {
  for (const child of children) await stop(child)
  await client.end()
}
