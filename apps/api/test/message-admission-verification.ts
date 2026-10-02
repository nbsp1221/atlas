import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { eq } from "drizzle-orm"
import {
  actionExecutions,
  automations,
  automationVersions,
  connections,
  createDatabase,
  createExecutionRepository,
  createReadRepository,
  modelInvocations,
  nodeExecutions,
  runs,
} from "@workspace/db"
import { fakeEmail } from "@workspace/automation-simulation"
import { verificationDatabaseUrl } from "../../../scripts/verification-isolation.mjs"
import {
  fakeGmailMessageIdentity,
  gmailMessageIdentityFromConnection,
} from "../src/composition/gmail-message-identity"

const verificationRunId = process.env.VERIFICATION_RUN_ID
assert(
  verificationRunId,
  "Run this through scripts/verify-message-admission.mjs"
)
const databaseUrl = verificationDatabaseUrl("e2e", verificationRunId)
assert.equal(
  process.env.DATABASE_URL,
  databaseUrl,
  "Refusing non-owned database"
)
const { db, client } = createDatabase(databaseUrl)
const read = createReadRepository(db)
const store = createExecutionRepository(db)
const children: ChildProcess[] = []
const mailbox = {
  integrationKey: "gmail",
  resourceType: "mailbox",
  externalId: "fixture-mailbox-A",
}

type Reply = {
  runId: string
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  admission: "created" | "duplicate"
  version: number
  error?: unknown
  simulation: null | {
    environment: string
    archiveAttempts: number
    archiveVerificationReads: number
    notificationCount: number
    modelRequests: unknown[]
    mailboxAfter: { messageId: string; archived: boolean }[]
  }
}

async function startWorker() {
  const child = fork(
    fileURLToPath(
      new URL("./message-admission-http-worker.ts", import.meta.url)
    ),
    [],
    {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        VERIFICATION_RUN_ID: verificationRunId,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }
  )
  children.push(child)
  return new Promise<{ url: string; pid: number }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("HTTP worker startup timed out")),
      30_000
    )
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`HTTP worker exited before ready: ${code}`))
    })
    child.once("message", (message) => {
      clearTimeout(timer)
      try {
        const ready = message as {
          type: string
          pid: number
          url: string
          runId: string
        }
        assert.equal(ready.type, "ready")
        assert.equal(ready.pid, child.pid)
        assert.equal(ready.runId, verificationRunId)
        assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/)
        resolve(ready)
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Owned HTTP worker did not shut down"))
    }, 10_000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    if (child.connected) child.send({ type: "shutdown" })
    else child.kill("SIGTERM")
  })
}

function eventBody(messageId: string, extra: Record<string, unknown> = {}) {
  return {
    email: fakeEmail({ messageId }),
    execution: {
      kind: "event",
      mailbox,
      historyId: "history-original",
      notificationId: "notification-original",
    },
    scenario: { route: "archive", verificationBehavior: "actual" },
    ...extra,
  }
}

async function post(url: string, body: unknown) {
  const response = await fetch(
    `${url}/api/automations/email-triage/test-runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }
  )
  return { code: response.status, body: (await response.json()) as Reply }
}

function created(response: Awaited<ReturnType<typeof post>>) {
  assert.equal(response.code, 201, JSON.stringify(response.body))
  assert.equal(response.body.admission, "created")
  assert(response.body.simulation)
  assert.equal(response.body.simulation.environment, "fake")
  return response.body
}

function duplicate(response: Awaited<ReturnType<typeof post>>, runId: string) {
  assert.equal(response.code, 200, JSON.stringify(response.body))
  assert.equal(response.body.admission, "duplicate")
  assert.equal(response.body.runId, runId)
  assert.equal(
    response.body.simulation,
    null,
    "Duplicate must not report a fresh simulation"
  )
  return response.body
}

async function history(runId: string) {
  const bundle = await read.findRun(runId)
  assert(bundle)
  return {
    run: bundle.run,
    nodes: bundle.nodes,
    actions: bundle.actions,
    models: bundle.models,
  }
}

async function executionFingerprint() {
  // Ordered, serialized complete records catch silent inserts or overwrites,
  // including attempts that returned an error before the caller noticed them.
  const [runRows, nodes, actions, models] = await Promise.all([
    db.select().from(runs).orderBy(runs.id),
    db.select().from(nodeExecutions).orderBy(nodeExecutions.id),
    db.select().from(actionExecutions).orderBy(actionExecutions.id),
    db.select().from(modelInvocations).orderBy(modelInvocations.id),
  ])
  return JSON.stringify({ runs: runRows, nodes, actions, models })
}

async function main() {
  const [a, b] = await Promise.all([startWorker(), startWorker()])
  assert.notEqual(a.pid, b.pid, "Concurrency must cross process boundaries")
  assert.notEqual(a.url, b.url)
  console.log(
    "✓ two independent HTTP API workers share one owned PostgreSQL database"
  )

  const baseline = await read.findAutomationVersion("email-triage")
  assert(baseline?.version)
  const version = baseline.version
  const automation = baseline.automation

  // True cross-process race: 20 HTTP clients compete on one database key.
  const raceRequests = Array.from({ length: 20 }, (_, index) =>
    eventBody("admission-race", {
      execution: {
        kind: "event",
        mailbox,
        historyId: `history-race-${index}`,
        notificationId: `notification-race-${index}`,
      },
      scenario: {
        route: "archive",
        modelDelayMs: 100,
        verificationBehavior: "actual",
      },
    })
  )
  const raced = await Promise.all(
    raceRequests.map((body, index) => post(index % 2 ? a.url : b.url, body))
  )
  const winners = raced.filter((response) => response.code === 201)
  assert.equal(winners.length, 1, JSON.stringify(raced))
  const winner = created(winners[0])
  assert.equal(winner.status, "succeeded")
  assert.equal(winner.simulation!.archiveAttempts, 1)
  assert.equal(winner.simulation!.modelRequests.length, 1)
  assert.equal(winner.simulation!.archiveVerificationReads, 1)
  assert.equal(winner.simulation!.mailboxAfter[0].archived, true)
  for (const response of raced.filter((item) => item !== winners[0])) {
    const item = duplicate(response, winner.runId)
    assert(["queued", "running", "succeeded"].includes(item.status))
    assert.equal(item.version, version.versionNumber)
  }
  const raceHistory = await history(winner.runId)
  const historicalEvents: {
    messageId: string
    reply: Reply
    serialized: string
  }[] = [
    {
      messageId: "admission-race",
      reply: winner,
      serialized: JSON.stringify(raceHistory),
    },
  ]
  assert.equal(raceHistory.run.mode, "test")
  assert(raceHistory.run.idempotencyKey)
  assert.equal(raceHistory.models.length, 1)
  assert.equal(raceHistory.actions.length, 1)
  assert.equal(raceHistory.actions[0].executionStatus, "succeeded")
  const sameKeyRows = (await db.select().from(runs)).filter(
    (run) => run.idempotencyKey === raceHistory.run.idempotencyKey
  )
  assert.equal(sameKeyRows.length, 1)

  const retry = duplicate(
    await post(
      b.url,
      eventBody("admission-race", {
        email: fakeEmail({
          messageId: "admission-race",
          subject: "Must not replace original input",
        }),
        execution: {
          kind: "event",
          mailbox,
          historyId: "new-history",
          notificationId: "new-notification",
        },
        scenario: { route: "notify", modelPermanentFailure: true },
      })
    ),
    winner.runId
  )
  assert.equal(retry.status, "succeeded")
  assert.deepEqual(
    await history(winner.runId),
    raceHistory,
    "Duplicate must not overwrite any historical record"
  )
  console.log(
    "✓ 20 cross-process requests and changed delivery IDs admit one Run/model/action without history overwrite"
  )

  for (const [name, scenario, expectedError, expectedActions] of [
    [
      "model-failed",
      { modelPermanentFailure: true },
      "fake_model_permanent",
      0,
    ],
    [
      "action-failed",
      { route: "archive", actionBehavior: "failure" },
      "permanent_failure",
      1,
    ],
    [
      "unknown-after-effect",
      { route: "archive", actionBehavior: "unknown", archiveEffect: "apply" },
      null,
      1,
    ],
  ] as const) {
    const original = created(await post(a.url, eventBody(name, { scenario })))
    assert.equal(
      original.status,
      name === "unknown-after-effect" ? "succeeded" : "failed"
    )
    const before = await history(original.runId)
    historicalEvents.push({
      messageId: name,
      reply: original,
      serialized: JSON.stringify(before),
    })
    assert.equal(before.run.error?.code ?? null, expectedError)
    assert.equal(before.models.length, 1)
    assert.equal(before.actions.length, expectedActions)
    if (name === "unknown-after-effect") {
      assert.equal(before.actions[0].executionStatus, "unknown")
      assert.equal(original.simulation!.mailboxAfter[0].archived, true)
      assert.equal(original.simulation!.archiveAttempts, 1)
    }
    const after = duplicate(await post(b.url, eventBody(name)), original.runId)
    assert.equal(after.status, original.status)
    assert.deepEqual(after.error, original.error)
    assert.deepEqual(await history(original.runId), before)
  }
  console.log(
    "✓ failed and reconciled-unknown deliveries remain deduplicated without new model/action effects"
  )

  // An admitted message belongs to its historical run even if today's
  // configuration cannot admit a new message. Never use reconfiguration as retry.
  const driftedGraph = structuredClone(version.graphDefinition)
  const archiveNode = driftedGraph.nodes.find(
    (node) => node.key === "archive_email"
  )
  assert(archiveNode)
  archiveNode.config = { ...archiveNode.config, actionKey: "report-spam" }
  const unavailableConfigurations: {
    name: string
    code: number
    error: string
    extra?: Record<string, unknown>
    configure?: () => Promise<unknown>
    restore?: () => Promise<unknown>
  }[] = [
    {
      name: "no-active-version",
      code: 404,
      error: "version_not_found",
      configure: () =>
        db
          .update(automations)
          .set({ activeVersionId: null })
          .where(eq(automations.id, automation.id)),
      restore: () =>
        db
          .update(automations)
          .set({ activeVersionId: version.id })
          .where(eq(automations.id, automation.id)),
    },
    {
      name: "requested-version-missing",
      code: 404,
      error: "version_not_found",
      extra: { version: version.versionNumber + 1000 },
    },
    {
      name: "graph-semantics-drift",
      code: 409,
      error: "invalid_automation_definition",
      configure: () =>
        db
          .update(automationVersions)
          .set({ graphDefinition: driftedGraph })
          .where(eq(automationVersions.id, version.id)),
      restore: () =>
        db
          .update(automationVersions)
          .set({ graphDefinition: version.graphDefinition })
          .where(eq(automationVersions.id, version.id)),
    },
    {
      name: "connection-removed-without-replacement",
      code: 409,
      error: "connection_not_found",
      configure: () =>
        db
          .update(connections)
          .set({ key: "google-primary-unavailable" })
          .where(eq(connections.key, "google-primary")),
      restore: () =>
        db
          .update(connections)
          .set({ key: "google-primary" })
          .where(eq(connections.key, "google-primary-unavailable")),
    },
  ]
  for (const configuration of unavailableConfigurations) {
    const fingerprint = await executionFingerprint()
    try {
      await configuration.configure?.()
      for (const original of historicalEvents) {
        const response = duplicate(
          await post(
            b.url,
            eventBody(original.messageId, {
              ...configuration.extra,
              email: fakeEmail({
                messageId: original.messageId,
                subject: "Must not update admitted input",
              }),
              scenario: { route: "notify", modelPermanentFailure: true },
            })
          ),
          original.reply.runId
        )
        assert.equal(response.status, original.reply.status, configuration.name)
        assert.equal(
          response.version,
          original.reply.version,
          configuration.name
        )
        assert.deepEqual(
          response.error,
          original.reply.error,
          configuration.name
        )
        assert.equal(
          JSON.stringify(await history(original.reply.runId)),
          original.serialized,
          `${configuration.name}: historical run/node/action/model bytes changed`
        )

        // Matching a real admitted message must never bypass request validation.
        const valid = eventBody(original.messageId, configuration.extra)
        const malformed: unknown[] = [
          { ...valid, unexpected: "must be rejected" },
          {
            ...valid,
            email: { ...valid.email, messageId: ` ${original.messageId}` },
          },
          {
            ...valid,
            execution: {
              ...valid.execution,
              mailbox: { ...mailbox, externalId: `${mailbox.externalId} ` },
            },
          },
          { ...valid, execution: { ...valid.execution, environment: "live" } },
        ]
        for (const body of malformed) {
          const rejected = await post(a.url, body)
          assert.equal(
            rejected.code,
            400,
            `${configuration.name}: invalid request bypassed validation: ${JSON.stringify(rejected)}`
          )
        }
      }

      const fresh = await post(
        a.url,
        eventBody(
          `fresh-unavailable-${configuration.name}`,
          configuration.extra
        )
      )
      assert.equal(fresh.code, configuration.code, JSON.stringify(fresh))
      assert.equal(fresh.body.error, configuration.error)
      assert.equal(
        await executionFingerprint(),
        fingerprint,
        `${configuration.name}: duplicate, rejected identity, or unavailable new event wrote execution records`
      )
    } finally {
      await configuration.restore?.()
    }
  }
  console.log(
    "✓ completed/failed/unknown duplicates retain original history despite absent versions, graph drift, or missing Connection; new and malformed events fail closed"
  )

  const pendingEmail = fakeEmail({ messageId: "pending-message" })
  const pending = await store.claimRun({
    automationId: automation.id,
    automationVersionId: version.id,
    mode: "test",
    idempotencyKey: fakeGmailMessageIdentity(mailbox, pendingEmail.messageId)
      .idempotencyKey,
    input: pendingEmail,
    triggerSnapshot: {
      source: "owned-pending-fixture",
      historyId: "keep-original",
    },
    createdAt: new Date(),
  })
  assert.equal(pending.created, true)
  for (const status of ["queued", "running", "cancelled"] as const) {
    if (status !== "queued")
      await db.update(runs).set({ status }).where(eq(runs.id, pending.id))
    const before = await history(pending.id)
    const response = duplicate(
      await post(b.url, eventBody(pendingEmail.messageId)),
      pending.id
    )
    assert.equal(response.status, status)
    assert.deepEqual(await history(pending.id), before)
    assert.equal(before.nodes.length, 0)
    assert.equal(before.models.length, 0)
    assert.equal(before.actions.length, 0)
  }
  console.log(
    "✓ queued, running, and cancelled claims are observed without execution or takeover"
  )

  const otherMessage = created(
    await post(a.url, eventBody("different-message"))
  )
  const otherMailbox = created(
    await post(
      b.url,
      eventBody("admission-race", {
        execution: {
          kind: "event",
          mailbox: { ...mailbox, externalId: "fixture-mailbox-B" },
        },
      })
    )
  )
  assert.notEqual(otherMessage.runId, winner.runId)
  assert.notEqual(otherMailbox.runId, winner.runId)
  assert.equal((await history(otherMessage.runId)).actions.length, 1)
  assert.equal((await history(otherMailbox.runId)).actions.length, 1)

  const collisionCases = [
    { mailboxId: "a:b", messageId: "c" },
    { mailboxId: "a", messageId: "b:c" },
    { mailboxId: 'quote"\\box', messageId: 'message"\\value' },
    { mailboxId: "ящик-é", messageId: "信-🙂" },
  ]
  const collisionIds = new Set<string>()
  const collisionKeys = new Set<string>()
  for (const item of collisionCases) {
    const body = eventBody(item.messageId, {
      execution: {
        kind: "event",
        mailbox: { ...mailbox, externalId: item.mailboxId },
      },
    })
    const response = created(await post(a.url, body))
    collisionIds.add(response.runId)
    const record = await history(response.runId)
    collisionKeys.add(record.run.idempotencyKey!)
    assert.equal(
      (record.run.inputSnapshot as { messageId: string }).messageId,
      item.messageId
    )
    duplicate(await post(b.url, body), response.runId)
    assert.deepEqual(await history(response.runId), record)
  }
  assert.equal(collisionIds.size, collisionCases.length)
  assert.equal(collisionKeys.size, collisionCases.length)
  console.log(
    "✓ delimiter, quotes, backslashes, and Unicode identities remain lossless and collision-free"
  )

  const manualBody = {
    email: fakeEmail({ messageId: "admission-race" }),
    scenario: { route: "archive" },
  }
  const manuals = [
    created(await post(a.url, manualBody)),
    created(await post(b.url, manualBody)),
    created(
      await post(a.url, { ...manualBody, execution: { kind: "manual" } })
    ),
    created(
      await post(b.url, { ...manualBody, execution: { kind: "manual" } })
    ),
  ]
  assert.equal(
    new Set([winner.runId, ...manuals.map((item) => item.runId)]).size,
    5
  )
  for (const manual of manuals) {
    const record = await history(manual.runId)
    assert.equal(record.run.idempotencyKey, null)
    assert.equal(record.actions.length, 1)
    assert.equal(record.models.length, 1)
  }
  const { messageId: _messageId, ...emailWithoutId } = fakeEmail()
  const noIdManual = created(
    await post(a.url, {
      email: emailWithoutId,
      scenario: { route: "no_action" },
    })
  )
  assert((await history(noIdManual.runId)).run.inputSnapshot)
  console.log(
    "✓ distinct messages/mailboxes execute independently; omitted/explicit manual mode stays independent"
  )

  // A new Connection is not a new mailbox. Preserve the old row and FKs.
  const [oldConnection] = await db
    .select()
    .from(connections)
    .where(eq(connections.key, "google-primary"))
  assert(oldConnection)
  assert.equal(raceHistory.actions[0].connectionId, oldConnection.id)
  await db
    .update(connections)
    .set({ key: "google-primary-retired" })
    .where(eq(connections.id, oldConnection.id))
  const [newConnection] = await db
    .insert(connections)
    .values({
      ...oldConnection,
      id: undefined,
      key: "google-primary",
      label: "Owned replacement fixture",
    })
    .returning()
  assert.notEqual(newConnection.id, oldConnection.id)
  const reconnected = duplicate(
    await post(b.url, eventBody("admission-race")),
    winner.runId
  )
  assert.equal(reconnected.status, "succeeded")
  assert.deepEqual(await history(winner.runId), raceHistory)
  const freshAfterReconnect = created(
    await post(a.url, eventBody("fresh-after-reconnect"))
  )
  assert.equal(
    (await history(freshAfterReconnect.runId)).actions[0].connectionId,
    newConnection.id
  )
  console.log(
    "✓ Connection replacement preserves mailbox dedup and historical Connection foreign keys"
  )

  const [nextVersion] = await db
    .insert(automationVersions)
    .values({
      automationId: automation.id,
      versionNumber: version.versionNumber + 1,
      definitionSchemaVersion: version.definitionSchemaVersion,
      graphDefinition: version.graphDefinition,
      definitionHash: `owned-version-${verificationRunId}`,
    })
    .returning()
  await db
    .update(automations)
    .set({ activeVersionId: nextVersion.id })
    .where(eq(automations.id, automation.id))
  for (const body of [
    eventBody("admission-race"),
    eventBody("admission-race", { version: nextVersion.versionNumber }),
  ]) {
    const response = duplicate(await post(b.url, body), winner.runId)
    assert.equal(
      response.version,
      version.versionNumber,
      "Response must identify original execution version"
    )
    assert.deepEqual(await history(winner.runId), raceHistory)
  }
  const newVersionRun = created(
    await post(a.url, eventBody("new-version-message"))
  )
  assert.equal(newVersionRun.version, nextVersion.versionNumber)
  assert.equal(
    (await history(newVersionRun.runId)).run.automationVersionId,
    nextVersion.id
  )
  console.log(
    "✓ version selection changes cannot rerun a message or relabel its original version"
  )

  // Repository-only namespace probes: no live execution or live adapter exists.
  const secondAutomation = await read.findAutomationVersion("email-summary")
  assert(secondAutomation?.version)
  const claimInput = {
    automationId: automation.id,
    automationVersionId: version.id,
    mode: "test" as const,
    idempotencyKey: raceHistory.run.idempotencyKey!,
    input: fakeEmail(),
    createdAt: new Date(),
  }
  const anotherAutomation = await store.claimRun({
    ...claimInput,
    automationId: secondAutomation.automation.id,
    automationVersionId: secondAutomation.version.id,
  })
  assert.equal(anotherAutomation.created, true)
  assert.notEqual(anotherAutomation.id, winner.runId)
  const liveClaim = await store.claimRun({ ...claimInput, mode: "live" })
  assert.equal(liveClaim.created, true)
  assert.notEqual(liveClaim.id, winner.runId)
  const liveDuplicate = await store.claimRun({ ...claimInput, mode: "live" })
  assert.equal(liveDuplicate.created, false)
  assert.equal(liveDuplicate.id, liveClaim.id)
  assert.equal((await history(liveClaim.id)).nodes.length, 0)
  const liveIdentity = gmailMessageIdentityFromConnection(
    {
      providerKey: "google",
      externalPrincipalType: "google-sub",
      externalPrincipalId: "fixture-mailbox-A",
    },
    "admission-race"
  )
  const fakeIdentity = fakeGmailMessageIdentity(
    liveIdentity.mailbox,
    "admission-race"
  )
  assert.notEqual(liveIdentity.idempotencyKey, fakeIdentity.idempotencyKey)
  console.log(
    "✓ automation, live/test database namespaces, and fake/live identity namespaces remain independent"
  )

  const beforeInvalid = await db.select().from(runs)
  const invalidEvents: unknown[] = [
    { ...eventBody("invalid"), email: emailWithoutId },
    ...["", " ", " padded", "padded ", "\tmessage", "message\n"].map(
      (messageId) => ({
        ...eventBody("invalid"),
        email: { ...fakeEmail(), messageId },
      })
    ),
    ...[
      undefined,
      null,
      {},
      { ...mailbox, externalId: "" },
      { ...mailbox, externalId: " " },
      { ...mailbox, externalId: " fixture" },
      { ...mailbox, externalId: "fixture " },
      { ...mailbox, externalId: 42 },
      { ...mailbox, integrationKey: "drive" },
      { ...mailbox, resourceType: "message" },
      { ...mailbox, extra: "not allowed" },
    ].map((invalidMailbox) =>
      eventBody("invalid", {
        execution: { kind: "event", mailbox: invalidMailbox },
      })
    ),
    eventBody("invalid", {
      execution: { kind: "event", mailbox, environment: "live" },
    }),
    eventBody("invalid", {
      execution: { kind: "event", mailbox, connectionId: oldConnection.id },
    }),
    eventBody("invalid", {
      execution: { kind: "event", mailbox, idempotencyKey: "injected" },
    }),
    eventBody("invalid", { execution: { kind: "live", mailbox } }),
    eventBody("invalid", { execution: null }),
    eventBody("invalid", { execution: { kind: "manual", mailbox } }),
  ]
  for (const body of invalidEvents) {
    const response = await post(a.url, body)
    assert.equal(
      response.code,
      400,
      `Invalid event accepted: ${JSON.stringify(body)} => ${JSON.stringify(response)}`
    )
  }
  assert.deepEqual(
    await db.select().from(runs),
    beforeInvalid,
    "Invalid identities must not create runs"
  )
  assert.deepEqual(await history(winner.runId), raceHistory)
  console.log(
    "✓ missing/blank/padded/invalid event identities and non-strict execution fields fail closed before Run creation"
  )
}

try {
  await main()
} finally {
  try {
    await Promise.all(children.map(stopWorker))
  } finally {
    await client.end()
  }
}
